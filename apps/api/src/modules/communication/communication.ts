import { Body, Controller, Get, Injectable, NotFoundException, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Audience, Prisma } from '@prisma/client';
import { IsBoolean, IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { Actor, Can, CurrentActor, Public } from '../../common/auth';
import { AuditService } from '../../common/audit.service';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { FilesService } from '../files/files.service';
import { NotificationsService } from '../notifications/notifications.service';
import { logoUrl, tenantSettings } from '../settings/settings.service';

class AnnouncementDto {
  @IsString() @MaxLength(160) title: string;
  @IsString() @MaxLength(4000) body: string;
  @IsEnum(Audience) audience: Audience;
  @IsOptional() @IsUUID() classId?: string;
  @IsOptional() @IsUUID() siteId?: string;
  /// Alerte d'urgence : diffusion immédiate par SMS en plus de l'application (CDC §4.5).
  @IsOptional() @IsBoolean() urgent?: boolean;
}

const STAFF = ['DIRECTION', 'SECRETARIAT', 'ENSEIGNANT', 'VIE_SCOLAIRE', 'COMPTABLE'] as const;

/** Annonces ciblées et alertes d'urgence. */
@Injectable()
export class CommunicationService {
  constructor(private db: PrismaService, private scope: ScopeService, private audit: AuditService, private notifications: NotificationsService) {}

  list(actor: Actor) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const isStaff = (STAFF as readonly string[]).includes(actor.role);
      const classIds = (await this.scope.classIds(tx, actor)) ?? [];
      const audiences: Prisma.AnnouncementWhereInput[] = [{ audience: 'ALL' }];
      if (isStaff) audiences.push({ audience: 'STAFF' });
      if (actor.role === 'ENSEIGNANT') audiences.push({ audience: 'TEACHERS' });
      if (actor.role === 'PARENT') audiences.push({ audience: 'PARENTS' });
      if (['DIRECTION', 'SECRETARIAT', 'VIE_SCOLAIRE'].includes(actor.role)) audiences.push({ audience: { in: ['PARENTS', 'TEACHERS', 'CLASS'] } });
      else audiences.push({ audience: 'CLASS', classId: { in: classIds } });
      return tx.announcement.findMany({
        where: { OR: audiences },
        include: { class: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
    });
  }

  create(actor: Actor, dto: AnnouncementDto) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      if (dto.audience === 'CLASS' && !dto.classId) throw new NotFoundException('Choisissez la classe');
      const a = await tx.announcement.create({ data: { tenantId: actor.tenantId, ...dto, urgent: !!dto.urgent, authorId: actor.userId } });
      // Destinataires construits à partir des inscriptions : aucune liste à tenir à la main (CDC §4.5).
      let userIds: string[] = [];
      const yearId = await this.scope.currentYearId(tx);
      const families = async (where: Prisma.EnrollmentWhereInput) => {
        const enr = await tx.enrollment.findMany({ where: { academicYearId: yearId, status: 'ACTIVE', ...where }, select: { studentId: true } });
        const ids: string[] = [];
        for (const e of enr) ids.push(...(await this.notifications.studentAudience(tx, e.studentId)));
        return ids;
      };
      const roleUsers = async (roles: string[]) => (await tx.userRole.findMany({ where: { role: { in: roles as any } }, select: { userId: true } })).map((r) => r.userId);
      const site = dto.siteId ? { class: { siteId: dto.siteId } } : {};
      if (dto.audience === 'ALL') userIds = [...(await families(site)), ...(await roleUsers([...STAFF]))];
      if (dto.audience === 'PARENTS') userIds = await families(site);
      if (dto.audience === 'STAFF') userIds = await roleUsers([...STAFF]);
      if (dto.audience === 'TEACHERS') userIds = await roleUsers(['ENSEIGNANT']);
      if (dto.audience === 'CLASS') userIds = await families({ classId: dto.classId });
      const sent = await this.notifications.notify(tx, actor.tenantId, userIds, {
        kind: dto.urgent ? 'urgent' : 'announcement', title: dto.urgent ? `URGENT · ${dto.title}` : dto.title, body: dto.body,
        sms: `${dto.title} : ${dto.body}`.slice(0, 300), data: { announcementId: a.id }, smsMode: dto.urgent ? 'immediate' : 'none',
      });
      await this.audit.log(tx, actor, dto.urgent ? 'announcement.urgent' : 'announcement.created', 'Announcement', a.id, { audience: dto.audience, recipients: sent });
      return { ...a, recipients: sent };
    });
  }
}

/** Informations publiques de l'établissement pour le site vitrine. */
@Injectable()
export class PublicService {
  constructor(private db: PrismaService, private files: FilesService) {}

  async school(slug: string) {
    const t = await this.db.tenant.findUnique({ where: { slug } });
    if (!t) throw new NotFoundException('Établissement inconnu');
    const s = tenantSettings(t.settings);
    const branding = { logoUrl: logoUrl(t), primaryColor: s.branding.primaryColor };
    if (t.status === 'SUSPENDED') return { name: t.name, shortName: t.shortName, suspended: true, branding };
    return this.db.forTenant(t.id, async (tx) => {
      const [sites, tracks, levels] = await Promise.all([
        tx.site.findMany({ where: { active: true }, select: { id: true, name: true, address: true, phone: true }, orderBy: { name: 'asc' } }),
        tx.track.findMany({ select: { code: true, name: true, cycle: true }, orderBy: { name: 'asc' } }),
        tx.level.findMany({ select: { name: true, cycle: true }, orderBy: { position: 'asc' } }),
      ]);
      return {
        name: t.name, shortName: t.shortName, country: t.country, suspended: false, branding,
        /// Comptes de démonstration affichés à la connexion uniquement pour l'école de démonstration.
        demo: (t.settings as any)?.demo === true,
        public: (t.settings as any)?.public ?? {}, sites, tracks, levels,
      };
    });
  }

  async logo(slug: string) {
    const t = await this.db.tenant.findUnique({ where: { slug } });
    const key = t && tenantSettings(t.settings).branding.logoKey;
    if (!key) throw new NotFoundException('Aucun logo');
    return this.files.readKey(key);
  }
}

@ApiTags('Communication')
@Controller()
export class CommunicationController {
  constructor(private s: CommunicationService, private pub: PublicService) {}

  @ApiBearerAuth()
  @Get('announcements') @Can('announcements.read')
  list(@CurrentActor() a: Actor) { return this.s.list(a); }

  @ApiBearerAuth()
  @Post('announcements') @Can('announcements.write')
  create(@CurrentActor() a: Actor, @Body() dto: AnnouncementDto) { return this.s.create(a, dto); }

  @Public()
  @Get('public/:tenant')
  school(@Param('tenant') tenant: string) { return this.pub.school(tenant); }

  @Public()
  @Get('public/:tenant/logo')
  async logo(@Param('tenant') tenant: string, @Res() res: Response) {
    const f = await this.pub.logo(tenant);
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(f.buffer);
  }
}
