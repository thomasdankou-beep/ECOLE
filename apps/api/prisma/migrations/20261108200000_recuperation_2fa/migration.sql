-- Récupération de la double authentification (lots R1, R2, R3).
-- Ajouts seulement : deux colonnes à « false » par défaut et trois tables nouvelles.
-- Aucune ligne existante n'est modifiée ni supprimée ; les secrets Google Authenticator (totpSecret) ne sont pas touchés.

-- CreateEnum
CREATE TYPE "RecoveryRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'COMPLETED', 'CANCELLED');

-- AlterTable
ALTER TABLE "platform_admins" ADD COLUMN     "mustSetupTwoFactor" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "twoFactorReenroll" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "platform_recovery_codes" (
    "id" UUID NOT NULL,
    "adminId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_codes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "two_factor_recovery_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "requestedById" UUID,
    "requestedByName" TEXT NOT NULL,
    "requestedByPlatform" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT NOT NULL,
    "identityCheck" TEXT NOT NULL,
    "identityNote" TEXT,
    "requiresPlatform" BOOLEAN NOT NULL DEFAULT false,
    "status" "RecoveryRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" UUID,
    "decidedByName" TEXT,
    "decidedByPlatform" BOOLEAN NOT NULL DEFAULT false,
    "decisionNote" TEXT,
    "decidedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "activationHash" TEXT,
    "activationExpiresAt" TIMESTAMP(3),
    "activationAttempts" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "two_factor_recovery_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_recovery_codes_adminId_codeHash_key" ON "platform_recovery_codes"("adminId", "codeHash");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_codes_userId_codeHash_key" ON "recovery_codes"("userId", "codeHash");

-- CreateIndex
CREATE INDEX "two_factor_recovery_requests_tenant_id_status_idx" ON "two_factor_recovery_requests"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "two_factor_recovery_requests_userId_idx" ON "two_factor_recovery_requests"("userId");

-- AddForeignKey
ALTER TABLE "platform_recovery_codes" ADD CONSTRAINT "platform_recovery_codes_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "platform_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "two_factor_recovery_requests" ADD CONSTRAINT "two_factor_recovery_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Isolation par établissement : une école ne voit ni les codes ni les demandes d'une autre.
ALTER TABLE "recovery_codes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recovery_codes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "recovery_codes" USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE "two_factor_recovery_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "two_factor_recovery_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "two_factor_recovery_requests" USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- Codes du Super Admin : jamais accessibles au rôle applicatif des écoles (comme platform_admins).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    REVOKE ALL ON platform_recovery_codes FROM erp_app;
  END IF;
END $$;

-- Rôle de la plateforme : mêmes droits qu'avant (migration securite_lot3), plus ce que la récupération demande.
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
  -- Récupération de la double authentification.
  GRANT SELECT, INSERT, UPDATE, DELETE ON platform_recovery_codes TO erp_platform;
  GRANT SELECT, INSERT, UPDATE ON two_factor_recovery_requests TO erp_platform;
  GRANT SELECT, DELETE ON recovery_codes TO erp_platform;
  GRANT INSERT ON notifications TO erp_platform;
END $$;

SELECT grant_platform_role();

-- Contrôle « même école » sur les nouvelles clés étrangères (recovery_codes.userId, two_factor_recovery_requests.userId).
SELECT install_same_tenant_checks();
