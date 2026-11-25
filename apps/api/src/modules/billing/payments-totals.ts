import { Prisma } from '@prisma/client';

/**
 * Totaux financiers de Cahiora (lot G5d-2, §14 du cahier des charges G5) : ce qui est facturé par les documents
 * provisoires et ce qui est réellement encaissé ne se confondent jamais. Tout est compté par monnaie, jamais additionné
 * d'une monnaie à l'autre. Lus par le rôle de la plateforme (lecture seule et fonctions de la base) ; aucun calcul
 * n'écrit quoi que ce soit.
 * Précisions du 24 novembre 2026 : ce sont des indicateurs réels, des clients réels seulement. Un établissement de test
 * n'y entre jamais (chiffre d'affaires facturé ou encaissé, avoirs, remboursements, créances, crédits), même avec des
 * documents ou des paiements fictifs d'avant son passage « de test » ; un document qui compte un établissement de test
 * en est écarté entièrement.
 */

/** Portée des indicateurs réels, lue dans la console (24 novembre 2026). */
export const REAL_INDICATORS_NOTE = 'Clients réels seulement : les établissements de test n’entrent dans aucun montant, aucune créance ni aucune liste de ces indicateurs.';

/** Un montant dans une monnaie. */
export type MoneyRow = { currency: string; amount: number };

export interface TotalsFilter {
  /** Période (jours compris, AAAA-MM-JJ) : date du document, du paiement ou du remboursement. */
  from?: string | null;
  to?: string | null;
  /** Établissements retenus (null : tous). */
  tenantIds?: string[] | null;
}

export interface FinancialTotals {
  /** Facturé : proformas de l'abonnement (documents provisoires, lot G5c), par les lignes des établissements retenus. */
  billed: MoneyRow[];
  /** Avoirs provisoires émis. */
  credited: MoneyRow[];
  /** Encaissé : paiements enregistrés et validés par Cahiora, saisies annulées déduites. */
  collected: MoneyRow[];
  /** Crédits remboursés aux établissements. */
  refunded: MoneyRow[];
  /** Reste à payer, aujourd'hui, des documents d'un établissement seul. */
  unpaid: MoneyRow[];
  /** Documents de plusieurs établissements : leur paiement attend les décisions D-G5-19 et D-G5-32. */
  groupPending: MoneyRow[];
  /** Crédits disponibles des établissements, aujourd'hui (demande de remboursement en attente déduite). */
  credits: MoneyRow[];
}

