/**
 * Règles de la facturation de Cahiora (lot G5a), sans accès à la base : paramètres datés, essai, pilote, calendriers.
 * Cahier des charges du lot G5 du 14 novembre 2026. Ce qui attend encore une décision de Dankou est marqué
 * « provisoire » et ne fige rien : positionnement des régularisations (D-G5-28), alertes du pilote (D-G5-38).
 * Les dates sont des jours du calendrier (AAAA-MM-JJ), sans heure.
 */

export type ParameterUnit = 'money' | 'hours' | 'days' | 'months' | 'percent';

export interface ParameterDef {
  label: string;
  unit: ParameterUnit;
  min: number;
  max: number;
  /// Sous-lot qui s'en sert.
  usedFrom: string;
  /// Décision qui doit encore confirmer la valeur.
  provisional?: string;
}

/** Paramètres modifiables par le Super Admin, sans code (§15). Pourcentages en centièmes : 1500 = 15 %. */
export const PARAMETERS = {
  PRICE_PER_PUPIL: { label: 'Prix par élève et par année scolaire', unit: 'money', min: 1, max: 1_000_000, usedFrom: 'G5c' },
  MINIMUM_PER_ESTABLISHMENT: { label: 'Minimum annuel par établissement', unit: 'money', min: 0, max: 100_000_000, usedFrom: 'G5c' },
  TRIAL_DAYS: { label: 'Durée de l’essai gratuit', unit: 'days', min: 1, max: 90, usedFrom: 'G5a' },
  PILOT_FREE_MONTHS: { label: 'Gratuité d’une école pilote', unit: 'months', min: 1, max: 24, usedFrom: 'G5a' },
  PILOT_ALERT_FIRST_DAYS: { label: 'Première alerte avant la fin d’un pilote', unit: 'days', min: 1, max: 120, usedFrom: 'G5a', provisional: 'D-G5-38' },
  PILOT_ALERT_LAST_DAYS: { label: 'Dernière alerte avant la fin d’un pilote', unit: 'days', min: 1, max: 120, usedFrom: 'G5a', provisional: 'D-G5-38' },
  COUNT_REVIEW_DAYS: { label: 'Vérification des effectifs par la direction avant chaque régularisation', unit: 'days', min: 1, max: 60, usedFrom: 'G5b' },
  GRACE_DAYS: { label: 'Délai de grâce en accès complet après la fin de la gratuité', unit: 'days', min: 1, max: 90, usedFrom: 'G5d' },
  // Lectures 7 A et 9 A, validées par Dankou le 20 novembre 2026 : préavis après la réponse à une demande de
  // régularisation (0 : pas de préavis), durée maximale de chaque prolongation exceptionnelle, renouvellements compris.
  NOTICE_HOURS: { label: 'Préavis après la réponse à une demande de régularisation', unit: 'hours', min: 0, max: 168, usedFrom: 'G5d' },
  EXTENSION_MAX_DAYS: { label: 'Durée maximale d’une prolongation exceptionnelle', unit: 'days', min: 1, max: 366, usedFrom: 'G5d' },
  REFERRAL_REWARD: { label: 'Crédit de parrainage par école filleule', unit: 'money', min: 0, max: 10_000_000, usedFrom: 'G5h' },
  COMMISSION_APPORTEUR: { label: 'Commission d’un apporteur d’affaires', unit: 'percent', min: 0, max: 10_000, usedFrom: 'G5h' },
  COMMISSION_PREMIUM: { label: 'Commission d’un partenaire premium', unit: 'percent', min: 0, max: 10_000, usedFrom: 'G5h' },
} as const satisfies Record<string, ParameterDef>;

export type ParameterKey = keyof typeof PARAMETERS;
export const PARAMETER_KEYS = Object.keys(PARAMETERS) as ParameterKey[];

export interface ParameterVersion {
  id: string;
  key: string;
  currency: string | null;
  value: number;
  effectiveFrom: string;
  createdAt: Date;
}

/**
 * Version en vigueur un jour donné : la date d'effet la plus récente jusqu'à ce jour, puis la dernière inscrite
 * (même règle que la fonction billing_parameter_value de la base).
 */
export function versionOn<T extends ParameterVersion>(versions: T[], key: string, currency: string | null, day: string): T | null {
  const list = versions
    .filter((v) => v.key === key && (v.currency ?? null) === (currency ?? null) && v.effectiveFrom <= day)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  return list.at(-1) ?? null;
}

