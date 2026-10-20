-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "domain" TEXT,
ADD COLUMN     "platformNotes" TEXT,
ADD COLUMN     "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE';

-- CreateTable
CREATE TABLE "platform_admins" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "failedLogins" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_audit_logs" (
    "id" UUID NOT NULL,
    "adminId" UUID,
    "action" TEXT NOT NULL,
    "tenantId" UUID,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_admins_email_key" ON "platform_admins"("email");

-- CreateIndex
CREATE INDEX "platform_audit_logs_createdAt_idx" ON "platform_audit_logs"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_domain_key" ON "tenants"("domain");


-- Journal de la plateforme en ajout seul.
CREATE TRIGGER platform_audit_append_only BEFORE UPDATE OR DELETE ON platform_audit_logs FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Tables de la plateforme : jamais accessibles au rôle applicatif des écoles.
-- Le statut et le domaine d'une école ne se changent que depuis la plateforme.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    REVOKE ALL ON platform_admins, platform_audit_logs FROM erp_app;
    REVOKE UPDATE ON tenants FROM erp_app;
    GRANT UPDATE (name, "shortName", settings, "updatedAt") ON tenants TO erp_app;
  END IF;
END $$;
