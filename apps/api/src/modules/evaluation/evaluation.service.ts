import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AssessmentKind } from '@prisma/client';
import { Actor } from '../../common/auth';
import { AuditService } from '../../common/audit.service';
import { PrismaService, Tx } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { toDate } from '../../common/util';
import { NotificationsService } from '../notifications/notifications.service';
import { tenantSettings } from '../settings/settings.service';
import { annualAverage, generalAverage, MissingRule, ranks, stats, subjectAverage } from './grading';

export interface AssessmentInput {
  classSubjectId: string;
  termId: string;
  title: string;
  kind: AssessmentKind;
  weight: number;
  maxScore?: number;
  date: string;
}

export interface GradeEntry {
  studentId: string;
  score: number | null;
  absent?: boolean;
  exempt?: boolean;
  comment?: string;
}

const LOCKED = ['VALIDE', 'PUBLIE'];

/** Résultat consolidé d'une classe sur une période : base des carnets, bulletins et conseils. */
export interface ClassTermResult {
  subjects: { classSubjectId: string; name: string; coefficient: number; teacher: string | null; stats: ReturnType<typeof stats>; ranks: Map<string, number> }[];
  students: { id: string; firstName: string; lastName: string; matricule: string; subjects: Map<string, number | null>; average: number | null; rank: number | null }[];
  classStats: ReturnType<typeof stats>;
}

@Injectable()
export class EvaluationService {
  constructor(
    private db: PrismaService,
    private scope: ScopeService,
    private audit: AuditService,
    private notifications: NotificationsService,
  ) {}

  async missingRule(tx: Tx, tenantId: string): Promise<MissingRule> {
    const t = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    return tenantSettings(t.settings).grading.missingGrade as MissingRule;
  }

  /** Calcule toutes les moyennes d'une classe pour une période (seulement les notes publiées si demandé). */
  async computeClassTerm(tx: Tx, tenantId: string, classId: string, termId: string, publishedOnly = false): Promise<ClassTermResult> {
    const rule = await this.missingRule(tx, tenantId);
    const [enr, classSubjects] = await Promise.all([
      tx.enrollment.findMany({ where: { classId, status: 'ACTIVE' }, select: { student: { select: { id: true, firstName: true, lastName: true, matricule: true } } }, orderBy: [{ student: { lastName: 'asc' } }, { student: { firstName: 'asc' } }] }),
      tx.classSubject.findMany({
        where: { classId },
        include: {
          subject: true,
          assignments: { include: { teacher: { select: { firstName: true, lastName: true } } } },
          assessments: { where: { termId, ...(publishedOnly ? { published: true } : {}) }, include: { grades: true } },
        },
        orderBy: { subject: { name: 'asc' } },
      }),
    ]);
    const students = enr.map(({ student }) => ({ ...student, subjects: new Map<string, number | null>(), average: null as number | null, rank: null as number | null }));
    const subjects: ClassTermResult['subjects'] = [];
    for (const cs of classSubjects) {
      const coefficient = Number(cs.coefficient);
      for (const s of students) {
        const grades = cs.assessments.map((a) => {
          const g = a.grades.find((x) => x.studentId === s.id);
          return { score: g?.score === null || g?.score === undefined ? null : Number(g.score), maxScore: Number(a.maxScore), weight: Number(a.weight), absent: g?.absent, exempt: g?.exempt };
        });
        s.subjects.set(cs.id, cs.assessments.length ? subjectAverage(grades, rule) : null);
      }
      const values = students.map((s) => s.subjects.get(cs.id) ?? null);
      const t = cs.assignments[0]?.teacher;
      subjects.push({
        classSubjectId: cs.id, name: cs.subject.name, coefficient, teacher: t ? `${t.firstName} ${t.lastName}` : null,
        stats: stats(values), ranks: ranks(students.map((s) => ({ id: s.id, average: s.subjects.get(cs.id) ?? null }))),
      });
    }
    for (const s of students) s.average = generalAverage(subjects.map((x) => ({ average: s.subjects.get(x.classSubjectId) ?? null, coefficient: x.coefficient })));
    const r = ranks(students);
    for (const s of students) s.rank = r.get(s.id) ?? null;
    return { subjects, students, classStats: stats(students.map((s) => s.average)) };
  }

