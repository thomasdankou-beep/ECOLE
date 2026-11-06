-- Sécurité v1.1, étape 1, lot 2 (SEC-006, SEC-007, SEC-008, SEC-001 option B).
-- Aucune donnée n'est modifiée ni supprimée : on ne change que des règles d'accès,
-- un index d'unicité et des contrôles appliqués aux prochaines écritures.

-- SEC-006 : dans la transaction d'une école, seule sa propre fiche d'établissement est visible.
-- Hors transaction d'école (connexion, adresse du site, pages publiques), la recherche par
-- identifiant reste possible comme avant.
DROP POLICY IF EXISTS tenants_read ON tenants;
CREATE POLICY tenants_read ON tenants FOR SELECT
  USING (app_current_tenant() IS NULL OR id = app_current_tenant());

-- SEC-006 : les notes internes de la plateforme ne sont plus lisibles par le rôle des écoles.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    REVOKE SELECT ON tenants FROM erp_app;
    GRANT SELECT (id, slug, name, "shortName", country, currency, timezone, settings, status, domain, "createdAt", "updatedAt") ON tenants TO erp_app;
  END IF;
END $$;

-- SEC-007 : les codes de vérification et le routage des paiements sont cloisonnés par école.
-- Hors transaction d'école (vérification publique d'un document, retour de l'opérateur de
-- paiement), la recherche par code reste possible comme avant ; toute écriture doit porter
-- l'école courante.
ALTER TABLE verification_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON verification_entries
  USING (app_current_tenant() IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE payment_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_routes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_routes
  USING (app_current_tenant() IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- SEC-008 : la clé anti-doublon d'un paiement est unique dans son école, plus dans toute la plateforme.
-- L'ancienne règle étant plus stricte, aucune ligne existante ne peut faire échouer la nouvelle.
CREATE UNIQUE INDEX "payments_tenant_id_idempotencyKey_key" ON payments (tenant_id, "idempotencyKey");
DROP INDEX "payments_idempotencyKey_key";

-- SEC-001 (option B) : la base refuse elle-même qu'une fiche pointe vers la fiche d'une autre école.
-- PostgreSQL vérifie les clés étrangères sans la Row Level Security ; ce contrôle compare l'école de
-- la fiche référencée à celle de la ligne écrite. Il ne porte que sur les écritures futures, et une
-- mise à jour qui ne change pas la référence n'est pas contrôlée (les lignes existantes ne bloquent rien).
CREATE OR REPLACE FUNCTION check_same_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  i int;
  col text;
  needed boolean;
  owner_tenant uuid;
BEGIN
  -- Arguments par groupes de trois : colonne, table référencée, colonne référencée.
  FOR i IN 0 .. (TG_NARGS / 3) - 1 LOOP
    col := TG_ARGV[i * 3];
    IF TG_OP = 'UPDATE' THEN
      EXECUTE format('SELECT ($1).%1$I IS NOT NULL AND (($1).%1$I IS DISTINCT FROM ($2).%1$I OR ($1).tenant_id IS DISTINCT FROM ($2).tenant_id)', col)
        INTO needed USING NEW, OLD;
    ELSE
      EXECUTE format('SELECT ($1).%I IS NOT NULL', col) INTO needed USING NEW;
    END IF;
    CONTINUE WHEN NOT needed;
    -- Lecture sous la Row Level Security de l'appelant : la fiche d'une autre école est introuvable.
    EXECUTE format('SELECT p.tenant_id FROM %I p WHERE p.%I = ($1).%I', TG_ARGV[i * 3 + 1], TG_ARGV[i * 3 + 2], col)
      INTO owner_tenant USING NEW;
    IF owner_tenant IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'Référence vers un autre établissement (%.%)', TG_TABLE_NAME, col
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

-- Pose (ou repose) le contrôle sur chaque table d'école, d'après les clés étrangères existantes.
-- Une migration qui ajoute une clé étrangère entre tables d'école doit appeler : SELECT install_same_tenant_checks();
CREATE OR REPLACE FUNCTION install_same_tenant_checks() RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT con.conrelid::regclass::text AS child,
           string_agg(format('%L, %L, %L', ca.attname, con.confrelid::regclass::text, pa.attname), ', ' ORDER BY ca.attname) AS args
    FROM pg_constraint con
    JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = con.conkey[1]
    JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = con.confkey[1]
    WHERE con.contype = 'f' AND array_length(con.conkey, 1) = 1
      AND con.connamespace = 'public'::regnamespace
      AND ca.attname <> 'tenant_id'
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = con.conrelid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = con.confrelid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
    GROUP BY con.conrelid
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS same_tenant_refs ON %s', r.child);
    EXECUTE format('CREATE TRIGGER same_tenant_refs BEFORE INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION check_same_tenant(%s)', r.child, r.args);
  END LOOP;
END $$;

SELECT install_same_tenant_checks();
