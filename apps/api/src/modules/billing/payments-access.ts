import { BillingPaymentMeans, Prisma } from '@prisma/client';
import { money } from '../../common/country';
import { groupLog, PlatformActor, platformLog, schoolLogInTx } from '../platform/group-journal';
import { restoredStatus } from './access-rules';
import { frDay, SubscriptionStatus } from './billing-rules';
import { SYSTEM, systemJournals } from './billing-tasks';
import { activeMeans, losesPayment, MeansVersion, paymentsUnlocked, restoresAccess } from './payments-rules';

/**
 * Lot G5d-2 : ce que les paiements, les crédits et les avoirs changent à l'accès (choix 2 A, D-G5-30 A, D-G5-43 A) et
 * aux moyens de paiement vus par les règles de G5d-1 (D-G5-42 A). Partagé par les paiements, les documents de G5c, les
 * tâches planifiées et l'accès, dans la transaction de l'appelant. Rien n'est payé ici, aucun prestataire n'est appelé.
 */

const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

/** Une version d'un moyen de paiement, telle que les règles la lisent. */
export const meansVersion = (m: BillingPaymentMeans): MeansVersion & { reason: string; createdByName: string; createdAt: Date } => ({
  id: m.id, code: m.code, version: m.version, name: m.name, instructions: m.instructions, currency: m.currency, active: m.active, effectiveFrom: iso(m.effectiveFrom)!,
  reason: m.reason, createdByName: m.createdByName, createdAt: m.createdAt,
});

/**
 * Un établissement peut-il payer Cahiora un jour donné (D-G5-42 A) : verrou 1 du serveur ouvert, un moyen activé ce
 * jour-là dans sa monnaie, et l'établissement seul dans son groupe (le paiement d'un document de plusieurs
 * établissements attend D-G5-19 et D-G5-32). Sinon, une demande de régularisation en attente retient la limitation.
 */
export const paymentMeansActiveFor = (versions: MeansVersion[], t: { currency: string; alone: boolean }, day: string) =>
  t.alone && activeMeans(versions, t.currency, day, paymentsUnlocked()).length > 0;

/** Versions des moyens de paiement (aucune lecture tant que le verrou 1 est fermé : aucun moyen n'y compte). */
export async function meansVersions(db: Pick<Prisma.TransactionClient, 'billingPaymentMeans'>): Promise<MeansVersion[]> {
  if (!paymentsUnlocked()) return [];
  return (await db.billingPaymentMeans.findMany()).map(meansVersion);
}

type GraceRow = { document_id: string; reference: string; balance: number };

export type AccessTransition = {
  /** RESTORED : accès complet rendu (abonnement actif) ; REVERSED : paiement annulé, abonnement de nouveau en attente. */
  kind: 'RESTORED' | 'REVERSED' | null;
  wasLimited: boolean;
  /** Document qui a ouvert le délai de grâce, et son reste à payer. */
  graceDocument: { reference: string; balance: number } | null;
  status: SubscriptionStatus | null;
};

/** Journaux de la plateforme (avec le motif), du groupe et de l'établissement (sans lui), au nom du Super Admin ou de la tâche. */
export async function paymentJournals(
  tx: Prisma.TransactionClient, by: PlatformActor | null, t: { id: string; name: string; groupId: string }, action: string, data: Record<string, unknown>,
  internal: Record<string, unknown> = {},
) {
  if (!by) return systemJournals(tx, t, 'Subscription', null, action, data);
  await platformLog(tx, by, action, t.id, { ...data, ...internal });
  await groupLog(tx, by, [{ groupId: t.groupId, action, data: { tenantName: t.name, ...data } }]);
  await schoolLogInTx(tx, by, t.id, action, data);
}

/**
 * Accès après un paiement, une déduction de crédit, un avoir ou une annulation (choix 2 A) : l'abonnement en attente de
 * paiement ou en accès limité, conditions acceptées, devient actif dès que le document qui a ouvert son délai de grâce
 * est entièrement payé (l'accès limité est levé, rien n'a été supprimé) ; un paiement partiel ne change rien (D-G5-43 A).
 * Un abonnement actif dont ce document n'est plus entièrement payé (annulation d'une saisie) revient en attente de
 * paiement : la tâche planifiée applique ensuite les règles de G5d-1 (délai, prolongation, préavis, demande). Chaque
 * changement s'inscrit dans l'historique et les journaux ; l'appelant prévient la direction et vide le cache de l'accès.
 */
