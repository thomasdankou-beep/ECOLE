import { daysBetween, frDay, isDay } from './billing-rules';

/**
 * Paiements de l'abonnement Cahiora (lot G5d-2), sans accès à la base. Cahier des charges G5 du 14 novembre 2026,
 * §8 (paiements et encaissements) et §9 (avoirs, crédits et remboursements) ; plan G5d-2 validé par Dankou le
 * 20 novembre 2026 (« Tout valider ») :
 * - D-G5-17 A : au lancement, le Super Admin enregistre et vérifie chaque paiement reçu, avec le code de son
 *   application ; aucun prestataire de paiement n'est appelé, aucun paiement en ligne ;
 * - D-G5-34, encore ouverte, lue A : un seul rôle de Super Admin, chaque validation nommée et protégée par le code ;
 * - choix 1 A : un paiement va d'abord au document indiqué par le Super Admin (le « document concerné »), puis le
 *   surplus aux autres documents impayés de l'établissement, du plus ancien au plus récent, puis devient un crédit de
 *   l'établissement payeur (D-G5-15 A) ; un avoir suit la même règle à partir du document qu'il corrige ;
 * - choix 2 A : l'accès complet revient quand le document qui a ouvert le délai de grâce (le premier document de
 *   l'abonnement après la gratuité) est entièrement payé ; les compléments suivent leur propre règle (D-G5-18, ouverte) ;
 * - D-G5-43 A : un paiement partiel laisse l'accès tel qu'il est, sauf prolongation ;
 * - un crédit se déduit du document suivant, le reste est reporté ; un remboursement se fait seulement sur demande de
 *   la direction, validé par le Super Admin avec sa preuve ; un crédit ne sert jamais deux fois et un crédit consommé ne
 *   se rembourse pas ; un transfert entre établissements d'un même groupe exige une autorisation et laisse sa trace ;
 * - une saisie erronée s'annule par une contre-écriture motivée : rien n'est supprimé ni modifié en silence.
 * Deux verrous empêchent tout paiement réel tant que la situation juridique et fiscale de Cahiora n'est pas validée
 * (D-G5-33) : le verrou du serveur (fermé par défaut, donc en production) et l'activation de chaque moyen de paiement
 * dans la console, refusée tant que le premier est fermé. Montants en entiers dans la monnaie de l'établissement ;
 * dates de calendrier (AAAA-MM-JJ). La base refait chaque contrôle et chaque imputation (migration paiements_g5d2) :
 * ces règles servent aux contrôles de l'API, aux aperçus et aux essais.
 */

// ---------------------------------------------------------------- Verrou 1 : le serveur

/** Variable du serveur qui ouvre le verrou 1 ; seule la valeur exacte « true » l'ouvre. */
export const PAYMENTS_LOCK_ENV = 'BILLING_PAYMENTS_UNLOCKED';

/** Verrou 1 : ouvert seulement si la variable du serveur vaut exactement « true » ; fermé par défaut, donc en production. */
export const paymentsUnlocked = (env: Record<string, string | undefined> = process.env) => env[PAYMENTS_LOCK_ENV] === 'true';

/** Document de plusieurs établissements : son paiement (et l'imputation de ses avoirs) attend D-G5-19 et D-G5-32. */
export const GROUP_PAYMENT_PENDING = 'Document de plusieurs établissements : son paiement attend les décisions D-G5-19 et D-G5-32';

/** Ce que lit la direction tant que le verrou 1 est fermé (son crédit reste déduit du document suivant). */
export const REFUNDS_CLOSED = 'Les remboursements ne sont pas encore ouverts par Cahiora : votre crédit disponible est déduit de votre prochain document.';

/** Message de tout refus dû au verrou 1. */
export const PAYMENTS_LOCKED =
  'Les paiements de Cahiora sont fermés sur ce serveur : aucun paiement réel avant la validation juridique et fiscale de Cahiora (D-G5-33). Rien n’est enregistré.';

// ---------------------------------------------------------------- Verrou 2 : les moyens de paiement