/** Erreur de saisie d'une nouvelle version, ou null. La date d'effet n'est jamais dans le passé (§2 : jamais rétroactif). */
export function parameterError(key: string, currency: string | null | undefined, value: number, effectiveFrom: string, today: string, currencies: string[]): string | null {
  const def = (PARAMETERS as Record<string, ParameterDef>)[key];
  if (!def) return 'Paramètre inconnu';
  if (def.unit === 'money') {
    if (!currency || !currencies.includes(currency)) return 'Monnaie : choisissez celle des établissements concernés';
  } else if (currency) return 'Ce paramètre ne dépend pas de la monnaie';
  if (!Number.isInteger(value) || value < def.min || value > def.max) return `Valeur : nombre entier entre ${def.min} et ${def.max}`;
  if (!isDay(effectiveFrom)) return 'Date d’effet invalide';
  if (effectiveFrom < today) return 'La date d’effet ne peut pas être passée : un changement ne s’applique jamais avant sa saisie';
  return null;
}

// ---------------------------------------------------------------- Dates

const DAY_MS = 86_400_000;

export const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** Dernier jour du mois (mois de 0 à 11, au-delà : mois des années suivantes). */
export function lastDayOfMonth(year: number, month0: number) {
  return new Date(Date.UTC(year, month0 + 1, 0)).toISOString().slice(0, 10);
}

const parts = (day: string) => day.split('-').map(Number) as [number, number, number];

/** Dernier jour de l'essai : le jour d'ouverture est le jour 1 (14 jours du 1er au 14 juillet). */
export function trialEndDay(start: string, days: number) {
  return addDays(start, days - 1);
}

/**
 * Dernier jour gratuit d'une école pilote : la veille du même quantième, N mois plus tard (5 novembre + 3 mois :
 * jusqu'au 4 février inclus). Quand ce quantième n'existe pas (31 janvier + 1 mois), le dernier jour de ce mois.
 */
export function pilotEndDay(start: string, months: number) {
  const [y, m, d] = parts(start);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const ty = target.getUTCFullYear();
  const tm = target.getUTCMonth();
  const last = Number(lastDayOfMonth(ty, tm).slice(8));
  if (d > last) return lastDayOfMonth(ty, tm);
  return addDays(`${ty}-${String(tm + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`, -1);
}

// ---------------------------------------------------------------- Calendriers des établissements (§3)

export type CalendarFormula = 'A' | 'B' | 'MANUEL';

export interface CalendarDates {
  startDate: string;
  endDate: string;
  preparationFrom?: string | null;
  initialCountDate: string;
  firstRegularizationDate: string;
  finalRegularizationDate: string;
  renewalDate?: string | null;
}

export const CALENDAR_FIELDS: { key: keyof CalendarDates; label: string }[] = [
  { key: 'startDate', label: 'Début de l’année scolaire' },
  { key: 'endDate', label: 'Fin de l’année scolaire' },
  { key: 'preparationFrom', label: 'Début de la préparation' },
  { key: 'initialCountDate', label: 'Comptage initial' },
  { key: 'firstRegularizationDate', label: 'Première régularisation' },
  { key: 'finalRegularizationDate', label: 'Régularisation finale' },
  { key: 'renewalDate', label: 'Renouvellement' },
];

/**
 * Dates proposées pour une année, selon la formule (décision D-G5-28 en attente, donc provisoire) :
 * - B, à distance fixe : comptage initial à la fin du 3e mois, première régularisation 3 mois avant la fin,
 *   régularisation finale le dernier jour (septembre à juin : 30 novembre, 31 mars, 30 juin) ;
 * - A, en proportion : comptage initial à la fin du 3e mois, première régularisation à 70 % de l'année,
 *   régularisation finale le dernier jour.
 * Le Super Admin peut ensuite ajuster chaque date, avec un motif. Pour l'écran, passer par calendarProposal, qui dit
 * aussi quand la formule ne s'applique pas.
 */
export function proposeCalendar(startDate: string, endDate: string, formula: 'A' | 'B') {
  const [sy, sm] = parts(startDate);
  const [ey, em] = parts(endDate);
  const initialCountDate = lastDayOfMonth(sy, sm - 1 + 2);
  const firstRegularizationDate = formula === 'B'
    ? lastDayOfMonth(ey, em - 1 - 3)
    : addDays(startDate, Math.round(0.7 * daysBetween(startDate, endDate)));
  return { initialCountDate, firstRegularizationDate, finalRegularizationDate: endDate };
}

/**
 * Une année de 6 mois ou moins n'a pas de dates proposées : aucune formule n'y donne un calendrier valide (vérifié sur
 * 636 années), et la décision CAL-1 de Dankou du 19 novembre 2026 (option A) veut que le Super Admin y saisisse les
 * dates à la main, avec un motif.
 */
export const SHORT_YEAR_MONTHS = 6;

