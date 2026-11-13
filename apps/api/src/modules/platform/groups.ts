import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, Header, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { GroupStatus, Prisma } from '@prisma/client';
import { IsEmail, IsEnum, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from 'class-validator';
import type { Request } from 'express';
import { Public } from '../../common/auth';
import { COUNTRY_CODES } from '../../common/country';
import { config } from '../../config';
import {
  ACCOUNT_VIEW, accountView, createGroupAccount, GROUP_ROLE_LABELS, GroupAccountDto, GroupAccountUpdateDto, groupConsoleUrl, resetGroupAccount, revokeSessions,
} from '../group/group-accounts';
import { createSmsProvider, sendQuietly } from '../notifications/sms.provider';
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

/** Suspendre ou rétablir l'accès d'un groupe à sa console (lot G2), avec un motif. Sans effet sur ses écoles. */
export class GroupStatusDto {
  @IsEnum(GroupStatus, { message: 'État inconnu' }) status: GroupStatus;
  @IsString(MOTIF) @MinLength(5, MOTIF) @MaxLength(300, MOTIF) motif: string;
}

/** Remettre l'accès d'un compte de groupe (téléphone et codes perdus) : identité vérifiée hors de Cahiora, motif écrit. */
export class ResetGroupAccountDto {
  @IsString(MOTIF) @MinLength(5, MOTIF) @MaxLength(300, MOTIF) motif: string;
}

/** Champ facultatif : absent = inchangé, vide = effacé. */
const opt = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() || null);
const FIELDS = ['name', 'legalName', 'promoter', 'phone', 'email', 'address', 'country', 'taxId', 'notes'] as const;
type School = { id: string; name: string; country: string; currency: string; groupId: string; group: { name: string } };

@Injectable()
export class PlatformGroupsService {
  private sms = createSmsProvider(config.smsProvider);
  constructor(private db: PlatformDb) {}

