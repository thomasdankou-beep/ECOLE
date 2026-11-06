-- Contrôle en lecture seule (sécurité v1.1, SEC-001) : compte les fiches qui pointent vers une fiche d'une autre école.
-- Ne modifie rien (transaction en lecture seule, annulée à la fin).
-- Sur le serveur : cd ~/ecole && docker compose exec -T postgres psql -U postgres erp -q < infra/securite/verifier-liens-ecoles.sql
BEGIN READ ONLY;
DO $$
DECLARE r record; n bigint; total bigint := 0;
BEGIN
  FOR r IN
    SELECT con.conrelid::regclass::text AS child, ca.attname AS col, con.confrelid::regclass::text AS parent, pa.attname AS pcol
    FROM pg_constraint con
    JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = con.conkey[1]
    JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = con.confkey[1]
    WHERE con.contype = 'f' AND array_length(con.conkey, 1) = 1 AND con.connamespace = 'public'::regnamespace AND ca.attname <> 'tenant_id'
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = con.conrelid AND a.attname = 'tenant_id')
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = con.confrelid AND a.attname = 'tenant_id')
  LOOP
    EXECUTE format('SELECT count(*) FROM %s c JOIN %s p ON p.%I = c.%I WHERE p.tenant_id <> c.tenant_id', r.child, r.parent, r.pcol, r.col) INTO n;
    IF n > 0 THEN RAISE NOTICE '% liens entre ecoles dans %.%', n, r.child, r.col; END IF;
    total := total + n;
  END LOOP;
  RAISE NOTICE 'RESULTAT : % lien(s) entre ecoles', total;
END $$;
ROLLBACK;