/** Mois de l'année scolaire, du mois de la rentrée au mois de la fin, les deux comptés (septembre à juin : 10). */
export function monthsSpanned(startDate: string, endDate: string) {
  const [sy, sm] = parts(startDate);
  const [ey, em] = parts(endDate);
  return (ey - sy) * 12 + em - sm + 1;
}

/** Erreur du début ou de la fin d'une année, ou null (mêmes messages que calendarErrors). */
export function yearDatesError(startDate: unknown, endDate: unknown): string | null {
  if (!isDay(startDate)) return 'Début de l’année scolaire : date invalide';
  if (!isDay(endDate)) return 'Fin de l’année scolaire : date invalide';
  if (endDate <= startDate) return 'La fin de l’année doit suivre son début';
  if (daysBetween(startDate, endDate) > 550) return 'Une année scolaire dure au plus 18 mois';
  return null;
}

export interface CalendarProposal {
  /** La formule donne un calendrier valide pour cette année. */
  applies: boolean;
  /** Pourquoi elle ne s'applique pas, pour l'écran ; null quand elle s'applique. */
  message: string | null;
  initialCountDate: string | null;
  firstRegularizationDate: string | null;
  finalRegularizationDate: string | null;
}

/**
 * Dates proposées par une formule pour n'importe quelle année (correction C0 : plus seulement pour l'année scolaire
 * enregistrée par l'école). Les dates de l'année doivent être valides (yearDatesError). Quand la formule ne
 * s'applique pas, aucune date n'est proposée et le message dit quoi faire.
 */
export function calendarProposal(startDate: string, endDate: string, formula: 'A' | 'B'): CalendarProposal {
  const none = { initialCountDate: null, firstRegularizationDate: null, finalRegularizationDate: null };
  const manual = 'choisissez « Dates saisies à la main » et indiquez le motif';
  if (monthsSpanned(startDate, endDate) <= SHORT_YEAR_MONTHS) {
    return { applies: false, message: `La formule ${formula} ne s’applique pas à une année de 6 mois ou moins (du mois de la rentrée au mois de la fin) : ${manual}`, ...none };
  }
  const p = proposeCalendar(startDate, endDate, formula);
  if (calendarErrors({ startDate, endDate, ...p }).length) {
    return { applies: false, message: `La formule ${formula} ne donne pas de dates valides pour cette année : ${manual}`, ...none };
  }
  return { applies: true, message: null, ...p };
}

/** Propositions des deux formules pour une année, ou null si son début ou sa fin ne va pas. */
export function calendarProposals(startDate: string, endDate: string): Record<'A' | 'B', CalendarProposal> | null {
  if (yearDatesError(startDate, endDate)) return null;
  return { B: calendarProposal(startDate, endDate, 'B'), A: calendarProposal(startDate, endDate, 'A') };
}

/**
 * Version proposée par une formule dont une des trois dates calculées a été changée à la main (correction C0) : elle
 * reste « formule B », marquée « ajustée », avec son motif. Le début de la préparation et le renouvellement ne viennent
 * d'aucune formule et n'y comptent pas. Si la définition d'une formule change un jour, elle prendra un autre nom, pour
 * que les versions déjà enregistrées gardent leur marque.
 */
export function isAdjusted(c: CalendarDates, formula: string) {
  if (formula !== 'A' && formula !== 'B') return false;
  const p = proposeCalendar(c.startDate, c.endDate, formula);
  return p.initialCountDate !== c.initialCountDate || p.firstRegularizationDate !== c.firstRegularizationDate || p.finalRegularizationDate !== c.finalRegularizationDate;
}

/** Erreurs d'un calendrier saisi (messages pour l'écran), dans l'ordre des champs. */
export function calendarErrors(c: CalendarDates): string[] {
  const errors: string[] = [];
  for (const f of CALENDAR_FIELDS) {
    const v = c[f.key];
    const optional = f.key === 'preparationFrom' || f.key === 'renewalDate';
    if ((v === null || v === undefined || v === '') && optional) continue;
    if (!isDay(v)) errors.push(`${f.label} : date invalide`);
  }
  if (errors.length) return errors;
  if (c.endDate <= c.startDate) errors.push('La fin de l’année doit suivre son début');
  else if (daysBetween(c.startDate, c.endDate) > 550) errors.push('Une année scolaire dure au plus 18 mois');
  if (c.preparationFrom && (c.preparationFrom >= c.startDate || daysBetween(c.preparationFrom, c.startDate) > 184)) {
    errors.push('La préparation commence avant la rentrée, au plus 6 mois avant');
  }
  if (c.initialCountDate < c.startDate || c.initialCountDate > c.endDate) errors.push('Le comptage initial tombe pendant l’année scolaire');
  if (!(c.initialCountDate < c.firstRegularizationDate && c.firstRegularizationDate < c.finalRegularizationDate)) {
    errors.push('Ordre attendu : comptage initial, puis première régularisation, puis régularisation finale');
  }
  if (c.finalRegularizationDate > c.endDate) errors.push('La régularisation finale tombe au plus tard le dernier jour de l’année');
  if (c.renewalDate && c.renewalDate <= c.startDate) errors.push('Le renouvellement suit le début de l’année');
  return errors;
}

