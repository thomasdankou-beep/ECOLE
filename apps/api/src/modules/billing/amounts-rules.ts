import { addDays, frDay, isDay, monthsSpanned } from './billing-rules';
import { COUNT_KINDS, CountKind } from './counts-rules';

/**
 * Montants de l'abonnement Cahiora (lot G5c, étape 1), sans accès à la base : montant de l'année, minimum, part de la
 * première année, complément à chaque date, avoir à examiner après une exclusion, document d'un groupe. Les mêmes
 * données donnent toujours le même résultat, et chaque exemple chiffré des documents validés par Dankou est un essai
 * (amounts-rules.spec.ts).
 *
 * Règles validées par Dankou :
 * - 11 novembre 2026 : 500 F par élève et par année scolaire, minimum de 40 000 F par établissement et par année ; un
 *   groupe paie la somme de ses établissements, chacun calculé à part (les valeurs viennent des paramètres datés de G5a) ;
 * - D-G5-10 A : chaque élève distinct compté une fois par établissement et par année ; à chaque date, seul le
 *   complément est facturé ; un départ ne réduit jamais le montant ;
 * - D-G5-2 (provisoire) et D-G5-3 A : la première année, part P1 du montant entier, minimum compris ; l'essai n'est
 *   jamais payé ; les arrivées de la première année gardent la même part ;
 * - 13 novembre, D-G5-13 B, D-G5-15 A : le montant ne baisse que par l'exclusion validée d'une inscription erronée ;
 *   après un document émis, un avoir validé par le Super Admin ; au minimum, rien ne change ; aucun remboursement
 *   automatique ; D-G5-14 A : une telle exclusion se demande au plus tard 30 jours après le document concerné.
 *
 * Ce qui attend encore une réponse reste fermé : le calcul répond « en attente de la décision » au lieu de choisir à la
 * place de Dankou (D-G5-4, D-G5-29, D-G5-31, D-G5-32, arrondi d'une part, tarif changé en cours d'année). Montants en
 * unités entières de la monnaie de l'établissement (francs CFA).
 */

// ---------------------------------------------------------------- Décisions encore ouvertes

export type OpenDecision = 'D-G5-4' | 'D-G5-29' | 'D-G5-31' | 'D-G5-32' | 'ARRONDI' | 'TARIF';

export const OPEN_DECISIONS: Record<OpenDecision, string> = {
  'D-G5-4': 'décision D-G5-4 (comptage initial de la première année)',
  'D-G5-29': 'décision D-G5-29 (première année d’un établissement)',
  'D-G5-31': 'décision D-G5-31 (document d’un groupe dont les établissements sont facturés à des dates différentes)',
  'D-G5-32': 'décision D-G5-32 (élève transféré entre deux établissements du même groupe)',
  ARRONDI: 'décision sur l’arrondi d’une part au prorata',
  TARIF: 'décision sur un tarif changé en cours d’année',
};

/** Calcul fermé : aucun montant n'en sort tant que la décision n'est pas prise. */
export interface Closed {
  closed: true;
  decision: OpenDecision;
  message: string;
}

export const isClosed = (r: unknown): r is Closed => typeof r === 'object' && r !== null && (r as Closed).closed === true;

function close(decision: OpenDecision, detail: string): Closed {
  return { closed: true, decision, message: `En attente de la ${OPEN_DECISIONS[decision]} : ${detail}` };
}

/** Calcul fermé par une décision encore ouverte, avec le détail du cas (documents-rules). */
export const pendingDecision = close;

/**
 * Réponses de Dankou qui ouvrent un calcul fermé ; null tant qu'il n'a pas répondu. Seules y figurent les possibilités
 * déjà chiffrées dans ses documents. D-G5-4, le point 1 de D-G5-29, D-G5-31 et D-G5-32 n'ont pas de réglage : ils restent
 * fermés jusqu'à sa réponse, qui sera alors écrite et essayée.
 */
