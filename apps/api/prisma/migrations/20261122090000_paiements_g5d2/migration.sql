-- Lot G5d-2 · paiements de l'abonnement Cahiora, reçus provisoires, avoirs, crédits, remboursements et transferts.
-- Cahier des charges du lot G5 (14 novembre 2026), §8 et §9 ; plan G5d-2 validé par Dankou le 20 novembre 2026 :
-- - D-G5-17 A : le Super Admin enregistre chaque paiement reçu (établissement payeur, document concerné, montant
--   attendu, montant reçu, date, moyen, référence de la transaction, justificatif, agent qui valide) ; aucun prestataire
--   de paiement n'est appelé. Une même référence de transaction ne s'enregistre qu'une fois.
-- - Choix 1 A : un paiement va d'abord au document indiqué, puis le surplus aux autres documents impayés de
--   l'établissement, du plus ancien au plus récent, puis devient un crédit de l'établissement (D-G5-15 A) ; un avoir suit
--   la même règle à partir du document qu'il corrige.
-- - Crédits (D-G5-15 A) : déduits du document suivant, le reste reporté ; remboursement seulement sur demande de la
--   direction, validé par le Super Admin avec sa preuve ; jamais deux fois le même crédit, jamais le remboursement d'un
--   crédit consommé ; un transfert entre établissements d'un même groupe exige une autorisation et laisse sa trace.
-- - Une saisie erronée s'annule par une contre-écriture motivée : rien n'est supprimé ni modifié en silence.
-- - Verrou 2 : chaque moyen de paiement est une suite de versions datées ; un paiement exige un moyen activé le jour du
--   paiement. Le verrou 1 (serveur, fermé par défaut) est dans l'API : fermé, aucune de ces fonctions n'est appelée.
-- Les reçus portent une suite à part « PROV-REC-… » et restent « Reçu provisoire, sans valeur fiscale » (§16 ; factures
-- fiscales au lot G5f). Aucune donnée existante n'est modifiée : les avoirs déjà émis sont seulement imputés (lignes
-- ajoutées) sur les documents qu'ils corrigent ; aucun paiement, aucun moyen de paiement n'est créé ici.
-- Tout s'applique en une seule transaction : en cas d'erreur, rien n'est changé.

-- CreateEnum
CREATE TYPE "BillingAllocationSource" AS ENUM ('PAYMENT', 'CREDIT_NOTE', 'CREDIT');

-- CreateEnum
CREATE TYPE "BillingCreditEntryKind" AS ENUM ('PAYMENT_SURPLUS', 'CREDIT_NOTE_SURPLUS', 'USE', 'USE_REVERSED', 'PAYMENT_CANCELLED', 'REFUND', 'TRANSFER_OUT', 'TRANSFER_IN');

-- CreateEnum
CREATE TYPE "BillingRefundStatus" AS ENUM ('PENDING', 'REFUNDED', 'REFUSED');

-- CreateTable
CREATE TABLE "billing_payment_means" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" UUID,
    "createdByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_payment_means_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "billing_payment_means_check" CHECK ("version" >= 1 AND length(btrim("name")) BETWEEN 2 AND 80 AND length(btrim("instructions")) BETWEEN 5 AND 1000
      AND length(btrim("reason")) BETWEEN 5 AND 300 AND "code" ~ '^[A-Z0-9_]{1,40}$')
);

-- CreateTable
CREATE TABLE "billing_payments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "currency" TEXT NOT NULL,
    "expectedAmount" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "paidOn" DATE NOT NULL,
    "meansId" UUID NOT NULL,
    "meansName" TEXT NOT NULL,
    "transactionRef" TEXT NOT NULL,
    "transactionKey" TEXT NOT NULL,
    "proofKey" TEXT NOT NULL,
    "proofMime" TEXT NOT NULL,
    "note" TEXT,
    "receiptSeq" INTEGER NOT NULL,
    "receiptNumber" TEXT NOT NULL,
    "creditAmount" INTEGER NOT NULL,
    "recordedById" UUID,
    "recordedByName" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" UUID,
    "cancelledByName" TEXT,
    "cancelReason" TEXT,
    "cancelIp" TEXT,

    CONSTRAINT "billing_payments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "billing_payments_amount_check" CHECK ("amount" BETWEEN 1 AND 1000000000 AND "expectedAmount" >= 0 AND "creditAmount" BETWEEN 0 AND "amount"),
    CONSTRAINT "billing_payments_text_check" CHECK (length(btrim("transactionRef")) BETWEEN 3 AND 100 AND "transactionKey" <> '' AND btrim("proofKey") <> ''
      AND ("note" IS NULL OR length("note") <= 500) AND "receiptSeq" >= 1
      AND "receiptNumber" = 'PROV-REC-' || CASE WHEN "receiptSeq" < 1000000 THEN lpad("receiptSeq"::text, 6, '0') ELSE "receiptSeq"::text END),
    CONSTRAINT "billing_payments_cancel_check" CHECK (("cancelledAt" IS NULL) = ("cancelReason" IS NULL) AND ("cancelledAt" IS NULL) = ("cancelledByName" IS NULL)
      AND ("cancelReason" IS NULL OR length(btrim("cancelReason")) BETWEEN 5 AND 300))
);

-- CreateTable
CREATE TABLE "billing_credit_transfers" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "fromTenantId" UUID NOT NULL,
    "toTenantId" UUID NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "authorizedBy" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "proofKey" TEXT,
    "proofMime" TEXT,
    "createdById" UUID,
    "createdByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,

    CONSTRAINT "billing_credit_transfers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "billing_credit_transfers_check" CHECK ("amount" >= 1 AND "fromTenantId" <> "toTenantId" AND length(btrim("authorizedBy")) BETWEEN 5 AND 300
      AND length(btrim("reason")) BETWEEN 5 AND 300 AND ("proofKey" IS NULL) = ("proofMime" IS NULL))
);

-- CreateTable
CREATE TABLE "billing_refunds" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "BillingRefundStatus" NOT NULL DEFAULT 'PENDING',
    "message" TEXT,
    "requestedById" UUID,
    "requestedByName" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "decidedById" UUID,
    "decidedByName" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "refundedOn" DATE,
    "refundMeans" TEXT,
    "refundRef" TEXT,
    "proofKey" TEXT,
    "proofMime" TEXT,
    "decisionIp" TEXT,

    CONSTRAINT "billing_refunds_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "billing_refunds_amount_check" CHECK ("amount" >= 1 AND ("message" IS NULL OR length("message") <= 1000)),
    CONSTRAINT "billing_refunds_decision_check" CHECK (
      ("status" = 'PENDING') = ("decidedAt" IS NULL)
      AND ("status" <> 'REFUNDED' OR ("refundedOn" IS NOT NULL AND "refundMeans" IS NOT NULL AND "refundRef" IS NOT NULL AND "proofKey" IS NOT NULL AND "decidedByName" IS NOT NULL))
      AND ("status" <> 'REFUSED' OR (length(btrim(coalesce("decisionNote", ''))) >= 5 AND "decidedByName" IS NOT NULL AND "refundedOn" IS NULL AND "proofKey" IS NULL))
      AND ("decisionNote" IS NULL OR length("decisionNote") <= 500))
);

-- CreateTable
CREATE TABLE "billing_credit_entries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "currency" TEXT NOT NULL,
    "kind" "BillingCreditEntryKind" NOT NULL,
    "amount" INTEGER NOT NULL,
    "paymentId" UUID,
    "documentId" UUID,
    "refundId" UUID,
    "transferId" UUID,
    "reversesId" UUID,
    "data" JSONB,
    "createdByKind" TEXT NOT NULL,
    "createdById" UUID,
    "createdByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_credit_entries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "billing_credit_entries_creator_check" CHECK ("createdByKind" IN ('system', 'platform', 'school')),
    -- Sens de chaque écriture, et ce qu'elle cite : un trop-perçu cite son paiement, un avoir son document, un
    -- remboursement sa demande, un transfert le sien, une reprise de déduction la déduction reprise.
    CONSTRAINT "billing_credit_entries_kind_check" CHECK (
      CASE "kind"
        WHEN 'PAYMENT_SURPLUS' THEN "amount" > 0 AND "paymentId" IS NOT NULL
        WHEN 'CREDIT_NOTE_SURPLUS' THEN "amount" > 0 AND "documentId" IS NOT NULL
        WHEN 'USE' THEN "amount" < 0
        WHEN 'USE_REVERSED' THEN "amount" > 0 AND "reversesId" IS NOT NULL AND "paymentId" IS NOT NULL
        WHEN 'PAYMENT_CANCELLED' THEN "amount" < 0 AND "paymentId" IS NOT NULL
        WHEN 'REFUND' THEN "amount" < 0 AND "refundId" IS NOT NULL
        WHEN 'TRANSFER_OUT' THEN "amount" < 0 AND "transferId" IS NOT NULL
        WHEN 'TRANSFER_IN' THEN "amount" > 0 AND "transferId" IS NOT NULL
      END)
);

