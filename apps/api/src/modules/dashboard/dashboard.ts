import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Actor, Can, CurrentActor } from '../../common/auth';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { isoDay, toDate } from '../../common/util';
import { EvaluationService } from '../evaluation/evaluation.service';

/** Tableau de bord de la direction (CDC §2.1) et journal d'audit. */
@Injectable()
export class DashboardService {
  constructor(private db: PrismaService, private scope: ScopeService, private evaluation: EvaluationService) {}

  direction(actor: Actor, siteId?: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const yearId = await this.scope.currentYearId(tx);
      const today = toDate(isoDay(new Date()));
      const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
      const classWhere = { academicYearId: yearId, ...(siteId ? { siteId } : {}) };
      const classes = await tx.class.findMany({
        where: classWhere,
        include: { level: true, track: true, site: true, _count: { select: { enrollments: { where: { status: 'ACTIVE' } } } } },
        orderBy: { name: 'asc' },
      });
      const classIds = classes.map((c) => c.id);
      const byTrack = new Map<string, number>();
      const bySite = new Map<string, number>();
      for (const c of classes) {
        const k = c.track?.name ?? c.level.name;
        byTrack.set(k, (byTrack.get(k) ?? 0) + c._count.enrollments);
        bySite.set(c.site.name, (bySite.get(c.site.name) ?? 0) + c._count.enrollments);
      }
      const studentsWhere = { enrollments: { some: { classId: { in: classIds }, status: 'ACTIVE' as const } } };
      const [absentToday, recordsToday, unjustified, monthPaid, invAgg, pendingApps, pendingJustifs] = await Promise.all([
        tx.attendanceRecord.count({ where: { status: 'ABSENT', session: { date: today, classId: { in: classIds } } } }),
        tx.attendanceRecord.count({ where: { session: { date: today, classId: { in: classIds } } } }),
        tx.attendanceRecord.groupBy({ by: ['sessionId'], where: { status: 'ABSENT', justification: { in: ['NONE', 'REJECTED'] }, session: { classId: { in: classIds }, date: { gte: new Date(today.getTime() - 7 * 86400000) } } }, _count: true }),
        tx.payment.aggregate({ where: { status: 'SUCCESS', confirmedAt: { gte: monthStart }, student: studentsWhere }, _sum: { amount: true } }),
        tx.invoice.aggregate({ where: { status: { not: 'CANCELLED' }, student: studentsWhere }, _sum: { total: true, paid: true } }),
        tx.application.count({ where: { status: { in: ['RECU', 'INCOMPLET', 'EN_TEST'] } } }),
        tx.attendanceRecord.count({ where: { justification: 'PENDING' } }),
      ]);
      const sessions = await tx.attendanceSession.findMany({ where: { id: { in: unjustified.map((u) => u.sessionId) } }, select: { id: true, classId: true } });
      const unjustifiedByClass = new Map<string, number>();
      for (const u of unjustified) {
        const cid = sessions.find((s) => s.id === u.sessionId)?.classId;
        if (cid) unjustifiedByClass.set(cid, (unjustifiedByClass.get(cid) ?? 0) + u._count);
      }

      // Résultats moyens par classe sur la période en cours (notes publiées).
      const terms = await tx.term.findMany({ where: { academicYearId: yearId }, orderBy: { position: 'asc' } });
      const term = terms.find((t) => t.startDate <= today && t.endDate >= today) ?? terms[0];
      const results: { classId: string; className: string; average: number | null }[] = [];
      if (term) {
        for (const c of classes) {
          const r = await this.evaluation.computeClassTerm(tx, actor.tenantId, c.id, term.id, true);
          results.push({ classId: c.id, className: c.name, average: r.classStats.mean });
        }
      }
      const expected = invAgg._sum.total ?? 0;
      const paid = invAgg._sum.paid ?? 0;
      return {
        date: isoDay(today), term: term ? { id: term.id, name: term.name } : null,
        students: classes.reduce((a, c) => a + c._count.enrollments, 0), classes: classes.length,
        byTrack: [...byTrack].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
        bySite: [...bySite].map(([label, count]) => ({ label, count })),
        attendance: { absentToday, presenceRate: recordsToday ? Math.round(((recordsToday - absentToday) / recordsToday) * 1000) / 10 : null },
        finance: { monthCollected: monthPaid._sum.amount ?? 0, expected, paid, unpaid: expected - paid, unpaidRate: expected ? Math.round(((expected - paid) / expected) * 1000) / 10 : null },
        results,
        alerts: [
          ...[...unjustifiedByClass].filter(([, n]) => n >= 3).map(([cid, n]) => ({ kind: 'assiduite', text: `${classes.find((c) => c.id === cid)?.name} : ${n} absences non justifiées sur 7 jours` })),
          ...(pendingApps ? [{ kind: 'admissions', text: `${pendingApps} pré-inscription(s) à traiter` }] : []),
          ...(pendingJustifs ? [{ kind: 'justificatifs', text: `${pendingJustifs} justificatif(s) d'absence en attente` }] : []),
        ],
      };
    });
  }

  auditLog(actor: Actor, q: { action?: string; from?: string; to?: string; userId?: string }) {
    return this.db.forTenant(actor.tenantId, (tx) =>
      tx.auditLog.findMany({
        where: {
          ...(q.action ? { action: { startsWith: q.action } } : {}),
          ...(q.userId ? { userId: q.userId } : {}),
          ...(q.from || q.to ? { createdAt: { gte: q.from ? toDate(q.from) : undefined, lt: q.to ? new Date(toDate(q.to).getTime() + 86400000) : undefined } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: 300,
      }),
    );
  }
}

@ApiTags('Pilotage')
@ApiBearerAuth()
@Controller()
export class DashboardController {
  constructor(private s: DashboardService) {}

  @Get('dashboard') @Can('settings.manage')
  direction(@CurrentActor() a: Actor, @Query('siteId') siteId?: string) { return this.s.direction(a, siteId); }

  @Get('audit') @Can('audit.read')
  audit(@CurrentActor() a: Actor, @Query('action') action?: string, @Query('from') from?: string, @Query('to') to?: string, @Query('userId') userId?: string) {
    return this.s.auditLog(a, { action, from, to, userId });
  }
}
