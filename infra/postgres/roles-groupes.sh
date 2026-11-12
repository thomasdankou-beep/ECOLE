#!/bin/sh
# Rôles de base des groupes scolaires (lot G1), sur le modèle de role-plateforme.sh :
# - erp_group : console du groupe (lot G2), lecture seule de son propre groupe ;
# - erp_stats : calcul des chiffres agrégés (lots G3 et G5), aucun droit sur aucune table pour l'instant.
# Crée chaque rôle s'il n'existe pas, lui donne le mot de passe du fichier .env (ERP_GROUP_PASSWORD,
# ERP_STATS_PASSWORD), puis ses droits si la base est déjà migrée (fonction grant_group_roles()).
# Aucun service ne s'y connecte encore. Appelé par installer-serveur.sh et demarrer.sh, PostgreSQL démarré.
# Ne modifie aucune donnée.
set -e
cd "$(dirname "$0")/../.."
gpw=$(grep '^ERP_GROUP_PASSWORD=' .env | cut -d= -f2-)
spw=$(grep '^ERP_STATS_PASSWORD=' .env | cut -d= -f2-)
[ -n "$gpw" ] || { echo "ERP_GROUP_PASSWORD manquant dans .env"; exit 1; }
[ -n "$spw" ] || { echo "ERP_STATS_PASSWORD manquant dans .env"; exit 1; }
for i in $(seq 1 30); do docker compose exec -T postgres pg_isready -U postgres -d erp >/dev/null 2>&1 && break; sleep 2; done
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -q -U postgres -d erp -v gpw="$gpw" -v spw="$spw" >/dev/null <<'SQL'
SELECT format('CREATE ROLE erp_group LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', :'gpw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_group') \gexec
SELECT format('ALTER ROLE erp_group LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', :'gpw') \gexec
SELECT format('CREATE ROLE erp_stats LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', :'spw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_stats') \gexec
SELECT format('ALTER ROLE erp_stats LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', :'spw') \gexec
GRANT CONNECT ON DATABASE erp TO erp_group, erp_stats;
SELECT 'SELECT grant_group_roles()' WHERE to_regproc('grant_group_roles') IS NOT NULL \gexec
SQL
echo "Rôles erp_group et erp_stats prêts."