export interface AmountDecisions {
  /** D-G5-29, point 3 : P1 divise par les mois de l'année scolaire de l'établissement, ou toujours par 12 (variante). */
  firstYearDivisor: 'SCHOOL_MONTHS' | 'TWELVE' | null;
  /** Part qui ne tombe pas juste : au franc inférieur, en faveur de l'école (proposition du 13 novembre). */
  rounding: 'FLOOR' | null;
}

/** État au 19 novembre 2026 : aucune de ces réponses n'est arrivée. */
export const DECISIONS: AmountDecisions = { firstYearDivisor: null, rounding: null };

// ---------------------------------------------------------------- Contrôles des données

function whole(name: string, n: number, min: number) {
  if (!Number.isSafeInteger(n) || n < min) throw new Error(`${name} : nombre entier d'au moins ${min} attendu (reçu ${n})`);
}

function day(name: string, d: string) {
  if (!isDay(d)) throw new Error(`${name} : date AAAA-MM-JJ attendue (reçu ${d})`);
}

export interface SchoolYear {
  label: string;
  startDate: string;
  endDate: string;
}

function checkYear(y: SchoolYear) {
  day('Début de l’année', y.startDate);
  day('Fin de l’année', y.endDate);
  if (y.endDate <= y.startDate) throw new Error(`Année ${y.label} : la fin doit suivre le début`);
}

// ---------------------------------------------------------------- Tarif

/** Prix par élève et minimum d'un établissement pour une année scolaire. */
export interface Tariff {
  pricePerPupil: number;
  minimum: number;
}

function checkTariff(t: Tariff) {
  whole('Prix par élève', t.pricePerPupil, 1);
  whole('Minimum annuel', t.minimum, 0);
}

const sameTariff = (a: Tariff, b: Tariff) => a.pricePerPupil === b.pricePerPupil && a.minimum === b.minimum;

/**
 * Tarif d'un document : celui en vigueur à sa date. Pour un document qui suit le premier de la même année, si ce tarif
 * a changé entre-temps, le calcul reste fermé : « l'année garde le tarif de sa première facture » n'est qu'une
 * proposition du 13 novembre (cas 24) ; seul est validé qu'un document émis garde ses prix.
 */
export function yearTariff(atFirstDocument: Tariff | null, inForce: Tariff): Tariff | Closed {
  checkTariff(inForce);
  if (!atFirstDocument || sameTariff(atFirstDocument, inForce)) return inForce;
  return close('TARIF', 'le prix par élève ou le minimum a changé depuis le premier document de l’année');
}

// ---------------------------------------------------------------- Part de la première année (P1)

/** Part d'une année : `months` mois payés sur `of`. */
export interface Share {
  months: number;
  of: number;
}

/**
 * Part P1 de la première année (D-G5-2, provisoire) : mois restants à partir du mois du premier jour payant, mois
 * commencé compris, divisés par les mois de l'année scolaire (de la rentrée à la fin, les deux comptés : 10 de septembre
 * à juin) ou par 12 (variante de D-G5-29, point 3). Une part ne dépasse jamais l'année entière : le prix vaut pour une
 * année scolaire (D-G5-29, point 4). Le premier jour payant doit tomber dans l'année : avant la rentrée ou après la fin,
 * c'est le point 1 de D-G5-29, fermé (billingLine).
 */
export function firstYearShare(firstPaidDay: string, year: SchoolYear, divisor: 'SCHOOL_MONTHS' | 'TWELVE'): Share {
  checkYear(year);
  day('Premier jour payant', firstPaidDay);
  if (firstPaidDay < year.startDate || firstPaidDay > year.endDate) throw new Error('Le premier jour payant doit tomber dans l’année scolaire');
  const of = divisor === 'SCHOOL_MONTHS' ? monthsSpanned(year.startDate, year.endDate) : 12;
  return { months: Math.min(monthsSpanned(firstPaidDay, year.endDate), of), of };
}

// ---------------------------------------------------------------- Montant de l'année