  /** Moyennes de chaque période et moyenne annuelle (pondérée par le poids des périodes), avec le rang annuel. */
  async computeClassYear(tx: Tx, tenantId: string, classId: string, publishedOnly = false) {
    const klass = await tx.class.findUniqueOrThrow({ where: { id: classId } });
    const terms = await tx.term.findMany({ where: { academicYearId: klass.academicYearId }, orderBy: { position: 'asc' } });
    const results: ClassTermResult[] = [];
    for (const t of terms) results.push(await this.computeClassTerm(tx, tenantId, classId, t.id, publishedOnly));
    const students = (results[0]?.students ?? []).map((s) => {
      const byTerm = Object.fromEntries(terms.map((t, i) => [t.id, results[i].students.find((x) => x.id === s.id)?.average ?? null]));
      return { id: s.id, firstName: s.firstName, lastName: s.lastName, matricule: s.matricule, terms: byTerm, average: annualAverage(terms.map((t) => ({ average: byTerm[t.id], weight: Number(t.weight) }))), rank: null as number | null };
    });
    const r = ranks(students);
    for (const s of students) s.rank = r.get(s.id) ?? null;
    return { terms: terms.map((t) => ({ id: t.id, name: t.name, weight: Number(t.weight), classAverage: results[terms.indexOf(t)].classStats.mean })), students, classStats: stats(students.map((s) => s.average)), academicYearId: klass.academicYearId };
  }

  private async runStatus(tx: Tx, classId: string, termId: string) {
    return (await tx.reportCardRun.findUnique({ where: { classId_termId: { classId, termId } } }))?.status ?? 'SAISIE';
  }

