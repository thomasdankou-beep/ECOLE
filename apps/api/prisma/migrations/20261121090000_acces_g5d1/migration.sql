-- Lot G5d-1 · accès selon le paiement de l'abonnement : délai de grâce après la fin de la gratuité, rappels, demandes
-- de régularisation de la direction, prolongations exceptionnelles du Super Admin et accès limité.
-- Décisions de Dankou du 19 novembre 2026 : D-G5-30 A (essai de 14 jours, 15 jours de grâce en accès complet, puis
-- accès limité sans rien supprimer), D-G5-41 A (renouvellement impayé : même règle), D-G5-42 A (une demande de
-- régularisation qui attend la réponse de Cahiora, sans moyen de paiement activé, empêche la limitation), D-G5-43 A
-- (paiement partiel : accès limité, sauf prolongation exceptionnelle avec une date de fin et un motif) ; chaque demande
-- est horodatée et journalisée. Aucun paiement ni encaissement : le paiement validé arrive avec le lot G5d-2 (D-G5-33).
-- Aucune donnée existante n'est modifiée : les nouvelles colonnes des abonnements restent vides (un abonnement dont la
-- gratuité a fini avant ce lot n'a pas de délai de grâce et n'est jamais limité automatiquement). Un seul paramètre
-- est ajouté : le délai de grâce de 15 jours (D-G5-30 A).
-- Tout s'applique en une seule transaction : en cas d'erreur, rien n'est changé.

-- CreateEnum
CREATE TYPE "RegularizationRequestStatus" AS ENUM ('PENDING', 'ANSWERED');

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN "graceStart" DATE,
ADD COLUMN "graceEnd" DATE,
ADD COLUMN "extendedUntil" DATE,
ADD COLUMN "limitedSince" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "regularization_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "status" "RegularizationRequestStatus" NOT NULL DEFAULT 'PENDING',
    "subscriptionStatus" "SubscriptionStatus" NOT NULL,
    "message" TEXT,
    "requestedById" UUID,
    "requestedByName" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "answeredById" UUID,
    "answeredByName" TEXT,
    "answeredAt" TIMESTAMP(3),
    "answer" TEXT,

    CONSTRAINT "regularization_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "regularization_requests_tenant_id_requestedAt_idx" ON "regularization_requests"("tenant_id", "requestedAt");

-- AddForeignKey
ALTER TABLE "regularization_requests" ADD CONSTRAINT "regularization_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regularization_requests" ADD CONSTRAINT "regularization_requests_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Une seule demande en attente par établissement ; un message de 1 000 caractères au plus.
CREATE UNIQUE INDEX "regularization_requests_one_pending" ON "regularization_requests"("tenant_id") WHERE "status" = 'PENDING';
ALTER TABLE "regularization_requests" ADD CONSTRAINT "regularization_requests_message_length" CHECK ("message" IS NULL OR length("message") <= 1000);
ALTER TABLE "regularization_requests" ADD CONSTRAINT "regularization_requests_answer_check"
  CHECK (("status" = 'PENDING') = ("answeredAt" IS NULL) AND ("status" = 'PENDING' OR (coalesce(btrim("answer"), '') <> '' AND length("answer") <= 2000 AND "answeredByName" IS NOT NULL)));

-- Délai de grâce : ses deux bornes ensemble, la fin après le début ; l'accès limité porte toujours sa date.
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_grace_check"
  CHECK (("graceStart" IS NULL) = ("graceEnd" IS NULL) AND ("graceEnd" IS NULL OR "graceEnd" >= "graceStart"));
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_limited_check" CHECK (("status" = 'LIMITED') = ("limitedSince" IS NOT NULL));

-- Contrôle « même école » (SEC-001) : une demande pointe toujours vers l'abonnement de son établissement.
SELECT install_same_tenant_checks();

