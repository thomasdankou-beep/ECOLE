import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ReportRunStatus } from '@prisma/client';
import { Actor } from '../../common/auth';
import { AuditService } from '../../common/audit.service';
import { PrismaService, Tx } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { verifyCode } from '../../common/util';
import { distinction } from '../evaluation/grading';
import { EvaluationService } from '../evaluation/evaluation.service';
import { FinanceService } from '../finance/finance.service';
import { NotificationsService } from '../notifications/notifications.service';
import { tenantSettings } from '../settings/settings.service';

/** Circuit de validation (CDC §3.3) : saisie → contrôle du professeur principal → conseil → validation → publication. */
export const STEPS: ReportRunStatus[] = ['SAISIE', 'CONTROLE', 'CONSEIL', 'VALIDE', 'PUBLIE'];
export const STEP_LABEL: Record<ReportRunStatus, string> = {
  SAISIE: 'Saisie des enseignants',
  CONTROLE: 'Contrôle du professeur principal',
  CONSEIL: 'Conseil de classe',
  VALIDE: 'Validé par la direction',
  PUBLIE: 'Publié aux familles',
};

export interface CouncilEntry {
  studentId: string;
  appreciation?: string;
  councilDecision?: string;
}

@Injectable()
export class ReportCardsService {
  constructor(
    private db: PrismaService,
    private scope: ScopeService,
    private audit: AuditService,
    private evaluation: EvaluationService,
    private notifications: NotificationsService,
    private finance: FinanceService,
  ) {}

