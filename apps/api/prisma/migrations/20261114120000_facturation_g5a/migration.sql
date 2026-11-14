-- Lot G5a · facturation de Cahiora : paramètres tarifaires datés, calendriers des établissements, abonnements
-- (essai, pilote, acceptation des conditions commerciales), historique, conditions, tâches planifiées et alertes.
-- Cahier des charges du lot G5 du 14 novembre 2026 ; plan « audit de l'existant et plan d'exécution ».
-- Aucune donnée existante n'est modifiée et aucun abonnement n'est créé pour les écoles existantes : le Super Admin
-- ouvre lui-même chaque abonnement (essai ou pilote). Seules les valeurs initiales des paramètres sont inscrites.
-- Tout s'applique en une seule transaction : en cas d'erreur, rien n'est changé.

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIAL', 'PILOT', 'AWAITING_ACCEPTANCE', 'AWAITING_PAYMENT', 'ACTIVE', 'LIMITED');

-- CreateTable
CREATE TABLE "billing_parameters" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "currency" TEXT,
    "value" INTEGER NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" UUID,
    "createdByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_parameters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_calendars" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "yearLabel" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "preparationFrom" DATE,
    "initialCountDate" DATE NOT NULL,
    "firstRegularizationDate" DATE NOT NULL,
    "finalRegularizationDate" DATE NOT NULL,
    "renewalDate" DATE,
    "formula" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" UUID,
    "createdByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_calendars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "statusSince" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trialStart" DATE,
    "trialEnd" DATE,
    "trialDays" INTEGER,
    "pilotStart" DATE,
    "pilotEnd" DATE,
    "pilotMonths" INTEGER,
    "acceptedTermsId" UUID,
    "acceptedAt" TIMESTAMP(3),
    "acceptedByName" TEXT,
    "acceptedTariff" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_events" (
    "id" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "fromStatus" "SubscriptionStatus",
    "toStatus" "SubscriptionStatus",
    "data" JSONB,
    "reason" TEXT,
    "actorKind" TEXT NOT NULL,
    "actorId" UUID,
    "actorName" TEXT NOT NULL,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commercial_terms" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "createdById" UUID,
    "createdByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commercial_terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_jobs" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tenant_id" UUID,
    "dueDate" DATE NOT NULL,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_alerts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "dueDate" DATE,
    "readAt" TIMESTAMP(3),
    "readById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "billing_parameters_key_currency_effectiveFrom_idx" ON "billing_parameters"("key", "currency", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "billing_calendars_tenant_id_yearLabel_version_key" ON "billing_calendars"("tenant_id", "yearLabel", "version");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_tenant_id_key" ON "subscriptions"("tenant_id");

-- CreateIndex
CREATE INDEX "subscription_events_tenant_id_createdAt_idx" ON "subscription_events"("tenant_id", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "commercial_terms_version_key" ON "commercial_terms"("version");

-- CreateIndex
CREATE UNIQUE INDEX "billing_jobs_key_key" ON "billing_jobs"("key");

-- CreateIndex
CREATE INDEX "platform_alerts_createdAt_idx" ON "platform_alerts"("createdAt");

-- AddForeignKey
ALTER TABLE "billing_calendars" ADD CONSTRAINT "billing_calendars_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Contrôle « même école » (SEC-001) : une ligne d'historique pointe toujours vers l'abonnement de son établissement.
SELECT install_same_tenant_checks();


-- Tables en ajout seul : un paramètre, une version de calendrier, une ligne d'historique, une version des
-- conditions ou une tâche exécutée ne se modifient ni ne s'effacent, même par le propriétaire de la base.
CREATE TRIGGER billing_parameters_append_only BEFORE UPDATE OR DELETE ON billing_parameters FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER billing_calendars_append_only BEFORE UPDATE OR DELETE ON billing_calendars FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER subscription_events_append_only BEFORE UPDATE OR DELETE ON subscription_events FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER commercial_terms_append_only BEFORE UPDATE OR DELETE ON commercial_terms FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER billing_jobs_append_only BEFORE UPDATE OR DELETE ON billing_jobs FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Un abonnement et une alerte ne s'effacent jamais. L'établissement d'un abonnement ne change pas ; d'une alerte,
-- seule sa lecture est notée.
CREATE TRIGGER subscriptions_no_delete BEFORE DELETE ON subscriptions FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER platform_alerts_no_delete BEFORE DELETE ON platform_alerts FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE OR REPLACE FUNCTION subscriptions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'L''établissement d''un abonnement ne change pas';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER subscriptions_guard BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION subscriptions_guard();
CREATE OR REPLACE FUNCTION platform_alerts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.kind, NEW.message, NEW."dueDate", NEW."createdAt")
     IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.kind, OLD.message, OLD."dueDate", OLD."createdAt") THEN
    RAISE EXCEPTION 'Une alerte ne se modifie pas : seule sa lecture est notée';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER platform_alerts_guard BEFORE UPDATE ON platform_alerts FOR EACH ROW EXECUTE FUNCTION platform_alerts_guard();
