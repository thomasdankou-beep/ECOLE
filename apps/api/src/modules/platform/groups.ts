import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { IsEmail, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from 'class-validator';
import type { Request } from 'express';
import { Public } from '../../common/auth';
import { COUNTRY_CODES } from '../../common/country';
import { groupLog, PlatformActor, platformLog, schoolLogInTx } from './group-journal';
import { checkSameCurrency } from './group-rules';
import { PlatformDb, PlatformGuard } from './platform';

/**
 * Groupes scolaires (lot G1, décision D-G1) : un groupe est un compte client qui regroupe une ou plusieurs écoles ;
 * une école indépendante forme un groupe à elle seule, à son nom. Seul le Super Admin crée un groupe et y rattache
 * ou en détache une école, avec un motif ; chaque rattachement est inscrit dans le journal de la plateforme, dans
 * celui de chaque groupe concerné et dans celui de l'école, dans la même transaction que le changement.
 */

const MOTIF = { message: 'Motif : 5 à 300 caractères (par exemple la demande écrite du promoteur et sa date)' };

export class GroupDto {
  @IsString() @MinLength(3, { message: 'Nom du groupe : au moins 3 caractères' }) @MaxLength(160) name: string;
  @IsOptional() @IsString() @MaxLength(200) legalName?: string | null;
  @IsOptional() @IsString() @MaxLength(160) promoter?: string | null;
  @IsOptional() @IsString() @MaxLength(30) phone?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null && v !== '') @IsEmail({}, { message: 'Adresse e-mail invalide' }) email?: string | null;
  @IsOptional() @IsString() @MaxLength(300) address?: string | null;
  @IsOptional() @IsIn(COUNTRY_CODES, { message: 'Pays non pris en charge' }) country?: string;
  @IsOptional() @IsString() @MaxLength(60) taxId?: string | null;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string | null;
}

export class UpdateGroupDto {
  @IsOptional() @IsString() @MinLength(3, { message: 'Nom du groupe : au moins 3 caractères' }) @MaxLength(160) name?: string;
  @IsOptional() @IsString() @MaxLength(200) legalName?: string | null;
  @IsOptional() @IsString() @MaxLength(160) promoter?: string | null;
  @IsOptional() @IsString() @MaxLength(30) phone?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null && v !== '') @IsEmail({}, { message: 'Adresse e-mail invalide' }) email?: string | null;
  @IsOptional() @IsString() @MaxLength(300) address?: string | null;
  @IsOptional() @IsIn(COUNTRY_CODES, { message: 'Pays non pris en charge' }) country?: string;
  @IsOptional() @IsString() @MaxLength(60) taxId?: string | null;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string | null;
}

export class AttachSchoolDto {
  @IsUUID('all', { message: 'Groupe invalide' }) groupId: string;
  @IsString(MOTIF) @MinLength(5, MOTIF) @MaxLength(300, MOTIF) motif: string;
}

export class DetachSchoolDto {
  @IsString(MOTIF) @MinLength(5, MOTIF) @MaxLength(300, MOTIF) motif: string;
}

/** Champ facultatif : absent = inchangé, vide = effacé. */
const opt = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() || null);
const FIELDS = ['name', 'legalName', 'promoter', 'phone', 'email', 'address', 'country', 'taxId', 'notes'] as const;
type School = { id: string; name: string; country: string; currency: string; groupId: string; group: { name: string } };

@Injectable()
export class PlatformGroupsService {
  constructor(private db: PlatformDb) {}

  /** Groupes avec leurs écoles (nom, adresse, état, date de rattachement), sans aucune donnée des écoles. */
  async list() {
    const groups = await this.db.schoolGroup.findMany({
      orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
      include: { tenants: { select: { id: true, name: true, slug: true, status: true, groupJoinedAt: true }, orderBy: { name: 'asc' } } },
    });
    return groups.map(({ tenants, ...g }) => ({ ...g, schools: tenants }));
  }

