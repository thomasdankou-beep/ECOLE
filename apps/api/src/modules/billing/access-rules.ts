import { addDays, daysBetween, daysLeft, frDay, isDay, STATUS_LABELS, SubscriptionStatus } from './billing-rules';

/**
 * Accès selon le paiement de l'abonnement (lot G5d-1), sans accès à la base. Décisions de Dankou du 19 novembre 2026 :
 * - D-G5-30 A : essai de 14 jours, rappels les 11e, 13e et 14e jours ; puis 15 jours de grâce en accès complet, avec une
 *   alerte à chaque connexion de la direction, un bandeau permanent et un compteur des jours ; ensuite, sans paiement
 *   validé, accès limité : consultation, impression, export, caisse scolaire et régularisation, aucune autre saisie,
 *   aucune suppression. Le bouton « Régulariser mon abonnement » ouvre la page de l'abonnement. Les dates des pilotes et
 *   les gratuités exceptionnelles sont respectées : la grâce commence le lendemain du dernier jour gratuit.
 * - D-G5-41 A : un renouvellement impayé suit la même règle, avec des rappels avant l'échéance et pendant la grâce.
 * - D-G5-42 A : une demande de régularisation qui attend la réponse de Cahiora, quand aucun moyen de paiement n'est
 *   activé, empêche la limitation automatique.
 * - D-G5-43 A : un paiement partiel laisse l'accès limité, sauf prolongation exceptionnelle avec une date de fin
 *   obligatoire et un motif.
 * Précisions du même jour : chaque demande est horodatée et journalisée ; pendant l'accès complet, les alertes ne
 * gênent pas le travail. Le paiement validé (retour à l'accès complet) et les moyens de paiement arrivent avec le lot
 * G5d-2, fermé tant que D-G5-33 et la validation juridique et fiscale manquent. Les dates sont des jours du
 * calendrier de l'établissement (AAAA-MM-JJ).
 * Lectures 7 A et 9 A, validées par Dankou le 20 novembre 2026 :
 * - jamais moins de 48 heures (paramètre daté NOTICE_HOURS) entre la réponse de Cahiora à une demande de régularisation
 *   et la limitation : l'accès reste complet pendant ce préavis, donné une seule fois par échéance (une nouvelle demande
 *   puis sa réponse n'en ouvrent pas un second) ; la direction lit le jour et l'heure de la limitation ;
 * - chaque prolongation exceptionnelle dure 30 jours au plus (paramètre daté EXTENSION_MAX_DAYS), comptés depuis la fin
 *   de l'accès complet en cours, ou depuis aujourd'hui si elle est passée ; une nouvelle prolongation pour la même
 *   échéance est un renouvellement exceptionnel, avec son propre motif, marqué au journal ; le garde-fou d'un an reste.
 */

/** Rappels avant une fin : 3 jours avant, la veille et le jour même (11e, 13e et 14e jours d'un essai de 14 jours). */
export const REMINDER_DAYS_BEFORE = [3, 1, 0] as const;

/**
 * Rappel dû aujourd'hui avant `lastDay` (dernier jour compris) : le plus récent dont la date est arrivée, ou null. Un
 * passage en retard n'envoie que celui-là, jamais plusieurs rappels d'un coup ; chacun ne part qu'une fois (clé de la
 * tâche planifiée).
 */
export function dueReminder(today: string, lastDay: string): number | null {
  if (today > lastDay) return null;
  const left = daysBetween(today, lastDay);
  const started = REMINDER_DAYS_BEFORE.filter((n) => n >= left);
  return started.length ? Math.min(...started) : null;
}

/** Délai de grâce après le dernier jour gratuit : du lendemain au N-ième jour (15 : jours 15 à 29 d'un essai de 14 jours). */
export function graceWindow(lastFreeDay: string, graceDays: number) {
  return { graceStart: addDays(lastFreeDay, 1), graceEnd: addDays(lastFreeDay, graceDays) };
}

