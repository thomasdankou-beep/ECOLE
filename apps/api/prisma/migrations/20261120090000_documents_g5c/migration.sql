-- Lot G5c · documents provisoires de Cahiora : proformas de l'abonnement (première facture, compléments des
-- régularisations, relevés à 0 F), avoirs, devis et proformas de prestations. Aucun n'est une facture fiscale :
-- cahier des charges du lot G5 (14 novembre 2026), §16 ; les factures fiscales attendent les informations légales et
-- fiscales (lot G5f). Chaque document porte une référence provisoire, jamais un numéro de facture.
-- Le client d'un document est le groupe (compte client, lot G1) : une école indépendante est un groupe d'un seul
-- établissement ; une ligne par établissement (décision du 11 novembre 2026).
-- Ajout seul : un document émis et ses lignes ne se modifient ni ne s'effacent, même par le propriétaire de la base.
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
--   différentes attendent D-G5-31), un établissement une seule fois, élèves = cumul du comptage figé, montant de
--   l'année, déjà demandé, écart d'élèves et complément recalculés (D-G5-10 A) ;
-- - avoir : une ligne, qui touche une ligne d'un document d'abonnement du même client et de la même année, pour une
--   exclusion validée de l'établissement, une seule fois ; montant = déjà demandé moins le montant de l'année recalculé
--   (13 novembre 2026, D-G5-13 B) ;
-- - devis et proformas de prestations : prestation du catalogue, quantité, prix unitaire, montant = quantité × prix ;
--   une proforma peut reprendre un devis du même client.
-- Total = somme des lignes. Référence provisoire « PROV-… », jamais un numéro de facture (G5f).
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
      IF l.pupils <> c.cumulative THEN
        RAISE EXCEPTION 'CAHIORA: ligne % : élèves facturables différents du comptage figé', l.n;
      END IF;
      v_prev := NULL;
      SELECT x.pupils INTO v_prev FROM billing_document_lines x JOIN billing_documents d ON d.id = x."documentId"
       WHERE x.tenant_id = l."tenantId" AND d."yearLabel" = p_year AND d.kind = 'SUBSCRIPTION'
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
      PERFORM set_config('app.tenant_id', l."tenantId"::text, true);
      SELECT * INTO k FROM count_corrections x WHERE x.id = l."correctionId";
      IF NOT FOUND OR k.tenant_id <> l."tenantId" OR k.kind <> 'EXCLUSION' OR k.status <> 'VALIDATED' THEN
        RAISE EXCEPTION 'CAHIORA: ligne % : exclusion validée de cet établissement attendue', l.n;
      END IF;
      IF EXISTS (SELECT 1 FROM billing_document_lines x WHERE x."correctionId" = k.id) THEN
        RAISE EXCEPTION 'CAHIORA: ligne % : cette exclusion a déjà son avoir', l.n;
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

REVOKE ALL ON FUNCTION billing_already_billed(uuid, text), billing_year_amount(integer, integer, integer, integer, integer),
  issue_billing_document(uuid, text, text, date, date, text, uuid, jsonb, jsonb, text, uuid, text), current_tenant_sees_billing_documents(),
  current_tenant_billing_documents() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT EXECUTE ON FUNCTION current_tenant_sees_billing_documents(), current_tenant_billing_documents() TO erp_app;
  END IF;
END $$;

-- Rôle de la plateforme : droits des documents dans une fonction à part, comme ceux des lots G5a, G5g et G5b ;
-- infra/postgres/role-plateforme.sh l'appelle à chaque installation. Lecture des documents et émission par la seule
-- fonction ci-dessus ; aucune écriture directe.
CREATE OR REPLACE FUNCTION grant_platform_documents_role() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_platform') THEN
    RAISE NOTICE 'Rôle erp_platform absent : droits non attribués (poste de développement)';
    RETURN;
  END IF;
  GRANT SELECT ON billing_documents, billing_document_lines TO erp_platform;
  GRANT EXECUTE ON FUNCTION billing_already_billed(uuid, text),
    issue_billing_document(uuid, text, text, date, date, text, uuid, jsonb, jsonb, text, uuid, text) TO erp_platform;
END $$;

SELECT grant_platform_documents_role();
