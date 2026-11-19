import {
  AmountDecisions, billableCounts, billingLine, Closed, FREE_END_KINDS, firstPaidDayAfter, groupDocument, groupTransfers, isClosed, Line, LineInput,
  pendingDecision, SchoolYear, Tariff, yearAmount, YearAmount, yearTariff,
} from './amounts-rules';
import { frDay } from './billing-rules';
import { COUNT_KIND_LABELS, CountKind } from './counts-rules';

/**
 * Prochain document de l'abonnement d'un client (lot G5c, étape 2), sans accès à la base : pour chaque établissement,
 * le plus ancien comptage figé qui n'a pas encore son document, calculé par amounts-rules avec ce que les documents
 * déjà émis ont demandé ; puis le document du groupe. Un calcul fermé bloque les dates suivantes de l'établissement :
 * elles en dépendent. La base refait chaque contrôle à l'émission (issue_billing_document).
 */

/** Comptage figé vu par les documents : des nombres, jamais un nom. */
export interface CountFact {
  id: string;
  kind: CountKind;
  stage: string;
  date: string;
  yearLabel: string;
  /**
   * Élèves facturables de l'année à cette date : cumul du comptage figé, moins les exclusions validées depuis (la base
   * le calcule, billing_counts_billable ; le comptage figé lui-même ne change jamais).
   */
  cumulative: number;
}

/** Ligne déjà émise pour l'établissement : abonnement ou avoir. */
export interface LineFact {
  id?: string;
  documentId?: string;
  documentKind: 'SUBSCRIPTION' | 'CREDIT_NOTE';
  yearLabel: string;
  countId: string | null;
  referenceDate: string | null;
  amount: number;
  pupils: number | null;
  pricePerPupil: number | null;
  minimum: number | null;
  shareMonths: number | null;
  shareOf: number | null;
  createdAt: Date;
}

export interface EstablishmentFacts {
  tenantId: string;
  name: string;
  /** Tarif figé à l'acceptation des conditions commerciales (lot G5a) ; null tant qu'elles ne sont pas acceptées. */
  tariff: Tariff | null;
  /** Dernier jour gratuit (fin de l'essai ou du pilote). */
  lastFreeDay: string | null;
  counts: CountFact[];
  lines: LineFact[];
  /** Dates de chaque année scolaire : calendrier de facturation, sinon année scolaire de l'école. */
  years: Record<string, SchoolYear>;
}

export type NextLine =
  | { state: 'NOT_CLIENT' | 'NOTHING' | 'WAITING' | 'MISSING'; message: string }
  | {
    state: 'READY';
    count: CountFact;
    input: LineInput;
    line: Line | Closed;
    /** Document de la fin de la gratuité (première facture) : son échéance suit le délai de grâce. */
    first: boolean;
  };

const byDate = (a: LineFact, b: LineFact) => (a.referenceDate ?? '').localeCompare(b.referenceDate ?? '') || a.createdAt.getTime() - b.createdAt.getTime();
const total = (rows: LineFact[]) => rows.reduce((s, l) => s + l.amount, 0);
/** Élèves du dernier document de l'année, abonnement ou avoir (un avoir suit la ligne qu'il touche). */
const previousPupils = (ofYear: LineFact[]) => [...ofYear].sort(byDate).at(-1)?.pupils ?? 0;

/** Prochaine ligne d'abonnement d'un établissement, ou la raison pour laquelle il n'y en a pas. */
export function nextLine(e: EstablishmentFacts, decisions: AmountDecisions): NextLine {
  if (!e.tariff) return { state: 'NOT_CLIENT', message: 'Conditions commerciales pas encore acceptées : aucun document' };
  if (!e.lastFreeDay) return { state: 'MISSING', message: 'INFORMATION MANQUANTE : fin de la période gratuite introuvable' };
  const billable = billableCounts(e.counts, e.lastFreeDay);
  const freeEnd = billable.find((c) => FREE_END_KINDS.includes(c.kind));
  if (!freeEnd) return { state: 'WAITING', message: `Comptage de la fin de la période gratuite (${frDay(e.lastFreeDay)}) pas encore fait` };
  const billed = new Set(e.lines.map((l) => l.countId).filter((id): id is string => !!id));
  const next = billable.find((c) => !billed.has(c.id));
  if (!next) return { state: 'NOTHING', message: 'Aucun comptage figé sans document' };
  const year = e.years[next.yearLabel];
  if (!year) return { state: 'MISSING', message: `INFORMATION MANQUANTE : dates de l’année scolaire ${next.yearLabel}` };
  // La première année payante est celle du comptage de la fin de la gratuité ; les suivantes sont entières.
  const firstPaidDay = next.yearLabel === freeEnd.yearLabel ? firstPaidDayAfter(e.lastFreeDay) : null;
  const ofYear = e.lines.filter((l) => l.yearLabel === next.yearLabel);
  const subscription = ofYear.filter((l) => l.documentKind === 'SUBSCRIPTION').sort(byDate);
  const credits = ofYear.filter((l) => l.documentKind === 'CREDIT_NOTE');
  const firstOfYear = subscription[0];
  const tariff = yearTariff(firstOfYear ? { pricePerPupil: firstOfYear.pricePerPupil!, minimum: firstOfYear.minimum! } : null, e.tariff);
  const input: LineInput = {
    kind: next.kind, date: next.date, year, pupils: next.cumulative, previousPupils: previousPupils(ofYear),
    tariff: isClosed(tariff) ? e.tariff : tariff, firstPaidDay, alreadyBilled: total(subscription) - total(credits),
    keptShare: firstPaidDay && firstOfYear?.shareMonths && firstOfYear.shareOf ? { months: firstOfYear.shareMonths, of: firstOfYear.shareOf } : null,
  };
  return { state: 'READY', count: next, input, line: isClosed(tariff) ? tariff : billingLine(input, decisions), first: next.id === freeEnd.id };
}