/** Moyens de paiement activés par Cahiora : aucun avant le lot G5d-2 et la réponse à D-G5-33. */
export const PAYMENT_MEANS_ACTIVE = false;

export const AWAITING_STATUSES: SubscriptionStatus[] = ['AWAITING_ACCEPTANCE', 'AWAITING_PAYMENT'];

/** Statut rendu quand la limitation est levée : en attente d'acceptation tant que les conditions ne sont pas acceptées. */
export const restoredStatus = (acceptedAt: unknown): SubscriptionStatus => (acceptedAt ? 'AWAITING_PAYMENT' : 'AWAITING_ACCEPTANCE');

export interface AccessState {
  status: SubscriptionStatus;
  /** Dernier jour du délai de grâce (null : fin de gratuité antérieure au lot G5d, sans délai connu). */
  graceEnd: string | null;
  /** Dernier jour d'une prolongation exceptionnelle de Cahiora. */
  extendedUntil: string | null;
  /** Demande de régularisation en attente de la réponse de Cahiora. */
  pendingRequest: boolean;
  /** Au moins un moyen de paiement activé par Cahiora. */
  paymentMeansActive: boolean;
  /**
   * Préavis donné après une réponse de Cahiora pour l'échéance en cours (lecture 7 A) : sa fin, et le jour de
   * l'établissement où elle tombe. null sans préavis, ou pour une autre échéance.
   */
  notice: { until: Date; lastDay: string } | null;
}

/**
 * - FREE : essai ou pilote ; ACTIVE : abonnement payé ; LIMITED : accès limité (posé par la tâche planifiée) ;
 * - GRACE : délai de grâce en cours ; EXTENDED : prolongation de Cahiora en cours (accès complet dans les deux cas) ;
 * - NOTICE : préavis après la réponse de Cahiora (lecture 7 A), qui finit après le délai ou la prolongation : accès
 *   complet jusqu'à son heure de fin ;
 * - HELD : délai passé, mais une demande de régularisation attend Cahiora sans moyen de paiement activé (D-G5-42 A) ;
 * - DUE : délai passé et rien ne retient la limitation : la tâche planifiée la pose à son prochain passage ;
 * - WAITING : en attente sans délai connu (gratuité finie avant le lot G5d) : jamais limité automatiquement.
 */
export type AccessPhase = 'FREE' | 'ACTIVE' | 'GRACE' | 'EXTENDED' | 'NOTICE' | 'HELD' | 'DUE' | 'LIMITED' | 'WAITING';

export interface AccessView {
  phase: AccessPhase;
  /** Dernier jour d'accès complet assuré (grâce, prolongation, ou jour de la fin du préavis). */
  until: string | null;
  /** Jours d'accès complet restants, aujourd'hui compris (le compteur du bandeau). */
  daysLeft: number | null;
  /** Premier jour de l'accès limité si rien ne change. */
  limitedFrom: string | null;
  /** Préavis en cours : instant de sa fin (ISO), à partir duquel la limitation peut être posée. */
  limitedAt: string | null;
  /** Préavis en cours : heures d'accès complet restantes, heure entamée comprise (le compteur du bandeau). */
  hoursLeft: number | null;
}

const HOUR_MS = 3_600_000;

const none = (phase: AccessPhase, limitedFrom: string | null = null): AccessView => ({ phase, until: null, daysLeft: null, limitedFrom, limitedAt: null, hoursLeft: null });

/**
 * Phase d'accès d'un abonnement un jour donné (jour de l'établissement) ; `now`, l'instant de ce jour, ne compte que
 * pour un préavis (par défaut, midi UTC de ce jour). Un préavis prime sur le délai ou la prolongation qu'il dépasse ;
 * une prolongation plus longue que lui prime sur lui.
 */