export interface YearAmount {
  /** Élèves facturables de l'année : chaque élève distinct une fois (cumul du comptage figé). */
  pupils: number;
  pricePerPupil: number;
  minimum: number;
  /** Le minimum l'emporte sur « élèves × prix ». */
  minimumApplied: boolean;
  /** Montant d'une année entière : MAX(élèves × prix ; minimum). */
  fullYear: number;
  /** Part de la première année ; null pour une année entière. */
  share: Share | null;
  /** Montant retenu pour l'année. */
  amount: number;
  /** La part ne tombait pas juste et le montant a été arrondi. */
  rounded: boolean;
}

/** Montant retenu pour une année : MAX(élèves × prix ; minimum), réduit par la part de la première année (D-G5-3 A). */
export function yearAmount(pupils: number, tariff: Tariff, share: Share | null, rounding: AmountDecisions['rounding']): YearAmount | Closed {
  whole('Élèves facturables', pupils, 0);
  checkTariff(tariff);
  if (share) {
    whole('Mois payés', share.months, 1);
    whole('Mois de l’année', share.of, 1);
    if (share.months > share.of) throw new Error('Une part ne dépasse jamais l’année entière');
  }
  const byPupils = pupils * tariff.pricePerPupil;
  const fullYear = Math.max(byPupils, tariff.minimum);
  const base = { pupils, pricePerPupil: tariff.pricePerPupil, minimum: tariff.minimum, minimumApplied: tariff.minimum > byPupils, fullYear, share };
  if (!share || share.months === share.of) return { ...base, amount: fullYear, rounded: false };
  const scaled = fullYear * share.months;
  if (scaled % share.of === 0) return { ...base, amount: scaled / share.of, rounded: false };
  if (rounding !== 'FLOOR') {
    return close('ARRONDI', `la part ${share.months}/${share.of} ne donne pas un montant entier`);
  }
  return { ...base, amount: Math.floor(scaled / share.of), rounded: true };
}

// ---------------------------------------------------------------- Ligne d'un document à une date

export interface LineInput {
  /** Comptage figé qui donne le document (G5b). */
  kind: CountKind;
  date: string;
  year: SchoolYear;
  /** Élèves facturables de l'année à cette date : cumul du comptage figé, exclusions validées retirées. */
  pupils: number;
  /** Même nombre au document précédent de l'année (0 pour le premier). */
  previousPupils: number;
  tariff: Tariff;
  /**
   * Première année payante de l'établissement : son premier jour payant (lendemain du dernier jour gratuit, essai ou
   * pilote). null pour une année entière (deuxième année et suivantes).
   */
  firstPaidDay: string | null;
  /** Déjà demandé pour cet établissement et cette année : documents émis, moins les avoirs validés. */
  alreadyBilled: number;
  /**
   * Part retenue par le premier document de la première année : les arrivées suivantes gardent la même part (D-G5-3 A),
   * même si les dates de l'année ont changé depuis. Absente pour le premier document.
   */
  keptShare?: Share | null;
}

export interface Line extends YearAmount {
  kind: CountKind;
  date: string;
  yearLabel: string;
  /** Écart d'élèves facturables avec le document précédent de l'année (négatif après une exclusion validée). */
  pupilsChange: number;
  alreadyBilled: number;
  /** À demander à cette date ; 0 donne un relevé à 0 F. */
  due: number;
  /**
   * Demandé au-delà du montant de l'année, après l'exclusion validée d'une inscription erronée : avoir que le Super
   * Admin peut valider (jamais automatique, aucun remboursement automatique). 0 au minimum.
   */
  creditToReview: number;
}

/**
 * Ligne d'un établissement à la date d'un comptage figé : montant retenu pour l'année, moins ce qui a déjà été demandé.
 * Un montant plus bas que le déjà demandé ne donne jamais de remboursement : il propose un avoir au Super Admin.
 */
