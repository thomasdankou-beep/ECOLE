#!/bin/sh
# FENÊTRE DE MAINTENANCE, COURTE : plus aucune écriture scolaire possible pendant la sauvegarde finale, la migration et la
# vérification des empreintes (demande de Dankou du 24 novembre 2026).
#
# Le point d'entrée du site (Caddy) répond « Maintenance en cours » (code 503) à toutes les pages et à toute l'API, pour
# toutes les écoles, les groupes et la console du Super Admin. Seuls les fichiers fixes du site (images, styles, scripts)
# passent encore, en lecture : un téléphone qui les demande ne garde pas une page d'erreur à leur place.
# Rien n'est arrêté ni supprimé : la base, l'API et le site continuent de tourner (la sauvegarde s'en sert), les données
# ne changent pas. Aucun fichier du serveur, aucun réglage n'est modifié : la configuration de maintenance est copiée dans
# /tmp du conteneur caddy et chargée en mémoire ; « fin » recharge la configuration habituelle (infra/caddy/Caddyfile),
# qu'un redémarrage de Caddy rétablit aussi.
#
#   ./maintenance.sh debut    ouvre la fenêtre (le site affiche la page de maintenance)
#   ./maintenance.sh etat     dit si la fenêtre est ouverte, d'après la réponse réelle du site
#   ./maintenance.sh fin      ferme la fenêtre : le site rouvre
# Avant la mise à jour, le script n'est pas encore dans le code en ligne : depuis le commit épinglé du rapport,
#   cd ~/ecole && git fetch -q origin <COMMIT> && sh -c "$(git show <COMMIT>:maintenance.sh)" maintenance debut
# (et de même avec « etat » ou « fin »).
set -u

if [ "${CAHIORA_ESSAI_LOCAL:-}" = 1 ]; then
  # Essais sur un ordinateur de développement seulement : Caddy lancé à part (CADDY), adresse d'essai (ESSAI_URL).
  # ESSAI_TLS_INTERNE=1 : certificats de l'autorité locale de Caddy au lieu des certificats publics à la demande.
  ICI=$(pwd)
  NORMALE="${ESSAI_NORMALE:-$ICI/infra/caddy/Caddyfile}"
  TMP="${ESSAI_DIR:-/tmp}/cahiora-maintenance.Caddyfile"
  ecrire_config() {
    if [ "${ESSAI_TLS_INTERNE:-}" = 1 ]; then awk '/^\ttls \{$/ { print "\ttls internal {"; next } { print }' > "$TMP"; else cat > "$TMP"; fi
  }
  caddy_bin() { "${CADDY:-caddy}" "$@"; }
  adresses() { echo "${ESSAI_URL:-http://localhost:8080}/connexion ${ESSAI_URL:-http://localhost:8080}/api/v1/health"; }
  CURL_ESSAI="-k --noproxy localhost" # autorité locale de Caddy, sans relais réseau : essais seulement
else
  cd "$HOME/ecole" 2>/dev/null || { echo "Dossier ~/ecole introuvable"; exit 1; }
  ICI="$HOME/ecole"
  NORMALE=/etc/caddy/Caddyfile
  TMP=/tmp/cahiora-maintenance.Caddyfile
  ecrire_config() { docker compose exec -T caddy sh -c "cat > $TMP"; }
  caddy_bin() { docker compose exec -T caddy caddy "$@"; }
  dom=$(grep '^PLATFORM_DOMAIN=' "$ICI/.env" 2>/dev/null | tail -n 1 | cut -d= -f2- | sed "s/^[\"']//; s/[\"']\$//")
  dom=${dom:-cahiora.com}
  adresses() { echo "https://$dom/plateforme/connexion https://saint-kisito.$dom/connexion https://$dom/api/v1/health"; }
  CURL_ESSAI=
fi

