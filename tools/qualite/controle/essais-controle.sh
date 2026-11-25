#!/usr/bin/env bash
# Essais de controle-production.sh et de maintenance.sh (demande de Dankou du 24 novembre 2026, 22 h 49, points 1 à 9), sur
# un banc Docker qui reproduit le serveur : PostgreSQL 16 avec les vraies migrations (les 25 de la version en ligne fcb84eb,
# puis les 5 de la mise à jour), Redis, la vraie image de Caddy avec le Caddyfile du code monté comme en production, l'API
# et le site remplacés par un petit serveur (banc/serveur.js). Les deux scripts sont lancés comme sur le serveur,
# sh -c "<contenu du script>", depuis ~/ecole : une copie du dépôt d'abord à fcb84eb, puis au commit essayé (la mise à
# jour est simulée par git checkout). Données fictives ; rien n'est envoyé vers le serveur de production.
#
# Usage : bash tools/qualite/controle/essais-controle.sh
# Il faut Docker (avec compose), git, curl, node et l'historique complet du dépôt (fcb84eb).
# SORTIES=<dossier> garde la sortie de chaque lancement ; BANC_PORT change le port local de Caddy (18191).
set -uo pipefail

racine=$(cd "$(dirname "$0")/../../.." && pwd)
ici="$racine/tools/qualite/controle"
EN_LIGNE=fcb84eb24d26d81068f09dc91d37c80ca6701fce # version en production : 25 migrations
NOUVELLES="20261119120000_comptages_g5b 20261120090000_documents_g5c 20261121090000_acces_g5d1 20261122090000_paiements_g5d2 20261123090000_ajustements_g5"
tmp=$(mktemp -d)
sorties="${SORTIES:-$tmp/sorties}"
mkdir -p "$sorties" "$tmp/bin" "$tmp/app"
pids_annexes=""

# --- Environnement : HOME du banc (~/ecole, ~/.cahiora-maintenance, ~/sauvegardes) ; curl sans relais réseau.
export DOCKER_CONFIG="${DOCKER_CONFIG:-$HOME/.docker}"
export HOME="$tmp/home"
mkdir -p "$HOME"
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy NO_PROXY no_proxy FENETRE ATTENDU EMPREINTE DETAIL PANNE
export GIT_AUTHOR_NAME=essai GIT_AUTHOR_EMAIL=essai@example.invalid GIT_COMMITTER_NAME=essai GIT_COMMITTER_EMAIL=essai@example.invalid
P="${BANC_PORT:-18191}"
export COMPOSE_FILE="$ici/banc/docker-compose.yml" COMPOSE_PROJECT_NAME=essai_controle BANC_ECOLE="$HOME/ecole" BANC_APP="$tmp/app" BANC_PORT="$P"
export ESSAI_SCHEMA=http ESSAI_LOCAL="127.0.0.1:$P" ESSAI_CURL="--connect-to ::127.0.0.1:$P"
CONTROLE=$(cat "$racine/controle-production.sh")
MAINTENANCE=$(cat "$racine/maintenance.sh")

# docker : le vrai, sauf PANNE = motif (grep -E) d'une requête SQL passée par -c, qui échoue alors (point 6).
DOCKER_REEL=$(command -v docker) || { echo "Docker introuvable."; exit 1; }
export DOCKER_REEL
cat > "$tmp/bin/docker" <<'EOF'
#!/bin/sh
if [ -n "${PANNE:-}" ]; then
  prec=""
  for a in "$@"; do
    if [ "$prec" = "-c" ] && printf '%s' "$a" | grep -qE -- "$PANNE"; then echo "ERROR:  panne simulée" >&2; exit 1; fi
    prec=$a
  done
fi
exec "$DOCKER_REEL" "$@"
EOF
# ss absent (certains conteneurs de développement) : mêmes informations lues dans /proc/net/tcp et tcp6.
if ! command -v ss > /dev/null 2>&1; then
  cat > "$tmp/bin/ss" <<'EOF'
#!/bin/sh
cat /proc/net/tcp /proc/net/tcp6 2> /dev/null | awk '$4 == "0A" { split($2, a, ":"); h = a[2]; n = 0
  for (i = 1; i <= length(h); i++) n = n * 16 + index("0123456789ABCDEF", substr(h, i, 1)) - 1
  print "LISTEN 0 0 *:" n " *:*" }' | sort -u
EOF
fi
chmod +x "$tmp/bin/"*
export PATH="$tmp/bin:$PATH"

