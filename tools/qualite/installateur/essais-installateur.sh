#!/usr/bin/env bash
# Essais de installer-serveur.sh sans serveur : git réel (dépôts temporaires), Docker, curl, systemctl et ufw simulés.
# Vérifie que :
#   - une mise à jour normale récupère le code puis reconstruit ;
#   - une erreur de récupération du code (modification locale en conflit, dépôt injoignable) ARRÊTE la mise à jour
#     avant toute reconstruction (décision D3 du 16 novembre 2026) ;
#   - un retour arrière (version fixée par « git checkout <commit> ») garde cette version et reconstruit ;
#   - l'étape « créer votre compte Super Admin » n'est proposée que s'il n'existe encore aucun compte ;
#   - les images sont construites avec le commit installé (CAHIORA_COMMIT), que controle-production.sh vérifie ensuite.
# Rien n'est installé ni démarré : aucun appel réseau, aucun Docker réel.
#
# Usage : bash tools/qualite/installateur/essais-installateur.sh [chemin de installer-serveur.sh]
set -euo pipefail

racine="$(cd "$(dirname "$0")/../../.." && pwd)"
installateur="$(cd "$(dirname "${1:-$racine/installer-serveur.sh}")" && pwd)/$(basename "${1:-installer-serveur.sh}")"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export GIT_AUTHOR_NAME=essai GIT_AUTHOR_EMAIL=essai@example.invalid GIT_COMMITTER_NAME=essai GIT_COMMITTER_EMAIL=essai@example.invalid

# Commandes simulées : elles notent leurs appels dans $JOURNAL.
mkdir -p "$tmp/bin"
cat > "$tmp/bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >> "$JOURNAL"
# Commit que l'installateur donne aux images de l'API et du site (contrôlé après la mise à jour par controle-production.sh).
case "$*" in "compose up -d --build"*) echo "commit des images : ${CAHIORA_COMMIT:-absent}" >> "$JOURNAL" ;; esac
case "$*" in
  *"SELECT count(*) FROM platform_admins"*) echo "${FAUX_ADMINS:-0}" ;;
  "compose exec -T postgres psql"*) cat > /dev/null ;;
esac
exit 0
EOF
cat > "$tmp/bin/curl" <<'EOF'
#!/usr/bin/env bash
echo "curl $*" >> "$JOURNAL"
case "$*" in
  *ifconfig.me*) echo 203.0.113.10 ;;
  *localhost*) exit 0 ;;
  *) exit 1 ;;
esac
EOF
cat > "$tmp/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "systemctl $*" >> "$JOURNAL"
EOF
cat > "$tmp/bin/ufw" <<'EOF'
#!/usr/bin/env bash
echo "Status: inactive"
EOF
cat > "$tmp/bin/apt-get" <<'EOF'
#!/usr/bin/env bash
echo "apt-get $*" >> "$JOURNAL"
exit 1
EOF
cat > "$tmp/bin/id" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "-u" ]; then echo 0; else exec /usr/bin/id "$@"; fi
EOF
chmod +x "$tmp/bin/"*
export PATH="$tmp/bin:$PATH" JOURNAL="$tmp/journal"

# Dépôt d'origine minimal : l'installateur à essayer et ce qu'il appelle.
src="$tmp/source"
mkdir -p "$src/infra/postgres"
cp "$installateur" "$src/installer-serveur.sh"
cp "$racine/.env.docker.example" "$src/"
cp "$racine/infra/postgres/role-plateforme.sh" "$racine/infra/postgres/roles-groupes.sh" "$src/infra/postgres/"
chmod +x "$src/installer-serveur.sh" "$src/infra/postgres/"*.sh
printf '.env\n' > "$src/.gitignore"
echo 1 > "$src/VERSION"
git -C "$src" init -q -b principale
git -C "$src" add -A && git -C "$src" commit -q -m v1
v1=$(git -C "$src" rev-parse HEAD)
git clone -q --bare "$src" "$tmp/origine.git"
git -C "$src" remote add origin "$tmp/origine.git"
git clone -q "$tmp/origine.git" "$tmp/serveur"
nouvelle_version() { echo "$1" > "$src/VERSION"; git -C "$src" commit -q -am "v$1"; git -C "$src" push -q origin principale; git -C "$src" rev-parse HEAD; }