-- Le délai de grâce se fixe une seule fois, au passage en attente (fin d'un essai ou d'un pilote ; plus tard, échéance
-- d'un renouvellement) ; ensuite, seul Cahiora accorde plus de temps, par une prolongation inscrite dans l'historique.
CREATE OR REPLACE FUNCTION subscriptions_access_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."graceStart", NEW."graceEnd") IS DISTINCT FROM (OLD."graceStart", OLD."graceEnd")
     AND NOT (OLD.status IN ('TRIAL', 'PILOT', 'ACTIVE') AND NEW.status IN ('AWAITING_ACCEPTANCE', 'AWAITING_PAYMENT')) THEN
    RAISE EXCEPTION 'Le délai de grâce se fixe à la fin de la gratuité et ne change plus : Cahiora accorde ensuite une prolongation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER subscriptions_access_guard BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION subscriptions_access_guard();

-- Une demande de régularisation ne s'efface jamais ; seule sa réponse s'inscrit, une seule fois, datée et signée.
CREATE TRIGGER regularization_requests_no_delete BEFORE DELETE ON regularization_requests FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER regularization_requests_no_truncate BEFORE TRUNCATE ON regularization_requests FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE OR REPLACE FUNCTION regularization_requests_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'La réponse à une demande de régularisation ne change plus';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW."subscriptionId", NEW."subscriptionStatus", NEW.message, NEW."requestedById", NEW."requestedByName", NEW."requestedAt", NEW.ip)
     IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD."subscriptionId", OLD."subscriptionStatus", OLD.message, OLD."requestedById", OLD."requestedByName", OLD."requestedAt", OLD.ip) THEN
    RAISE EXCEPTION 'Une demande de régularisation ne se modifie pas : seule sa réponse s''inscrit';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER regularization_requests_guard BEFORE UPDATE ON regularization_requests FOR EACH ROW EXECUTE FUNCTION regularization_requests_guard();

-- Row Level Security : zone de la plateforme, comme les abonnements (propriétaire et rôle erp_platform). Les écoles
-- passent par leurs fonctions ci-dessous ; le rôle des groupes et celui des statistiques n'ont aucun droit.
ALTER TABLE regularization_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE regularization_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY regularization_requests_owner_all ON regularization_requests TO erp_owner USING (true) WITH CHECK (true);
CREATE POLICY regularization_requests_platform_all ON regularization_requests TO PUBLIC USING (current_user = 'erp_platform') WITH CHECK (current_user = 'erp_platform');
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    REVOKE ALL ON regularization_requests FROM erp_app;
  END IF;
END $$;