  /** État des bulletins de chaque classe visible pour une période. */
  runs(actor: Actor, termId: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const yearId = await this.scope.currentYearId(tx);
      const visible = await this.scope.classIds(tx, actor);
      const classes = await tx.class.findMany({
        where: { academicYearId: yearId, ...(visible ? { id: { in: visible } } : {}), ...(actor.role === 'ENSEIGNANT' ? { headTeacherId: actor.userId } : {}) },
        include: { site: { select: { name: true } }, reportRuns: { where: { termId } }, _count: { select: { enrollments: { where: { status: 'ACTIVE' } } } } },
        orderBy: { name: 'asc' },
      });
      return classes.map((c) => ({ classId: c.id, className: c.name, site: c.site.name, students: c._count.enrollments, status: c.reportRuns[0]?.status ?? 'SAISIE' }));
    });
  }

  private async canControl(tx: Tx, actor: Actor, classId: string) {
    if (actor.role === 'DIRECTION') return true;
    const c = await tx.class.findUniqueOrThrow({ where: { id: classId } });
    return actor.role === 'ENSEIGNANT' && c.headTeacherId === actor.userId;
  }

  /** Préparation du conseil : tableau de la classe recalculé, absences, sanctions, décisions saisies. */
  preview(actor: Actor, classId: string, termId: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      if (!(await this.canControl(tx, actor, classId))) throw new ForbiddenException('Réservé à la direction et au professeur principal');
      const [run, klass, term, tenant] = await Promise.all([
        tx.reportCardRun.findUnique({ where: { classId_termId: { classId, termId } } }),
        tx.class.findUniqueOrThrow({ where: { id: classId }, include: { site: true, headTeacher: { select: { firstName: true, lastName: true } } } }),
        tx.term.findUniqueOrThrow({ where: { id: termId } }),
        tx.tenant.findUniqueOrThrow({ where: { id: actor.tenantId } }),
      ]);
      const result = await this.evaluation.computeClassTerm(tx, actor.tenantId, classId, termId);
      const thresholds = tenantSettings(tenant.settings).grading.distinctions;
      const ids = result.students.map((s) => s.id);
      const [absences, sanctions, cards, prevTerm] = await Promise.all([
        tx.attendanceRecord.groupBy({ by: ['studentId'], where: { studentId: { in: ids }, status: 'ABSENT', session: { classId, date: { gte: term.startDate, lte: term.endDate } } }, _count: true }),
        tx.sanction.groupBy({ by: ['studentId'], where: { studentId: { in: ids }, status: 'VALIDATED', date: { gte: term.startDate, lte: term.endDate } }, _count: true }),
        tx.reportCard.findMany({ where: { termId, classId } }),
        tx.term.findFirst({ where: { academicYearId: term.academicYearId, position: term.position - 1 } }),
      ]);
      const previous = prevTerm ? await tx.reportCard.findMany({ where: { termId: prevTerm.id, classId }, select: { studentId: true, average: true } }) : [];
      const council = ((run?.history as any[]) ?? []).filter((h) => h.council).pop()?.council as Record<string, CouncilEntry> | undefined;
      return {
        class: { id: klass.id, name: klass.name, site: klass.site.name, headTeacher: klass.headTeacher },
        term: { id: term.id, name: term.name },
        status: run?.status ?? 'SAISIE', steps: STEPS.map((s) => ({ code: s, label: STEP_LABEL[s] })), history: run?.history ?? [],
        subjects: result.subjects.map((s) => ({ classSubjectId: s.classSubjectId, name: s.name, coefficient: s.coefficient, teacher: s.teacher, stats: s.stats })),
        classStats: result.classStats,
        students: result.students.map((s) => {
          const card = cards.find((c) => c.studentId === s.id);
          const prev = previous.find((p) => p.studentId === s.id)?.average;
          return {
            id: s.id, name: `${s.firstName} ${s.lastName}`, matricule: s.matricule, average: s.average, rank: s.rank,
            subjects: Object.fromEntries(result.subjects.map((x) => [x.classSubjectId, s.subjects.get(x.classSubjectId) ?? null])),
            distinction: distinction(s.average, thresholds),
            evolution: prev !== undefined && prev !== null && s.average !== null ? Math.round((s.average - Number(prev)) * 100) / 100 : null,
            absences: absences.find((a) => a.studentId === s.id)?._count ?? 0,
            sanctions: sanctions.find((a) => a.studentId === s.id)?._count ?? 0,
            appreciation: card?.appreciation ?? council?.[s.id]?.appreciation ?? '',
            councilDecision: card?.councilDecision ?? council?.[s.id]?.councilDecision ?? '',
            reportCardId: card?.id ?? null,
          };
        }),
      };
    });
  }

  /** Décisions et appréciations générales saisies en conseil de classe. */
  saveCouncil(actor: Actor, classId: string, termId: string, entries: CouncilEntry[]) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      if (!(await this.canControl(tx, actor, classId))) throw new ForbiddenException();
      const run = await tx.reportCardRun.findUnique({ where: { classId_termId: { classId, termId } } });
      if (run?.status !== 'CONSEIL') throw new ConflictException('Les décisions se saisissent pendant l’étape « Conseil de classe »');
      const council = Object.fromEntries(entries.map((e) => [e.studentId, e]));
      const history = [...((run.history as any[]) ?? []), { at: new Date().toISOString(), by: actor.name, action: 'Décisions du conseil enregistrées', council }];
      await tx.reportCardRun.update({ where: { id: run.id }, data: { history } });
      await this.audit.log(tx, actor, 'reportcards.council_saved', 'ReportCardRun', run.id, { count: entries.length });
      return { ok: true };
    });
  }

  /** Passe à l'étape suivante ; la validation fige les bulletins et verrouille les notes. */
  advance(actor: Actor, classId: string, termId: string) {
    return this.db.forTenant(
      actor.tenantId,
      async (tx) => {
        const run = await tx.reportCardRun.upsert({
          where: { classId_termId: { classId, termId } },
          create: { tenantId: actor.tenantId, classId, termId },
          update: {},
        });
        const i = STEPS.indexOf(run.status);
        if (i === STEPS.length - 1) throw new ConflictException('Les bulletins sont déjà publiés');
        const next = STEPS[i + 1];
        const directionOnly = next === 'VALIDE' || next === 'PUBLIE';
        if (directionOnly ? actor.role !== 'DIRECTION' : !(await this.canControl(tx, actor, classId))) {
          throw new ForbiddenException(directionOnly ? 'La validation et la publication reviennent à la direction' : 'Réservé au professeur principal et à la direction');
        }
        if (next === 'VALIDE') await this.generate(tx, actor, classId, termId, run.history as any[]);
        if (next === 'PUBLIE') await this.publish(tx, actor, classId, termId);
        const history = [...((run.history as any[]) ?? []), { at: new Date().toISOString(), by: actor.name, action: STEP_LABEL[next] }];
        const updated = await tx.reportCardRun.update({ where: { id: run.id }, data: { status: next, history } });
        await this.audit.log(tx, actor, `reportcards.${next.toLowerCase()}`, 'ReportCardRun', run.id, { classId, termId });
        return { status: updated.status };
      },
      { timeout: 120000 },
    );
  }

  /** Retour en saisie (correction demandée), impossible après publication. */
  reopen(actor: Actor, classId: string, termId: string, reason: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      if (actor.role !== 'DIRECTION') throw new ForbiddenException();
      const run = await tx.reportCardRun.findUniqueOrThrow({ where: { classId_termId: { classId, termId } } });
      if (run.status === 'PUBLIE') throw new ConflictException('Bulletins déjà publiés : ils ne peuvent plus être rouverts');
      await tx.reportCard.deleteMany({ where: { classId, termId, publishedAt: null } });
      const history = [...((run.history as any[]) ?? []), { at: new Date().toISOString(), by: actor.name, action: `Retour en saisie : ${reason}` }];
      await tx.reportCardRun.update({ where: { id: run.id }, data: { status: 'SAISIE', history } });
      await this.audit.log(tx, actor, 'reportcards.reopened', 'ReportCardRun', run.id, { reason });
      return { status: 'SAISIE' };
    });
  }

  /** Génération des bulletins (instantané des moyennes, rangs, appréciations et décisions). */
  private async generate(tx: Tx, actor: Actor, classId: string, termId: string, history: any[]) {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: actor.tenantId } });
    const thresholds = tenantSettings(tenant.settings).grading.distinctions;
    const term = await tx.term.findUniqueOrThrow({ where: { id: termId } });
    const result = await this.evaluation.computeClassTerm(tx, actor.tenantId, classId, termId);
    const council = (history ?? []).filter((h) => h.council).pop()?.council as Record<string, CouncilEntry> | undefined;
    const appreciations = await tx.appreciation.findMany({ where: { termId, classSubjectId: { in: result.subjects.map((x) => x.classSubjectId) } } });
    await tx.reportCard.deleteMany({ where: { classId, termId, publishedAt: null } });
    for (const s of result.students) {
      const absences = await tx.attendanceRecord.count({ where: { studentId: s.id, status: 'ABSENT', session: { classId, date: { gte: term.startDate, lte: term.endDate } } } });
      await tx.reportCard.create({
        data: {
          tenantId: actor.tenantId, studentId: s.id, classId, termId, average: s.average, rank: s.rank, classSize: result.students.length,
          distinction: distinction(s.average, thresholds), appreciation: council?.[s.id]?.appreciation, councilDecision: council?.[s.id]?.councilDecision,
          absencesCount: absences, verifyCode: verifyCode(),
          items: {
            create: result.subjects.map((x) => ({
              tenantId: actor.tenantId, subjectName: x.name, coefficient: x.coefficient, average: s.subjects.get(x.classSubjectId) ?? null,
              classAverage: x.stats.mean, minAverage: x.stats.min, maxAverage: x.stats.max, rank: x.ranks.get(s.id) ?? null, teacherName: x.teacher,
              appreciation: appreciations.find((a) => a.classSubjectId === x.classSubjectId && a.studentId === s.id)?.text,
            })),
          },
        },
      });
    }
  }

  /** Publication : visible des familles, notifications étalées par la file (CDC §3.3). */
  private async publish(tx: Tx, actor: Actor, classId: string, termId: string) {
    const cards = await tx.reportCard.findMany({ where: { classId, termId }, include: { student: true } });
    if (!cards.length) throw new BadRequestException('Aucun bulletin généré');
    const term = await tx.term.findUniqueOrThrow({ where: { id: termId } });
    const now = new Date();
    for (const c of cards) {
      await tx.reportCard.update({ where: { id: c.id }, data: { publishedAt: now } });
      await tx.verificationEntry.create({
        data: {
          code: c.verifyCode, tenantId: actor.tenantId, kind: 'Bulletin de notes', issuedAt: now,
          summary: `Bulletin ${term.name} · ${c.student.firstName} ${c.student.lastName.charAt(0)}. · moyenne ${c.average === null ? '—' : Number(c.average).toLocaleString('fr-FR')}`,
        },
      });
      await this.notifications.notify(tx, actor.tenantId, await this.notifications.studentAudience(tx, c.studentId), {
        kind: 'report_card', title: `Bulletin du ${term.name.toLowerCase()}`,
        body: `Le bulletin de ${c.student.firstName} pour le ${term.name.toLowerCase()} est disponible.`,
        sms: `Le bulletin de ${c.student.firstName} (${term.name}) est disponible dans l'application.`,
        data: { reportCardId: c.id }, smsMode: 'fallback',
      });
    }
  }

  /** Bulletins publiés d'un élève. */
  forStudent(actor: Actor, studentId: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      await this.scope.assertStudent(tx, actor, studentId);
      const family = ['PARENT', 'ELEVE'].includes(actor.role);
      const cards = await tx.reportCard.findMany({
        where: { studentId, ...(family ? { publishedAt: { not: null } } : {}) },
        include: { class: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
      });
      const terms = await tx.term.findMany({ where: { id: { in: cards.map((c) => c.termId) } } });
      const blocked = family ? await this.blockedForUnpaid(tx, actor.tenantId, studentId) : false;
      return { blocked, cards: cards.map((c) => ({ id: c.id, term: terms.find((t) => t.id === c.termId)?.name, className: c.class.name, average: c.average, rank: c.rank, classSize: c.classSize, distinction: c.distinction, publishedAt: c.publishedAt })) };
    });
  }

  private async blockedForUnpaid(tx: Tx, tenantId: string, studentId: string) {
    const t = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    if (!tenantSettings(t.settings).blockReportCardIfUnpaid) return false;
    return ((await this.finance.balances(tx, [studentId])).get(studentId) ?? 0) > 0;
  }

  /** Bulletin complet pour l'affichage et l'impression. */
  get(actor: Actor, id: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const c = await tx.reportCard.findUnique({
        where: { id },
        include: { items: true, student: true, class: { include: { site: true, level: true, track: true, headTeacher: { select: { firstName: true, lastName: true } } } } },
      });
      if (!c) throw new NotFoundException('Bulletin introuvable');
      await this.scope.assertStudent(tx, actor, c.studentId);
      if (['PARENT', 'ELEVE'].includes(actor.role)) {
        if (!c.publishedAt) throw new NotFoundException('Bulletin pas encore publié');
        if (await this.blockedForUnpaid(tx, actor.tenantId, c.studentId)) throw new ForbiddenException("L'accès au bulletin en ligne est suspendu jusqu'au règlement des frais. Rapprochez-vous de l'économat.");
      }
      const [term, tenant] = await Promise.all([
        tx.term.findUniqueOrThrow({ where: { id: c.termId }, include: { academicYear: true } }),
        tx.tenant.findUniqueOrThrow({ where: { id: actor.tenantId }, select: { name: true } }),
      ]);
      return { ...c, term: { name: term.name, year: term.academicYear.label }, tenant };
    });
  }
}
