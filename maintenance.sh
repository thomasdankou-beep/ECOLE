#!/bin/sh
# FENÊTRE DE MAINTENANCE, COURTE : plus aucune écriture scolaire possible pendant la sauvegarde finale, la migration et la
# vérification des empreintes (demandes de Dankou du 24 novembre 2026).
#
# Le point d'entrée du site (Caddy) répond « Maintenance en cours » (code 503 et en-tête X-Cahiora-Maintenance: oui) à
# toutes les pages et à toute l'API, pour toutes les écoles, les groupes et la console du Super Admin. Seuls les fichiers
# fixes du site (images, styles, scripts) passent encore, en lecture. Rien n'est arrêté ni supprimé : la base, l'API et le
# site continuent de tourner (la sauvegarde s'en sert) ; aucun fichier du code, aucune donnée, aucun réglage n'est modifié.
#
# La fenêtre tient même si Caddy redémarre pendant la migration :
#  - un fragment « maintenance » est posé dans le volume de Caddy (/data/cahiora-maintenance/actif.caddy) : la
#    configuration de Caddy de cette version (infra/caddy/Caddyfile) l'importe à chaque démarrage ;
#  - un gardien (petit programme du serveur, ~/.cahiora-maintenance) relit toutes les 2 secondes la configuration chargée
#    dans Caddy et y remet la maintenance si elle a disparu (redémarrage avec l'ancienne configuration, avant la mise à jour).
# « fin » arrête le gardien, enlève le fragment et recharge la configuration habituelle du code.
#
#   debut  ouvre la fenêtre, attend la fin des requêtes déjà en cours, vérifie toutes les adresses
#   etat   pour chaque adresse : le code HTTP et l'en-tête réellement reçus ; puis ce que Caddy a chargé et la protection
#          de la fenêtre. Une adresse injoignable (réseau) n'est jamais comptée comme ouverte ni comme fermée.
#   fin    ferme la fenêtre : le site rouvre
# Code de sortie : 0 seulement si la fenêtre est vérifiée dans l'état attendu (ouverte et protégée, ou fermée), 1 sinon,
# 2 si rien n'a pu être fait.
#
# Avant la mise à jour, le script n'est pas encore dans le code en ligne : depuis le commit épinglé du rapport,
#   cd ~/ecole && git fetch -q origin <COMMIT> && sh -c "$(git show <COMMIT>:maintenance.sh)" maintenance debut
# (de même avec « etat » ou « fin ») ; après la mise à jour : cd ~/ecole && ./maintenance.sh etat
set -u
set -f

cd "$HOME/ecole" 2>/dev/null || { echo "Dossier ~/ecole introuvable : rien n'a été fait."; exit 2; }
ICI="$HOME/ecole"
ETAT="$HOME/.cahiora-maintenance"
FRAGMENT=/data/cahiora-maintenance/actif.caddy
CONF=/tmp/cahiora-maintenance.Caddyfile
NORMALE=/tmp/cahiora-normale.Caddyfile
# Essais seulement (banc Docker en http) : ESSAI_SCHEMA=http, ESSAI_CURL (options de curl), ESSAI_LOCAL (Caddy local).
SCHEMA=${ESSAI_SCHEMA:-https}
LOCAL=${ESSAI_LOCAL:-127.0.0.1:443}

