import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { TimetableChangeKind } from '@prisma/client';
import { Actor } from '../../common/auth';
import { AuditService } from '../../common/audit.service';
import { PrismaService, Tx } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { isoDay, toDate } from '../../common/util';
import { NotificationsService } from '../notifications/notifications.service';

export const DAYS = ['', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
export const hhmm = (m: number) => `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`.replace(' 00', '');

export interface SlotInput {
  classSubjectId: string;
  roomId?: string | null;
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
}

export interface ChangeInput {
  date: string;
  kind: TimetableChangeKind;
  newDate?: string;
  newStartMinute?: number;
  newEndMinute?: number;
  newRoomId?: string;
  reason?: string;
}

/** Lundi de la semaine contenant la date. */
export function mondayOf(d: Date) {
  const day = d.getUTCDay() || 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 1));
}

@Injectable()
export class TimetableService {
  constructor(
    private db: PrismaService,
    private scope: ScopeService,
    private audit: AuditService,
    private notifications: NotificationsService,
  ) {}

  /** Emploi du temps de la semaine, par classe, enseignant ou salle, avec les cours annulés ou déplacés. */
  week(actor: Actor, q: { classId?: string; teacherId?: string; roomId?: string; week?: string }) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const monday = mondayOf(q.week ? toDate(q.week) : new Date());
      const sunday = new Date(monday.getTime() + 6 * 86400000);
      const yearId = await this.scope.currentYearId(tx);
      let teacherId = q.teacherId;
      if (actor.role === 'ENSEIGNANT' && !q.classId) teacherId = actor.userId;
      if (q.classId) await this.scope.assertClass(tx, actor, q.classId);
      else if (teacherId && actor.role !== 'ENSEIGNANT' && !['DIRECTION', 'SECRETARIAT', 'VIE_SCOLAIRE'].includes(actor.role)) throw new ForbiddenException();
      else if (!teacherId && !q.roomId) throw new BadRequestException('Précisez une classe, un enseignant ou une salle');

