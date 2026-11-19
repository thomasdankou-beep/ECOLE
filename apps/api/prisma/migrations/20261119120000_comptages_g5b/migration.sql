-- Lot G5b · comptages des élèves facturables : comptages provisoires et figés aux dates de l'établissement (fin
-- d'essai, fin de pilote, comptage initial, régularisations), vérification par la direction, exclusions d'inscriptions
-- annulées par erreur de saisie et dates des départs enregistrés avant l'historique des inscriptions.
-- Cahier des charges du lot G5 (14 novembre 2026) et décisions de Dankou du 19 novembre 2026 : D-G5-13 B (la
-- direction valide une exclusion tant qu'aucun document émis n'est touché ; les documents arrivent au lot G5c),
-- D-G5-14 A (demande pendant la vérification, ou dans les 30 jours après le document concerné, au lot G5c), D-G5-16 A
-- (départ sans date : date du journal d'audit, que la direction peut avancer pendant la vérification).
-- Le comptage (nombres et empreinte) est dans la zone de la plateforme ; la liste des inscriptions et les demandes de
-- correction restent dans l'espace de l'école. Aucune donnée existante n'est modifiée, aucun comptage n'est créé ici :
-- les tâches planifiées les font aux dates du calendrier. Aucun montant ni aucune facture.
-- Tout s'applique en une seule transaction : en cas d'erreur, rien n'est changé.

-- CreateEnum
CREATE TYPE "BillingCountKind" AS ENUM ('TRIAL_END', 'PILOT_END', 'INITIAL', 'FIRST_REGULARIZATION', 'FINAL_REGULARIZATION');

-- CreateEnum
CREATE TYPE "BillingCountStage" AS ENUM ('PROVISIONAL', 'FROZEN');

-- CreateEnum
CREATE TYPE "CountCorrectionKind" AS ENUM ('EXCLUSION', 'DEPARTURE_DATE');

-- CreateEnum
CREATE TYPE "CountCorrectionStatus" AS ENUM ('PENDING', 'VALIDATED', 'REFUSED');

-- CreateTable
CREATE TABLE "billing_counts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "yearLabel" TEXT NOT NULL,
    "academicYearId" UUID NOT NULL,
    "kind" "BillingCountKind" NOT NULL,
    "referenceDate" DATE NOT NULL,
    "stage" "BillingCountStage" NOT NULL,
    "calendarVersion" INTEGER,
    "pupils" INTEGER NOT NULL,
    "cumulative" INTEGER NOT NULL,
    "toCheck" INTEGER NOT NULL,
    "excluded" INTEGER NOT NULL,
    "listHash" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "knownAt" TIMESTAMP(3) NOT NULL,
    "reviewUntil" DATE,
    "timeZone" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_count_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "countId" UUID NOT NULL,
    "enrollmentId" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "siteId" UUID,
    "counted" BOOLEAN NOT NULL,
    "basis" TEXT NOT NULL,
    "departureDate" DATE,

    CONSTRAINT "billing_count_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "count_corrections" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "CountCorrectionKind" NOT NULL,
    "enrollmentId" UUID NOT NULL,
    "countId" UUID NOT NULL,
    "departureDate" DATE,
    "justification" TEXT NOT NULL,
    "fileKey" TEXT,
    "fileMime" TEXT,
    "fileSize" INTEGER,
    "status" "CountCorrectionStatus" NOT NULL,
    "requestedById" UUID,
    "requestedByName" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedByKind" TEXT,
    "decidedById" UUID,
    "decidedByName" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,

    CONSTRAINT "count_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "billing_counts_tenant_id_createdAt_idx" ON "billing_counts"("tenant_id", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "billing_counts_tenant_id_yearLabel_kind_referenceDate_stage_key" ON "billing_counts"("tenant_id", "yearLabel", "kind", "referenceDate", "stage");

-- CreateIndex
CREATE INDEX "billing_count_items_tenant_id_enrollmentId_idx" ON "billing_count_items"("tenant_id", "enrollmentId");

-- CreateIndex
CREATE UNIQUE INDEX "billing_count_items_countId_enrollmentId_key" ON "billing_count_items"("countId", "enrollmentId");

-- CreateIndex
CREATE INDEX "count_corrections_tenant_id_enrollmentId_idx" ON "count_corrections"("tenant_id", "enrollmentId");

-- CreateIndex
CREATE INDEX "count_corrections_countId_idx" ON "count_corrections"("countId");

-- AddForeignKey
ALTER TABLE "billing_counts" ADD CONSTRAINT "billing_counts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_counts" ADD CONSTRAINT "billing_counts_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "academic_years"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_count_items" ADD CONSTRAINT "billing_count_items_countId_fkey" FOREIGN KEY ("countId") REFERENCES "billing_counts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_count_items" ADD CONSTRAINT "billing_count_items_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "enrollments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "count_corrections" ADD CONSTRAINT "count_corrections_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "enrollments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "count_corrections" ADD CONSTRAINT "count_corrections_countId_fkey" FOREIGN KEY ("countId") REFERENCES "billing_counts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Contrôle « même école » (SEC-001) : une ligne de comptage ou une demande de correction pointe toujours vers une
-- inscription et un comptage de son établissement ; un comptage, vers une année scolaire de son établissement.
SELECT install_same_tenant_checks();

-- Ajout seul : un comptage et ses lignes ne se modifient ni ne s'effacent, même par le propriétaire de la base. Une
-- demande de correction ne s'efface jamais ; seule sa décision s'inscrit, une seule fois (count_corrections_guard).
CREATE TRIGGER billing_counts_append_only BEFORE UPDATE OR DELETE ON billing_counts FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER billing_count_items_append_only BEFORE UPDATE OR DELETE ON billing_count_items FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER count_corrections_no_delete BEFORE DELETE ON count_corrections FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE OR REPLACE FUNCTION count_corrections_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'La décision sur une demande de correction ne change plus';
  END IF;
  IF NEW.status = 'PENDING' OR NEW."decidedAt" IS NULL OR NEW."decidedByName" IS NULL OR NEW."decidedByKind" IS NULL THEN
    RAISE EXCEPTION 'Une demande de correction ne change que par sa décision, datée et signée';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.kind, NEW."enrollmentId", NEW."countId", NEW."departureDate", NEW.justification, NEW."fileKey", NEW."fileMime",
      NEW."fileSize", NEW."requestedById", NEW."requestedByName", NEW."requestedAt")
     IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.kind, OLD."enrollmentId", OLD."countId", OLD."departureDate", OLD.justification, OLD."fileKey", OLD."fileMime",
      OLD."fileSize", OLD."requestedById", OLD."requestedByName", OLD."requestedAt") THEN
    RAISE EXCEPTION 'Une demande de correction ne se modifie pas : seule sa décision s''inscrit';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER count_corrections_guard BEFORE UPDATE ON count_corrections FOR EACH ROW EXECUTE FUNCTION count_corrections_guard();
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing_counts', 'billing_count_items', 'count_corrections'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION forbid_change()', t || '_no_truncate', t);
  END LOOP;