ok=0; ko=0
code_attendu() { # code_attendu <nom> <code obtenu> <code attendu>
  if [ "$2" = "$3" ]; then ok=$((ok + 1)); echo "  ok    $1 : code de sortie $2"
  else ko=$((ko + 1)); echo "  ÉCHEC $1 : code de sortie $2 au lieu de $3"; sed 's/^/        | /' "$sorties/$1.txt" | tail -n 40; fi
}
controle() { # controle <nom> <code attendu> [VARIABLE=valeur...] : le contrôle, depuis ~/ecole, comme sur le serveur
  local nom=$1 attendu=$2; shift 2
  (cd "$HOME/ecole" && env "$@" sh -c "$CONTROLE") > "$sorties/$nom.txt" 2>&1
  code_attendu "$nom" $? "$attendu"
}
maintenance() { # maintenance <nom> <code attendu> <debut|etat|fin> [VARIABLE=valeur...]
  local nom=$1 attendu=$2 action=$3; shift 3
  (cd "$HOME/ecole" && env "$@" sh -c "$MAINTENANCE" maintenance "$action") > "$sorties/$nom.txt" 2>&1
  code_attendu "$nom" $? "$attendu"
}
contient() { if grep -qF -- "$2" "$sorties/$1.txt"; then ok=$((ok + 1)); else ko=$((ko + 1)); echo "  ÉCHEC $1 : « $2 » absent"; fi; }
sans() { if grep -qF -- "$2" "$sorties/$1.txt"; then ko=$((ko + 1)); echo "  ÉCHEC $1 : « $2 » présent"; else ok=$((ok + 1)); fi; }
verifier() { # verifier <description> <commande...>
  local d=$1; shift
  if "$@"; then ok=$((ok + 1)); echo "  ok    $d"; else ko=$((ko + 1)); echo "  ÉCHEC $d"; fi
}
empreinte() { sed -n 's/^empreinte des données scolaires : \([0-9a-f]\{16\}\) .*/\1/p' "$sorties/$1.txt"; }
sql() { docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -q -U postgres -d erp -At -c "$1"; }
http() { # http <méthode> <url> : « code entete » (entete : oui si X-Cahiora-Maintenance: oui)
  curl -s -o /dev/null -m 5 -X "$1" -D - -w 'code=%{http_code}\n' --connect-to "::127.0.0.1:$P" "$2" 2> /dev/null | tr -d '\r' |
    awk 'tolower($0) ~ /^x-cahiora-maintenance: *oui/ { m = "oui" } /^code=/ { c = substr($0, 6) } END { print c " " (m ? m : "non") }'
}
attendre_site() { # attendre_site <code HTTP attendu> : 60 s au plus
  local i
  for i in $(seq 1 60); do [ "$(http GET http://cahiora.test/api/v1/health | cut -d' ' -f1)" = "$1" ] && return 0; sleep 1; done
  return 1
}
sonder_pendant() { # sonder_pendant <secondes> <fichier> : une requête toutes les 0,2 s, « code entete » par ligne
  local fin=$(($(date +%s) + $1))
  while [ "$(date +%s)" -lt "$fin" ]; do http GET http://saint-kisito.cahiora.test/connexion; sleep 0.2; done > "$2"
}
gardien() { cat "$HOME/.cahiora-maintenance/gardien.pid" 2> /dev/null; }
tuer_gardien() { # arrête le gardien d'un coup, comme une panne
  local g
  g=$(gardien)
  verifier "gardien en marche avant son arrêt simulé" test -n "$g" && kill -s KILL -- "-$g"
  sleep 1
}
fin_des_essais() {
  local g
  g=$(gardien) && kill -s TERM -- "-$g" 2> /dev/null
  for p in $pids_annexes; do kill "$p" 2> /dev/null; done
  docker compose down -v --remove-orphans > /dev/null 2>&1
  rm -rf "$tmp"
}
trap fin_des_essais EXIT

echo "0. Scripts : syntaxe, taille, configuration de Caddy, commit inscrit dans les images"
for s in controle-production.sh maintenance.sh; do
  verifier "$s : syntaxe valide (sh -n)" sh -n "$racine/$s"
  taille=$(wc -c < "$racine/$s")
  verifier "$s : $taille octets, passe en entier dans sh -c \"\$(git show …)\" (moins de 120 000)" test "$taille" -lt 120000
done
awk '/^config\(\) \{/ { f = 1; next } f && /<<.CADDY.$/ { c = 1; next } c && /^CADDY$/ { exit } c' "$racine/maintenance.sh" |
  sed '/^[[:space:]]*$/d' > "$tmp/config-maintenance"
grep -v '^[[:space:]]*#' "$racine/infra/caddy/Caddyfile" | sed '/^[[:space:]]*$/d' > "$tmp/caddyfile"
verifier "configuration chargée par maintenance.sh = infra/caddy/Caddyfile (hors commentaires)" cmp -s "$tmp/caddyfile" "$tmp/config-maintenance"
marque=$(grep -E '^(ARG|ENV) CAHIORA_COMMIT' "$racine/apps/api/Dockerfile")
verifier "apps/api/Dockerfile inscrit le commit dans l'image (ARG et ENV CAHIORA_COMMIT)" test "$(printf '%s\n' "$marque" | grep -c .)" = 2
verifier "apps/web/Dockerfile inscrit le commit de la même façon" test "$(grep -E '^(ARG|ENV) CAHIORA_COMMIT' "$racine/apps/web/Dockerfile")" = "$marque"
mkdir -p "$tmp/vide"
requis=$(grep -o '\${[A-Z_]*:?' "$racine/docker-compose.yml" | sed 's/\${//; s/:?//' | sort -u | sed 's/$/=essai/')
# shellcheck disable=SC2086
args=$(env $requis CAHIORA_COMMIT=0123456789abcdef0123456789abcdef01234567 docker compose -f "$racine/docker-compose.yml" \
  --project-directory "$tmp/vide" config --format json 2> "$tmp/config.err" |
  node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { const c = JSON.parse(s);
    console.log(["api", "web"].map((n) => n + "=" + ((c.services[n].build || {}).args || {}).CAHIORA_COMMIT).join(" ")); })')
verifier "docker-compose.yml passe le commit exporté par l'installateur aux images de l'API et du site ($args)" \
  test "$args" = "api=0123456789abcdef0123456789abcdef01234567 web=0123456789abcdef0123456789abcdef01234567"

echo "Préparation du banc : ~/ecole à fcb84eb (version en ligne), base avec ses 25 migrations, données fictives"
git -C "$racine" cat-file -e "$EN_LIGNE^{commit}" 2> /dev/null || { echo "Historique incomplet : fcb84eb absent (actions/checkout avec fetch-depth: 0)."; exit 1; }
git clone -q "$racine" "$HOME/ecole" || exit 1
git -C "$racine" diff HEAD --binary > "$tmp/travail.patch"
if [ -s "$tmp/travail.patch" ]; then # essai sur un poste de travail : modifications non validées comprises
  (cd "$HOME/ecole" && git apply --index "$tmp/travail.patch" && git commit -q -m "essai : copie de travail") || exit 1
