#!/usr/bin/env bash
# Copie de la semaine HORS DU SERVEUR : chiffrée, vérifiée, prête à télécharger sur un ordinateur.
#
#   cd ~/ecole && ./copie-hors-serveur.sh           prépare la copie (demande deux fois la phrase secrète)
#   ./copie-hors-serveur.sh --liste                 montre les copies prêtes à télécharger, avec leur empreinte
#   ./copie-hors-serveur.sh --verifier FICHIER      relit une copie avec sa phrase secrète (exercice de restauration)
#   ./copie-hors-serveur.sh --extraire FICHIER      déchiffre une copie dans ~/copie-extraite-<date>, sans toucher au site
#
# 1. Prend la dernière sauvegarde de la nuit (base, fichiers envoyés, .env) dans ~/sauvegardes, ou en fait une
#    (./sauvegarder.sh) si la dernière a plus de 26 heures.
# 2. Vérifie la copie de la base : fin présente, puis restauration dans une base TEMPORAIRE (erp_copie_verif),
#    supprimée ensuite. La base en ligne n'est jamais modifiée et le site reste ouvert.
# 3. Réunit les trois fichiers dans ~/copies-hors-serveur/cahiora-<date>.tar.enc, chiffré en AES-256 avec une clé
#    tirée de la phrase secrète (PBKDF2). La phrase n'est écrite nulle part.
# 4. Déchiffre le résultat pour vérifier qu'il se relit, note son empreinte SHA-256 et garde les 4 copies les plus récentes.
# 5. Affiche les commandes à taper dans PowerShell, SUR L'ORDINATEUR, pour la télécharger et la contrôler.
# Sans la phrase secrète, une copie est illisible : gardez-la en deux endroits sûrs, jamais dans un message.
set -euo pipefail
export PATH="$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

ICI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SAUV="${SAUVEGARDE_DIR:-$HOME/sauvegardes}"
DEST="${COPIES_DIR:-$HOME/copies-hors-serveur}"
GARDER="${GARDER:-4}"
AGE_MAX_HEURES="${AGE_MAX_HEURES:-26}"
BASE="${BASE:-erp}"
VERIF="${BASE}_copie_verif"
CHIFFRE=(-aes-256-cbc -pbkdf2 -iter 600000 -md sha256)
FIN_DE_COPIE="PostgreSQL database dump complete"

erreur() { echo "ÉCHEC : $*" >&2; exit 1; }

if [ "${CAHIORA_ESSAI_LOCAL:-}" = 1 ]; then
  # Essais sur un ordinateur de développement seulement (base de test, sans Docker).
  pg() { "$@"; }
else
  pg() { (cd "$ICI" && docker compose exec -T postgres "$@"); }
fi

temporaire=""
nettoyer() {
  [ -t 0 ] && stty echo 2>/dev/null
  [ -z "$temporaire" ] || rm -f "$temporaire"
  true
}
trap nettoyer EXIT
trap 'exit 130' INT TERM

phrase=""
lire_phrase() { # lire_phrase <invite> : lit une ligne sans l'afficher à l'écran
  local p=""
  if [ -t 0 ]; then
    stty -echo # avant l'invite : rien de ce qui est tapé ensuite ne peut s'afficher
    printf '%s' "$1" >&2
    IFS= read -r p || true
    stty echo
    echo >&2
  else
    printf '%s' "$1" >&2
    IFS= read -r p || true
  fi
  printf '%s' "$p"
}

chiffrer() { CAHIORA_PHRASE="$phrase" openssl enc -e "${CHIFFRE[@]}" -salt -pass env:CAHIORA_PHRASE; }
dechiffrer() { CAHIORA_PHRASE="$phrase" openssl enc -d "${CHIFFRE[@]}" -pass env:CAHIORA_PHRASE; }
# copie_complete : la copie de la base (lue sur l'entrée) se termine par la marque de fin de pg_dump.
copie_complete() { tail -n 20 | grep -cF "$FIN_DE_COPIE" > /dev/null; }