END $$;

-- Row Level Security. Comptages : zone de la plateforme (propriétaire et erp_platform, en lecture seule par ses droits).
-- Lignes et demandes : espace de l'école, filtrées sur l'établissement courant comme toutes les tables des écoles.
ALTER TABLE billing_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_counts FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_counts_owner_all ON billing_counts TO erp_owner USING (true) WITH CHECK (true);
CREATE POLICY billing_counts_platform_all ON billing_counts TO PUBLIC USING (current_user = 'erp_platform') WITH CHECK (current_user = 'erp_platform');
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing_count_items', 'count_corrections'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;

-- Droits. Les écoles (erp_app) ne lisent pas les comptages directement (fonction current_tenant_billing_counts) ; elles
-- lisent leurs lignes et leurs demandes, sans jamais les écrire elles-mêmes : tout passe par les fonctions ci-dessous.
-- Le rôle des groupes et celui des statistiques n'ont aucun droit (les droits par défaut ne valent que pour erp_app).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    REVOKE ALL ON billing_counts, billing_count_items, count_corrections FROM erp_app;
    GRANT SELECT ON billing_count_items, count_corrections TO erp_app;
  END IF;
END $$;

-- Enregistre un comptage (tâche planifiée, rôle de la plateforme seulement). La liste vient de l'API, calculée dans
-- l'espace de l'école en rejouant l'historique des inscriptions (enrollments.ts) ; la base refait les contrôles : date
-- terminée et conforme à l'abonnement ou à la version du calendrier, hors période gratuite, vérification terminée avant
-- de figer, inscriptions de l'établissement et de l'année. Elle calcule elle-même les nombres, le cumul de l'année et
-- l'empreinte. Déjà enregistré : aucune ligne rendue, rien n'est changé (une tâche relancée ne crée pas de doublon).
-- Cumul : inscriptions comptées dans les comptages figés de l'année jusqu'à cette date et dans celui-ci (chaque élève une
-- fois par année et par établissement : une seule inscription par élève et par année), moins les exclusions validées
-- au plus tard à l'instant de l'historique lu.
CREATE OR REPLACE FUNCTION record_billing_count(
  p_tenant uuid, p_year uuid, p_kind text, p_date date, p_stage text, p_calendar_version integer, p_items jsonb,
  p_at timestamptz, p_known_at timestamptz, p_today date)
  RETURNS TABLE (count_id uuid, count_pupils integer, count_cumulative integer, count_to_check integer, count_excluded integer,
                 count_hash text, count_review_until date)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid := gen_random_uuid();
  v_label text;
  v_tz text;
  v_kind "BillingCountKind";
  v_stage "BillingCountStage";
  s record;
  c record;
  v_days integer;
  v_review date;
  v_rows integer;
  v_distinct integer;
  v_known integer;
  v_bad integer;
  v_pupils integer;
  v_check integer;
  v_excluded integer;
  v_hash text;
  v_cumulative integer;
