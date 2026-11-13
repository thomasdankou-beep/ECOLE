import { EnrollmentEventKind, Prisma } from '@prisma/client';
import { Actor } from '../../common/auth';
import { Tx } from '../../common/prisma.service';

/**
 * Inscriptions (lot G4) : historique en ajout seul, détection des doublons possibles, élèves facturables.
 * Rien ici ne supprime ni ne fusionne un dossier : la base l'interdit de toute façon (migration G4).
 */

type Who = Pick<Actor, 'tenantId' | 'userId' | 'name'>;

/** Ajoute une ligne à l'historique d'une inscription (table en ajout seul). */
export function enrollmentEvent(tx: Tx, actor: Who, enrollmentId: string, kind: EnrollmentEventKind, data?: Record<string, unknown>) {
  return tx.enrollmentEvent.create({
    data: { tenantId: actor.tenantId, enrollmentId, kind, data: data as Prisma.InputJsonValue | undefined, actorId: actor.userId, actorName: actor.name },
  });
}

/**
 * Clé de comparaison d'un nom : mots sans accents, sans majuscules, sans tirets ni apostrophes, dans l'ordre
 * alphabétique (un nom et des prénoms inversés donnent la même clé). « N'GUESSAN Aya-Marie » = « aya marie nguessan ».
 */
export function nameKey(firstName: string, lastName: string) {
  return `${firstName} ${lastName}`
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .sort()
    .join(' ');
}

export type DuplicateReason = 'NOM_NAISSANCE' | 'NOM_TELEPHONE';

export const DUPLICATE_REASON_LABELS: Record<DuplicateReason, string> = {
  NOM_NAISSANCE: 'même nom et même date de naissance',
  NOM_TELEPHONE: 'même nom et un parent en commun',
};

export type DuplicateCandidate = {
  id: string; matricule: string; firstName: string; lastName: string; birthDate: Date | null; status: string;
  reason: DuplicateReason; reasonLabel: string; lastClass: string | null; lastYear: string | null;
  /** Site de la dernière classe : sert au périmètre des personnels limités à un site. */
  lastSiteId: string | null; lastSite: string | null;
  /** Inscription active pour l'année en cours : l'élève n'est pas à réinscrire, il l'est déjà. */
  enrolledThisYear: boolean;
};

/**
 * Dossiers existants qui ressemblent à un élève : même nom (clé ci-dessus) ET, soit la même date de naissance, soit
 * un parent ou tuteur au même numéro de téléphone. Un nom seul ne suffit pas (homonymes trop fréquents).
 */
