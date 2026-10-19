import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InternshipStatus } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { Actor, Can, CurrentActor } from '../../common/auth';
import { AuditService } from '../../common/audit.service';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { toDate } from '../../common/util';

export class InternshipPeriodDto {
  @IsString() @MaxLength(120) label: string;
  @IsOptional() @IsUUID() levelId?: string | null;
  @IsOptional() @IsUUID() trackId?: string | null;
  @IsDateString() startDate: string;
  @IsDateString() endDate: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
}

export class PlacementDto {
  @IsUUID() studentId: string;
  @IsString() @MaxLength(160) company: string;
  @IsOptional() @IsString() @MaxLength(300) companyAddress?: string | null;
  @IsOptional() @IsString() @MaxLength(40) companyPhone?: string | null;
  @IsOptional() @IsString() @MaxLength(120) tutorName?: string | null;
  @IsOptional() @IsString() @MaxLength(40) tutorPhone?: string | null;
  @IsOptional() @IsEnum(InternshipStatus) status?: InternshipStatus;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
}

/**
 * Stages en entreprise (affiches de l'école, absent du cahier des charges) : l'école définit elle-même
 * ses périodes de stage par niveau et filière, puis le lieu et le tuteur de chaque élève.
 */
@Injectable()
export class InternshipsService {
  constructor(private db: PrismaService, private scope: ScopeService, private audit: AuditService) {}

