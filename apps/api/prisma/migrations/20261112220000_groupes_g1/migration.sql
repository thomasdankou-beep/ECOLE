-- Lot G1 · groupes scolaires (plan validé le 12 novembre 2026, décision D-G1).
-- Un groupe est un compte client qui regroupe une ou plusieurs écoles ; une école indépendante est un
-- groupe d'un seul établissement. Aucune donnée existante n'est modifiée ni supprimée : la migration
-- ajoute deux tables et deux colonnes, puis rattache chaque école à un groupe créé à son nom, en le
-- traçant dans les journaux de la plateforme, du groupe et de l'école.
-- Tout s'applique en une seule transaction : en cas d'erreur, rien n'est changé.

-- CreateEnum
CREATE TYPE "GroupStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateTable
CREATE TABLE "school_groups" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "promoter" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "country" TEXT NOT NULL DEFAULT 'BJ',
    "taxId" TEXT,
    "status" "GroupStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "school_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_audit_logs" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "actorKind" TEXT NOT NULL,
    "actorId" UUID,
    "actorName" TEXT,
    "action" TEXT NOT NULL,
    "data" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "group_audit_logs_group_id_createdAt_idx" ON "group_audit_logs"("group_id", "createdAt");

-- Journal du groupe en ajout seul, comme ceux des écoles et de la plateforme.
CREATE TRIGGER group_audit_append_only BEFORE UPDATE OR DELETE ON group_audit_logs FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- AlterTable : colonnes d'abord facultatives, le temps du rattachement.
ALTER TABLE "tenants" ADD COLUMN "group_id" UUID,
ADD COLUMN "groupJoinedAt" TIMESTAMP(3);

-- Rattachement : chaque école existante devient un groupe d'un seul établissement, à son nom (D-G1).
-- Trace dans les trois journaux. Le journal de l'école est cloisonné : l'école courante est fixée pour
-- chaque ligne, puis effacée.
DO $$
DECLARE
  t record;
  g uuid;
BEGIN
  FOR t IN SELECT id, name, country FROM tenants ORDER BY "createdAt", id LOOP
    g := gen_random_uuid();
    INSERT INTO school_groups (id, name, country, "updatedAt") VALUES (g, t.name, t.country, CURRENT_TIMESTAMP);
    UPDATE tenants SET group_id = g, "groupJoinedAt" = CURRENT_TIMESTAMP WHERE id = t.id;
    INSERT INTO group_audit_logs (id, group_id, "actorKind", "actorName", action, data)
      VALUES (gen_random_uuid(), g, 'system', 'Mise à jour de Cahiora (lot G1)', 'group.created_for_school',
              jsonb_build_object('tenantId', t.id, 'tenantName', t.name));
    INSERT INTO platform_audit_logs (id, action, "tenantId", data)
      VALUES (gen_random_uuid(), 'platform.group.created_for_school', t.id,
              jsonb_build_object('groupId', g, 'groupName', t.name, 'source', 'migration groupes_g1'));
    PERFORM set_config('app.tenant_id', t.id::text, true);
    INSERT INTO audit_logs (id, tenant_id, "userId", "userName", action, entity, "entityId", data)
      VALUES (gen_random_uuid(), t.id, NULL, 'Mise à jour de Cahiora', 'platform.group.initial', 'Tenant', t.id::text,
              jsonb_build_object('group', t.name));
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

-- Toute école appartient désormais à un groupe.
ALTER TABLE "tenants" ALTER COLUMN "group_id" SET NOT NULL,
ALTER COLUMN "groupJoinedAt" SET NOT NULL,
ALTER COLUMN "groupJoinedAt" SET DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "tenants_group_id_idx" ON "tenants"("group_id");

-- AddForeignKey : un groupe qui a des écoles ne peut pas être supprimé.
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "school_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Groupe de la session, fixé à chaque transaction par la console du groupe (lot G2), comme app.tenant_id pour les écoles.
CREATE OR REPLACE FUNCTION app_current_group() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.group_id', true), '')::uuid $$;

-- Row Level Security des tables du groupe. Les rôles erp_platform et erp_group peuvent ne pas exister
-- encore (poste de développement) : les politiques testent current_user, comme tenants_platform_all.
ALTER TABLE school_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY school_groups_owner_all ON school_groups TO erp_owner USING (true) WITH CHECK (true);
CREATE POLICY school_groups_platform_all ON school_groups TO PUBLIC
  USING (current_user = 'erp_platform') WITH CHECK (current_user = 'erp_platform');
CREATE POLICY school_groups_group_read ON school_groups FOR SELECT TO PUBLIC
  USING (current_user = 'erp_group' AND id = app_current_group());

ALTER TABLE group_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY group_audit_owner_all ON group_audit_logs TO erp_owner USING (true) WITH CHECK (true);
CREATE POLICY group_audit_platform_all ON group_audit_logs TO PUBLIC
  USING (current_user = 'erp_platform') WITH CHECK (current_user = 'erp_platform');
CREATE POLICY group_audit_group_read ON group_audit_logs FOR SELECT TO PUBLIC
  USING (current_user = 'erp_group' AND group_id = app_current_group());

