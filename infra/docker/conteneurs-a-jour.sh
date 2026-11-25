#!/bin/sh
# Appelé par installer-serveur.sh juste après « docker compose up -d --build » : l'API et le site en marche doivent avoir
# été construits depuis le commit installé (CAHIORA_COMMIT, inscrit dans leurs images). Un conteneur resté sur une
# ancienne image est recréé depuis l'image qui vient d'être construite.
# Vu sur GitHub avec Docker Compose 2.38.2 : un conteneur recréé plus tôt sans --build (par exemple par
# « docker compose up -d api » après une modification du .env) garde son ancienne image après « docker compose up -d
# --build » ; controle-production.sh le déclarerait alors BLOQUANT (point 9 de la demande de Dankou du 24 novembre 2026).
# Rien d'autre n'est touché : ni la base, ni Redis, ni Caddy, donc la fenêtre de maintenance reste en place.
# Usage, depuis ~/ecole : CAHIORA_COMMIT=<commit> ./infra/docker/conteneurs-a-jour.sh
# Code de sortie : 0 si l'API et le site tournent sur ce commit (au besoin après recréation), 1 sinon.
set -u
attendu=${CAHIORA_COMMIT:-}
if [ -z "$attendu" ]; then
  echo "ÉCHEC : CAHIORA_COMMIT n'est pas donné."
  exit 1
fi

commit_en_marche() { # commit inscrit dans le conteneur du service $1 (lu dans sa configuration) ; vide s'il n'y en a pas
  id=$(docker compose ps -a -q "$1" 2> /dev/null | head -n 1)
  [ -n "$id" ] || return 0
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$id" 2> /dev/null | sed -n 's/^CAHIORA_COMMIT=//p' | head -n 1
}

echecs=0
for s in api web; do
  if [ "$s" = api ]; then Nom="L'API" nom="l'API"; else Nom="Le site" nom="le site"; fi
  c=$(commit_en_marche "$s")
  [ "$c" = "$attendu" ] && continue
  echo "$Nom tourne sur une image construite depuis « ${c:-aucun commit inscrit} », et non depuis le commit $attendu :" \
    "recréation du conteneur depuis l'image qui vient d'être construite."
  docker compose up -d --no-deps --force-recreate "$s" || true
  c=$(commit_en_marche "$s")
  if [ "$c" = "$attendu" ]; then
    echo "$Nom tourne maintenant sur le commit $attendu."
  else
    echo "ÉCHEC : $nom tourne toujours sur « ${c:-aucun commit inscrit} » au lieu du commit $attendu."
    echecs=$((echecs + 1))
  fi
done
[ "$echecs" = 0 ]