-- CreateTable
CREATE TABLE "billing_allocations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "source" "BillingAllocationSource" NOT NULL,
    "paymentId" UUID,
    "creditNoteId" UUID,
    "creditEntryId" UUID,
    "amount" INTEGER NOT NULL,
    "reversesId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_allocations_pkey" PRIMARY KEY ("id"),
    -- Chaque imputation cite sa source ; une contre-écriture est négative et cite l'imputation qu'elle reprend.
    CONSTRAINT "billing_allocations_source_check" CHECK (
      ("source" = 'PAYMENT') = ("paymentId" IS NOT NULL) AND ("source" = 'CREDIT_NOTE') = ("creditNoteId" IS NOT NULL)
      AND ("source" = 'CREDIT') = ("creditEntryId" IS NOT NULL) AND "amount" <> 0 AND ("amount" < 0) = ("reversesId" IS NOT NULL)
      AND ("source" <> 'CREDIT_NOTE' OR "amount" > 0))
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_payment_means_code_version_key" ON "billing_payment_means"("code", "version");

-- CreateIndex
CREATE UNIQUE INDEX "billing_payments_receiptSeq_key" ON "billing_payments"("receiptSeq");

-- CreateIndex
CREATE UNIQUE INDEX "billing_payments_receiptNumber_key" ON "billing_payments"("receiptNumber");

-- CreateIndex
CREATE INDEX "billing_payments_tenant_id_paidOn_idx" ON "billing_payments"("tenant_id", "paidOn");

-- CreateIndex
CREATE INDEX "billing_payments_documentId_idx" ON "billing_payments"("documentId");

-- CreateIndex
CREATE INDEX "billing_credit_transfers_group_id_createdAt_idx" ON "billing_credit_transfers"("group_id", "createdAt");

-- CreateIndex
CREATE INDEX "billing_refunds_tenant_id_requestedAt_idx" ON "billing_refunds"("tenant_id", "requestedAt");

-- CreateIndex
CREATE INDEX "billing_credit_entries_tenant_id_createdAt_idx" ON "billing_credit_entries"("tenant_id", "createdAt");

-- CreateIndex
CREATE INDEX "billing_allocations_documentId_idx" ON "billing_allocations"("documentId");

-- CreateIndex
CREATE INDEX "billing_allocations_tenant_id_idx" ON "billing_allocations"("tenant_id");

-- AddForeignKey
ALTER TABLE "billing_payments" ADD CONSTRAINT "billing_payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_payments" ADD CONSTRAINT "billing_payments_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "school_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_payments" ADD CONSTRAINT "billing_payments_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "billing_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_payments" ADD CONSTRAINT "billing_payments_meansId_fkey" FOREIGN KEY ("meansId") REFERENCES "billing_payment_means"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_transfers" ADD CONSTRAINT "billing_credit_transfers_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "school_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_transfers" ADD CONSTRAINT "billing_credit_transfers_fromTenantId_fkey" FOREIGN KEY ("fromTenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_transfers" ADD CONSTRAINT "billing_credit_transfers_toTenantId_fkey" FOREIGN KEY ("toTenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_refunds" ADD CONSTRAINT "billing_refunds_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_entries" ADD CONSTRAINT "billing_credit_entries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_entries" ADD CONSTRAINT "billing_credit_entries_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "billing_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_entries" ADD CONSTRAINT "billing_credit_entries_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "billing_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_entries" ADD CONSTRAINT "billing_credit_entries_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "billing_refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_entries" ADD CONSTRAINT "billing_credit_entries_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "billing_credit_transfers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_credit_entries" ADD CONSTRAINT "billing_credit_entries_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "billing_credit_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_allocations" ADD CONSTRAINT "billing_allocations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_allocations" ADD CONSTRAINT "billing_allocations_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "billing_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_allocations" ADD CONSTRAINT "billing_allocations_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "billing_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_allocations" ADD CONSTRAINT "billing_allocations_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "billing_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_allocations" ADD CONSTRAINT "billing_allocations_creditEntryId_fkey" FOREIGN KEY ("creditEntryId") REFERENCES "billing_credit_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_allocations" ADD CONSTRAINT "billing_allocations_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "billing_allocations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Une même référence de transaction ne s'enregistre qu'une fois (prévention des doubles encaissements), sauf pour
-- ressaisir un paiement dont la saisie a été annulée ; une seule demande de remboursement en attente par établissement ;
-- l'imputation d'un paiement n'est reprise qu'une fois (une déduction de crédit peut l'être en plusieurs fois, jamais
-- au-delà de son montant : contrôlé par cancel_billing_payment).
CREATE UNIQUE INDEX "billing_payments_transaction_once" ON "billing_payments"("transactionKey") WHERE "cancelledAt" IS NULL;
CREATE UNIQUE INDEX "billing_refunds_one_pending" ON "billing_refunds"("tenant_id") WHERE "status" = 'PENDING';
CREATE UNIQUE INDEX "billing_allocations_payment_reversed_once" ON "billing_allocations"("reversesId") WHERE "reversesId" IS NOT NULL AND "source" = 'PAYMENT';

-- Contrôle « même école » (SEC-001) : une imputation, une écriture de crédit, une reprise citent toujours un paiement,
-- une demande ou une écriture du même établissement.
SELECT install_same_tenant_checks();

-- Ajout seul : moyens de paiement (versions), imputations, écritures de crédit et transferts ne se modifient ni ne
-- s'effacent, même par le propriétaire de la base (test 24 : aucune modification rétroactive).
CREATE TRIGGER billing_payment_means_append_only BEFORE UPDATE OR DELETE ON billing_payment_means FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER billing_allocations_append_only BEFORE UPDATE OR DELETE ON billing_allocations FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER billing_credit_entries_append_only BEFORE UPDATE OR DELETE ON billing_credit_entries FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER billing_credit_transfers_append_only BEFORE UPDATE OR DELETE ON billing_credit_transfers FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER billing_payments_no_delete BEFORE DELETE ON billing_payments FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER billing_refunds_no_delete BEFORE DELETE ON billing_refunds FOR EACH ROW EXECUTE FUNCTION forbid_change();
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing_payment_means', 'billing_payments', 'billing_allocations', 'billing_credit_entries', 'billing_credit_transfers', 'billing_refunds'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION forbid_change()', t || '_no_truncate', t);
  END LOOP;
END $$;

-- Un paiement enregistré ne change plus ; seule son annulation (contre-écriture motivée, datée, signée) s'inscrit, une fois.
CREATE OR REPLACE FUNCTION billing_payments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."cancelledAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Un paiement annulé ne change plus';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.group_id, NEW."documentId", NEW.currency, NEW."expectedAmount", NEW.amount, NEW."paidOn", NEW."meansId", NEW."meansName",
      NEW."transactionRef", NEW."transactionKey", NEW."proofKey", NEW."proofMime", NEW.note, NEW."receiptSeq", NEW."receiptNumber", NEW."creditAmount",
      NEW."recordedById", NEW."recordedByName", NEW."recordedAt", NEW.ip)
     IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.group_id, OLD."documentId", OLD.currency, OLD."expectedAmount", OLD.amount, OLD."paidOn", OLD."meansId",
      OLD."meansName", OLD."transactionRef", OLD."transactionKey", OLD."proofKey", OLD."proofMime", OLD.note, OLD."receiptSeq", OLD."receiptNumber",
      OLD."creditAmount", OLD."recordedById", OLD."recordedByName", OLD."recordedAt", OLD.ip) THEN
    RAISE EXCEPTION 'Un paiement enregistré ne se modifie pas : une erreur de saisie s''annule par une contre-écriture';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_payments_guard BEFORE UPDATE ON billing_payments FOR EACH ROW EXECUTE FUNCTION billing_payments_guard();

