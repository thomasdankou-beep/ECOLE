#!/usr/bin/env bash
# Installe ou met à jour le site sur un serveur Ubuntu (VPS), en root :
#   ./installer-serveur.sh            (adresse publique du serveur détectée automatiquement)
#   ./installer-serveur.sh 2.24.57.21 (adresse donnée à la main)
# Installe Docker si besoin, crée .env avec des secrets de production aléatoires au premier lancement
# (jamais remplacés ensuite), récupère la dernière version du code et démarre les services.
# Ne charge AUCUNE donnée de démonstration. Relancer le script = mettre le site à jour, les données restent.
set -euo pipefail
cd "$(dirname "$0")"

if [ "$(id -u)" != 0 ]; then
  echo "Lancez ce script en root : sudo ./installer-serveur.sh"
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Installation de Docker (quelques minutes)..."
  curl -fsSL https://get.docker.com | sh
fi
if ! docker compose version >/dev/null 2>&1; then
  apt-get update && apt-get install -y docker-compose-plugin
fi
systemctl enable --now docker >/dev/null 2>&1 || true

# Pare-feu Ubuntu : s'il est actif, on ouvre SSH, HTTP et HTTPS.
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
fi

if [ -d .git ]; then
  echo "Récupération de la dernière version du code..."
  git pull --ff-only || echo "Attention : le code n'a pas pu être mis à jour, la version actuelle est utilisée."
fi

secret() { openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
setkv() { # setkv CLE valeur : remplace la ligne CLE=... dans .env, ou l'ajoute.
  if grep -q "^$1=" .env; then sed -i "s#^$1=.*#$1=$2#" .env; else echo "$1=$2" >> .env; fi
}

if [ ! -f .env ]; then
  ip="${1:-$(curl -4 -fsS --max-time 10 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')}"
  cp .env.docker.example .env
  # Pas encore de nom de domaine : site en http sur l'adresse IP, port 80.
  setkv WEB_ORIGIN "http://$ip"
  setkv HTTP_PORT 80
  setkv SITE_ADDRESS :80
  setkv COOKIE_SECURE false
  setkv SHOW_DEMO_ACCOUNTS false
  echo "Fichier .env de production créé pour http://$ip"
fi
for k in POSTGRES_PASSWORD ERP_OWNER_PASSWORD ERP_APP_PASSWORD JWT_ACCESS_SECRET JWT_REFRESH_SECRET APP_ENCRYPTION_KEY; do
  if grep -q "^$k=." .env; then continue; fi
  # La clé de chiffrement est lue en base64 (32 octets) ; les autres secrets en hexadécimal.
  if [ "$k" = APP_ENCRYPTION_KEY ]; then v=$(head -c 32 /dev/urandom | base64 | tr -d '\n'); else v=$(secret); fi
  setkv "$k" "$v"
  echo "Secret $k généré."
done
chmod 600 .env

echo "Construction et démarrage des services (10 à 15 minutes la première fois)..."
docker compose up -d --build

port=$(grep '^HTTP_PORT=' .env | cut -d= -f2-); port=${port:-80}
echo "Attente de la réponse du site..."
for i in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://localhost:${port}/"; then
    echo ""
    echo "SITE EN LIGNE : $(grep '^WEB_ORIGIN=' .env | cut -d= -f2-)"
    echo "Étape suivante, créer votre compte Super Admin :"
    echo "  docker compose exec api npm run platform:admin -- votre@email \"Votre nom\""
    exit 0
  fi
  sleep 5
done

echo "Le site ne répond pas encore. État des services :"
docker compose ps
docker compose logs --tail=40 api web caddy
exit 1
