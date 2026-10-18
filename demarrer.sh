#!/usr/bin/env bash
# Lance le site en local avec Docker : crée .env (secrets générés) au premier lancement,
# démarre les services, puis charge les données de démonstration.
set -euo pipefail
cd "$(dirname "$0")"

secret() { head -c 48 /dev/urandom | base64 | tr -d '\n/+='; }

if [ ! -f .env ]; then
  cp .env.docker.example .env
  for k in POSTGRES_PASSWORD ERP_OWNER_PASSWORD ERP_APP_PASSWORD JWT_ACCESS_SECRET JWT_REFRESH_SECRET APP_ENCRYPTION_KEY; do
    sed -i.bak "s|^$k=.*|$k=$(secret)|" .env
  done
  rm -f .env.bak
  echo "Fichier .env créé avec des secrets générés."
  first_run=1
fi

docker compose up -d --build

if [ "${first_run:-0}" = 1 ]; then
  echo "Chargement des données de démonstration..."
  for i in $(seq 1 30); do
    docker compose exec -T api npm run db:seed && break
    sleep 5
  done
fi

echo "Site prêt : http://localhost:${HTTP_PORT:-8080}"