-- Une demande de remboursement ne change plus ; seule la décision de Cahiora s'y inscrit, une fois.
CREATE OR REPLACE FUNCTION billing_refunds_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'La décision sur une demande de remboursement ne change plus';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.currency, NEW.amount, NEW.message, NEW."requestedById", NEW."requestedByName", NEW."requestedAt", NEW.ip)
     IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.currency, OLD.amount, OLD.message, OLD."requestedById", OLD."requestedByName", OLD."requestedAt", OLD.ip) THEN
    RAISE EXCEPTION 'Une demande de remboursement ne se modifie pas : seule la décision s''inscrit';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_refunds_guard BEFORE UPDATE ON billing_refunds FOR EACH ROW EXECUTE FUNCTION billing_refunds_guard();

-- Row Level Security : zone de la plateforme (propriétaire et erp_platform, en lecture seule par ses droits). Les écoles
-- lisent leur part par leurs fonctions ci-dessous ; le rôle des groupes et celui des statistiques n'ont aucun droit.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing_payment_means', 'billing_payments', 'billing_allocations', 'billing_credit_entries', 'billing_credit_transfers', 'billing_refunds'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I TO erp_owner USING (true) WITH CHECK (true)', t || '_owner_all', t);
    EXECUTE format('CREATE POLICY %I ON %I TO PUBLIC USING (current_user = %L) WITH CHECK (current_user = %L)', t || '_platform_all', t, 'erp_platform', 'erp_platform');
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    REVOKE ALL ON billing_payment_means, billing_payments, billing_allocations, billing_credit_entries, billing_credit_transfers, billing_refunds FROM erp_app;
  END IF;
END $$;

-- ---------------------------------------------------------------- Soldes

