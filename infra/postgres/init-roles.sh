#!/bin/sh
# Crée les deux rôles de la base au premier démarrage du conteneur PostgreSQL :
# - erp_owner : propriétaire du schéma, utilisé pour les migrations et le jeu de démonstration ;
# - erp_app : rôle de l'application, sans contournement de la Row Level Security ;
# - erp_platform : rôle du Super Admin (voir role-plateforme.sh, qui le crée aussi sur une base existante).
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE erp_owner LOGIN PASSWORD '${ERP_OWNER_PASSWORD}';
CREATE ROLE erp_app LOGIN PASSWORD '${ERP_APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
CREATE DATABASE erp OWNER erp_owner;
SQL
if [ -n "${ERP_PLATFORM_PASSWORD:-}" ]; then
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -c "CREATE ROLE erp_platform LOGIN PASSWORD '${ERP_PLATFORM_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE"
fi