-- Vider une de ces tables d'un coup (TRUNCATE) est refusé aussi.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing_parameters', 'billing_calendars', 'subscriptions', 'subscription_events', 'commercial_terms', 'billing_jobs', 'platform_alerts'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION forbid_change()', t || '_no_truncate', t);
  END LOOP;
END $$;

-- Row Level Security : tables de la plateforme seulement (propriétaire et rôle erp_platform). Les rôles erp_platform
-- et erp_group peuvent ne pas exister (poste de développement) : les politiques testent current_user.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing_parameters', 'billing_calendars', 'subscriptions', 'subscription_events', 'commercial_terms', 'billing_jobs', 'platform_alerts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I TO erp_owner USING (true) WITH CHECK (true)', t || '_owner_all', t);
    EXECUTE format('CREATE POLICY %I ON %I TO PUBLIC USING (current_user = ''erp_platform'') WITH CHECK (current_user = ''erp_platform'')', t || '_platform_all', t);
  END LOOP;
END $$;

-- Les écoles (erp_app) n'ont aucun droit sur ces tables : les droits par défaut donnés à erp_app sur toute nouvelle
-- table sont retirés. Le rôle des groupes et celui des statistiques n'en reçoivent aucun.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    REVOKE ALL ON billing_parameters, billing_calendars, subscriptions, subscription_events, commercial_terms, billing_jobs, platform_alerts FROM erp_app;
  END IF;
END $$;

-- Valeur d'un paramètre en vigueur un jour donné : la version de date d'effet la plus récente jusqu'à ce jour, puis
-- la dernière inscrite. Le tarif est public pour les écoles : la direction le lit, sans droit sur la table.
CREATE OR REPLACE FUNCTION billing_parameter_value(p_key text, p_currency text, p_day date) RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT value FROM billing_parameters
  WHERE key = p_key AND currency IS NOT DISTINCT FROM p_currency AND "effectiveFrom" <= p_day
  ORDER BY "effectiveFrom" DESC, "createdAt" DESC, id DESC
  LIMIT 1
$$;

-- Conditions commerciales en vigueur un jour donné (même règle que les paramètres).
CREATE OR REPLACE FUNCTION current_commercial_terms(p_day date) RETURNS TABLE (id uuid, version integer, title text, body text, effective_from date)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.version, c.title, c.body, c."effectiveFrom" FROM commercial_terms c
  WHERE c."effectiveFrom" <= p_day
  ORDER BY c."effectiveFrom" DESC, c.version DESC
  LIMIT 1
$$;

