import { Body, Controller, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ApplicationStatus, Sex } from '@prisma/client';
import { IsDateString, IsEmail, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Actor, Can, CurrentActor, Public } from '../../common/auth';
import { AuditService } from '../../common/audit.service';
import { PrismaService } from '../../common/prisma.service';
import { nextNumber, normalizePhone, pad, toDate } from '../../common/util';
import { NotificationsService } from '../notifications/notifications.service';
import { createSmsProvider } from '../notifications/sms.provider';
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
  @IsString() @MinLength(3) @MaxLength(120) guardianName: string;
  @IsString() @MinLength(8) @MaxLength(30) guardianPhone: string;
  @IsOptional() @IsEmail() guardianEmail?: string;
  @IsOptional() @IsString() @MaxLength(1000) message?: string;
}

class ReviewDto {
  @IsEnum(ApplicationStatus) status: ApplicationStatus;
  @IsOptional() @IsString() @MaxLength(200) testResult?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
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
      const year = new Date().getUTCFullYear();
      const reference = `PRE-${year}-${pad(await nextNumber(tx, tenant.id, `application-${year}`), 4)}`;
      const phone = normalizePhone(dto.guardianPhone);
      const a = await tx.application.create({
        data: { ...dto, tenantId: tenant.id, reference, guardianPhone: phone, birthDate: dto.birthDate ? toDate(dto.birthDate) : null, studentLastName: dto.studentLastName.toUpperCase() },
      });
      const staff = await tx.userRole.findMany({ where: { role: 'SECRETARIAT' }, select: { userId: true } });
      await this.notifications.notify(tx, tenant.id, staff.map((s) => s.userId), {
        kind: 'application', title: 'Nouvelle pré-inscription', body: `${dto.studentFirstName} ${dto.studentLastName} · ${dto.wantedLevel}${dto.wantedTrack ? ` · ${dto.wantedTrack}` : ''}`, data: { applicationId: a.id }, smsMode: 'none',
      });
      await this.sms.send(phone, `${tenant.shortName ?? tenant.name} : pré-inscription de ${dto.studentFirstName} reçue (réf. ${reference}). Le secrétariat vous recontactera.`);
      return { reference };
    });
  }

  list(actor: Actor, status?: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const [items, counts] = await Promise.all([
        tx.application.findMany({ where: status ? { status: status as ApplicationStatus } : {}, orderBy: { createdAt: 'desc' }, take: 500 }),
        tx.application.groupBy({ by: ['status'], _count: true }),
      ]);
      return { items, funnel: Object.fromEntries(counts.map((c) => [c.status, c._count])) };
    });
  }

  review(actor: Actor, id: string, dto: ReviewDto) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const a = await tx.application.update({ where: { id }, data: dto });
      if (dto.status !== 'RECU' && dto.status !== 'INSCRIT') {
        const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: actor.tenantId } });
        await this.sms.send(a.guardianPhone, `${tenant.shortName ?? tenant.name} : la demande de ${a.studentFirstName} (réf. ${a.reference}) est ${STATUS_LABEL[dto.status]}.`);
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
