import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Actor } from './auth';
import { Tx } from './prisma.service';

/**
 * Périmètre des données (le « P » de la matrice RBAC) :
 * un enseignant ne voit que ses classes, un parent que ses enfants, un élève que lui-même,
 * un personnel limité à un site que les classes de ce site.
 */
@Injectable()
export class ScopeService {
  async currentYearId(tx: Tx): Promise<string> {
    const y = await tx.academicYear.findFirst({ where: { isCurrent: true } });
    if (!y) throw new NotFoundException("Aucune année scolaire courante n'est définie");
    return y.id;
  }

  /** Identifiants des classes visibles par l'acteur pour l'année courante ; null = toutes. */
  async classIds(tx: Tx, actor: Actor): Promise<string[] | null> {
    const yearId = await this.currentYearId(tx);
    switch (actor.role) {
      case 'ENSEIGNANT': {
        const rows = await tx.teacherAssignment.findMany({
          where: { teacherId: actor.userId, classSubject: { class: { academicYearId: yearId } } },
          select: { classSubject: { select: { classId: true } } },
        });
        const head = await tx.class.findMany({ where: { headTeacherId: actor.userId, academicYearId: yearId }, select: { id: true } });
        return [...new Set([...rows.map((r) => r.classSubject.classId), ...head.map((c) => c.id)])];
      }
      case 'PARENT':
      case 'ELEVE': {
        const ids = await this.studentIds(tx, actor);
        const enr = await tx.enrollment.findMany({ where: { studentId: { in: ids ?? [] }, academicYearId: yearId }, select: { classId: true } });
        return [...new Set(enr.map((e) => e.classId))];
      }
      default: {
        if (!actor.siteIds.length) return null;
        const cls = await tx.class.findMany({ where: { siteId: { in: actor.siteIds }, academicYearId: yearId }, select: { id: true } });
        return cls.map((c) => c.id);
      }
    }
  }

  /** Identifiants des élèves visibles ; null = tous ceux de l'établissement. */
  async studentIds(tx: Tx, actor: Actor): Promise<string[] | null> {
    if (actor.role === 'PARENT') {
      const links = await tx.studentGuardian.findMany({ where: { guardian: { userId: actor.userId } }, select: { studentId: true } });
      return links.map((l) => l.studentId);
    }
    if (actor.role === 'ELEVE') {
      const s = await tx.student.findFirst({ where: { userId: actor.userId }, select: { id: true } });
      return s ? [s.id] : [];
    }
    const classIds = await this.classIds(tx, actor);
    if (classIds === null) return null;
    const enr = await tx.enrollment.findMany({ where: { classId: { in: classIds }, status: 'ACTIVE' }, select: { studentId: true } });
    return enr.map((e) => e.studentId);
  }

  async assertStudent(tx: Tx, actor: Actor, studentId: string) {
    const ids = await this.studentIds(tx, actor);
    if (ids !== null && !ids.includes(studentId)) throw new ForbiddenException('Élève hors de votre périmètre');
  }

  async assertClass(tx: Tx, actor: Actor, classId: string) {
    const ids = await this.classIds(tx, actor);
    if (ids !== null && !ids.includes(classId)) throw new ForbiddenException('Classe hors de votre périmètre');
  }

  /** Un enseignant ne peut agir que sur les matières qui lui sont affectées. */
  async assertTeaches(tx: Tx, actor: Actor, classSubjectId: string) {
    if (actor.role !== 'ENSEIGNANT') return;
    const a = await tx.teacherAssignment.findFirst({ where: { teacherId: actor.userId, classSubjectId } });
    if (!a) throw new ForbiddenException("Cette matière ne vous est pas affectée dans cette classe");
  }
}