export function accessPhase(a: AccessState, today: string, now: Date = new Date(`${today}T12:00:00.000Z`)): AccessView {
  if (a.status === 'TRIAL' || a.status === 'PILOT') return none('FREE');
  if (a.status === 'ACTIVE') return none('ACTIVE');
  if (a.status === 'LIMITED') return none('LIMITED');
  const ends = [a.graceEnd, a.extendedUntil].filter((x): x is string => !!x && x >= today).sort();
  const until = ends.at(-1) ?? null;
  const notice = a.notice && a.notice.until > now ? a.notice : null;
  if (notice && (!until || notice.lastDay > until)) {
    return {
      phase: 'NOTICE', until: notice.lastDay, daysLeft: daysLeft(today, notice.lastDay), limitedFrom: notice.lastDay, limitedAt: notice.until.toISOString(),
      hoursLeft: Math.max(1, Math.ceil((notice.until.getTime() - now.getTime()) / HOUR_MS)),
    };
  }
  if (until) {
    const extended = !!a.extendedUntil && a.extendedUntil === until && (!a.graceEnd || a.extendedUntil > a.graceEnd);
    return { phase: extended ? 'EXTENDED' : 'GRACE', until, daysLeft: daysLeft(today, until), limitedFrom: addDays(until, 1), limitedAt: null, hoursLeft: null };
  }
  if (a.pendingRequest && !a.paymentMeansActive) return none('HELD');
  if (a.graceEnd || a.extendedUntil) return none('DUE', today);
  return none('WAITING');
}

/** La limitation est due aujourd'hui : la tâche planifiée la pose. */
export const limitationDue = (a: AccessState, today: string) => accessPhase(a, today).phase === 'DUE';

// ---------------------------------------------------------------- Préavis après la réponse (lecture 7 A)

/**
 * Ce que change la réponse de Cahiora à une demande de régularisation, l'instant où elle part. `view` est l'accès tel
 * qu'il sera une fois la demande répondue (sans demande en attente) ; `limitStart(jour)`, l'instant où ce jour commence
 * pour l'établissement. Sans préavis déjà donné pour l'échéance et quand la limitation tomberait moins de `hours`
 * heures après la réponse, un préavis s'ouvre : la limitation ne tombe pas avant `hours` heures.
 * - none : aucune limitation prévue (gratuité, abonnement actif, accès déjà limité, attente sans délai connu) ;
 * - scheduled : la limitation reste à sa date, plus de `hours` heures après la réponse ;
 * - notice : préavis ouvert par cette réponse ;
 * - notice-running : un préavis déjà donné pour cette échéance court encore : il n'est pas renouvelé ;
 * - now : délai passé et préavis déjà donné (ou préavis à 0) : limitation au prochain passage de la tâche planifiée.
 */
export interface AnswerOutcome {
  kind: 'none' | 'scheduled' | 'notice' | 'notice-running' | 'now';
  /** Instant à partir duquel la limitation peut être posée ; null : aucune prévue (none) ou dans l'heure (now). */
  limitedAt: Date | null;
  /** Durée du préavis ouvert par cette réponse (notice). */
  hours: number | null;
  /** Un préavis avait déjà été donné pour cette échéance avant la réponse. */
  noticeGiven: boolean;
}

export function answerOutcome(view: AccessView, now: Date, hours: number | null, noticeGiven: boolean, limitStart: (day: string) => Date): AnswerOutcome {
  const out = (kind: AnswerOutcome['kind'], limitedAt: Date | null = null, h: number | null = null): AnswerOutcome => ({ kind, limitedAt, hours: h, noticeGiven });
  let at: Date;
  if (view.phase === 'GRACE' || view.phase === 'EXTENDED') at = limitStart(view.limitedFrom!);
  else if (view.phase === 'NOTICE') at = new Date(view.limitedAt!);
  else if (view.phase === 'DUE' || view.phase === 'HELD') at = now;
  else return out('none');
  if (hours && hours > 0 && !noticeGiven && at.getTime() < now.getTime() + hours * HOUR_MS) return out('notice', new Date(now.getTime() + hours * HOUR_MS), hours);
  if (at <= now) return out('now');
  return out(view.phase === 'NOTICE' ? 'notice-running' : 'scheduled', at);
}