echecs=0
verifier() { # verifier <attendu> <commande...> : « ok » si la commande réussit, « ÉCHEC » sinon
  local attendu="$1"; shift
  if "$@"; then echo "  ok : $attendu"; else echo "  ÉCHEC : $attendu"; echecs=$((echecs + 1)); fi
}
lancer() { # lancer <nombre de comptes Super Admin> : lance l'installateur du serveur simulé
  : > "$JOURNAL"
  set +e
  FAUX_ADMINS="$1" "$tmp/serveur/installer-serveur.sh" > "$tmp/sortie" 2>&1
  code=$?
  set -e
}
contient() { grep -qF -- "$1" "$2"; }
sans() { ! grep -qF -- "$1" "$2"; }
tete() { git -C "$tmp/serveur" rev-parse HEAD; }
est_en() { test "$(tete)" = "$1"; }

echo "1. Mise à jour normale (comptes Super Admin déjà créés)"
v2=$(nouvelle_version 2)
lancer 2
verifier "terminé sans erreur" test "$code" = 0
verifier "code récupéré (v2)" est_en "$v2"
verifier "services reconstruits" contient "compose up -d --build" "$JOURNAL"
verifier "images marquées du commit installé (v2)" contient "commit des images : $v2" "$JOURNAL"
verifier "site annoncé en ligne" contient "SITE EN LIGNE" "$tmp/sortie"
verifier "pas d'étape Super Admin quand 2 comptes existent" sans "créer votre compte Super Admin" "$tmp/sortie"

echo "2. Récupération impossible : modification locale en conflit"
v3=$(nouvelle_version 3)
echo "modifié à la main" > "$tmp/serveur/VERSION"
lancer 2
verifier "arrêt avec une erreur" test "$code" != 0
verifier "message d'échec clair" contient "ÉCHEC : le code n'a pas pu être récupéré" "$tmp/sortie"
verifier "aucun service démarré ni reconstruit" sans "compose up" "$JOURNAL"
verifier "version en place inchangée (v2)" est_en "$v2"
git -C "$tmp/serveur" checkout -q -- VERSION

echo "3. Récupération impossible : dépôt injoignable"
git -C "$tmp/serveur" remote set-url origin "$tmp/introuvable.git"
lancer 2
verifier "arrêt avec une erreur" test "$code" != 0
verifier "aucun service démarré ni reconstruit" sans "compose up" "$JOURNAL"
git -C "$tmp/serveur" remote set-url origin "$tmp/origine.git"
lancer 2
verifier "dépôt revenu : la mise à jour suivante passe" test "$code" = 0
verifier "code récupéré (v3)" est_en "$v3"

echo "4. Retour arrière : version fixée par git checkout <commit>"
git -C "$tmp/serveur" checkout -q "$v1"
lancer 2
verifier "terminé sans erreur" test "$code" = 0
verifier "la version choisie (v1) est gardée" est_en "$v1"
verifier "services reconstruits sur cette version" contient "compose up -d --build" "$JOURNAL"
verifier "images marquées du commit fixé (v1)" contient "commit des images : $v1" "$JOURNAL"
verifier "le retour arrière est annoncé" contient "Version fixée" "$tmp/sortie"
verifier "la commande pour reprendre les mises à jour est donnée" contient "git checkout principale" "$tmp/sortie"
git -C "$tmp/serveur" checkout -q principale

echo "5. Premier lancement : aucun compte Super Admin"
lancer 0
verifier "terminé sans erreur" test "$code" = 0
verifier "l'étape Super Admin est proposée" contient "créer votre compte Super Admin" "$tmp/sortie"

echo ""
if [ "$echecs" = 0 ]; then echo "Tous les essais de l'installateur sont réussis."; else echo "$echecs vérification(s) en échec."; exit 1; fi
