-- Isolation des établissements par Row Level Security (CDC §5.2, master prompt §7).
-- L'API se connecte avec le rôle erp_app (ni propriétaire, ni BYPASSRLS) et fixe
-- app.tenant_id dans chaque transaction : une requête sans tenant ne voit aucune ligne.

CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables tb ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema
    WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND tb.table_type = 'BASE TABLE'
      AND c.table_name <> 'verification_entries'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;

-- Journal d'audit infalsifiable : aucune modification ni suppression, même par le propriétaire.
CREATE OR REPLACE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'La table % est en ajout seul', TG_TABLE_NAME;
END $$;
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Reçus, paiements et notes ne se suppriment jamais physiquement.
CREATE TRIGGER receipts_no_delete BEFORE DELETE ON receipts FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER grades_no_delete BEFORE DELETE ON grades FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Droits du rôle applicatif.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT USAGE ON SCHEMA public TO erp_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO erp_app;
    REVOKE INSERT, UPDATE, DELETE ON tenants FROM erp_app;
    REVOKE UPDATE, DELETE ON audit_logs FROM erp_app;
    REVOKE DELETE ON receipts, payments, grades, verification_entries FROM erp_app;
    IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
      REVOKE ALL ON _prisma_migrations FROM erp_app;
    END IF;
    GRANT EXECUTE ON FUNCTION app_current_tenant() TO erp_app;
  END IF;
END $$;
