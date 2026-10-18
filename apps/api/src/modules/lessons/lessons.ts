import { Body, Controller, ForbiddenException, Get, Injectable, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { Actor, Can, CurrentActor } from '../../common/auth';
import { AuditService } from '../../common/audit.service';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { isoDay, toDate } from '../../common/util';
import { NotificationsService } from '../notifications/notifications.service';

class LessonDto {
  @IsUUID() classSubjectId: string;
  @IsDateString() date: string;
  @IsString() @MaxLength(160) title: string;
  @IsString() @MaxLength(4000) content: string;
  @IsOptional() @IsString() @MaxLength(1000) homework?: string;
  @IsOptional() @IsDateString() homeworkDue?: string;
}
class LessonUpdateDto {
  @IsOptional() @IsString() @MaxLength(160) title?: string;
  @IsOptional() @IsString() @MaxLength(4000) content?: string;
  @IsOptional() @IsString() @MaxLength(1000) homework?: string;
  @IsOptional() @IsDateString() homeworkDue?: string;
}

/** Cahier de texte : contenu des séances et devoirs, visibles des élèves et des parents (CDC §4.2). */
@Injectable()
export class LessonsService {
  constructor(private db: PrismaService, private scope: ScopeService, private audit: AuditService, private notifications: NotificationsService) {}

  list(actor: Actor, q: { classId?: string; classSubjectId?: string; from?: string; to?: string }) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const visible = await this.scope.classIds(tx, actor);
      if (q.classId) await this.scope.assertClass(tx, actor, q.classId);
      return tx.lesson.findMany({
        where: {
          classSubject: {
            ...(visible ? { classId: { in: visible } } : {}),
            ...(q.classId ? { classId: q.classId } : {}),
            ...(actor.role === 'ENSEIGNANT' && !q.classId ? { assignments: { some: { teacherId: actor.userId } } } : {}),
          },
          ...(q.classSubjectId ? { classSubjectId: q.classSubjectId } : {}),
          ...(q.from || q.to ? { date: { gte: q.from ? toDate(q.from) : undefined, lte: q.to ? toDate(q.to) : undefined } } : {}),
        },
        include: { classSubject: { select: { id: true, subject: { select: { name: true } }, class: { select: { id: true, name: true } } } } },
        orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
        take: 200,
      });
    });
  }

  /** Devoirs à faire à partir d'aujourd'hui pour un élève. */
  homework(actor: Actor, studentId: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      await this.scope.assertStudent(tx, actor, studentId);
      const yearId = await this.scope.currentYearId(tx);
      const enr = await tx.enrollment.findUnique({ where: { studentId_academicYearId: { studentId, academicYearId: yearId } } });
      if (!enr) return [];
      return tx.lesson.findMany({
        where: { classSubject: { classId: enr.classId }, homework: { not: null }, homeworkDue: { gte: toDate(isoDay(new Date())) } },
        include: { classSubject: { select: { subject: { select: { name: true } } } } },
        orderBy: { homeworkDue: 'asc' },
      });
    });
  }

  create(actor: Actor, dto: LessonDto) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      await this.scope.assertTeaches(tx, actor, dto.classSubjectId);
      const l = await tx.lesson.create({
        data: { tenantId: actor.tenantId, ...dto, date: toDate(dto.date), homeworkDue: dto.homeworkDue ? toDate(dto.homeworkDue) : null, authorId: actor.userId },
        include: { classSubject: { include: { subject: true } } },
      });
      if (l.homework) {
        const enr = await tx.enrollment.findMany({ where: { classId: l.classSubject.classId, status: 'ACTIVE' }, select: { studentId: true } });
        const users: string[] = [];
        for (const e of enr) users.push(...(await this.notifications.studentAudience(tx, e.studentId)));
        await this.notifications.notify(tx, actor.tenantId, users, {
          kind: 'homework', title: `Devoir · ${l.classSubject.subject.name}`,
          body: `${l.homework}${l.homeworkDue ? ` (pour le ${l.homeworkDue.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })})` : ''}`, smsMode: 'none',
        });
      }
      await this.audit.log(tx, actor, 'lesson.created', 'Lesson', l.id);
      return l;
    });
  }

  update(actor: Actor, id: string, dto: LessonUpdateDto) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const l = await tx.lesson.findUniqueOrThrow({ where: { id } });
      if (l.authorId !== actor.userId) throw new ForbiddenException('Seul l’auteur peut modifier cette séance');
      return tx.lesson.update({ where: { id }, data: { ...dto, homeworkDue: dto.homeworkDue ? toDate(dto.homeworkDue) : undefined } });
    });
  }
}

@ApiTags('Cahier de texte')
@ApiBearerAuth()
@Controller('lessons')
export class LessonsController {
  constructor(private s: LessonsService) {}

  @Get() @Can('lessons.read')
  list(@CurrentActor() a: Actor, @Query('classId') classId?: string, @Query('classSubjectId') cs?: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.s.list(a, { classId, classSubjectId: cs, from, to });
  }

  @Get('homework/:studentId') @Can('lessons.read')
  homework(@CurrentActor() a: Actor, @Param('studentId', ParseUUIDPipe) id: string) { return this.s.homework(a, id); }

  @Post() @Can('lessons.write')
  create(@CurrentActor() a: Actor, @Body() dto: LessonDto) { return this.s.create(a, dto); }

  @Patch(':id') @Can('lessons.write')
  update(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: LessonUpdateDto) { return this.s.update(a, id, dto); }
}