  periods(actor: Actor) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const academicYearId = await this.scope.currentYearId(tx);
      const rows = await tx.internshipPeriod.findMany({
        where: { academicYearId },
        include: { placements: { select: { status: true } } },
        orderBy: { startDate: 'asc' },
      });
      return rows.map(({ placements, ...p }) => ({
        ...p,
        placed: placements.filter((x) => x.status !== 'CANCELLED').length,
        done: placements.filter((x) => x.status === 'DONE').length,
      }));
    });
  }

  private checkDates(start: string, end: string) {
    if (toDate(end) < toDate(start)) throw new BadRequestException('La date de fin doit suivre la date de début');
  }

  createPeriod(actor: Actor, dto: InternshipPeriodDto) {
    this.checkDates(dto.startDate, dto.endDate);
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const academicYearId = await this.scope.currentYearId(tx);
      const p = await tx.internshipPeriod.create({
        data: {
          tenantId: actor.tenantId, academicYearId, label: dto.label, levelId: dto.levelId ?? null, trackId: dto.trackId ?? null,
          startDate: toDate(dto.startDate), endDate: toDate(dto.endDate), notes: dto.notes ?? null,
        },
      });
      await this.audit.log(tx, actor, 'internship_period.created', 'InternshipPeriod', p.id, dto);
      return p;
    });
  }

  updatePeriod(actor: Actor, id: string, dto: InternshipPeriodDto) {
    this.checkDates(dto.startDate, dto.endDate);
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const p = await tx.internshipPeriod.update({
        where: { id },
        data: { label: dto.label, levelId: dto.levelId ?? null, trackId: dto.trackId ?? null, startDate: toDate(dto.startDate), endDate: toDate(dto.endDate), notes: dto.notes ?? null },
      });
      await this.audit.log(tx, actor, 'internship_period.updated', 'InternshipPeriod', id, dto);
      return p;
    });
  }

  removePeriod(actor: Actor, id: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const used = await tx.internshipPlacement.count({ where: { periodId: id } });
      if (used) throw new ConflictException(`${used} élève(s) sont déjà placés sur cette période : retirez-les d’abord`);
      await tx.internshipPeriod.delete({ where: { id } });
      await this.audit.log(tx, actor, 'internship_period.removed', 'InternshipPeriod', id);
      return { ok: true };
    });
  }

  /** Période, élèves concernés (classes du niveau et de la filière) et leur placement. */
  period(actor: Actor, id: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const p = await tx.internshipPeriod.findUnique({ where: { id }, include: { placements: true } });
      if (!p) throw new NotFoundException('Période de stage introuvable');
      const visible = await this.scope.studentIds(tx, actor);
      const enrollments = await tx.enrollment.findMany({
        where: {
          academicYearId: p.academicYearId,
          status: 'ACTIVE',
          class: { ...(p.levelId ? { levelId: p.levelId } : {}), ...(p.trackId ? { trackId: p.trackId } : {}) },
          ...(visible ? { studentId: { in: visible } } : {}),
        },
        select: {
          student: { select: { id: true, matricule: true, firstName: true, lastName: true } },
          class: { select: { id: true, name: true, site: { select: { name: true } } } },
        },
        orderBy: [{ class: { name: 'asc' } }, { student: { lastName: 'asc' } }, { student: { firstName: 'asc' } }],
      });
      const byStudent = new Map(p.placements.map((x) => [x.studentId, x]));
      const { placements, ...period } = p;
      return {
        period,
        students: enrollments.map((e) => ({ ...e.student, class: e.class, placement: byStudent.get(e.student.id) ?? null })),
      };
    });
  }

  upsertPlacement(actor: Actor, periodId: string, dto: PlacementDto) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      await this.scope.assertStudent(tx, actor, dto.studentId);
      const data = {
        company: dto.company, companyAddress: dto.companyAddress ?? null, companyPhone: dto.companyPhone ?? null,
        tutorName: dto.tutorName ?? null, tutorPhone: dto.tutorPhone ?? null, status: dto.status ?? 'PLANNED', notes: dto.notes ?? null,
      };
      const row = await tx.internshipPlacement.upsert({
        where: { periodId_studentId: { periodId, studentId: dto.studentId } },
        create: { tenantId: actor.tenantId, periodId, studentId: dto.studentId, ...data },
        update: data,
      });
      await this.audit.log(tx, actor, 'internship_placement.saved', 'InternshipPlacement', row.id, dto);
      return row;
    });
  }

  removePlacement(actor: Actor, id: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      await tx.internshipPlacement.delete({ where: { id } });
      await this.audit.log(tx, actor, 'internship_placement.removed', 'InternshipPlacement', id);
      return { ok: true };
    });
  }

  /** Stages d'un élève, pour sa fiche (personnel) ou l'espace famille. */
  forStudent(actor: Actor, studentId: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      await this.scope.assertStudent(tx, actor, studentId);
      return tx.internshipPlacement.findMany({
        where: { studentId },
        include: { period: { select: { label: true, startDate: true, endDate: true } } },
        orderBy: { period: { startDate: 'desc' } },
      });
    });
  }
}

@ApiTags('Stages')
@ApiBearerAuth()
@Controller()
export class InternshipsController {
  constructor(private s: InternshipsService) {}

  @Get('internships/periods') @Can('students.read')
  periods(@CurrentActor() a: Actor) { return this.s.periods(a); }

  @Post('internships/periods') @Can('settings.manage')
  createPeriod(@CurrentActor() a: Actor, @Body() dto: InternshipPeriodDto) { return this.s.createPeriod(a, dto); }

  @Get('internships/periods/:id') @Can('students.read')
  period(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.s.period(a, id); }

  @Patch('internships/periods/:id') @Can('settings.manage')
  updatePeriod(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: InternshipPeriodDto) { return this.s.updatePeriod(a, id, dto); }

  @Delete('internships/periods/:id') @Can('settings.manage')
  removePeriod(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.s.removePeriod(a, id); }

  @Put('internships/periods/:id/placements') @Can('settings.manage')
  upsertPlacement(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PlacementDto) { return this.s.upsertPlacement(a, id, dto); }

  @Delete('internships/placements/:id') @Can('settings.manage')
  removePlacement(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.s.removePlacement(a, id); }

  @Get('students/:id/internships') @Can('students.read', 'grades.read')
  forStudent(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.s.forStudent(a, id); }
}