/** Rappel du préavis : dans ses dernières 24 heures (le dernier jour d'un préavis de 48 heures), une seule fois. */
export const noticeReminderDue = (noticeUntil: Date, now: Date) => now < noticeUntil && noticeUntil.getTime() - now.getTime() <= 24 * HOUR_MS;

/** Instant où un jour (AAAA-MM-JJ) commence dans le fuseau de l'établissement. */
export function dayStart(day: string, timezone: string): Date {
  const utc = Date.parse(`${day}T00:00:00.000Z`);
  // Décalage du fuseau à un instant donné : heure lue sur place moins heure UTC.
  const offset = (t: number) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
        .formatToParts(new Date(t)).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]),
    );
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t;
  };
  const first = utc - offset(utc);
  return new Date(utc - offset(first));
}

/** « 3 décembre 2026 à 14 h 05 », à l'heure de l'établissement. */
export function frDateTime(at: Date, timezone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(at).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]),
  );
  return `${frDay(`${p.year}-${p.month}-${p.day}`)} à ${Number(p.hour)} h ${p.minute}`;
}

/** Phrase de la réponse de Cahiora sur la limitation, pour la direction ; vide si aucune limitation n'est prévue. */
export function answerOutcomeText(o: AnswerOutcome, timezone: string) {
  const keeps = ` En accès limité, ${LIMITED_KEEPS}.`;
  const at = o.limitedAt ? frDateTime(o.limitedAt, timezone) : '';
  switch (o.kind) {
    case 'notice':
      return `Sans paiement validé, l’accès sera limité à partir du ${at} : Cahiora vous laisse un préavis de ${o.hours} heures après cette réponse.${keeps}`;
    case 'scheduled':
      return `Sans paiement validé, l’accès sera limité à partir du ${at}.${keeps}`;
    case 'notice-running':
      return `Sans paiement validé, l’accès sera limité à partir du ${at}, à la fin du préavis déjà donné pour cette échéance.${keeps}`;
    case 'now':
      return `${o.noticeGiven ? 'Le préavis de cette échéance a déjà été donné' : 'Le délai d’accès complet est passé'} : sans paiement validé, l’accès sera limité dans l’heure.${keeps}`;
    default:
      return '';
  }
}

// ---------------------------------------------------------------- Prolongations (D-G5-43 A, lecture 9 A)

/**
 * Prolongation de l'échéance en cours (renouvelable) : une prolongation déjà donnée qui dépasse le délai de grâce
 * actuel. Une date antérieure appartient à une échéance passée.
 */
export const currentExtension = (graceEnd: string | null, extendedUntil: string | null) => (extendedUntil && (!graceEnd || extendedUntil > graceEnd) ? extendedUntil : null);

/**
 * Nature d'une prolongation : la première pour l'échéance, un renouvellement exceptionnel (nouvelle date plus tardive
 * qu'une prolongation déjà donnée pour la même échéance), ou une prolongation raccourcie (jamais un renouvellement).
 */
export function extensionKind(until: string, graceEnd: string | null, extendedUntil: string | null): 'first' | 'renewal' | 'shortened' {
  const current = currentExtension(graceEnd, extendedUntil);
  if (!current) return 'first';
  return until > current ? 'renewal' : 'shortened';
}

/**
 * Dernier jour possible d'une prolongation (lecture 9 A) : `maxDays` jours après la fin de l'accès complet en cours (fin
 * du délai de grâce ou de la prolongation), ou après aujourd'hui si elle est passée ; jamais plus d'un an après
 * aujourd'hui. Sans durée en vigueur (`maxDays` null), seul le garde-fou d'un an compte.
 */