  /** Groupes avec leurs écoles (nom, adresse, état, date de rattachement), sans aucune donnée des écoles. */
  async list() {
    const groups = await this.db.schoolGroup.findMany({
      orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
      include: {
        tenants: { select: { id: true, name: true, slug: true, status: true, groupJoinedAt: true }, orderBy: { name: 'asc' } },
        _count: { select: { accounts: { where: { active: true } } } },
      },
    });
    return groups.map(({ tenants, _count, ...g }) => ({ ...g, schools: tenants, activeAccounts: _count.accounts }));
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
        const g = await tx.schoolGroup.findUnique({ where: { id }, include: { _count: { select: { tenants: true, accounts: true } } } });
        if (!g) throw new NotFoundException('Groupe introuvable');
        if (g._count.tenants > 0) {
          throw new ConflictException(`Ce groupe a encore ${g._count.tenants} école${g._count.tenants > 1 ? 's' : ''} : rattachez-les d’abord à un autre groupe ou détachez-les`);
        }
        // Les comptes de la console ne sont jamais effacés (traçabilité) : un groupe qui en a gardé ne se supprime pas.
        if (g._count.accounts > 0) throw new ConflictException('Ce groupe a des comptes de console : il ne peut pas être supprimé. Suspendez plutôt son accès.');
        await groupLog(tx, actor, [{ groupId: id, action: 'group.deleted', data: { name: g.name } }]);
        await tx.schoolGroup.delete({ where: { id } });
        await platformLog(tx, actor, 'platform.group.deleted', null, { groupId: id, name: g.name });
        return { ok: true };
      });
    } catch (e) {
      // Une école rattachée entre-temps : la clé étrangère (ON DELETE RESTRICT) refuse la suppression.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') throw new ConflictException('Ce groupe a encore des écoles ou des comptes');
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

  /** Suspendre l'accès d'un groupe à sa console (sessions fermées aussitôt) ou le rétablir. Les écoles ne sont pas touchées. */
  setStatus(actor: PlatformActor, id: string, dto: GroupStatusDto) {
    return this.db.$transaction(async (tx) => {
      const g = await tx.schoolGroup.findUnique({ where: { id }, select: { id: true, name: true, status: true } });
      if (!g) throw new NotFoundException('Groupe introuvable');
      if (g.status === dto.status) throw new BadRequestException(dto.status === 'SUSPENDED' ? 'L’accès de ce groupe est déjà suspendu' : 'L’accès de ce groupe est déjà actif');
      await tx.schoolGroup.update({ where: { id }, data: { status: dto.status } });
      const closed = dto.status === 'SUSPENDED'
        ? (await tx.groupSession.updateMany({ where: { groupId: id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'groupe suspendu' } })).count
        : 0;
      const what = dto.status === 'SUSPENDED' ? 'suspended' : 'reactivated';
      // Le groupe voit que son accès a changé, jamais le motif (journal de la plateforme seulement).
      await groupLog(tx, actor, [{ groupId: id, action: `group.${what}` }]);
      await platformLog(tx, actor, `platform.group.${what}`, null, { groupId: id, groupName: g.name, motif: dto.motif.trim(), sessionsClosed: closed });
      return { id, status: dto.status, sessionsClosed: closed };
    });
  }

  /** Comptes de la console d'un groupe, sans mot de passe, secret ni code. */
  async accounts(groupId: string) {
    if (!(await this.db.schoolGroup.findUnique({ where: { id: groupId }, select: { id: true } }))) throw new NotFoundException('Groupe introuvable');
    const rows = await this.db.groupAccount.findMany({ where: { groupId }, select: ACCOUNT_VIEW, orderBy: [{ active: 'desc' }, { lastName: 'asc' }] });
    return rows.map(accountView);
  }

  private async groupName(tx: Prisma.TransactionClient, groupId: string) {
    return (await tx.schoolGroup.findUnique({ where: { id: groupId }, select: { name: true } }))?.name ?? null;
  }

  private async sendCredentials(phone: string | null, password: string) {
    if (!phone) return;
    await sendQuietly(this.sms, phone, `Votre accès à la console de votre groupe Cahiora : ${groupConsoleUrl()}. Identifiant : ${phone}. Mot de passe provisoire : ${password}. Changez-le à la première connexion.`);
  }

  /** Premier compte d'un groupe (ou tout autre) : mot de passe provisoire montré une seule fois et envoyé par SMS. */
  async createAccount(actor: PlatformActor, groupId: string, dto: GroupAccountDto) {
    const r = await this.db.$transaction(async (tx) => {
      const created = await createGroupAccount(tx, groupId, dto);
      const data = { accountId: created.account.id, name: `${created.account.firstName} ${created.account.lastName}`, role: GROUP_ROLE_LABELS[created.account.role] };
      await groupLog(tx, actor, [{ groupId, action: 'group.account_created', data }]);
      await platformLog(tx, actor, 'platform.group.account_created', null, { groupId, groupName: await this.groupName(tx, groupId), ...data });
      return created;
    });
    await this.sendCredentials(r.account.phone, r.temporaryPassword);
    return { account: accountView(r.account), temporaryPassword: r.temporaryPassword };
  }

  /** Changer le rôle d'un compte, le désactiver (sessions fermées aussitôt) ou le réactiver. */
  updateAccount(actor: PlatformActor, groupId: string, accountId: string, dto: GroupAccountUpdateDto) {
    if (dto.role === undefined && dto.active === undefined) throw new BadRequestException('Rien à modifier');
    return this.db.$transaction(async (tx) => {
      const before = await tx.groupAccount.findFirst({ where: { id: accountId, groupId }, select: { role: true, active: true } });
      if (!before) throw new NotFoundException('Compte introuvable');
      const a = await tx.groupAccount.update({ where: { id: accountId }, data: { role: dto.role, active: dto.active }, select: ACCOUNT_VIEW });
      const closed = dto.active === false ? await revokeSessions(tx, accountId, 'compte désactivé par Cahiora') : 0;
      const changes: Record<string, unknown> = {};
      if (dto.role !== undefined && dto.role !== before.role) changes.role = GROUP_ROLE_LABELS[dto.role];
      if (dto.active !== undefined && dto.active !== before.active) changes.active = dto.active;
      const data = { accountId, name: `${a.firstName} ${a.lastName}`, ...changes, sessionsClosed: closed };
      await groupLog(tx, actor, [{ groupId, action: 'group.account_updated', data }]);
      await platformLog(tx, actor, 'platform.group.account_updated', null, { groupId, groupName: await this.groupName(tx, groupId), ...data });
      return accountView(a);
    });
  }

  /**
   * Remettre l'accès d'un compte de groupe dont le titulaire a perdu son téléphone et ses codes (ou le seul responsable
   * général bloqué) : nouveau mot de passe provisoire, nouvelle double authentification à la connexion suivante.
   */
  async resetAccount(actor: PlatformActor, groupId: string, accountId: string, dto: ResetGroupAccountDto) {
    const r = await this.db.$transaction(async (tx) => {
      const out = await resetGroupAccount(tx, groupId, accountId, 'accès remis par Cahiora');
      const data = { accountId, name: `${out.account.firstName} ${out.account.lastName}`, sessionsClosed: out.sessionsClosed };
      await groupLog(tx, actor, [{ groupId, action: 'group.account_reset', data }]);
      await platformLog(tx, actor, 'platform.group.account_reset', null, { groupId, groupName: await this.groupName(tx, groupId), ...data, motif: dto.motif.trim() });
      return out;
    });
    await this.sendCredentials(r.account.phone, r.temporaryPassword);
    return { account: accountView({ ...r.account, mustChangePassword: true, totpEnabled: false, lockedUntil: null }), temporaryPassword: r.temporaryPassword };
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

  @Post('platform/groups/:id/status') @UseGuards(PlatformGuard)
  status(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: GroupStatusDto) { return this.s.setStatus(this.actor(req), id, dto); }

  @Get('platform/groups/:id/accounts') @UseGuards(PlatformGuard)
  accounts(@Param('id', ParseUUIDPipe) id: string) { return this.s.accounts(id); }

  @Post('platform/groups/:id/accounts') @UseGuards(PlatformGuard) @Header('Cache-Control', 'no-store')
  createAccount(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: GroupAccountDto) { return this.s.createAccount(this.actor(req), id, dto); }

  @Patch('platform/groups/:id/accounts/:aid') @UseGuards(PlatformGuard)
  updateAccount(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Param('aid', ParseUUIDPipe) aid: string, @Body() dto: GroupAccountUpdateDto) {
    return this.s.updateAccount(this.actor(req), id, aid, dto);
  }

  @Post('platform/groups/:id/accounts/:aid/reset') @UseGuards(PlatformGuard) @Header('Cache-Control', 'no-store')
  resetAccount(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Param('aid', ParseUUIDPipe) aid: string, @Body() dto: ResetGroupAccountDto) {
    return this.s.resetAccount(this.actor(req), id, aid, dto);
  }
}
