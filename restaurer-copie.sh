#!/bin/sh
# RETOUR ARRIÈRE après une mise à jour : remplace TOUTE la base par une copie faite avant (sauvegarder-avant-maj.sh).
# Tout ce qui a été saisi sur le site depuis cette copie est perdu. À lancer seulement après accord.
# Avant de remplacer, l'état actuel est copié dans ~/copie-avant-restauration-AAAAMMJJ-HHMM.sql.
# L'API et le site sont arrêtés pendant la restauration ; il faut ensuite remettre l'ancien code, que le script indique
# (version notée par sauvegarder-avant-maj.sh dans …-HHMM.commit) : git checkout <ce commit> && ./installer-serveur.sh
#
# Sur le serveur (Terminal hPanel) : cd ~/ecole && ./restaurer-copie.sh ~/copie-avant-g5-AAAAMMJJ-HHMM.sql
set -eu
if [ "${CAHIORA_ESSAI_LOCAL:-}" = 1 ]; then
  # Essais sur un ordinateur de développement seulement (base de test, sans Docker).
  pg() { "$@"; }; dc() { :; }
else
  cd "$HOME/ecole" 2>/dev/null || { echo "Dossier ~/ecole introuvable"; exit 1; }
  pg() { docker compose exec -T postgres "$@"; }; dc() { docker compose "$@"; }
fi
BASE=${BASE:-erp}
copie=${1:-}
[ -n "$copie" ] || { echo "Indiquez la copie à restaurer, par exemple : ./restaurer-copie.sh ~/copie-avant-g5-20261116-0900.sql"; exit 1; }
[ -s "$copie" ] || { echo "Copie introuvable ou vide : $copie"; exit 1; }
tail -n 20 "$copie" | grep -q "PostgreSQL database dump complete" || { echo "Copie incomplète (fin absente) : $copie. Rien n'a été changé."; exit 1; }

printf 'La base %s va être REMPLACÉE par %s. Tapez RESTAURER pour continuer : ' "$BASE" "$copie"
read -r reponse
[ "$reponse" = RESTAURER ] || { echo "Abandon : rien n'a été changé."; exit 1; }

etat="$HOME/copie-avant-restauration-$(date +%Y%m%d-%H%M).sql"
umask 077
if ! pg pg_dump -U postgres "$BASE" > "$etat" </dev/null || ! tail -n 20 "$etat" | grep -q "PostgreSQL database dump complete"; then
  echo "La copie de l'état actuel a échoué : rien n'a été changé."; exit 1
fi
echo "État actuel copié : $etat"

dc stop api web
pg psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$BASE' AND pid <> pg_backend_pid()" \
  -c "DROP DATABASE $BASE" -c "CREATE DATABASE $BASE OWNER erp_owner" </dev/null > /dev/null
ancien=$(cat "${copie%.sql}.commit" 2>/dev/null || echo "<commit d'avant la mise à jour>")
if pg psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$BASE" < "$copie" > /dev/null; then
  echo "Base restaurée depuis $copie."
  echo "Étape suivante : remettre le code d'avant la mise à jour, puis vérifier :"
  echo "  git checkout $ancien && ./installer-serveur.sh"
else
  echo "ÉCHEC de la restauration. L'API et le site restent arrêtés. L'état d'avant est dans $etat."
  exit 1
fi