BEGIN
  IF p_tenant IS NULL OR p_year IS NULL OR p_date IS NULL OR p_today IS NULL OR p_at IS NULL OR p_known_at IS NULL OR p_items IS NULL
     OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'CAHIORA: comptage incomplet';
  END IF;
  IF p_kind NOT IN ('TRIAL_END', 'PILOT_END', 'INITIAL', 'FIRST_REGULARIZATION', 'FINAL_REGULARIZATION') THEN
    RAISE EXCEPTION 'CAHIORA: type de comptage inconnu';
  END IF;
  IF p_stage NOT IN ('PROVISIONAL', 'FROZEN') THEN
    RAISE EXCEPTION 'CAHIORA: étape de comptage inconnue';
  END IF;
  v_kind := p_kind::"BillingCountKind";
  v_stage := p_stage::"BillingCountStage";
  -- Lignes de l'école lues et écrites pour cet établissement seulement ; un comptage à la fois par établissement.
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  PERFORM pg_advisory_xact_lock(hashtext('cahiora:billing_count:' || p_tenant::text));

  SELECT y.label INTO v_label FROM academic_years y WHERE y.id = p_year AND y.tenant_id = p_tenant;
  IF v_label IS NULL THEN
    RAISE EXCEPTION 'CAHIORA: année scolaire introuvable pour cet établissement';
  END IF;
  IF EXISTS (SELECT 1 FROM billing_counts b WHERE b.tenant_id = p_tenant AND b."yearLabel" = v_label AND b.kind = v_kind AND b."referenceDate" = p_date AND b.stage = v_stage) THEN
    RETURN;
  END IF;
  SELECT t.timezone INTO v_tz FROM tenants t WHERE t.id = p_tenant;
  IF p_date >= p_today THEN
    RAISE EXCEPTION 'CAHIORA: le jour de référence n''est pas encore terminé';
  END IF;
  IF p_known_at < p_at THEN
    RAISE EXCEPTION 'CAHIORA: l''historique lu précède la fin du jour de référence';
  END IF;
  SELECT * INTO s FROM subscriptions WHERE tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CAHIORA: aucun abonnement n''est ouvert pour cet établissement';
  END IF;

  IF v_kind IN ('TRIAL_END', 'PILOT_END') THEN
    -- Fin d'une période gratuite réellement terminée (événement de l'abonnement) : comptage figé aussitôt.
    IF v_stage <> 'FROZEN' THEN
      RAISE EXCEPTION 'CAHIORA: le comptage de fin d''essai ou de pilote est figé aussitôt';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM subscription_events e WHERE e."subscriptionId" = s.id AND e.data->>'lastFreeDay' = p_date::text
                   AND e.kind = CASE WHEN v_kind = 'TRIAL_END' THEN 'TRIAL_ENDED' ELSE 'PILOT_ENDED' END) THEN
      RAISE EXCEPTION 'CAHIORA: cette période gratuite ne s''est pas terminée à cette date';
    END IF;
    IF p_known_at <> p_at THEN
      RAISE EXCEPTION 'CAHIORA: le comptage de fin d''essai ou de pilote lit l''historique à la fin du dernier jour gratuit';
    END IF;
  ELSE
    SELECT * INTO c FROM billing_calendars b WHERE b.tenant_id = p_tenant AND b."yearLabel" = v_label AND b.version = p_calendar_version;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CAHIORA: version du calendrier de facturation introuvable';
    END IF;
    IF p_date IS DISTINCT FROM (CASE v_kind WHEN 'INITIAL' THEN c."initialCountDate" WHEN 'FIRST_REGULARIZATION' THEN c."firstRegularizationDate"
                                ELSE c."finalRegularizationDate" END) THEN
      RAISE EXCEPTION 'CAHIORA: cette date n''est pas celle du calendrier de facturation';
    END IF;
    IF s.status IN ('TRIAL', 'PILOT') OR p_date <= greatest(s."trialEnd", s."pilotEnd") THEN
      RAISE EXCEPTION 'CAHIORA: aucun comptage pendant une période gratuite';
    END IF;
    IF v_stage = 'PROVISIONAL' THEN
      v_days := billing_parameter_value('COUNT_REVIEW_DAYS', NULL, p_today);
      IF v_days IS NULL OR v_days < 1 THEN
        RAISE EXCEPTION 'CAHIORA: la durée de vérification des effectifs n''est pas fixée';
      END IF;
      v_review := p_today + v_days - 1;
    ELSE
      SELECT b."reviewUntil" INTO v_review FROM billing_counts b
       WHERE b.tenant_id = p_tenant AND b."yearLabel" = v_label AND b.kind = v_kind AND b."referenceDate" = p_date AND b.stage = 'PROVISIONAL';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'CAHIORA: aucun comptage provisoire à figer pour cette date';
      END IF;
      IF v_review >= p_today THEN
        RAISE EXCEPTION 'CAHIORA: la vérification par la direction n''est pas terminée';
      END IF;
      v_review := NULL;
    END IF;
  END IF;

  -- Liste : chaque inscription une seule fois, de cet établissement et de cette année, avec un motif connu.
  SELECT count(*), count(DISTINCT x."enrollmentId"), count(e.id),
         count(*) FILTER (WHERE x."classId" IS NULL OR x.counted IS NULL
           OR x.basis NOT IN ('ACTIVE', 'DEPARTURE_AUDIT', 'DEPARTURE_UNKNOWN', 'DEPARTURE_DIRECTION', 'EXCLUDED')
           OR (x.basis = 'EXCLUDED') = x.counted
           OR (x.basis IN ('ACTIVE', 'DEPARTURE_UNKNOWN') AND x."departureDate" IS NOT NULL)
           OR (x.basis IN ('DEPARTURE_AUDIT', 'DEPARTURE_DIRECTION') AND (x."departureDate" IS NULL OR x."departureDate" <= p_date))),
         count(*) FILTER (WHERE x.counted),
         count(*) FILTER (WHERE x.counted AND x.basis IN ('DEPARTURE_AUDIT', 'DEPARTURE_UNKNOWN')),
         count(*) FILTER (WHERE x.basis = 'EXCLUDED')
    INTO v_rows, v_distinct, v_known, v_bad, v_pupils, v_check, v_excluded
    FROM jsonb_to_recordset(p_items) AS x("enrollmentId" uuid, "classId" uuid, "siteId" uuid, counted boolean, basis text, "departureDate" date)
    LEFT JOIN enrollments e ON e.id = x."enrollmentId" AND e.tenant_id = p_tenant AND e."academicYearId" = p_year;
  IF v_rows <> v_distinct OR v_rows <> v_known OR v_bad > 0 THEN
    RAISE EXCEPTION 'CAHIORA: liste du comptage invalide (doublon, inscription d''une autre année ou motif inconnu)';
  END IF;
  SELECT encode(sha256(convert_to(coalesce(string_agg(x."enrollmentId"::text || ':' || x.basis || ':' || coalesce(x."departureDate"::text, ''), ',' ORDER BY x."enrollmentId"::text), ''), 'UTF8')), 'hex')
    INTO v_hash
    FROM jsonb_to_recordset(p_items) AS x("enrollmentId" uuid, basis text, "departureDate" date);
  SELECT count(DISTINCT u.eid) INTO v_cumulative FROM (
      SELECT i."enrollmentId" AS eid FROM billing_count_items i JOIN billing_counts b ON b.id = i."countId"
       WHERE b.tenant_id = p_tenant AND b."yearLabel" = v_label AND b.stage = 'FROZEN' AND b."referenceDate" <= p_date AND i.counted
      UNION
      SELECT x."enrollmentId" FROM jsonb_to_recordset(p_items) AS x("enrollmentId" uuid, counted boolean) WHERE x.counted
    ) u
   WHERE NOT EXISTS (SELECT 1 FROM count_corrections k WHERE k."enrollmentId" = u.eid AND k.kind = 'EXCLUSION' AND k.status = 'VALIDATED'
                     AND k."decidedAt" <= timezone('UTC', p_known_at));

  INSERT INTO billing_counts (id, tenant_id, "yearLabel", "academicYearId", kind, "referenceDate", stage, "calendarVersion", pupils, cumulative,
                              "toCheck", excluded, "listHash", at, "knownAt", "reviewUntil", "timeZone", "createdAt")
    VALUES (v_id, p_tenant, v_label, p_year, v_kind, p_date, v_stage, CASE WHEN v_kind IN ('TRIAL_END', 'PILOT_END') THEN NULL ELSE p_calendar_version END,
            v_pupils, v_cumulative, v_check, v_excluded, v_hash, timezone('UTC', p_at), timezone('UTC', p_known_at), v_review, coalesce(v_tz, 'UTC'),
            timezone('UTC', now()));
  INSERT INTO billing_count_items (id, tenant_id, "countId", "enrollmentId", "classId", "siteId", counted, basis, "departureDate")
    SELECT gen_random_uuid(), p_tenant, v_id, x."enrollmentId", x."classId", x."siteId", x.counted, x.basis, x."departureDate"
    FROM jsonb_to_recordset(p_items) AS x("enrollmentId" uuid, "classId" uuid, "siteId" uuid, counted boolean, basis text, "departureDate" date);
  RETURN QUERY SELECT v_id, v_pupils, v_cumulative, v_check, v_excluded, v_hash, v_review;