export async function findDuplicates(
  tx: Tx,
  input: { firstName: string; lastName: string; birthDate?: Date | null; phones: string[] },
  exclude: string[] = [],
): Promise<DuplicateCandidate[]> {
  const key = nameKey(input.firstName, input.lastName);
  if (!key) return [];
  const found = new Map<string, DuplicateReason>();
  if (input.birthDate) {
    const same = await tx.student.findMany({ where: { birthDate: input.birthDate, id: { notIn: exclude } }, select: { id: true, firstName: true, lastName: true } });
    for (const s of same) if (nameKey(s.firstName, s.lastName) === key) found.set(s.id, 'NOM_NAISSANCE');
  }
  if (input.phones.length) {
    const links = await tx.studentGuardian.findMany({
      where: { guardian: { phone: { in: input.phones } }, studentId: { notIn: exclude } },
      select: { student: { select: { id: true, firstName: true, lastName: true } } },
    });
    for (const { student: s } of links) if (!found.has(s.id) && nameKey(s.firstName, s.lastName) === key) found.set(s.id, 'NOM_TELEPHONE');
  }
  if (!found.size) return [];
  const rows = await tx.student.findMany({
    where: { id: { in: [...found.keys()] } },
    select: {
      id: true, matricule: true, firstName: true, lastName: true, birthDate: true, status: true,
      enrollments: {
        orderBy: { academicYear: { startDate: 'desc' } }, take: 1,
        select: { status: true, class: { select: { name: true, siteId: true, site: { select: { name: true } } } }, academicYear: { select: { label: true, isCurrent: true } } },
      },
    },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(({ enrollments, ...s }) => {
    const reason = found.get(s.id)!;
    const last = enrollments[0];
    return {
      ...s, reason, reasonLabel: DUPLICATE_REASON_LABELS[reason],
      lastClass: last?.class.name ?? null, lastYear: last?.academicYear.label ?? null,
      lastSiteId: last?.class.siteId ?? null, lastSite: last?.class.site.name ?? null,
      enrolledThisYear: !!last && last.academicYear.isCurrent && last.status === 'ACTIVE',
    };
  });
}

/**
 * Périmètre « historique » d'un personnel limité à un site : les élèves dont la dernière inscription (quelle que soit
 * l'année ou son état) est dans une classe de ses sites. null = tous les élèves de l'établissement.
 */
export async function historyStudentIds(tx: Tx, siteIds: string[]): Promise<string[] | null> {
  if (!siteIds.length) return null;
  const rows = await tx.enrollment.findMany({ select: { studentId: true, academicYear: { select: { startDate: true } }, class: { select: { siteId: true } } } });
  const last = new Map<string, { start: number; siteId: string }>();
  for (const r of rows) {
    const start = r.academicYear.startDate.getTime();
    const seen = last.get(r.studentId);
    if (!seen || start > seen.start) last.set(r.studentId, { start, siteId: r.class.siteId });
  }
  return [...last].filter(([, v]) => siteIds.includes(v.siteId)).map(([id]) => id);
}

/** Paires de dossiers existants qui se ressemblent (même règle que ci-dessus), pour la liste de la direction. */
export async function suspectedPairs(tx: Tx, visible: string[] | null) {
  const students = await tx.student.findMany({
    where: visible ? { id: { in: visible } } : {},
    select: { id: true, firstName: true, lastName: true, birthDate: true, createdAt: true, guardians: { select: { guardian: { select: { phone: true } } } } },
  });
  const groups = new Map<string, { id: string; createdAt: Date }[]>();
  const add = (k: string, s: { id: string; createdAt: Date }) => groups.set(k, [...(groups.get(k) ?? []), s]);
  for (const s of students) {
    const key = nameKey(s.firstName, s.lastName);
    if (!key) continue;
    if (s.birthDate) add(`N|${key}|${s.birthDate.toISOString().slice(0, 10)}`, s);
    for (const phone of new Set(s.guardians.map((g) => g.guardian.phone))) add(`T|${key}|${phone}`, s);
  }
  // Paire ordonnée : le dossier le plus récent d'abord. Une même date de naissance l'emporte sur un parent commun.
  const pairs = new Map<string, { studentId: string; otherId: string; reason: DuplicateReason }>();
  for (const [k, list] of groups) {
    if (list.length < 2) continue;
    const reason: DuplicateReason = k.startsWith('N|') ? 'NOM_NAISSANCE' : 'NOM_TELEPHONE';
    const sorted = [...list].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const id = `${sorted[i].id}|${sorted[j].id}`;
        if (!pairs.has(id) || reason === 'NOM_NAISSANCE') pairs.set(id, { studentId: sorted[i].id, otherId: sorted[j].id, reason });
      }
    }
  }
  return [...pairs.values()];
}

/**
 * Fin de la journée `date` (AAAA-MM-JJ) dans le fuseau de l'école : l'instant de référence des élèves facturables.
 */
export function endOfSchoolDay(date: string, timeZone: string) {
  const [y, m, d] = date.split('-').map(Number);
  const next = Date.UTC(y, m - 1, d + 1);
  // Décalage du fuseau à cette date (minutes), sans bibliothèque : l'heure locale lue par Intl, comparée à l'UTC.
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(next))
      .map((p) => [p.type, p.value]),
  );
  const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return new Date(next - (local - next) - 1);
}

/**
 * Élèves facturables d'une école pour une année scolaire, à la date de référence R (définition validée par Dankou
 * le 11 novembre 2026) : « un élève ayant une inscription active pour l'année scolaire concernée à une date de
 * référence ». R est un jour (AAAA-MM-JJ) compté jusqu'à minuit dans le fuseau de l'école. Une inscription de
 * l'année compte si elle est :
 * - enregistrée au plus tard le jour R ;
 * - non annulée à la fin du jour R (annulée avant : exclue ; annulée après : elle était active à R) ;
 * - sans sortie (transfert, abandon) datée du jour R ou d'avant (un élève sorti le jour R ne compte plus).
 * Une seule inscription par élève et par année (contrainte de la base) : un élève n'est jamais compté deux fois
 * dans la même école pour la même année. Deux dossiers en double non tranchés par la direction comptent tels que
 * saisis (règle A du 12 novembre 2026). Aucune facture n'est créée ici : ces données serviront au lot de facturation.
 */
export function billableEnrollments(tx: Tx, academicYearId: string, date: string, timeZone: string) {
  const at = endOfSchoolDay(date, timeZone);
  const day = new Date(`${date}T00:00:00.000Z`);
  return tx.enrollment.findMany({
    where: {
      academicYearId,
      enrolledAt: { lte: at },
      AND: [
        { OR: [{ cancelledAt: null }, { cancelledAt: { gt: at } }] },
        { OR: [{ exitDate: null }, { exitDate: { gt: day } }] },
      ],
    },
    select: { id: true, studentId: true, classId: true, type: true, status: true, enrolledAt: true, class: { select: { siteId: true } }, student: { select: { matricule: true } } },
    orderBy: { enrolledAt: 'asc' },
  });
}
