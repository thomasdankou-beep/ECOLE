import { localDay } from '../../common/country';

/**
 * Comptages des élèves facturables (lot G5b), règles sans accès à la base : quels comptages sont dus un jour donné,
 * quelle année scolaire compte à la fin d'un essai ou d'un pilote, et quelles inscriptions entrent dans la liste.
 * Les mêmes données donnent toujours le même résultat ; la base refait les contrôles à l'enregistrement
 * (record_billing_count, migration comptages_g5b).
 */

export const COUNT_KINDS = ['TRIAL_END', 'PILOT_END', 'INITIAL', 'FIRST_REGULARIZATION', 'FINAL_REGULARIZATION'] as const;
export type CountKind = (typeof COUNT_KINDS)[number];
export type CountStage = 'PROVISIONAL' | 'FROZEN';
export type CountBasis = 'ACTIVE' | 'DEPARTURE_AUDIT' | 'DEPARTURE_UNKNOWN' | 'DEPARTURE_DIRECTION' | 'DEPARTURE_CONFIRMED' | 'EXCLUDED';

export const COUNT_KIND_LABELS: Record<CountKind, string> = {
  TRIAL_END: 'Fin de l’essai gratuit',
  PILOT_END: 'Fin de la période pilote',
  INITIAL: 'Comptage initial',
  FIRST_REGULARIZATION: 'Première régularisation',
  FINAL_REGULARIZATION: 'Régularisation finale',
};

export const COUNT_STAGE_LABELS: Record<CountStage, string> = { PROVISIONAL: 'Provisoire', FROZEN: 'Définitif' };

export const BASIS_LABELS: Record<CountBasis, string> = {
  ACTIVE: 'Inscrit à la date',
  DEPARTURE_AUDIT: 'À vérifier : départ enregistré avant l’historique, compté (date du journal après le jour du comptage)',
  DEPARTURE_UNKNOWN: 'À vérifier : départ enregistré avant l’historique, sans date connue, compté',
  DEPARTURE_DIRECTION: 'Départ enregistré avant l’historique : date fixée par la direction',
  DEPARTURE_CONFIRMED: 'Départ sans date retrouvée, confirmé par la direction : compté',
  EXCLUDED: 'Exclu : inscription annulée par erreur de saisie',
};

/**
 * G5b-2 (Dankou, 20 novembre 2026) : un élève signalé parti sans date de départ connue est « À vérifier » et reste
 * compté, jamais exclu d'office. La direction fixe sa date, ou confirme qu'elle est introuvable (il reste compté, sans
 * être « À vérifier »), à tout moment avant le comptage (période gratuite comprise) ou pendant sa vérification.
 */
export const TO_CHECK_BASES: CountBasis[] = ['DEPARTURE_AUDIT', 'DEPARTURE_UNKNOWN'];
export const isToCheck = (i: { counted: boolean; basis: CountBasis }) => i.counted && TO_CHECK_BASES.includes(i.basis);
/** Jours avant la fin d'une vérification (ou d'une période gratuite) où la direction est rappelée s'il reste des élèves « À vérifier ». */
export const TO_CHECK_REMINDER_DAYS = 2;
export const FREE_END_CHECK_REMINDER_DAYS = 3;

/** Dates du calendrier de facturation qui donnent un comptage. */
export const CALENDAR_COUNT_DATES = {
  INITIAL: 'initialCountDate',
  FIRST_REGULARIZATION: 'firstRegularizationDate',
  FINAL_REGULARIZATION: 'finalRegularizationDate',
} as const;
type CalendarKind = keyof typeof CALENDAR_COUNT_DATES;

/** Abonnement vu par les comptages : `endedTrial` et `endedPilot` sont les derniers jours gratuits réellement terminés. */
export type CountSubscription = { status: string; trialEnd: string | null; pilotEnd: string | null; endedTrial: string | null; endedPilot: string | null };
/** Dernière version du calendrier d'une année scolaire, dates en AAAA-MM-JJ. */
export type CountCalendar = {
  yearLabel: string; version: number; startDate: string; endDate: string; preparationFrom: string | null;
  initialCountDate: string; firstRegularizationDate: string; finalRegularizationDate: string;
};
export type RecordedCount = { kind: CountKind; stage: CountStage; date: string; yearLabel: string; reviewUntil: string | null };
/** Comptage à faire : `yearLabel` vide pour une fin d'essai ou de pilote (l'année se cherche à la date, freeEndYear). */
export type DueCount = { kind: CountKind; stage: CountStage; date: string; yearLabel: string | null; calendarVersion: number | null; reviewUntil: string | null };

