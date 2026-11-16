#!/usr/bin/env bash
# Essais de copie-hors-serveur.sh sans serveur : vraie base PostgreSQL d'essai (sans Docker), openssl et tar réels.
# Vérifie que :
#   - une copie se prépare, se chiffre, se relit (--verifier) et se déchiffre (--extraire) avec la bonne phrase secrète ;
#   - sans la phrase, la copie est illisible : le .env n'y apparaît pas en clair ;
#   - une phrase incorrecte, trop courte ou différente à la confirmation ne produit aucune copie ;
#   - une copie de la base incomplète ou qui ne se restaure pas est refusée, sans laisser de base temporaire ;
#   - une sauvegarde trop ancienne ou incomplète est signalée ;
#   - seules les 4 copies les plus récentes sont gardées.
# Seules les bases essai_copie_source et erp_copie_verif sont créées, puis supprimées.
#
# Usage : PGHOST=… PGPASSWORD=… bash tools/qualite/copie-hors-serveur/essais-copie.sh [chemin de copie-hors-serveur.sh]
set -euo pipefail

racine="$(cd "$(dirname "$0")/../../.." && pwd)"
origine="$(cd "$(dirname "${1:-$racine/copie-hors-serveur.sh}")" && pwd)/$(basename "${1:-copie-hors-serveur.sh}")"
tmp="$(mktemp -d)"
source_db=essai_copie_source
admin() { PGOPTIONS="-c client_min_messages=warning" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"; }
trap 'admin -c "DROP DATABASE IF EXISTS $source_db" -c "DROP DATABASE IF EXISTS erp_copie_verif" > /dev/null 2>&1 || true; rm -rf "$tmp"' EXIT

# Dossier du code simulé : le script et un .env qui donne l'adresse du serveur.
mkdir -p "$tmp/ecole"
cp "$origine" "$tmp/ecole/copie-hors-serveur.sh"
chmod +x "$tmp/ecole/copie-hors-serveur.sh"
printf 'PLATFORM_DOMAIN=exemple.invalid\n' > "$tmp/ecole/.env"
script="$tmp/ecole/copie-hors-serveur.sh"
export CAHIORA_ESSAI_LOCAL=1 HOME="$tmp/maison"
export SAUVEGARDE_DIR="$HOME/sauvegardes" COPIES_DIR="$HOME/copies-hors-serveur"
mkdir -p "$SAUVEGARDE_DIR"

# Base d'essai : même propriétaire que sur le serveur, une table protégée par RLS, 302 lignes.
admin -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_owner') THEN CREATE ROLE erp_owner; END IF; END \$\$" \
  -c "DROP DATABASE IF EXISTS $source_db" -c "CREATE DATABASE $source_db OWNER erp_owner"
psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$source_db" <<'SQL'
SET ROLE erp_owner;
CREATE TABLE ecoles (id serial PRIMARY KEY, nom text NOT NULL);
CREATE TABLE eleves (id serial PRIMARY KEY, ecole_id int NOT NULL REFERENCES ecoles, nom text NOT NULL);
ALTER TABLE eleves ENABLE ROW LEVEL SECURITY;
CREATE POLICY eleves_ecole ON eleves USING (ecole_id = current_setting('app.ecole', true)::int);
INSERT INTO ecoles (nom) VALUES ('École A'), ('École B');
INSERT INTO eleves (ecole_id, nom) SELECT 1 + i % 2, 'Élève ' || i FROM generate_series(1, 300) i;
SQL

sauvegarde() { # sauvegarde <date> : base, fichiers envoyés et .env, comme sauvegarder.sh
  local d="$1"
  pg_dump -U postgres "$source_db" > "$SAUVEGARDE_DIR/base-$d.sql"
  mkdir -p "$tmp/envoyes"
  echo "bulletin $d" > "$tmp/envoyes/bulletin.pdf"
  tar -C "$tmp/envoyes" -czf "$SAUVEGARDE_DIR/fichiers-$d.tar.gz" .
  printf 'APP_ENCRYPTION_KEY=cle-secrete-essai-%s\nPLATFORM_DOMAIN=exemple.invalid\n' "$d" > "$SAUVEGARDE_DIR/env-$d.txt"
}
oublier() { rm -f "$SAUVEGARDE_DIR"/*-"$1".*; } # oublier <date> : retire une sauvegarde

PHRASE="phrase de test 2026"
echecs=0
verifier() { # verifier <attendu> <commande...>
  local attendu="$1"; shift
  if "$@"; then echo "  ok : $attendu"; else echo "  ÉCHEC : $attendu"; echecs=$((echecs + 1)); fi
}
lancer() { # lancer <lignes tapées> [options...] : lance le script, garde sa sortie et son code
  local saisie="$1"; shift
  set +e
  printf '%s' "$saisie" | "$script" "$@" > "$tmp/sortie" 2>&1
  code=$?
  set -e
}
contient() { grep -qF -- "$1" "$tmp/sortie"; }
sans() { ! grep -qF -- "$1" "$tmp/sortie"; }
copies() { find "$COPIES_DIR" -maxdepth 1 -name 'cahiora-*.tar.enc' 2> /dev/null | wc -l; }
aucune_base_temporaire() { test "$(psql -X -At -U postgres -d postgres -c "SELECT count(*) FROM pg_database WHERE datname = 'erp_copie_verif'")" = 0; }
aucun_temporaire() { ! find "$COPIES_DIR" -name '*.tmp' 2> /dev/null | grep -q .; }
deux_fois() { printf '%s\n%s\n' "$1" "$1"; }

echo "1. Copie de la semaine"
sauvegarde 2026-11-16_02h00
lancer "$(deux_fois "$PHRASE")"
archive="$COPIES_DIR/cahiora-2026-11-16_02h00.tar.enc"
verifier "terminée sans erreur" test "$code" = 0
verifier "base restaurée dans une base temporaire" contient "Base restaurée sans erreur : 2 tables et 302 lignes"
verifier "base temporaire supprimée" aucune_base_temporaire
verifier "copie relue" contient "Copie RELUE"
verifier "copie présente" test -s "$archive"
verifier "empreinte exacte" bash -c "cd '$COPIES_DIR' && sha256sum --status -c cahiora-2026-11-16_02h00.tar.enc.sha256"
verifier "copie lisible par son seul propriétaire" test "$(stat -c %a "$archive")" = 600
verifier "dossier des copies fermé aux autres comptes" test "$(stat -c %a "$COPIES_DIR")" = 700
verifier "le .env n'apparaît pas en clair" bash -c "! grep -aq 'cle-secrete-essai' '$archive'"
verifier "ce n'est pas une archive lisible sans la phrase" bash -c "! tar -tf '$archive' > /dev/null 2>&1"
verifier "commande de téléchargement avec l'adresse du serveur" contient "scp root@exemple.invalid:$archive"
verifier "contrôle automatique de l'empreinte sur l'ordinateur" contient "Get-FileHash"
verifier "la phrase n'est pas affichée" sans "$PHRASE"

echo "2. Relecture et extraction (exercice de restauration)"
lancer "$PHRASE"$'\n' --verifier "$archive"
verifier "bonne phrase : copie relue" test "$code" = 0
lancer "mauvaise phrase 123"$'\n' --verifier "$archive"
verifier "mauvaise phrase : refus" test "$code" != 0
verifier "mauvaise phrase : message clair" contient "phrase secrète incorrecte"
lancer "$PHRASE"$'\n' --extraire "$archive"
extrait="$HOME/copie-extraite-2026-11-16_02h00"
verifier "extraction terminée" test "$code" = 0
for f in base-2026-11-16_02h00.sql fichiers-2026-11-16_02h00.tar.gz env-2026-11-16_02h00.txt; do
  verifier "$f identique à la sauvegarde" cmp -s "$extrait/$f" "$SAUVEGARDE_DIR/$f"
done
lancer "$PHRASE"$'\n' --extraire "$archive"
verifier "pas d'écrasement d'une extraction précédente" test "$code" != 0

echo "3. Phrases refusées : aucune copie faite"
sauvegarde 2026-11-17_02h00
lancer "$(printf '%s\n%s\n' "$PHRASE" "autre phrase 2026")"
verifier "phrases différentes : refus" contient "les deux phrases diffèrent"
lancer "$(deux_fois "trop courte")"
verifier "phrase trop courte : refus" contient "phrase secrète trop courte"
verifier "aucune nouvelle copie" test "$(copies)" = 1
verifier "aucun fichier temporaire" aucun_temporaire

echo "4. Sauvegarde abîmée ou absente : refus"
head -n -40 "$SAUVEGARDE_DIR/base-2026-11-17_02h00.sql" > "$tmp/coupee" && mv "$tmp/coupee" "$SAUVEGARDE_DIR/base-2026-11-17_02h00.sql"
lancer "$(deux_fois "$PHRASE")"
verifier "copie de la base coupée : refus" contient "copie de la base incomplète"
sauvegarde 2026-11-17_02h00
sed -i '0,/^CREATE TABLE/s//CREATE TABLEAU/' "$SAUVEGARDE_DIR/base-2026-11-17_02h00.sql"
lancer "$(deux_fois "$PHRASE")"
verifier "copie de la base qui ne se restaure pas : refus" contient "ne se restaure pas"
verifier "base temporaire supprimée après l'échec" aucune_base_temporaire
sauvegarde 2026-11-17_02h00
rm "$SAUVEGARDE_DIR/fichiers-2026-11-17_02h00.tar.gz"
lancer "$(deux_fois "$PHRASE")"
verifier "fichiers envoyés absents : refus" contient "fichiers-2026-11-17_02h00.tar.gz manque"
verifier "toujours une seule copie" test "$(copies)" = 1
oublier 2026-11-17_02h00
touch -d '3 days ago' "$SAUVEGARDE_DIR"/*
lancer "$(deux_fois "$PHRASE")"
verifier "sauvegarde de plus de 26 heures : signalée" contient "aucune sauvegarde de moins de 26 heures"

echo "5. Seules les 4 copies les plus récentes sont gardées"
for jour in 18 19 20 21; do
  sauvegarde "2026-11-${jour}_02h00"
  lancer "$(deux_fois "$PHRASE")"
  test "$code" = 0 || { cat "$tmp/sortie"; echecs=$((echecs + 1)); }
done
verifier "4 copies" test "$(copies)" = 4
verifier "la plus ancienne est retirée, avec son empreinte" test ! -e "$archive" -a ! -e "$archive.sha256"
lancer "" --liste
verifier "la liste montre la plus récente et son empreinte" contient "cahiora-2026-11-21_02h00.tar.enc"
lancer "" --inconnue
verifier "option inconnue : refus" test "$code" != 0

echo ""
if [ "$echecs" = 0 ]; then echo "Tous les essais de la copie hors du serveur sont réussis."; else echo "$echecs vérification(s) en échec."; exit 1; fi
