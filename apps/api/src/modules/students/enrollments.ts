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
  /** Dernière inscription annulée : sa classe n'a jamais été suivie, l'écran le dit (corrections du lot G4). */
  lastCancelled: boolean;
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
      lastCancelled: last?.status === 'CANCELLED',
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

type JournalLine = { kind: EnrollmentEventKind; data: Prisma.JsonValue | null; createdAt: Date };

/**
 * Une période d'activité d'une inscription, reconstruite depuis son historique : début (instant) et moment où ce
 * début a été enregistré ; fin par une sortie datée (le jour de sortie n'est plus un jour d'activité), par une
 * annulation (instant), ou fin inconnue (départ enregistré avant l'historique du lot G4, sans date).
 */
export type Episode = {
  start: Date;
  startRecorded: Date;
  end: null | { kind: 'EXIT'; day: string; recorded: Date } | { kind: 'CANCEL'; at: Date } | { kind: 'UNKNOWN'; before: Date | null };
};

const byRecord = (lines: JournalLine[]) => [...lines].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
const field = (l: JournalLine, key: string) => ((l.data ?? {}) as Record<string, unknown>)[key];

/**
 * Périodes d'activité d'une inscription, rejouées depuis son historique dans l'ordre d'enregistrement (corrections
 * du lot G4) : l'état actuel de l'inscription ne sert qu'à repérer un départ enregistré avant cet historique.
 */
export function enrollmentEpisodes(e: { enrolledAt: Date; status: string }, journal: JournalLine[]): Episode[] {
  const lines = byRecord(journal);
  const created = lines.find((l) => l.kind === 'ENROLLED' || l.kind === 'REENROLLED');
  const episodes: Episode[] = [];
  let open: Episode | null = { start: e.enrolledAt, startRecorded: created?.createdAt ?? e.enrolledAt, end: null };
  for (const l of lines) {
    if (l.kind === 'TRANSFERRED' || l.kind === 'WITHDRAWN') {
      if (open) episodes.push({ ...open, end: { kind: 'EXIT', day: String(field(l, 'exitDate')).slice(0, 10), recorded: l.createdAt } });
      open = null;
    } else if (l.kind === 'CANCELLED') {
      if (open) episodes.push({ ...open, end: { kind: 'CANCEL', at: l.createdAt } });
      open = null;
    } else if (l.kind === 'REINSTATED') {
      // Rétablie alors que l'historique la croit active : elle avait été arrêtée avant l'historique, à une date inconnue.
      if (open) episodes.push({ ...open, end: { kind: 'UNKNOWN', before: l.createdAt } });
      open = { start: l.createdAt, startRecorded: l.createdAt, end: null };
    }
  }
  // Arrêtée sans aucune ligne d'historique pour le dire : départ enregistré avant le lot G4, date inconnue.
  if (open) episodes.push(e.status === 'ACTIVE' ? open : { ...open, end: { kind: 'UNKNOWN', before: null } });
  return episodes;
}

/**
 * État d'une inscription à la fin du jour R (instant `at`), d'après ce qui était enregistré à l'instant `knownAt`.
 * « UNKNOWN » : un départ sans date (enregistré avant l'historique) empêche de conclure.
 */
export function stateAt(episodes: Episode[], date: string, at: Date, knownAt: Date): 'ACTIVE' | 'INACTIVE' | 'UNKNOWN' {
  let unknown = false;
  for (const ep of episodes) {
    if (ep.start > at || ep.startRecorded > knownAt) continue;
    const end = ep.end;
    if (!end) return 'ACTIVE';
    if (end.kind === 'EXIT') {
      // Sortie connue à knownAt et datée du jour R ou d'avant : plus active à la fin du jour R.
      if (end.recorded > knownAt || date < end.day) return 'ACTIVE';
    } else if (end.kind === 'CANCEL') {
      if (end.at > knownAt || end.at > at) return 'ACTIVE';
    } else if (!end.before || end.before > at) {
      unknown = true;
    }
  }
  return unknown ? 'UNKNOWN' : 'INACTIVE';
}