/** Une version d'un moyen de paiement (en ajout seul) : la plus récente en vigueur un jour donné fait foi. */
export interface MeansVersion {
  id: string;
  code: string;
  version: number;
  name: string;
  instructions: string;
  currency: string;
  active: boolean;
  effectiveFrom: string;
}

/** Version en vigueur de chaque moyen de paiement un jour donné : la date d'effet la plus récente, puis la dernière version. */
export function meansOn<T extends MeansVersion>(versions: T[], day: string): T[] {
  const byCode = new Map<string, T>();
  for (const v of versions) {
    if (v.effectiveFrom > day) continue;
    const cur = byCode.get(v.code);
    if (!cur || v.effectiveFrom > cur.effectiveFrom || (v.effectiveFrom === cur.effectiveFrom && v.version > cur.version)) byCode.set(v.code, v);
  }
  return [...byCode.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr') || a.code.localeCompare(b.code));
}

/** Moyens activés un jour donné dans une monnaie ; aucun tant que le verrou 1 est fermé. */
export const activeMeans = <T extends MeansVersion>(versions: T[], currency: string, day: string, unlocked: boolean) =>
  (unlocked ? meansOn(versions, day).filter((v) => v.active && v.currency === currency) : []);

/** Code stable d'un moyen de paiement, tiré de son premier nom : « MTN Mobile Money » → MTN_MOBILE_MONEY. */
export function meansCode(name: string) {
  const code = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return code || 'MOYEN';
}

export interface MeansInput {
  name: string;
  instructions: string;
  currency: string;
  active: boolean;
  effectiveFrom: string;
}

/**
 * Erreur d'une nouvelle version d'un moyen de paiement, ou null. Nom et coordonnées viennent de Dankou (INFORMATION
 * MANQUANTE tant qu'il ne les a pas données) ; une date d'effet passée ne change jamais ce qui a déjà été vu ; une
 * activation exige le verrou 1 ouvert.
 */
export function meansError(v: MeansInput, today: string, currencies: string[], unlocked: boolean) {
  if (!unlocked) return PAYMENTS_LOCKED;
  if (v.name.trim().length < 2 || v.name.trim().length > 80) return 'Nom du moyen de paiement : 2 à 80 caractères';
  if (v.instructions.trim().length < 5 || v.instructions.trim().length > 1000) return 'Coordonnées et instructions pour les établissements : 5 à 1 000 caractères';
  if (!currencies.includes(v.currency)) return 'Monnaie non prise en charge';
  if (!isDay(v.effectiveFrom)) return 'Date d’effet invalide';
  if (v.effectiveFrom < today) return 'La date d’effet ne peut pas être passée';
  if (daysBetween(today, v.effectiveFrom) > 366) return 'Date d’effet : au plus un an après aujourd’hui';
  return null;
}

// ---------------------------------------------------------------- Imputation (choix 1 A)

/** Document qui attend encore un paiement, avec son reste à payer. */
export interface OpenDocument {
  id: string;
  reference: string;
  issueDate: string;
  createdAt: Date;
  balance: number;
}

export interface Imputation {
  allocations: { documentId: string; reference: string; amount: number }[];
  /** Reste après les documents : crédit de l'établissement (D-G5-15 A). */
  credit: number;
}

/** Du plus ancien au plus récent : date du document, puis instant de l'émission, puis référence. */
export const oldestFirst = (a: OpenDocument, b: OpenDocument) =>
  a.issueDate.localeCompare(b.issueDate) || a.createdAt.getTime() - b.createdAt.getTime() || a.reference.localeCompare(b.reference);

/**
 * Imputation d'un montant (choix 1 A) : d'abord le document indiqué, puis les autres documents impayés du plus ancien au
 * plus récent, puis le crédit. Sans document indiqué (un crédit qui se déduit), du plus ancien au plus récent.
 */
export function impute(amount: number, indicated: string | null, docs: OpenDocument[]): Imputation {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Montant invalide');
  const open = docs.filter((d) => d.balance > 0);
  const order = [...open.filter((d) => d.id === indicated), ...open.filter((d) => d.id !== indicated).sort(oldestFirst)];
  const allocations: Imputation['allocations'] = [];
  let left = amount;
  for (const d of order) {
    if (left <= 0) break;
    const part = Math.min(left, d.balance);
    allocations.push({ documentId: d.id, reference: d.reference, amount: part });
    left -= part;
  }
  return { allocations, credit: left };
}

// ---------------------------------------------------------------- État du paiement d'un document

export type DocumentPaymentStatus = 'NOTHING_DUE' | 'PENDING' | 'PARTIAL' | 'PAID' | 'CANCELLED';

export const DOCUMENT_STATUS_LABELS: Record<DocumentPaymentStatus, string> = {
  NOTHING_DUE: 'Rien à payer',
  PENDING: 'En attente',
  PARTIAL: 'Partiellement payé',
  PAID: 'Payé',
  CANCELLED: 'Annulé par avoir',
};

/** Filtre des rapports : les états, plus « En retard » (reste à payer après l'échéance). */
export const STATUS_FILTERS = ['PENDING', 'PARTIAL', 'OVERDUE', 'PAID', 'CANCELLED', 'NOTHING_DUE'] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export interface DocumentPayment {
  status: DocumentPaymentStatus;
  label: string;
  /** Échéance passée avec un reste à payer. */
  overdue: boolean;
  /** Montant du document, moins les avoirs imputés. */
  due: number;
  /** Payé : paiements et crédits imputés, annulations déduites. */
  paid: number;
  /** Reste à payer. */
  balance: number;
}

/**
 * État du paiement d'un document (§8) : total du document, avoirs, paiements et crédits imputés (annulations déduites).
 * « En retard » s'ajoute quand l'échéance est passée et qu'il reste à payer. « Remboursé » est l'état d'une demande de
 * remboursement d'un crédit : un document ne se rembourse pas, son trop-perçu devient un crédit de l'établissement.
 */
export function documentPayment(d: { total: number; credited: number; paid: number; dueDate: string | null }, today: string): DocumentPayment {
  const due = Math.max(0, d.total - d.credited);
  const balance = Math.max(0, due - d.paid);
  let status: DocumentPaymentStatus;
  if (d.total === 0) status = 'NOTHING_DUE';
  else if (due === 0 && d.paid === 0) status = 'CANCELLED';
  else if (balance === 0) status = 'PAID';
  else if (d.paid > 0) status = 'PARTIAL';
  else status = 'PENDING';
  const overdue = balance > 0 && !!d.dueDate && d.dueDate < today;
  const label = overdue ? (status === 'PARTIAL' ? 'Partiellement payé, en retard' : 'En retard') : DOCUMENT_STATUS_LABELS[status];
  return { status, label, overdue, due, paid: d.paid, balance };
}

/** Un document répond-il au filtre d'état des rapports ? */
export const matchesStatus = (p: DocumentPayment, filter: StatusFilter | null | undefined) =>
  !filter || (filter === 'OVERDUE' ? p.overdue : p.status === filter);

// ---------------------------------------------------------------- Reçus provisoires

/** Mention de chaque reçu : jamais une facture ni un reçu fiscal (§16 ; factures fiscales au lot G5f). */
export const RECEIPT_MENTION = 'Reçu provisoire, sans valeur fiscale.';

/** Numéro d'un reçu provisoire, dans sa propre suite : PROV-REC-000001. */
export const receiptNumber = (n: number) => `PROV-REC-${String(n).padStart(6, '0')}`;

/** Référence d'une transaction comparée sans espaces ni casse : une même référence ne s'enregistre qu'une fois. */
export const normalizedReference = (s: string) => s.replace(/\s+/g, '').toUpperCase();

export const PAYMENT_STATUS_LABELS = { VALIDATED: 'Validé', CANCELLED: 'Annulé (contre-écriture)' } as const;

// ---------------------------------------------------------------- Saisie d'un paiement

export interface PaymentInput {
  amount: number;
  paidOn: string;
  transactionRef: string;
}

/** Erreur de saisie d'un paiement, ou null (la base refait ces contrôles). */
export function paymentError(p: PaymentInput, today: string, documentIssueDate: string) {
  if (!Number.isSafeInteger(p.amount) || p.amount < 1 || p.amount > 1_000_000_000) return 'Montant reçu : nombre entier de 1 à 1 000 000 000';
  if (!isDay(p.paidOn)) return 'Date du paiement invalide';
  if (p.paidOn > today) return 'La date du paiement ne peut pas être dans le futur';
  if (p.paidOn < documentIssueDate) return `Un paiement ne précède pas le document qu’il règle (émis le ${frDay(documentIssueDate)})`;
  const ref = p.transactionRef.trim();
  if (ref.length < 3 || ref.length > 100) return 'Référence de la transaction : 3 à 100 caractères';
  return null;
}

// ---------------------------------------------------------------- Accès (choix 2 A)

/**
 * Le paiement rend l'accès complet (choix 2 A, D-G5-30 A) : abonnement en attente de paiement ou en accès limité,
 * conditions acceptées, et document qui a ouvert le délai de grâce entièrement payé. Un complément impayé n'y compte pas.
 */
export function restoresAccess(status: string, termsAccepted: boolean, graceDocumentBalance: number | null) {
  return termsAccepted && (status === 'AWAITING_PAYMENT' || status === 'LIMITED') && graceDocumentBalance !== null && graceDocumentBalance <= 0;
}

/**
 * Une annulation remet l'abonnement en attente de paiement : il était actif et le document du délai de grâce n'est plus
 * entièrement payé. La tâche planifiée applique ensuite la règle de G5d-1 (délai, prolongation, préavis, demande).
 */
export const losesPayment = (status: string, graceDocumentBalance: number | null) => status === 'ACTIVE' && graceDocumentBalance !== null && graceDocumentBalance > 0;

// ---------------------------------------------------------------- Crédits (D-G5-15 A)

export type CreditEntryKind = 'PAYMENT_SURPLUS' | 'CREDIT_NOTE_SURPLUS' | 'USE' | 'USE_REVERSED' | 'PAYMENT_CANCELLED' | 'REFUND' | 'TRANSFER_OUT' | 'TRANSFER_IN';

export const CREDIT_ENTRY_LABELS: Record<CreditEntryKind, string> = {
  PAYMENT_SURPLUS: 'Trop-perçu d’un paiement',
  CREDIT_NOTE_SURPLUS: 'Avoir au-delà du reste à payer',
  USE: 'Déduit d’un document',
  USE_REVERSED: 'Déduction reprise (paiement annulé)',
  PAYMENT_CANCELLED: 'Paiement annulé : trop-perçu retiré',
  REFUND: 'Remboursé',
  TRANSFER_OUT: 'Transféré à un autre établissement du groupe',
  TRANSFER_IN: 'Reçu d’un autre établissement du groupe',
};

/** Crédit disponible : solde, moins la demande de remboursement qui attend (son montant est réservé). */
export const availableCredit = (balance: number, reserved: number) => Math.max(0, balance - reserved);

/**
 * Annulation d'un paiement dont le trop-perçu est devenu un crédit : le crédit disponible le reprend d'abord ; s'il ne
 * suffit plus, les déductions de crédit sont reprises, de la plus récente à la plus ancienne (les documents qu'elles
 * payaient attendent à nouveau leur paiement). Un crédit remboursé, transféré ou réservé par une demande de
 * remboursement ne revient pas : l'annulation est refusée.
 */
export function cancellationPlan(creditPart: number, available: number, uses: { id: string; remaining: number; createdAt: Date }[]) {
  if (creditPart <= 0 || available >= creditPart) return { reverse: [] as { id: string; amount: number }[], error: null };
  let need = creditPart - available;
  const reverse: { id: string; amount: number }[] = [];
  for (const u of [...uses].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
    if (need <= 0) break;
    if (u.remaining <= 0) continue;
    const part = Math.min(need, u.remaining);
    reverse.push({ id: u.id, amount: part });
    need -= part;
  }
  if (need > 0) return { reverse: [], error: CANCEL_REFUSED };
  return { reverse, error: null };
}

export const CANCEL_REFUSED =
  'Le trop-perçu de ce paiement a déjà été remboursé, transféré ou réservé par une demande de remboursement : il ne peut plus être repris, l’annulation est refusée';

// ---------------------------------------------------------------- Remboursements et transferts

export type RefundStatus = 'PENDING' | 'REFUNDED' | 'REFUSED';
export const REFUND_STATUS_LABELS: Record<RefundStatus, string> = { PENDING: 'Demandé', REFUNDED: 'Remboursé', REFUSED: 'Refusé' };

/** Erreur d'une demande de remboursement de la direction, ou null : une à la fois, au plus le crédit disponible. */
export function refundRequestError(amount: number, available: number, pending: boolean) {
  if (pending) return 'Une demande de remboursement attend déjà la décision de Cahiora';
  if (!Number.isSafeInteger(amount) || amount < 1) return 'Montant : nombre entier d’au moins 1';
  if (available <= 0) return 'Aucun crédit disponible à rembourser';
  if (amount > available) return `Montant : au plus le crédit disponible (${available})`;
  return null;
}

export interface RefundDecisionInput {
  decision: 'REFUNDED' | 'REFUSED';
  note?: string | null;
  refundedOn?: string | null;
  means?: string | null;
  reference?: string | null;
}

/**
 * Erreur de la décision du Super Admin sur une demande de remboursement, ou null. Un remboursement porte sa preuve :
 * date (ni future ni avant la demande), moyen, référence et justificatif (contrôlé à part) ; un refus, son motif.
 */
export function refundDecisionError(d: RefundDecisionInput, today: string, requestedOn: string) {
  if (d.decision === 'REFUSED') return (d.note?.trim().length ?? 0) < 5 ? 'Un refus exige un motif (5 caractères au moins)' : null;
  if (!d.refundedOn || !isDay(d.refundedOn)) return 'Date du remboursement invalide';
  if (d.refundedOn > today) return 'La date du remboursement ne peut pas être dans le futur';
  if (d.refundedOn < requestedOn) return `Un remboursement ne précède pas la demande (du ${frDay(requestedOn)})`;
  if ((d.means?.trim().length ?? 0) < 2 || (d.means?.trim().length ?? 0) > 80) return 'Moyen du remboursement : 2 à 80 caractères';
  if ((d.reference?.trim().length ?? 0) < 3 || (d.reference?.trim().length ?? 0) > 100) return 'Référence du remboursement : 3 à 100 caractères';
  return null;
}

export interface TransferInput {
  fromGroupId: string;
  toGroupId: string;
  fromCurrency: string;
  toCurrency: string;
  sameTenant: boolean;
  amount: number;
  available: number;
  authorizedBy: string;
  reason: string;
}

/**
 * Erreur d'un transfert de crédit, ou null : entre deux établissements du même groupe et de la même monnaie, au plus le
 * crédit disponible, avec l'autorisation (qui l'a donnée, par quel écrit) et un motif.
 */
export function transferError(t: TransferInput) {
  if (t.sameTenant) return 'Choisissez un autre établissement que celui qui cède le crédit';
  if (t.fromGroupId !== t.toGroupId) return 'Un crédit ne se transfère qu’entre établissements d’un même groupe';
  if (t.fromCurrency !== t.toCurrency) return 'Les deux établissements n’ont pas la même monnaie';
  if (!Number.isSafeInteger(t.amount) || t.amount < 1) return 'Montant : nombre entier d’au moins 1';
  if (t.amount > t.available) return `Montant : au plus le crédit disponible (${t.available})`;
  if (t.authorizedBy.trim().length < 5 || t.authorizedBy.trim().length > 300) return 'Autorisation : qui l’a donnée et par quel écrit (5 à 300 caractères)';
  if (t.reason.trim().length < 5 || t.reason.trim().length > 300) return 'Motif : 5 à 300 caractères';
  return null;
}