  create(actor: PlatformActor, dto: GroupDto) {
    return this.db.$transaction(async (tx) => {
      const g = await tx.schoolGroup.create({
        data: {
          name: dto.name.trim(), legalName: opt(dto.legalName), promoter: opt(dto.promoter), phone: opt(dto.phone), email: opt(dto.email)?.toLowerCase() ?? null,
          address: opt(dto.address), country: dto.country ?? 'BJ', taxId: opt(dto.taxId), notes: opt(dto.notes),
        },
      });
      await groupLog(tx, actor, [{ groupId: g.id, action: 'group.created', data: { name: g.name } }]);
      await platformLog(tx, actor, 'platform.group.created', null, { groupId: g.id, name: g.name });
      return { ...g, schools: [] };
    });
  }

  update(actor: PlatformActor, id: string, dto: UpdateGroupDto) {
    return this.db.$transaction(async (tx) => {
      const g = await tx.schoolGroup.findUnique({ where: { id } });
      if (!g) throw new NotFoundException('Groupe introuvable');
      // Seuls les champs envoyés et réellement changés ; le nom et le pays ne peuvent pas être vidés.
      const next: Record<string, string | null> = {};
      for (const k of FIELDS) {
        const raw = k === 'name' ? dto.name?.trim() || undefined : k === 'country' ? dto.country ?? undefined : opt(dto[k]);
        const v = k === 'email' && raw ? raw.toLowerCase() : raw;
        if (v !== undefined && v !== g[k]) next[k] = v;
      }
      if (!Object.keys(next).length) return g;
      const updated = await tx.schoolGroup.update({ where: { id }, data: next as Prisma.SchoolGroupUpdateInput });
      // Le journal du groupe ne reçoit jamais les notes internes de la plateforme.
      const { notes, ...visible } = next;
      if (Object.keys(visible).length) await groupLog(tx, actor, [{ groupId: id, action: 'group.updated', data: visible }]);
      await platformLog(tx, actor, 'platform.group.updated', null, { groupId: id, name: updated.name, ...visible, ...(notes !== undefined ? { notes: 'modifiées' } : {}) });
      return updated;
    });
  }

  /** Seul un groupe sans école peut être supprimé (la base le refuse aussi) ; son journal est conservé. */
  async remove(actor: PlatformActor, id: string) {
    try {
      return await this.db.$transaction(async (tx) => {
        const g = await tx.schoolGroup.findUnique({ where: { id }, include: { _count: { select: { tenants: true } } } });
        if (!g) throw new NotFoundException('Groupe introuvable');
        if (g._count.tenants > 0) {
          throw new ConflictException(`Ce groupe a encore ${g._count.tenants} école${g._count.tenants > 1 ? 's' : ''} : rattachez-les d’abord à un autre groupe ou détachez-les`);
        }
        await groupLog(tx, actor, [{ groupId: id, action: 'group.deleted', data: { name: g.name } }]);
        await tx.schoolGroup.delete({ where: { id } });
        await platformLog(tx, actor, 'platform.group.deleted', null, { groupId: id, name: g.name });
        return { ok: true };
      });
    } catch (e) {
      // Une école rattachée entre-temps : la clé étrangère (ON DELETE RESTRICT) refuse la suppression.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') throw new ConflictException('Ce groupe a encore des écoles');
      throw e;
    }
  }