-- Accès de l'abonnement de l'école courante (app.tenant_id) : délai de grâce, prolongation, accès limité. Jamais le
-- motif d'une prolongation, ni l'abonnement d'une autre école.
CREATE OR REPLACE FUNCTION current_tenant_subscription_access() RETURNS TABLE (
  status text, grace_start date, grace_end date, extended_until date, limited_since timestamp, terms_accepted boolean, pending_request boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.status::text, s."graceStart", s."graceEnd", s."extendedUntil", s."limitedSince", s."acceptedAt" IS NOT NULL,
         EXISTS (SELECT 1 FROM regularization_requests r WHERE r.tenant_id = s.tenant_id AND r.status = 'PENDING')
  FROM subscriptions s
  WHERE s.tenant_id = app_current_tenant()
$$;

-- Demandes de régularisation de l'école courante et réponses de Cahiora (signées « Cahiora », sans le nom du Super Admin).
CREATE OR REPLACE FUNCTION current_tenant_regularization_requests() RETURNS TABLE (
  id uuid, status text, message text, requested_by_name text, requested_at timestamp, answered_at timestamp, answer text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.id, r.status::text, r.message, r."requestedByName", r."requestedAt", r."answeredAt", r.answer
  FROM regularization_requests r
  WHERE r.tenant_id = app_current_tenant()
  ORDER BY r."requestedAt" DESC
  LIMIT 50
$$;

-- Demande de régularisation de la direction de tout l'établissement (D-G5-42 A) : abonnement en attente ou en accès
-- limité, une seule demande en attente à la fois. Elle est horodatée et inscrite, dans la même transaction, dans
-- l'historique de l'abonnement, dans les journaux de la plateforme et du groupe, avec une alerte pour le Super Admin.
-- L'API refait les mêmes contrôles et trace le journal de l'école.
CREATE OR REPLACE FUNCTION request_regularization(p_user uuid, p_user_name text, p_message text, p_ip text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant uuid := app_current_tenant();
  v_now timestamp := timezone('UTC', now());
  v_id uuid := gen_random_uuid();
  v_message text := nullif(btrim(coalesce(p_message, '')), '');
  s record;
  t record;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'CAHIORA: école courante absente';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM user_roles r JOIN users u ON u.id = r."userId"
    WHERE r."userId" = p_user AND r.tenant_id = v_tenant AND r.role = 'DIRECTION' AND r."siteId" IS NULL AND u.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'CAHIORA: seule la direction de tout l''établissement demande une régularisation';
  END IF;
  IF length(v_message) > 1000 THEN
    RAISE EXCEPTION 'CAHIORA: message : 1 000 caractères au plus';
  END IF;
  SELECT * INTO s FROM subscriptions WHERE tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CAHIORA: aucun abonnement n''est encore ouvert pour votre établissement';
  END IF;
  IF s.status NOT IN ('AWAITING_ACCEPTANCE', 'AWAITING_PAYMENT', 'LIMITED') THEN
    RAISE EXCEPTION 'CAHIORA: votre abonnement n''attend pas de régularisation';
  END IF;
  IF EXISTS (SELECT 1 FROM regularization_requests WHERE tenant_id = v_tenant AND status = 'PENDING') THEN
    RAISE EXCEPTION 'CAHIORA: une demande de régularisation attend déjà la réponse de Cahiora';
  END IF;
  SELECT id, name, group_id INTO t FROM tenants WHERE id = v_tenant;
  INSERT INTO regularization_requests (id, tenant_id, "subscriptionId", status, "subscriptionStatus", message, "requestedById", "requestedByName", "requestedAt", ip)
    VALUES (v_id, v_tenant, s.id, 'PENDING', s.status, v_message, p_user, p_user_name, v_now, p_ip);
  INSERT INTO subscription_events (id, "subscriptionId", tenant_id, kind, "fromStatus", "toStatus", data, "actorKind", "actorId", "actorName", ip, "createdAt")
    VALUES (gen_random_uuid(), s.id, v_tenant, 'REGULARIZATION_REQUESTED', s.status, s.status,
            jsonb_build_object('requestId', v_id, 'message', v_message), 'school', p_user, p_user_name, p_ip, v_now);
  INSERT INTO platform_alerts (id, tenant_id, kind, message, "dueDate", "createdAt")
    VALUES (gen_random_uuid(), v_tenant, 'REGULARIZATION_REQUEST',
            format('%s demande à régulariser son abonnement (demande de %s). Répondez dans Commercial et facturation › Accès des clients.', t.name, p_user_name),
            NULL, v_now);
  INSERT INTO platform_audit_logs (id, action, "tenantId", data, ip, "createdAt")
    VALUES (gen_random_uuid(), 'billing.regularization_requested', v_tenant, jsonb_build_object('requestId', v_id, 'by', p_user_name, 'status', s.status), p_ip, v_now);
  INSERT INTO group_audit_logs (id, group_id, "actorKind", "actorId", "actorName", action, data, "createdAt")
    VALUES (gen_random_uuid(), t.group_id, 'school', p_user, p_user_name, 'billing.regularization_requested',
            jsonb_build_object('tenantName', t.name, 'requestId', v_id), v_now);
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION current_tenant_subscription_access(), current_tenant_regularization_requests(), request_regularization(uuid, text, text, text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT EXECUTE ON FUNCTION current_tenant_subscription_access(), current_tenant_regularization_requests(), request_regularization(uuid, text, text, text) TO erp_app;
  END IF;
END $$;

-- Acceptation des conditions commerciales (lot G5a), reprise pour le lot G5d-1 : une direction dont l'accès a été
-- limité avant qu'elle accepte les conditions peut encore les accepter. L'accès reste limité (seul un paiement validé,
-- lot G5d-2, ou une prolongation de Cahiora le rend complet) ; le reste ne change pas : version en vigueur seulement,
-- direction active de tout l'établissement, tarif du jour figé, historique et journaux dans la même transaction.
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
  v_to "SubscriptionStatus";
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
  IF NOT (s.status = 'AWAITING_ACCEPTANCE' OR (s.status = 'LIMITED' AND s."acceptedAt" IS NULL)) THEN
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
  v_to := CASE WHEN s.status = 'LIMITED' THEN 'LIMITED' ELSE 'AWAITING_PAYMENT' END;
  UPDATE subscriptions
     SET status = v_to, "statusSince" = CASE WHEN v_to = s.status THEN s."statusSince" ELSE v_now END, "acceptedTermsId" = cur.id, "acceptedAt" = v_now,
         "acceptedByName" = p_user_name, "acceptedTariff" = v_tariff, "updatedAt" = v_now
   WHERE id = s.id;
  INSERT INTO subscription_events (id, "subscriptionId", tenant_id, kind, "fromStatus", "toStatus", data, "actorKind", "actorId", "actorName", ip, "createdAt")
    VALUES (gen_random_uuid(), s.id, v_tenant, 'TERMS_ACCEPTED', s.status, v_to,
            jsonb_build_object('termsId', cur.id, 'termsVersion', cur.version, 'tariff', v_tariff), 'school', p_user, p_user_name, p_ip, v_now);
  INSERT INTO platform_audit_logs (id, action, "tenantId", data, ip, "createdAt")
    VALUES (gen_random_uuid(), 'billing.terms_accepted', v_tenant, jsonb_build_object('termsVersion', cur.version, 'by', p_user_name, 'tariff', v_tariff), p_ip, v_now);
  INSERT INTO group_audit_logs (id, group_id, "actorKind", "actorId", "actorName", action, data, "createdAt")
    SELECT gen_random_uuid(), t.group_id, 'school', p_user, p_user_name, 'billing.terms_accepted',
           jsonb_build_object('tenantName', t.name, 'termsVersion', cur.version), v_now
    FROM tenants t WHERE t.id = v_tenant;
  RETURN v_to::text;
END $$;

-- Un document de l'abonnement (lot G5c) ne part que pour un établissement qui a accepté les conditions commerciales.
-- Jusqu'ici, l'état de l'abonnement suffisait (en attente de paiement, actif ou limité) ; depuis ce lot, un accès peut
-- être limité avant toute acceptation : la date d'acceptation est désormais contrôlée à chaque ligne tirée d'un comptage.
CREATE OR REPLACE FUNCTION billing_document_lines_terms_check() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."countId" IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.tenant_id = NEW.tenant_id AND s."acceptedAt" IS NOT NULL) THEN
      RAISE EXCEPTION 'CAHIORA: ligne % : les conditions commerciales ne sont pas acceptées', NEW.position;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_document_lines_terms_check BEFORE INSERT ON billing_document_lines FOR EACH ROW EXECUTE FUNCTION billing_document_lines_terms_check();

-- Délai de grâce de la décision D-G5-30 A, en version 1 ; le Super Admin peut en saisir une nouvelle valeur datée.
INSERT INTO billing_parameters (id, key, currency, value, "effectiveFrom", reason, "createdByName") VALUES
  (gen_random_uuid(), 'GRACE_DAYS', NULL, 15, DATE '2026-11-19', 'Décision D-G5-30 A de Dankou (19 novembre 2026) : 15 jours de grâce en accès complet après la fin de la gratuité', 'Mise à jour de Cahiora (lot G5d-1)');
INSERT INTO platform_audit_logs (id, action, "tenantId", data)
  VALUES (gen_random_uuid(), 'billing.parameters.initial', NULL, jsonb_build_object('source', 'migration acces_g5d1', 'count', 1, 'key', 'GRACE_DAYS'));

-- Rôle de la plateforme : lire les demandes et y répondre (la réponse seulement, une fois) ; les abonnements, leur
-- historique et les alertes gardent les droits du lot G5a. infra/postgres/role-plateforme.sh appelle cette fonction
-- avec les autres à chaque installation.
CREATE OR REPLACE FUNCTION grant_platform_access_role() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_platform') THEN
    RAISE NOTICE 'Rôle erp_platform absent : droits non attribués (poste de développement)';
    RETURN;
  END IF;
  GRANT SELECT ON regularization_requests TO erp_platform;
  GRANT UPDATE (status, "answeredById", "answeredByName", "answeredAt", answer) ON regularization_requests TO erp_platform;
END $$;

SELECT grant_platform_access_role();
