-- Retour arrière de la migration 20261120090000_documents_g5c (API arrêtée, avant de remettre le code précédent).
-- Retire les tables, les fonctions, le type et les droits ajoutés par le lot G5c, et remet les fonctions de demande et
-- de décision des corrections du lot G5b telles qu'elles étaient ; ne touche à aucune autre donnée, ni aux comptages et
-- aux demandes de correction du lot G5b (une décision prise par le Super Admin reste), ni à la facturation des lots G5a
-- et G5g. Si plusieurs lots doivent être retirés, passer
-- celui-ci d'abord, puis ceux de G5b, de G5g et de G5a.
-- Les lignes déjà inscrites dans les journaux de la plateforme, des groupes et des écoles restent : ils sont en ajout
-- seul. Une fois le script passé, la migration peut être rejouée par une nouvelle mise à jour.
-- Contrôle de sécurité : s'il existe un document (proforma, avoir, devis), le script les compte et S'ARRÊTE sans rien
-- changer. Pour passer outre en connaissance de cause seulement (ces documents seront perdus : gardez d'abord une
-- sauvegarde hors du serveur) : PGOPTIONS="-c cahiora.forcer_retour=oui".
-- Lancement :
--   docker compose exec -T postgres psql -U postgres erp -v ON_ERROR_STOP=1 < apps/api/prisma/retour-arriere/20261120090000_documents_g5c.sql
BEGIN;

DO $$
DECLARE
  n_documents int;
BEGIN
  -- Une ligne pointe toujours vers son document (clé étrangère) : compter les documents suffit, et la table se lit en
  -- entier (zone de la plateforme, sans filtre par école).
  SELECT count(*) INTO n_documents FROM billing_documents;
  IF n_documents > 0 AND coalesce(current_setting('cahiora.forcer_retour', true), '') <> 'oui' THEN
    RAISE EXCEPTION 'Retour arrière arrêté, rien n''a été changé : % document(s) provisoire(s) déjà émis', n_documents;
  END IF;
END $$;

DROP FUNCTION IF EXISTS grant_platform_documents_role();
DROP FUNCTION IF EXISTS platform_count_exclusions();
DROP FUNCTION IF EXISTS decide_count_exclusion_platform(uuid, uuid, text, text, uuid, text, text);
DROP FUNCTION IF EXISTS current_tenant_count_documents();
DROP FUNCTION IF EXISTS issue_billing_document(uuid, text, text, date, date, text, uuid, jsonb, jsonb, text, uuid, text);
DROP FUNCTION IF EXISTS current_tenant_billing_documents();
DROP FUNCTION IF EXISTS current_tenant_sees_billing_documents();
DROP TABLE IF EXISTS billing_document_lines, billing_documents;
DROP FUNCTION IF EXISTS billing_already_billed(uuid, text);
DROP FUNCTION IF EXISTS billing_year_amount(integer, integer, integer, integer, integer);
DROP FUNCTION IF EXISTS billing_count_billable(uuid);
DROP FUNCTION IF EXISTS billing_counts_billable(uuid);

-- Fonctions du lot G5b, telles qu'elles étaient (CREATE OR REPLACE garde leurs droits) : la demande se fait de nouveau
-- pendant la vérification seulement, et la direction décide chaque exclusion.
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

DROP FUNCTION IF EXISTS billing_enrollment_document(uuid, uuid, text);
DROP TYPE IF EXISTS "BillingDocumentKind";
DELETE FROM _prisma_migrations WHERE migration_name = '20261120090000_documents_g5c';

COMMIT;