fi
NOUVEAU=$(git -C "$HOME/ecole" rev-parse HEAD)
court=$(printf '%s' "$NOUVEAU" | cut -c1-7)
git -C "$HOME/ecole" checkout -q "$EN_LIGNE" || exit 1
cat > "$HOME/ecole/.env" <<'EOF'
PLATFORM_DOMAIN=cahiora.test
BILLING_PAYMENTS_UNLOCKED=false
PAYMENT_PROVIDER=sandbox
SMS_PROVIDER=console
ERP_PLATFORM_PASSWORD=erp_platform_essai
ERP_GROUP_PASSWORD=erp_group_essai
ERP_STATS_PASSWORD=erp_stats_essai
EOF
cp "$ici/banc/serveur.js" "$tmp/app/"
base="FROM ${BANC_NODE:-node:22-alpine}
COPY serveur.js /serveur.js
ARG ROLE_ESSAI=api
ARG PORT_ESSAI=4000
ENV ROLE_ESSAI=\$ROLE_ESSAI PORT_ESSAI=\$PORT_ESSAI"
# Un Dockerfile par service, comme en production (apps/api/Dockerfile, apps/web/Dockerfile).
for s in api web; do
  printf '%s\nCMD ["node", "/serveur.js"]\n' "$base" > "$tmp/app/Dockerfile.$s.avant" # comme les images de fcb84eb : aucun commit inscrit
  printf '%s\n%s\nCMD ["node", "/serveur.js"]\n' "$base" "$marque" > "$tmp/app/Dockerfile.$s.apres" # lignes copiées de apps/api/Dockerfile
done
docker compose up -d postgres > "$tmp/demarrage.log" 2>&1 || { cat "$tmp/demarrage.log"; exit 1; }
for i in $(seq 1 60); do docker compose exec -T postgres pg_isready -U postgres -d erp > /dev/null 2>&1 && break; sleep 2; done
(cd "$HOME/ecole" && ./infra/postgres/role-plateforme.sh && ./infra/postgres/roles-groupes.sh) > /dev/null || { echo "Rôles de la base : échec."; exit 1; }
migrer() { # migrer <migration>... : comme prisma migrate deploy (en erp_owner, une transaction par migration), puis noté
  local m f
  for m in "$@"; do
    f="$HOME/ecole/apps/api/prisma/migrations/$m/migration.sql"
    docker compose exec -T -e PGOPTIONS='-c client_min_messages=warning' postgres psql -v ON_ERROR_STOP=1 -q -U erp_owner -d erp -1 -f - < "$f" > /dev/null ||
      { echo "Migration $m : échec."; return 1; }
    docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -q -U erp_owner -d erp -c "INSERT INTO _prisma_migrations (id, checksum,
      finished_at, migration_name, applied_steps_count) VALUES (gen_random_uuid()::text, '$(sha256sum < "$f" | cut -c1-64)', now(), '$m', 1)" || return 1
  done
}
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -q -U erp_owner -d erp -c 'CREATE TABLE "_prisma_migrations" ("id" VARCHAR(36) PRIMARY KEY NOT NULL,
  "checksum" VARCHAR(64) NOT NULL, "finished_at" TIMESTAMPTZ, "migration_name" VARCHAR(255) NOT NULL, "logs" TEXT, "rolled_back_at" TIMESTAMPTZ,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(), "applied_steps_count" INTEGER NOT NULL DEFAULT 0)' || exit 1
# shellcheck disable=SC2046
migrer $(ls "$HOME/ecole/apps/api/prisma/migrations" | grep -v '\.toml$') || exit 1
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -q -U postgres -d erp > /dev/null <<'SQL' || { echo "Données fictives : échec."; exit 1; }
BEGIN;
INSERT INTO school_groups (id, name, "updatedAt") VALUES
  ('a0000000-0000-4000-8000-000000000001', 'Groupe A (essai)', now()), ('a0000000-0000-4000-8000-000000000002', 'Groupe B (essai)', now());
INSERT INTO tenants (id, slug, name, "updatedAt", group_id, domain) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'saint-kisito', 'École A (essai)', now(), 'a0000000-0000-4000-8000-000000000001', NULL),
  ('b0000000-0000-4000-8000-000000000002', 'dst', 'École B (essai)', now(), 'a0000000-0000-4000-8000-000000000002', 'ecole-b.test');
INSERT INTO platform_admins (id, email, name, "passwordHash", active, "totpEnabled", "mustSetupTwoFactor")
  VALUES ('c0000000-0000-4000-8000-000000000001', 'admin@example.invalid', 'Admin essai', 'x', true, true, false);
