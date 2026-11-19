-- Lot G5c · documents provisoires de Cahiora : proformas de l'abonnement (première facture, compléments des
-- régularisations, relevés à 0 F), avoirs, devis et proformas de prestations. Aucun n'est une facture fiscale :
-- cahier des charges du lot G5 (14 novembre 2026), §16 ; les factures fiscales attendent les informations légales et
-- fiscales (lot G5f). Chaque document porte une référence provisoire, jamais un numéro de facture.
-- Le client d'un document est le groupe (compte client, lot G1) : une école indépendante est un groupe d'un seul
-- établissement ; une ligne par établissement (décision du 11 novembre 2026).
-- Ajout seul : un document émis et ses lignes ne se modifient ni ne s'effacent, même par le propriétaire de la base.
-- Exclusions après un document (D-G5-13 B, D-G5-14 A) : les fonctions de demande et de décision des corrections du
-- lot G5b sont remplacées (une exclusion se demande encore jusqu'à 30 jours après le document concerné, et le Super Admin
-- décide celle qui touche un document émis) ; l'avoir qui en suit est émis par issue_billing_document.
-- Aucune donnée existante n'est modifiée, aucun document n'est créé ici : l'API les émet par issue_billing_document,
-- qui refait les contrôles et les calculs.
-- Tout s'applique en une seule transaction : en cas d'erreur, rien n'est changé.

-- CreateEnum
CREATE TYPE "BillingDocumentKind" AS ENUM ('SUBSCRIPTION', 'CREDIT_NOTE', 'SERVICE_QUOTE', 'SERVICE_PROFORMA');

-- CreateTable
CREATE TABLE "billing_documents" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "kind" "BillingDocumentKind" NOT NULL,
    "reference" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "issueDate" DATE NOT NULL,
    "dueDate" DATE,
    "total" INTEGER NOT NULL,
    "yearLabel" TEXT,
    "relatedDocumentId" UUID,
    "data" JSONB NOT NULL,
    "createdByKind" TEXT NOT NULL,
    "createdById" UUID,
    "createdByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_documents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "billing_documents_total_check" CHECK ("total" >= 0),
    CONSTRAINT "billing_documents_creator_check" CHECK ("createdByKind" IN ('system', 'platform'))
);

-- CreateTable
CREATE TABLE "billing_document_lines" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "countId" UUID,
    "countKind" "BillingCountKind",
    "referenceDate" DATE,
    "pupils" INTEGER,
    "pupilsChange" INTEGER,
    "pricePerPupil" INTEGER,
    "minimum" INTEGER,
    "minimumApplied" BOOLEAN,
    "fullYear" INTEGER,
    "shareMonths" INTEGER,
    "shareOf" INTEGER,
    "yearAmount" INTEGER,
    "alreadyBilled" INTEGER,
    "relatedLineId" UUID,
    "correctionId" UUID,
    "serviceId" UUID,
    "serviceName" TEXT,
    "quantity" INTEGER,
    "unitPrice" INTEGER,
    "priceBasis" TEXT,

    CONSTRAINT "billing_document_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "billing_document_lines_amount_check" CHECK ("amount" >= 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_documents_reference_key" ON "billing_documents"("reference");

-- CreateIndex
CREATE INDEX "billing_documents_group_id_issueDate_idx" ON "billing_documents"("group_id", "issueDate");

-- CreateIndex
CREATE UNIQUE INDEX "billing_document_lines_countId_key" ON "billing_document_lines"("countId");

-- CreateIndex
CREATE UNIQUE INDEX "billing_document_lines_correctionId_key" ON "billing_document_lines"("correctionId");

-- CreateIndex
CREATE UNIQUE INDEX "billing_document_lines_documentId_position_key" ON "billing_document_lines"("documentId", "position");

-- CreateIndex
CREATE INDEX "billing_document_lines_tenant_id_idx" ON "billing_document_lines"("tenant_id");

-- AddForeignKey
ALTER TABLE "billing_documents" ADD CONSTRAINT "billing_documents_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "school_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_documents" ADD CONSTRAINT "billing_documents_relatedDocumentId_fkey" FOREIGN KEY ("relatedDocumentId") REFERENCES "billing_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_document_lines" ADD CONSTRAINT "billing_document_lines_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "billing_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_document_lines" ADD CONSTRAINT "billing_document_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_document_lines" ADD CONSTRAINT "billing_document_lines_countId_fkey" FOREIGN KEY ("countId") REFERENCES "billing_counts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_document_lines" ADD CONSTRAINT "billing_document_lines_relatedLineId_fkey" FOREIGN KEY ("relatedLineId") REFERENCES "billing_document_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_document_lines" ADD CONSTRAINT "billing_document_lines_correctionId_fkey" FOREIGN KEY ("correctionId") REFERENCES "count_corrections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_document_lines" ADD CONSTRAINT "billing_document_lines_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Contrôle « même école » (SEC-001) : un comptage, une ligne touchée ou une exclusion cités par une ligne sont toujours
-- ceux de l'établissement de la ligne.
SELECT install_same_tenant_checks();

-- Ajout seul : un document émis et ses lignes ne se modifient ni ne s'effacent, même par le propriétaire de la base
-- (tests 15 et 24 du cahier des charges : un tarif changé ne touche aucun document ; aucune modification rétroactive).
CREATE TRIGGER billing_documents_append_only BEFORE UPDATE OR DELETE ON billing_documents FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER billing_document_lines_append_only BEFORE UPDATE OR DELETE ON billing_document_lines FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER billing_documents_no_truncate BEFORE TRUNCATE ON billing_documents FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER billing_document_lines_no_truncate BEFORE TRUNCATE ON billing_document_lines FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- Row Level Security : zone de la plateforme (propriétaire et erp_platform, en lecture seule par ses droits).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing_documents', 'billing_document_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I TO erp_owner USING (true) WITH CHECK (true)', t || '_owner_all', t);
    EXECUTE format('CREATE POLICY %I ON %I TO PUBLIC USING (current_user = %L) WITH CHECK (current_user = %L)', t || '_platform_all', t, 'erp_platform', 'erp_platform');
  END LOOP;
END $$;

-- Droits : les écoles (erp_app) ne lisent les documents que par current_tenant_billing_documents ; le rôle des groupes
-- et celui des statistiques n'ont aucun droit.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    REVOKE ALL ON billing_documents, billing_document_lines FROM erp_app;
  END IF;
END $$;

-- Déjà demandé à un établissement pour une année : lignes d'abonnement, moins les avoirs.
CREATE OR REPLACE FUNCTION billing_already_billed(p_tenant uuid, p_year text) RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (coalesce(sum(l.amount) FILTER (WHERE d.kind = 'SUBSCRIPTION'), 0) - coalesce(sum(l.amount) FILTER (WHERE d.kind = 'CREDIT_NOTE'), 0))::integer
  FROM billing_document_lines l JOIN billing_documents d ON d.id = l."documentId"
  WHERE l.tenant_id = p_tenant AND d."yearLabel" = p_year AND d.kind IN ('SUBSCRIPTION', 'CREDIT_NOTE')
