#!/usr/bin/env bash
# Sauvegarde du site (base de données + fichiers envoyés + clés du .env).
#
#   ./sauvegarder.sh                 fait une sauvegarde maintenant
#   ./sauvegarder.sh --auto          sauvegarde automatique chaque nuit à 2 h
#   ./sauvegarder.sh --arreter-auto  arrête la sauvegarde automatique
#   ./sauvegarder.sh --liste         montre les sauvegardes présentes
#
# Les copies vont dans ~/sauvegardes (ou SAUVEGARDE_DIR). Les GARDER copies
# les plus récentes sont conservées (14 par défaut), les plus anciennes sont
# effacées. Ce script ne fait que LIRE le site : il ne modifie aucune donnée.
# Copier ensuite les fichiers sur un ordinateur (scp ou WinSCP).
set -euo pipefail
export PATH="$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

ICI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOSSIER="${SAUVEGARDE_DIR:-$HOME/sauvegardes}"
GARDER="${GARDER:-14}"
HEURE_AUTO="${HEURE_AUTO:-2}"
MARQUE="# sauvegarde-auto-cahiora"

erreur() { echo "ERREUR : $*" >&2; exit 1; }

liste() {
  [ -d "$DOSSIER" ] || { echo "Aucune sauvegarde pour l'instant ($DOSSIER n'existe pas)."; return; }
  echo "Sauvegardes dans $DOSSIER :"
  ls -lh "$DOSSIER" | grep -E 'base-|fichiers-|env-' || echo "(aucune)"
}

installer_auto() {
  command -v crontab >/dev/null || erreur "la commande crontab est absente (apt-get install -y cron)."
  local ligne="0 $HEURE_AUTO * * * SAUVEGARDE_DIR='$DOSSIER' GARDER='$GARDER' '$ICI/sauvegarder.sh' >> '$DOSSIER/journal.log' 2>&1 $MARQUE"
  mkdir -p "$DOSSIER" && chmod 700 "$DOSSIER"
  { crontab -l 2>/dev/null | grep -v -F "$MARQUE" || true; echo "$ligne"; } | crontab -
  echo "Sauvegarde automatique activée : chaque nuit à ${HEURE_AUTO} h (heure du serveur)."
  echo "Copies dans $DOSSIER, compte rendu dans $DOSSIER/journal.log."
}

arreter_auto() {
  { crontab -l 2>/dev/null | grep -v -F "$MARQUE" || true; } | crontab -
  echo "Sauvegarde automatique arrêtée. Les copies existantes sont conservées."
}

sauvegarder() {
  cd "$ICI"
  [ -f .env ] || erreur "fichier .env introuvable dans $ICI."
  docker compose ps --status running --services 2>/dev/null | grep -qx postgres \
    || erreur "la base de données (service postgres) ne tourne pas."

  mkdir -p "$DOSSIER" && chmod 700 "$DOSSIER"
  exec 9>"$DOSSIER/.verrou"
  flock -n 9 || erreur "une autre sauvegarde est déjà en cours."

  local D; D="$(date +%Y-%m-%d_%Hh%M)"
  local base="$DOSSIER/base-$D.sql" fichiers="$DOSSIER/fichiers-$D.tar.gz" env="$DOSSIER/env-$D.txt"
  umask 077
  echo "[$(date '+%F %T')] Sauvegarde $D…"

  docker compose exec -T postgres pg_dump -U postgres erp > "$base.tmp"
  grep -q "PostgreSQL database dump complete" "$base.tmp" || { rm -f "$base.tmp"; erreur "copie de la base incomplète."; }
  mv "$base.tmp" "$base"

  if docker compose ps --status running --services | grep -qx api; then
    docker compose exec -T api sh -c 'cd "${STORAGE_DIR:-/repo/apps/api/storage}" && tar czf - .' > "$fichiers.tmp"
    gzip -t "$fichiers.tmp" || { rm -f "$fichiers.tmp"; erreur "copie des fichiers incomplète."; }
    mv "$fichiers.tmp" "$fichiers"
  else
    echo "Attention : le service api ne tourne pas, fichiers envoyés NON copiés." >&2
  fi

  cp .env "$env"

  # On ne garde que les $GARDER sauvegardes les plus récentes.
  local anciennes
  anciennes="$(ls -1 "$DOSSIER" | sed -n 's/^base-\(.*\)\.sql$/\1/p' | sort -r | tail -n +"$((GARDER + 1))")"
  for a in $anciennes; do
    rm -f "$DOSSIER/base-$a.sql" "$DOSSIER/fichiers-$a.tar.gz" "$DOSSIER/env-$a.txt"
  done

  echo "Sauvegarde terminée :"
  ls -lh "$base" "$fichiers" "$env" 2>/dev/null
  echo "Place libre sur le serveur : $(df -h "$DOSSIER" | awk 'NR==2 {print $4}')"
}

case "${1:-}" in
  "") sauvegarder ;;
  --auto) installer_auto ;;
  --arreter-auto) arreter_auto ;;
  --liste) liste ;;
  -h|--help|--aide) sed -n '2,12p' "$0" ;;
  *) erreur "option inconnue : $1 (voir ./sauvegarder.sh --aide)" ;;
esac