-- Écoles vues par le rôle du groupe : seulement celles de son groupe. La politique restrictive empêche
-- que la lecture libre hors transaction d'école (tenants_read) s'applique jamais à ce rôle.
CREATE POLICY tenants_group_read ON tenants FOR SELECT TO PUBLIC
  USING (current_user = 'erp_group' AND group_id = app_current_group());
CREATE POLICY tenants_group_only ON tenants AS RESTRICTIVE FOR SELECT TO PUBLIC
  USING (current_user <> 'erp_group' OR group_id = app_current_group());

-- Les écoles (erp_app) n'ont aucun droit sur les tables du groupe : les droits par défaut donnés à
-- erp_app sur toute nouvelle table sont retirés. Elles ne lisent pas non plus les deux nouvelles
-- colonnes de tenants (leur droit de lecture est limité à une liste de colonnes, SEC-006).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    REVOKE ALL ON school_groups, group_audit_logs FROM erp_app;
  END IF;
END $$;

-- La direction d'une école voit dans Paramètres le nom de son groupe et la date du rattachement, sans aucun
-- droit sur les tables du groupe : cette fonction ne renvoie que cela, pour l'école courante (app.tenant_id),
-- jamais les autres écoles du groupe ni leur nombre.
CREATE OR REPLACE FUNCTION current_tenant_group() RETURNS TABLE (name text, joined_at timestamp)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT g.name, t."groupJoinedAt"
  FROM tenants t JOIN school_groups g ON g.id = t.group_id
  WHERE t.id = app_current_tenant()
$$;
REVOKE ALL ON FUNCTION current_tenant_group() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT EXECUTE ON FUNCTION current_tenant_group() TO erp_app;
  END IF;
END $$;

-- Rôle de la plateforme : mêmes droits qu'avant (migration recuperation_2fa), plus les groupes.
CREATE OR REPLACE FUNCTION grant_platform_role() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_platform') THEN
    RAISE NOTICE 'Rôle erp_platform absent : droits non attribués (poste de développement)';
    RETURN;
  END IF;
  GRANT USAGE ON SCHEMA public TO erp_platform;
  GRANT EXECUTE ON FUNCTION app_current_tenant() TO erp_platform;
  GRANT SELECT, INSERT, UPDATE ON tenants TO erp_platform;
  GRANT SELECT, INSERT, UPDATE ON platform_admins TO erp_platform;
  GRANT SELECT, INSERT ON platform_audit_logs TO erp_platform;
  GRANT SELECT ON students TO erp_platform;
  GRANT SELECT, INSERT ON sites TO erp_platform;
  GRANT SELECT, INSERT, UPDATE ON users TO erp_platform;
  GRANT SELECT, INSERT ON user_roles TO erp_platform;
  GRANT SELECT, UPDATE ON sessions TO erp_platform;
  GRANT INSERT ON audit_logs TO erp_platform;
  GRANT SELECT, INSERT, UPDATE, DELETE ON platform_recovery_codes TO erp_platform;
  GRANT SELECT, INSERT, UPDATE ON two_factor_recovery_requests TO erp_platform;
  GRANT SELECT, DELETE ON recovery_codes TO erp_platform;
  GRANT INSERT ON notifications TO erp_platform;
  -- Groupes scolaires (lot G1) : fiche, rattachement des écoles, journal du groupe (en ajout seul).
  GRANT EXECUTE ON FUNCTION app_current_group() TO erp_platform;
  GRANT SELECT, INSERT, UPDATE, DELETE ON school_groups TO erp_platform;
  GRANT SELECT, INSERT ON group_audit_logs TO erp_platform;
END $$;

-- Rôles des groupes (créés par infra/postgres/roles-groupes.sh, car erp_owner ne peut pas créer de rôle) :
-- - erp_group : console du groupe (lot G2), lecture seule de son propre groupe (app.group_id), sans les
--   notes internes, et d'une liste réduite de colonnes de ses écoles ; aucun droit sur les tables d'école ;
-- - erp_stats : calcul des chiffres agrégés (lots G3 et G5). Pour l'instant, aucun droit sur aucune table.
CREATE OR REPLACE FUNCTION grant_group_roles() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_group') THEN
    GRANT USAGE ON SCHEMA public TO erp_group;
    GRANT EXECUTE ON FUNCTION app_current_group() TO erp_group;
    GRANT SELECT (id, name, "legalName", promoter, phone, email, address, country, "taxId", status, "createdAt", "updatedAt") ON school_groups TO erp_group;
    GRANT SELECT ON group_audit_logs TO erp_group;
    GRANT SELECT (id, slug, name, "shortName", country, currency, status, group_id, "groupJoinedAt") ON tenants TO erp_group;
  ELSE
    RAISE NOTICE 'Rôle erp_group absent : droits non attribués (poste de développement)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_stats') THEN
    GRANT USAGE ON SCHEMA public TO erp_stats;
  ELSE
    RAISE NOTICE 'Rôle erp_stats absent : droits non attribués (poste de développement)';
  END IF;
END $$;

SELECT grant_platform_role();
SELECT grant_group_roles();