export function billingLine(input: LineInput, decisions: AmountDecisions): Line | Closed {
  checkYear(input.year);
  day('Date du comptage', input.date);
  whole('Élèves facturables', input.pupils, 0);
  whole('Élèves du document précédent', input.previousPupils, 0);
  whole('Déjà demandé', input.alreadyBilled, 0);
  let share: Share | null = null;
  if (input.firstPaidDay) {
    day('Premier jour payant', input.firstPaidDay);
    if (input.firstPaidDay < input.year.startDate || input.firstPaidDay > input.year.endDate) {
      return close('D-G5-29', `premier jour payant, le ${frDay(input.firstPaidDay)}, hors de l’année scolaire ${input.year.label} (avant la rentrée ou après la fin)`);
    }
    if (input.kind === 'INITIAL') {
      return close('D-G5-4', `la période gratuite a fini avant le comptage initial du ${frDay(input.date)}`);
    }
    if (input.keptShare) {
      share = input.keptShare;
    } else if (!decisions.firstYearDivisor) {
      return close('D-G5-29', 'mois de l’année scolaire ou 12 mois pour la part de la première année');
    } else {
      share = firstYearShare(input.firstPaidDay, input.year, decisions.firstYearDivisor);
    }
  }
  const y = yearAmount(input.pupils, input.tariff, share, decisions.rounding);
  if (isClosed(y)) return y;
  const difference = y.amount - input.alreadyBilled;
  return {
    ...y, kind: input.kind, date: input.date, yearLabel: input.year.label, pupilsChange: input.pupils - input.previousPupils,
    alreadyBilled: input.alreadyBilled, due: Math.max(0, difference), creditToReview: Math.max(0, -difference),
  };
}

// ---------------------------------------------------------------- Comptages qui donnent un document

export const FREE_END_KINDS: CountKind[] = ['TRIAL_END', 'PILOT_END'];

/** Premier jour payant : le lendemain du dernier jour gratuit (fin de l'essai ou du pilote). */
export const firstPaidDayAfter = (lastFreeDay: string) => addDays(lastFreeDay, 1);

/** D-G5-30 A (19 novembre 2026) : 15 jours de grâce, accès complet, après la fin de la gratuité. */
export const GRACE_DAYS = 15;

/**
 * Échéance du premier document, celui de la fin de la gratuité : le dernier jour de grâce (D-G5-30 A). Un document émis
 * plus tard (conditions acceptées après la grâce) est à régler dès son émission. Les compléments n'ont pas d'échéance
 * décidée : null. Depuis le lot G5d-1, le délai de grâce est fixé dans l'abonnement à la fin de la gratuité (paramètre
 * daté) : c'est lui qui compte quand il est connu, 15 jours sinon.
 */
export function firstDueDate(lastFreeDay: string, issueDay: string, graceEnd: string | null = null) {
  day('Dernier jour gratuit', lastFreeDay);
  day('Date du document', issueDay);
  if (graceEnd) day('Fin du délai de grâce', graceEnd);
  const end = graceEnd ?? addDays(lastFreeDay, GRACE_DAYS);
  return end < issueDay ? issueDay : end;
}

/**
 * Comptages figés qui donnent un document, du plus ancien au plus récent : celui de la fin de la dernière période
 * gratuite (la première facture, le lendemain), puis ceux du calendrier datés après elle. Un comptage de fin d'essai
 * suivi d'un pilote ne donne rien : une période gratuite n'est jamais facturée.
 */
export function billableCounts<T extends { kind: CountKind; stage: string; date: string }>(counts: T[], lastFreeDay: string | null): T[] {
  return counts
    .filter((c) => c.stage === 'FROZEN')
    .filter((c) => (FREE_END_KINDS.includes(c.kind) ? c.date === lastFreeDay : !lastFreeDay || c.date > lastFreeDay))
    .sort((a, b) => a.date.localeCompare(b.date) || COUNT_KINDS.indexOf(a.kind) - COUNT_KINDS.indexOf(b.kind));
}