liste() {
  [ -d "$DEST" ] || { echo "Aucune copie pour l'instant ($DEST n'existe pas)."; return; }
  local f n=0
  for f in "$DEST"/cahiora-*.tar.enc; do
    [ -e "$f" ] || continue
    n=$((n + 1))
    echo "$(basename "$f")  $(du -h "$f" | cut -f1)  empreinte $(tr 'a-f' 'A-F' < "$f.sha256" 2>/dev/null | cut -d' ' -f1)"
  done
  [ "$n" -gt 0 ] || echo "Aucune copie dans $DEST."
}

# verifier_archive <fichier> : la copie se déchiffre, contient la base complète, les fichiers envoyés et le .env.
verifier_archive() {
  local archive="$1" contenu
  contenu=$(dechiffrer < "$archive" 2>/dev/null | tar -tf - 2>/dev/null) \
    || erreur "copie illisible : phrase secrète incorrecte, ou fichier abîmé ($archive)"
  grep -q '^base-.*\.sql$' <<< "$contenu" || erreur "la copie ne contient pas la base"
  grep -q '^fichiers-.*\.tar\.gz$' <<< "$contenu" || erreur "la copie ne contient pas les fichiers envoyés"
  grep -q '^env-.*\.txt$' <<< "$contenu" || erreur "la copie ne contient pas le .env"
  dechiffrer < "$archive" | tar -xOf - --wildcards 'base-*.sql' | copie_complete \
    || erreur "la base contenue dans la copie est incomplète"
}

demander_copie() { # demander_copie <option> <fichier>
  [ -s "${2:-}" ] || erreur "indiquez la copie : ./copie-hors-serveur.sh $1 ~/copies-hors-serveur/cahiora-….tar.enc"
  command -v openssl > /dev/null || erreur "la commande openssl est absente"
  phrase=$(lire_phrase "Phrase secrète de cette copie : ")
  verifier_archive "$2"
}

case "${1:-}" in
  --liste) liste; exit 0 ;;
  --verifier)
    demander_copie --verifier "${2:-}"
    echo "Copie RELUE : elle se déchiffre et contient la base complète, les fichiers envoyés et le .env."
    exit 0 ;;
  --extraire)
    demander_copie --extraire "${2:-}"
    nom=$(basename "$2" .tar.enc)
    dossier="$HOME/copie-extraite-${nom#cahiora-}"
    [ ! -e "$dossier" ] || erreur "$dossier existe déjà : renommez-le ou supprimez-le, puis recommencez"
    umask 077
    mkdir -p "$dossier"
    dechiffrer < "$2" | tar -C "$dossier" -xf - --wildcards 'base-*.sql' 'fichiers-*.tar.gz' 'env-*.txt'
    echo "Copie déchiffrée dans $dossier (le site n'a pas été modifié) :"
    ls -l "$dossier"
    echo "Pour remettre le site en état à partir de ces fichiers, suivez la procédure écrite, et seulement après accord."
    exit 0 ;;
  -h | --help | --aide) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
  "") ;;
  *) erreur "option inconnue : $1 (voir ./copie-hors-serveur.sh --aide)" ;;
esac

command -v openssl > /dev/null || erreur "la commande openssl est absente"
echo "1. Sauvegarde de la nuit..."
derniere() { find "$SAUV" -maxdepth 1 -name 'base-*.sql' -mmin -$((AGE_MAX_HEURES * 60)) 2>/dev/null | sort | tail -n 1; }
recente=$(derniere)
if [ -z "$recente" ]; then
  [ "${CAHIORA_ESSAI_LOCAL:-}" = 1 ] && erreur "aucune sauvegarde de moins de $AGE_MAX_HEURES heures dans $SAUV"
  [ -x "$ICI/sauvegarder.sh" ] || erreur "aucune sauvegarde de moins de $AGE_MAX_HEURES heures, et ./sauvegarder.sh est absent de $ICI"
  echo "   Aucune sauvegarde de moins de $AGE_MAX_HEURES heures : sauvegarde faite maintenant."
  "$ICI/sauvegarder.sh" < /dev/null
  recente=$(derniere)
  [ -n "$recente" ] || erreur "la sauvegarde n'a pas produit de copie de la base"
