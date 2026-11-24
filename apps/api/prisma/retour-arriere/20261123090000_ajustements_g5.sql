-- Retour arrière de la migration 20261123090000_ajustements_g5 (API arrêtée, avant de remettre le code précédent).
-- Retire le statut commercial des établissements (« test » ou « client réel ») et ses contrôles, la confirmation d'une
-- date de départ introuvable, les corrections de départ faites hors de tout comptage et la contestation d'un départ
-- antérieur au comptage (G5b-2 ; les contestations déjà demandées restent, vues comme des exclusions), les liens des
-- exclusions vers leur document d'origine (G5c-9), la ressaisie désignée d'un paiement annulé, l'empreinte des
-- justificatifs et le motif d'un paiement semblable (G5d2-5), les dérogations du Super Admin au délai de 30 jours
-- (lecture 1 du 24 novembre 2026) et le retour d'un élève dans le compte après une exclusion ou une contestation validée
-- (lecture 3). Remet les fonctions des lots G5a, G5b, G5c, G5d-1 et G5d-2 telles qu'elles étaient. Ne touche à aucune autre donnée : comptages, documents, avoirs, paiements et abonnements
-- restent tels qu'ils sont. À passer avant celui de G5d-2 si plusieurs lots doivent être retirés.
-- Attention : après ce retour arrière, les établissements de test ne sont plus protégés par la base ; le code
-- précédent ne connaît pas ce statut (aucun abonnement n'est ouvert en production à ce jour pour un établissement de
-- test : à vérifier avant de lancer le script).
-- Les lignes déjà inscrites dans les journaux de la plateforme, des groupes et des écoles, dans l'historique des
-- abonnements et dans les alertes du Super Admin restent : ils sont en ajout seul. Une fois le script passé, la
-- migration peut être rejouée par une nouvelle mise à jour (tous les établissements redeviennent alors « test »).
-- Contrôle de sécurité : s'il existe un établissement passé en client réel, un lien d'exclusion inscrit depuis la mise à
-- jour (ceux qu'elle a inscrits pour les exclusions plus anciennes se déduisent des données gardées), une correction
-- faite hors comptage, une confirmation de date introuvable ou une contestation de départ, une dérogation au délai de
-- 30 jours, un élève revenu après une exclusion validée (le lot G5c le retirerait de toute l'année), ou un paiement qui
-- porte une ressaisie, une empreinte de justificatif ou un motif, le script les compte et S'ARRÊTE sans rien changer. Pour passer outre en connaissance de
-- cause seulement (ces données seront perdues : gardez d'abord une sauvegarde hors du serveur) :
-- PGOPTIONS="-c cahiora.forcer_retour=oui".
-- Lancement :
--   docker compose exec -T postgres psql -U postgres erp -v ON_ERROR_STOP=1 < apps/api/prisma/retour-arriere/20261123090000_ajustements_g5.sql
BEGIN;

DO $$
DECLARE
  n_clients int;
  n_links int;
  n_corrections int := 0;
  n_returns int := 0;
  n_derogations int;
  n_payments int;
  t record;
BEGIN
  SELECT count(*) INTO n_clients FROM tenants WHERE "commercialStatus" = 'CLIENT';
  SELECT count(*) INTO n_links FROM billing_exclusion_links l
   WHERE l."createdAt" > coalesce((SELECT m.finished_at AT TIME ZONE 'UTC' FROM _prisma_migrations m WHERE m.migration_name = '20261123090000_ajustements_g5'), '-infinity');
  -- Corrections cloisonnées par école (Row Level Security forcée, sauf pour un superutilisateur) : lues école par école.
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    n_corrections := n_corrections + (SELECT count(*) FROM count_corrections WHERE tenant_id = t.id
      AND ("countId" IS NULL OR kind::text = 'DEPARTURE_CONFIRMED' OR (kind::text = 'EXCLUSION' AND "departureDate" IS NOT NULL)));
    n_returns := n_returns + (SELECT count(*) FROM count_corrections k WHERE k.tenant_id = t.id AND k.kind::text = 'EXCLUSION' AND k.status = 'VALIDATED'
      AND EXISTS (SELECT 1 FROM enrollment_events r WHERE r."enrollmentId" = k."enrollmentId" AND r.kind = 'REINSTATED' AND r."createdAt" > k."requestedAt"));
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
  SELECT count(*) INTO n_derogations FROM count_request_derogations;
  SELECT count(*) INTO n_payments FROM billing_payments WHERE "replacesPaymentId" IS NOT NULL OR "proofSha256" IS NOT NULL OR "similarReason" IS NOT NULL;
  IF n_clients + n_links + n_corrections + n_returns + n_derogations + n_payments > 0 AND coalesce(current_setting('cahiora.forcer_retour', true), '') <> 'oui' THEN
    RAISE EXCEPTION 'Retour arrière arrêté, rien n''a été changé : % établissement(s) en client réel, % lien(s) d''exclusion, % correction(s) de départ hors comptage, date introuvable ou contestation de départ, % élève(s) revenu(s) après une exclusion ou une contestation validée, % dérogation(s) au délai de 30 jours, % paiement(s) avec ressaisie, empreinte ou motif',
      n_clients, n_links, n_corrections, n_returns, n_derogations, n_payments;
  END IF;
END $$;

-- Contrôles des établissements de test.
DROP TRIGGER IF EXISTS subscriptions_test_guard ON subscriptions;
DROP TRIGGER IF EXISTS subscriptions_test_frozen ON subscriptions;
DROP TRIGGER IF EXISTS billing_counts_test_guard ON billing_counts;
DROP TRIGGER IF EXISTS billing_document_lines_test_guard ON billing_document_lines;
DROP TRIGGER IF EXISTS billing_payments_test_guard ON billing_payments;
DROP TRIGGER IF EXISTS billing_credit_entries_test_guard ON billing_credit_entries;
DROP TRIGGER IF EXISTS billing_refunds_test_guard ON billing_refunds;
DROP TRIGGER IF EXISTS billing_credit_transfers_test_guard ON billing_credit_transfers;
DROP TRIGGER IF EXISTS regularization_requests_test_guard ON regularization_requests;
DROP TRIGGER IF EXISTS tenants_commercial_status_guard ON tenants;
DROP FUNCTION IF EXISTS tenants_commercial_status_guard();
DROP FUNCTION IF EXISTS billing_test_tenant_guard();

-- Fonctions de l'abonnement et de l'accès de l'école, telles qu'aux lots G5a et G5d-1.
CREATE OR REPLACE FUNCTION current_tenant_subscription() RETURNS TABLE (
  status text, status_since timestamp, trial_start date, trial_end date, trial_days integer, pilot_start date, pilot_end date, pilot_months integer,
  accepted_at timestamp, accepted_by_name text, accepted_terms_version integer, accepted_tariff jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.status::text, s."statusSince", s."trialStart", s."trialEnd", s."trialDays", s."pilotStart", s."pilotEnd", s."pilotMonths",
         s."acceptedAt", s."acceptedByName", c.version, s."acceptedTariff"
  FROM subscriptions s LEFT JOIN commercial_terms c ON c.id = s."acceptedTermsId"
  WHERE s.tenant_id = app_current_tenant()
$$;

CREATE OR REPLACE FUNCTION current_tenant_subscription_access() RETURNS TABLE (
  status text, grace_start date, grace_end date, extended_until date, limited_since timestamp, terms_accepted boolean, pending_request boolean,
  notice_until timestamp)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.status::text, s."graceStart", s."graceEnd", s."extendedUntil", s."limitedSince", s."acceptedAt" IS NOT NULL,
         EXISTS (SELECT 1 FROM regularization_requests r WHERE r.tenant_id = s.tenant_id AND r.status = 'PENDING'),
         CASE WHEN s."noticeGraceEnd" IS NOT DISTINCT FROM s."graceEnd" THEN s."noticeUntil" END
  FROM subscriptions s
  WHERE s.tenant_id = app_current_tenant()
$$;

DROP FUNCTION IF EXISTS tenant_is_test(uuid);
ALTER TABLE tenants DROP COLUMN IF EXISTS "commercialStatus", DROP COLUMN IF EXISTS "commercialStatusAt";
DROP TYPE IF EXISTS "CommercialStatus";

-- G5c-9 : liens des exclusions (les avoirs déjà émis gardent leur exclusion et leur document corrigé).
DROP TRIGGER IF EXISTS count_corrections_exclusion_link ON count_corrections;
DROP TRIGGER IF EXISTS billing_document_lines_credit_link ON billing_document_lines;
DROP FUNCTION IF EXISTS billing_exclusion_link_on_decision();
DROP FUNCTION IF EXISTS billing_credit_note_link_check();
DROP FUNCTION IF EXISTS billing_exclusion_origin(uuid, uuid);
DROP TABLE IF EXISTS billing_exclusion_links;

-- G5b-2 : corrections de départ hors comptage et confirmations de date introuvable (si le retour est forcé), puis le
-- type de correction sans DEPARTURE_CONFIRMED, et le comptage de nouveau obligatoire.
ALTER TABLE count_corrections DISABLE TRIGGER count_corrections_no_delete;
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    DELETE FROM count_corrections WHERE tenant_id = t.id AND ("countId" IS NULL OR kind::text = 'DEPARTURE_CONFIRMED');
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
ALTER TABLE count_corrections ENABLE TRIGGER count_corrections_no_delete;
ALTER TABLE count_corrections DROP CONSTRAINT IF EXISTS count_corrections_count_check, DROP CONSTRAINT IF EXISTS count_corrections_confirmed_check;
ALTER TABLE count_corrections ALTER COLUMN "countId" SET NOT NULL;
ALTER TYPE "CountCorrectionKind" RENAME TO "CountCorrectionKind_ajustements";
CREATE TYPE "CountCorrectionKind" AS ENUM ('EXCLUSION', 'DEPARTURE_DATE');
ALTER TABLE count_corrections ALTER COLUMN kind TYPE "CountCorrectionKind" USING kind::text::"CountCorrectionKind";
-- Le type recréé appartient au propriétaire des tables (celui des migrations), jamais au compte qui passe ce script.
DO $$
BEGIN
  EXECUTE format('ALTER TYPE "CountCorrectionKind" OWNER TO %I', (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'count_corrections'::regclass));
END $$;
DROP TYPE "CountCorrectionKind_ajustements";

-- Demande de correction et enregistrement d'un comptage, tels qu'aux lots G5c et G5b.
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

-- Lectures 1 et 3 (24 novembre 2026, soir) : élèves facturables et date du document tels qu'au lot G5c (toute exclusion
-- validée retire l'élève de l'année), contrôle des demandes tel qu'au lot G5b ; dérogations retirées (les demandes déjà
-- faites restent, sans leur lien vers la dérogation).
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

DROP FUNCTION IF EXISTS grant_count_request_derogation(uuid, text, text, text, uuid, text, text, date);
DROP FUNCTION IF EXISTS current_tenant_count_derogations();
DROP FUNCTION IF EXISTS billing_counts_billable_if(uuid, uuid);
DROP FUNCTION IF EXISTS billing_enrollment_document_asof(uuid, uuid, text, timestamp, uuid);
DROP FUNCTION IF EXISTS billing_item_voided(uuid, date, timestamp, timestamp, uuid, uuid);
ALTER TABLE count_corrections DROP CONSTRAINT IF EXISTS "count_corrections_derogationId_fkey";
DROP INDEX IF EXISTS "count_corrections_derogationId_key";
ALTER TABLE count_corrections DROP COLUMN IF EXISTS "derogationId";
DROP TABLE IF EXISTS count_request_derogations;

-- Liste des exclusions du Super Admin telle qu'au lot G5c (sans la date d'un départ contesté). Fonction recréée : même
-- propriétaire que les tables, aucun droit sauf pour le rôle de la plateforme (grant_platform_documents_role).
DROP FUNCTION IF EXISTS platform_count_exclusions();
CREATE FUNCTION platform_count_exclusions() RETURNS TABLE (
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
DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION platform_count_exclusions() OWNER TO %I', (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'count_corrections'::regclass));
END $$;
REVOKE ALL ON FUNCTION platform_count_exclusions() FROM PUBLIC;
SELECT grant_platform_documents_role();

-- G5d2-5 : ressaisie, empreinte et motif des paiements ; enregistrement d'un paiement tel qu'au lot G5d-2.
DROP TRIGGER IF EXISTS billing_payments_links_guard ON billing_payments;
DROP FUNCTION IF EXISTS billing_payments_links_guard();
-- Le contrôle « même école » de la ressaisie part avec sa colonne (aucune autre référence contrôlée sur cette table).
DROP TRIGGER IF EXISTS same_tenant_refs ON billing_payments;
DROP FUNCTION IF EXISTS record_billing_payment(uuid, uuid, integer, date, text, text, text, text, text, uuid, text, text, date, uuid, text, text);
ALTER TABLE billing_payments DROP CONSTRAINT IF EXISTS billing_payments_links_check;
ALTER TABLE billing_payments DROP CONSTRAINT IF EXISTS "billing_payments_replacesPaymentId_fkey";
DROP INDEX IF EXISTS "billing_payments_replacesPaymentId_key";
DROP INDEX IF EXISTS "billing_payments_proofSha256_idx";
ALTER TABLE billing_payments DROP COLUMN IF EXISTS "replacesPaymentId", DROP COLUMN IF EXISTS "proofSha256", DROP COLUMN IF EXISTS "similarReason";

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

-- Fonction recréée : même propriétaire que les tables (sinon elle tournerait avec les droits du compte qui passe ce
-- script), et aucun droit pour les autres rôles que celui de la plateforme.
DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION record_billing_payment(uuid, uuid, integer, date, text, text, text, text, text, uuid, text, text, date) OWNER TO %I',
                 (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'billing_payments'::regclass));
END $$;
REVOKE ALL ON FUNCTION record_billing_payment(uuid, uuid, integer, date, text, text, text, text, text, uuid, text, text, date) FROM PUBLIC;

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
DROP FUNCTION IF EXISTS grant_platform_ajustements_role();
-- Contrôles « même école » d'après les clés étrangères restantes.
SELECT install_same_tenant_checks();

DELETE FROM _prisma_migrations WHERE migration_name = '20261123090000_ajustements_g5';

COMMIT;
