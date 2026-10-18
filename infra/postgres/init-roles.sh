#!/bin/sh
# Crée les deux rôles de la base au premier démarrage du conteneur PostgreSQL :
# - erp_owner : propriétaire du schéma, utilisé pour les migrations et le jeu de démonstration ;
# - erp_app : rôle de l'application, sans contournement de la Row Level Security.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE erp_owner LOGIN PASSWORD '${ERP_OWNER_PASSWORD}';
CREATE ROLE erp_app LOGIN PASSWORD '${ERP_APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
CREATE DATABASE erp OWNER erp_owner;
SQL