export interface PlannedEstablishment {
  tenantId: string;
  name: string;
  next: NextLine;
}

export type GroupPlan =
  | { state: 'NOTHING'; establishments: PlannedEstablishment[] }
  | { state: 'CLOSED'; closed: Closed; establishments: PlannedEstablishment[] }
  | {
    state: 'READY';
    date: string;
    yearLabel: string;
    total: number;
    first: boolean;
    lines: { tenantId: string; name: string; count: CountFact; line: Line }[];
    establishments: PlannedEstablishment[];
  };

const ready = (p: PlannedEstablishment): p is PlannedEstablishment & { next: Extract<NextLine, { state: 'READY' }> } => p.next.state === 'READY';

/**
 * Document du groupe : une ligne par établissement, à la même date (11 novembre 2026). Un établissement fermé ferme le
 * document ; des établissements sans document à la même date relèvent de D-G5-31 ; un groupe de plusieurs
 * établissements attend aussi D-G5-32 (amounts-rules, groupTransfers). Une école indépendante est un groupe d'un seul
 * établissement.
 */
export function groupPlan(establishments: PlannedEstablishment[]): GroupPlan {
  const lines = establishments.filter(ready);
  if (!lines.length) return { state: 'NOTHING', establishments };
  for (const l of lines) if (isClosed(l.next.line)) return { state: 'CLOSED', closed: l.next.line, establishments };
  const dates = [...new Set(lines.map((l) => l.next.count.date))].sort();
  if (lines.length < establishments.length || dates.length > 1) {
    const detail = establishments
      .map((e) => (ready(e) ? `${e.name} le ${frDay(e.next.count.date)}` : `${e.name} : rien à cette date`))
      .join(' ; ');
    return { state: 'CLOSED', closed: pendingDecision('D-G5-31', `établissements du groupe facturés à des dates différentes (${detail})`), establishments };
  }
  const doc = groupDocument(lines.map((l) => ({ establishment: l.name, line: l.next.line })));
  if (isClosed(doc)) return { state: 'CLOSED', closed: doc, establishments };
  const transfers = groupTransfers(establishments.length);
  if (transfers) return { state: 'CLOSED', closed: transfers, establishments };
  const years = [...new Set(lines.map((l) => l.next.count.yearLabel))];
  if (years.length > 1) throw new Error('Un document d’abonnement porte sur une seule année scolaire');
  return {
    state: 'READY', date: doc.date, yearLabel: years[0], total: doc.total, first: lines.some((l) => l.next.first),
    lines: lines.map((l) => ({ tenantId: l.tenantId, name: l.name, count: l.next.count, line: l.next.line as Line })), establishments,
  };
}

/** Libellé d'une ligne d'abonnement : l'établissement et la date du comptage. */
export const subscriptionLineLabel = (establishment: string, kind: CountKind, date: string) => `${establishment} · ${COUNT_KIND_LABELS[kind]} du ${frDay(date)}`;

// ---------------------------------------------------------------- Avoir après une exclusion

/** Ce qu'il faut pour l'avoir d'un établissement et d'une année. */
export interface CreditInput {
  /** Ligne touchée : celle de l'établissement dans son dernier document d'abonnement de l'année (prix, minimum, part). */
  related: { pricePerPupil: number; minimum: number; shareMonths: number | null; shareOf: number | null };
  /** Élèves facturables du comptage de cette ligne, l'exclusion validée retirée. */
  pupils: number;
  /** Élèves du dernier document ou avoir de l'année. */
  previousPupils: number;
  /** Déjà demandé pour l'établissement et l'année : documents émis, moins les avoirs. */
  alreadyBilled: number;
}

export type CreditPlan =
  | { state: 'NONE'; message: string; year: YearAmount }
  | { state: 'CLOSED'; closed: Closed }
  | { state: 'READY'; year: YearAmount; pupilsChange: number; alreadyBilled: number; amount: number };

/**
 * Avoir après l'exclusion validée d'une inscription erronée qui touche un document émis (règle du 13 novembre 2026,
 * D-G5-13 B) : déjà demandé moins le montant de l'année recalculé sans l'élève, avec les prix et la part du dernier
 * document de l'année. Au minimum, rien ne change : aucun avoir. Jamais un remboursement : l'avoir réduit ce qui est
 * dû (son imputation viendra avec les paiements, lot G5d). La base refait ce calcul (issue_billing_document).
 */
export function creditLine(input: CreditInput, decisions: AmountDecisions): CreditPlan {
  const { related } = input;
  const share = related.shareMonths && related.shareOf ? { months: related.shareMonths, of: related.shareOf } : null;
  const year = yearAmount(input.pupils, { pricePerPupil: related.pricePerPupil, minimum: related.minimum }, share, decisions.rounding);
  if (isClosed(year)) return { state: 'CLOSED', closed: year };
  const amount = input.alreadyBilled - year.amount;
  if (amount <= 0) {
    return {
      state: 'NONE', year,
      message: year.minimumApplied ? 'Au minimum annuel, rien ne change : aucun avoir' : 'Rien n’a été demandé en plus pour cet élève : aucun avoir',
    };
  }
  return { state: 'READY', year, pupilsChange: input.pupils - input.previousPupils, alreadyBilled: input.alreadyBilled, amount };
}

/** Libellé d'une ligne d'avoir : l'établissement et le comptage du document touché. */
export const creditLineLabel = (establishment: string, kind: CountKind, date: string) =>
  `${establishment} · Avoir après exclusion d’une inscription erronée (${COUNT_KIND_LABELS[kind].toLowerCase()} du ${frDay(date)})`;