      const slots = await tx.timetableSlot.findMany({
        where: {
          classSubject: {
            class: { academicYearId: yearId },
            ...(q.classId ? { classId: q.classId } : {}),
            ...(teacherId ? { assignments: { some: { teacherId } } } : {}),
          },
          ...(q.roomId ? { roomId: q.roomId } : {}),
        },
        include: {
          room: { select: { id: true, name: true } },
          classSubject: {
            select: {
              id: true, subject: { select: { name: true, code: true } }, class: { select: { id: true, name: true, site: { select: { name: true } } } },
              assignments: { select: { teacher: { select: { id: true, firstName: true, lastName: true } } } },
            },
          },
          changes: { where: { OR: [{ date: { gte: monday, lte: sunday } }, { newDate: { gte: monday, lte: sunday } }] } },
        },
        orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }],
      });
      const rooms = await tx.room.findMany({ select: { id: true, name: true } });
      const roomName = new Map(rooms.map((r) => [r.id, r.name]));
      return {
        week: isoDay(monday),
        slots: slots.map((s) => ({
          id: s.id, dayOfWeek: s.dayOfWeek, startMinute: s.startMinute, endMinute: s.endMinute, room: s.room,
          subject: s.classSubject.subject, class: s.classSubject.class, classSubjectId: s.classSubject.id,
          teachers: s.classSubject.assignments.map((a) => a.teacher),
          changes: s.changes.map((c) => ({ ...c, newRoomName: c.newRoomId ? roomName.get(c.newRoomId) ?? null : null })),
        })),
      };
    });
  }

  /** Détection des conflits : une classe, un enseignant ou une salle sur deux créneaux (CDC §4.2). */
  private async conflicts(tx: Tx, input: SlotInput, ignoreSlotId?: string) {
    if (input.endMinute <= input.startMinute) throw new BadRequestException("L'heure de fin doit suivre l'heure de début");
    if (input.dayOfWeek < 1 || input.dayOfWeek > 6) throw new BadRequestException('Jour invalide');
    const cs = await tx.classSubject.findUniqueOrThrow({ where: { id: input.classSubjectId }, include: { assignments: true, class: true } });
    const teacherIds = cs.assignments.map((a) => a.teacherId);
    const overlapping = await tx.timetableSlot.findMany({
      where: {
        id: ignoreSlotId ? { not: ignoreSlotId } : undefined,
        dayOfWeek: input.dayOfWeek,
        startMinute: { lt: input.endMinute },
        endMinute: { gt: input.startMinute },
        classSubject: { class: { academicYearId: cs.class.academicYearId } },
      },
      include: { room: true, classSubject: { include: { class: true, subject: true, assignments: { include: { teacher: true } } } } },
    });
    const messages: string[] = [];
    for (const o of overlapping) {
      const what = `${o.classSubject.subject.name} en ${o.classSubject.class.name} (${DAYS[o.dayOfWeek]} ${hhmm(o.startMinute)}-${hhmm(o.endMinute)})`;
      if (o.classSubject.classId === cs.classId) messages.push(`La classe a déjà ${what}`);
      if (input.roomId && o.roomId === input.roomId) messages.push(`La salle ${o.room?.name} est prise par ${what}`);
      const t = o.classSubject.assignments.find((a) => teacherIds.includes(a.teacherId));
      if (t) messages.push(`${t.teacher.firstName} ${t.teacher.lastName} enseigne déjà ${what}`);
    }
    if (messages.length) throw new ConflictException([...new Set(messages)].join(' · '));
    return cs;
  }

  createSlot(actor: Actor, input: SlotInput) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      await this.conflicts(tx, input);
      const slot = await tx.timetableSlot.create({ data: { ...input, roomId: input.roomId ?? null, tenantId: actor.tenantId } });
      await this.audit.log(tx, actor, 'timetable.slot_created', 'TimetableSlot', slot.id, input);
      return slot;
    });
  }

  updateSlot(actor: Actor, id: string, input: Partial<SlotInput>) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const cur = await tx.timetableSlot.findUniqueOrThrow({ where: { id } });
      const next: SlotInput = {
        classSubjectId: input.classSubjectId ?? cur.classSubjectId, roomId: input.roomId === undefined ? cur.roomId : input.roomId,
        dayOfWeek: input.dayOfWeek ?? cur.dayOfWeek, startMinute: input.startMinute ?? cur.startMinute, endMinute: input.endMinute ?? cur.endMinute,
      };
      await this.conflicts(tx, next, id);
      const slot = await tx.timetableSlot.update({ where: { id }, data: next });
      await this.audit.log(tx, actor, 'timetable.slot_updated', 'TimetableSlot', id, input);
      return slot;
    });
  }

  deleteSlot(actor: Actor, id: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      await tx.timetableSlot.delete({ where: { id } });
      await this.audit.log(tx, actor, 'timetable.slot_deleted', 'TimetableSlot', id);
      return { ok: true };
    });
  }

  /** Modification ponctuelle avec notification aux élèves, aux parents et à l'enseignant (CDC §4.2). */
  addChange(actor: Actor, slotId: string, input: ChangeInput) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const slot = await tx.timetableSlot.findUniqueOrThrow({
        where: { id: slotId },
        include: { classSubject: { include: { subject: true, class: true, assignments: true } } },
      });
      const date = toDate(input.date);
      const dow = date.getUTCDay() || 7;
      if (dow !== slot.dayOfWeek) throw new BadRequestException(`Ce cours a lieu le ${DAYS[slot.dayOfWeek]}, pas le ${DAYS[dow] ?? 'dimanche'}`);
      if (input.kind === 'MOVED') {
        if (!input.newDate || input.newStartMinute === undefined || input.newEndMinute === undefined) throw new BadRequestException('Indiquez la nouvelle date et les nouveaux horaires');
        const nd = toDate(input.newDate);
        await this.conflicts(tx, { classSubjectId: slot.classSubjectId, roomId: input.newRoomId ?? slot.roomId, dayOfWeek: nd.getUTCDay() || 7, startMinute: input.newStartMinute, endMinute: input.newEndMinute }, slot.id);
      }
      if (input.kind === 'ROOM_CHANGED' && !input.newRoomId) throw new BadRequestException('Choisissez la nouvelle salle');
      const data = {
        kind: input.kind, reason: input.reason, newDate: input.newDate ? toDate(input.newDate) : null,
        newStartMinute: input.newStartMinute ?? null, newEndMinute: input.newEndMinute ?? null, newRoomId: input.newRoomId ?? null, createdById: actor.userId,
      };
      const change = await tx.timetableChange.upsert({
        where: { slotId_date: { slotId, date } },
        create: { tenantId: actor.tenantId, slotId, date, ...data },
        update: data,
      });

      const subject = slot.classSubject.subject.name;
      const when = `${DAYS[slot.dayOfWeek].toLowerCase()} ${date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', timeZone: 'UTC' })} à ${hhmm(slot.startMinute)}`;
      let body: string;
      if (input.kind === 'CANCELLED') body = `Le cours de ${subject} du ${when} est annulé.`;
      else if (input.kind === 'MOVED') body = `Le cours de ${subject} du ${when} est déplacé au ${toDate(input.newDate!).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })} à ${hhmm(input.newStartMinute!)}.`;
      else {
        const room = await tx.room.findUnique({ where: { id: input.newRoomId! } });
        body = `Le cours de ${subject} du ${when} aura lieu en ${room?.name ?? 'autre salle'}.`;
      }
      if (input.reason) body += ` Motif : ${input.reason}.`;
      const enr = await tx.enrollment.findMany({ where: { classId: slot.classSubject.classId, status: 'ACTIVE' }, select: { studentId: true } });
      const recipients = [...slot.classSubject.assignments.map((a) => a.teacherId)];
      for (const e of enr) recipients.push(...(await this.notifications.studentAudience(tx, e.studentId)));
      await this.notifications.notify(tx, actor.tenantId, recipients, {
        kind: 'timetable', title: `Emploi du temps · ${slot.classSubject.class.name}`, body, data: { slotId, changeId: change.id }, smsMode: 'none',
      });
      await this.audit.log(tx, actor, 'timetable.change', 'TimetableChange', change.id, input);
      return change;
    });
  }

  removeChange(actor: Actor, id: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      await tx.timetableChange.delete({ where: { id } });
      await this.audit.log(tx, actor, 'timetable.change_removed', 'TimetableChange', id);
      return { ok: true };
    });
  }
}