/**
 * Changements interdits d'une nouvelle version par rapport à la précédente (§2 et §3 : jamais rétroactif) :
 * une date déjà passée ne change pas, et une date ne peut pas être déplacée dans le passé.
 */
export function retroactiveChanges(previous: CalendarDates, next: CalendarDates, today: string): string[] {
  const errors: string[] = [];
  for (const f of CALENDAR_FIELDS) {
    const before = previous[f.key] || null;
    const after = next[f.key] || null;
    if (before === after) continue;
    if (before && before < today) errors.push(`${f.label} : le ${frDay(before)} est passé, cette date ne change plus`);
    else if (after && after < today) errors.push(`${f.label} : une date ne peut pas être déplacée dans le passé`);
  }
  return errors;
}

/** Libellé d'une année scolaire : « 2026-2027 » ou « 2027 » (année civile). */
export const isYearLabel = (s: unknown): s is string => typeof s === 'string' && /^\d{4}(-\d{4})?$/.test(s);

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/** « 4 février 2027 ». */
export function frDay(day: string) {
  const [y, m, d] = parts(day);
  return `${d === 1 ? '1er' : d} ${MONTHS[m - 1]} ${y}`;
}

// ---------------------------------------------------------------- Abonnements (§4 et §13)

export type SubscriptionStatus = 'TRIAL' | 'PILOT' | 'AWAITING_ACCEPTANCE' | 'AWAITING_PAYMENT' | 'ACTIVE' | 'LIMITED';

export const STATUS_LABELS: Record<SubscriptionStatus, string> = {
  TRIAL: 'Essai gratuit',
  PILOT: 'École pilote partenaire CAHIORA',
  AWAITING_ACCEPTANCE: 'En attente d’acceptation des conditions',
  AWAITING_PAYMENT: 'En attente de paiement',
  ACTIVE: 'Abonnement actif',
  LIMITED: 'Accès limité',
};

const KIND_LABELS: Record<string, string> = {
  TRIAL_OPENED: 'Essai gratuit ouvert', PILOT_OPENED: 'Statut d’école pilote partenaire activé', PILOT_END_CHANGED: 'Fin de la gratuité du pilote modifiée',
  TRIAL_ENDED: 'Essai terminé : conditions commerciales à accepter', PILOT_ENDED: 'Pilote terminé : conditions commerciales à accepter',
  TERMS_ACCEPTED: 'Conditions commerciales acceptées par la direction',
  // Lot G5d-1 : accès selon le paiement.
  ACCESS_LIMITED: 'Délai passé sans paiement validé : accès limité', ACCESS_EXTENDED: 'Accès complet prolongé par Cahiora',
  // Lecture 9 A (20 novembre 2026) : renouvellement exceptionnel ou fin avancée d'une prolongation.
  ACCESS_EXTENSION_RENEWED: 'Renouvellement exceptionnel : accès complet prolongé à nouveau par Cahiora',
  ACCESS_EXTENSION_SHORTENED: 'Fin de la prolongation avancée par Cahiora',
  REGULARIZATION_REQUESTED: 'Demande de régularisation envoyée par la direction', REGULARIZATION_ANSWERED: 'Réponse de Cahiora à la demande de régularisation',
};

/** Libellé d'une ligne de l'historique d'un abonnement. */
export const subscriptionKindLabel = (kind: string) => KIND_LABELS[kind] ?? kind;

/** Jours de gratuité restants, jour de fin compris (0 une fois la fin passée). */
export function daysLeft(today: string, lastDay: string) {
  return Math.max(0, daysBetween(today, lastDay) + 1);
}

/**
 * Alertes avant la fin d'un pilote dues aujourd'hui : chaque délai (30 et 7 jours, provisoire) qui a commencé et
 * dont la fin n'est pas passée. Une tâche en retard envoie l'alerte au premier passage, une seule fois.
 */
export function dueAlerts(today: string, lastDay: string, delays: number[]) {
  if (today > lastDay) return [];
  return [...new Set(delays)].filter((n) => n > 0 && addDays(lastDay, -n) <= today).sort((a, b) => b - a);
}
