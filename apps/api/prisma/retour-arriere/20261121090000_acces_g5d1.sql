-- Retour arrière de la migration 20261121090000_acces_g5d1 (API arrêtée, avant de remettre le code précédent).
-- Retire la table des demandes de régularisation, les colonnes d'accès des abonnements (délai de grâce, prolongation,
-- accès limité, préavis après une réponse), les fonctions, le type, les contrôles et les droits ajoutés par le lot
-- G5d-1, remet l'acceptation des conditions commerciales du lot G5a telle qu'elle était et retire les trois paramètres
-- inscrits par la migration (délai de grâce, préavis, durée maximale d'une prolongation). Ne touche à aucune autre
-- donnée, ni à la facturation des lots G5a, G5b, G5c et G5g. Si plusieurs lots doivent être retirés, passer celui-ci
-- d'abord, puis ceux de G5c, de G5b, de G5g et de G5a.
-- Les lignes déjà inscrites dans les journaux de la plateforme, des groupes et des écoles et dans l'historique des
-- abonnements restent : ils sont en ajout seul. Une fois le script passé, la migration peut être rejouée par une
-- nouvelle mise à jour.
-- Contrôle de sécurité : s'il existe une demande de régularisation, un abonnement avec un délai de grâce, une
-- prolongation, un préavis ou un accès limité, ou une valeur de ces trois paramètres saisie par le Super Admin, le
-- script les compte et S'ARRÊTE sans rien changer. Pour passer outre en connaissance de cause seulement (ces données seront perdues : gardez d'abord une
-- sauvegarde hors du serveur) : PGOPTIONS="-c cahiora.forcer_retour=oui". Un accès limité est alors levé : l'abonnement
-- revient en attente d'acceptation ou de paiement, inscrit dans son historique.
-- Lancement :
--   docker compose exec -T postgres psql -U postgres erp -v ON_ERROR_STOP=1 < apps/api/prisma/retour-arriere/20261121090000_acces_g5d1.sql
BEGIN;

DO $$
DECLARE
  n_requests int;
  n_access int;
  n_limited int;
  n_params int;
BEGIN
  SELECT count(*) INTO n_requests FROM regularization_requests;
  SELECT count(*) INTO n_access FROM subscriptions
   WHERE "graceStart" IS NOT NULL OR "extendedUntil" IS NOT NULL OR "limitedSince" IS NOT NULL OR "noticeUntil" IS NOT NULL;
  SELECT count(*) INTO n_limited FROM subscriptions WHERE status = 'LIMITED';
  SELECT count(*) INTO n_params FROM billing_parameters
   WHERE key IN ('GRACE_DAYS', 'NOTICE_HOURS', 'EXTENSION_MAX_DAYS') AND "createdByName" <> 'Mise à jour de Cahiora (lot G5d-1)';
  IF n_requests + n_access + n_limited + n_params > 0 AND coalesce(current_setting('cahiora.forcer_retour', true), '') <> 'oui' THEN
    RAISE EXCEPTION 'Retour arrière arrêté, rien n''a été changé : % demande(s) de régularisation, % abonnement(s) avec un délai de grâce, une prolongation, un préavis ou un accès limité, % valeur(s) du délai de grâce, du préavis ou de la durée des prolongations saisie(s) par le Super Admin',
      n_requests, greatest(n_access, n_limited), n_params;
  END IF;
END $$;

-- Retour forcé seulement : un accès limité est levé, inscrit dans l'historique de l'abonnement (ajout seul).
INSERT INTO subscription_events (id, "subscriptionId", tenant_id, kind, "fromStatus", "toStatus", data, "actorKind", "actorId", "actorName", ip, "createdAt")
  SELECT gen_random_uuid(), s.id, s.tenant_id, 'ACCESS_RESTORED', 'LIMITED',
         CASE WHEN s."acceptedAt" IS NULL THEN 'AWAITING_ACCEPTANCE'::"SubscriptionStatus" ELSE 'AWAITING_PAYMENT'::"SubscriptionStatus" END,
         jsonb_build_object('source', 'retour arrière du lot G5d-1'), 'system', NULL, 'Cahiora (retour arrière du lot G5d-1)', NULL, timezone('UTC', now())
  FROM subscriptions s WHERE s.status = 'LIMITED';
UPDATE subscriptions
   SET status = CASE WHEN "acceptedAt" IS NULL THEN 'AWAITING_ACCEPTANCE'::"SubscriptionStatus" ELSE 'AWAITING_PAYMENT'::"SubscriptionStatus" END,
       "statusSince" = timezone('UTC', now()), "limitedSince" = NULL, "updatedAt" = timezone('UTC', now())
 WHERE status = 'LIMITED';

DROP FUNCTION IF EXISTS grant_platform_access_role();
DROP FUNCTION IF EXISTS request_regularization(uuid, text, text, text);
DROP FUNCTION IF EXISTS current_tenant_regularization_requests();
DROP FUNCTION IF EXISTS current_tenant_subscription_access();
DROP TRIGGER IF EXISTS billing_document_lines_terms_check ON billing_document_lines;
DROP FUNCTION IF EXISTS billing_document_lines_terms_check();
DROP TABLE IF EXISTS regularization_requests;
DROP FUNCTION IF EXISTS regularization_requests_guard();
DROP TRIGGER IF EXISTS subscriptions_access_guard ON subscriptions;
DROP FUNCTION IF EXISTS subscriptions_access_guard();
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_notice_check, DROP CONSTRAINT IF EXISTS subscriptions_limited_check,
  DROP CONSTRAINT IF EXISTS subscriptions_grace_check;