type Db = { $queryRaw: <T = unknown>(query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => Prisma.PrismaPromise<T> };

const rows = (r: { currency: string; amount: number | null }[]) =>
  r.filter((x) => (x.amount ?? 0) !== 0).map((x) => ({ currency: x.currency, amount: x.amount ?? 0 })).sort((a, b) => a.currency.localeCompare(b.currency));

export async function financialTotals(db: Db, f: TotalsFilter = {}): Promise<FinancialTotals> {
  const from = f.from ?? null;
  const to = f.to ?? null;
  const tenants = f.tenantIds ?? null;
  const billing = await db.$queryRaw<{ currency: string; kind: string; amount: number }[]>`
    SELECT d.currency, d.kind::text AS kind, sum(l.amount)::integer AS amount
    FROM billing_documents d JOIN billing_document_lines l ON l."documentId" = d.id
    WHERE d.kind IN ('SUBSCRIPTION', 'CREDIT_NOTE') AND (${from}::date IS NULL OR d."issueDate" >= ${from}::date) AND (${to}::date IS NULL OR d."issueDate" <= ${to}::date)
      AND (${tenants}::uuid[] IS NULL OR l.tenant_id = ANY(${tenants}::uuid[]))
      AND NOT EXISTS (SELECT 1 FROM billing_document_lines x JOIN tenants xt ON xt.id = x.tenant_id WHERE x."documentId" = d.id AND xt."commercialStatus" = 'TEST')
    GROUP BY 1, 2`;
  const collected = await db.$queryRaw<{ currency: string; amount: number }[]>`
    SELECT p.currency, sum(p.amount)::integer AS amount FROM billing_payments p
    WHERE p."cancelledAt" IS NULL AND (${from}::date IS NULL OR p."paidOn" >= ${from}::date) AND (${to}::date IS NULL OR p."paidOn" <= ${to}::date)
      AND (${tenants}::uuid[] IS NULL OR p.tenant_id = ANY(${tenants}::uuid[]))
      AND EXISTS (SELECT 1 FROM tenants ct WHERE ct.id = p.tenant_id AND ct."commercialStatus" = 'CLIENT')
    GROUP BY 1`;
  const refunded = await db.$queryRaw<{ currency: string; amount: number }[]>`
    SELECT r.currency, sum(r.amount)::integer AS amount FROM billing_refunds r
    WHERE r.status = 'REFUNDED' AND (${from}::date IS NULL OR r."refundedOn" >= ${from}::date) AND (${to}::date IS NULL OR r."refundedOn" <= ${to}::date)
      AND (${tenants}::uuid[] IS NULL OR r.tenant_id = ANY(${tenants}::uuid[]))
      AND EXISTS (SELECT 1 FROM tenants ct WHERE ct.id = r.tenant_id AND ct."commercialStatus" = 'CLIENT')
    GROUP BY 1`;
  const unpaid = await db.$queryRaw<{ currency: string; amount: number }[]>`
    SELECT t.currency, sum(p.balance)::integer AS amount
    FROM tenants t CROSS JOIN LATERAL billing_payable_documents(t.id) p
    WHERE t."commercialStatus" = 'CLIENT' AND (${tenants}::uuid[] IS NULL OR t.id = ANY(${tenants}::uuid[]))
      AND (${from}::date IS NULL OR p.issue_date >= ${from}::date) AND (${to}::date IS NULL OR p.issue_date <= ${to}::date)
    GROUP BY 1`;
  const groupPending = await db.$queryRaw<{ currency: string; amount: number }[]>`
    SELECT d.currency, sum(greatest(0, d.total - coalesce((SELECT sum(c.total) FROM billing_documents c WHERE c."relatedDocumentId" = d.id AND c.kind = 'CREDIT_NOTE'), 0)))::integer AS amount
    FROM billing_documents d
    WHERE d.kind = 'SUBSCRIPTION' AND d.total > 0
      AND (SELECT count(DISTINCT l.tenant_id) FROM billing_document_lines l WHERE l."documentId" = d.id) > 1
      AND NOT EXISTS (SELECT 1 FROM billing_document_lines x JOIN tenants xt ON xt.id = x.tenant_id WHERE x."documentId" = d.id AND xt."commercialStatus" = 'TEST')
      AND (${tenants}::uuid[] IS NULL OR EXISTS (SELECT 1 FROM billing_document_lines l WHERE l."documentId" = d.id AND l.tenant_id = ANY(${tenants}::uuid[])))
      AND (${from}::date IS NULL OR d."issueDate" >= ${from}::date) AND (${to}::date IS NULL OR d."issueDate" <= ${to}::date)
    GROUP BY 1`;
  const credits = await db.$queryRaw<{ currency: string; amount: number }[]>`
    SELECT t.currency, sum(greatest(0, billing_credit_balance(t.id) - billing_credit_reserved(t.id)))::integer AS amount
    FROM tenants t WHERE t."commercialStatus" = 'CLIENT' AND (${tenants}::uuid[] IS NULL OR t.id = ANY(${tenants}::uuid[]))
    GROUP BY 1`;
  return {
    billed: rows(billing.filter((r) => r.kind === 'SUBSCRIPTION')),
    credited: rows(billing.filter((r) => r.kind === 'CREDIT_NOTE')),
    collected: rows(collected),
    refunded: rows(refunded),
    unpaid: rows(unpaid),
    groupPending: rows(groupPending),
    credits: rows(credits),
  };
}
