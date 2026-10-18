import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AttendanceStatus, Prisma } from '@prisma/client';
import { Actor } from '../../common/auth';
import { AuditService } from '../../common/audit.service';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { isoDay, toDate } from '../../common/util';
import { FilesService } from '../files/files.service';
import { NotificationsService } from '../notifications/notifications.service';
import { tenantSettings } from '../settings/settings.service';
import { hhmm } from '../timetable/timetable.service';

export interface RollCallInput {
  classId: string;
  classSubjectId?: string;
  date: string;
  startMinute: number;
  records: { studentId: string; status: AttendanceStatus; minutesLate?: number }[];
}

@Injectable()
export class AttendanceService {
  constructor(
    private db: PrismaService,
    private scope: ScopeService,
    private audit: AuditService,
    private notifications: NotificationsService,
    private files: FilesService,
  ) {}

  /** Cours du jour de l'enseignant, avec l'état de l'appel. */
  myCourses(actor: Actor, date?: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const day = toDate(date ?? isoDay(new Date()));
      const dow = day.getUTCDay() || 7;
      const yearId = await this.scope.currentYearId(tx);
      const slots = await tx.timetableSlot.findMany({
        where: { dayOfWeek: dow, classSubject: { class: { academicYearId: yearId }, assignments: { some: { teacherId: actor.userId } } } },
        include: { room: true, classSubject: { include: { subject: true, class: { include: { site: true } } } }, changes: { where: { date: day } } },
        orderBy: { startMinute: 'asc' },
      });
      const sessions = await tx.attendanceSession.findMany({ where: { date: day, classId: { in: slots.map((s) => s.classSubject.classId) } } });
      return slots.map((s) => ({
        slotId: s.id, classId: s.classSubject.classId, className: s.classSubject.class.name, site: s.classSubject.class.site.name,
        classSubjectId: s.classSubjectId, subject: s.classSubject.subject.name, room: s.room?.name ?? null,
        startMinute: s.startMinute, endMinute: s.endMinute, cancelled: s.changes.some((c) => c.kind === 'CANCELLED'),
        taken: sessions.find((x) => x.classId === s.classSubject.classId && x.startMinute === s.startMinute)?.takenAt ?? null,
      }));
    });
  }

  /** Feuille d'appel : élèves de la classe, présents par défaut, et saisie existante. */
  sheet(actor: Actor, classId: string, date: string, startMinute: number) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      await this.scope.assertClass(tx, actor, classId);
      const day = toDate(date);
      const [enr, session] = await Promise.all([
        tx.enrollment.findMany({
          where: { classId, status: 'ACTIVE' },
          select: { student: { select: { id: true, firstName: true, lastName: true, matricule: true, photoUrl: true } } },
          orderBy: [{ student: { lastName: 'asc' } }, { student: { firstName: 'asc' } }],
        }),
        tx.attendanceSession.findUnique({ where: { classId_date_startMinute: { classId, date: day, startMinute } }, include: { records: true } }),
      ]);
      const rec = new Map(session?.records.map((r) => [r.studentId, r]) ?? []);
      return {
        takenAt: session?.takenAt ?? null,
        students: enr.map(({ student }) => ({ ...student, status: rec.get(student.id)?.status ?? 'PRESENT', minutesLate: rec.get(student.id)?.minutesLate ?? null })),
      };
    });
  }

  /** Validation de l'appel : les absences remontent aussitôt et les parents sont prévenus (CDC §4.3). */
  rollCall(actor: Actor, input: RollCallInput) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      await this.scope.assertClass(tx, actor, input.classId);
      if (input.classSubjectId) await this.scope.assertTeaches(tx, actor, input.classSubjectId);
      const date = toDate(input.date);
      const enrolled = new Set((await tx.enrollment.findMany({ where: { classId: input.classId, status: 'ACTIVE' }, select: { studentId: true } })).map((e) => e.studentId));
      for (const r of input.records) if (!enrolled.has(r.studentId)) throw new BadRequestException("Un élève de la liste n'est pas inscrit dans cette classe");

      const existing = await tx.attendanceSession.findUnique({ where: { classId_date_startMinute: { classId: input.classId, date, startMinute: input.startMinute } }, include: { records: true } });
      if (existing && actor.role === 'ENSEIGNANT' && existing.takenById !== actor.userId) throw new ForbiddenException('Cet appel a été fait par un collègue ; la vie scolaire peut le corriger');
      const session = existing
        ? await tx.attendanceSession.update({ where: { id: existing.id }, data: { takenAt: new Date() } })
        : await tx.attendanceSession.create({ data: { tenantId: actor.tenantId, classId: input.classId, classSubjectId: input.classSubjectId, date, startMinute: input.startMinute, takenById: actor.userId } });
      const before = new Map(existing?.records.map((r) => [r.studentId, r.status]) ?? []);

      const subject = input.classSubjectId ? (await tx.classSubject.findUnique({ where: { id: input.classSubjectId }, include: { subject: true } }))?.subject.name : null;
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: actor.tenantId } });
      const smsOn = tenantSettings(tenant.settings).notifications.absenceSms;
      let notified = 0;
      for (const r of input.records) {
        await tx.attendanceRecord.upsert({
          where: { sessionId_studentId: { sessionId: session.id, studentId: r.studentId } },
          create: { tenantId: actor.tenantId, sessionId: session.id, studentId: r.studentId, status: r.status, minutesLate: r.status === 'LATE' ? r.minutesLate ?? null : null },
          update: { status: r.status, minutesLate: r.status === 'LATE' ? r.minutesLate ?? null : null },
        });
        if (r.status !== 'PRESENT' && before.get(r.studentId) !== r.status) {
          const st = await tx.student.findUniqueOrThrow({ where: { id: r.studentId }, select: { firstName: true } });
          const course = subject ? `en ${subject}` : 'en cours';
          const msg = r.status === 'ABSENT'
            ? `${st.firstName} est absent(e) ${course} ce ${date.toLocaleDateString('fr-FR', { weekday: 'long', timeZone: 'UTC' })} à ${hhmm(input.startMinute)}.`
            : `${st.firstName} est arrivé(e) en retard ${course}${r.minutesLate ? ` (${r.minutesLate} min)` : ''}.`;
          notified += await this.notifications.notify(tx, actor.tenantId, await this.notifications.guardianUserIds(tx, r.studentId), {
            kind: r.status === 'ABSENT' ? 'absence' : 'late',
            title: r.status === 'ABSENT' ? 'Absence' : 'Retard',
            body: `${msg} Vous pouvez justifier depuis votre espace parent.`,
            sms: `${msg} Justifiez depuis l'application.`,
            data: { studentId: r.studentId, sessionId: session.id },
            smsMode: smsOn && r.status === 'ABSENT' ? 'fallback' : 'none',
          });
        }
      }
      await this.audit.log(tx, actor, existing ? 'attendance.updated' : 'attendance.taken', 'AttendanceSession', session.id, {
        classId: input.classId, absents: input.records.filter((r) => r.status === 'ABSENT').length, lates: input.records.filter((r) => r.status === 'LATE').length,
      });
      return { sessionId: session.id, notified };
    });
  }

  /** Absences et retards (vie scolaire : tout ; parent : ses enfants ; élève : soi). */
  absences(actor: Actor, q: { from?: string; to?: string; classId?: string; studentId?: string; justification?: string }) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const visible = await this.scope.studentIds(tx, actor);
      if (q.studentId) await this.scope.assertStudent(tx, actor, q.studentId);
      const where: Prisma.AttendanceRecordWhereInput = {
        status: { in: ['ABSENT', 'LATE'] },
        ...(visible ? { studentId: { in: visible } } : {}),
        ...(q.studentId ? { studentId: q.studentId } : {}),
        ...(q.justification ? { justification: q.justification as any } : {}),
        session: {
          ...(q.classId ? { classId: q.classId } : {}),
          ...(q.from || q.to ? { date: { gte: q.from ? toDate(q.from) : undefined, lte: q.to ? toDate(q.to) : undefined } } : {}),
        },
      };
      const rows = await tx.attendanceRecord.findMany({
        where,
        include: {
          student: { select: { id: true, firstName: true, lastName: true, matricule: true } },
          session: { select: { date: true, startMinute: true, class: { select: { id: true, name: true } }, classSubjectId: true } },
        },
        orderBy: [{ session: { date: 'desc' } }, { session: { startMinute: 'desc' } }],
        take: 500,
      });
      const csIds = [...new Set(rows.map((r) => r.session.classSubjectId).filter(Boolean))] as string[];
      const cs = await tx.classSubject.findMany({ where: { id: { in: csIds } }, select: { id: true, subject: { select: { name: true } } } });
      const subj = new Map(cs.map((c) => [c.id, c.subject.name]));
      return rows.map((r) => ({
        id: r.id, status: r.status, minutesLate: r.minutesLate, justification: r.justification, justificationReason: r.justificationReason,
        justificationFileUrl: r.justificationFile && actor.role !== 'ELEVE' ? this.files.signedUrl(r.justificationFile) : null,
        student: r.student, class: r.session.class, date: r.session.date, startMinute: r.session.startMinute,
        subject: r.session.classSubjectId ? subj.get(r.session.classSubjectId) ?? null : null,
      }));
    });
  }

  /** Justification par le parent (motif + photo du certificat). */
  justify(actor: Actor, recordId: string, reason: string, file?: { buffer: Buffer; mimetype: string; size: number }) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const r = await tx.attendanceRecord.findUnique({ where: { id: recordId }, include: { student: true } });
      if (!r) throw new NotFoundException('Absence introuvable');
      await this.scope.assertStudent(tx, actor, r.studentId);
      if (r.justification === 'ACCEPTED') throw new BadRequestException('Cette absence est déjà justifiée');
      const key = file ? await this.files.save(actor.tenantId, 'justificatifs', file) : r.justificationFile;
      await tx.attendanceRecord.update({ where: { id: recordId }, data: { justification: 'PENDING', justificationReason: reason, justificationFile: key, justifiedById: actor.userId } });
      const staff = await tx.userRole.findMany({ where: { role: 'VIE_SCOLAIRE' }, select: { userId: true } });
      await this.notifications.notify(tx, actor.tenantId, staff.map((s) => s.userId), {
        kind: 'justification', title: 'Justificatif à valider', body: `${r.student.firstName} ${r.student.lastName} : ${reason}`, data: { recordId }, smsMode: 'none',
      });
      await this.audit.log(tx, actor, 'attendance.justified', 'AttendanceRecord', recordId, { reason, file: !!key });
      return { ok: true };
    });
  }

  review(actor: Actor, recordId: string, accept: boolean, comment?: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const r = await tx.attendanceRecord.findUniqueOrThrow({ where: { id: recordId }, include: { student: true } });
      await tx.attendanceRecord.update({ where: { id: recordId }, data: { justification: accept ? 'ACCEPTED' : 'REJECTED', reviewedById: actor.userId, reviewedAt: new Date() } });
      await this.notifications.notify(tx, actor.tenantId, await this.notifications.guardianUserIds(tx, r.studentId), {
        kind: 'justification', title: accept ? 'Justificatif accepté' : 'Justificatif refusé',
        body: `Le justificatif pour l'absence de ${r.student.firstName} a été ${accept ? 'accepté' : 'refusé'} par la vie scolaire.${comment ? ` ${comment}` : ''}`, smsMode: 'none',
      });
      await this.audit.log(tx, actor, accept ? 'attendance.justification_accepted' : 'attendance.justification_rejected', 'AttendanceRecord', recordId, { comment });
      return { ok: true };
    });
  }

  /** Tableau de bord d'assiduité du jour (CDC §4.3). */
  today(actor: Actor, date?: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const day = toDate(date ?? isoDay(new Date()));
      const classIds = await this.scope.classIds(tx, actor);
      const sessionWhere = { date: day, ...(classIds ? { classId: { in: classIds } } : {}) };
      const [absent, late, total, pending, unjustified, sessions] = await Promise.all([
        tx.attendanceRecord.count({ where: { status: 'ABSENT', session: sessionWhere } }),
        tx.attendanceRecord.count({ where: { status: 'LATE', session: sessionWhere } }),
        tx.attendanceRecord.count({ where: { session: sessionWhere } }),
        tx.attendanceRecord.count({ where: { justification: 'PENDING', ...(classIds ? { session: { classId: { in: classIds } } } : {}) } }),
        tx.attendanceRecord.count({ where: { status: 'ABSENT', justification: { in: ['NONE', 'REJECTED'] }, ...(classIds ? { session: { classId: { in: classIds } } } : {}) } }),
        tx.attendanceSession.count({ where: sessionWhere }),
      ]);
      return { date: isoDay(day), absent, late, presenceRate: total ? Math.round(((total - absent) / total) * 1000) / 10 : null, pendingJustifications: pending, unjustified, sessionsTaken: sessions };
    });
  }

  // ------------------------------------------------------------ Sanctions
  sanctions(actor: Actor, studentId?: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const visible = await this.scope.studentIds(tx, actor);
      if (studentId) await this.scope.assertStudent(tx, actor, studentId);
      return tx.sanction.findMany({
        where: { ...(visible ? { studentId: { in: visible } } : {}), ...(studentId ? { studentId } : {}), ...(['PARENT', 'ELEVE'].includes(actor.role) ? { status: 'VALIDATED' } : {}) },
        include: { student: { select: { id: true, firstName: true, lastName: true, matricule: true } } },
        orderBy: { date: 'desc' },
        take: 300,
      });
    });
  }

  /** L'enseignant propose, la vie scolaire saisit directement, la direction valide (CDC §2.9). */
  createSanction(actor: Actor, dto: { studentId: string; kind: string; reason: string; date: string }) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      await this.scope.assertStudent(tx, actor, dto.studentId);
      const s = await tx.sanction.create({
        data: { tenantId: actor.tenantId, studentId: dto.studentId, kind: dto.kind, reason: dto.reason, date: toDate(dto.date), proposedById: actor.userId, status: 'PROPOSED' },
      });
      await this.audit.log(tx, actor, 'sanction.proposed', 'Sanction', s.id, dto);
      return s;
    });
  }

  decideSanction(actor: Actor, id: string, validate: boolean) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const s = await tx.sanction.update({ where: { id }, data: { status: validate ? 'VALIDATED' : 'REJECTED', validatedById: actor.userId }, include: { student: true } });
      if (validate) {
        await this.notifications.notify(tx, actor.tenantId, await this.notifications.guardianUserIds(tx, s.studentId), {
          kind: 'sanction', title: 'Sanction', body: `${s.student.firstName} : ${s.kind}. Motif : ${s.reason}.`, smsMode: 'fallback', sms: `${s.student.firstName} : ${s.kind}. Consultez l'application.`,
        });
      }
      await this.audit.log(tx, actor, validate ? 'sanction.validated' : 'sanction.rejected', 'Sanction', id);
      return s;
    });
  }
}