END $$;

-- Comptages de l'école courante (app.tenant_id) seulement, les plus récents d'abord : des nombres et des dates.
CREATE OR REPLACE FUNCTION current_tenant_billing_counts() RETURNS TABLE (
  id uuid, year_label text, academic_year_id uuid, kind text, reference_date date, stage text, calendar_version integer, pupils integer,
  cumulative integer, to_check integer, excluded integer, list_hash text, at timestamp, known_at timestamp, review_until date, time_zone text,
  created_at timestamp)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT b.id, b."yearLabel", b."academicYearId", b.kind::text, b."referenceDate", b.stage::text, b."calendarVersion", b.pupils, b.cumulative,
         b."toCheck", b.excluded, b."listHash", b.at, b."knownAt", b."reviewUntil", b."timeZone", b."createdAt"
  FROM billing_counts b
  WHERE b.tenant_id = app_current_tenant()
  ORDER BY b."referenceDate" DESC, b.stage DESC, b."createdAt" DESC
$$;

-- Demande de correction par la direction de tout l'établissement courant, pendant la vérification d'un comptage
-- provisoire (D-G5-14 A ; le délai de 30 jours après un document arrive avec les documents, au lot G5c) :
-- - EXCLUSION d'une inscription annulée pour erreur de saisie (règle du 13 novembre 2026), avec sa justification ;
--   elle attend la décision (decide_count_correction). Jamais pour un départ réel : l'inscription doit être annulée.
-- - DEPARTURE_DATE : date d'un départ enregistré avant l'historique des inscriptions (D-G5-16 A), fixée par la
--   direction ; l'API vérifie qu'elle n'est pas après la date du journal d'audit. Elle vaut aussitôt.
-- La demande est inscrite dans les journaux de la plateforme (avec le matricule, sans la justification) et du groupe
-- (sans le matricule) ; l'API trace le journal de l'école.
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
  IF b.stage <> 'PROVISIONAL' OR b."reviewUntil" < p_today OR EXISTS (
    SELECT 1 FROM billing_counts f WHERE f.tenant_id = v_tenant AND f."yearLabel" = b."yearLabel" AND f.kind = b.kind AND f."referenceDate" = b."referenceDate" AND f.stage = 'FROZEN'
  ) THEN
    RAISE EXCEPTION 'CAHIORA: la vérification de ce comptage est terminée';
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
            jsonb_build_object('countKind', b.kind, 'referenceDate', b."referenceDate", 'matricule', e.matricule, 'departureDate', p_departure, 'by', p_user_name), p_ip, v_now);
  INSERT INTO group_audit_logs (id, group_id, "actorKind", "actorId", "actorName", action, data, "createdAt")
    SELECT gen_random_uuid(), t.group_id, 'school', p_user, p_user_name, v_action,
           jsonb_build_object('tenantName', t.name, 'countKind', b.kind, 'referenceDate', b."referenceDate"), v_now
    FROM tenants t WHERE t.id = v_tenant;
  RETURN v_id;