ALTER TABLE subscriptions DROP COLUMN IF EXISTS "graceStart", DROP COLUMN IF EXISTS "graceEnd", DROP COLUMN IF EXISTS "extendedUntil", DROP COLUMN IF EXISTS "limitedSince",
  DROP COLUMN IF EXISTS "noticeUntil", DROP COLUMN IF EXISTS "noticeGraceEnd";
DROP TYPE IF EXISTS "RegularizationRequestStatus";

-- Paramètres inscrits par la migration (table en ajout seul : son contrôle est suspendu le temps de ces lignes).
ALTER TABLE billing_parameters DISABLE TRIGGER billing_parameters_append_only;
DELETE FROM billing_parameters WHERE key IN ('GRACE_DAYS', 'NOTICE_HOURS', 'EXTENSION_MAX_DAYS') AND "createdByName" = 'Mise à jour de Cahiora (lot G5d-1)';
ALTER TABLE billing_parameters ENABLE TRIGGER billing_parameters_append_only;

-- Acceptation des conditions commerciales du lot G5a, telle qu'elle était (CREATE OR REPLACE garde ses droits).
CREATE OR REPLACE FUNCTION accept_commercial_terms(p_terms uuid, p_user uuid, p_user_name text, p_ip text, p_day date) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant uuid := app_current_tenant();
  v_now timestamp := timezone('UTC', now());
  s record;
  cur record;
  v_currency text;
  v_price integer;
  v_min integer;
  v_tariff jsonb;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'CAHIORA: école courante absente';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM user_roles r JOIN users u ON u.id = r."userId"
    WHERE r."userId" = p_user AND r.tenant_id = v_tenant AND r.role = 'DIRECTION' AND r."siteId" IS NULL AND u.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'CAHIORA: seule la direction de tout l''établissement accepte les conditions commerciales';
  END IF;
  SELECT * INTO s FROM subscriptions WHERE tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CAHIORA: aucun abonnement n''est ouvert pour cet établissement';
  END IF;
  IF s.status <> 'AWAITING_ACCEPTANCE' THEN
    RAISE EXCEPTION 'CAHIORA: l''abonnement n''attend pas d''acceptation des conditions';
  END IF;
  SELECT * INTO cur FROM current_commercial_terms(p_day);
  IF cur.id IS NULL THEN
    RAISE EXCEPTION 'CAHIORA: aucune condition commerciale n''est encore publiée';
  END IF;
  IF cur.id <> p_terms THEN
    RAISE EXCEPTION 'CAHIORA: ces conditions ont été remplacées par une nouvelle version : relisez-la avant d''accepter';
  END IF;
  SELECT currency INTO v_currency FROM tenants WHERE id = v_tenant;
  v_price := billing_parameter_value('PRICE_PER_PUPIL', v_currency, p_day);
  v_min := billing_parameter_value('MINIMUM_PER_ESTABLISHMENT', v_currency, p_day);
  IF v_price IS NULL OR v_min IS NULL THEN
    RAISE EXCEPTION 'CAHIORA: le tarif de la monnaie % n''est pas encore fixé par Cahiora', v_currency;
  END IF;
  v_tariff := jsonb_build_object('currency', v_currency, 'pricePerPupil', v_price, 'minimum', v_min, 'day', p_day);
  UPDATE subscriptions
     SET status = 'AWAITING_PAYMENT', "statusSince" = v_now, "acceptedTermsId" = cur.id, "acceptedAt" = v_now,
         "acceptedByName" = p_user_name, "acceptedTariff" = v_tariff, "updatedAt" = v_now
   WHERE id = s.id;
  INSERT INTO subscription_events (id, "subscriptionId", tenant_id, kind, "fromStatus", "toStatus", data, "actorKind", "actorId", "actorName", ip, "createdAt")
    VALUES (gen_random_uuid(), s.id, v_tenant, 'TERMS_ACCEPTED', 'AWAITING_ACCEPTANCE', 'AWAITING_PAYMENT',
            jsonb_build_object('termsId', cur.id, 'termsVersion', cur.version, 'tariff', v_tariff), 'school', p_user, p_user_name, p_ip, v_now);
  INSERT INTO platform_audit_logs (id, action, "tenantId", data, ip, "createdAt")
    VALUES (gen_random_uuid(), 'billing.terms_accepted', v_tenant, jsonb_build_object('termsVersion', cur.version, 'by', p_user_name, 'tariff', v_tariff), p_ip, v_now);
  INSERT INTO group_audit_logs (id, group_id, "actorKind", "actorId", "actorName", action, data, "createdAt")
    SELECT gen_random_uuid(), t.group_id, 'school', p_user, p_user_name, 'billing.terms_accepted',
           jsonb_build_object('tenantName', t.name, 'termsVersion', cur.version), v_now
    FROM tenants t WHERE t.id = v_tenant;
  RETURN 'AWAITING_PAYMENT';
END $$;

DELETE FROM _prisma_migrations WHERE migration_name = '20261121090000_acces_g5d1';

COMMIT;
