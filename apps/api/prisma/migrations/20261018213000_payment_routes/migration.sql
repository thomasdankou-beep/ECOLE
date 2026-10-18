-- CreateTable
CREATE TABLE "payment_routes" (
    "transaction_id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_routes_pkey" PRIMARY KEY ("transaction_id")
);

-- Le webhook de paiement arrive sans établissement : cette table (sans donnée personnelle) le retrouve.
GRANT SELECT, INSERT ON payment_routes TO erp_app;

-- Un rôle sans site (NULL) ne peut pas être attribué deux fois.
ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS "user_roles_userId_role_siteId_key";
DROP INDEX IF EXISTS "user_roles_userId_role_siteId_key";
CREATE UNIQUE INDEX "user_roles_userId_role_siteId_key" ON user_roles ("userId", role, "siteId") NULLS NOT DISTINCT;

-- Établissements : lecture libre (connexion par identifiant d'établissement), modification limitée à son propre établissement.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenants_read ON tenants FOR SELECT USING (true);
CREATE POLICY tenants_update_own ON tenants FOR UPDATE USING (id = app_current_tenant()) WITH CHECK (id = app_current_tenant());
CREATE POLICY tenants_owner_all ON tenants TO erp_owner USING (true) WITH CHECK (true);
GRANT UPDATE (name, "shortName", settings, "updatedAt") ON tenants TO erp_app;

-- Les tables créées par les migrations futures donnent les mêmes droits au rôle applicatif.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO erp_app;