-- Abonnement de l'école courante (app.tenant_id) seulement : jamais celui d'une autre école, ni le motif du Super Admin.
CREATE OR REPLACE FUNCTION current_tenant_subscription() RETURNS TABLE (
  status text, status_since timestamp, trial_start date, trial_end date, trial_days integer, pilot_start date, pilot_end date, pilot_months integer,
  accepted_at timestamp, accepted_by_name text, accepted_terms_version integer, accepted_tariff jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.status::text, s."statusSince", s."trialStart", s."trialEnd", s."trialDays", s."pilotStart", s."pilotEnd", s."pilotMonths",
         s."acceptedAt", s."acceptedByName", c.version, s."acceptedTariff"
  FROM subscriptions s LEFT JOIN commercial_terms c ON c.id = s."acceptedTermsId"
  WHERE s.tenant_id = app_current_tenant()
$$;

-- Historique de l'abonnement de l'école courante : le Super Admin y figure sous le nom « Cahiora », sans motif ni adresse IP.
CREATE OR REPLACE FUNCTION current_tenant_subscription_events() RETURNS TABLE (
  kind text, from_status text, to_status text, data jsonb, actor_kind text, actor_name text, created_at timestamp)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.kind, e."fromStatus"::text, e."toStatus"::text, e.data, e."actorKind",
         CASE WHEN e."actorKind" = 'school' THEN e."actorName" ELSE 'Cahiora' END, e."createdAt"
  FROM subscription_events e
  WHERE e.tenant_id = app_current_tenant()
  ORDER BY e."createdAt" DESC
  LIMIT 100
$$;

-- Calendriers de facturation de l'école courante : la dernière version de chaque année scolaire.
CREATE OR REPLACE FUNCTION current_tenant_billing_calendars() RETURNS TABLE (
  year_label text, version integer, start_date date, end_date date, preparation_from date, initial_count_date date,
  first_regularization_date date, final_regularization_date date, renewal_date date, formula text, created_at timestamp)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT ON (c."yearLabel") c."yearLabel", c.version, c."startDate", c."endDate", c."preparationFrom", c."initialCountDate",
         c."firstRegularizationDate", c."finalRegularizationDate", c."renewalDate", c.formula, c."createdAt"
  FROM billing_calendars c
  WHERE c.tenant_id = app_current_tenant()
  ORDER BY c."yearLabel" DESC, c.version DESC
$$;

-- Acceptation des conditions commerciales par la direction de l'école courante (§4) : seulement quand l'abonnement
-- l'attend, seulement la version en vigueur, par un compte Direction actif de tout l'établissement. Le tarif du jour est
-- figé dans l'abonnement ; l'acceptation est inscrite dans l'historique (ajout seul) et dans les journaux de la
-- plateforme et du groupe, dans la même transaction. L'API vérifie les mêmes points et trace le journal de l'école.
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

REVOKE ALL ON FUNCTION billing_parameter_value(text, text, date), current_commercial_terms(date), current_tenant_subscription(),
  current_tenant_subscription_events(), current_tenant_billing_calendars(), accept_commercial_terms(uuid, uuid, text, text, date) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT EXECUTE ON FUNCTION billing_parameter_value(text, text, date), current_commercial_terms(date), current_tenant_subscription(),
      current_tenant_subscription_events(), current_tenant_billing_calendars(), accept_commercial_terms(uuid, uuid, text, text, date) TO erp_app;
  END IF;
END $$;

-- Valeurs initiales des paramètres (§15 du cahier des charges), en version 1. Les prestations (lot G5g) et le prix
-- des SMS (lot G5e, INFORMATION MANQUANTE) ont leurs propres tables. Les montants valent pour le franc CFA d'Afrique
-- de l'Ouest (XOF) : une autre monnaie attend un tarif saisi par le Super Admin.
INSERT INTO billing_parameters (id, key, currency, value, "effectiveFrom", reason, "createdByName") VALUES
  (gen_random_uuid(), 'PRICE_PER_PUPIL', 'XOF', 500, DATE '2026-11-14', 'Valeur initiale du cahier des charges du lot G5 (14 novembre 2026) : 500 FCFA par élève et par année scolaire', 'Mise à jour de Cahiora (lot G5a)'),
  (gen_random_uuid(), 'MINIMUM_PER_ESTABLISHMENT', 'XOF', 40000, DATE '2026-11-14', 'Valeur initiale du cahier des charges du lot G5 (14 novembre 2026) : minimum de 40 000 FCFA par établissement et par année', 'Mise à jour de Cahiora (lot G5a)'),
  (gen_random_uuid(), 'TRIAL_DAYS', NULL, 14, DATE '2026-11-14', 'Valeur initiale du cahier des charges du lot G5 (14 novembre 2026) : essai gratuit de 14 jours', 'Mise à jour de Cahiora (lot G5a)'),
  (gen_random_uuid(), 'PILOT_FREE_MONTHS', NULL, 3, DATE '2026-11-14', 'Valeur initiale du cahier des charges du lot G5 (14 novembre 2026) : 3 mois gratuits pour une école pilote', 'Mise à jour de Cahiora (lot G5a)'),
  (gen_random_uuid(), 'PILOT_ALERT_FIRST_DAYS', NULL, 30, DATE '2026-11-14', 'Valeur provisoire proposée (décision D-G5-38 en attente) : première alerte 30 jours avant la fin du pilote', 'Mise à jour de Cahiora (lot G5a)'),
  (gen_random_uuid(), 'PILOT_ALERT_LAST_DAYS', NULL, 7, DATE '2026-11-14', 'Valeur provisoire proposée (décision D-G5-38 en attente) : dernière alerte 7 jours avant la fin du pilote', 'Mise à jour de Cahiora (lot G5a)'),
  (gen_random_uuid(), 'COUNT_REVIEW_DAYS', NULL, 15, DATE '2026-11-14', 'Valeur initiale du cahier des charges du lot G5 (14 novembre 2026) : 15 jours de vérification des effectifs par la direction', 'Mise à jour de Cahiora (lot G5a)'),
  (gen_random_uuid(), 'REFERRAL_REWARD', 'XOF', 5000, DATE '2026-11-14', 'Valeur initiale du cahier des charges du lot G5 (14 novembre 2026) : 5 000 FCFA de crédit par école filleule', 'Mise à jour de Cahiora (lot G5a)'),
  (gen_random_uuid(), 'COMMISSION_APPORTEUR', NULL, 1500, DATE '2026-11-14', 'Valeur initiale du cahier des charges du lot G5 (14 novembre 2026) : 15 % pour un apporteur d''affaires', 'Mise à jour de Cahiora (lot G5a)'),
  (gen_random_uuid(), 'COMMISSION_PREMIUM', NULL, 2000, DATE '2026-11-14', 'Valeur initiale du cahier des charges du lot G5 (14 novembre 2026) : 20 % pour un partenaire premium', 'Mise à jour de Cahiora (lot G5a)');
INSERT INTO platform_audit_logs (id, action, "tenantId", data)
  VALUES (gen_random_uuid(), 'billing.parameters.initial', NULL, jsonb_build_object('source', 'migration facturation_g5a', 'count', 10));

-- Rôle de la plateforme : droits de la facturation dans une fonction à part. grant_platform_role() (lots précédents et
-- lot G2) reste inchangée : les deux lots s'intègrent sans que l'un efface les droits de l'autre. infra/postgres/
-- role-plateforme.sh appelle les deux à chaque installation.
CREATE OR REPLACE FUNCTION grant_platform_billing_role() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_platform') THEN
    RAISE NOTICE 'Rôle erp_platform absent : droits non attribués (poste de développement)';
    RETURN;
  END IF;
  -- Paramètres, calendriers, conditions, historique et tâches en ajout seul ; abonnements et alertes modifiables mais
  -- jamais supprimés ; dates des années scolaires des écoles, pour proposer leur calendrier (aucune autre donnée).
  GRANT SELECT, INSERT ON billing_parameters, billing_calendars, commercial_terms, subscription_events, billing_jobs TO erp_platform;
  GRANT SELECT, INSERT, UPDATE ON subscriptions, platform_alerts TO erp_platform;
  GRANT SELECT (id, tenant_id, label, "startDate", "endDate", "isCurrent") ON academic_years TO erp_platform;
END $$;

SELECT grant_platform_billing_role();
