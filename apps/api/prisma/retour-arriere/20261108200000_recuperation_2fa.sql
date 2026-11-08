-- Retour arrière de la migration 20261108200000_recuperation_2fa (API arrêtée, avant de remettre le code précédent).
-- Efface les codes de récupération, les demandes de récupération et les deux colonnes ajoutées ; ne touche à aucune
-- autre donnée, ni aux secrets Google Authenticator existants.
-- Contrôle de sécurité : un compte dont la récupération a été validée mais pas terminée (twoFactorReenroll = true)
-- n'a plus d'ancienne double authentification ; après ce retour arrière il resterait sans 2FA. Le script liste ces
-- comptes et S'ARRÊTE sans rien changer tant qu'il y en a. Faites d'abord terminer leur réactivation (connexion avec
-- le code de réactivation, nouveau téléphone), puis relancez. Pour passer outre en connaissance de cause seulement :
--   PGOPTIONS="-c cahiora.forcer_retour=oui" (les comptes listés devront réactiver la 2FA dans Mon compte).
-- Le Super Admin récupéré par la commande serveur (mustSetupTwoFactor = true) est contrôlé de la même façon.
-- Lancement, avec le super-utilisateur postgres (seul à voir les comptes de toutes les écoles malgré le cloisonnement) :
--   docker compose exec -T postgres psql -U postgres erp -v ON_ERROR_STOP=1 < apps/api/prisma/retour-arriere/20261108200000_recuperation_2fa.sql
BEGIN;

DO $$ BEGIN
  IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'Lancez ce script avec le super-utilisateur postgres : sinon le cloisonnement par école cache les comptes à contrôler';
  END IF;
END $$;

DO $$
DECLARE
  r record;
  n int := 0;
BEGIN
  FOR r IN
    SELECT t.slug AS ecole, u."firstName" || ' ' || u."lastName" AS nom, coalesce(u.phone, u.email, u.id::text) AS compte
    FROM users u JOIN tenants t ON t.id = u.tenant_id
    WHERE u."twoFactorReenroll" ORDER BY 1, 2
  LOOP
    n := n + 1;
    RAISE NOTICE 'Réactivation en cours : % (%) dans l''école %', r.nom, r.compte, r.ecole;
  END LOOP;
  FOR r IN SELECT name AS nom, email AS compte FROM platform_admins WHERE "mustSetupTwoFactor" ORDER BY 1 LOOP
    n := n + 1;
    RAISE NOTICE 'Super Admin sans nouvelle double authentification : % (%)', r.nom, r.compte;
  END LOOP;
  RAISE NOTICE 'Comptes en cours de réactivation : %', n;
  IF n > 0 AND coalesce(current_setting('cahiora.forcer_retour', true), '') <> 'oui' THEN
    RAISE EXCEPTION 'Retour arrière arrêté, rien n''a été modifié : % compte(s) resteraient sans double authentification. Faites terminer leur réactivation puis relancez.', n;
  END IF;
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