  /** Matières de l'enseignant (ou toutes, pour la direction) avec les périodes de l'année. */
  myClassSubjects(actor: Actor) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const yearId = await this.scope.currentYearId(tx);
      const visible = await this.scope.classIds(tx, actor);
      const rows = await tx.classSubject.findMany({
        where: {
          class: { academicYearId: yearId, ...(visible ? { id: { in: visible } } : {}) },
          ...(actor.role === 'ENSEIGNANT' ? { assignments: { some: { teacherId: actor.userId } } } : {}),
        },
        include: { subject: true, class: { select: { id: true, name: true, site: { select: { name: true } } } } },
        orderBy: [{ class: { name: 'asc' } }, { subject: { name: 'asc' } }],
      });
      const terms = await tx.term.findMany({ where: { academicYearId: yearId }, orderBy: { position: 'asc' } });
      return { classSubjects: rows.map((r) => ({ id: r.id, coefficient: Number(r.coefficient), subject: r.subject, class: r.class })), terms };
    });
  }

  /** Carnet de notes d'une matière : évaluations, notes, moyennes recalculées, statistiques. */
  gradebook(actor: Actor, classSubjectId: string, termId: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const cs = await tx.classSubject.findUnique({ where: { id: classSubjectId }, include: { subject: true, class: true } });
      if (!cs) throw new NotFoundException();
      await this.scope.assertClass(tx, actor, cs.classId);
      await this.scope.assertTeaches(tx, actor, classSubjectId);
      const rule = await this.missingRule(tx, actor.tenantId);
      const [assessments, enr, appreciations, status] = await Promise.all([
        tx.assessment.findMany({ where: { classSubjectId, termId }, include: { grades: true }, orderBy: [{ date: 'asc' }, { createdAt: 'asc' }] }),
        tx.enrollment.findMany({ where: { classId: cs.classId, status: 'ACTIVE' }, select: { student: { select: { id: true, firstName: true, lastName: true, matricule: true } } }, orderBy: [{ student: { lastName: 'asc' } }, { student: { firstName: 'asc' } }] }),
        tx.appreciation.findMany({ where: { classSubjectId, termId } }),
        this.runStatus(tx, cs.classId, termId),
      ]);
      const students = enr.map(({ student }) => {
        const grades = Object.fromEntries(assessments.map((a) => {
          const g = a.grades.find((x) => x.studentId === student.id);
          return [a.id, g ? { score: g.score === null ? null : Number(g.score), absent: g.absent, exempt: g.exempt, comment: g.comment } : null];
        }));
        const average = subjectAverage(assessments.map((a) => ({ score: grades[a.id]?.score ?? null, maxScore: Number(a.maxScore), weight: Number(a.weight), absent: grades[a.id]?.absent, exempt: grades[a.id]?.exempt })), rule);
        return { ...student, grades, average, appreciation: appreciations.find((x) => x.studentId === student.id)?.text ?? '' };
      });
      return {
        classSubject: { id: cs.id, subject: cs.subject.name, className: cs.class.name, coefficient: Number(cs.coefficient) },
        locked: LOCKED.includes(status), runStatus: status,
        assessments: assessments.map((a) => ({
          id: a.id, title: a.title, kind: a.kind, weight: Number(a.weight), maxScore: Number(a.maxScore), date: a.date, published: a.published,
          stats: stats(a.grades.map((g) => (g.score === null ? null : (Number(g.score) * 20) / Number(a.maxScore)))),
        })),
        students,
        stats: stats(students.map((s) => s.average)),
      };
    });
  }

  private async assertEditable(tx: Tx, actor: Actor, classSubjectId: string, termId: string) {
    const cs = await tx.classSubject.findUniqueOrThrow({ where: { id: classSubjectId } });
    await this.scope.assertTeaches(tx, actor, classSubjectId);
    if (actor.role !== 'ENSEIGNANT') throw new ForbiddenException('Seul l’enseignant de la matière saisit les notes');
    if (LOCKED.includes(await this.runStatus(tx, cs.classId, termId))) throw new ConflictException('Les notes de cette période sont verrouillées : les bulletins ont été validés');
    return cs;
  }

  createAssessment(actor: Actor, input: AssessmentInput) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      await this.assertEditable(tx, actor, input.classSubjectId, input.termId);
      const term = await tx.term.findUniqueOrThrow({ where: { id: input.termId } });
      const date = toDate(input.date);
      if (date < term.startDate || date > term.endDate) throw new BadRequestException(`La date doit être comprise dans la période (${term.name})`);
      const a = await tx.assessment.create({
        data: { tenantId: actor.tenantId, classSubjectId: input.classSubjectId, termId: input.termId, title: input.title, kind: input.kind, weight: input.weight, maxScore: input.maxScore ?? 20, date, createdById: actor.userId },
      });
      // Alerte de charge : plus de 3 évaluations le même jour dans la classe (CDC §4.2).
      const cs = await tx.classSubject.findUniqueOrThrow({ where: { id: input.classSubjectId } });
      const sameDay = await tx.assessment.count({ where: { date, classSubject: { classId: cs.classId } } });
      await this.audit.log(tx, actor, 'assessment.created', 'Assessment', a.id, input);
      return { ...a, warning: sameDay > 3 ? `La classe a déjà ${sameDay - 1} évaluations ce jour-là` : null };
    });
  }

  updateAssessment(actor: Actor, id: string, input: Partial<AssessmentInput>) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const a = await tx.assessment.findUniqueOrThrow({ where: { id } });
      await this.assertEditable(tx, actor, a.classSubjectId, a.termId);
      const u = await tx.assessment.update({ where: { id }, data: { title: input.title, kind: input.kind, weight: input.weight, maxScore: input.maxScore, date: input.date ? toDate(input.date) : undefined } });
      await this.audit.log(tx, actor, 'assessment.updated', 'Assessment', id, input);
      return u;
    });
  }

  /** Saisie des notes : chaque modification d'une note existante est tracée (qui, quand, avant, après). */
  saveGrades(actor: Actor, assessmentId: string, entries: GradeEntry[]) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const a = await tx.assessment.findUniqueOrThrow({ where: { id: assessmentId }, include: { grades: true } });
      const cs = await this.assertEditable(tx, actor, a.classSubjectId, a.termId);
      const enrolled = new Set((await tx.enrollment.findMany({ where: { classId: cs.classId, status: 'ACTIVE' }, select: { studentId: true } })).map((e) => e.studentId));
      const max = Number(a.maxScore);
      const changes: { studentId: string; before: number | null; after: number | null }[] = [];
      for (const e of entries) {
        if (!enrolled.has(e.studentId)) throw new BadRequestException("Un élève n'appartient pas à cette classe");
        if (e.score !== null && (e.score < 0 || e.score > max || Number.isNaN(e.score))) throw new BadRequestException(`Les notes vont de 0 à ${max}`);
        const prev = a.grades.find((g) => g.studentId === e.studentId);
        const score = e.score === null ? null : Math.round(e.score * 100) / 100;
        await tx.grade.upsert({
          where: { assessmentId_studentId: { assessmentId, studentId: e.studentId } },
          create: { tenantId: actor.tenantId, assessmentId, studentId: e.studentId, score, absent: !!e.absent, exempt: !!e.exempt, comment: e.comment, updatedById: actor.userId },
          update: { score, absent: !!e.absent, exempt: !!e.exempt, comment: e.comment, updatedById: actor.userId },
        });
        const before = prev?.score === null || prev?.score === undefined ? null : Number(prev.score);
        if (prev && before !== score) changes.push({ studentId: e.studentId, before, after: score });
      }
      await this.audit.log(tx, actor, 'grades.saved', 'Assessment', assessmentId, { count: entries.length, modified: changes });
      return { saved: entries.length };
    });
  }

  /** Publication : les notes deviennent visibles des familles, qui sont notifiées (CDC §2.2). */
  publish(actor: Actor, assessmentId: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const a = await tx.assessment.findUniqueOrThrow({ where: { id: assessmentId }, include: { grades: true, classSubject: { include: { subject: true } } } });
      await this.scope.assertTeaches(tx, actor, a.classSubjectId);
      if (a.published) return { ok: true, notified: 0 };
      await tx.assessment.update({ where: { id: assessmentId }, data: { published: true } });
      let notified = 0;
      for (const g of a.grades) {
        if (g.score === null) continue;
        const st = await tx.student.findUniqueOrThrow({ where: { id: g.studentId }, select: { firstName: true } });
        notified += await this.notifications.notify(tx, actor.tenantId, await this.notifications.studentAudience(tx, g.studentId), {
          kind: 'grade', title: `Nouvelle note · ${a.classSubject.subject.name}`,
          body: `${st.firstName} a obtenu ${Number(g.score).toLocaleString('fr-FR')}/${Number(a.maxScore)} à « ${a.title} » en ${a.classSubject.subject.name}.`,
          data: { assessmentId, studentId: g.studentId }, smsMode: 'none',
        });
      }
      await this.audit.log(tx, actor, 'assessment.published', 'Assessment', assessmentId);
      return { ok: true, notified };
    });
  }

  saveAppreciation(actor: Actor, dto: { studentId: string; classSubjectId: string; termId: string; text: string }) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      await this.assertEditable(tx, actor, dto.classSubjectId, dto.termId);
      return tx.appreciation.upsert({
        where: { studentId_classSubjectId_termId: { studentId: dto.studentId, classSubjectId: dto.classSubjectId, termId: dto.termId } },
        create: { tenantId: actor.tenantId, ...dto, authorId: actor.userId },
        update: { text: dto.text, authorId: actor.userId },
      });
    });
  }

  /** Notes d'un élève pour une période (familles : notes publiées seulement). */
  studentGrades(actor: Actor, studentId: string, termId?: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      await this.scope.assertStudent(tx, actor, studentId);
      const yearId = await this.scope.currentYearId(tx);
      const terms = await tx.term.findMany({ where: { academicYearId: yearId }, orderBy: { position: 'asc' } });
      const today = new Date();
      const term = terms.find((t) => t.id === termId) ?? terms.find((t) => t.startDate <= today && t.endDate >= today) ?? terms[0];
      const enr = await tx.enrollment.findUnique({ where: { studentId_academicYearId: { studentId, academicYearId: yearId } } });
      if (!enr || !term) return { terms, term: term ?? null, subjects: [], average: null };
      const publishedOnly = ['PARENT', 'ELEVE'].includes(actor.role);
      const rule = await this.missingRule(tx, actor.tenantId);
      const css = await tx.classSubject.findMany({
        where: { classId: enr.classId },
        include: { subject: true, assessments: { where: { termId: term.id, ...(publishedOnly ? { published: true } : {}) }, include: { grades: { where: { studentId } } }, orderBy: { date: 'asc' } } },
        orderBy: { subject: { name: 'asc' } },
      });
      const result = await this.computeClassTerm(tx, actor.tenantId, enr.classId, term.id, publishedOnly);
      const subjects = css.map((cs) => {
        const assessments = cs.assessments.map((a) => ({ id: a.id, title: a.title, kind: a.kind, date: a.date, weight: Number(a.weight), maxScore: Number(a.maxScore), score: a.grades[0]?.score === null || a.grades[0]?.score === undefined ? null : Number(a.grades[0].score), absent: a.grades[0]?.absent ?? false }));
        const average = subjectAverage(assessments.map((a) => ({ score: a.score, maxScore: a.maxScore, weight: a.weight, absent: a.absent })), rule);
        const st = result.subjects.find((s) => s.classSubjectId === cs.id)?.stats;
        return { classSubjectId: cs.id, subject: cs.subject.name, coefficient: Number(cs.coefficient), assessments, average, classAverage: st?.mean ?? null };
      });
      return { terms, term, subjects, average: generalAverage(subjects.map((s) => ({ average: s.average, coefficient: s.coefficient }))), classAverage: result.classStats.mean };
    });
  }
}