# Fonctions communes au script et au gardien (le gardien les reçoit telles quelles).
commun() {
  cat <<'FIN_COMMUN'
dans_caddy() { docker compose exec -T caddy "$@"; }
# Configuration chargée dans Caddy (interface d'administration, dans son conteneur) : maintenance, habituelle ou illisible.
chargee() {
  c=$(dans_caddy wget -q -T 5 -O - http://localhost:2019/config/ </dev/null 2>/dev/null) || { echo illisible; return; }
  case "$c" in
    *'"apps"'*X-Cahiora-Maintenance* | *X-Cahiora-Maintenance*'"apps"'*) echo maintenance ;;
    *'"apps"'*) echo habituelle ;;
    *) echo illisible ;;
  esac
}
# fichier_caddy <chemin dans le conteneur> < contenu : écrit d'un coup (fichier temporaire, puis renommage).
fichier_caddy() { dans_caddy sh -c 'mkdir -p "$(dirname "$1")" && cat > "$1.part" && mv -f "$1.part" "$1"' fichier "$1"; }
# Pose le fragment dans le volume de Caddy et charge la configuration de maintenance.
appliquer() {
  fichier_caddy "$FRAGMENT" < "$ETAT/actif.caddy" && fichier_caddy "$CONF" < "$ETAT/maintenance.Caddyfile" &&
    dans_caddy caddy reload --config "$CONF" --adapter caddyfile </dev/null >/dev/null 2>&1
}
journal() { echo "$(date -u '+%Y-%m-%d %H:%M:%S UTC') $*" >> "$ETAT/journal.log"; }
FIN_COMMUN
}
COMMUN=$(commun)
eval "$COMMUN"

# Le gardien : tourne tant que la fenêtre est ouverte (fichier « fenetre »), 12 h au plus.
gardien_code() {
  cat <<'FIN_GARDIEN'
ICI=$1; ETAT=$2; FRAGMENT=$3; CONF=$4
cd "$ICI" || exit 1
echo $$ > "$ETAT/gardien.pid"
trap 'journal "gardien arrêté"; rm -f "$ETAT/gardien.pid"; exit 0' TERM INT HUP
journal "gardien démarré (processus $$) : configuration de Caddy relue toutes les 2 s"
limite=$(( $(date +%s) + 43200 ))
muet=0
while [ -f "$ETAT/fenetre" ] && [ "$(date +%s)" -lt "$limite" ]; do
  case "$(chargee)" in
    maintenance) [ "$muet" = 0 ] || journal "Caddy répond de nouveau, maintenance en place"; muet=0 ;;
    habituelle)
      journal "Caddy a chargé sa configuration habituelle (redémarrage ?) : maintenance remise"
      if appliquer && [ "$(chargee)" = maintenance ]; then journal "fenêtre RÉTABLIE"; else journal "ÉCHEC de la remise en maintenance, nouvel essai dans 2 s"; fi
      muet=0 ;;
    *)
      [ "$muet" = 1 ] || journal "Caddy ne répond pas (redémarrage en cours ?) : nouvel essai toutes les 2 s"
      muet=1 ;;
  esac
  sleep 2
done
[ -f "$ETAT/fenetre" ] && journal "gardien arrêté après 12 h : la fenêtre reste ouverte, relancez « debut » ou « fin »"
rm -f "$ETAT/gardien.pid"
FIN_GARDIEN
}

