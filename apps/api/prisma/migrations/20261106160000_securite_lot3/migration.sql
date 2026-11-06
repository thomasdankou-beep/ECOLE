-- Sécurité v1.1, étape 1, lot 3 (SEC-009) : rôle de base dédié au Super Admin.
-- Aucune donnée n'est modifiée. Le rôle erp_platform (créé par le script d'installation, car le
-- propriétaire erp_owner ne peut pas créer de rôle) n'est ni propriétaire des tables ni exempté
-- de la Row Level Security. Il reçoit seulement ce dont la plateforme a besoin.

-- La plateforme lit, crée et modifie les écoles (y compris ses notes internes).
DROP POLICY IF EXISTS tenants_platform_all ON tenants;
CREATE POLICY tenants_platform_all ON tenants TO PUBLIC
  USING (current_user = 'erp_platform') WITH CHECK (current_user = 'erp_platform');

CREATE OR REPLACE FUNCTION grant_platform_role() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_platform') THEN
    RAISE NOTICE 'Rôle erp_platform absent : droits non attribués (poste de développement)';
    RETURN;
  END IF;
  GRANT USAGE ON SCHEMA public TO erp_platform;
  GRANT EXECUTE ON FUNCTION app_current_tenant() TO erp_platform;
  -- Écoles et comptes de la plateforme.
  GRANT SELECT, INSERT, UPDATE ON tenants TO erp_platform;
  GRANT SELECT, INSERT, UPDATE ON platform_admins TO erp_platform;
  GRANT SELECT, INSERT ON platform_audit_logs TO erp_platform;
  -- Dans une école (toujours sous sa Row Level Security) : activité, premier site et compte Direction,
  -- réinitialisation de la Direction, trace dans le journal de l'école.
  GRANT SELECT ON students TO erp_platform;
  GRANT SELECT, INSERT ON sites TO erp_platform;
  GRANT SELECT, INSERT, UPDATE ON users TO erp_platform;
  GRANT SELECT, INSERT ON user_roles TO erp_platform;
  GRANT SELECT, UPDATE ON sessions TO erp_platform;
  GRANT INSERT ON audit_logs TO erp_platform;
END $$;

SELECT grant_platform_role();