$$;

-- Montant retenu pour une année : MAX(élèves × prix ; minimum), réduit par la part de la première année, au franc
-- inférieur quand elle ne tombe pas juste (l'API n'émet un tel montant qu'une fois l'arrondi décidé).
CREATE OR REPLACE FUNCTION billing_year_amount(p_pupils integer, p_price integer, p_minimum integer, p_months integer, p_of integer) RETURNS integer
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN p_months IS NULL OR p_months = p_of THEN greatest(p_pupils::bigint * p_price, p_minimum)
              ELSE floor(greatest(p_pupils::bigint * p_price, p_minimum) * p_months / p_of::numeric) END::integer
$$;


-- Émet un document provisoire (rôle de la plateforme seulement : tâche planifiée ou Super Admin). L'API calcule les
-- lignes (amounts-rules.ts) ; la base refait les contrôles et les calculs avant d'écrire quoi que ce soit :
-- - client et établissements : chaque ligne porte un établissement du groupe, dans la monnaie du document ;
-- - abonnement : comptage figé de l'établissement et de l'année, une seule fois (jamais facturé deux fois : test 8),
--   conditions commerciales acceptées (D-G5-1), fin de la dernière période gratuite seulement pour un comptage de fin
--   d'essai ou de pilote (une période gratuite n'est jamais facturée), même date pour toutes les lignes (des dates
--   différentes attendent D-G5-31), un établissement une seule fois, élèves = cumul du comptage figé moins les
--   exclusions validées depuis, montant de l'année, déjà demandé, écart d'élèves (avec le document ou l'avoir précédent)
--   et complément recalculés (D-G5-10 A) ;
-- - avoir : une ligne, pour une exclusion validée par le Super Admin après le document touché (D-G5-13 B), une seule
--   fois ; elle touche la ligne de l'établissement dans son dernier document d'abonnement de l'année, avec ses prix et sa
--   part ; élèves = élèves facturables de ce comptage, exclusions validées retirées ; montant = déjà demandé moins le
--   montant de l'année recalculé, au moins 1 (au minimum, rien ne change : aucun avoir) ; règle du 13 novembre 2026 ;
-- - devis et proformas de prestations : prestation du catalogue, quantité, prix unitaire, montant = quantité × prix ;
--   une proforma peut reprendre un devis du même client.
-- Un document lié (avoir, proforma d'un devis) n'est jamais daté avant le document qu'il reprend. Total = somme des
-- lignes. Référence provisoire « PROV-… », jamais un numéro de facture (G5f).
CREATE OR REPLACE FUNCTION issue_billing_document(
  p_group uuid, p_kind text, p_currency text, p_issue date, p_due date, p_year text, p_related uuid, p_data jsonb, p_lines jsonb,
  p_by_kind text, p_by_id uuid, p_by_name text)
  RETURNS TABLE (document_id uuid, document_reference text, document_total integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid := gen_random_uuid();
  v_ref text := 'PROV-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  v_kind "BillingDocumentKind";
  v_total bigint := 0;
  v_date date;
  v_last_free date;
  v_billed integer;
  v_prev integer;
  v_status text;
  v_lines integer;
  rel record;
  l record;
  c record;
  k record;
  rl record;
BEGIN
  IF p_group IS NULL OR p_kind IS NULL OR p_currency IS NULL OR p_issue IS NULL OR p_data IS NULL OR jsonb_typeof(p_data) <> 'object'
     OR p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0
     OR p_by_kind IS NULL OR p_by_kind NOT IN ('system', 'platform') OR coalesce(btrim(p_by_name), '') = '' THEN
    RAISE EXCEPTION 'CAHIORA: document incomplet';
  END IF;
  IF p_kind NOT IN ('SUBSCRIPTION', 'CREDIT_NOTE', 'SERVICE_QUOTE', 'SERVICE_PROFORMA') THEN
    RAISE EXCEPTION 'CAHIORA: type de document inconnu';
  END IF;
  v_kind := p_kind::"BillingDocumentKind";
  v_lines := jsonb_array_length(p_lines);
  IF NOT EXISTS (SELECT 1 FROM school_groups g WHERE g.id = p_group) THEN
    RAISE EXCEPTION 'CAHIORA: client inconnu';
  END IF;
  IF p_due IS NOT NULL AND p_due < p_issue THEN
    RAISE EXCEPTION 'CAHIORA: échéance avant la date du document';
  END IF;
  IF v_kind IN ('SUBSCRIPTION', 'CREDIT_NOTE') AND p_year IS NULL THEN
    RAISE EXCEPTION 'CAHIORA: année scolaire absente';
  END IF;
  IF v_kind = 'CREDIT_NOTE' AND v_lines <> 1 THEN
    RAISE EXCEPTION 'CAHIORA: un avoir a une seule ligne, pour une seule exclusion';
  END IF;
  IF v_kind = 'SUBSCRIPTION' AND (SELECT count(*) <> count(DISTINCT x."tenantId") FROM jsonb_to_recordset(p_lines) AS x("tenantId" uuid)) THEN
    RAISE EXCEPTION 'CAHIORA: un établissement figure une seule fois dans un document d''abonnement';
  END IF;
  -- Deux documents d'un même client ne se calculent jamais en même temps : le déjà demandé reste juste.
  PERFORM pg_advisory_xact_lock(hashtext('cahiora-billing-document'), hashtext(p_group::text));

  -- Document lié : un avoir touche un document d'abonnement ; une proforma de prestations peut reprendre un devis.
  IF p_related IS NOT NULL THEN
    SELECT * INTO rel FROM billing_documents d WHERE d.id = p_related;
    IF NOT FOUND OR rel.group_id <> p_group THEN
      RAISE EXCEPTION 'CAHIORA: document lié inconnu pour ce client';
    END IF;
    IF (v_kind = 'CREDIT_NOTE' AND (rel.kind <> 'SUBSCRIPTION' OR rel."yearLabel" IS DISTINCT FROM p_year))
       OR (v_kind = 'SERVICE_PROFORMA' AND rel.kind <> 'SERVICE_QUOTE')
       OR v_kind IN ('SUBSCRIPTION', 'SERVICE_QUOTE') THEN
      RAISE EXCEPTION 'CAHIORA: ce document ne peut pas être lié à celui-ci';
    END IF;
    IF p_issue < rel."issueDate" THEN
      RAISE EXCEPTION 'CAHIORA: un document n''est jamais daté avant le document auquel il est lié';
    END IF;
  ELSIF v_kind = 'CREDIT_NOTE' THEN
    RAISE EXCEPTION 'CAHIORA: un avoir touche toujours un document émis';
  END IF;

  -- Premier passage : contrôles et calculs de chaque ligne, sans rien écrire.
  FOR l IN
    SELECT e.n::integer AS n, x.*
    FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS e(v, n),
         jsonb_to_record(e.v) AS x("tenantId" uuid, label text, amount integer, "countId" uuid, pupils integer, "pupilsChange" integer,
                                   "pricePerPupil" integer, minimum integer, "minimumApplied" boolean, "fullYear" integer, "shareMonths" integer,
                                   "shareOf" integer, "yearAmount" integer, "alreadyBilled" integer, "relatedLineId" uuid, "correctionId" uuid,
                                   "serviceId" uuid, "serviceName" text, quantity integer, "unitPrice" integer, "priceBasis" text)
    ORDER BY e.n
  LOOP
    IF l."tenantId" IS NULL OR coalesce(btrim(l.label), '') = '' OR l.amount IS NULL OR l.amount < 0 THEN
      RAISE EXCEPTION 'CAHIORA: ligne % incomplète', l.n;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = l."tenantId" AND t.group_id = p_group AND t.currency = p_currency) THEN
      RAISE EXCEPTION 'CAHIORA: ligne % : établissement hors de ce client ou d''une autre monnaie', l.n;
    END IF;

    IF v_kind IN ('SUBSCRIPTION', 'CREDIT_NOTE') THEN
      IF l.pupils IS NULL OR l."pupilsChange" IS NULL OR l."pricePerPupil" IS NULL OR l.minimum IS NULL OR l."minimumApplied" IS NULL
         OR l."fullYear" IS NULL OR l."yearAmount" IS NULL OR l."alreadyBilled" IS NULL OR l.pupils < 0 OR l."pricePerPupil" < 1 OR l.minimum < 0
         OR (l."shareMonths" IS NULL) <> (l."shareOf" IS NULL) OR (l."shareMonths" IS NOT NULL AND (l."shareMonths" < 1 OR l."shareMonths" > l."shareOf"))
         OR l."serviceId" IS NOT NULL OR l.quantity IS NOT NULL OR l."unitPrice" IS NOT NULL THEN
        RAISE EXCEPTION 'CAHIORA: ligne % : calcul incomplet', l.n;
      END IF;
      IF l."fullYear" <> greatest(l.pupils::bigint * l."pricePerPupil", l.minimum)
         OR l."minimumApplied" <> (l.minimum > l.pupils::bigint * l."pricePerPupil")
         OR l."yearAmount" <> billing_year_amount(l.pupils, l."pricePerPupil", l.minimum, l."shareMonths", l."shareOf") THEN
        RAISE EXCEPTION 'CAHIORA: ligne % : montant de l''année faux', l.n;
      END IF;
      v_billed := billing_already_billed(l."tenantId", p_year);
      IF l."alreadyBilled" <> v_billed THEN
        RAISE EXCEPTION 'CAHIORA: ligne % : déjà demandé faux (% au lieu de %)', l.n, l."alreadyBilled", v_billed;
      END IF;
    END IF;

    IF v_kind = 'SUBSCRIPTION' THEN
      IF l."countId" IS NULL OR l."relatedLineId" IS NOT NULL OR l."correctionId" IS NOT NULL THEN
        RAISE EXCEPTION 'CAHIORA: ligne % : une ligne d''abonnement vient d''un comptage figé', l.n;
      END IF;
      SELECT * INTO c FROM billing_counts b WHERE b.id = l."countId";
      IF NOT FOUND OR c.tenant_id <> l."tenantId" OR c.stage <> 'FROZEN' OR c."yearLabel" <> p_year THEN
        RAISE EXCEPTION 'CAHIORA: ligne % : comptage figé de cet établissement et de cette année attendu', l.n;
      END IF;
      IF EXISTS (SELECT 1 FROM billing_document_lines x WHERE x."countId" = c.id) THEN
        RAISE EXCEPTION 'CAHIORA: ligne % : ce comptage a déjà son document', l.n;
      END IF;
      SELECT s.status::text INTO v_status FROM subscriptions s WHERE s.tenant_id = l."tenantId";
      IF v_status IS NULL OR v_status NOT IN ('AWAITING_PAYMENT', 'ACTIVE', 'LIMITED') THEN
        RAISE EXCEPTION 'CAHIORA: ligne % : les conditions commerciales ne sont pas acceptées', l.n;
      END IF;
      SELECT max((e.data->>'lastFreeDay')::date) INTO v_last_free
        FROM subscription_events e JOIN subscriptions s ON s.id = e."subscriptionId"
       WHERE s.tenant_id = l."tenantId" AND e.kind IN ('TRIAL_ENDED', 'PILOT_ENDED');
      IF (c.kind IN ('TRIAL_END', 'PILOT_END') AND c."referenceDate" IS DISTINCT FROM v_last_free)
         OR (c.kind NOT IN ('TRIAL_END', 'PILOT_END') AND v_last_free IS NOT NULL AND c."referenceDate" <= v_last_free) THEN
        RAISE EXCEPTION 'CAHIORA: ligne % : une période gratuite n''est jamais facturée', l.n;
      END IF;
      IF v_date IS NULL THEN
        v_date := c."referenceDate";
      ELSIF v_date <> c."referenceDate" THEN
        RAISE EXCEPTION 'CAHIORA: établissements facturés à des dates différentes : en attente de la décision D-G5-31';
      END IF;
      IF l.pupils <> billing_count_billable(c.id) THEN
        RAISE EXCEPTION 'CAHIORA: ligne % : élèves facturables différents du comptage figé (exclusions validées retirées)', l.n;
      END IF;
      v_prev := NULL;
      SELECT x.pupils INTO v_prev FROM billing_document_lines x JOIN billing_documents d ON d.id = x."documentId"
       WHERE x.tenant_id = l."tenantId" AND d."yearLabel" = p_year AND d.kind IN ('SUBSCRIPTION', 'CREDIT_NOTE')
       ORDER BY x."referenceDate" DESC, d."createdAt" DESC LIMIT 1;
      IF l."pupilsChange" <> l.pupils - coalesce(v_prev, 0) THEN
        RAISE EXCEPTION 'CAHIORA: ligne % : écart d''élèves faux', l.n;
      END IF;
      IF l.amount <> greatest(0, l."yearAmount" - v_billed) THEN
        RAISE EXCEPTION 'CAHIORA: ligne % : complément faux', l.n;
      END IF;

    ELSIF v_kind = 'CREDIT_NOTE' THEN
      IF l."relatedLineId" IS NULL OR l."correctionId" IS NULL OR l."countId" IS NOT NULL OR l.amount < 1 THEN
        RAISE EXCEPTION 'CAHIORA: ligne % : un avoir vient d''une exclusion validée et touche une ligne d''abonnement', l.n;
      END IF;
      SELECT * INTO rl FROM billing_document_lines x WHERE x.id = l."relatedLineId";
      IF NOT FOUND OR rl."documentId" <> p_related OR rl.tenant_id <> l."tenantId" THEN
        RAISE EXCEPTION 'CAHIORA: ligne % : ligne touchée inconnue', l.n;
      END IF;
      -- L'avoir corrige le dernier document d'abonnement de l'établissement pour l'année, avec ses prix et sa part.
      IF EXISTS (SELECT 1 FROM billing_document_lines x JOIN billing_documents d ON d.id = x."documentId"
                 WHERE x.tenant_id = l."tenantId" AND d."yearLabel" = p_year AND d.kind = 'SUBSCRIPTION' AND x.id <> rl.id
                   AND (x."referenceDate" > rl."referenceDate" OR (x."referenceDate" = rl."referenceDate" AND d."createdAt" > rel."createdAt"))) THEN
        RAISE EXCEPTION 'CAHIORA: ligne % : un avoir touche le dernier document d''abonnement de l''établissement pour l''année', l.n;
      END IF;
      IF l."pricePerPupil" <> rl."pricePerPupil" OR l.minimum <> rl.minimum OR l."shareMonths" IS DISTINCT FROM rl."shareMonths"
         OR l."shareOf" IS DISTINCT FROM rl."shareOf" THEN
        RAISE EXCEPTION 'CAHIORA: ligne % : prix, minimum et part de la ligne touchée attendus', l.n;
      END IF;
      PERFORM set_config('app.tenant_id', l."tenantId"::text, true);
      SELECT * INTO k FROM count_corrections x WHERE x.id = l."correctionId";
      IF NOT FOUND OR k.tenant_id <> l."tenantId" OR k.kind <> 'EXCLUSION' OR k.status <> 'VALIDATED' OR k."decidedByKind" IS DISTINCT FROM 'platform'
         OR k."decidedAt" < rel."createdAt" THEN
        RAISE EXCEPTION 'CAHIORA: ligne % : exclusion de cet établissement validée par le Super Admin après ce document attendue', l.n;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM billing_count_items i JOIN billing_counts f ON f.id = i."countId"
                     WHERE i."enrollmentId" = k."enrollmentId" AND i.counted AND f.tenant_id = l."tenantId" AND f."yearLabel" = p_year
                       AND f.stage = 'FROZEN' AND f."referenceDate" <= rl."referenceDate") THEN
        RAISE EXCEPTION 'CAHIORA: ligne % : cette exclusion ne touche pas ce document', l.n;
      END IF;
      IF EXISTS (SELECT 1 FROM billing_document_lines x WHERE x."correctionId" = k.id) THEN
        RAISE EXCEPTION 'CAHIORA: ligne % : cette exclusion a déjà son avoir', l.n;
      END IF;
      IF l.pupils <> billing_count_billable(rl."countId") THEN
        RAISE EXCEPTION 'CAHIORA: ligne % : élèves facturables après l''exclusion faux', l.n;
      END IF;
      v_prev := NULL;
      SELECT x.pupils INTO v_prev FROM billing_document_lines x JOIN billing_documents d ON d.id = x."documentId"
       WHERE x.tenant_id = l."tenantId" AND d."yearLabel" = p_year AND d.kind IN ('SUBSCRIPTION', 'CREDIT_NOTE')
       ORDER BY x."referenceDate" DESC, d."createdAt" DESC LIMIT 1;
      IF l."pupilsChange" <> l.pupils - coalesce(v_prev, 0) THEN
        RAISE EXCEPTION 'CAHIORA: ligne % : écart d''élèves faux', l.n;
      END IF;
      IF l.amount <> v_billed - l."yearAmount" THEN
        RAISE EXCEPTION 'CAHIORA: ligne % : montant de l''avoir faux', l.n;
      END IF;

    ELSE
      IF l."serviceId" IS NULL OR coalesce(btrim(l."serviceName"), '') = '' OR l.quantity IS NULL OR l.quantity < 1 OR l."unitPrice" IS NULL
         OR l."unitPrice" < 0 OR l."countId" IS NOT NULL OR l."correctionId" IS NOT NULL OR l."relatedLineId" IS NOT NULL OR l.pupils IS NOT NULL THEN
        RAISE EXCEPTION 'CAHIORA: ligne % : prestation, quantité et prix unitaire attendus', l.n;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM services s WHERE s.id = l."serviceId") THEN
        RAISE EXCEPTION 'CAHIORA: ligne % : prestation inconnue', l.n;
      END IF;
      IF l.amount <> l.quantity::bigint * l."unitPrice" THEN
        RAISE EXCEPTION 'CAHIORA: ligne % : montant différent de quantité × prix unitaire', l.n;
      END IF;
    END IF;
    v_total := v_total + l.amount;
  END LOOP;
  IF v_total > 2147483647 THEN
    RAISE EXCEPTION 'CAHIORA: total trop élevé';
  END IF;

  -- Second passage : le document, avec son total, puis ses lignes.
  INSERT INTO billing_documents (id, group_id, kind, reference, currency, "issueDate", "dueDate", total, "yearLabel", "relatedDocumentId", data,
                                 "createdByKind", "createdById", "createdByName", "createdAt")
    VALUES (v_id, p_group, v_kind, v_ref, p_currency, p_issue, p_due, v_total, CASE WHEN v_kind IN ('SUBSCRIPTION', 'CREDIT_NOTE') THEN p_year END,
            p_related, p_data, p_by_kind, p_by_id, btrim(p_by_name), timezone('UTC', now()));
  INSERT INTO billing_document_lines (id, "documentId", tenant_id, position, label, amount, "countId", "countKind", "referenceDate", pupils, "pupilsChange",
                                      "pricePerPupil", minimum, "minimumApplied", "fullYear", "shareMonths", "shareOf", "yearAmount", "alreadyBilled",
                                      "relatedLineId", "correctionId", "serviceId", "serviceName", quantity, "unitPrice", "priceBasis")
    SELECT gen_random_uuid(), v_id, x."tenantId", e.n::integer, btrim(x.label), x.amount, x."countId",
           coalesce(b.kind, r."countKind"), coalesce(b."referenceDate", r."referenceDate"), x.pupils, x."pupilsChange",
           x."pricePerPupil", x.minimum, x."minimumApplied", x."fullYear", x."shareMonths", x."shareOf", x."yearAmount", x."alreadyBilled",
           x."relatedLineId", x."correctionId", x."serviceId", nullif(btrim(x."serviceName"), ''), x.quantity, x."unitPrice", x."priceBasis"
    FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS e(v, n)
    CROSS JOIN LATERAL jsonb_to_record(e.v) AS x("tenantId" uuid, label text, amount integer, "countId" uuid, pupils integer, "pupilsChange" integer,
                                                 "pricePerPupil" integer, minimum integer, "minimumApplied" boolean, "fullYear" integer, "shareMonths" integer,
                                                 "shareOf" integer, "yearAmount" integer, "alreadyBilled" integer, "relatedLineId" uuid, "correctionId" uuid,
                                                 "serviceId" uuid, "serviceName" text, quantity integer, "unitPrice" integer, "priceBasis" text)
    LEFT JOIN billing_counts b ON b.id = x."countId"
    LEFT JOIN billing_document_lines r ON r.id = x."relatedLineId";
  RETURN QUERY SELECT v_id, v_ref, v_total::integer;