export async function syncPaymentAccess(
  tx: Prisma.TransactionClient, tenantId: string, cause: Record<string, unknown>, by: PlatformActor | null,
): Promise<AccessTransition> {
  // Abonnement verrouillé d'abord : la tâche planifiée qui limiterait au même instant attend ce paiement.
  const [locked] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM subscriptions WHERE tenant_id = ${tenantId}::uuid FOR UPDATE`;
  const [g] = await tx.$queryRaw<GraceRow[]>`SELECT * FROM billing_grace_document(${tenantId}::uuid)`;
  const graceDocument = g ? { reference: g.reference, balance: g.balance } : null;
  if (!locked) return { kind: null, wasLimited: false, graceDocument, status: null };
  const s = await tx.subscription.findUniqueOrThrow({ where: { id: locked.id }, include: { tenant: { select: { id: true, name: true, groupId: true } } } });
  const balance = graceDocument?.balance ?? null;
  const restore = restoresAccess(s.status, !!s.acceptedAt, balance);
  const reverse = !restore && losesPayment(s.status, balance);
  if (!restore && !reverse) return { kind: null, wasLimited: s.status === 'LIMITED', graceDocument, status: s.status };
  const to: SubscriptionStatus = restore ? 'ACTIVE' : restoredStatus(s.acceptedAt);
  const now = new Date();
  await tx.subscription.update({ where: { id: s.id }, data: { status: to, statusSince: now, limitedSince: null } });
  const kind = restore ? 'SUBSCRIPTION_PAID' : 'SUBSCRIPTION_PAYMENT_REVERSED';
  const data = { ...cause, graceDocument: graceDocument?.reference ?? null, graceDocumentBalance: balance, limitationLifted: restore && s.status === 'LIMITED' };
  await tx.subscriptionEvent.create({
    data: {
      subscriptionId: s.id, tenantId, kind, fromStatus: s.status, toStatus: to, data: data as Prisma.InputJsonValue, actorKind: by ? 'platform' : 'system', actorId: by?.id ?? null,
      actorName: by?.name ?? SYSTEM, ip: by?.ip ?? null,
    },
  });
  await paymentJournals(tx, by, s.tenant, restore ? 'billing.subscription_paid' : 'billing.subscription_payment_reversed', data);
  return { kind: restore ? 'RESTORED' : 'REVERSED', wasLimited: s.status === 'LIMITED', graceDocument, status: to };
}

/** Phrase de l'accès pour la direction, après un paiement, une déduction de crédit ou un avoir ; vide si rien ne change. */
export function accessSentence(a: AccessTransition, currency: string) {
  if (a.kind === 'RESTORED') {
    return `Le document ${a.graceDocument!.reference} est entièrement payé : l’accès complet à Cahiora est rétabli${a.wasLimited ? ', l’accès limité est levé' : ''}.`;
  }
  if (a.kind === 'REVERSED') return `Le document ${a.graceDocument!.reference} attend à nouveau son paiement : l’abonnement revient en attente de paiement.`;
  if ((a.status === 'AWAITING_PAYMENT' || a.status === 'LIMITED') && a.graceDocument && a.graceDocument.balance > 0) {
    return `Il reste ${money(a.graceDocument.balance, currency)} à payer sur le document ${a.graceDocument.reference}${a.status === 'LIMITED' ? ' : l’accès reste limité jusqu’à son paiement complet' : ''}.`;
  }
  return '';
}

type ApplyRow = { entry_id: string; used: number; documents: { documentId: string; reference: string; amount: number }[] | null };

/**
 * Déduit le crédit disponible d'un établissement de ses documents à payer, du plus ancien au plus récent (D-G5-15 A),
 * après l'émission d'un document, un refus de remboursement ou un transfert reçu ; puis l'accès (choix 2 A). null quand
 * rien n'est déduit.
 */
export async function useCredit(tx: Prisma.TransactionClient, t: { id: string; name: string; groupId: string }, by: PlatformActor | null) {
  const [r] = await tx.$queryRaw<ApplyRow[]>`SELECT * FROM apply_billing_credit(${t.id}::uuid, ${by ? 'platform' : 'system'}, ${by?.id ?? null}::uuid, ${by?.name ?? SYSTEM})`;
  if (!r) return null;
  const documents = r.documents ?? [];
  await paymentJournals(tx, by, t, 'billing.credit_used', { used: r.used, documents: documents.map((d) => ({ reference: d.reference, amount: d.amount })) });
  const access = await syncPaymentAccess(tx, t.id, { cause: 'CREDIT', used: r.used }, by);
  return { used: r.used, documents, access };
}

/** Phrase d'une déduction de crédit pour la direction. */
export const creditSentence = (c: { used: number; documents: { reference: string; amount: number }[] }, currency: string) =>
  `Crédit de votre établissement déduit : ${money(c.used, currency)} sur ${c.documents.map((d) => `${d.reference} (${money(d.amount, currency)})`).join(', ')}.`;

type ImputeRow = { tenant_id: string; allocated: number; credit: number };

/**
 * Impute un avoir qui vient d'être émis (choix 1 A) : d'abord le document qu'il corrige, puis les autres documents à
 * payer, puis le crédit de l'établissement ; puis l'accès (choix 2 A). null pour l'avoir d'un document de plusieurs
 * établissements, qui attend D-G5-19 et D-G5-32.
 */
export async function imputeCreditNote(tx: Prisma.TransactionClient, documentId: string, t: { id: string; name: string; groupId: string }, by: PlatformActor | null) {
  const [r] = await tx.$queryRaw<ImputeRow[]>`SELECT * FROM impute_billing_credit_note(${documentId}::uuid)`;
  if (!r) return null;
  const allocations = await tx.billingAllocation.findMany({ where: { creditNoteId: documentId }, include: { document: { select: { reference: true } } } });
  const data = { creditNoteId: documentId, allocated: r.allocated, credit: r.credit, allocations: allocations.map((a) => ({ reference: a.document.reference, amount: a.amount })) };
  await paymentJournals(tx, by, t, 'billing.credit_note_imputed', data);
  const access = await syncPaymentAccess(tx, t.id, { cause: 'CREDIT_NOTE', creditNoteId: documentId }, by);
  return { ...data, access };
}

/** Phrase de l'imputation d'un avoir pour la direction. */
export function creditNoteSentence(c: { allocations: { reference: string; amount: number }[]; credit: number }, currency: string) {
  const parts = [];
  if (c.allocations.length) parts.push(`imputé sur ${c.allocations.map((a) => `${a.reference} (${money(a.amount, currency)})`).join(', ')}`);
  if (c.credit > 0) parts.push(`${money(c.credit, currency)} deviennent un crédit de votre établissement, déduit du prochain document`);
  return parts.length ? `Cet avoir est ${parts.join(' ; ')}.` : '';
}

/** « 21 novembre 2026 » pour un jour AAAA-MM-JJ, ou une date. */
export const dayLabel = (d: Date | string) => frDay(typeof d === 'string' ? d : iso(d)!);
