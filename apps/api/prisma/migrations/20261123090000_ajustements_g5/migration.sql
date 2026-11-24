-- Ajustements des lectures de G5b, G5c et G5d-2, et établissements de test : demande de Dankou du 20 novembre 2026
-- (21 h 44 UTC). « Tous les établissements actuellement présents sur CAHIORA sont utilisés pour les tests. Aucun n'est
-- encore considéré comme un client commercial réel. Vérifie que les établissements de test ne peuvent être ni facturés
-- réellement ni automatiquement limités. Maintiens les paiements réels désactivés. »
-- - Établissements de test : statut commercial de chaque établissement, « test » par défaut, y compris pour tous ceux
--   qui existent déjà ; seul le Super Admin le passe en « client réel », tant qu'aucun abonnement n'est ouvert. Un
--   établissement de test n'a ni essai, ni pilote, ni abonnement, ni comptage, ni document, ni paiement, ni crédit, et
--   son accès n'est jamais limité : la base le refuse elle-même, quel que soit le chemin.
-- - G5b-2 : un élève parti sans date connue reste « À vérifier » ; la direction fixe la date ou confirme qu'elle est
--   introuvable, avant le comptage (période gratuite comprise) ou pendant sa vérification. Rien n'est exclu sans elle.
-- - G5c-9 : chaque avoir est relié par la base à l'exclusion qui le cause et au document d'origine (le premier document
--   qui a demandé l'élève) ; le document corrigé reste celui auquel l'avoir est lié.
-- - G5d2-5 : la ressaisie d'un paiement annulé est désignée et ne se fait qu'une fois (au besoin pour un autre
--   établissement, s'il avait été choisi par erreur) ; un justificatif déjà joint à un autre paiement, ou un paiement
--   semblable (même établissement, montant et moyen, à 3 jours près), exige un motif.
-- Aucune donnée existante n'est modifiée ni supprimée : colonnes et tables ajoutées, fonctions remplacées. Tout
-- s'applique en une seule transaction : en cas d'erreur, rien n'est changé. Retour arrière :
-- apps/api/prisma/retour-arriere/20261123090000_ajustements_g5.sql.

-- ---------------------------------------------------------------- 1. Établissements de test

-- CreateEnum
CREATE TYPE "CommercialStatus" AS ENUM ('TEST', 'CLIENT');

-- AlterTable : tous les établissements existants sont des établissements de test (consigne du 20 novembre 2026).
ALTER TABLE "tenants" ADD COLUMN "commercialStatus" "CommercialStatus" NOT NULL DEFAULT 'TEST',
  ADD COLUMN "commercialStatusAt" TIMESTAMP(3);

INSERT INTO platform_audit_logs (id, action, "tenantId", data)
  SELECT gen_random_uuid(), 'billing.commercial_status_initialized', NULL,
         jsonb_build_object('source', 'migration ajustements_g5', 'status', 'TEST', 'establishments', count(*),
                            'reason', 'Tous les établissements actuellement présents sur Cahiora servent aux tests (Dankou, 20 novembre 2026)')
  FROM tenants;

-- Établissement de test ? (lu par les contrôles ci-dessous, qui ne dépendent d'aucun rôle).
CREATE OR REPLACE FUNCTION tenant_is_test(p_tenant uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM tenants t WHERE t.id = p_tenant AND t."commercialStatus" = 'TEST')
$$;

-- Refus pour un établissement de test, quel que soit le chemin (API, tâche planifiée, propriétaire de la base) ; le
-- motif de chaque table vient de l'argument du déclencheur.
CREATE OR REPLACE FUNCTION billing_test_tenant_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_row jsonb := to_jsonb(NEW);
  v_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF v_row ? 'tenant_id' THEN
    v_ids := v_ids || (v_row->>'tenant_id')::uuid;
  END IF;
  IF v_row ? 'fromTenantId' THEN
    v_ids := v_ids || (v_row->>'fromTenantId')::uuid;
  END IF;
  IF v_row ? 'toTenantId' THEN
    v_ids := v_ids || (v_row->>'toTenantId')::uuid;
  END IF;
  IF EXISTS (SELECT 1 FROM tenants t WHERE t.id = ANY (v_ids) AND t."commercialStatus" = 'TEST') THEN
    RAISE EXCEPTION 'CAHIORA: établissement de test : %', TG_ARGV[0];
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER subscriptions_test_guard BEFORE INSERT ON subscriptions FOR EACH ROW
  EXECUTE FUNCTION billing_test_tenant_guard('aucun essai, pilote ni abonnement ne s''ouvre ; passez-le d''abord en client réel');
-- Un abonnement ouvert avant ce lot sur un établissement de test reste figé : ni fin d'essai, ni acceptation des
-- conditions, ni délai de grâce, ni accès limité, ni prolongation.
CREATE TRIGGER subscriptions_test_frozen BEFORE UPDATE ON subscriptions FOR EACH ROW
  EXECUTE FUNCTION billing_test_tenant_guard('son abonnement reste figé : ni fin d''essai, ni acceptation, ni délai de grâce, ni accès limité, ni prolongation');
CREATE TRIGGER billing_counts_test_guard BEFORE INSERT ON billing_counts FOR EACH ROW
  EXECUTE FUNCTION billing_test_tenant_guard('aucun comptage des élèves facturables');
CREATE TRIGGER billing_document_lines_test_guard BEFORE INSERT ON billing_document_lines FOR EACH ROW
  EXECUTE FUNCTION billing_test_tenant_guard('aucun document de Cahiora (proforma, relevé, avoir, devis)');
CREATE TRIGGER billing_payments_test_guard BEFORE INSERT ON billing_payments FOR EACH ROW
  EXECUTE FUNCTION billing_test_tenant_guard('aucun paiement ne s''enregistre');
CREATE TRIGGER billing_credit_entries_test_guard BEFORE INSERT ON billing_credit_entries FOR EACH ROW
  EXECUTE FUNCTION billing_test_tenant_guard('aucun crédit');
CREATE TRIGGER billing_refunds_test_guard BEFORE INSERT ON billing_refunds FOR EACH ROW
  EXECUTE FUNCTION billing_test_tenant_guard('aucun remboursement');
CREATE TRIGGER billing_credit_transfers_test_guard BEFORE INSERT ON billing_credit_transfers FOR EACH ROW
  EXECUTE FUNCTION billing_test_tenant_guard('aucun transfert de crédit');
CREATE TRIGGER regularization_requests_test_guard BEFORE INSERT ON regularization_requests FOR EACH ROW
  EXECUTE FUNCTION billing_test_tenant_guard('aucune demande de régularisation');

-- Le statut se change seulement tant qu'aucun abonnement ni aucun document de Cahiora n'existe pour l'établissement :
-- jamais de facturation ni de limitation rétroactive d'un ancien essai de test, jamais un client réel qui redevient
-- « test » avec un abonnement ou un document (devis, proforma). La date du changement s'inscrit d'elle-même ; l'API
-- écrit les journaux dans la même transaction.
CREATE OR REPLACE FUNCTION tenants_commercial_status_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."commercialStatus" IS DISTINCT FROM OLD."commercialStatus" THEN
    IF EXISTS (SELECT 1 FROM subscriptions s WHERE s.tenant_id = NEW.id)
       OR EXISTS (SELECT 1 FROM billing_document_lines l WHERE l.tenant_id = NEW.id) THEN
      RAISE EXCEPTION 'CAHIORA: le statut commercial d''un établissement se change seulement tant qu''aucun abonnement ni aucun document de Cahiora n''existe pour lui';
    END IF;
    NEW."commercialStatusAt" := timezone('UTC', now());
  ELSIF NEW."commercialStatusAt" IS DISTINCT FROM OLD."commercialStatusAt" THEN
    RAISE EXCEPTION 'CAHIORA: la date du statut commercial suit le changement du statut';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenants_commercial_status_guard BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION tenants_commercial_status_guard();

-- L'école lit son propre statut (bandeau « Établissement de test » de la page de l'abonnement).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT ("commercialStatus") ON tenants TO erp_app;
  END IF;
END $$;

-- Abonnement de l'école courante (remplace celle du lot G5a) : rien pour un établissement de test.
CREATE OR REPLACE FUNCTION current_tenant_subscription() RETURNS TABLE (
  status text, status_since timestamp, trial_start date, trial_end date, trial_days integer, pilot_start date, pilot_end date, pilot_months integer,
  accepted_at timestamp, accepted_by_name text, accepted_terms_version integer, accepted_tariff jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.status::text, s."statusSince", s."trialStart", s."trialEnd", s."trialDays", s."pilotStart", s."pilotEnd", s."pilotMonths",
         s."acceptedAt", s."acceptedByName", c.version, s."acceptedTariff"
  FROM subscriptions s LEFT JOIN commercial_terms c ON c.id = s."acceptedTermsId"
  WHERE s.tenant_id = app_current_tenant() AND NOT tenant_is_test(s.tenant_id)
$$;

-- Accès de l'école courante (remplace celle du lot G5d-1) : rien pour un établissement de test, donc jamais de bandeau,
-- d'alerte ni d'accès limité (le contrôle des routes lit cette fonction).
CREATE OR REPLACE FUNCTION current_tenant_subscription_access() RETURNS TABLE (
  status text, grace_start date, grace_end date, extended_until date, limited_since timestamp, terms_accepted boolean, pending_request boolean,
  notice_until timestamp)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.status::text, s."graceStart", s."graceEnd", s."extendedUntil", s."limitedSince", s."acceptedAt" IS NOT NULL,
         EXISTS (SELECT 1 FROM regularization_requests r WHERE r.tenant_id = s.tenant_id AND r.status = 'PENDING'),
         CASE WHEN s."noticeGraceEnd" IS NOT DISTINCT FROM s."graceEnd" THEN s."noticeUntil" END
  FROM subscriptions s
  WHERE s.tenant_id = app_current_tenant() AND NOT tenant_is_test(s.tenant_id)
$$;

-- ---------------------------------------------------------------- 2. G5b-2 : élèves « À vérifier »

-- Nouvelle correction : la direction confirme qu'une date de départ est introuvable (l'élève reste compté, sans être
-- « À vérifier »). Une correction de départ peut se faire hors de tout comptage, avant lui (période gratuite comprise).
ALTER TYPE "CountCorrectionKind" ADD VALUE IF NOT EXISTS 'DEPARTURE_CONFIRMED';
ALTER TABLE "count_corrections" ALTER COLUMN "countId" DROP NOT NULL;
ALTER TABLE "count_corrections" ADD CONSTRAINT "count_corrections_count_check" CHECK ("countId" IS NOT NULL OR "kind" <> 'EXCLUSION');
ALTER TABLE "count_corrections" ADD CONSTRAINT "count_corrections_confirmed_check" CHECK ("kind"::text <> 'DEPARTURE_CONFIRMED' OR "departureDate" IS NULL);

-- Demande de correction par la direction de tout l'établissement courant (remplace celle du lot G5c) :
-- - pendant la vérification d'un comptage provisoire : EXCLUSION d'une inscription annulée pour erreur de saisie, qui
--   attend une décision ; DEPARTURE_DATE d'un départ enregistré avant l'historique des inscriptions (D-G5-16 A), ou
--   DEPARTURE_CONFIRMED (date introuvable, l'élève reste compté), qui valent aussitôt ;
-- - hors de tout comptage (p_count NULL, G5b-2) : DEPARTURE_DATE ou DEPARTURE_CONFIRMED, pour qu'aucun élève ne reste
--   « À vérifier » au comptage suivant, y compris celui de la fin d'une période gratuite, figé aussitôt ;
-- - après, sur un comptage figé (D-G5-14 A) : EXCLUSION seulement, jusqu'à 30 jours après le dernier document qui a
--   demandé l'élève (sans limite tant qu'aucun document ne l'a demandé).
-- Jamais pour un départ réel : l'inscription doit être annulée. Journaux de la plateforme (avec le matricule, sans la
-- justification) et du groupe (sans le matricule) ; l'API trace le journal de l'école.
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
  v_year uuid;
  v_year_label text;
  v_stage text;
  v_count_kind text;
  v_reference date;
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
  IF p_kind NOT IN ('EXCLUSION', 'DEPARTURE_DATE', 'DEPARTURE_CONFIRMED') THEN
    RAISE EXCEPTION 'CAHIORA: type de correction inconnu';
  END IF;
  IF length(btrim(coalesce(p_justification, ''))) < 5 THEN
    RAISE EXCEPTION 'CAHIORA: la justification est obligatoire (5 caractères au moins)';
  END IF;
  IF p_count IS NULL THEN
    IF p_kind = 'EXCLUSION' THEN
      RAISE EXCEPTION 'CAHIORA: une exclusion se demande sur un comptage';
    END IF;
    SELECT en."academicYearId" INTO v_year FROM enrollments en WHERE en.id = p_enrollment AND en.tenant_id = v_tenant;
    SELECT y.label INTO v_year_label FROM academic_years y WHERE y.id = v_year;
  ELSE
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
    v_year := b."academicYearId";
    v_year_label := b."yearLabel";
    v_stage := b.stage::text;
    v_count_kind := b.kind::text;
    v_reference := b."referenceDate";
  END IF;
  SELECT en.id, en.status, st.matricule INTO e FROM enrollments en JOIN students st ON st.id = en."studentId"
   WHERE en.id = p_enrollment AND en.tenant_id = v_tenant AND en."academicYearId" = v_year;
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
    v_document := billing_enrollment_document(v_tenant, p_enrollment, v_year_label);
    IF v_stage = 'FROZEN' THEN
      IF NOT EXISTS (SELECT 1 FROM billing_count_items i JOIN billing_counts f ON f.id = i."countId"
                     WHERE i."enrollmentId" = p_enrollment AND i.counted AND f.tenant_id = v_tenant AND f."yearLabel" = v_year_label
                       AND f.stage = 'FROZEN' AND f."referenceDate" <= v_reference) THEN
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
    IF e.status NOT IN ('TRANSFERRED', 'WITHDRAWN')
       AND NOT EXISTS (SELECT 1 FROM enrollment_events v WHERE v."enrollmentId" = p_enrollment AND v.kind = 'REINSTATED') THEN
      RAISE EXCEPTION 'CAHIORA: cette inscription n''a pas de départ enregistré avant l''historique des inscriptions';
    END IF;
    IF p_kind = 'DEPARTURE_DATE' THEN
      IF p_departure IS NULL THEN
        RAISE EXCEPTION 'CAHIORA: la date de départ est obligatoire';
      END IF;
      IF p_departure > p_today THEN
        RAISE EXCEPTION 'CAHIORA: la date de départ ne peut pas être dans le futur';
      END IF;
      v_action := 'billing.count_departure_dated';
    ELSE
      IF p_departure IS NOT NULL THEN
        RAISE EXCEPTION 'CAHIORA: une confirmation de date introuvable ne porte pas de date de départ';
      END IF;
      IF EXISTS (SELECT 1 FROM count_corrections k WHERE k."enrollmentId" = p_enrollment AND k.kind::text IN ('DEPARTURE_DATE', 'DEPARTURE_CONFIRMED') AND k.status = 'VALIDATED') THEN
        RAISE EXCEPTION 'CAHIORA: la date de départ de cet élève est déjà fixée ou confirmée introuvable';
      END IF;
      v_action := 'billing.count_departure_confirmed';
    END IF;
    v_status := 'VALIDATED';
  END IF;
  INSERT INTO count_corrections (id, tenant_id, kind, "enrollmentId", "countId", "departureDate", justification, "fileKey", "fileMime", "fileSize", status,
                                 "requestedById", "requestedByName", "requestedAt", "decidedByKind", "decidedById", "decidedByName", "decidedAt")
    VALUES (v_id, v_tenant, p_kind::"CountCorrectionKind", p_enrollment, p_count, p_departure, btrim(p_justification), p_file_key, p_file_mime, p_file_size, v_status,
            p_user, p_user_name, v_now,
            CASE WHEN v_status = 'VALIDATED' THEN 'school' END, CASE WHEN v_status = 'VALIDATED' THEN p_user END,
            CASE WHEN v_status = 'VALIDATED' THEN p_user_name END, CASE WHEN v_status = 'VALIDATED' THEN v_now END);
  INSERT INTO platform_audit_logs (id, action, "tenantId", data, ip, "createdAt")
    VALUES (gen_random_uuid(), v_action, v_tenant,
            jsonb_build_object('countKind', v_count_kind, 'referenceDate', v_reference, 'yearLabel', v_year_label, 'matricule', e.matricule,
                               'departureDate', p_departure, 'by', p_user_name, 'documentDate', v_document, 'outsideCount', p_count IS NULL), p_ip, v_now);
  INSERT INTO group_audit_logs (id, group_id, "actorKind", "actorId", "actorName", action, data, "createdAt")
    SELECT gen_random_uuid(), t.group_id, 'school', p_user, p_user_name, v_action,
           jsonb_build_object('tenantName', t.name, 'countKind', v_count_kind, 'referenceDate', v_reference, 'yearLabel', v_year_label), v_now
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

-- Enregistre un comptage (remplace celle du lot G5b) : même contrôles, plus le motif DEPARTURE_CONFIRMED (date
-- introuvable confirmée par la direction : compté, sans date ou avec la date du journal postérieure au jour R), qui ne
-- compte plus parmi les élèves « À vérifier ».
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
           OR x.basis NOT IN ('ACTIVE', 'DEPARTURE_AUDIT', 'DEPARTURE_UNKNOWN', 'DEPARTURE_DIRECTION', 'DEPARTURE_CONFIRMED', 'EXCLUDED')
           OR (x.basis = 'EXCLUDED') = x.counted
           OR (x.basis IN ('ACTIVE', 'DEPARTURE_UNKNOWN') AND x."departureDate" IS NOT NULL)
           OR (x.basis IN ('DEPARTURE_AUDIT', 'DEPARTURE_DIRECTION') AND (x."departureDate" IS NULL OR x."departureDate" <= p_date))
           OR (x.basis = 'DEPARTURE_CONFIRMED' AND x."departureDate" IS NOT NULL AND x."departureDate" <= p_date)),
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

-- ---------------------------------------------------------------- 3. G5c-9 : avoir, exclusion et document d'origine

-- CreateTable : une ligne par exclusion validée par le Super Admin (D-G5-13 B), inscrite par la base au moment de la
-- décision : le document d'origine est le premier document d'abonnement de l'année qui a demandé l'élève. L'avoir cite
-- l'exclusion (billing_document_lines."correctionId", une seule fois) et le document corrigé ("relatedDocumentId").
CREATE TABLE "billing_exclusion_links" (
    "correctionId" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "originDocumentId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_exclusion_links_pkey" PRIMARY KEY ("correctionId")
);
CREATE INDEX "billing_exclusion_links_originDocumentId_idx" ON "billing_exclusion_links"("originDocumentId");
ALTER TABLE "billing_exclusion_links" ADD CONSTRAINT "billing_exclusion_links_correctionId_fkey" FOREIGN KEY ("correctionId") REFERENCES "count_corrections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_exclusion_links" ADD CONSTRAINT "billing_exclusion_links_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_exclusion_links" ADD CONSTRAINT "billing_exclusion_links_originDocumentId_fkey" FOREIGN KEY ("originDocumentId") REFERENCES "billing_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER billing_exclusion_links_append_only BEFORE UPDATE OR DELETE ON billing_exclusion_links FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER billing_exclusion_links_no_truncate BEFORE TRUNCATE ON billing_exclusion_links FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
ALTER TABLE billing_exclusion_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_exclusion_links FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_exclusion_links_owner_all ON billing_exclusion_links TO erp_owner USING (true) WITH CHECK (true);
CREATE POLICY billing_exclusion_links_platform_all ON billing_exclusion_links TO PUBLIC USING (current_user = 'erp_platform') WITH CHECK (current_user = 'erp_platform');
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    REVOKE ALL ON billing_exclusion_links FROM erp_app;
  END IF;
END $$;

-- Document d'origine d'une exclusion (premier document d'abonnement de l'année qui a demandé l'inscription) et document
-- corrigé (dernier document d'abonnement de l'année de l'établissement), NULL s'il n'y en a pas ; avec le matricule
-- (jamais le nom), le comptage et les dates de la demande et de la décision, pour l'avoir et la console.
CREATE OR REPLACE FUNCTION billing_exclusion_origin(p_tenant uuid, p_correction uuid)
  RETURNS TABLE (origin_id uuid, origin_reference text, origin_issue_date date, corrected_id uuid, corrected_reference text, corrected_issue_date date,
                 matricule text, count_kind text, reference_date date, year_label text, requested_at timestamp, decided_at timestamp)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  k record;
  v_year text;
  v_kind text;
  v_reference date;
  v_first date;
  v_matricule text;
  o record;
  c record;
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  SELECT x.* INTO k FROM count_corrections x WHERE x.id = p_correction AND x.tenant_id = p_tenant;
  IF NOT FOUND OR k.kind <> 'EXCLUSION' THEN
    RAISE EXCEPTION 'CAHIORA: demande d''exclusion introuvable';
  END IF;
  SELECT b."yearLabel", b.kind::text, b."referenceDate" INTO v_year, v_kind, v_reference FROM billing_counts b WHERE b.id = k."countId";
  SELECT st.matricule INTO v_matricule FROM enrollments en JOIN students st ON st.id = en."studentId" WHERE en.id = k."enrollmentId";
  SELECT min(b."referenceDate") INTO v_first
    FROM billing_count_items i JOIN billing_counts b ON b.id = i."countId"
   WHERE i."enrollmentId" = k."enrollmentId" AND i.counted AND b.tenant_id = p_tenant AND b."yearLabel" = v_year AND b.stage = 'FROZEN';
  SELECT d.id, d.reference, d."issueDate" INTO o
    FROM billing_document_lines l JOIN billing_documents d ON d.id = l."documentId"
   WHERE l.tenant_id = p_tenant AND d.kind = 'SUBSCRIPTION' AND d."yearLabel" = v_year AND v_first IS NOT NULL AND l."referenceDate" >= v_first
   ORDER BY l."referenceDate", d."createdAt" LIMIT 1;
  SELECT d.id, d.reference, d."issueDate" INTO c
    FROM billing_document_lines l JOIN billing_documents d ON d.id = l."documentId"
   WHERE l.tenant_id = p_tenant AND d.kind = 'SUBSCRIPTION' AND d."yearLabel" = v_year
   ORDER BY l."referenceDate" DESC, d."createdAt" DESC LIMIT 1;
  RETURN QUERY SELECT o.id, o.reference, o."issueDate", c.id, c.reference, c."issueDate", v_matricule, v_kind, v_reference, v_year, k."requestedAt", k."decidedAt";
END $$;

-- La décision du Super Admin inscrit le lien (une seule fois) ; une exclusion décidée par la direction avant tout
-- document n'a ni document d'origine ni avoir.
CREATE OR REPLACE FUNCTION billing_exclusion_link_on_decision() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_origin uuid;
BEGIN
  IF NEW.kind = 'EXCLUSION' AND NEW.status = 'VALIDATED' AND OLD.status = 'PENDING' AND NEW."decidedByKind" = 'platform' THEN
    SELECT x.origin_id INTO v_origin FROM billing_exclusion_origin(NEW.tenant_id, NEW.id) x;
    IF v_origin IS NULL THEN
      RAISE EXCEPTION 'CAHIORA: document d''origine introuvable pour cette exclusion';
    END IF;
    INSERT INTO billing_exclusion_links ("correctionId", tenant_id, "originDocumentId", "createdAt")
      VALUES (NEW.id, NEW.tenant_id, v_origin, timezone('UTC', now()));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER count_corrections_exclusion_link AFTER UPDATE ON count_corrections FOR EACH ROW EXECUTE FUNCTION billing_exclusion_link_on_decision();

-- Un avoir n'est émis que pour une exclusion reliée à son document d'origine ; le document qu'il cite (données du
-- document, « exclusion ») dit le même document d'origine et la même exclusion.
CREATE OR REPLACE FUNCTION billing_credit_note_link_check() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_origin uuid;
  v_data jsonb;
BEGIN
  IF NEW."correctionId" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT x."originDocumentId" INTO v_origin FROM billing_exclusion_links x WHERE x."correctionId" = NEW."correctionId" AND x.tenant_id = NEW.tenant_id;
  IF v_origin IS NULL THEN
    RAISE EXCEPTION 'CAHIORA: un avoir est toujours relié à son exclusion et au document d''origine (G5c-9)';
  END IF;
  SELECT d.data->'exclusion' INTO v_data FROM billing_documents d WHERE d.id = NEW."documentId";
  IF v_data IS NOT NULL AND (v_data->>'correctionId' IS DISTINCT FROM NEW."correctionId"::text OR v_data->>'originDocumentId' IS DISTINCT FROM v_origin::text) THEN
    RAISE EXCEPTION 'CAHIORA: exclusion ou document d''origine de l''avoir différents de ceux de la décision';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_document_lines_credit_link BEFORE INSERT ON billing_document_lines FOR EACH ROW EXECUTE FUNCTION billing_credit_note_link_check();

-- Exclusions déjà validées par le Super Admin (bases d'essai seulement : aucune en production) : leur lien est inscrit.
-- Les corrections sont cloisonnées par école (Row Level Security forcée, même pour le propriétaire de la base) : elles
-- se lisent école par école, puis l'école courante est vidée. Les exclusions sont choisies d'abord (MATERIALIZED).
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT id FROM tenants ORDER BY id LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    WITH k AS MATERIALIZED (
      SELECT x.id, x.tenant_id FROM count_corrections x
      WHERE x.tenant_id = t.id AND x.kind = 'EXCLUSION' AND x.status = 'VALIDATED' AND x."decidedByKind" = 'platform'
    )
    INSERT INTO billing_exclusion_links ("correctionId", tenant_id, "originDocumentId", "createdAt")
      SELECT k.id, k.tenant_id, o.origin_id, timezone('UTC', now())
      FROM k CROSS JOIN LATERAL billing_exclusion_origin(k.tenant_id, k.id) o
      WHERE o.origin_id IS NOT NULL;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;


-- ---------------------------------------------------------------- 4. G5d2-5 : doubles saisies après une annulation

ALTER TABLE "billing_payments" ADD COLUMN "replacesPaymentId" UUID, ADD COLUMN "proofSha256" TEXT, ADD COLUMN "similarReason" TEXT;
CREATE UNIQUE INDEX "billing_payments_replacesPaymentId_key" ON "billing_payments"("replacesPaymentId");
CREATE INDEX "billing_payments_proofSha256_idx" ON "billing_payments"("proofSha256");
-- Pas de clé étrangère : la ressaisie peut viser le paiement annulé d'un autre établissement (choisi par erreur), ce que
-- le contrôle « même école » des clés étrangères refuserait ; la fonction ci-dessous vérifie que ce paiement existe, et
-- aucun paiement ne se supprime (billing_payments_no_delete). Le lien n'est lu que par la plateforme.
ALTER TABLE "billing_payments" ADD CONSTRAINT "billing_payments_links_check" CHECK (("proofSha256" IS NULL OR "proofSha256" ~ '^[0-9a-f]{64}$')
  AND ("similarReason" IS NULL OR length(btrim("similarReason")) BETWEEN 5 AND 300) AND "replacesPaymentId" IS DISTINCT FROM id);

-- Ressaisie, empreinte du justificatif et motif d'un paiement semblable ne changent jamais.
CREATE OR REPLACE FUNCTION billing_payments_links_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."replacesPaymentId", NEW."proofSha256", NEW."similarReason") IS DISTINCT FROM (OLD."replacesPaymentId", OLD."proofSha256", OLD."similarReason") THEN
    RAISE EXCEPTION 'Un paiement enregistré ne se modifie pas : une erreur de saisie s''annule par une contre-écriture';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_payments_links_guard BEFORE UPDATE ON billing_payments FOR EACH ROW EXECUTE FUNCTION billing_payments_links_guard();

-- Contrôle « même école » (SEC-001) des nouvelles clés étrangères : le lien d'une exclusion cite une demande du même
-- établissement.
SELECT install_same_tenant_checks();

-- Enregistre un paiement reçu (remplace celle du lot G5d-2, qui disparaît : l'API appelle celle-ci). Mêmes contrôles,
-- plus (G5d2-5) :
-- - une référence déjà portée par un paiement annulé ne revient que dans sa ressaisie, désignée (p_replaces) ; un
--   paiement annulé ne se ressaisit qu'une fois, pour son établissement ou pour celui qui aurait dû être choisi ;
-- - un justificatif (empreinte SHA-256 du fichier) déjà joint à un autre paiement exige un motif (relevé qui couvre
--   plusieurs versements, par exemple), sauf à la ressaisie du paiement annulé qu'il justifiait ;
-- - un paiement semblable (même établissement, même montant, même moyen, à 3 jours près), validé ou annulé sans
--   ressaisie, exige un motif (« autre versement ») ; la ressaisie elle-même n'est pas « semblable » au paiement annulé.
DROP FUNCTION record_billing_payment(uuid, uuid, integer, date, text, text, text, text, text, uuid, text, text, date);
CREATE OR REPLACE FUNCTION record_billing_payment(
  p_tenant uuid, p_document uuid, p_amount integer, p_paid_on date, p_means_code text, p_reference text, p_proof_key text, p_proof_mime text,
  p_note text, p_admin uuid, p_admin_name text, p_ip text, p_today date, p_replaces uuid, p_proof_sha256 text, p_similar_reason text)
  RETURNS TABLE (payment_id uuid, receipt_number text, expected integer, allocated integer, credit integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid := gen_random_uuid();
  v_now timestamp := timezone('UTC', now());
  v_key text := upper(regexp_replace(coalesce(p_reference, ''), '\s+', '', 'g'));
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_similar text := nullif(btrim(coalesce(p_similar_reason, '')), '');
  v_has_similar boolean := false;
  v_same_proof boolean := false;
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
  r record;
  z record;
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
  IF coalesce(p_proof_sha256, '') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'CAHIORA: empreinte du justificatif absente ou invalide';
  END IF;
  IF length(v_note) > 500 THEN
    RAISE EXCEPTION 'CAHIORA: commentaire : 500 caractères au plus';
  END IF;
  IF v_similar IS NOT NULL AND length(v_similar) NOT BETWEEN 5 AND 300 THEN
    RAISE EXCEPTION 'CAHIORA: motif d''un autre versement semblable : 5 à 300 caractères';
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
  -- Ressaisie d'un paiement annulé (G5d2-5).
  IF p_replaces IS NOT NULL THEN
    SELECT * INTO r FROM billing_payments bp WHERE bp.id = p_replaces FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CAHIORA: paiement annulé à ressaisir introuvable';
    END IF;
    IF r."cancelledAt" IS NULL THEN
      RAISE EXCEPTION 'CAHIORA: seul un paiement dont la saisie est annulée se ressaisit (reçu %)', r."receiptNumber";
    END IF;
    SELECT bp."receiptNumber" INTO z FROM billing_payments bp WHERE bp."replacesPaymentId" = p_replaces;
    IF FOUND THEN
      RAISE EXCEPTION 'CAHIORA: ce paiement annulé a déjà été ressaisi (reçu %) : une ressaisie ne se fait qu''une fois', z."receiptNumber";
    END IF;
  END IF;
  SELECT bp."receiptNumber" INTO z FROM billing_payments bp
   WHERE bp."transactionKey" = v_key AND bp."cancelledAt" IS NOT NULL AND bp.id IS DISTINCT FROM p_replaces
     AND NOT EXISTS (SELECT 1 FROM billing_payments n WHERE n."replacesPaymentId" = bp.id)
   ORDER BY bp."cancelledAt" DESC LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'CAHIORA: cette référence est celle du paiement annulé du reçu % : enregistrez la ressaisie de ce paiement en le désignant', z."receiptNumber";
  END IF;
  -- Un justificatif déjà joint à un autre paiement exige un motif (sauf la ressaisie du paiement annulé qu'il justifiait).
  SELECT bp."receiptNumber" INTO z FROM billing_payments bp WHERE bp."proofSha256" = p_proof_sha256 AND bp.id IS DISTINCT FROM p_replaces
   ORDER BY bp."recordedAt" DESC LIMIT 1;
  v_same_proof := FOUND;
  IF v_same_proof AND v_similar IS NULL THEN
    RAISE EXCEPTION 'CAHIORA: ce justificatif est déjà joint au paiement du reçu % : un même versement ne s''enregistre qu''une fois ; s''il justifie aussi un autre versement, donnez-en le motif', z."receiptNumber";
  END IF;
  -- Paiement semblable, validé ou annulé sans ressaisie : un motif est exigé.
  SELECT bp."receiptNumber", bp."paidOn", bp."cancelledAt" INTO z FROM billing_payments bp JOIN billing_payment_means pm ON pm.id = bp."meansId"
   WHERE bp.tenant_id = p_tenant AND bp.amount = p_amount AND pm.code = p_means_code AND abs(bp."paidOn" - p_paid_on) <= 3
     AND bp.id IS DISTINCT FROM p_replaces
     AND (bp."cancelledAt" IS NULL OR NOT EXISTS (SELECT 1 FROM billing_payments n WHERE n."replacesPaymentId" = bp.id))
   ORDER BY bp."recordedAt" DESC LIMIT 1;
  v_has_similar := FOUND;
  IF v_has_similar AND v_similar IS NULL THEN
    RAISE EXCEPTION '%', format('CAHIORA: paiement semblable déjà enregistré (reçu %s du %s, même montant et même moyen%s) : s''il s''agit d''un autre versement, donnez-en le motif',
      z."receiptNumber", to_char(z."paidOn", 'DD/MM/YYYY'), CASE WHEN z."cancelledAt" IS NOT NULL THEN ', saisie annulée sans ressaisie' ELSE '' END);
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
                                "recordedAt", ip, "replacesPaymentId", "proofSha256", "similarReason")
    VALUES (v_id, p_tenant, t.group_id, p_document, t.currency, coalesce(v_expected, 0), p_amount, p_paid_on, m.id, m.name, btrim(p_reference), v_key,
            p_proof_key, p_proof_mime, v_note, v_seq, v_number, p_amount - v_allocated, p_admin, btrim(p_admin_name), v_now, p_ip,
            p_replaces, p_proof_sha256, CASE WHEN v_has_similar OR v_same_proof THEN v_similar END);
  PERFORM billing_write_allocations(p_tenant, v_docs, v_amounts, 'PAYMENT', v_id, NULL, NULL, v_now);
  IF p_amount > v_allocated THEN
    INSERT INTO billing_credit_entries (id, tenant_id, currency, kind, amount, "paymentId", data, "createdByKind", "createdById", "createdByName", "createdAt")
      VALUES (gen_random_uuid(), p_tenant, t.currency, 'PAYMENT_SURPLUS', p_amount - v_allocated, v_id, jsonb_build_object('receiptNumber', v_number),
              'platform', p_admin, btrim(p_admin_name), v_now);
  END IF;
  RETURN QUERY SELECT v_id, v_number, coalesce(v_expected, 0), v_allocated, p_amount - v_allocated;
END $$;

-- Droits du rôle de la plateforme du lot G5d-2 (infra/postgres/role-plateforme.sh les redonne à chaque installation) :
-- même fonction, avec la nouvelle signature de record_billing_payment (l'ancienne n'existe plus).
CREATE OR REPLACE FUNCTION grant_platform_payments_role() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_platform') THEN
    RAISE NOTICE 'Rôle erp_platform absent : droits non attribués (poste de développement)';
    RETURN;
  END IF;
  GRANT SELECT ON billing_payment_means, billing_payments, billing_allocations, billing_credit_entries, billing_credit_transfers, billing_refunds TO erp_platform;
  GRANT EXECUTE ON FUNCTION billing_payable_documents(uuid), billing_credit_balance(uuid), billing_credit_reserved(uuid), billing_grace_document(uuid),
    billing_plan_allocations(uuid, integer, uuid), add_billing_payment_means(text, boolean, text, text, text, boolean, date, text, uuid, text, date),
    record_billing_payment(uuid, uuid, integer, date, text, text, text, text, text, uuid, text, text, date, uuid, text, text), cancel_billing_payment(uuid, text, uuid, text, text),
    apply_billing_credit(uuid, text, uuid, text), impute_billing_credit_note(uuid),
    decide_billing_refund(uuid, text, text, date, text, text, text, text, uuid, text, text, date),
    transfer_billing_credit(uuid, uuid, integer, text, text, text, text, uuid, text, text) TO erp_platform;
END $$;

-- ---------------------------------------------------------------- Droits

REVOKE ALL ON FUNCTION tenant_is_test(uuid), billing_exclusion_origin(uuid, uuid),
  record_billing_payment(uuid, uuid, integer, date, text, text, text, text, text, uuid, text, text, date, uuid, text, text) FROM PUBLIC;

-- Rôle de la plateforme : lecture des liens des exclusions, statut commercial (colonne de tenants, déjà lisible et
-- modifiable par ce rôle), document d'origine, nouvel enregistrement des paiements. infra/postgres/role-plateforme.sh
-- appelle cette fonction avec les autres à chaque installation.
CREATE OR REPLACE FUNCTION grant_platform_ajustements_role() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_platform') THEN
    RAISE NOTICE 'Rôle erp_platform absent : droits non attribués (poste de développement)';
    RETURN;
  END IF;
  GRANT SELECT ON billing_exclusion_links TO erp_platform;
  GRANT EXECUTE ON FUNCTION tenant_is_test(uuid), billing_exclusion_origin(uuid, uuid),
    record_billing_payment(uuid, uuid, integer, date, text, text, text, text, text, uuid, text, text, date, uuid, text, text) TO erp_platform;
END $$;

SELECT grant_platform_ajustements_role();