END $$;

-- L'école courante voit-elle les documents de Cahiora ? Oui pour une école indépendante (groupe d'un seul
-- établissement) ; une école d'un groupe de plusieurs établissements ne voit encore rien : ce qu'elle verra attend la
-- décision D-G5-19. Ne dit rien d'autre du groupe.
CREATE OR REPLACE FUNCTION current_tenant_sees_billing_documents() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (SELECT count(*) FROM tenants o WHERE o.group_id = t.group_id) = 1 FROM tenants t WHERE t.id = app_current_tenant()
$$;

-- Documents de l'école courante (app.tenant_id), ses lignes seulement, les plus récents d'abord ; rien pour l'école
-- d'un groupe de plusieurs établissements (voir ci-dessus).
CREATE OR REPLACE FUNCTION current_tenant_billing_documents() RETURNS TABLE (
  document_id uuid, kind text, reference text, currency text, issue_date date, due_date date, total integer, year_label text,
  related_document_id uuid, data jsonb, created_at timestamp, line_id uuid, "position" integer, label text, amount integer, count_kind text,
  reference_date date, pupils integer, pupils_change integer, price_per_pupil integer, minimum integer, minimum_applied boolean, full_year integer,
  share_months integer, share_of integer, year_amount integer, already_billed integer, service_name text, quantity integer, unit_price integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.id, d.kind::text, d.reference, d.currency, d."issueDate", d."dueDate", d.total, d."yearLabel", d."relatedDocumentId", d.data, d."createdAt",
         l.id, l.position, l.label, l.amount, l."countKind"::text, l."referenceDate", l.pupils, l."pupilsChange", l."pricePerPupil", l.minimum,
         l."minimumApplied", l."fullYear", l."shareMonths", l."shareOf", l."yearAmount", l."alreadyBilled", l."serviceName", l.quantity, l."unitPrice"
  FROM billing_document_lines l
  JOIN billing_documents d ON d.id = l."documentId"
  WHERE l.tenant_id = app_current_tenant() AND current_tenant_sees_billing_documents()
  ORDER BY d."issueDate" DESC, d."createdAt" DESC, l.position
$$;

-- ---------------------------------------------------------------- Exclusions après un document, avoirs
-- Décisions de Dankou du 19 novembre 2026 : D-G5-13 B (la direction valide une exclusion tant qu'aucun document émis
-- n'est touché, puis le Super Admin) et D-G5-14 A (pendant la vérification d'un comptage, ou jusqu'à 30 jours après le
-- document concerné) ; règle du 13 novembre 2026 : après un document émis, un avoir validé par le Super Admin ; au
-- minimum, rien ne change ; aucun remboursement automatique. Les fonctions de demande et de décision du lot G5b sont
-- remplacées ici (le script de retour arrière remet celles du lot G5b).

-- Élèves facturables de chaque comptage figé d'un établissement, à cet instant : inscriptions comptées dans les
-- comptages figés de l'année jusqu'à sa date, moins toutes les exclusions validées, même après le comptage. Un comptage
-- figé ne change jamais : une exclusion validée ensuite retire l'élève de ce que demandent ses documents.
CREATE OR REPLACE FUNCTION billing_counts_billable(p_tenant uuid) RETURNS TABLE (count_id uuid, billable integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  RETURN QUERY
    SELECT c.id, (SELECT count(DISTINCT i."enrollmentId")::integer
                    FROM billing_count_items i JOIN billing_counts b ON b.id = i."countId"
                   WHERE b.tenant_id = c.tenant_id AND b."yearLabel" = c."yearLabel" AND b.stage = 'FROZEN' AND b."referenceDate" <= c."referenceDate"
                     AND i.counted
                     AND NOT EXISTS (SELECT 1 FROM count_corrections k
                                      WHERE k."enrollmentId" = i."enrollmentId" AND k.kind = 'EXCLUSION' AND k.status = 'VALIDATED'))
    FROM billing_counts c
    WHERE c.tenant_id = p_tenant AND c.stage = 'FROZEN';
END $$;

-- Le même nombre pour un seul comptage figé (NULL s'il n'est pas figé).
CREATE OR REPLACE FUNCTION billing_count_billable(p_count uuid) RETURNS integer
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT x.billable FROM billing_counts c CROSS JOIN LATERAL billing_counts_billable(c.tenant_id) x WHERE c.id = p_count AND x.count_id = p_count
$$;

-- Date du dernier document d'abonnement qui a demandé cette inscription (comptée dans un comptage figé de l'année au
-- plus tard à la date du comptage de ce document), ou NULL : aucun document émis n'est touché.
CREATE OR REPLACE FUNCTION billing_enrollment_document(p_tenant uuid, p_enrollment uuid, p_year text) RETURNS date
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_first date;
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  SELECT min(b."referenceDate") INTO v_first
    FROM billing_count_items i JOIN billing_counts b ON b.id = i."countId"
   WHERE i."enrollmentId" = p_enrollment AND i.counted AND b.tenant_id = p_tenant AND b."yearLabel" = p_year AND b.stage = 'FROZEN';
  IF v_first IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN (SELECT max(d."issueDate") FROM billing_document_lines l JOIN billing_documents d ON d.id = l."documentId"
           WHERE l.tenant_id = p_tenant AND d.kind = 'SUBSCRIPTION' AND d."yearLabel" = p_year AND l."referenceDate" >= v_first);
END $$;

-- Demande de correction par la direction de tout l'établissement courant (remplace celle du lot G5b) :
-- - pendant la vérification d'un comptage provisoire : EXCLUSION d'une inscription annulée pour erreur de saisie (règle
--   du 13 novembre 2026), avec sa justification, qui attend une décision ; DEPARTURE_DATE d'un départ enregistré avant
--   l'historique des inscriptions (D-G5-16 A), qui vaut aussitôt ;
-- - après, sur un comptage figé (D-G5-14 A) : EXCLUSION seulement, d'une inscription comptée dans ce comptage ou avant,
--   jusqu'à 30 jours après le dernier document qui l'a demandée (sans limite tant qu'aucun document ne l'a demandée).
-- Jamais pour un départ réel : l'inscription doit être annulée. La demande est inscrite dans les journaux de la
-- plateforme (avec le matricule, sans la justification) et du groupe (sans le matricule) ; l'API trace le journal de
-- l'école.
CREATE OR REPLACE FUNCTION request_count_correction(
  p_count uuid, p_kind text, p_enrollment uuid, p_departure date, p_justification text, p_file_key text, p_file_mime text, p_file_size integer,
  p_user uuid, p_user_name text, p_ip text, p_today date) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant uuid := app_current_tenant();
  v_now timestamp := timezone('UTC', now());
  v_id uuid := gen_random_uuid();
  v_status "CountCorrectionStatus";
  v_action text;
  v_document date;
  b record;
  e record;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'CAHIORA: école courante absente';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM user_roles r JOIN users u ON u.id = r."userId"
    WHERE r."userId" = p_user AND r.tenant_id = v_tenant AND r.role = 'DIRECTION' AND r."siteId" IS NULL AND u.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'CAHIORA: seule la direction de tout l''établissement corrige un comptage';
  END IF;
  IF p_kind NOT IN ('EXCLUSION', 'DEPARTURE_DATE') THEN
    RAISE EXCEPTION 'CAHIORA: type de correction inconnu';
  END IF;
  IF length(btrim(coalesce(p_justification, ''))) < 5 THEN
    RAISE EXCEPTION 'CAHIORA: la justification est obligatoire (5 caractères au moins)';
  END IF;
  SELECT * INTO b FROM billing_counts WHERE id = p_count AND tenant_id = v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CAHIORA: comptage introuvable';
  END IF;
  IF b.stage = 'PROVISIONAL' THEN
    IF b."reviewUntil" < p_today OR EXISTS (
      SELECT 1 FROM billing_counts f WHERE f.tenant_id = v_tenant AND f."yearLabel" = b."yearLabel" AND f.kind = b.kind AND f."referenceDate" = b."referenceDate" AND f.stage = 'FROZEN'
    ) THEN
      RAISE EXCEPTION 'CAHIORA: la vérification de ce comptage est terminée';
    END IF;
  ELSIF p_kind <> 'EXCLUSION' THEN
    RAISE EXCEPTION 'CAHIORA: la vérification de ce comptage est terminée : seule une exclusion se demande encore (D-G5-14 A)';
  END IF;
  SELECT en.id, en.status, st.matricule INTO e FROM enrollments en JOIN students st ON st.id = en."studentId"
   WHERE en.id = p_enrollment AND en.tenant_id = v_tenant AND en."academicYearId" = b."academicYearId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CAHIORA: inscription introuvable pour l''année de ce comptage';
  END IF;
  -- Verrou de l'inscription : deux demandes envoyées en même temps ne passent pas toutes les deux.
  PERFORM 1 FROM enrollments WHERE id = p_enrollment FOR UPDATE;
  IF p_kind = 'EXCLUSION' THEN
    IF e.status <> 'CANCELLED' THEN
      RAISE EXCEPTION 'CAHIORA: seule une inscription annulée pour erreur de saisie peut être exclue ; annulez-la d''abord, avec son motif (un départ réel ne s''exclut jamais)';
    END IF;
    IF p_departure IS NOT NULL THEN
      RAISE EXCEPTION 'CAHIORA: une exclusion ne porte pas de date de départ';
    END IF;
    IF EXISTS (SELECT 1 FROM count_corrections k WHERE k."enrollmentId" = p_enrollment AND k.kind = 'EXCLUSION' AND k.status IN ('PENDING', 'VALIDATED')) THEN
      RAISE EXCEPTION 'CAHIORA: une demande d''exclusion est déjà en cours ou validée pour cette inscription';
    END IF;
    v_document := billing_enrollment_document(v_tenant, p_enrollment, b."yearLabel");
    IF b.stage = 'FROZEN' THEN
      IF NOT EXISTS (SELECT 1 FROM billing_count_items i JOIN billing_counts f ON f.id = i."countId"
                     WHERE i."enrollmentId" = p_enrollment AND i.counted AND f.tenant_id = v_tenant AND f."yearLabel" = b."yearLabel"
                       AND f.stage = 'FROZEN' AND f."referenceDate" <= b."referenceDate") THEN
        RAISE EXCEPTION 'CAHIORA: cette inscription n''est pas comptée dans ce comptage figé';
      END IF;
      IF v_document IS NOT NULL AND p_today > v_document + 30 THEN
        RAISE EXCEPTION 'CAHIORA: délai passé : une exclusion se demande au plus tard 30 jours après le document concerné, émis le % (D-G5-14 A)',
          to_char(v_document, 'DD/MM/YYYY');
      END IF;
    END IF;
    v_status := 'PENDING';
    v_action := 'billing.count_exclusion_requested';
  ELSE
    IF p_departure IS NULL THEN
      RAISE EXCEPTION 'CAHIORA: la date de départ est obligatoire';
    END IF;
    IF p_departure > p_today THEN
      RAISE EXCEPTION 'CAHIORA: la date de départ ne peut pas être dans le futur';
    END IF;
    IF e.status NOT IN ('TRANSFERRED', 'WITHDRAWN')
       AND NOT EXISTS (SELECT 1 FROM enrollment_events v WHERE v."enrollmentId" = p_enrollment AND v.kind = 'REINSTATED') THEN
      RAISE EXCEPTION 'CAHIORA: cette inscription n''a pas de départ enregistré avant l''historique des inscriptions';
    END IF;
    v_status := 'VALIDATED';
    v_action := 'billing.count_departure_dated';
  END IF;
  INSERT INTO count_corrections (id, tenant_id, kind, "enrollmentId", "countId", "departureDate", justification, "fileKey", "fileMime", "fileSize", status,
                                 "requestedById", "requestedByName", "requestedAt", "decidedByKind", "decidedById", "decidedByName", "decidedAt")
    VALUES (v_id, v_tenant, p_kind::"CountCorrectionKind", p_enrollment, p_count, p_departure, btrim(p_justification), p_file_key, p_file_mime, p_file_size, v_status,
            p_user, p_user_name, v_now,
            CASE WHEN v_status = 'VALIDATED' THEN 'school' END, CASE WHEN v_status = 'VALIDATED' THEN p_user END,
            CASE WHEN v_status = 'VALIDATED' THEN p_user_name END, CASE WHEN v_status = 'VALIDATED' THEN v_now END);
  INSERT INTO platform_audit_logs (id, action, "tenantId", data, ip, "createdAt")
    VALUES (gen_random_uuid(), v_action, v_tenant,
            jsonb_build_object('countKind', b.kind, 'referenceDate', b."referenceDate", 'matricule', e.matricule, 'departureDate', p_departure, 'by', p_user_name,
                               'documentDate', v_document), p_ip, v_now);
  INSERT INTO group_audit_logs (id, group_id, "actorKind", "actorId", "actorName", action, data, "createdAt")
    SELECT gen_random_uuid(), t.group_id, 'school', p_user, p_user_name, v_action,
           jsonb_build_object('tenantName', t.name, 'countKind', b.kind, 'referenceDate', b."referenceDate"), v_now
    FROM tenants t WHERE t.id = v_tenant;
  -- Une exclusion qui touche un document émis attend le Super Admin (D-G5-13 B) : alerte de la plateforme.
  IF p_kind = 'EXCLUSION' AND v_document IS NOT NULL THEN
    INSERT INTO platform_alerts (id, tenant_id, kind, message, "dueDate", "createdAt")
      SELECT gen_random_uuid(), v_tenant, 'COUNT_EXCLUSION_TO_DECIDE',
             'Demande d''exclusion à décider : ' || t.name || ', inscription ' || e.matricule || ' déjà demandée par le document du '
               || to_char(v_document, 'DD/MM/YYYY') || ' (D-G5-13 B)', NULL, v_now
      FROM tenants t WHERE t.id = v_tenant;
  END IF;
  RETURN v_id;
END $$;

-- Décision de la direction de tout l'établissement courant sur une demande d'exclusion (remplace celle du lot G5b) :
-- seulement tant qu'aucun document émis n'est touché (D-G5-13 B) ; sinon le Super Admin décide
-- (decide_count_exclusion_platform). Un refus exige un motif. La décision est inscrite une seule fois. Même verrou que
-- l'émission d'un document du client : une décision et un document ne se croisent jamais.
CREATE OR REPLACE FUNCTION decide_count_correction(p_id uuid, p_decision text, p_note text, p_user uuid, p_user_name text, p_ip text) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant uuid := app_current_tenant();
  v_now timestamp := timezone('UTC', now());
  v_group uuid;
  k record;
  b record;
  v_matricule text;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'CAHIORA: école courante absente';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM user_roles r JOIN users u ON u.id = r."userId"
    WHERE r."userId" = p_user AND r.tenant_id = v_tenant AND r.role = 'DIRECTION' AND r."siteId" IS NULL AND u.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'CAHIORA: seule la direction de tout l''établissement décide d''une exclusion';
  END IF;
  IF p_decision NOT IN ('VALIDATED', 'REFUSED') THEN
    RAISE EXCEPTION 'CAHIORA: décision inconnue';
  END IF;
  IF p_decision = 'REFUSED' AND length(btrim(coalesce(p_note, ''))) < 5 THEN
    RAISE EXCEPTION 'CAHIORA: un refus exige un motif (5 caractères au moins)';
  END IF;
  SELECT t.group_id INTO v_group FROM tenants t WHERE t.id = v_tenant;
  PERFORM pg_advisory_xact_lock(hashtext('cahiora-billing-document'), hashtext(v_group::text));
  SELECT * INTO k FROM count_corrections WHERE id = p_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND OR k.kind <> 'EXCLUSION' THEN
    RAISE EXCEPTION 'CAHIORA: demande d''exclusion introuvable';
  END IF;
  IF k.status <> 'PENDING' THEN
    RAISE EXCEPTION 'CAHIORA: cette demande a déjà reçu une décision';
  END IF;
  SELECT c.kind, c."referenceDate", c."yearLabel" INTO b FROM billing_counts c WHERE c.id = k."countId";
  IF billing_enrollment_document(v_tenant, k."enrollmentId", b."yearLabel") IS NOT NULL THEN
    RAISE EXCEPTION 'CAHIORA: cette exclusion touche un document déjà émis : le Super Admin de Cahiora la décide (D-G5-13 B)';
  END IF;
  UPDATE count_corrections
     SET status = p_decision::"CountCorrectionStatus", "decidedByKind" = 'school', "decidedById" = p_user, "decidedByName" = p_user_name,
         "decidedAt" = v_now, "decisionNote" = nullif(btrim(coalesce(p_note, '')), '')
   WHERE id = p_id;
  SELECT st.matricule INTO v_matricule FROM enrollments en JOIN students st ON st.id = en."studentId" WHERE en.id = k."enrollmentId";
  INSERT INTO platform_audit_logs (id, action, "tenantId", data, ip, "createdAt")
    VALUES (gen_random_uuid(), CASE WHEN p_decision = 'VALIDATED' THEN 'billing.count_exclusion_validated' ELSE 'billing.count_exclusion_refused' END, v_tenant,
            jsonb_build_object('countKind', b.kind, 'referenceDate', b."referenceDate", 'matricule', v_matricule, 'by', p_user_name), p_ip, v_now);
  INSERT INTO group_audit_logs (id, group_id, "actorKind", "actorId", "actorName", action, data, "createdAt")
    SELECT gen_random_uuid(), t.group_id, 'school', p_user, p_user_name,
           CASE WHEN p_decision = 'VALIDATED' THEN 'billing.count_exclusion_validated' ELSE 'billing.count_exclusion_refused' END,
           jsonb_build_object('tenantName', t.name, 'countKind', b.kind, 'referenceDate', b."referenceDate"), v_now
    FROM tenants t WHERE t.id = v_tenant;
  RETURN p_decision;
END $$;

-- Décision du Super Admin sur une demande d'exclusion qui touche un document émis (D-G5-13 B), rôle de la plateforme
-- seulement. Un refus exige un motif. Rend la date du dernier document touché et l'année : l'API émet l'avoir dans la
-- même transaction (issue_billing_document refait le calcul) ; au minimum, aucun avoir. Journaux de la plateforme (avec
-- le matricule) et du groupe (sans) ; l'API trace le journal de l'école.
CREATE OR REPLACE FUNCTION decide_count_exclusion_platform(
  p_tenant uuid, p_id uuid, p_decision text, p_note text, p_admin uuid, p_admin_name text, p_ip text)
  RETURNS TABLE (document_date date, year_label text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_now timestamp := timezone('UTC', now());
  v_group uuid;
  v_name text;
  v_document date;
  v_matricule text;
  v_action text;
  k record;
  b record;
BEGIN
  IF p_tenant IS NULL OR p_id IS NULL OR coalesce(btrim(p_admin_name), '') = '' THEN
    RAISE EXCEPTION 'CAHIORA: décision incomplète';
  END IF;
  IF p_decision NOT IN ('VALIDATED', 'REFUSED') THEN
    RAISE EXCEPTION 'CAHIORA: décision inconnue';
  END IF;
  IF p_decision = 'REFUSED' AND length(btrim(coalesce(p_note, ''))) < 5 THEN
    RAISE EXCEPTION 'CAHIORA: un refus exige un motif (5 caractères au moins)';
  END IF;
  SELECT t.group_id, t.name INTO v_group, v_name FROM tenants t WHERE t.id = p_tenant;
  IF v_group IS NULL THEN
    RAISE EXCEPTION 'CAHIORA: établissement introuvable';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cahiora-billing-document'), hashtext(v_group::text));
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  SELECT * INTO k FROM count_corrections x WHERE x.id = p_id AND x.tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND OR k.kind <> 'EXCLUSION' THEN
    RAISE EXCEPTION 'CAHIORA: demande d''exclusion introuvable';
  END IF;
  IF k.status <> 'PENDING' THEN
    RAISE EXCEPTION 'CAHIORA: cette demande a déjà reçu une décision';
  END IF;
  SELECT c.kind, c."referenceDate", c."yearLabel" INTO b FROM billing_counts c WHERE c.id = k."countId";
  v_document := billing_enrollment_document(p_tenant, k."enrollmentId", b."yearLabel");
  IF v_document IS NULL THEN
    RAISE EXCEPTION 'CAHIORA: cette exclusion ne touche aucun document émis : la direction de l''établissement la décide (D-G5-13 B)';
  END IF;
  UPDATE count_corrections
     SET status = p_decision::"CountCorrectionStatus", "decidedByKind" = 'platform', "decidedById" = p_admin, "decidedByName" = btrim(p_admin_name),
         "decidedAt" = v_now, "decisionNote" = nullif(btrim(coalesce(p_note, '')), '')
   WHERE id = p_id;
  SELECT st.matricule INTO v_matricule FROM enrollments en JOIN students st ON st.id = en."studentId" WHERE en.id = k."enrollmentId";
  v_action := CASE WHEN p_decision = 'VALIDATED' THEN 'billing.count_exclusion_validated' ELSE 'billing.count_exclusion_refused' END;
  INSERT INTO platform_audit_logs (id, "adminId", action, "tenantId", data, ip, "createdAt")
    VALUES (gen_random_uuid(), p_admin, v_action, p_tenant,
            jsonb_build_object('countKind', b.kind, 'referenceDate', b."referenceDate", 'matricule', v_matricule, 'by', btrim(p_admin_name),
                               'decidedBy', 'platform', 'documentDate', v_document), p_ip, v_now);
  INSERT INTO group_audit_logs (id, group_id, "actorKind", "actorId", "actorName", action, data, "createdAt")
    VALUES (gen_random_uuid(), v_group, 'platform', p_admin, 'Super Admin Cahiora (' || btrim(p_admin_name) || ')', v_action,
            jsonb_build_object('tenantName', v_name, 'countKind', b.kind, 'referenceDate', b."referenceDate"), v_now);
  RETURN QUERY SELECT v_document, b."yearLabel"::text;
END $$;

-- Demandes d'exclusion du ressort du Super Admin (D-G5-13 B), tous établissements : en attente et touchant un document
-- émis, ou déjà décidées par lui. Matricule, classe, motif de l'annulation, justification et justificatif, jamais le
-- nom de l'élève (rôle de la plateforme seulement).
CREATE OR REPLACE FUNCTION platform_count_exclusions() RETURNS TABLE (
  tenant_id uuid, correction_id uuid, status text, count_id uuid, count_kind text, reference_date date, year_label text, matricule text,
  class_name text, cancel_reason text, justification text, file_key text, file_mime text, requested_by_name text, requested_at timestamp,
  decided_by_name text, decided_at timestamp, decision_note text, document_date date)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant uuid;
BEGIN
  FOR v_tenant IN
    SELECT DISTINCT l.tenant_id FROM billing_document_lines l JOIN billing_documents d ON d.id = l."documentId" WHERE d.kind = 'SUBSCRIPTION' ORDER BY 1
  LOOP
    PERFORM set_config('app.tenant_id', v_tenant::text, true);
    RETURN QUERY
      SELECT x.tenant_id, x.id, x.status, x.count_id, x.count_kind, x.reference_date, x.year_label, x.matricule, x.class_name, x.cancel_reason,
             x.justification, x.file_key, x.file_mime, x.requested_by_name, x.requested_at, x.decided_by_name, x.decided_at, x.decision_note, x.document_date
      FROM (
        SELECT k.tenant_id, k.id, k.status::text AS status, b.id AS count_id, b.kind::text AS count_kind, b."referenceDate" AS reference_date,
               b."yearLabel" AS year_label, st.matricule, cl.name AS class_name, en."cancelReason" AS cancel_reason, k.justification,
               k."fileKey" AS file_key, k."fileMime" AS file_mime, k."requestedByName" AS requested_by_name, k."requestedAt" AS requested_at,
               k."decidedByName" AS decided_by_name, k."decidedAt" AS decided_at, k."decisionNote" AS decision_note, k."decidedByKind" AS decided_by_kind,
               billing_enrollment_document(v_tenant, k."enrollmentId", b."yearLabel") AS document_date
        FROM count_corrections k
        JOIN billing_counts b ON b.id = k."countId"
        JOIN enrollments en ON en.id = k."enrollmentId"
        JOIN students st ON st.id = en."studentId"
        LEFT JOIN classes cl ON cl.id = en."classId"
        WHERE k.tenant_id = v_tenant AND k.kind = 'EXCLUSION'
      ) x
      WHERE x.decided_by_kind = 'platform' OR (x.status = 'PENDING' AND x.document_date IS NOT NULL)
      ORDER BY x.requested_at DESC;
  END LOOP;
END $$;

-- Documents d'abonnement qui touchent les comptages de l'école courante : comptage, année, date du comptage et date du
-- document, rien d'autre (ni montant, ni client) ; l'API en tire jusqu'à quand une exclusion se demande et qui la décide.
CREATE OR REPLACE FUNCTION current_tenant_count_documents() RETURNS TABLE (count_id uuid, year_label text, reference_date date, issue_date date)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT l."countId", d."yearLabel", l."referenceDate", d."issueDate"
  FROM billing_document_lines l JOIN billing_documents d ON d.id = l."documentId"
  WHERE l.tenant_id = app_current_tenant() AND d.kind = 'SUBSCRIPTION'
  ORDER BY l."referenceDate", d."createdAt"
$$;

REVOKE ALL ON FUNCTION billing_already_billed(uuid, text), billing_year_amount(integer, integer, integer, integer, integer),
  issue_billing_document(uuid, text, text, date, date, text, uuid, jsonb, jsonb, text, uuid, text), current_tenant_sees_billing_documents(),
  current_tenant_billing_documents(), billing_counts_billable(uuid), billing_count_billable(uuid), billing_enrollment_document(uuid, uuid, text),
  decide_count_exclusion_platform(uuid, uuid, text, text, uuid, text, text), platform_count_exclusions(), current_tenant_count_documents() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT EXECUTE ON FUNCTION current_tenant_sees_billing_documents(), current_tenant_billing_documents(), current_tenant_count_documents() TO erp_app;
  END IF;
END $$;

-- Rôle de la plateforme : droits des documents dans une fonction à part, comme ceux des lots G5a, G5g et G5b ;
-- infra/postgres/role-plateforme.sh l'appelle à chaque installation. Lecture des documents, émission et décision des
-- exclusions qui touchent un document par les seules fonctions ci-dessus ; aucune écriture directe.
CREATE OR REPLACE FUNCTION grant_platform_documents_role() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_platform') THEN
    RAISE NOTICE 'Rôle erp_platform absent : droits non attribués (poste de développement)';
    RETURN;
  END IF;
  GRANT SELECT ON billing_documents, billing_document_lines TO erp_platform;
  GRANT EXECUTE ON FUNCTION billing_already_billed(uuid, text),
    issue_billing_document(uuid, text, text, date, date, text, uuid, jsonb, jsonb, text, uuid, text), billing_counts_billable(uuid),
    decide_count_exclusion_platform(uuid, uuid, text, text, uuid, text, text), platform_count_exclusions() TO erp_platform;
END $$;

SELECT grant_platform_documents_role();
