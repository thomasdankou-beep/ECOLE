#!/bin/sh
# Rôle de base dédié au Super Admin (sécurité v1.1, SEC-009) : crée erp_platform s'il n'existe pas,
# lui donne le mot de passe ERP_PLATFORM_PASSWORD du fichier .env, puis ses droits si la base est déjà migrée.
# Appelé par installer-serveur.sh et demarrer.sh, PostgreSQL démarré. Ne modifie aucune donnée.
set -e
cd "$(dirname "$0")/../.."
pw=$(grep '^ERP_PLATFORM_PASSWORD=' .env | cut -d= -f2-)
[ -n "$pw" ] || { echo "ERP_PLATFORM_PASSWORD manquant dans .env"; exit 1; }
for i in $(seq 1 30); do docker compose exec -T postgres pg_isready -U postgres -d erp >/dev/null 2>&1 && break; sleep 2; done
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -q -U postgres -d erp -v pw="$pw" >/dev/null <<'SQL'
SELECT format('CREATE ROLE erp_platform LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', :'pw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_platform') \gexec
SELECT format('ALTER ROLE erp_platform LOGIN PASSWORD %L', :'pw') \gexec
GRANT CONNECT ON DATABASE erp TO erp_platform;
SELECT 'SELECT grant_platform_role()' WHERE to_regproc('grant_platform_role') IS NOT NULL \gexec
SQL
echo "Rôle erp_platform prêt."
