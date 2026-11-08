-- Retour arrière de la migration 20261108200000_recuperation_2fa (à n'utiliser qu'après avoir remis le code précédent).
-- Efface les codes de récupération, les demandes de récupération et les deux colonnes ajoutées ; ne touche à aucune
-- autre donnée, ni aux secrets Google Authenticator existants.
-- Attention : un compte dont la récupération a été validée mais pas terminée (twoFactorReenroll = true) reste sans
-- double authentification après ce retour arrière ; la liste est affichée ci-dessous avant l'effacement.
-- Lancement : psql "$DATABASE_ADMIN_URL" -v ON_ERROR_STOP=1 -f retour-arriere/20261108200000_recuperation_2fa.sql
BEGIN;

-- Comptes en cours de réactivation (à prévenir) : l'école doit les remettre en double authentification à la main.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM users WHERE "twoFactorReenroll";
  RAISE NOTICE 'Comptes en cours de réactivation : %', n;
END $$;

DROP TABLE IF EXISTS "two_factor_recovery_requests";
DROP TABLE IF EXISTS "recovery_codes";
DROP TABLE IF EXISTS "platform_recovery_codes";
DROP TYPE IF EXISTS "RecoveryRequestStatus";
ALTER TABLE "users" DROP COLUMN IF EXISTS "twoFactorReenroll";
ALTER TABLE "platform_admins" DROP COLUMN IF EXISTS "mustSetupTwoFactor";

-- Droits de la plateforme tels qu'avant (migration securite_lot3).
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
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_platform') THEN
    REVOKE INSERT ON notifications FROM erp_platform;
  END IF;
END $$;

DELETE FROM "_prisma_migrations" WHERE migration_name = '20261108200000_recuperation_2fa';
COMMIT;