# Même configuration que infra/caddy/Caddyfile (certificats à la demande, HSTS), mais une réponse « maintenance » au lieu
# de l'API et des pages. Les accolades du JSON sont protégées (\{ \}) : ce ne sont pas des variables de Caddy.
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
	header X-Cahiora-Maintenance oui
	# Fichiers fixes du site, en lecture seulement.
	@fixes {
		method GET HEAD
		path /_next/static/* /img/* /illustrations/* /favicon.png /logo.png /icon-192.png /icon-512.png
	}
	handle @fixes {
		reverse_proxy web:3000
	}
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
}
CADDY
}

# Réponse réelle du site pour chaque adresse : « code maintenance » (oui ou non).
reponses() {
  for u in $(adresses); do
    r=$(curl $CURL_ESSAI -s -o /dev/null -m 20 -D - -w 'code=%{http_code}' "$u" </dev/null | tr -d '\r')
    c=$(printf '%s\n' "$r" | sed -n 's/^code=//p' | tail -n 1)
    if printf '%s\n' "$r" | grep -qi '^x-cahiora-maintenance: *oui'; then m=oui; else m=non; fi
    echo "$u $c $m"
  done
}

# Détail par adresse, puis une dernière ligne : ouverte, fermee ou partielle.
etat() {
  r=$(reponses)
  printf '%s\n' "$r" | awk '{ print "  " $1 " : " $2 ($3 == "oui" ? " (maintenance)" : "") }'
  ouvertes=$(printf '%s\n' "$r" | awk '$3 == "oui"' | grep -c .)
  fermees=$(printf '%s\n' "$r" | awk '$3 == "non"' | grep -c .)
  if [ "$fermees" = 0 ] && [ "$ouvertes" -gt 0 ]; then echo ouverte; elif [ "$ouvertes" = 0 ]; then echo fermee; else echo partielle; fi
}

case "${1:-}" in
  debut)
    echo "Ouverture de la fenêtre de maintenance ($(date -u '+%Y-%m-%d %H:%M UTC'))..."
    if ! config | ecrire_config; then echo "ÉCHEC : configuration de maintenance non copiée dans Caddy. Rien n'a changé : le site reste ouvert."; exit 1; fi
    if ! caddy_bin validate --config "$TMP" --adapter caddyfile >/dev/null 2>&1; then
      echo "ÉCHEC : configuration de maintenance refusée par Caddy. Rien n'a changé : le site reste ouvert."; exit 1
    fi
    if ! caddy_bin reload --config "$TMP" --adapter caddyfile >/dev/null 2>&1; then
      echo "ÉCHEC : Caddy n'a pas chargé la configuration de maintenance. Vérifiez avec la même commande et « etat »."; exit 1
    fi
    sleep 2
    e=$(etat); printf '%s\n' "$e" | sed '$d'
    if [ "$(printf '%s\n' "$e" | tail -n 1)" = ouverte ]; then
      echo "Fenêtre de maintenance OUVERTE : le site répond « Maintenance en cours », aucune écriture scolaire n'est possible."
      echo "Pour la fermer à la fin : la même commande, avec « fin » au lieu de « debut »."
    else
      echo "ATTENTION : la maintenance ne répond pas partout. Ne commencez pas la sauvegarde finale ; relancez la commande ou envoyez-moi ce résultat."
      exit 1
    fi
    ;;
  fin)
    echo "Fermeture de la fenêtre de maintenance ($(date -u '+%Y-%m-%d %H:%M UTC'))..."
    if ! caddy_bin reload --config "$NORMALE" --adapter caddyfile >/dev/null 2>&1; then
      echo "ÉCHEC : Caddy n'a pas rechargé sa configuration habituelle ; la maintenance reste affichée. Envoyez-moi ce résultat."; exit 1
    fi
    if [ "${CAHIORA_ESSAI_LOCAL:-}" = 1 ]; then rm -f "$TMP"; else docker compose exec -T caddy rm -f "$TMP" </dev/null; fi
    sleep 2
    e=$(etat); printf '%s\n' "$e" | sed '$d'
    if [ "$(printf '%s\n' "$e" | tail -n 1)" = fermee ]; then echo "Fenêtre de maintenance FERMÉE : le site est de nouveau ouvert."
    else echo "ATTENTION : la maintenance répond encore à certaines adresses. Envoyez-moi ce résultat."; exit 1; fi
    ;;
  etat)
    e=$(etat); printf '%s\n' "$e" | sed '$d'
    case "$(printf '%s\n' "$e" | tail -n 1)" in
      ouverte) echo "Fenêtre de maintenance : OUVERTE (aucune écriture scolaire possible)" ;;
      fermee) echo "Fenêtre de maintenance : fermée (le site est ouvert)" ;;
      *) echo "Fenêtre de maintenance : PARTIELLE (certaines adresses répondent encore normalement)" ;;
    esac
    ;;
  *)
    echo "Usage : maintenance.sh debut | etat | fin"; exit 2
    ;;
esac
