-- Lot G5g · prestations complémentaires de Cahiora : catalogue en versions datées, prix du catalogue datés, remises,
-- tarifs particuliers et gratuités, pour un établissement ou pour tous, chacun avec un motif et un historique.
-- Cahier des charges du lot G5 du 14 novembre 2026, sections 7 et 15. Aucune prestation n'est rattachée d'office à un
-- établissement : une prestation n'entrera dans un devis ou une facture que si quelqu'un l'y ajoute (lot G5c).
-- Aucune donnée existante n'est modifiée. Seul le catalogue initial de la section 7 est inscrit.
-- Tout s'applique en une seule transaction : en cas d'erreur, rien n'est changé.

-- CreateEnum
CREATE TYPE "ServicePricing" AS ENUM ('FIXED', 'FREE', 'QUOTE');

-- CreateEnum
CREATE TYPE "ServiceRateKind" AS ENUM ('PRICE', 'SPECIAL_PRICE', 'DISCOUNT_PERCENT', 'DISCOUNT_AMOUNT', 'FREE');

-- CreateTable
CREATE TABLE "services" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "createdById" UUID,
    "createdByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_versions" (
    "id" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "pricing" "ServicePricing" NOT NULL,
    "active" BOOLEAN NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" UUID,
    "createdByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_rates" (
    "id" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "tenant_id" UUID,
    "kind" "ServiceRateKind" NOT NULL,
    "currency" TEXT,
    "value" INTEGER,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "reason" TEXT NOT NULL,
    "createdById" UUID,
    "createdByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_rate_ends" (
    "id" UUID NOT NULL,
    "rateId" UUID NOT NULL,
    "lastDay" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" UUID,
    "createdByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_rate_ends_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "services_code_key" ON "services"("code");

-- CreateIndex
CREATE UNIQUE INDEX "service_versions_serviceId_version_key" ON "service_versions"("serviceId", "version");

-- CreateIndex
CREATE INDEX "service_rates_serviceId_effectiveFrom_idx" ON "service_rates"("serviceId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "service_rates_tenant_id_idx" ON "service_rates"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "service_rate_ends_rateId_key" ON "service_rate_ends"("rateId");

-- AddForeignKey
ALTER TABLE "service_versions" ADD CONSTRAINT "service_versions_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_rates" ADD CONSTRAINT "service_rates_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_rates" ADD CONSTRAINT "service_rates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_rate_ends" ADD CONSTRAINT "service_rate_ends_rateId_fkey" FOREIGN KEY ("rateId") REFERENCES "service_rates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Contrôles de la base, en plus de ceux de l'API : une valeur incohérente est refusée même saisie à la main.
ALTER TABLE services ADD CONSTRAINT services_code_check CHECK (code ~ '^[A-Z0-9_]{1,60}$');
ALTER TABLE service_versions ADD CONSTRAINT service_versions_text_check
  CHECK (version >= 1 AND char_length(btrim(name)) BETWEEN 3 AND 120 AND (description IS NULL OR char_length(description) <= 2000));
-- Un prix ou un tarif particulier est un montant de 0 ou plus ; une remise en montant, au moins 1 ; une remise en
-- pourcentage, de 0,01 % à 100 % (en centièmes), sans monnaie ; une gratuité n'a ni montant ni monnaie.
ALTER TABLE service_rates ADD CONSTRAINT service_rates_value_check CHECK (
  (kind IN ('PRICE', 'SPECIAL_PRICE') AND currency IS NOT NULL AND value BETWEEN 0 AND 100000000)
  OR (kind = 'DISCOUNT_AMOUNT' AND currency IS NOT NULL AND value BETWEEN 1 AND 100000000)
  OR (kind = 'DISCOUNT_PERCENT' AND currency IS NULL AND value BETWEEN 1 AND 10000)
  OR (kind = 'FREE' AND currency IS NULL AND value IS NULL));
-- Le prix du catalogue vaut pour tous les établissements et n'a pas de dernier jour (un nouveau prix le remplace) ;
-- un tarif particulier vise toujours un établissement.
ALTER TABLE service_rates ADD CONSTRAINT service_rates_scope_check CHECK (
  (kind <> 'PRICE' OR (tenant_id IS NULL AND "effectiveTo" IS NULL)) AND (kind <> 'SPECIAL_PRICE' OR tenant_id IS NOT NULL));
ALTER TABLE service_rates ADD CONSTRAINT service_rates_dates_check CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom");

-- Arrêt d'une règle : jamais d'un prix du catalogue ; au plus tôt la veille de sa date d'effet (annulation) ; une règle
-- se raccourcit seulement. L'arrêt est unique (index unique sur rateId) et définitif (ajout seul).
CREATE OR REPLACE FUNCTION service_rate_ends_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  r record;
BEGIN
  SELECT kind, "effectiveFrom", "effectiveTo" INTO r FROM service_rates WHERE id = NEW."rateId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Règle de prix introuvable';
  END IF;
  IF r.kind = 'PRICE' THEN
    RAISE EXCEPTION 'Un prix du catalogue ne s''arrête pas : un nouveau prix le remplace';
  END IF;
  IF NEW."lastDay" < r."effectiveFrom" - 1 THEN
    RAISE EXCEPTION 'Le dernier jour d''une règle est au plus tôt la veille de sa date d''effet';
  END IF;
  IF r."effectiveTo" IS NOT NULL AND NEW."lastDay" >= r."effectiveTo" THEN
    RAISE EXCEPTION 'Une règle se raccourcit seulement : pour la prolonger, il faut en créer une nouvelle';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER service_rate_ends_check BEFORE INSERT ON service_rate_ends FOR EACH ROW EXECUTE FUNCTION service_rate_ends_check();

-- Tables en ajout seul : une prestation, une version, une règle ou un arrêt ne se modifient ni ne s'effacent, même par
-- le propriétaire de la base. Vider une de ces tables d'un coup (TRUNCATE) est refusé aussi.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['services', 'service_versions', 'service_rates', 'service_rate_ends'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forbid_change()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION forbid_change()', t || '_no_truncate', t);
  END LOOP;
END $$;

-- Row Level Security : tables de la plateforme seulement (propriétaire et rôle erp_platform). Les rôles peuvent ne pas
-- exister (poste de développement) : les politiques testent current_user.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['services', 'service_versions', 'service_rates', 'service_rate_ends'] LOOP
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
    REVOKE ALL ON services, service_versions, service_rates, service_rate_ends FROM erp_app;
  END IF;
END $$;

-- Catalogue initial (section 7 du cahier des charges), daté du 14 novembre 2026. Les descriptions restent vides :
-- le contenu de chaque prestation n'est pas encore rédigé (INFORMATION MANQUANTE). Les prix valent pour le franc CFA
-- d'Afrique de l'Ouest (XOF) : une autre monnaie attend un prix saisi par le Super Admin.
DO $$
DECLARE
  v_by text := 'Mise à jour de Cahiora (lot G5g)';
  v_day date := DATE '2026-11-14';
  v_reason text := 'Catalogue initial du cahier des charges du lot G5 (14 novembre 2026, section 7)';
  s_conf uuid := gen_random_uuid();
  s_form uuid := gen_random_uuid();
  s_param uuid := gen_random_uuid();
  s_site uuid := gen_random_uuid();
BEGIN
  INSERT INTO services (id, code, "createdByName") VALUES
    (s_conf, 'CONFIGURATION_AUTONOME', v_by),
    (s_form, 'FORMATION_ET_PRISE_EN_MAIN', v_by),
    (s_param, 'PARAMETRAGE_COMPLET', v_by),
    (s_site, 'INTERVENTION_SUR_SITE', v_by);
  INSERT INTO service_versions (id, "serviceId", version, name, description, pricing, active, "effectiveFrom", reason, "createdByName") VALUES
    (gen_random_uuid(), s_conf, 1, 'Configuration autonome', NULL, 'FREE', true, v_day, v_reason || ' : gratuite', v_by),
    (gen_random_uuid(), s_form, 1, 'Formation et prise en main', NULL, 'FIXED', true, v_day, v_reason, v_by),
    (gen_random_uuid(), s_param, 1, 'Paramétrage complet', NULL, 'FIXED', true, v_day, v_reason, v_by),
    (gen_random_uuid(), s_site, 1, 'Intervention sur site', NULL, 'QUOTE', true, v_day, v_reason || ' : sur devis', v_by);
  INSERT INTO service_rates (id, "serviceId", tenant_id, kind, currency, value, "effectiveFrom", reason, "createdByName") VALUES
    (gen_random_uuid(), s_form, NULL, 'PRICE', 'XOF', 15000, v_day, v_reason || ' : 15 000 FCFA', v_by),
    (gen_random_uuid(), s_param, NULL, 'PRICE', 'XOF', 50000, v_day, v_reason || ' : 50 000 FCFA', v_by);
  INSERT INTO platform_audit_logs (id, action, "tenantId", data)
    VALUES (gen_random_uuid(), 'billing.services.initial', NULL, jsonb_build_object('source', 'migration prestations_g5g', 'count', 4));
END $$;

-- Rôle de la plateforme : droits des prestations dans une fonction à part, comme ceux de la facturation (lot G5a) :
-- grant_platform_role() (lots précédents et lot G2) reste inchangée. infra/postgres/role-plateforme.sh appelle les trois
-- fonctions à chaque installation. Ajout et lecture seulement : rien ne se modifie ni ne s'efface.
CREATE OR REPLACE FUNCTION grant_platform_services_role() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_platform') THEN
    RAISE NOTICE 'Rôle erp_platform absent : droits non attribués (poste de développement)';
    RETURN;
  END IF;
  GRANT SELECT, INSERT ON services, service_versions, service_rates, service_rate_ends TO erp_platform;
END $$;

SELECT grant_platform_services_role();