// ---------------------------------------------------------------- Suite des documents d'une année

export interface YearStep {
  kind: CountKind;
  date: string;
  pupils: number;
  /** Tarif en vigueur à la date du comptage. */
  tariff: Tariff;
}

/**
 * Documents d'un établissement sur une année, dans l'ordre de ses comptages figés : chaque ligne déduit ce que les
 * précédentes ont demandé, moins les avoirs validés (`credits`). S'arrête au premier calcul fermé : les dates suivantes
 * en dépendent.
 */
export function simulateYear(year: SchoolYear, firstPaidDay: string | null, steps: YearStep[], decisions: AmountDecisions, credits = 0): (Line | Closed)[] {
  whole('Avoirs validés', credits, 0);
  const out: (Line | Closed)[] = [];
  let billed = 0;
  let previousPupils = 0;
  let firstTariff: Tariff | null = null;
  for (const s of [...steps].sort((a, b) => a.date.localeCompare(b.date) || COUNT_KINDS.indexOf(a.kind) - COUNT_KINDS.indexOf(b.kind))) {
    const tariff = yearTariff(firstTariff, s.tariff);
    const line = isClosed(tariff) ? tariff : billingLine({
      kind: s.kind, date: s.date, year, pupils: s.pupils, previousPupils, tariff, firstPaidDay, alreadyBilled: Math.max(0, billed - credits),
    }, decisions);
    out.push(line);
    if (isClosed(line)) break;
    firstTariff ??= s.tariff;
    billed += line.due;
    previousPupils = s.pupils;
  }
  return out;
}

// ---------------------------------------------------------------- Groupe

export interface GroupDocument {
  date: string;
  /** Somme des lignes : ce que le groupe doit à cette date. */
  total: number;
  lines: { establishment: string; line: Line }[];
}

/**
 * Document d'un groupe à une date : une ligne par établissement, chacun calculé à part, minimum compris, et le total
 * (11 novembre 2026). Si un établissement est fermé, le document l'est aussi. Des établissements facturés à des dates
 * différentes relèvent de D-G5-31 : fermé.
 */
export function groupDocument(lines: { establishment: string; line: Line | Closed }[]): GroupDocument | Closed {
  if (!lines.length) throw new Error('Un document de groupe a au moins un établissement');
  for (const l of lines) if (isClosed(l.line)) return l.line;
  const open = lines as { establishment: string; line: Line }[];
  const dates = [...new Set(open.map((l) => l.line.date))].sort();
  if (dates.length > 1) return close('D-G5-31', `établissements facturés le ${dates.map(frDay).join(', le ')}`);
  return { date: dates[0], total: open.reduce((sum, l) => sum + l.line.due, 0), lines: open };
}

/**
 * Groupe de plusieurs établissements : un élève transféré de l'un à l'autre dans l'année serait compté dans chacun (une
 * fois par établissement). Cahiora ne voit pas les transferts (les noms restent dans les écoles) et D-G5-32 n'est pas
 * tranché : le document du groupe reste fermé. Une école indépendante (groupe d'un seul établissement) n'est pas concernée.
 */
export function groupTransfers(establishments: number): Closed | null {
  if (establishments < 2) return null;
  return close('D-G5-32', `groupe de ${establishments} établissements : un élève transféré de l’un à l’autre serait compté dans chacun`);
}

// ---------------------------------------------------------------- Exclusion après un document

/** D-G5-14 A : une exclusion qui touche un document émis se demande au plus tard 30 jours après lui. */
export const EXCLUSION_DAYS_AFTER_DOCUMENT = 30;

/** Dernier jour pour demander une exclusion qui touche un document émis le jour `documentDay` (ce jour compris). */
export function exclusionDeadline(documentDay: string) {
  day('Date du document', documentDay);
  return addDays(documentDay, EXCLUSION_DAYS_AFTER_DOCUMENT);
}

export const exclusionOpen = (documentDay: string, today: string) => today <= exclusionDeadline(documentDay);