-- Documents que paie un établissement : proformas de l'abonnement à payer (total au-delà de 0) adressées à lui seul ;
-- le paiement d'un document de plusieurs établissements attend les décisions D-G5-19 et D-G5-32. Avoirs imputés,
-- paiements et crédits imputés (contre-écritures déduites), reste à payer ; du plus ancien au plus récent.
CREATE OR REPLACE FUNCTION billing_payable_documents(p_tenant uuid) RETURNS TABLE (
  document_id uuid, reference text, issue_date date, due_date date, created_at timestamp, total integer, credited integer, paid integer, balance integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.id, d.reference, d."issueDate", d."dueDate", d."createdAt", d.total, x.credited, x.paid, greatest(0, d.total - x.credited - x.paid)
  FROM billing_documents d
  CROSS JOIN LATERAL (
    SELECT coalesce(sum(a.amount) FILTER (WHERE a.source = 'CREDIT_NOTE'), 0)::integer AS credited,
           coalesce(sum(a.amount) FILTER (WHERE a.source <> 'CREDIT_NOTE'), 0)::integer AS paid
    FROM billing_allocations a WHERE a."documentId" = d.id
  ) x
  WHERE d.kind = 'SUBSCRIPTION' AND d.total > 0
    AND EXISTS (SELECT 1 FROM billing_document_lines l WHERE l."documentId" = d.id AND l.tenant_id = p_tenant)
    AND NOT EXISTS (SELECT 1 FROM billing_document_lines l WHERE l."documentId" = d.id AND l.tenant_id <> p_tenant)
  ORDER BY d."issueDate", d."createdAt", d.reference
$$;

-- Crédit d'un établissement : somme de ses écritures ; réservé : sa demande de remboursement en attente.
CREATE OR REPLACE FUNCTION billing_credit_balance(p_tenant uuid) RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(sum(e.amount), 0)::integer FROM billing_credit_entries e WHERE e.tenant_id = p_tenant
$$;
CREATE OR REPLACE FUNCTION billing_credit_reserved(p_tenant uuid) RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(sum(r.amount), 0)::integer FROM billing_refunds r WHERE r.tenant_id = p_tenant AND r.status = 'PENDING'
$$;

-- Document qui a ouvert le délai de grâce (choix 2 A) : le document de l'abonnement du comptage de la fin de la
-- gratuité la plus récente (essai ou pilote) ; son reste à payer décide du retour à l'accès complet.
CREATE OR REPLACE FUNCTION billing_grace_document(p_tenant uuid) RETURNS TABLE (document_id uuid, reference text, balance integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.document_id, p.reference, p.balance
  FROM billing_document_lines l
  JOIN billing_documents d ON d.id = l."documentId"
  JOIN billing_payable_documents(p_tenant) p ON p.document_id = d.id
  WHERE l.tenant_id = p_tenant AND d.kind = 'SUBSCRIPTION' AND l."countKind" IN ('TRIAL_END', 'PILOT_END')
  ORDER BY l."referenceDate" DESC, d."createdAt" DESC
  LIMIT 1
$$;

-- Imputation (choix 1 A), sans rien écrire : d'abord le document indiqué, puis les autres documents à payer de
-- l'établissement, du plus ancien au plus récent, jusqu'au montant ; le reste devient un crédit (calculé par l'appelant).
CREATE OR REPLACE FUNCTION billing_plan_allocations(p_tenant uuid, p_amount integer, p_indicated uuid)
  RETURNS TABLE (document_id uuid, amount integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_left integer := p_amount;
  r record;
BEGIN
  FOR r IN
    SELECT p.document_id AS id, p.balance FROM billing_payable_documents(p_tenant) p
    WHERE p.balance > 0
    ORDER BY (p.document_id IS NOT DISTINCT FROM p_indicated) DESC, p.issue_date, p.created_at, p.reference
  LOOP
    EXIT WHEN v_left <= 0;
    document_id := r.id;
    amount := least(v_left, r.balance);
    v_left := v_left - amount;
    RETURN NEXT;
  END LOOP;
END $$;

-- Écrit une imputation déjà calculée (tableaux parallèles de documents et de montants).
CREATE OR REPLACE FUNCTION billing_write_allocations(
  p_tenant uuid, p_docs uuid[], p_amounts integer[], p_source text, p_payment uuid, p_credit_note uuid, p_entry uuid, p_now timestamp) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO billing_allocations (id, tenant_id, "documentId", source, "paymentId", "creditNoteId", "creditEntryId", amount, "createdAt")
    SELECT gen_random_uuid(), p_tenant, x.doc, p_source::"BillingAllocationSource", p_payment, p_credit_note, p_entry, x.amount, p_now
    FROM unnest(p_docs, p_amounts) AS x(doc, amount)
    WHERE x.amount > 0;
END $$;

-- ---------------------------------------------------------------- Moyens de paiement (verrou 2)

-- Nouvelle version d'un moyen de paiement (rôle de la plateforme seulement, verrou 1 vérifié par l'API) : nouveau moyen
-- (code libre) ou version suivante d'un moyen existant, même monnaie ; date d'effet à partir d'aujourd'hui (une date
-- passée ne change jamais ce qui a été vu), au plus un an plus tard ; motif obligatoire. Nom et coordonnées viennent
-- de Dankou : aucune valeur n'est proposée ici.
CREATE OR REPLACE FUNCTION add_billing_payment_means(
  p_code text, p_new boolean, p_name text, p_instructions text, p_currency text, p_active boolean, p_effective date, p_reason text,
  p_admin uuid, p_admin_name text, p_today date)
  RETURNS TABLE (means_id uuid, means_code text, means_version integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid := gen_random_uuid();
  v_version integer;
  v_currency text;
BEGIN
  IF p_code IS NULL OR p_code !~ '^[A-Z0-9_]{1,40}$' OR p_new IS NULL OR p_active IS NULL OR p_effective IS NULL OR p_today IS NULL OR p_currency IS NULL
     OR coalesce(btrim(p_admin_name), '') = '' THEN
    RAISE EXCEPTION 'CAHIORA: moyen de paiement incomplet';
  END IF;
  IF length(btrim(coalesce(p_name, ''))) NOT BETWEEN 2 AND 80 THEN
    RAISE EXCEPTION 'CAHIORA: nom du moyen de paiement : 2 à 80 caractères';
  END IF;
  IF length(btrim(coalesce(p_instructions, ''))) NOT BETWEEN 5 AND 1000 THEN
    RAISE EXCEPTION 'CAHIORA: coordonnées et instructions pour les établissements : 5 à 1 000 caractères';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 5 AND 300 THEN
    RAISE EXCEPTION 'CAHIORA: motif : 5 à 300 caractères';
  END IF;
  IF p_effective < p_today THEN
    RAISE EXCEPTION 'CAHIORA: la date d''effet ne peut pas être passée';
  END IF;
  IF p_effective > p_today + 366 THEN
    RAISE EXCEPTION 'CAHIORA: date d''effet : au plus un an après aujourd''hui';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cahiora-billing-means'), hashtext(p_code));
  SELECT max(m.version), min(m.currency) INTO v_version, v_currency FROM billing_payment_means m WHERE m.code = p_code;
  IF p_new AND v_version IS NOT NULL THEN
    RAISE EXCEPTION 'CAHIORA: un moyen de paiement porte déjà ce nom : modifiez-le plutôt';
  END IF;
  IF NOT p_new AND v_version IS NULL THEN
    RAISE EXCEPTION 'CAHIORA: moyen de paiement inconnu';
  END IF;
  IF v_currency IS NOT NULL AND v_currency <> p_currency THEN
    RAISE EXCEPTION 'CAHIORA: un moyen de paiement garde sa monnaie (%)', v_currency;
  END IF;
  INSERT INTO billing_payment_means (id, code, version, name, instructions, currency, active, "effectiveFrom", reason, "createdById", "createdByName", "createdAt")
    VALUES (v_id, p_code, coalesce(v_version, 0) + 1, btrim(p_name), btrim(p_instructions), p_currency, p_active, p_effective, btrim(p_reason), p_admin,
            btrim(p_admin_name), timezone('UTC', now()));
  RETURN QUERY SELECT v_id, p_code, coalesce(v_version, 0) + 1;
END $$;

-- ---------------------------------------------------------------- Paiements

-- Enregistre un paiement reçu (rôle de la plateforme seulement, verrou 1 vérifié par l'API). La base refait chaque
-- contrôle : établissement et document concerné (proforma de l'abonnement à payer, adressée à lui seul, dans sa
-- monnaie), montant entier, date ni future ni avant le document, moyen de paiement activé le jour du paiement (verrou 2),
-- référence jamais enregistrée (sauf saisie annulée), justificatif ; puis l'imputation (choix 1 A), le crédit du surplus
-- et le numéro du reçu provisoire, dans la suite PROV-REC-…, sans trou ni doublon. L'API écrit les journaux et règle
-- l'accès dans la même transaction.
CREATE OR REPLACE FUNCTION record_billing_payment(
  p_tenant uuid, p_document uuid, p_amount integer, p_paid_on date, p_means_code text, p_reference text, p_proof_key text, p_proof_mime text,
  p_note text, p_admin uuid, p_admin_name text, p_ip text, p_today date)
  RETURNS TABLE (payment_id uuid, receipt_number text, expected integer, allocated integer, credit integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid := gen_random_uuid();
  v_now timestamp := timezone('UTC', now());
  v_key text := upper(regexp_replace(coalesce(p_reference, ''), '\s+', '', 'g'));
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_docs uuid[] := '{}';
  v_amounts integer[] := '{}';
  v_allocated integer := 0;
  v_expected integer;
  v_seq integer;
  v_number text;
  t record;
  d record;
  m record;
  x record;
BEGIN
  IF p_tenant IS NULL OR p_document IS NULL OR p_amount IS NULL OR p_paid_on IS NULL OR p_means_code IS NULL OR p_today IS NULL
     OR coalesce(btrim(p_admin_name), '') = '' THEN
    RAISE EXCEPTION 'CAHIORA: paiement incomplet';
  END IF;
  IF p_amount < 1 OR p_amount > 1000000000 THEN
    RAISE EXCEPTION 'CAHIORA: montant reçu : nombre entier de 1 à 1 000 000 000';
  END IF;
  IF length(btrim(coalesce(p_reference, ''))) NOT BETWEEN 3 AND 100 THEN
    RAISE EXCEPTION 'CAHIORA: référence de la transaction : 3 à 100 caractères';
  END IF;
  IF coalesce(btrim(p_proof_key), '') = '' OR coalesce(btrim(p_proof_mime), '') = '' THEN
    RAISE EXCEPTION 'CAHIORA: justificatif du paiement absent';
  END IF;
  IF length(v_note) > 500 THEN
    RAISE EXCEPTION 'CAHIORA: commentaire : 500 caractères au plus';
  END IF;
  SELECT tn.id, tn.name, tn.group_id, tn.currency INTO t FROM tenants tn WHERE tn.id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CAHIORA: établissement inconnu';
  END IF;
  SELECT * INTO d FROM billing_documents bd WHERE bd.id = p_document;
  IF NOT FOUND OR d.kind <> 'SUBSCRIPTION' OR d.total <= 0 THEN
    RAISE EXCEPTION 'CAHIORA: document concerné : une proforma de l''abonnement à payer est attendue';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM billing_document_lines l WHERE l."documentId" = d.id AND l.tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'CAHIORA: ce document n''est pas adressé à cet établissement';
  END IF;
  IF EXISTS (SELECT 1 FROM billing_document_lines l WHERE l."documentId" = d.id AND l.tenant_id <> p_tenant) THEN
    RAISE EXCEPTION 'CAHIORA: document de plusieurs établissements : son paiement attend les décisions D-G5-19 et D-G5-32';
  END IF;
  IF d.currency <> t.currency THEN
    RAISE EXCEPTION 'CAHIORA: le document et l''établissement n''ont pas la même monnaie';
  END IF;
  IF p_paid_on > p_today THEN
    RAISE EXCEPTION 'CAHIORA: la date du paiement ne peut pas être dans le futur';
  END IF;
  IF p_paid_on < d."issueDate" THEN
    RAISE EXCEPTION 'CAHIORA: un paiement ne précède pas le document qu''il règle';
  END IF;
  -- Verrou 2 : le moyen de paiement en vigueur le jour du paiement doit être activé, dans la monnaie de l'établissement.
  SELECT * INTO m FROM billing_payment_means pm WHERE pm.code = p_means_code AND pm."effectiveFrom" <= p_paid_on
   ORDER BY pm."effectiveFrom" DESC, pm.version DESC LIMIT 1;
  IF NOT FOUND OR NOT m.active THEN
    RAISE EXCEPTION 'CAHIORA: ce moyen de paiement n''était pas activé par Cahiora le jour du paiement';
  END IF;
  IF m.currency <> t.currency THEN
    RAISE EXCEPTION 'CAHIORA: ce moyen de paiement est prévu pour une autre monnaie';
  END IF;
  -- Le solde de l'établissement, puis la suite des reçus : deux saisies ne se calculent jamais en même temps.
  PERFORM pg_advisory_xact_lock(hashtext('cahiora-billing-balance'), hashtext(p_tenant::text));
  PERFORM pg_advisory_xact_lock(hashtext('cahiora-billing-receipt'), 0);
  IF EXISTS (SELECT 1 FROM billing_payments bp WHERE bp."transactionKey" = v_key AND bp."cancelledAt" IS NULL) THEN
    RAISE EXCEPTION 'CAHIORA: cette référence de transaction est déjà enregistrée : un même paiement ne s''enregistre qu''une fois';
  END IF;
  SELECT p.balance INTO v_expected FROM billing_payable_documents(p_tenant) p WHERE p.document_id = p_document;
  FOR x IN SELECT * FROM billing_plan_allocations(p_tenant, p_amount, p_document) LOOP
    v_docs := v_docs || x.document_id;
    v_amounts := v_amounts || x.amount;
    v_allocated := v_allocated + x.amount;
  END LOOP;
  SELECT coalesce(max(bp."receiptSeq"), 0) + 1 INTO v_seq FROM billing_payments bp;
  v_number := 'PROV-REC-' || CASE WHEN v_seq < 1000000 THEN lpad(v_seq::text, 6, '0') ELSE v_seq::text END;
  INSERT INTO billing_payments (id, tenant_id, group_id, "documentId", currency, "expectedAmount", amount, "paidOn", "meansId", "meansName", "transactionRef",
                                "transactionKey", "proofKey", "proofMime", note, "receiptSeq", "receiptNumber", "creditAmount", "recordedById", "recordedByName",
                                "recordedAt", ip)
    VALUES (v_id, p_tenant, t.group_id, p_document, t.currency, coalesce(v_expected, 0), p_amount, p_paid_on, m.id, m.name, btrim(p_reference), v_key,
            p_proof_key, p_proof_mime, v_note, v_seq, v_number, p_amount - v_allocated, p_admin, btrim(p_admin_name), v_now, p_ip);
  PERFORM billing_write_allocations(p_tenant, v_docs, v_amounts, 'PAYMENT', v_id, NULL, NULL, v_now);
  IF p_amount > v_allocated THEN
    INSERT INTO billing_credit_entries (id, tenant_id, currency, kind, amount, "paymentId", data, "createdByKind", "createdById", "createdByName", "createdAt")
      VALUES (gen_random_uuid(), p_tenant, t.currency, 'PAYMENT_SURPLUS', p_amount - v_allocated, v_id, jsonb_build_object('receiptNumber', v_number),
              'platform', p_admin, btrim(p_admin_name), v_now);
  END IF;
  RETURN QUERY SELECT v_id, v_number, coalesce(v_expected, 0), v_allocated, p_amount - v_allocated;
END $$;

-- Annule la saisie d'un paiement (contre-écriture motivée, une seule fois) : ses imputations sont reprises par des
-- lignes négatives ; son trop-perçu est retiré du crédit, d'abord du crédit disponible, puis en reprenant les
-- déductions de crédit les plus récentes (leurs documents attendent à nouveau leur paiement). Un trop-perçu remboursé,
-- transféré ou réservé par une demande de remboursement ne revient pas : l'annulation est alors refusée. Rien n'est
-- supprimé : le reçu reste, marqué annulé.
CREATE OR REPLACE FUNCTION cancel_billing_payment(p_payment uuid, p_reason text, p_admin uuid, p_admin_name text, p_ip text)
  RETURNS TABLE (tenant_id uuid, receipt_number text, reversed integer, credit_reversed integer, uses_reversed integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_now timestamp := timezone('UTC', now());
  v_available integer;
  v_need integer;
  v_part integer;
  v_left integer;
  v_take integer;
  v_entry uuid;
  v_uses integer := 0;
  v_reversed integer := 0;
  p record;
  u record;
  a record;
BEGIN
  IF p_payment IS NULL OR coalesce(btrim(p_admin_name), '') = '' THEN
    RAISE EXCEPTION 'CAHIORA: annulation incomplète';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 5 AND 300 THEN
    RAISE EXCEPTION 'CAHIORA: motif de l''annulation : 5 à 300 caractères';
  END IF;
  SELECT * INTO p FROM billing_payments bp WHERE bp.id = p_payment;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CAHIORA: paiement inconnu';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cahiora-billing-balance'), hashtext(p.tenant_id::text));
  SELECT * INTO p FROM billing_payments bp WHERE bp.id = p_payment FOR UPDATE;
  IF p."cancelledAt" IS NOT NULL THEN
    RAISE EXCEPTION 'CAHIORA: ce paiement est déjà annulé';
  END IF;
  IF p."creditAmount" > 0 THEN
    v_available := greatest(0, billing_credit_balance(p.tenant_id) - billing_credit_reserved(p.tenant_id));
    v_need := p."creditAmount" - v_available;
    -- Reprise des déductions de crédit les plus récentes, document le plus récent d'abord.
    FOR u IN
      SELECT e.id, e."createdAt", -e.amount - coalesce((SELECT sum(r.amount) FROM billing_credit_entries r WHERE r."reversesId" = e.id), 0) AS remaining
      FROM billing_credit_entries e WHERE e.tenant_id = p.tenant_id AND e.kind = 'USE'
      ORDER BY e."createdAt" DESC, e.id DESC
    LOOP
      EXIT WHEN v_need <= 0;
      CONTINUE WHEN u.remaining <= 0;
      v_part := least(v_need, u.remaining);
      v_entry := gen_random_uuid();
      INSERT INTO billing_credit_entries (id, tenant_id, currency, kind, amount, "paymentId", "reversesId", data, "createdByKind", "createdById", "createdByName", "createdAt")
        VALUES (v_entry, p.tenant_id, p.currency, 'USE_REVERSED', v_part, p.id, u.id, jsonb_build_object('receiptNumber', p."receiptNumber"), 'platform', p_admin,
                btrim(p_admin_name), v_now);
      v_left := v_part;
      FOR a IN
        SELECT al.id, al."documentId", al.amount - coalesce((SELECT -sum(r.amount) FROM billing_allocations r WHERE r."reversesId" = al.id), 0) AS remaining
        FROM billing_allocations al JOIN billing_documents d ON d.id = al."documentId"
        WHERE al."creditEntryId" = u.id AND al.amount > 0
        ORDER BY d."issueDate" DESC, d."createdAt" DESC, d.reference DESC
      LOOP
        EXIT WHEN v_left <= 0;
        CONTINUE WHEN a.remaining <= 0;
        v_take := least(v_left, a.remaining);
        INSERT INTO billing_allocations (id, tenant_id, "documentId", source, "creditEntryId", amount, "reversesId", "createdAt")
          VALUES (gen_random_uuid(), p.tenant_id, a."documentId", 'CREDIT', v_entry, -v_take, a.id, v_now);
        v_left := v_left - v_take;
      END LOOP;
      IF v_left > 0 THEN
        RAISE EXCEPTION 'CAHIORA: déduction de crédit incohérente : annulation refusée';
      END IF;
      v_need := v_need - v_part;
      v_uses := v_uses + v_part;
    END LOOP;
    IF v_need > 0 THEN
      RAISE EXCEPTION 'CAHIORA: le trop-perçu de ce paiement a déjà été remboursé, transféré ou réservé par une demande de remboursement : il ne peut plus être repris, l''annulation est refusée';
    END IF;
    INSERT INTO billing_credit_entries (id, tenant_id, currency, kind, amount, "paymentId", data, "createdByKind", "createdById", "createdByName", "createdAt")
      VALUES (gen_random_uuid(), p.tenant_id, p.currency, 'PAYMENT_CANCELLED', -p."creditAmount", p.id, jsonb_build_object('receiptNumber', p."receiptNumber"),
              'platform', p_admin, btrim(p_admin_name), v_now);
  END IF;
  FOR a IN SELECT al.id, al."documentId", al.amount FROM billing_allocations al WHERE al."paymentId" = p.id AND al.amount > 0 LOOP
    INSERT INTO billing_allocations (id, tenant_id, "documentId", source, "paymentId", amount, "reversesId", "createdAt")
      VALUES (gen_random_uuid(), p.tenant_id, a."documentId", 'PAYMENT', p.id, -a.amount, a.id, v_now);
    v_reversed := v_reversed + a.amount;
  END LOOP;
  UPDATE billing_payments SET "cancelledAt" = v_now, "cancelledById" = p_admin, "cancelledByName" = btrim(p_admin_name), "cancelReason" = btrim(p_reason), "cancelIp" = p_ip
   WHERE id = p.id;
  IF billing_credit_balance(p.tenant_id) < 0 THEN
    RAISE EXCEPTION 'CAHIORA: crédit négatif : annulation refusée';
  END IF;
  RETURN QUERY SELECT p.tenant_id, p."receiptNumber", v_reversed, p."creditAmount", v_uses;
END $$;

-- ---------------------------------------------------------------- Crédits

-- Déduit le crédit disponible de l'établissement de ses documents à payer, du plus ancien au plus récent (D-G5-15 A) :
-- une écriture de déduction et ses imputations ; le reste est reporté. Le montant d'une demande de remboursement en
-- attente reste réservé. Sans crédit disponible ni document à payer, rien n'est écrit.
CREATE OR REPLACE FUNCTION apply_billing_credit(p_tenant uuid, p_by_kind text, p_by_id uuid, p_by_name text)
  RETURNS TABLE (entry_id uuid, used integer, documents jsonb)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_now timestamp := timezone('UTC', now());
  v_entry uuid := gen_random_uuid();
  v_available integer;
  v_docs uuid[] := '{}';
  v_amounts integer[] := '{}';
  v_used integer := 0;
  v_currency text;
  x record;
BEGIN
  IF p_tenant IS NULL OR p_by_kind IS NULL OR p_by_kind NOT IN ('system', 'platform', 'school') OR coalesce(btrim(p_by_name), '') = '' THEN
    RAISE EXCEPTION 'CAHIORA: déduction du crédit incomplète';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cahiora-billing-balance'), hashtext(p_tenant::text));
  v_available := greatest(0, billing_credit_balance(p_tenant) - billing_credit_reserved(p_tenant));
  IF v_available <= 0 THEN
    RETURN;
  END IF;
  FOR x IN SELECT * FROM billing_plan_allocations(p_tenant, v_available, NULL) LOOP
    v_docs := v_docs || x.document_id;
    v_amounts := v_amounts || x.amount;
    v_used := v_used + x.amount;
  END LOOP;
  IF v_used <= 0 THEN
    RETURN;
  END IF;
  SELECT currency INTO v_currency FROM tenants WHERE id = p_tenant;
  INSERT INTO billing_credit_entries (id, tenant_id, currency, kind, amount, data, "createdByKind", "createdById", "createdByName", "createdAt")
    VALUES (v_entry, p_tenant, v_currency, 'USE', -v_used,
            jsonb_build_object('documents', (SELECT jsonb_agg(jsonb_build_object('documentId', u.doc, 'reference', d.reference, 'amount', u.amount) ORDER BY u.n)
                                               FROM unnest(v_docs, v_amounts) WITH ORDINALITY AS u(doc, amount, n) JOIN billing_documents d ON d.id = u.doc)),
            p_by_kind, p_by_id, btrim(p_by_name), v_now);
  PERFORM billing_write_allocations(p_tenant, v_docs, v_amounts, 'CREDIT', NULL, NULL, v_entry, v_now);
  RETURN QUERY SELECT v_entry, v_used, (SELECT e.data->'documents' FROM billing_credit_entries e WHERE e.id = v_entry);
END $$;

-- Impute un avoir (lot G5c) une seule fois : d'abord le document qu'il corrige, puis les autres documents à payer de
-- l'établissement, du plus ancien au plus récent (choix 1 A) ; au-delà de ce qui reste à payer, le crédit de
-- l'établissement (un avoir émis après un paiement complet : trop-perçu). L'avoir d'un document de plusieurs
-- établissements n'est pas imputé : comme le paiement de ce document, il attend les décisions D-G5-19 et D-G5-32 (aucune
-- ligne n'est rendue, rien n'est écrit).
CREATE OR REPLACE FUNCTION impute_billing_credit_note(p_document uuid)
  RETURNS TABLE (tenant_id uuid, allocated integer, credit integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_now timestamp := timezone('UTC', now());
  v_tenant uuid;
  v_docs uuid[] := '{}';
  v_amounts integer[] := '{}';
  v_allocated integer := 0;
  d record;
  x record;
BEGIN
  SELECT * INTO d FROM billing_documents bd WHERE bd.id = p_document;
  IF NOT FOUND OR d.kind <> 'CREDIT_NOTE' THEN
    RAISE EXCEPTION 'CAHIORA: avoir inconnu';
  END IF;
  SELECT l.tenant_id INTO v_tenant FROM billing_document_lines l WHERE l."documentId" = d.id LIMIT 1;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'CAHIORA: avoir sans ligne';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cahiora-billing-balance'), hashtext(v_tenant::text));
  IF EXISTS (SELECT 1 FROM billing_allocations a WHERE a."creditNoteId" = d.id)
     OR EXISTS (SELECT 1 FROM billing_credit_entries e WHERE e."documentId" = d.id AND e.kind = 'CREDIT_NOTE_SURPLUS') THEN
    RAISE EXCEPTION 'CAHIORA: cet avoir est déjà imputé';
  END IF;
  IF EXISTS (SELECT 1 FROM billing_document_lines l WHERE l."documentId" = d.id AND l.tenant_id <> v_tenant)
     OR NOT EXISTS (SELECT 1 FROM billing_payable_documents(v_tenant) p WHERE p.document_id = d."relatedDocumentId") THEN
    RETURN;
  END IF;
  FOR x IN SELECT * FROM billing_plan_allocations(v_tenant, d.total, d."relatedDocumentId") LOOP
    v_docs := v_docs || x.document_id;
    v_amounts := v_amounts || x.amount;
    v_allocated := v_allocated + x.amount;
  END LOOP;
  PERFORM billing_write_allocations(v_tenant, v_docs, v_amounts, 'CREDIT_NOTE', NULL, d.id, NULL, v_now);
  IF d.total > v_allocated THEN
    INSERT INTO billing_credit_entries (id, tenant_id, currency, kind, amount, "documentId", data, "createdByKind", "createdById", "createdByName", "createdAt")
      VALUES (gen_random_uuid(), v_tenant, d.currency, 'CREDIT_NOTE_SURPLUS', d.total - v_allocated, d.id, jsonb_build_object('reference', d.reference),
              d."createdByKind", d."createdById", d."createdByName", v_now);
  END IF;
  RETURN QUERY SELECT v_tenant, v_allocated, d.total - v_allocated;
END $$;

-- ---------------------------------------------------------------- Remboursements

-- Demande de remboursement de la direction de tout l'établissement (D-G5-15 A) : école indépendante (D-G5-19 encore
-- ouverte pour l'école d'un groupe), une seule demande en attente, au plus le crédit disponible, qui en est aussitôt
-- réservé. Horodatée et inscrite dans les journaux de la plateforme et du groupe, avec une alerte pour le Super Admin ;
-- l'API trace le journal de l'école. Verrou 1 vérifié par l'API.
CREATE OR REPLACE FUNCTION request_billing_refund(p_user uuid, p_user_name text, p_amount integer, p_message text, p_ip text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant uuid := app_current_tenant();
  v_now timestamp := timezone('UTC', now());
  v_id uuid := gen_random_uuid();
  v_message text := nullif(btrim(coalesce(p_message, '')), '');
  v_available integer;
  t record;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'CAHIORA: école courante absente';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM user_roles r JOIN users u ON u.id = r."userId"
    WHERE r."userId" = p_user AND r.tenant_id = v_tenant AND r.role = 'DIRECTION' AND r."siteId" IS NULL AND u.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'CAHIORA: seule la direction de tout l''établissement demande un remboursement';
  END IF;
  IF NOT coalesce(current_tenant_sees_billing_documents(), false) THEN
    RAISE EXCEPTION 'CAHIORA: ce que voit la direction d''un établissement de groupe attend la décision D-G5-19';
  END IF;
  IF length(v_message) > 1000 THEN
    RAISE EXCEPTION 'CAHIORA: message : 1 000 caractères au plus';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cahiora-billing-balance'), hashtext(v_tenant::text));
  IF EXISTS (SELECT 1 FROM billing_refunds r WHERE r.tenant_id = v_tenant AND r.status = 'PENDING') THEN
    RAISE EXCEPTION 'CAHIORA: une demande de remboursement attend déjà la décision de Cahiora';
  END IF;
  IF p_amount IS NULL OR p_amount < 1 THEN
    RAISE EXCEPTION 'CAHIORA: montant : nombre entier d''au moins 1';
  END IF;
  v_available := greatest(0, billing_credit_balance(v_tenant) - billing_credit_reserved(v_tenant));
  IF v_available <= 0 THEN
    RAISE EXCEPTION 'CAHIORA: aucun crédit disponible à rembourser';
  END IF;
  IF p_amount > v_available THEN
    RAISE EXCEPTION 'CAHIORA: montant : au plus le crédit disponible (%)', v_available;
  END IF;
  SELECT tn.id, tn.name, tn.group_id, tn.currency INTO t FROM tenants tn WHERE tn.id = v_tenant;
  INSERT INTO billing_refunds (id, tenant_id, currency, amount, status, message, "requestedById", "requestedByName", "requestedAt", ip)
    VALUES (v_id, v_tenant, t.currency, p_amount, 'PENDING', v_message, p_user, p_user_name, v_now, p_ip);
  INSERT INTO platform_alerts (id, tenant_id, kind, message, "dueDate", "createdAt")
    VALUES (gen_random_uuid(), v_tenant, 'REFUND_REQUEST',
            format('%s demande le remboursement de %s %s de son crédit (demande de %s). Décidez dans Commercial et facturation › Avoirs et crédits.',
                   t.name, regexp_replace(p_amount::text, '(\d)(?=(\d{3})+$)', '\1 ', 'g'),
                   CASE WHEN t.currency IN ('XOF', 'XAF') THEN 'FCFA' ELSE t.currency END, p_user_name), NULL, v_now);
  INSERT INTO platform_audit_logs (id, action, "tenantId", data, ip, "createdAt")
    VALUES (gen_random_uuid(), 'billing.refund_requested', v_tenant, jsonb_build_object('refundId', v_id, 'amount', p_amount, 'currency', t.currency, 'by', p_user_name), p_ip, v_now);
  INSERT INTO group_audit_logs (id, group_id, "actorKind", "actorId", "actorName", action, data, "createdAt")
    VALUES (gen_random_uuid(), t.group_id, 'school', p_user, p_user_name, 'billing.refund_requested',
            jsonb_build_object('tenantName', t.name, 'refundId', v_id, 'amount', p_amount, 'currency', t.currency), v_now);
  RETURN v_id;
END $$;

-- Décision du Super Admin sur une demande de remboursement, une seule fois : remboursement avec sa preuve (date ni
-- future ni avant la demande, moyen, référence, justificatif), qui retire le montant du crédit ; ou refus motivé, qui
-- libère le montant réservé. Un crédit consommé entre-temps ne se rembourse pas.
CREATE OR REPLACE FUNCTION decide_billing_refund(
  p_refund uuid, p_decision text, p_note text, p_refunded_on date, p_means text, p_reference text, p_proof_key text, p_proof_mime text,
  p_admin uuid, p_admin_name text, p_ip text, p_today date)
  RETURNS TABLE (refund_tenant uuid, refund_status text, refund_amount integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_now timestamp := timezone('UTC', now());
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  r record;
BEGIN
  IF p_refund IS NULL OR p_decision IS NULL OR p_today IS NULL OR coalesce(btrim(p_admin_name), '') = '' THEN
    RAISE EXCEPTION 'CAHIORA: décision incomplète';
  END IF;
  SELECT * INTO r FROM billing_refunds br WHERE br.id = p_refund;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CAHIORA: demande de remboursement inconnue';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cahiora-billing-balance'), hashtext(r.tenant_id::text));
  SELECT * INTO r FROM billing_refunds br WHERE br.id = p_refund FOR UPDATE;
  IF r.status <> 'PENDING' THEN
    RAISE EXCEPTION 'CAHIORA: cette demande est déjà décidée';
  END IF;
  IF length(v_note) > 500 THEN
    RAISE EXCEPTION 'CAHIORA: note : 500 caractères au plus';
  END IF;
  IF p_decision = 'REFUSED' THEN
    IF length(coalesce(v_note, '')) < 5 THEN
      RAISE EXCEPTION 'CAHIORA: un refus exige un motif (5 caractères au moins)';
    END IF;
    UPDATE billing_refunds SET status = 'REFUSED', "decidedById" = p_admin, "decidedByName" = btrim(p_admin_name), "decidedAt" = v_now, "decisionNote" = v_note,
                               "decisionIp" = p_ip
     WHERE id = r.id;
  ELSIF p_decision = 'REFUNDED' THEN
    IF p_refunded_on IS NULL OR p_refunded_on > p_today THEN
      RAISE EXCEPTION 'CAHIORA: date du remboursement : ni vide ni dans le futur';
    END IF;
    IF p_refunded_on < r."requestedAt"::date THEN
      RAISE EXCEPTION 'CAHIORA: un remboursement ne précède pas la demande';
    END IF;
    IF length(btrim(coalesce(p_means, ''))) NOT BETWEEN 2 AND 80 THEN
      RAISE EXCEPTION 'CAHIORA: moyen du remboursement : 2 à 80 caractères';
    END IF;
    IF length(btrim(coalesce(p_reference, ''))) NOT BETWEEN 3 AND 100 THEN
      RAISE EXCEPTION 'CAHIORA: référence du remboursement : 3 à 100 caractères';
    END IF;
    IF coalesce(btrim(p_proof_key), '') = '' OR coalesce(btrim(p_proof_mime), '') = '' THEN
      RAISE EXCEPTION 'CAHIORA: preuve du remboursement absente';
    END IF;
    IF billing_credit_balance(r.tenant_id) < r.amount THEN
      RAISE EXCEPTION 'CAHIORA: le crédit de l''établissement ne couvre plus ce montant : un crédit consommé ne se rembourse pas';
    END IF;
    INSERT INTO billing_credit_entries (id, tenant_id, currency, kind, amount, "refundId", data, "createdByKind", "createdById", "createdByName", "createdAt")
      VALUES (gen_random_uuid(), r.tenant_id, r.currency, 'REFUND', -r.amount, r.id,
              jsonb_build_object('refundedOn', p_refunded_on, 'means', btrim(p_means), 'reference', btrim(p_reference)), 'platform', p_admin, btrim(p_admin_name), v_now);
    UPDATE billing_refunds SET status = 'REFUNDED', "decidedById" = p_admin, "decidedByName" = btrim(p_admin_name), "decidedAt" = v_now, "decisionNote" = v_note,
                               "refundedOn" = p_refunded_on, "refundMeans" = btrim(p_means), "refundRef" = btrim(p_reference), "proofKey" = p_proof_key,
                               "proofMime" = p_proof_mime, "decisionIp" = p_ip
     WHERE id = r.id;
  ELSE
    RAISE EXCEPTION 'CAHIORA: décision inconnue';
  END IF;
  IF billing_credit_balance(r.tenant_id) < 0 THEN
    RAISE EXCEPTION 'CAHIORA: crédit négatif : décision refusée';
  END IF;
  RETURN QUERY SELECT r.tenant_id, p_decision, r.amount;
END $$;

-- ---------------------------------------------------------------- Transferts dans un groupe

-- Transfert d'un crédit entre deux établissements d'un même groupe et de la même monnaie (§9) : au plus le crédit
-- disponible, avec l'autorisation (qui l'a donnée, par quel écrit) et un motif ; deux écritures et le transfert, dans la
-- même transaction. Les deux soldes sont verrouillés dans un ordre fixe.
CREATE OR REPLACE FUNCTION transfer_billing_credit(
  p_from uuid, p_to uuid, p_amount integer, p_authorized_by text, p_reason text, p_proof_key text, p_proof_mime text, p_admin uuid, p_admin_name text, p_ip text)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid := gen_random_uuid();
  v_now timestamp := timezone('UTC', now());
  v_available integer;
  f record;
  t record;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_amount IS NULL OR coalesce(btrim(p_admin_name), '') = '' THEN
    RAISE EXCEPTION 'CAHIORA: transfert incomplet';
  END IF;
  IF p_from = p_to THEN
    RAISE EXCEPTION 'CAHIORA: choisissez un autre établissement que celui qui cède le crédit';
  END IF;
  SELECT tn.id, tn.name, tn.group_id, tn.currency INTO f FROM tenants tn WHERE tn.id = p_from;
  SELECT tn.id, tn.name, tn.group_id, tn.currency INTO t FROM tenants tn WHERE tn.id = p_to;
  IF f.id IS NULL OR t.id IS NULL THEN
    RAISE EXCEPTION 'CAHIORA: établissement inconnu';
  END IF;
  IF f.group_id <> t.group_id THEN
    RAISE EXCEPTION 'CAHIORA: un crédit ne se transfère qu''entre établissements d''un même groupe';
  END IF;
  IF f.currency <> t.currency THEN
    RAISE EXCEPTION 'CAHIORA: les deux établissements n''ont pas la même monnaie';
  END IF;
  IF length(btrim(coalesce(p_authorized_by, ''))) NOT BETWEEN 5 AND 300 THEN
    RAISE EXCEPTION 'CAHIORA: autorisation : qui l''a donnée et par quel écrit (5 à 300 caractères)';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 5 AND 300 THEN
    RAISE EXCEPTION 'CAHIORA: motif : 5 à 300 caractères';
  END IF;
  IF p_amount < 1 THEN
    RAISE EXCEPTION 'CAHIORA: montant : nombre entier d''au moins 1';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cahiora-billing-balance'), hashtext(least(p_from::text, p_to::text)));
  PERFORM pg_advisory_xact_lock(hashtext('cahiora-billing-balance'), hashtext(greatest(p_from::text, p_to::text)));
  v_available := greatest(0, billing_credit_balance(p_from) - billing_credit_reserved(p_from));
  IF p_amount > v_available THEN
    RAISE EXCEPTION 'CAHIORA: montant : au plus le crédit disponible (%)', v_available;
  END IF;
  INSERT INTO billing_credit_transfers (id, group_id, "fromTenantId", "toTenantId", currency, amount, "authorizedBy", reason, "proofKey", "proofMime", "createdById",
                                        "createdByName", "createdAt", ip)
    VALUES (v_id, f.group_id, p_from, p_to, f.currency, p_amount, btrim(p_authorized_by), btrim(p_reason), p_proof_key, p_proof_mime, p_admin, btrim(p_admin_name), v_now, p_ip);
  INSERT INTO billing_credit_entries (id, tenant_id, currency, kind, amount, "transferId", data, "createdByKind", "createdById", "createdByName", "createdAt") VALUES
    (gen_random_uuid(), p_from, f.currency, 'TRANSFER_OUT', -p_amount, v_id, jsonb_build_object('toTenantId', p_to, 'toName', t.name), 'platform', p_admin, btrim(p_admin_name), v_now),
    (gen_random_uuid(), p_to, f.currency, 'TRANSFER_IN', p_amount, v_id, jsonb_build_object('fromTenantId', p_from, 'fromName', f.name), 'platform', p_admin, btrim(p_admin_name), v_now);
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------- Lectures de l'école courante (app.tenant_id)
-- École indépendante seulement (D-G5-19 encore ouverte pour l'école d'un groupe de plusieurs établissements) ; jamais le
-- nom de l'agent de Cahiora, le justificatif, le commentaire interne ni le motif d'une annulation.

-- État du paiement de chaque document à payer de l'école.
CREATE OR REPLACE FUNCTION current_tenant_billing_balances() RETURNS TABLE (document_id uuid, total integer, credited integer, paid integer, balance integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.document_id, p.total, p.credited, p.paid, p.balance
  FROM billing_payable_documents(app_current_tenant()) p
  WHERE coalesce(current_tenant_sees_billing_documents(), false)
$$;

-- Reçus provisoires de l'école, les plus récents d'abord, avec l'imputation de chaque paiement.
CREATE OR REPLACE FUNCTION current_tenant_billing_payments() RETURNS TABLE (
  id uuid, receipt_number text, document_reference text, currency text, expected_amount integer, amount integer, paid_on date, means_name text,
  transaction_ref text, credit_amount integer, recorded_at timestamp, cancelled_at timestamp, allocations jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.id, p."receiptNumber", d.reference, p.currency, p."expectedAmount", p.amount, p."paidOn", p."meansName", p."transactionRef", p."creditAmount",
         p."recordedAt", p."cancelledAt",
         coalesce((SELECT jsonb_agg(jsonb_build_object('reference', ad.reference, 'amount', a.amount) ORDER BY ad."issueDate", ad."createdAt")
                   FROM billing_allocations a JOIN billing_documents ad ON ad.id = a."documentId"
                   WHERE a."paymentId" = p.id AND a.amount > 0), '[]'::jsonb)
  FROM billing_payments p JOIN billing_documents d ON d.id = p."documentId"
  WHERE p.tenant_id = app_current_tenant() AND coalesce(current_tenant_sees_billing_documents(), false)
  ORDER BY p."recordedAt" DESC
  LIMIT 200
$$;

-- Écritures du crédit de l'école, les plus récentes d'abord (paiement ou document cités par leur référence).
CREATE OR REPLACE FUNCTION current_tenant_billing_credit_entries() RETURNS TABLE (
  id uuid, kind text, amount integer, currency text, created_at timestamp, receipt_number text, document_reference text, documents jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.id, e.kind::text, e.amount, e.currency, e."createdAt", p."receiptNumber", d.reference, e.data->'documents'
  FROM billing_credit_entries e
  LEFT JOIN billing_payments p ON p.id = e."paymentId"
  LEFT JOIN billing_documents d ON d.id = e."documentId"
  WHERE e.tenant_id = app_current_tenant() AND coalesce(current_tenant_sees_billing_documents(), false)
  ORDER BY e."createdAt" DESC, e.id
  LIMIT 200
$$;

-- Demandes de remboursement de l'école et décisions de Cahiora (signées « Cahiora »).
CREATE OR REPLACE FUNCTION current_tenant_billing_refunds() RETURNS TABLE (
  id uuid, amount integer, currency text, status text, message text, requested_by_name text, requested_at timestamp, decided_at timestamp, decision_note text,
  refunded_on date, refund_means text, refund_ref text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.id, r.amount, r.currency, r.status::text, r.message, r."requestedByName", r."requestedAt", r."decidedAt", r."decisionNote", r."refundedOn", r."refundMeans", r."refundRef"
  FROM billing_refunds r
  WHERE r.tenant_id = app_current_tenant() AND coalesce(current_tenant_sees_billing_documents(), false)
  ORDER BY r."requestedAt" DESC
  LIMIT 50
$$;

-- Moyens de paiement activés par Cahiora un jour donné, dans la monnaie de l'école (l'API ne les montre qu'avec le
-- verrou 1 ouvert).
CREATE OR REPLACE FUNCTION current_tenant_payment_means(p_day date) RETURNS TABLE (code text, name text, instructions text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT v.code, v.name, v.instructions
  FROM (
    SELECT DISTINCT ON (m.code) m.code, m.name, m.instructions, m.active, m.currency
    FROM billing_payment_means m
    WHERE m."effectiveFrom" <= p_day
    ORDER BY m.code, m."effectiveFrom" DESC, m.version DESC
  ) v
  JOIN tenants t ON t.id = app_current_tenant() AND t.currency = v.currency
  WHERE v.active AND coalesce(current_tenant_sees_billing_documents(), false)
  ORDER BY v.name
$$;

-- Les avoirs déjà émis (lot G5c) sont imputés une fois, dans l'ordre de leur émission : lignes ajoutées seulement, sans
-- paiement existant (aucun avant ce lot) ; une ligne du journal de la plateforme les compte. Rien d'autre n'est écrit.
DO $$
DECLARE
  c record;
  r record;
  n_total int := 0;
  n_imputed int := 0;
  v_credit int := 0;
BEGIN
  FOR c IN SELECT d.id FROM billing_documents d WHERE d.kind = 'CREDIT_NOTE' ORDER BY d."createdAt", d.reference LOOP
    n_total := n_total + 1;
    FOR r IN SELECT * FROM impute_billing_credit_note(c.id) LOOP
      n_imputed := n_imputed + 1;
      v_credit := v_credit + r.credit;
    END LOOP;
  END LOOP;
  INSERT INTO platform_audit_logs (id, action, "tenantId", data)
    VALUES (gen_random_uuid(), 'billing.credit_notes_imputed', NULL,
            jsonb_build_object('source', 'migration paiements_g5d2', 'creditNotes', n_total, 'imputed', n_imputed, 'awaitingGroupDecision', n_total - n_imputed,
                               'creditLeft', v_credit));
END $$;

REVOKE ALL ON FUNCTION billing_payable_documents(uuid), billing_credit_balance(uuid), billing_credit_reserved(uuid), billing_grace_document(uuid),
  billing_plan_allocations(uuid, integer, uuid), billing_write_allocations(uuid, uuid[], integer[], text, uuid, uuid, uuid, timestamp),
  add_billing_payment_means(text, boolean, text, text, text, boolean, date, text, uuid, text, date),
  record_billing_payment(uuid, uuid, integer, date, text, text, text, text, text, uuid, text, text, date), cancel_billing_payment(uuid, text, uuid, text, text),
  apply_billing_credit(uuid, text, uuid, text), impute_billing_credit_note(uuid), request_billing_refund(uuid, text, integer, text, text),
  decide_billing_refund(uuid, text, text, date, text, text, text, text, uuid, text, text, date),
  transfer_billing_credit(uuid, uuid, integer, text, text, text, text, uuid, text, text), current_tenant_billing_balances(), current_tenant_billing_payments(),
  current_tenant_billing_credit_entries(), current_tenant_billing_refunds(), current_tenant_payment_means(date) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT EXECUTE ON FUNCTION current_tenant_billing_balances(), current_tenant_billing_payments(), current_tenant_billing_credit_entries(),
      current_tenant_billing_refunds(), current_tenant_payment_means(date), request_billing_refund(uuid, text, integer, text, text) TO erp_app;
  END IF;
END $$;

-- Rôle de la plateforme : lecture des tables du lot, écritures par les seules fonctions ci-dessus ; aucune écriture
-- directe. infra/postgres/role-plateforme.sh appelle cette fonction avec les autres à chaque installation.
CREATE OR REPLACE FUNCTION grant_platform_payments_role() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_platform') THEN
    RAISE NOTICE 'Rôle erp_platform absent : droits non attribués (poste de développement)';
    RETURN;
  END IF;
  GRANT SELECT ON billing_payment_means, billing_payments, billing_allocations, billing_credit_entries, billing_credit_transfers, billing_refunds TO erp_platform;
  GRANT EXECUTE ON FUNCTION billing_payable_documents(uuid), billing_credit_balance(uuid), billing_credit_reserved(uuid), billing_grace_document(uuid),
    billing_plan_allocations(uuid, integer, uuid), add_billing_payment_means(text, boolean, text, text, text, boolean, date, text, uuid, text, date),
    record_billing_payment(uuid, uuid, integer, date, text, text, text, text, text, uuid, text, text, date), cancel_billing_payment(uuid, text, uuid, text, text),
    apply_billing_credit(uuid, text, uuid, text), impute_billing_credit_note(uuid),
    decide_billing_refund(uuid, text, text, date, text, text, text, text, uuid, text, text, date),
    transfer_billing_credit(uuid, uuid, integer, text, text, text, text, uuid, text, text) TO erp_platform;
END $$;

SELECT grant_platform_payments_role();