END $$;

-- Décision sur une demande d'exclusion, par la direction de tout l'établissement courant (D-G5-13 B : tant qu'aucun
-- document émis n'est touché ; au lot G5c, une exclusion qui touche un document émis sera décidée par le Super Admin).
-- Un refus exige un motif. La décision est inscrite une seule fois ; une exclusion validée vaut pour les comptages
-- figés ensuite (un comptage déjà figé ne change jamais : le lot G5c en tirera un avoir s'il le faut).
CREATE OR REPLACE FUNCTION decide_count_correction(p_id uuid, p_decision text, p_note text, p_user uuid, p_user_name text, p_ip text) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant uuid := app_current_tenant();
  v_now timestamp := timezone('UTC', now());
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
  SELECT * INTO k FROM count_corrections WHERE id = p_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND OR k.kind <> 'EXCLUSION' THEN
    RAISE EXCEPTION 'CAHIORA: demande d''exclusion introuvable';
  END IF;
  IF k.status <> 'PENDING' THEN
    RAISE EXCEPTION 'CAHIORA: cette demande a déjà reçu une décision';
  END IF;
  UPDATE count_corrections
     SET status = p_decision::"CountCorrectionStatus", "decidedByKind" = 'school', "decidedById" = p_user, "decidedByName" = p_user_name,
         "decidedAt" = v_now, "decisionNote" = nullif(btrim(coalesce(p_note, '')), '')
   WHERE id = p_id;
  SELECT c.kind, c."referenceDate" INTO b FROM billing_counts c WHERE c.id = k."countId";
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

REVOKE ALL ON FUNCTION record_billing_count(uuid, uuid, text, date, text, integer, jsonb, timestamptz, timestamptz, date), current_tenant_billing_counts(),
  request_count_correction(uuid, text, uuid, date, text, text, text, integer, uuid, text, text, date), decide_count_correction(uuid, text, text, uuid, text, text)
  FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT EXECUTE ON FUNCTION current_tenant_billing_counts(), request_count_correction(uuid, text, uuid, date, text, text, text, integer, uuid, text, text, date),
      decide_count_correction(uuid, text, text, uuid, text, text) TO erp_app;
  END IF;
END $$;

-- Rôle de la plateforme : droits des comptages dans une fonction à part, comme ceux de la facturation (lot G5a) et des
-- prestations (lot G5g) ; infra/postgres/role-plateforme.sh l'appelle à chaque installation. Lecture des comptages
-- (des nombres) et enregistrement par la seule fonction ci-dessus ; aucun droit sur les listes ni sur les demandes.
CREATE OR REPLACE FUNCTION grant_platform_counts_role() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_platform') THEN
    RAISE NOTICE 'Rôle erp_platform absent : droits non attribués (poste de développement)';
    RETURN;
  END IF;
  GRANT SELECT ON billing_counts TO erp_platform;
  GRANT EXECUTE ON FUNCTION record_billing_count(uuid, uuid, text, date, text, integer, jsonb, timestamptz, timestamptz, date) TO erp_platform;
END $$;

SELECT grant_platform_counts_role();