export function extensionMaxUntil(today: string, graceEnd: string | null, extendedUntil: string | null, maxDays: number | null) {
  const guard = addDays(today, 366);
  if (!maxDays) return guard;
  const base = [today, graceEnd, currentExtension(graceEnd, extendedUntil)].filter((x): x is string => !!x).sort().at(-1)!;
  const max = addDays(base, maxDays);
  return max < guard ? max : guard;
}

/**
 * Erreur d'une prolongation exceptionnelle (D-G5-43 A, lecture 9 A), ou null. Elle se donne à un abonnement en attente
 * ou en accès limité, avec une date de fin à partir d'aujourd'hui et au-delà du délai de grâce, au plus un an plus tard
 * (garde-fou contre une faute de frappe) ; elle dure `maxDays` jours au plus depuis la fin de l'accès complet en cours,
 * renouvellement compris. Raccourcir une prolongation reste possible. Le motif est contrôlé à part.
 */
export function extensionError(
  status: SubscriptionStatus, until: string, today: string, graceEnd: string | null, extendedUntil: string | null = null, maxDays: number | null = null,
): string | null {
  if (!AWAITING_STATUSES.includes(status) && status !== 'LIMITED') {
    return `Une prolongation se donne à un abonnement en attente ou en accès limité (état actuel : ${STATUS_LABELS[status]})`;
  }
  if (!isDay(until)) return 'Date de fin : date invalide';
  if (until < today) return 'La date de fin ne peut pas être passée';
  if (graceEnd && until <= graceEnd) return `Le délai de grâce court déjà jusqu’au ${frDay(graceEnd)} : choisissez une date de fin plus tardive`;
  if (daysBetween(today, until) > 366) return 'Date de fin : au plus un an après aujourd’hui';
  if (extensionKind(until, graceEnd, extendedUntil) !== 'shortened') {
    const max = extensionMaxUntil(today, graceEnd, extendedUntil, maxDays);
    if (until > max) {
      return `Une prolongation dure ${maxDays} jours au plus, renouvellement compris, depuis la fin de l’accès complet en cours : choisissez au plus tard le ${frDay(max)}`;
    }
  }
  return null;
}

/** Erreur d'une demande de régularisation de la direction, ou null : abonnement en attente ou limité, une seule à la fois. */
export function requestError(status: SubscriptionStatus | null, pending: boolean): string | null {
  if (!status) return 'Aucun abonnement n’est encore ouvert pour votre établissement';
  if (!AWAITING_STATUSES.includes(status) && status !== 'LIMITED') return `Votre abonnement n’attend pas de régularisation (état : ${STATUS_LABELS[status]})`;
  if (pending) return 'Une demande de régularisation attend déjà la réponse de Cahiora';
  return null;
}

/** « aujourd’hui, le 14 juillet 2027 », « demain, le … », « dans 3 jours, le … ». */
export function whenText(today: string, lastDay: string) {
  const n = daysBetween(today, lastDay);
  const date = frDay(lastDay);
  return n <= 0 ? `aujourd’hui, le ${date}` : n === 1 ? `demain, le ${date}` : `dans ${n} jours, le ${date}`;
}

/** Ce qui reste ouvert pendant l'accès limité, tel que la direction le lit (D-G5-30 A). */
export const LIMITED_KEEPS = 'consultation, impression, export, caisse et régularisation restent possibles, et aucune donnée n’est supprimée';

/** Refus d'une saisie pendant l'accès limité : le personnel lit pourquoi ; une famille, seulement de contacter l'établissement. */
export const LIMITED_REFUSAL = {
  staff: `Accès limité : l’abonnement Cahiora de l’établissement n’est pas régularisé. ${LIMITED_KEEPS[0].toUpperCase()}${LIMITED_KEEPS.slice(1)}.`,
  family: 'Cette action n’est pas disponible pour le moment : contactez l’établissement.',
};
