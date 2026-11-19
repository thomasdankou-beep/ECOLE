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
}

/**
 * - FREE : essai ou pilote ; ACTIVE : abonnement payé ; LIMITED : accès limité (posé par la tâche planifiée) ;
 * - GRACE : délai de grâce en cours ; EXTENDED : prolongation de Cahiora en cours (accès complet dans les deux cas) ;
 * - HELD : délai passé, mais une demande de régularisation attend Cahiora sans moyen de paiement activé (D-G5-42 A) ;
 * - DUE : délai passé et rien ne retient la limitation : la tâche planifiée la pose à son prochain passage ;
 * - WAITING : en attente sans délai connu (gratuité finie avant le lot G5d) : jamais limité automatiquement.
 */
export type AccessPhase = 'FREE' | 'ACTIVE' | 'GRACE' | 'EXTENDED' | 'HELD' | 'DUE' | 'LIMITED' | 'WAITING';

export interface AccessView {
  phase: AccessPhase;
  /** Dernier jour d'accès complet assuré (grâce ou prolongation). */
  until: string | null;
  /** Jours d'accès complet restants, aujourd'hui compris (le compteur du bandeau). */
  daysLeft: number | null;
  /** Premier jour de l'accès limité si rien ne change. */
  limitedFrom: string | null;
}

const none = (phase: AccessPhase, limitedFrom: string | null = null): AccessView => ({ phase, until: null, daysLeft: null, limitedFrom });

/** Phase d'accès d'un abonnement un jour donné (jour de l'établissement). */
export function accessPhase(a: AccessState, today: string): AccessView {
  if (a.status === 'TRIAL' || a.status === 'PILOT') return none('FREE');
  if (a.status === 'ACTIVE') return none('ACTIVE');
  if (a.status === 'LIMITED') return none('LIMITED');
  const ends = [a.graceEnd, a.extendedUntil].filter((x): x is string => !!x && x >= today).sort();
  if (ends.length) {
    const until = ends[ends.length - 1];
    const extended = !!a.extendedUntil && a.extendedUntil === until && (!a.graceEnd || a.extendedUntil > a.graceEnd);
    return { phase: extended ? 'EXTENDED' : 'GRACE', until, daysLeft: daysLeft(today, until), limitedFrom: addDays(until, 1) };
  }
  if (a.pendingRequest && !a.paymentMeansActive) return none('HELD');
  if (a.graceEnd || a.extendedUntil) return none('DUE', today);
  return none('WAITING');
}

/** La limitation est due aujourd'hui : la tâche planifiée la pose. */
export const limitationDue = (a: AccessState, today: string) => accessPhase(a, today).phase === 'DUE';

/**
 * Erreur d'une prolongation exceptionnelle (D-G5-43 A), ou null. Elle se donne à un abonnement en attente ou en accès
 * limité, avec une date de fin à partir d'aujourd'hui et au-delà du délai de grâce, au plus un an plus tard (garde-fou
 * contre une faute de frappe). Le motif est contrôlé à part.
 */
export function extensionError(status: SubscriptionStatus, until: string, today: string, graceEnd: string | null): string | null {
  if (!AWAITING_STATUSES.includes(status) && status !== 'LIMITED') {
    return `Une prolongation se donne à un abonnement en attente ou en accès limité (état actuel : ${STATUS_LABELS[status]})`;
  }
  if (!isDay(until)) return 'Date de fin : date invalide';
  if (until < today) return 'La date de fin ne peut pas être passée';
  if (graceEnd && until <= graceEnd) return `Le délai de grâce court déjà jusqu’au ${frDay(graceEnd)} : choisissez une date de fin plus tardive`;
  if (daysBetween(today, until) > 366) return 'Date de fin : au plus un an après aujourd’hui';
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