# Le fragment de maintenance (importé dans la configuration de Caddy, avant l'API et les pages).
fragment() {
  cat <<'CADDY'
# Fenêtre de maintenance de Cahiora (maintenance.sh) : enlevé par « maintenance.sh fin ».
header X-Cahiora-Maintenance oui
# Fichiers fixes du site, en lecture seulement.
@cahiora_fixes {
	method GET HEAD
	path /_next/static/* /img/* /illustrations/* /favicon.png /logo.png /icon-192.png /icon-512.png
}
handle @cahiora_fixes {
	reverse_proxy web:3000
}
# Accolades du JSON protégées (\{ \}) : ce ne sont pas des variables de Caddy.
handle /api/* {
	header Content-Type "application/json; charset=utf-8"
	header Cache-Control no-store
	header Retry-After 900
	respond `\{"statusCode":503,"message":"Cahiora est en maintenance pendant quelques minutes : rien ne peut être enregistré pour l’instant. Réessayez un peu plus tard."\}` 503
}
handle {
	header Content-Type "text/html; charset=utf-8"
	header Cache-Control no-store
	header Retry-After 900
	respond `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Cahiora : maintenance en cours</title></head><body style="margin:0;padding:16px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f7f9;color:#1f2933"><main style="max-width:30rem;margin:15vh auto 0;background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.1)"><h1 style="font-size:1.3rem;margin:0 0 12px">Maintenance en cours</h1><p style="line-height:1.5">Cahiora est mis à jour pendant quelques minutes. Vos données sont conservées ; rien ne peut être modifié pendant ce temps.</p><p style="line-height:1.5">Réessayez un peu plus tard.</p></main></body></html>` 503
}
CADDY
}

# Configuration chargée pendant la fenêtre : la même que infra/caddy/Caddyfile de cette version (les essais le vérifient),
# qui importe le fragment. Elle vaut donc aussi avant la mise à jour, quand le code en ligne a encore l'ancienne.
config() {
  cat <<'CADDY'
{
	on_demand_tls {
		ask http://api:4000/api/v1/platform/tls-check
	}
}

{$SITE_ADDRESS::80} {
	tls {
		on_demand
	}
	encode zstd gzip
	header ?Strict-Transport-Security "max-age=31536000"
	route {
		import /data/cahiora-maintenance/*.caddy
		handle /api/* {
			reverse_proxy api:4000
		}
		handle {
			reverse_proxy web:3000
		}
	}
}
CADDY
}

env_val() { grep "^$1=" "$ICI/.env" 2>/dev/null | tail -n 1 | cut -d= -f2- | sed "s/^[\"']//; s/[\"']\$//"; }
# sql <requête> : en lecture seule ; code de sortie non nul si la requête échoue (jamais un résultat vide à la place).
sql() {
  r=$(docker compose exec -T -e PGOPTIONS='-c default_transaction_read_only=on' postgres psql -U postgres -d erp -X -q -At -v ON_ERROR_STOP=1 -c "$1" </dev/null 2>/dev/null) || return 1
  printf '%s\n' "$r" | tr -d '\r'
}
caddy_en_marche() { docker compose ps --status running --services </dev/null 2>/dev/null | grep -qx caddy; }
gardien_pid() {
  p=$(cat "$ETAT/gardien.pid" 2>/dev/null) || return 1
  case "$p" in '' | *[!0-9]*) return 1 ;; esac
  [ -r "/proc/$p/cmdline" ] && tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -q cahiora-gardien || return 1
  echo "$p"
}
fragment_present() { dans_caddy test -f "$FRAGMENT" </dev/null >/dev/null 2>&1; }

# Adresses contrôlées : console du Super Admin, espace des groupes et API sur le domaine de la plateforme, puis la page de
# connexion et l'API de chaque école (sous-domaine, et adresse propre si elle en a une).
adresses() {
  dom=$(env_val PLATFORM_DOMAIN)
  dom=${dom:-cahiora.com}
  echo "$SCHEMA://$dom/plateforme/connexion $SCHEMA://$dom/groupe/connexion $SCHEMA://$dom/api/v1/health"
  ecoles=$(sql "SELECT slug || ' ' || coalesce(domain, '') FROM tenants ORDER BY \"createdAt\"") || return 1
  printf '%s\n' "$ecoles" | while read -r s d; do
    [ -n "$s" ] || continue
    echo "$SCHEMA://$s.$dom/connexion $SCHEMA://$s.$dom/api/v1/health"
    [ -z "$d" ] || echo "$SCHEMA://$d/connexion $SCHEMA://$d/api/v1/health"
  done
}

raison() {
  case "$1" in
    5) echo "relais réseau introuvable" ;;
    6) echo "nom introuvable (DNS)" ;;
    7) echo "connexion refusée" ;;
    28) echo "délai dépassé" ;;
    35 | 51 | 53 | 54 | 58 | 59 | 60 | 64 | 66 | 77 | 80 | 82 | 83 | 90 | 91) echo "échec du chiffrement (TLS, code curl $1)" ;;
    52) echo "réponse vide" ;;
    55 | 56) echo "connexion coupée" ;;
    *) echo "erreur réseau (code curl $1)" ;;
  esac
}
# sonde <url> [options de curl] : « code entete sortie » (entete : oui ou non ; sortie : code de sortie de curl).
sonde() {
  u=$1; shift
  r=$(curl "$@" -s -o /dev/null -m 15 -D - -w 'cahiora-code=%{http_code}\n' "$u" </dev/null 2>/dev/null); x=$?
  c=$(printf '%s\n' "$r" | tr -d '\r' | sed -n 's/^cahiora-code=//p' | tail -n 1)
  if printf '%s\n' "$r" | tr -d '\r' | grep -qi '^x-cahiora-maintenance: *oui *$'; then m=oui; else m=non; fi
  echo "${c:-000} $m $x"
}
# classe <code> <entete> <sortie> : maintenance, ouverte, injoignable ou anomalie.
classe() {
  if [ "$3" != 0 ] || [ "$1" = 000 ]; then echo injoignable
  elif [ "$2" = oui ] && [ "$1" = 503 ]; then echo maintenance
  elif [ "$2" = oui ]; then echo anomalie
  elif [ "$1" = 200 ]; then echo ouverte
  else echo anomalie; fi
}

# Contrôle de toutes les adresses. Affiche le détail ; VERDICT : ouverte, fermee, partielle, injoignable ou anomalie.
verifier() {
  LISTE_INCOMPLETE=0
  if liste=$(adresses); then :; else
    echo "  (liste des écoles non lue dans la base : seules les adresses de la plateforme sont contrôlées)"
    LISTE_INCOMPLETE=1
  fi
  n=0; nm=0; no=0; ni=0; na=0; nl=0
  for u in $liste; do
    set -- $(sonde "$u" ${ESSAI_CURL:-})
    k=$(classe "$1" "$2" "$3")
    n=$((n + 1))
    case "$k" in
      maintenance) nm=$((nm + 1)); echo "  $u : $1, en-tête de maintenance → maintenance" ;;
      ouverte) no=$((no + 1)); echo "  $u : $1, sans en-tête de maintenance → site ouvert" ;;
      anomalie) na=$((na + 1)); echo "  $u : $1, en-tête de maintenance $([ "$2" = oui ] && echo présent || echo absent) → ANOMALIE" ;;
      injoignable)
        ni=$((ni + 1))
        set -- "$1" "$2" "$3" $(sonde "$u" --connect-to "::$LOCAL" -k)
        if [ "$6" = 0 ] && [ "$4" != 000 ]; then
          l="sur le serveur, Caddy répond $4 $([ "$5" = oui ] && echo 'avec' || echo 'sans') l'en-tête de maintenance"
        else
          l="Caddy ne répond pas non plus sur le serveur ($(raison "$6"))"; nl=$((nl + 1))
        fi
        echo "  $u : INJOIGNABLE par le réseau ($(raison "$3")) ; $l" ;;
    esac
  done
  if [ "$n" -gt 0 ] && [ "$nm" = "$n" ]; then VERDICT=ouverte
  elif [ "$n" -gt 0 ] && [ "$no" = "$n" ]; then VERDICT=fermee
  elif [ "$nm" -gt 0 ] && [ $((no + na)) -gt 0 ]; then VERDICT=partielle
  elif [ "$ni" -gt 0 ]; then VERDICT=injoignable
  else VERDICT=anomalie; fi
  if [ "$LISTE_INCOMPLETE" = 1 ]; then case "$VERDICT" in ouverte | fermee) VERDICT=incomplete ;; esac; fi
  CHARGEE=$(chargee)
  [ "$VERDICT" != injoignable ] || [ "$nl" != "$n" ] || [ "$CHARGEE" != illisible ] || VERDICT=caddy_arrete
  case "$CHARGEE" in
    maintenance) echo "Configuration chargée dans Caddy : MAINTENANCE" ;;
    habituelle) echo "Configuration chargée dans Caddy : habituelle (site ouvert)" ;;
    *) echo "Configuration chargée dans Caddy : ILLISIBLE (Caddy ne répond pas sur son interface d'administration)" ;;
  esac
  TEMOIN=non; [ -f "$ETAT/fenetre" ] && TEMOIN=oui
  FRAG=non; fragment_present && FRAG=oui
  if g=$(gardien_pid); then GARDIEN="en marche (processus $g)"; else GARDIEN=arrêté; fi
  echo "Protection de la fenêtre : ouverte par « debut » : $TEMOIN ; fragment dans le volume de Caddy : $FRAG ; gardien : $GARDIEN"
}

# Conclusion : code de sortie 0 seulement si tout est cohérent avec l'état attendu (ouverte ou fermee).
conclure() {
  case "$VERDICT:$CHARGEE" in
    ouverte:maintenance)
      if [ "$FRAG" = oui ] && [ "$TEMOIN" = oui ] && [ "$GARDIEN" != arrêté ]; then
        echo "Fenêtre de maintenance : OUVERTE ET PROTÉGÉE. Toutes les adresses répondent 503 avec l'en-tête de maintenance : aucune écriture scolaire possible."
        [ "$1" = ouverte ] && return 0
        echo "(attendu : fermée)"; return 1
      fi
      echo "Fenêtre de maintenance : OUVERTE mais NON PROTÉGÉE contre un redémarrage de Caddy (fragment $FRAG, gardien $GARDIEN) : relancez « debut »."
      return 1 ;;
    fermee:habituelle)
      if [ "$FRAG" = non ]; then
        echo "Fenêtre de maintenance : FERMÉE. Toutes les adresses répondent normalement, sans l'en-tête de maintenance."
        [ "$1" = fermee ] && return 0
        echo "(attendu : ouverte)"; return 1
      fi
      echo "Fenêtre de maintenance : fermée, mais le fragment est encore dans le volume de Caddy : relancez « fin »."
      return 1 ;;
    partielle:*)
      echo "Fenêtre de maintenance : PARTIELLE (certaines adresses ne répondent pas « maintenance ») : aucune sauvegarde ni migration ; relancez « debut », sinon envoyez-moi ce résultat." ;;
    injoignable:*)
      echo "Fenêtre de maintenance : NON VÉRIFIÉE, adresse(s) injoignable(s) par le réseau (ce n'est ni une ouverture ni une fermeture). Configuration chargée dans Caddy : $CHARGEE. Vérifiez le réseau et relancez « etat »." ;;
    caddy_arrete:*)
      echo "Fenêtre de maintenance : NON VÉRIFIÉE. Caddy ne répond pas du tout (service arrêté ou en train de redémarrer) : le site est inaccessible, rien ne peut y être écrit. Relancez « etat » dans une minute ; s'il ne répond toujours pas, envoyez-moi ce résultat." ;;
    incomplete:*)
      echo "Fenêtre de maintenance : NON VÉRIFIÉE pour les écoles (liste des écoles non lue dans la base) : relancez « etat »." ;;
    *)
      echo "Fenêtre de maintenance : ÉTAT INCOHÉRENT (adresses : $VERDICT ; Caddy : $CHARGEE) : envoyez-moi ce résultat." ;;
  esac
  return 1
}

# Requêtes déjà en cours dans la base : écriture commencée, transaction ouverte ou requête active d'un compte de l'application.
en_cours() {
  sql "SELECT count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND backend_type = 'client backend'
    AND datname = current_database() AND (backend_xid IS NOT NULL OR (usename IN ('erp_app', 'erp_platform', 'erp_group', 'erp_owner', 'erp_stats')
    AND (state = 'active' OR state LIKE 'idle in transaction%')))"
}

case "${1:-}" in
  debut)
    echo "Ouverture de la fenêtre de maintenance ($(date -u '+%Y-%m-%d %H:%M:%S UTC'))..."
    caddy_en_marche || { echo "ÉCHEC : le service caddy ne tourne pas. Rien n'a changé."; exit 2; }
    [ "$(chargee)" != illisible ] || { echo "ÉCHEC : Caddy ne répond pas sur son interface d'administration. Rien n'a changé."; exit 2; }
    mkdir -p "$ETAT" && chmod 700 "$ETAT" || { echo "ÉCHEC : dossier $ETAT impossible à créer. Rien n'a changé."; exit 2; }
    fragment > "$ETAT/actif.caddy" && config > "$ETAT/maintenance.Caddyfile" || { echo "ÉCHEC : écriture dans $ETAT. Rien n'a changé."; exit 2; }
    if ! fichier_caddy "$FRAGMENT" < "$ETAT/actif.caddy" || ! fichier_caddy "$CONF" < "$ETAT/maintenance.Caddyfile" ||
      ! dans_caddy caddy validate --config "$CONF" --adapter caddyfile </dev/null >/dev/null 2>&1; then
      dans_caddy rm -f "$FRAGMENT" </dev/null >/dev/null 2>&1
      echo "ÉCHEC : configuration de maintenance refusée par Caddy. Rien n'a changé : le site reste ouvert."; exit 2
    fi
    deja=non; [ -f "$ETAT/fenetre" ] && deja=oui
    [ "$deja" = oui ] || date -u '+%Y-%m-%d %H:%M:%S UTC' > "$ETAT/fenetre"
    if ! dans_caddy caddy reload --config "$CONF" --adapter caddyfile </dev/null >/dev/null 2>&1 || [ "$(chargee)" != maintenance ]; then
      if [ "$deja" = non ]; then rm -f "$ETAT/fenetre"; dans_caddy rm -f "$FRAGMENT" </dev/null >/dev/null 2>&1; fi
      echo "ÉCHEC : Caddy n'a pas chargé la configuration de maintenance. Relancez « etat » pour voir ce que répond le site."; exit 1
    fi
    if [ "$deja" = oui ]; then journal "« debut » relancé : maintenance reposée"; echo "La fenêtre était déjà ouverte (depuis $(cat "$ETAT/fenetre")) : maintenance reposée."
    else journal "fenêtre ouverte"; fi
    echo "Maintenance chargée dans Caddy ; fragment posé dans son volume (relu à chaque démarrage de Caddy)."
    if g=$(gardien_pid); then echo "Gardien déjà en marche (processus $g)."
    else
      if command -v setsid >/dev/null 2>&1; then
        setsid -f sh -c "$COMMUN
$(gardien_code)" cahiora-gardien "$ICI" "$ETAT" "$FRAGMENT" "$CONF" </dev/null >/dev/null 2>&1
      else
        nohup sh -c "$COMMUN
$(gardien_code)" cahiora-gardien "$ICI" "$ETAT" "$FRAGMENT" "$CONF" </dev/null >/dev/null 2>&1 &
      fi
      i=0; while [ "$i" -lt 10 ] && ! gardien_pid >/dev/null; do sleep 1; i=$((i + 1)); done
      if g=$(gardien_pid); then echo "Gardien démarré (processus $g) : il remet la maintenance si Caddy redémarre."
      else echo "ATTENTION : le gardien n'a pas démarré."; fi
    fi
    # Requêtes déjà parties vers l'API avant la fenêtre : on attend qu'elles soient finies (60 s au plus).
    i=0; vides=0
    while [ "$i" -lt 30 ]; do
      e=$(en_cours)
      case "$e" in '' | *[!0-9]*) e=illisible ;; esac
      if [ "$e" = 0 ]; then vides=$((vides + 1)); [ "$vides" -ge 2 ] && break; else vides=0; fi
      sleep 2; i=$((i + 1))
    done
    if [ "$e" = 0 ]; then echo "Requêtes en cours dans la base : aucune (celles d'avant la fenêtre sont terminées)."
    elif [ "$e" = illisible ]; then echo "Requêtes en cours dans la base : NON LUES (la base ne répond pas)."
    else echo "Requêtes en cours dans la base : $e encore après 60 s."; fi
    # Compteurs d'écritures de chaque table à l'ouverture : le contrôle vérifie ensuite que rien n'a été écrit depuis.
    # (gardés tels quels si « debut » est relancé pendant la fenêtre)
    if [ "$deja" = non ] || [ ! -s "$ETAT/ecritures" ]; then
      sql "SELECT relname || ' ' || (n_tup_ins + n_tup_upd + n_tup_del) FROM pg_stat_user_tables WHERE schemaname = 'public' ORDER BY 1" > "$ETAT/ecritures.part" &&
        [ -s "$ETAT/ecritures.part" ] && mv -f "$ETAT/ecritures.part" "$ETAT/ecritures" || rm -f "$ETAT/ecritures.part"
    fi
    sleep 1
    echo "Adresses contrôlées (code HTTP, en-tête X-Cahiora-Maintenance) :"
    verifier
    if conclure ouverte && [ "$e" = 0 ]; then
      echo "Pour la fermer à la fin : la même commande, avec « fin » au lieu de « debut »."
      exit 0
    fi
    [ "$e" = 0 ] || echo "Requêtes encore en cours ou non lues : attendez une minute, puis lancez le contrôle (étape suivante) avant toute sauvegarde."
    echo "Ne commencez pas la sauvegarde finale ; envoyez-moi ce résultat."
    exit 1
    ;;
  fin)
    echo "Fermeture de la fenêtre de maintenance ($(date -u '+%Y-%m-%d %H:%M:%S UTC'))..."
    caddy_en_marche || { echo "ÉCHEC : le service caddy ne tourne pas. Rien n'a changé."; exit 2; }
    if ! fichier_caddy "$NORMALE" < "$ICI/infra/caddy/Caddyfile" ||
      ! dans_caddy caddy validate --config "$NORMALE" --adapter caddyfile </dev/null >/dev/null 2>&1; then
      echo "ÉCHEC : la configuration habituelle du code (infra/caddy/Caddyfile) est refusée par Caddy : la fenêtre RESTE OUVERTE. Envoyez-moi ce résultat."
      exit 1
    fi
    rm -f "$ETAT/fenetre"
    if g=$(gardien_pid); then
      kill -s TERM -- "-$g" 2>/dev/null || kill -s TERM "$g" 2>/dev/null
      i=0; while [ "$i" -lt 10 ] && gardien_pid >/dev/null; do sleep 1; i=$((i + 1)); done
      if gardien_pid >/dev/null; then kill -s KILL -- "-$g" 2>/dev/null || kill -s KILL "$g" 2>/dev/null; sleep 1; fi
      sleep 3 # une remise en maintenance déjà envoyée à Caddy par le gardien se termine avant la suite
    fi
    if gardien_pid >/dev/null; then echo "ÉCHEC : le gardien ne s'arrête pas. Envoyez-moi ce résultat."; exit 1; fi
    echo "Gardien arrêté."
    dans_caddy rm -f "$FRAGMENT" </dev/null >/dev/null 2>&1
    if fragment_present; then echo "ÉCHEC : le fragment de maintenance n'a pas pu être enlevé du volume de Caddy. Envoyez-moi ce résultat."; exit 1; fi
    dans_caddy rmdir "$(dirname "$FRAGMENT")" </dev/null >/dev/null 2>&1
    i=0
    until dans_caddy caddy reload --config "$NORMALE" --adapter caddyfile </dev/null >/dev/null 2>&1 && [ "$(chargee)" = habituelle ]; do
      i=$((i + 1))
      if [ "$i" -ge 3 ]; then echo "ÉCHEC : Caddy n'a pas rechargé sa configuration habituelle ; la maintenance reste affichée. Relancez « fin »."; exit 1; fi
      sleep 2
    done
    dans_caddy rm -f "$CONF" "$NORMALE" </dev/null >/dev/null 2>&1
    echo "Configuration habituelle du code rechargée dans Caddy ; fragment enlevé."
    if [ -f "$ETAT/journal.log" ]; then echo "-- Journal du gardien"; journal "fenêtre fermée"; cat "$ETAT/journal.log"; fi
    rm -rf "$ETAT"
    sleep 2
    echo "Adresses contrôlées (code HTTP, en-tête X-Cahiora-Maintenance) :"
    verifier
    conclure fermee && { echo "Le site est de nouveau ouvert."; exit 0; }
    exit 1
    ;;
  etat)
    echo "État de la fenêtre de maintenance ($(date -u '+%Y-%m-%d %H:%M:%S UTC'))"
    echo "Adresses contrôlées (code HTTP, en-tête X-Cahiora-Maintenance) :"
    verifier
    if [ -f "$ETAT/fenetre" ]; then attendu=ouverte; else attendu=fermee; fi
    if [ -f "$ETAT/journal.log" ]; then echo "-- Journal du gardien (fin)"; tail -n 5 "$ETAT/journal.log"; fi
    conclure "$attendu" && exit 0
    exit 1
    ;;
  *)
    echo "Usage : maintenance.sh debut | etat | fin"; exit 2
    ;;
esac