/** Classe de l'inscription à l'instant `at`, d'après l'historique enregistré à l'instant `knownAt`. */
export function classAt(e: { classId: string }, journal: JournalLine[], at: Date, knownAt: Date): string {
  const lines = byRecord(journal);
  const created = lines.find((l) => l.kind === 'ENROLLED' || l.kind === 'REENROLLED');
  const firstMove = lines.find((l) => l.kind === 'CLASS_CHANGED' || l.kind === 'REINSTATED');
  const initial = created ? field(created, 'classId')
    : firstMove ? field(firstMove, firstMove.kind === 'CLASS_CHANGED' ? 'fromClassId' : 'previousClassId') : null;
  let classId = typeof initial === 'string' ? initial : e.classId;
  for (const l of lines) {
    if (l.createdAt > at || l.createdAt > knownAt) break;
    const to = l.kind === 'CLASS_CHANGED' ? field(l, 'toClassId') : l.kind === 'REINSTATED' ? field(l, 'classId') : null;
    if (typeof to === 'string') classId = to;
  }
  return classId;
}

export type BillableCount = {
  /** Jour de référence R (AAAA-MM-JJ), fuseau de l'école, fin de ce jour (instant), et état de l'historique utilisé. */
  date: string; timeZone: string; at: Date; knownAt: Date;
  count: number;
  items: { enrollmentId: string; studentId: string; matricule: string; type: string | null; classId: string; siteId: string | null }[];
  /** Inscriptions qu'on ne peut pas trancher (départ sans date, enregistré avant l'historique) : à vérifier par une personne. */
  toReview: { enrollmentId: string; studentId: string; matricule: string; reason: string }[];
};

/**
 * Élèves facturables d'une école pour une année scolaire, à la date de référence R (définition validée par Dankou
 * le 11 novembre 2026) : « un élève ayant une inscription active pour l'année scolaire concernée à une date de
 * référence ». R est un jour (AAAA-MM-JJ) compté jusqu'à minuit dans le fuseau de l'école.
 *
 * Le calcul ne lit pas l'état actuel des inscriptions : il rejoue leur historique (corrections du lot G4, demande
 * de Dankou du 13 novembre 2026). Une inscription compte si, à la fin du jour R, elle avait commencé, n'avait pas
 * été annulée (annulée avant : exclue ; annulée après : elle était active à R) et n'avait pas de sortie datée du
 * jour R ou d'avant ; une inscription annulée puis rétablie après R ne compte donc pas à R.
 *
 * `knownAt` (par défaut : maintenant) fige le calcul : seules les lignes d'historique enregistrées à cet instant
 * sont lues. Refaire le calcul de R avec le même `knownAt` donne toujours la même liste, même si une sortie est
 * enregistrée plus tard avec une date antérieure ; sans `knownAt`, la sortie tardive est prise en compte.
 *
 * Une seule inscription par élève et par année (contrainte de la base) : un élève n'est jamais compté deux fois dans
 * la même école pour la même année. Deux dossiers en double non tranchés par la direction comptent tels que saisis
 * (règle A du 12 novembre 2026). Aucune facture n'est créée ici : ces données serviront au lot de facturation.
 */
export async function billableEnrollments(tx: Tx, academicYearId: string, date: string, timeZone: string, knownAt: Date = new Date()): Promise<BillableCount> {
  const at = endOfSchoolDay(date, timeZone);
  const rows = await tx.enrollment.findMany({
    where: { academicYearId, enrolledAt: { lte: at } },
    select: {
      id: true, studentId: true, classId: true, status: true, type: true, enrolledAt: true, student: { select: { matricule: true } },
      events: { select: { kind: true, data: true, createdAt: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
    },
    orderBy: [{ enrolledAt: 'asc' }, { id: 'asc' }],
  });
  const sites = new Map((await tx.class.findMany({ where: { academicYearId }, select: { id: true, siteId: true } })).map((c) => [c.id, c.siteId]));
  const out: BillableCount = { date, timeZone, at, knownAt, count: 0, items: [], toReview: [] };
  for (const r of rows) {
    const state = stateAt(enrollmentEpisodes(r, r.events), date, at, knownAt);
    if (state === 'UNKNOWN') {
      out.toReview.push({ enrollmentId: r.id, studentId: r.studentId, matricule: r.student.matricule, reason: 'Départ enregistré sans date avant l’historique des inscriptions' });
    } else if (state === 'ACTIVE') {
      const classId = classAt(r, r.events, at, knownAt);
      out.items.push({ enrollmentId: r.id, studentId: r.studentId, matricule: r.student.matricule, type: r.type, classId, siteId: sites.get(classId) ?? null });
    }
  }
  out.count = out.items.length;
  return out;
}