/**
 * Comptages dus le jour `today` de l'établissement (son fuseau), du plus ancien au plus récent :
 * - fin d'essai ou de pilote : à la fin du dernier jour gratuit, une fois la période réellement terminée, figé aussitôt
 *   (la première facture part sans attendre, lot G5c) ;
 * - dates du calendrier (comptage initial, régularisations) : provisoire le lendemain, qui ouvre la vérification par la
 *   direction, puis figé le lendemain du dernier jour de vérification. Rien pendant une période gratuite, ni pour une
 *   date qui y tombe : la période gratuite n'est jamais facturée (le relevé à 0 F d'une telle date reste une proposition).
 * Sans abonnement, aucun comptage.
 */
export function dueCounts(today: string, s: CountSubscription | null, calendars: CountCalendar[], done: RecordedCount[]): DueCount[] {
  if (!s) return [];
  const out: DueCount[] = [];
  const find = (kind: CountKind, stage: CountStage, date: string, yearLabel?: string) =>
    done.find((d) => d.kind === kind && d.stage === stage && d.date === date && (yearLabel === undefined || d.yearLabel === yearLabel));
  for (const [kind, last] of [['TRIAL_END', s.endedTrial], ['PILOT_END', s.endedPilot]] as const) {
    if (last && last < today && !find(kind, 'FROZEN', last)) out.push({ kind, stage: 'FROZEN', date: last, yearLabel: null, calendarVersion: null, reviewUntil: null });
  }
  if (s.status !== 'TRIAL' && s.status !== 'PILOT') {
    const lastFree = [s.trialEnd, s.pilotEnd].filter((d): d is string => !!d).sort().pop() ?? null;
    for (const c of calendars) {
      for (const kind of Object.keys(CALENDAR_COUNT_DATES) as CalendarKind[]) {
        const date = c[CALENDAR_COUNT_DATES[kind]];
        if (date >= today || (lastFree && date <= lastFree)) continue;
        if (find(kind, 'FROZEN', date, c.yearLabel)) continue;
        const provisional = find(kind, 'PROVISIONAL', date, c.yearLabel);
        if (!provisional) out.push({ kind, stage: 'PROVISIONAL', date, yearLabel: c.yearLabel, calendarVersion: c.version, reviewUntil: null });
        else if (provisional.reviewUntil && provisional.reviewUntil < today) {
          out.push({ kind, stage: 'FROZEN', date, yearLabel: c.yearLabel, calendarVersion: c.version, reviewUntil: provisional.reviewUntil });
        }
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || COUNT_KINDS.indexOf(a.kind) - COUNT_KINDS.indexOf(b.kind));
}

type Year = { id: string; label: string; startDate: string; endDate: string };

/**
 * Année scolaire comptée à la fin d'un essai ou d'un pilote : celle dont le calendrier de facturation couvre la date,
 * période de préparation comprise (une école qui s'abonne avant la rentrée paie l'année qu'elle prépare, sans seconde
 * facture à la rentrée) ; sinon l'année scolaire de l'école qui contient la date ; sinon aucune (comptage en attente).
 */
export function freeEndYear(date: string, calendars: CountCalendar[], years: Year[]): Year | null {
  const calendar = calendars
    .filter((c) => (c.preparationFrom ?? c.startDate) <= date && date <= c.endDate)
    .sort((a, b) => b.startDate.localeCompare(a.startDate))[0];
  const byCalendar = calendar && years.find((y) => y.label === calendar.yearLabel);
  if (byCalendar) return byCalendar;
  return years.filter((y) => y.startDate <= date && date <= y.endDate).sort((a, b) => b.startDate.localeCompare(a.startDate))[0] ?? null;
}

/** Une inscription vue à la fin du jour R (billableRows) : seuls les champs utiles à la liste. */
export type ItemRow = {
  enrollmentId: string; studentId: string; classId: string; siteId: string | null; state: 'ACTIVE' | 'INACTIVE' | 'UNKNOWN';
  unknown: { since: Date; before: Date | null } | null;
};
export type CountItem = { enrollmentId: string; classId: string; siteId: string | null; counted: boolean; basis: CountBasis; departureDate: string | null };

/**
 * D-G5-16 A : la date d'un départ enregistré avant l'historique des inscriptions est le jour (fuseau de l'école) de la
 * première ligne « élève retiré ou transféré » du journal d'audit pour cet élève, dans la période concernée (après son
 * début, avant le retour de l'élève s'il est revenu) et déjà écrite à l'instant `knownAt`. Aucune ligne : pas de date.
 */
export function auditDepartureDays(rows: ItemRow[], logs: { entityId: string | null; createdAt: Date }[], knownAt: Date, timeZone: string) {
  const days = new Map<string, string>();
  for (const r of rows) {
    if (!r.unknown) continue;
    const until = r.unknown.before && r.unknown.before < knownAt ? r.unknown.before : knownAt;
    const first = logs
      .filter((l) => l.entityId === r.studentId && l.createdAt >= r.unknown!.since && l.createdAt <= until)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
    if (first) days.set(r.enrollmentId, localDay(timeZone, first.createdAt));
  }
  return days;
}

/**
 * Liste d'un comptage au jour R, triée par inscription :
 * - inscription active à la fin du jour R : comptée ;
 * - départ enregistré avant l'historique : la date fixée par la direction, sinon celle du journal d'audit ; comptée si
 *   le départ est après R (le jour du départ n'est plus un jour de présence, comme une sortie datée) ; sans aucune date,
 *   comptée et « À vérifier » (D-G5-16 A et G5b-2 : un silence ne retire pas l'élève du comptage), sauf si la direction
 *   a confirmé la date introuvable (`confirmed`) : comptée, sans être « À vérifier » ;
 * - exclusion validée : gardée dans la liste, non comptée, pour que la direction la voie.
 * Une inscription qui n'était pas active à R n'apparaît pas.
 */
export function resolveItems(
  date: string, rows: ItemRow[], departures: { direction: Map<string, string>; audit: Map<string, string>; confirmed?: Set<string> }, excluded: Set<string>,
): CountItem[] {
  const out: CountItem[] = [];
  for (const r of rows) {
    if (r.state === 'INACTIVE') continue;
    let basis: CountBasis = 'ACTIVE';
    let departureDate: string | null = null;
    if (r.state === 'UNKNOWN') {
      const byDirection = departures.direction.get(r.enrollmentId);
      departureDate = byDirection ?? departures.audit.get(r.enrollmentId) ?? null;
      basis = byDirection ? 'DEPARTURE_DIRECTION' : departures.confirmed?.has(r.enrollmentId) ? 'DEPARTURE_CONFIRMED' : departureDate ? 'DEPARTURE_AUDIT' : 'DEPARTURE_UNKNOWN';
      if (departureDate && departureDate <= date) continue;
    }
    const isExcluded = excluded.has(r.enrollmentId);
    out.push({ enrollmentId: r.enrollmentId, classId: r.classId, siteId: r.siteId, counted: !isExcluded, basis: isExcluded ? 'EXCLUDED' : basis, departureDate });
  }
  return out.sort((a, b) => a.enrollmentId.localeCompare(b.enrollmentId));
}

/** Vérification encore ouverte : comptage provisoire, dernier jour de vérification pas encore passé, pas encore figé. */
export function reviewOpen(c: { stage: string; reviewUntil: string | null }, today: string, frozen: boolean) {
  return c.stage === 'PROVISIONAL' && !!c.reviewUntil && c.reviewUntil >= today && !frozen;
}

/** Un comptage enregistré, tel que l'affichent la direction et le Super Admin : des nombres et une empreinte, aucun nom. */
export type CountRecord = {
  id: string; yearLabel: string; kind: CountKind; referenceDate: string; stage: CountStage; calendarVersion: number | null; pupils: number; cumulative: number;
  toCheck: number; excluded: number; listHash: string; at: Date; knownAt: Date; reviewUntil: string | null; timeZone: string; createdAt: Date;
};

/**
 * Libellés et état d'un comptage : vérification ouverte, figé (ou figé depuis : le provisoire dont le comptage figé de la
 * même date existe). `all` : les comptages du même établissement.
 */
export function countView<T extends CountRecord>(c: T, today: string, all: CountRecord[]) {
  const frozenSince = c.stage === 'PROVISIONAL'
    && all.some((x) => x.stage === 'FROZEN' && x.kind === c.kind && x.yearLabel === c.yearLabel && x.referenceDate === c.referenceDate);
  return {
    ...c, kindLabel: COUNT_KIND_LABELS[c.kind], stageLabel: COUNT_STAGE_LABELS[c.stage],
    reviewOpen: reviewOpen(c, today, frozenSince), frozen: c.stage === 'FROZEN' || frozenSince,
  };
}

/** Les comptages d'un établissement, les plus récents d'abord (date du comptage, puis figé avant provisoire). */
export function sortCounts<T extends CountRecord>(rows: T[]) {
  return [...rows].sort((a, b) => b.referenceDate.localeCompare(a.referenceDate)
    || COUNT_KINDS.indexOf(b.kind) - COUNT_KINDS.indexOf(a.kind) || (a.stage === b.stage ? 0 : a.stage === 'FROZEN' ? -1 : 1));
}
