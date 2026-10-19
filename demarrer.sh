#!/usr/bin/env bash
# Lance le site avec Docker : crée .env (secrets générés) au premier lancement,
# démarre les services, charge les données de démonstration et attend que le site réponde.
set -euo pipefail
cd "$(dirname "$0")"

if ! docker info >/dev/null 2>&1; then
  echo "Docker n'est pas démarré. Lancez Docker Desktop (ou le service docker), puis relancez ./demarrer.sh"
  exit 1
fi

secret() { head -c 48 /dev/urandom | base64 | tr -d '\n/+='; }
port=8080

if [ ! -f .env ]; then
  cp .env.docker.example .env
  echo "Fichier .env créé."
fi

# GitHub Codespaces : le site est servi sur une adresse publique propre au codespace.
if [ -n "${CODESPACE_NAME:-}" ] && grep -q '^WEB_ORIGIN=http://localhost' .env; then
  sed -i.bak "s|^WEB_ORIGIN=.*|WEB_ORIGIN=https://${CODESPACE_NAME}-${port}.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}|" .env
fi

# Complète chaque secret vide ou absent (cas d'un .env copié à la main sans être rempli).
for k in POSTGRES_PASSWORD ERP_OWNER_PASSWORD ERP_APP_PASSWORD JWT_ACCESS_SECRET JWT_REFRESH_SECRET APP_ENCRYPTION_KEY; do
  if grep -q "^$k=." .env; then continue; fi
  if grep -q "^$k=" .env; then
    sed -i.bak "s|^$k=.*|$k=$(secret)|" .env
  else
    echo "$k=$(secret)" >> .env
  fi
  echo "Secret $k généré."
done
rm -f .env.bak

echo "Construction et démarrage des services (le premier lancement prend plusieurs minutes)..."
docker compose up -d --build

echo "Préparation de la base et des données de démonstration..."
seeded=0
for i in $(seq 1 40); do
  if docker compose exec -T api node -e "process.exit(0)" >/dev/null 2>&1 \
     && docker compose exec -T api npm run -s db:seed:if-empty >/dev/null 2>&1; then
    seeded=1; break
  fi
  sleep 5
done
[ "$seeded" = 1 ] || echo "Attention : les données de démonstration n'ont pas pu être chargées (voir : docker compose logs api)."

echo "Attente de la réponse du site..."
for i in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://localhost:${port}/"; then
    url=$(grep '^WEB_ORIGIN=' .env | cut -d= -f2-)
    echo ""
    echo "Site prêt : ${url:-http://localhost:${port}}"
    echo "Mot de passe des comptes de démonstration : Kisito2026 (direction : +2290190000010)"
    exit 0
  fi
  sleep 5
done

echo "Le site ne répond pas encore. État des services :"
docker compose ps
echo "Dernières lignes des journaux :"
docker compose logs --tail=40 api web caddy
exit 1