fi
D=$(basename "$recente" .sql)
D=${D#base-}
for f in "base-$D.sql" "fichiers-$D.tar.gz" "env-$D.txt"; do
  [ -s "$SAUV/$f" ] || erreur "$f manque dans $SAUV : relancez ./sauvegarder.sh, puis ce script"
done
echo "   Sauvegarde du $D : base, fichiers envoyés et .env présents."

echo "2. Vérification de la base (restauration dans une base temporaire $VERIF)..."
copie_complete < "$SAUV/base-$D.sql" || erreur "copie de la base incomplète (base-$D.sql)"
gzip -t "$SAUV/fichiers-$D.tar.gz" || erreur "copie des fichiers envoyés abîmée (fichiers-$D.tar.gz)"
LIGNES="SELECT count(*) || ' tables et ' || coalesce(sum((xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I', table_name), false, true, '')))[1]::text::bigint), 0) || ' lignes'
  FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"
pg psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -c "SET client_min_messages TO warning" \
  -c "DROP DATABASE IF EXISTS $VERIF" -c "CREATE DATABASE $VERIF OWNER erp_owner" < /dev/null
if ! pg psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$VERIF" < "$SAUV/base-$D.sql" > /dev/null; then
  pg psql -X -q -U postgres -d postgres -c "DROP DATABASE IF EXISTS $VERIF" < /dev/null
  erreur "la copie de la base ne se restaure pas : copie hors du serveur NON faite"
fi
resume=$(pg psql -X -At -U postgres -d "$VERIF" -c "$LIGNES" < /dev/null)
pg psql -X -q -U postgres -d postgres -c "DROP DATABASE $VERIF" < /dev/null
echo "   Base restaurée sans erreur : $resume (base temporaire supprimée)."

echo "3. Chiffrement..."
phrase=$(lire_phrase "   Phrase secrète (au moins 12 caractères, rien ne s'affiche) : ")
[ "${#phrase}" -ge 12 ] || erreur "phrase secrète trop courte (au moins 12 caractères) : rien n'a été fait"
confirmation=$(lire_phrase "   La même, une seconde fois : ")
[ "$phrase" = "$confirmation" ] || erreur "les deux phrases diffèrent : rien n'a été fait"
umask 077
mkdir -p "$DEST"
chmod 700 "$DEST"
archive="$DEST/cahiora-$D.tar.enc"
temporaire="$archive.tmp"
tar -C "$SAUV" -cf - "base-$D.sql" "fichiers-$D.tar.gz" "env-$D.txt" | chiffrer > "$temporaire"

echo "4. Relecture de la copie chiffrée..."
verifier_archive "$temporaire"
mv "$temporaire" "$archive"
temporaire=""
(cd "$DEST" && sha256sum "$(basename "$archive")" > "$(basename "$archive").sha256")
empreinte=$(cut -d' ' -f1 < "$archive.sha256" | tr 'a-f' 'A-F')
find "$DEST" -maxdepth 1 -name 'cahiora-*.tar.enc' | sort -r | tail -n +"$((GARDER + 1))" \
  | while IFS= read -r ancienne; do rm -f "$ancienne" "$ancienne.sha256"; done
echo "   Copie RELUE : elle se déchiffre et contient la base complète, les fichiers envoyés et le .env."

serveur=$(grep -s '^PLATFORM_DOMAIN=' "$ICI/.env" | cut -d= -f2- | tr -d '"' || true)
[ -n "$serveur" ] || serveur=$(hostname -I 2>/dev/null | awk '{print $1}')
nom=$(basename "$archive")
cible="\$HOME\\Documents\\Cahiora-copies"
echo ""
echo "Copie prête : $archive ($(du -h "$archive" | cut -f1))"
echo "Empreinte SHA-256 : $empreinte"
echo ""
echo "5. Sur votre ORDINATEUR (pas dans ce Terminal), ouvrez PowerShell et tapez ces trois lignes :"
echo "   New-Item -ItemType Directory -Force \"$cible\" | Out-Null"
echo "   scp root@$serveur:$archive \"$cible\\$nom\""
echo "   if ((Get-FileHash \"$cible\\$nom\" -Algorithm SHA256).Hash -eq \"$empreinte\") { \"Copie IDENTIQUE à celle du serveur\" } else { \"ATTENTION : copie DIFFÉRENTE, recommencez le téléchargement\" }"
echo "   scp demande le mot de passe root du serveur. La dernière ligne doit afficher « Copie IDENTIQUE à celle du serveur »."