INSERT INTO sites (id, tenant_id, name, "updatedAt") VALUES ('d0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'Site A', now());
INSERT INTO academic_years (id, tenant_id, label, "startDate", "endDate")
  VALUES ('e0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', '2026-2027', '2026-09-14', '2027-07-31');
INSERT INTO levels (id, tenant_id, name, cycle, position) VALUES ('f0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', '6e', 'COLLEGE', 1);
INSERT INTO classes (id, tenant_id, "siteId", "academicYearId", "levelId", name, "updatedAt") VALUES ('10000000-0000-4000-8000-000000000001',
  'b0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001', '6e A', now());
INSERT INTO students (id, tenant_id, matricule, "firstName", "lastName", "updatedAt") VALUES
  ('20000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'E-0001', 'Élève', 'Un', now()),
  ('20000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', 'E-0002', 'Élève', 'Deux', now());
INSERT INTO enrollments (id, tenant_id, "studentId", "classId", "academicYearId") VALUES
  ('30000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001'),
  ('30000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001');
INSERT INTO subjects (id, tenant_id, code, name) VALUES ('40000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'MATH', 'Mathématiques');
INSERT INTO users (id, tenant_id, "passwordHash", "firstName", "lastName", "updatedAt")
  VALUES ('50000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'x', 'Direction', 'Essai', now());
COMMIT;
SQL
docker compose up -d --build > "$tmp/demarrage.log" 2>&1 || { cat "$tmp/demarrage.log"; exit 1; }
attendre_site 200 || { echo "Le site du banc ne répond pas."; docker compose ps; docker compose logs caddy | tail -n 20; exit 1; }
D=$(date -u +%Y-%m-%d_%H%M)
mkdir -p "$HOME/sauvegardes" "$HOME/copies-hors-serveur"
docker compose exec -T postgres pg_dump -U postgres erp > "$HOME/sauvegardes/base-$D.sql"
tar -czf "$HOME/sauvegardes/fichiers-$D.tar.gz" -C "$tmp/app" serveur.js
cp "$HOME/ecole/.env" "$HOME/sauvegardes/env-$D.txt"
: > "$HOME/copies-hors-serveur/cahiora-$D.tar.enc"
echo "  banc prêt : Caddy $(docker compose exec -T caddy caddy version | cut -d' ' -f1), commit essayé $court"
adm=""
for a in localhost 127.0.0.1 '[::1]'; do
  if docker compose exec -T caddy wget -q -T 3 -O /dev/null "http://$a:2019/config/" < /dev/null 2> /dev/null; then r=répond; else r="ne répond pas"; fi
  adm="$adm${adm:+, }$a $r"
done
echo "        interface d'administration de Caddy dans son conteneur : $adm"
echo "        Docker $(docker version --format '{{.Server.Version}}' 2> /dev/null), Compose $(docker compose version --short 2> /dev/null)"

echo "1. Avant la mise à jour, fenêtre fermée"
controle avant_fermee 0
contient avant_fermee "OK        fenêtre de maintenance fermée : les 9 adresses répondent normalement (200, sans l'en-tête de maintenance)"
contient avant_fermee "OK        code en ligne : fcb84eb"; contient avant_fermee "(51 tables sur 51,"; contient avant_fermee "Code de sortie : 0"
EMP=$(empreinte avant_fermee)
echo "        empreinte des données scolaires relevée : ${EMP:-AUCUNE}"
maintenance m_etat_fermee 0 etat
contient m_etat_fermee "Fenêtre de maintenance : FERMÉE."
echo "   Point 2 : réseau coupé, fenêtre fermée : ni « fermée » ni « ouverte »"
maintenance m_reseau_fermee 1 etat ESSAI_CURL="--connect-to ::127.0.0.1:9"
contient m_reseau_fermee "NON VÉRIFIÉE, adresse(s) injoignable(s) par le réseau (ce n'est ni une ouverture ni une fermeture)"
contient m_reseau_fermee "sur le serveur, Caddy répond 200 sans l'en-tête de maintenance"; sans m_reseau_fermee "FERMÉE."
echo "   Points 1 et 2 : site en panne (502) : jamais « fermée »"
docker compose stop web > /dev/null 2>&1
maintenance m_web_arrete 1 etat
contient m_web_arrete "502, en-tête de maintenance absent → ANOMALIE"; sans m_web_arrete "FERMÉE."
controle web_arrete 1
contient web_arrete "BLOQUANT  service(s) arrêté(s) : web"; contient web_arrete "BLOQUANT  réponses anormales du site (voir partie 3)"
contient web_arrete "Code de sortie : 1 (au moins un point BLOQUANT)"
docker compose start web > /dev/null 2>&1; attendre_site 200
echo "   Point 6 : une lecture qui échoue n'est jamais prise pour une absence"
controle panne_abonnements 1 PANNE='subscriptions'
contient panne_abonnements "BLOQUANT  lecture impossible : abonnements (DS-3)"; sans panne_abonnements "aucun abonnement en production"
controle panne_sms 1 PANNE='ILIKE ANY'
contient panne_sms "BLOQUANT  lecture impossible : SMS commerciaux"; sans panne_sms "OK        aucun SMS commercial"
controle panne_2fa 1 PANNE='FROM platform_admins'
contient panne_2fa "BLOQUANT  lecture impossible : comptes Super Admin et double authentification"; sans panne_2fa "double authentification active pour"
controle panne_migrations 1 PANNE='WHERE finished_at IS NULL'
contient panne_migrations "BLOQUANT  lecture impossible : migrations en échec"; sans panne_migrations "OK        migrations"
controle panne_sessions 1 PANNE='backend_xid'
contient panne_sessions "BLOQUANT  lecture impossible : requêtes en cours dans la base"
controle panne_tenants 1 PANNE='FROM tenants ORDER BY'
contient panne_tenants "BLOQUANT  liste des écoles illisible : leurs adresses ne sont pas contrôlées"; sans panne_tenants "OK        fenêtre de maintenance"
echo "   Point 5 : code de sortie 2 quand le contrôle est impossible"
controle panne_moment 2 PANNE="migration_name = '20261123090000_ajustements_g5'"
contient panne_moment "Migrations illisibles : contrôle impossible"
docker compose stop postgres > /dev/null 2>&1
controle base_arretee 2
contient base_arretee "La base ne répond pas : contrôle impossible"
docker compose start postgres > /dev/null 2>&1
for i in $(seq 1 30); do docker compose exec -T postgres pg_isready -U postgres -d erp > /dev/null 2>&1 && break; sleep 2; done
echo "   Point 3 : empreinte des données scolaires"
controle panne_empreinte 1 PANNE='query_to_xml'
contient panne_empreinte "BLOQUANT  empreinte des données scolaires NON CALCULÉE"; sans panne_empreinte "OK        empreinte"
sql 'ALTER TABLE rooms RENAME TO rooms_essai'
controle table_absente 1
contient table_absente "empreinte calculée sur 50 tables au lieu de 51 (absentes : rooms)"; sans table_absente "OK        empreinte"
sql 'ALTER TABLE rooms_essai RENAME TO rooms'
controle empreinte_identique 0 EMPREINTE="$EMP"
contient empreinte_identique "OK        empreinte des données scolaires identique à celle relevée avant : $EMP"
sql "UPDATE students SET \"lastName\" = 'Modifié' WHERE matricule = 'E-0002'"
controle empreinte_modifiee 1 EMPREINTE="$EMP"
contient empreinte_modifiee "DIFFÉRENTE de celle relevée avant ($EMP)"
sql "UPDATE students SET \"lastName\" = 'Deux' WHERE matricule = 'E-0002'"
controle empreinte_illisible 1 EMPREINTE=xyz
contient empreinte_illisible "empreinte attendue « xyz » illisible"
echo "   Point 4 : file des SMS non vide, site ouvert : normal"
ms=$(($(date +%s) * 1000 + 600000))
docker compose exec -T redis redis-cli HSET bull:notifications:meta opts.maxLenEvents 10000 > /dev/null
docker compose exec -T redis redis-cli ZADD bull:notifications:delayed $((ms * 4096)) essai-1 > /dev/null
controle file_hors_fenetre 0
contient file_hors_fenetre "OK        files de l'API : 1 envoi(s) en attente (normal, site ouvert"

echo "2. Ouverture de la fenêtre (maintenance.sh debut) avec une requête et une écriture déjà en cours"
curl -s -o "$tmp/lente.txt" -w '%{http_code}' --connect-to "::127.0.0.1:$P" http://saint-kisito.cahiora.test/api/v1/lent > "$tmp/lente.code" &
pid_lente=$!
docker compose exec -T postgres psql -q -U erp_app -d erp -c "BEGIN" -c "SELECT txid_current()" -c "SELECT pg_sleep(8)" -c "COMMIT" > /dev/null 2>&1 &
pid_ecriture=$!
sleep 1
maintenance m_debut_file 0 debut
contient m_debut_file "Fenêtre de maintenance : OUVERTE ET PROTÉGÉE."
contient m_debut_file "Requêtes en cours dans la base : aucune (celles d'avant la fenêtre sont terminées)."
wait "$pid_lente" "$pid_ecriture"
verifier "requête partie avant l'ouverture : terminée normalement ($(cat "$tmp/lente.code"))" test "$(cat "$tmp/lente.code")" = 200
controle file_fenetre 1 FENETRE=ouverte
contient file_fenetre "BLOQUANT  1 tâche(s) programmée(s) avant la fenêtre partiront encore (le dernier SMS différé vers"
docker compose exec -T redis redis-cli DEL bull:notifications:delayed bull:notifications:meta > /dev/null
maintenance m_debut 0 debut
contient m_debut "La fenêtre était déjà ouverte"; contient m_debut "Gardien déjà en marche"
contient m_debut "Fenêtre de maintenance : OUVERTE ET PROTÉGÉE. Toutes les adresses répondent 503 avec l'en-tête de maintenance"
controle ouverte 0 FENETRE=ouverte
contient ouverte "OK        fenêtre de maintenance ouverte et protégée : les 9 adresses répondent 503 avec l'en-tête de maintenance"
contient ouverte "OK        files de l'API vides (lecture réussie)"; contient ouverte "OK        seul Caddy est joignable de l'extérieur"
contient ouverte "OK        aucune écriture dans la base depuis l'ouverture de la fenêtre"
contient ouverte "OK        aucune écriture dans la base pendant ce contrôle"
contient ouverte "OK        aucune écriture ni requête de l'application en cours dans la base"
verifier "empreinte pendant la fenêtre = empreinte d'avant ($(empreinte ouverte))" test "$(empreinte ouverte)" = "$EMP"
verifier "écriture refusée : POST sur l'API → 503 avec l'en-tête" test "$(http POST http://saint-kisito.cahiora.test/api/v1/auth/login)" = "503 oui"
verifier "écriture refusée : PUT sur la console du Super Admin → 503" test "$(http PUT http://cahiora.test/api/v1/platform/tenants/x)" = "503 oui"
verifier "écriture refusée : POST vers un fichier fixe → 503" test "$(http POST http://saint-kisito.cahiora.test/_next/static/essai.js)" = "503 oui"
verifier "fichier fixe lu (GET) : 200" test "$(http GET http://saint-kisito.cahiora.test/_next/static/essai.js)" = "200 oui"
verifier "page d'une école sur son propre domaine → 503" test "$(http GET http://ecole-b.test/connexion)" = "503 oui"

echo "   Point 1 : maintenance partielle (une partie des adresses ne répond pas « maintenance »)"
node -e 'require("http").createServer((q, r) => { r.writeHead(Number(process.argv[1])); r.end(); }).listen(18192, "127.0.0.1")' 200 &
pids_annexes="$pids_annexes $!"; pid_200=$!
node -e 'require("http").createServer((q, r) => { r.writeHead(Number(process.argv[1])); r.end(); }).listen(18193, "127.0.0.1")' 503 &
pids_annexes="$pids_annexes $!"; sleep 1
controle partielle 1 FENETRE=ouverte ESSAI_CURL="--connect-to ecole-b.test:80:127.0.0.1:18192 --connect-to ::127.0.0.1:$P"
contient partielle "BLOQUANT  maintenance PARTIELLE : 7 adresse(s) sur 9 en maintenance"; sans partielle "OK        fenêtre de maintenance ouverte"
maintenance m_partielle 1 etat ESSAI_CURL="--connect-to ecole-b.test:80:127.0.0.1:18192 --connect-to ::127.0.0.1:$P"
contient m_partielle "Fenêtre de maintenance : PARTIELLE"; sans m_partielle "OUVERTE ET PROTÉGÉE"
controle partielle_503 1 FENETRE=ouverte ESSAI_CURL="--connect-to cahiora.test:80:127.0.0.1:18193 --connect-to ::127.0.0.1:$P"
contient partielle_503 "503, en-tête de maintenance absent → ANOMALIE"; contient partielle_503 "BLOQUANT  maintenance PARTIELLE : 6 adresse(s) sur 9"
echo "   Point 2 : réseau coupé, fenêtre ouverte : non vérifiée, jamais « fermée »"
controle reseau 1 FENETRE=ouverte ESSAI_CURL="--connect-to ::127.0.0.1:9"
contient reseau "9 adresse(s) injoignable(s) par le réseau"; contient reseau "sur le serveur, Caddy répond 503 avec l'en-tête de maintenance"
sans reseau "fenêtre de maintenance fermée"
maintenance m_reseau 1 etat ESSAI_CURL="--connect-to ::127.0.0.1:9"
contient m_reseau "NON VÉRIFIÉE, adresse(s) injoignable(s) par le réseau"; sans m_reseau "FERMÉE."; sans m_reseau "OUVERTE ET PROTÉGÉE"
echo "   Point 4 : Redis arrêté pendant la fenêtre"
docker compose stop redis > /dev/null 2>&1
controle redis_arrete 1 FENETRE=ouverte
contient redis_arrete "BLOQUANT  file des SMS ILLISIBLE pendant la fenêtre (Redis ne répond pas)"
docker compose start redis > /dev/null 2>&1
echo "   Point 7 : écritures et requêtes en cours, accès directs"
docker compose exec -T postgres psql -q -U erp_app -d erp -c "BEGIN" -c "SELECT txid_current()" -c "SELECT pg_sleep(25)" -c "COMMIT" > /dev/null 2>&1 &
pid_ecriture=$!; sleep 2
controle ecriture_en_cours 1 FENETRE=ouverte
contient ecriture_en_cours "pendant la fenêtre : 1 écriture(s) commencée(s)"
wait "$pid_ecriture"
docker compose exec -T postgres psql -q -U erp_app -d erp -c "SELECT pg_sleep(20)" > /dev/null 2>&1 &
pid_lecture=$!; sleep 2
controle requete_en_cours 1 FENETRE=ouverte
contient requete_en_cours "0 écriture(s) commencée(s) et 1 requête(s) de l'application en cours dans la base"
wait "$pid_lecture"
printf 'services:\n  api:\n    ports:\n      - "127.0.0.1:14000:4000"\n' > "$tmp/ports.yml"
COMPOSE_FILE="$COMPOSE_FILE:$tmp/ports.yml" docker compose up -d api > /dev/null 2>&1
controle port_api 1 FENETRE=ouverte COMPOSE_FILE="$COMPOSE_FILE:$tmp/ports.yml"
contient port_api "BLOQUANT  accès direct possible sans passer par Caddy (port publié) : api"
docker compose up -d api > /dev/null 2>&1
node -e 'require("net").createServer().listen(5432, "127.0.0.1")' &
pid_5432=$!; pids_annexes="$pids_annexes $pid_5432"; sleep 1
controle port_base 1 FENETRE=ouverte
contient port_base "BLOQUANT  le port 5432 (site, API, base ou Redis) est ouvert directement sur le serveur"
kill "$pid_5432"
sql 'UPDATE platform_admins SET name = name'; sleep 2
controle depuis_autre 0 FENETRE=ouverte
contient depuis_autre "ATTENTION écritures hors des tables de l'école depuis l'ouverture de la fenêtre : platform_admins 1"
sql "UPDATE students SET \"lastName\" = \"lastName\" WHERE matricule = 'E-0001'"; sleep 2
controle depuis_ecole 1 FENETRE=ouverte
contient depuis_ecole "BLOQUANT  ÉCRITURES dans les tables de l'école depuis l'ouverture de la fenêtre : students 1"
(for i in $(seq 1 60); do sql "UPDATE students SET \"lastName\" = \"lastName\" WHERE matricule = 'E-0001'"; sleep 0.5; done) > /dev/null 2>&1 &
pid_boucle=$!; pids_annexes="$pids_annexes $pid_boucle"
controle ecritures_pendant 1 FENETRE=ouverte
contient ecritures_pendant "BLOQUANT  ÉCRITURES dans les tables de l'école pendant ce contrôle, fenêtre ouverte : students"
kill "$pid_boucle" 2> /dev/null; wait "$pid_boucle" 2> /dev/null
echo "   Fermeture puis réouverture avant la mise à jour (configuration habituelle de fcb84eb, nouveaux compteurs)"
maintenance m_fin_avant 0 fin
contient m_fin_avant "Fenêtre de maintenance : FERMÉE."; contient m_fin_avant "Le site est de nouveau ouvert."
verifier "après « fin » : fragment enlevé du volume de Caddy" sh -c '! docker compose exec -T caddy test -e /data/cahiora-maintenance/actif.caddy'
maintenance m_debut2 0 debut
contient m_debut2 "Fenêtre de maintenance : OUVERTE ET PROTÉGÉE."
echo "   Point 8 : gardien arrêté, puis redémarrage de Caddy avant la mise à jour (ancienne configuration, sans le fragment)"
tuer_gardien
controle gardien_arrete 1 FENETRE=ouverte
contient gardien_arrete "fenêtre ouverte mais NON PROTÉGÉE contre un redémarrage de Caddy (fragment : oui ; gardien : arrêté)"
maintenance m_sans_gardien 1 etat
contient m_sans_gardien "OUVERTE mais NON PROTÉGÉE"
maintenance m_debut3 0 debut
contient m_debut3 "Gardien démarré"
sonder_pendant 20 "$tmp/redemarrage-avant.txt" &
pid_sonde=$!; sleep 1
docker compose restart caddy > /dev/null 2>&1
wait "$pid_sonde"
ouverts=$(grep -c '^200 non' "$tmp/redemarrage-avant.txt")
echo "        redémarrage de Caddy avant la mise à jour : $ouverts réponse(s) « site ouvert » sur $(grep -c . "$tmp/redemarrage-avant.txt") (une toutes les 0,2 s)"
verifier "fenêtre rétablie par le gardien (dernière réponse : $(tail -n 1 "$tmp/redemarrage-avant.txt"))" test "$(tail -n 1 "$tmp/redemarrage-avant.txt")" = "503 oui"
verifier "journal du gardien : « fenêtre RÉTABLIE »" grep -q "fenêtre RÉTABLIE" "$HOME/.cahiora-maintenance/journal.log"
maintenance m_apres_redemarrage 0 etat
contient m_apres_redemarrage "Fenêtre de maintenance : OUVERTE ET PROTÉGÉE."
controle ouverte_apres_redemarrage 0 FENETRE=ouverte
contient ouverte_apres_redemarrage "OK        fenêtre de maintenance ouverte et protégée"
tuer_gardien
docker compose restart caddy > /dev/null 2>&1; attendre_site 200
controle sans_gardien_redemarre 1 FENETRE=ouverte
contient sans_gardien_redemarre "BLOQUANT  fenêtre de maintenance attendue, mais le site est OUVERT (9 adresses répondent normalement)"
maintenance m_debut4 0 debut
contient m_debut4 "maintenance reposée"; contient m_debut4 "Fenêtre de maintenance : OUVERTE ET PROTÉGÉE."
EMP_FENETRE=$(empreinte ouverte_apres_redemarrage)

echo "3. Mise à jour pendant la fenêtre : code (git), images, migrations"
git -C "$HOME/ecole" checkout -q "$NOUVEAU" # comme « git pull --ff-only » de l'installateur
(cd "$HOME/ecole" && ./infra/postgres/role-plateforme.sh && ./infra/postgres/roles-groupes.sh) > /dev/null || { echo "Rôles de la base : échec."; exit 1; }
controle code_sans_migrations 1 FENETRE=ouverte
contient code_sans_migrations "alors que la base n'a pas les migrations de la mise à jour"
echo "   Point 8 : redémarrage de Caddy après la mise à jour du code (le Caddyfile importe le fragment)"
sonder_pendant 20 "$tmp/redemarrage-apres.txt" &
pid_sonde=$!; sleep 1
docker compose restart caddy > /dev/null 2>&1
wait "$pid_sonde"
verifier "aucune réponse « site ouvert » pendant le redémarrage ($(grep -c . "$tmp/redemarrage-apres.txt") requêtes)" test "$(grep -c '^200 non' "$tmp/redemarrage-apres.txt")" = 0
verifier "maintenance dès le redémarrage (dernière réponse : $(tail -n 1 "$tmp/redemarrage-apres.txt"))" test "$(tail -n 1 "$tmp/redemarrage-apres.txt")" = "503 oui"
# Comme installer-serveur.sh : commit exporté, puis docker compose up -d --build (tous les services).
CAHIORA_COMMIT="$NOUVEAU" BANC_DOCKERFILE_API=Dockerfile.api.apres BANC_DOCKERFILE_WEB=Dockerfile.web.apres docker compose up -d --build > "$tmp/maj.log" 2>&1
code_maj=$?
for s in api web; do
  id=$(docker compose ps -q "$s" 2> /dev/null)
  printf '%s %s %s\n' "$s" "${id:0:12}" "$(docker compose exec -T "$s" printenv CAHIORA_COMMIT < /dev/null 2> /dev/null | tr -d '\r')"
done > "$tmp/images.txt"
sed 's/^/        conteneur en marche, commit inscrit : /' "$tmp/images.txt"
inscrits=$(awk '{ print $3 }' "$tmp/images.txt" | sort -u | tr '\n' ' ')
verifier "mise à jour comme l'installateur (docker compose up -d --build) : API et site recréés depuis le commit essayé" \
  test "$code_maj:$inscrits" = "0:$NOUVEAU "
if [ "$code_maj:$inscrits" != "0:$NOUVEAU " ]; then
  sed 's/^/        | /' "$tmp/maj.log" | tail -n 60
  docker compose ps -a 2>&1 | sed 's/^/        | /'
fi
maintenance m_apres_images 0 etat
contient m_apres_images "Fenêtre de maintenance : OUVERTE ET PROTÉGÉE."
# shellcheck disable=SC2086
migrer $NOUVELLES || exit 1
echo "   Point 9 : commit réellement en marche"
export BANC_DOCKERFILE_API=Dockerfile.api.apres BANC_DOCKERFILE_WEB=Dockerfile.web.apres
controle apres_ok 0 ATTENDU="$NOUVEAU" EMPREINTE="$EMP" FENETRE=ouverte
contient apres_ok "OK        version en marche : commit $court, celui attendu ; l'API et le site ont été construits depuis ce commit"
contient apres_ok "OK        migrations : 30 appliquées, dont les 5 de la mise à jour, aucune en échec"
contient apres_ok "OK        empreinte des données scolaires identique à celle relevée avant : $EMP"
contient apres_ok "OK        les 2 établissement(s) sont en statut TEST : ni facturés, ni limités"
contient apres_ok "OK        fenêtre de maintenance ouverte et protégée"
verifier "empreinte relevée pendant la fenêtre, avant la migration = celle du début" test "$EMP_FENETRE" = "$EMP"
controle apres_court 0 ATTENDU="$(printf '%s' "$NOUVEAU" | cut -c1-12)" EMPREINTE="$EMP" FENETRE=ouverte
controle apres_sans 1 EMPREINTE="$EMP" FENETRE=ouverte
contient apres_sans "BLOQUANT  commit attendu non donné"
controle apres_autre 1 ATTENDU="$EN_LIGNE" EMPREINTE="$EMP" FENETRE=ouverte
contient apres_autre "code en ligne : $court au lieu du commit attendu $EN_LIGNE"
BANC_DOCKERFILE_WEB=Dockerfile.web.avant docker compose up -d --build web > /dev/null 2>&1
controle apres_site_ancien 1 ATTENDU="$NOUVEAU" EMPREINTE="$EMP" FENETRE=ouverte
contient apres_site_ancien "site en marche construit depuis « aucun commit inscrit » et non depuis $court"
CAHIORA_COMMIT="$EN_LIGNE" docker compose up -d --build web > /dev/null 2>&1
controle apres_site_autre 1 ATTENDU="$NOUVEAU" EMPREINTE="$EMP" FENETRE=ouverte
contient apres_site_autre "site en marche construit depuis « $EN_LIGNE » et non depuis $court"
CAHIORA_COMMIT="$NOUVEAU" docker compose up -d --build web > /dev/null 2>&1
echo "# modifié à la main" >> "$HOME/ecole/README.md"
controle apres_modifie 1 ATTENDU="$NOUVEAU" EMPREINTE="$EMP" FENETRE=ouverte
contient apres_modifie "des fichiers suivis ont été modifiés sur le serveur"
git -C "$HOME/ecole" checkout -q README.md
sql "UPDATE students SET \"firstName\" = 'Changé' WHERE matricule = 'E-0001'"
controle apres_empreinte 1 ATTENDU="$NOUVEAU" EMPREINTE="$EMP" FENETRE=ouverte
contient apres_empreinte "DIFFÉRENTE de celle relevée avant ($EMP)"
sql "UPDATE students SET \"firstName\" = 'Élève' WHERE matricule = 'E-0001'"

echo "4. Fermeture de la fenêtre après la mise à jour"
maintenance m_fin 0 fin
contient m_fin "Configuration habituelle du code rechargée dans Caddy ; fragment enlevé."; contient m_fin "Le site est de nouveau ouvert."
contient m_fin "fenêtre RÉTABLIE"
controle apres_fermee 0 ATTENDU="$NOUVEAU" EMPREINTE="$EMP"
contient apres_fermee "OK        fenêtre de maintenance fermée"; contient apres_fermee "Code de sortie : 0 (aucun point bloquant)"
controle apres_fermee_attendue 1 ATTENDU="$NOUVEAU" FENETRE=ouverte
contient apres_fermee_attendue "BLOQUANT  fenêtre de maintenance attendue, mais le site est OUVERT"
maintenance m_reseau_apres 1 etat ESSAI_CURL="--connect-to ::127.0.0.1:9"
contient m_reseau_apres "NON VÉRIFIÉE"; sans m_reseau_apres "FERMÉE."
docker compose restart caddy > /dev/null 2>&1; attendre_site 200
maintenance m_redemarrage_ferme 0 etat
contient m_redemarrage_ferme "Fenêtre de maintenance : FERMÉE."
docker compose stop caddy > /dev/null 2>&1
maintenance m_caddy_arrete 1 etat
contient m_caddy_arrete "Caddy ne répond pas du tout"; sans m_caddy_arrete "FERMÉE."
maintenance m_debut_sans_caddy 2 debut
contient m_debut_sans_caddy "ÉCHEC : le service caddy ne tourne pas. Rien n'a changé."
controle caddy_arrete 1 ATTENDU="$NOUVEAU"
contient caddy_arrete "BLOQUANT  Caddy ne répond pas du tout (arrêté ou en train de redémarrer)"
docker compose start caddy > /dev/null 2>&1; attendre_site 200
maintenance m_usage 2 autre
contient m_usage "Usage : maintenance.sh debut | etat | fin"

echo "5. « localhost » ne mène pas à l'interface d'administration de Caddy (cas trouvé sur GitHub, où il désignait ::1)"
# Caddy écoute sur 127.0.0.1:2019, mais « localhost » désigne 127.0.0.2 dans son conteneur : le wget du conteneur,
# qui n'essaie qu'une adresse, n'atteint plus l'interface par « localhost ».
printf '127.0.0.2\tlocalhost\n' > "$tmp/hosts-caddy"
printf 'services:\n  caddy:\n    environment:\n      CADDY_ADMIN: "127.0.0.1:2019"\n    volumes:\n      - "%s:/etc/hosts:ro"\n' "$tmp/hosts-caddy" > "$tmp/admin.yml"
export COMPOSE_FILE="$COMPOSE_FILE:$tmp/admin.yml"
docker compose up -d caddy > /dev/null 2>&1; attendre_site 200
verifier "dans le conteneur de Caddy, « localhost » ne mène pas à l'interface d'administration" \
  sh -c '! docker compose exec -T caddy wget -q -T 3 -O /dev/null http://localhost:2019/config/ < /dev/null 2> /dev/null'
maintenance m_admin_etat 0 etat
contient m_admin_etat "Fenêtre de maintenance : FERMÉE."
controle admin_fermee 0 ATTENDU="$NOUVEAU" EMPREINTE="$EMP"
contient admin_fermee "OK        fenêtre de maintenance fermée"
maintenance m_admin_debut 0 debut
contient m_admin_debut "Fenêtre de maintenance : OUVERTE ET PROTÉGÉE."
controle admin_ouverte 0 ATTENDU="$NOUVEAU" EMPREINTE="$EMP" FENETRE=ouverte
contient admin_ouverte "OK        fenêtre de maintenance ouverte et protégée"
maintenance m_admin_fin 0 fin
contient m_admin_fin "Le site est de nouveau ouvert."
echo
echo "Bilan : $ok vérifications réussies, $ko en échec."
[ "$ko" = 0 ]
