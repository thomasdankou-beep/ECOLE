import { BadRequestException, Body, Controller, ForbiddenException, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ApplicationStatus, Sex } from '@prisma/client';
import { IsDateString, IsEmail, IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { Actor, Can, CurrentActor, Public } from '../../common/auth';
import { AuditService } from '../../common/audit.service';
import { PrismaService, Tx } from '../../common/prisma.service';
import { nextNumber, normalizePhone, pad, toDate } from '../../common/util';
import { country } from '../../common/country';
import { NotificationsService } from '../notifications/notifications.service';
import { createSmsProvider, sendQuietly } from '../notifications/sms.provider';
import { config } from '../../config';

class ApplicationDto {
  @IsString() @MinLength(2) @MaxLength(80) studentFirstName: string;
  @IsString() @MinLength(2) @MaxLength(80) studentLastName: string;
  @IsOptional() @IsEnum(Sex) sex?: Sex;
  @IsOptional() @IsDateString() birthDate?: string;
  @IsOptional() @IsString() @MaxLength(160) previousSchool?: string;
  @IsString() @MaxLength(80) wantedLevel: string;
  @IsOptional() @IsString() @MaxLength(120) wantedTrack?: string;
  @IsOptional() @IsString() @MaxLength(120) wantedSite?: string;
  /** Site choisi par la famille (GRP-003), proposé quand l'établissement a deux sites actifs ou plus. */
  @IsOptional() @IsUUID() siteId?: string;
  @IsString() @MinLength(3) @MaxLength(120) guardianName: string;
  @IsString() @MinLength(8) @MaxLength(30) guardianPhone: string;
  @IsOptional() @IsEmail() guardianEmail?: string;
  @IsOptional() @IsString() @MaxLength(1000) message?: string;
}

class ReviewDto {
  @IsEnum(ApplicationStatus) status: ApplicationStatus;
  @IsOptional() @IsString() @MaxLength(200) testResult?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  /** Rattachement à un site (direction ou secrétariat de tout l'établissement seulement), GRP-003. */
  @IsOptional() @IsUUID() siteId?: string;
}

const STATUS_LABEL: Record<ApplicationStatus, string> = {
  RECU: 'reçue', INCOMPLET: 'incomplète', EN_TEST: 'convoquée au test d’entrée', ACCEPTE: 'acceptée', REFUSE: 'refusée', LISTE_ATTENTE: 'sur liste d’attente', INSCRIT: 'inscrite',
};

/** Pré-inscriptions en ligne depuis le site vitrine, étudiées par le secrétariat (CDC §4.1). */
@Injectable()
export class AdmissionsService {
  private sms = createSmsProvider(config.smsProvider);
  constructor(private db: PrismaService, private audit: AuditService, private notifications: NotificationsService) {}

  async submit(tenantSlug: string, dto: ApplicationDto) {
    const tenant = await this.db.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) throw new NotFoundException('Établissement inconnu');
    return this.db.forTenant(tenant.id, async (tx) => {
      // GRP-003 : la demande est rattachée à un site. Avec un seul site actif, c'est lui ; avec deux ou plus, la famille
      // choisit (un ancien formulaire qui envoie le nom du site en texte est encore compris). « Indifférent » : pas de
      // site ; seuls les comptes de tout l'établissement voient la demande et lui donnent un site.
      const sites = await tx.site.findMany({ where: { active: true }, select: { id: true, name: true } });
      const wanted = dto.wantedSite?.trim().toLowerCase();
      const site = dto.siteId
        ? sites.find((x) => x.id === dto.siteId)
        : sites.length === 1 ? sites[0] : sites.find((x) => !!wanted && x.name.toLowerCase() === wanted);
      if (dto.siteId && !site) throw new BadRequestException('Choisissez un des sites de l’établissement');
      const year = new Date().getUTCFullYear();
      const reference = `PRE-${year}-${pad(await nextNumber(tx, tenant.id, `application-${year}`), 4)}`;
      const phone = normalizePhone(dto.guardianPhone, country(tenant.country).dial);
      const { siteId: _siteId, ...rest } = dto;
      const a = await tx.application.create({
        data: {
          ...rest, tenantId: tenant.id, reference, guardianPhone: phone, birthDate: dto.birthDate ? toDate(dto.birthDate) : null, studentLastName: dto.studentLastName.toUpperCase(),
          siteId: site?.id ?? null, wantedSite: site?.name ?? dto.wantedSite ?? null,
        },
      });
      // Seuls les secrétariats de ce site (et ceux de tout l'établissement) sont prévenus.
      const staff = await this.recipients(tx, site?.id ?? null);
      await this.notifications.notify(tx, tenant.id, staff, {
        kind: 'application', title: 'Nouvelle pré-inscription', body: `${dto.studentFirstName} ${dto.studentLastName} · ${dto.wantedLevel}${dto.wantedTrack ? ` · ${dto.wantedTrack}` : ''}`, data: { applicationId: a.id }, smsMode: 'none',
      });
      await sendQuietly(this.sms, phone, `${tenant.shortName ?? tenant.name} : pré-inscription de ${dto.studentFirstName} reçue (réf. ${reference}). Le secrétariat vous recontactera.`, tenant.settings);
      return { reference };
    });
  }

  /** Destinataires d'une nouvelle demande : secrétariats du site et de tout l'établissement (à défaut, la direction générale). */
  private async recipients(tx: Tx, siteId: string | null) {
    const where = siteId ? { OR: [{ siteId: null }, { siteId }] } : { siteId: null };
    let rows = await tx.userRole.findMany({ where: { role: 'SECRETARIAT', ...where }, select: { userId: true } });
    if (!rows.length) rows = await tx.userRole.findMany({ where: { role: 'DIRECTION', ...where }, select: { userId: true } });
    return [...new Set(rows.map((r) => r.userId))];
  }

  list(actor: Actor, status?: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      // GRP-003 : un personnel limité à un site ne voit que les demandes de son site.
      const scope = actor.siteIds.length ? { siteId: { in: actor.siteIds } } : {};
      const [items, counts] = await Promise.all([
        tx.application.findMany({ where: { ...scope, ...(status ? { status: status as ApplicationStatus } : {}) }, include: { site: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' }, take: 500 }),
        tx.application.groupBy({ by: ['status'], where: scope, _count: true }),
      ]);
      return { items, funnel: Object.fromEntries(counts.map((c) => [c.status, c._count])) };
    });
  }

  review(actor: Actor, id: string, dto: ReviewDto) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const current = await tx.application.findUnique({ where: { id }, select: { siteId: true, status: true } });
      if (!current) throw new NotFoundException('Pré-inscription introuvable');
      if (actor.siteIds.length && !(current.siteId && actor.siteIds.includes(current.siteId))) throw new ForbiddenException('Pré-inscription hors de votre périmètre');
      const { siteId, ...changes } = dto;
      let site: { id: string; name: string } | null = null;
      if (siteId && siteId !== current.siteId) {
        if (actor.siteIds.length) throw new ForbiddenException('Seul un compte de tout l’établissement change le site d’une demande');
        site = await tx.site.findFirst({ where: { id: siteId, active: true }, select: { id: true, name: true } });
        if (!site) throw new BadRequestException('Choisissez un des sites de l’établissement');
      }
      const a = await tx.application.update({ where: { id }, data: { ...changes, ...(site ? { siteId: site.id, wantedSite: site.name } : {}) } });
      // Un simple changement de site (même statut) n'envoie pas de SMS à la famille.
      const onlySite = !!site && dto.status === current.status;
      if (dto.status !== 'RECU' && dto.status !== 'INSCRIT' && !onlySite) {
        const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: actor.tenantId } });
        await sendQuietly(this.sms, a.guardianPhone, `${tenant.shortName ?? tenant.name} : la demande de ${a.studentFirstName} (réf. ${a.reference}) est ${STATUS_LABEL[dto.status]}.`, tenant.settings);
      }
      await this.audit.log(tx, actor, 'application.reviewed', 'Application', id, dto);
      return a;
    });
  }
}

@ApiTags('Admissions')
@Controller()
export class AdmissionsController {
  constructor(private s: AdmissionsService) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 600000 } })
  @Post('public/:tenant/applications')
  submit(@Param('tenant') tenant: string, @Body() dto: ApplicationDto) { return this.s.submit(tenant, dto); }

  @ApiBearerAuth()
  @Get('applications') @Can('admissions.manage')
  list(@CurrentActor() a: Actor, @Query('status') status?: string) { return this.s.list(a, status); }

  @ApiBearerAuth()
  @Patch('applications/:id') @Can('admissions.manage')
  review(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReviewDto) { return this.s.review(a, id, dto); }
}