  /** Journal du groupe (200 dernières lignes). */
  async audit(id: string) {
    if (!(await this.db.schoolGroup.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundException('Groupe introuvable');
    return this.db.groupAuditLog.findMany({ where: { groupId: id }, orderBy: { createdAt: 'desc' }, take: 200 });
  }

  /** Rattache une école à un autre groupe existant. */
  attach(actor: PlatformActor, tenantId: string, dto: AttachSchoolDto) {
    return this.db.$transaction(async (tx) => {
      const t = await this.lockSchool(tx, tenantId);
      if (t.groupId === dto.groupId) throw new BadRequestException('Cette école appartient déjà à ce groupe');
      const target = await tx.schoolGroup.findUnique({ where: { id: dto.groupId }, select: { id: true, name: true, tenants: { select: { currency: true } } } });
      if (!target) throw new NotFoundException('Groupe introuvable');
      checkSameCurrency(target.tenants, t.currency);
      return this.move(tx, actor, t, target, dto.motif, 'attached');
    });
  }

  /** Détache une école de son groupe : elle forme désormais un groupe à elle seule, à son nom. */
  detach(actor: PlatformActor, tenantId: string, dto: DetachSchoolDto) {
    return this.db.$transaction(async (tx) => {
      const t = await this.lockSchool(tx, tenantId);
      if ((await tx.tenant.count({ where: { groupId: t.groupId } })) <= 1) throw new BadRequestException('Cette école est déjà seule dans son groupe');
      const target = await tx.schoolGroup.create({ data: { name: t.name, country: t.country } });
      await groupLog(tx, actor, [{ groupId: target.id, action: 'group.created_for_school', data: { tenantId: t.id, tenantName: t.name } }]);
      return this.move(tx, actor, t, target, dto.motif, 'detached');
    });
  }

  /** L'école est verrouillée jusqu'à la fin de la transaction : deux changements simultanés ne se mélangent pas. */
  private async lockSchool(tx: Prisma.TransactionClient, tenantId: string): Promise<School> {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM tenants WHERE id = ${tenantId}::uuid FOR UPDATE`;
    if (!locked.length) throw new NotFoundException('École introuvable');
    return tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { id: true, name: true, country: true, currency: true, groupId: true, group: { select: { name: true } } } });
  }

  private async move(tx: Prisma.TransactionClient, actor: PlatformActor, t: School, target: { id: string; name: string }, motif: string, kind: 'attached' | 'detached') {
    const joinedAt = new Date();
    await tx.tenant.update({ where: { id: t.id }, data: { groupId: target.id, groupJoinedAt: joinedAt }, select: { id: true } });
    // Chaque groupe ne voit que l'école qui part ou arrive, jamais le nom de l'autre groupe client ni le motif.
    await groupLog(tx, actor, [
      { groupId: t.groupId, action: 'group.school_left', data: { tenantId: t.id, tenantName: t.name } },
      { groupId: target.id, action: 'group.school_joined', data: { tenantId: t.id, tenantName: t.name } },
    ]);
    await platformLog(tx, actor, kind === 'attached' ? 'platform.group.school_attached' : 'platform.group.school_detached', t.id, {
      fromGroupId: t.groupId, fromGroupName: t.group.name, toGroupId: target.id, toGroupName: target.name, motif: motif.trim(),
    });
    await schoolLogInTx(tx, actor, t.id, kind === 'attached' ? 'platform.group.attached' : 'platform.group.detached', { from: t.group.name, to: target.name });
    return { tenantId: t.id, group: { id: target.id, name: target.name }, joinedAt };
  }
}

@ApiTags('Plateforme')
@Public()
@Controller()
export class PlatformGroupsController {
  constructor(private s: PlatformGroupsService) {}

  private actor(req: Request) {
    return (req as any).platformAdmin as PlatformActor;
  }

  @Get('platform/groups') @UseGuards(PlatformGuard)
  list() { return this.s.list(); }

  @Post('platform/groups') @UseGuards(PlatformGuard)
  create(@Req() req: Request, @Body() dto: GroupDto) { return this.s.create(this.actor(req), dto); }

  @Patch('platform/groups/:id') @UseGuards(PlatformGuard)
  update(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateGroupDto) { return this.s.update(this.actor(req), id, dto); }

  @Delete('platform/groups/:id') @UseGuards(PlatformGuard)
  remove(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) { return this.s.remove(this.actor(req), id); }

  @Get('platform/groups/:id/audit') @UseGuards(PlatformGuard)
  audit(@Param('id', ParseUUIDPipe) id: string) { return this.s.audit(id); }

  @Post('platform/tenants/:id/attach') @UseGuards(PlatformGuard)
  attach(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AttachSchoolDto) { return this.s.attach(this.actor(req), id, dto); }

  @Post('platform/tenants/:id/detach') @UseGuards(PlatformGuard)
  detach(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DetachSchoolDto) { return this.s.detach(this.actor(req), id, dto); }
}
