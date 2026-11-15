#!/bin/sh
# Sauvegarde avant une mise à jour, VÉRIFIÉE :
# 1. copie de la base (pg_dump) dans ~/copie-avant-<nom>-AAAAMMJJ-HHMM.sql, refusée si elle est incomplète ;
# 2. copie du .env à côté (…-HHMM.env), puis fichiers envoyés par sauvegarder.sh s'il est présent
#    (une erreur de sauvegarder.sh est signalée, sans arrêter la vérification de la copie de la base) ;
# 3. la copie est restaurée dans une base TEMPORAIRE (erp_verif), comparée table par table avec la base en ligne,
#    puis la base temporaire est supprimée.
# La base en ligne n'est jamais modifiée et le site reste ouvert.
#
# Sur le serveur (Terminal hPanel) : cd ~/ecole && ./sauvegarder-avant-maj.sh g5
set -eu
if [ "${CAHIORA_ESSAI_LOCAL:-}" = 1 ]; then
  # Essais sur un ordinateur de développement seulement (base de test, sans Docker).
  pg() { "$@"; }
else
  cd "$HOME/ecole" 2>/dev/null || { echo "Dossier ~/ecole introuvable"; exit 1; }
  pg() { docker compose exec -T postgres "$@"; }
fi
BASE=${BASE:-erp}
VERIF="${BASE}_verif"
nom=${1:-maj}
copie="$HOME/copie-avant-$nom-$(date +%Y%m%d-%H%M).sql"

echo "1. Copie de la base $BASE..."
umask 077
if ! pg pg_dump -U postgres "$BASE" > "$copie.tmp" </dev/null || ! tail -n 20 "$copie.tmp" | grep -q "PostgreSQL database dump complete"; then
  rm -f "$copie.tmp"; echo "ÉCHEC : copie incomplète, rien n'est gardé. Ne pas faire la mise à jour."; exit 1
fi
mv "$copie.tmp" "$copie"
echo "   $copie ($(du -h "$copie" | cut -f1))"

echo "2. .env et fichiers envoyés..."
if [ -f .env ]; then cp .env "${copie%.sql}.env" && echo "   ${copie%.sql}.env"; fi
if [ -x ./sauvegarder.sh ]; then
  ./sauvegarder.sh </dev/null || echo "   ATTENTION : sauvegarder.sh s'est arrêté sur une erreur (voir ci-dessus). La copie de la base de l'étape 1 reste valable."
else
  echo "   sauvegarder.sh absent : fichiers envoyés NON copiés (ils ne changent pas avec la mise à jour)"
fi

echo "3. Vérification de la copie (base temporaire $VERIF)..."
LIGNES="SELECT table_name || ' ' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I', table_name), false, true, '')))[1]::text
  FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name"
pg psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -c "DROP DATABASE IF EXISTS $VERIF" -c "CREATE DATABASE $VERIF OWNER erp_owner" </dev/null
if ! pg psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$VERIF" < "$copie" > /dev/null; then
  pg psql -X -q -U postgres -d postgres -c "DROP DATABASE IF EXISTS $VERIF" </dev/null
  echo "ÉCHEC : la copie ne se restaure pas. Ne pas faire la mise à jour."; exit 1
fi
en_ligne=$(pg psql -X -At -U postgres -d "$BASE" -c "$LIGNES" </dev/null)
restauree=$(pg psql -X -At -U postgres -d "$VERIF" -c "$LIGNES" </dev/null)
pg psql -X -q -U postgres -d postgres -c "DROP DATABASE $VERIF" </dev/null
tables=$(printf '%s\n' "$restauree" | grep -c .)
lignes=$(printf '%s\n' "$restauree" | awk '{s += $2} END {print s + 0}')
if [ "$en_ligne" = "$restauree" ]; then
  echo "   Copie VÉRIFIÉE : restaurée sans erreur, $tables tables et $lignes lignes, identiques à la base en ligne."
else
  echo "   Copie restaurée, mais des tables ont changé depuis la copie (activité sur le site ?) :"
  printf '%s\n' "$en_ligne" > "$HOME/.lignes-en-ligne"; printf '%s\n' "$restauree" > "$HOME/.lignes-copie"
  diff "$HOME/.lignes-copie" "$HOME/.lignes-en-ligne" | grep '^[<>]' | sed 's/^</   copie   :/; s/^>/   en ligne :/'
  rm -f "$HOME/.lignes-en-ligne" "$HOME/.lignes-copie"
fi
echo "Fin. Copie à garder pour un retour arrière : $copie"
