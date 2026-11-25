#!/bin/sh
# CONTRÔLE FINAL DE LA PRODUCTION, EN LECTURE SEULE : ne modifie aucun fichier, aucune donnée, aucun service, aucun réglage.
# La base est ouverte en lecture seule (default_transaction_read_only) : toute écriture y serait refusée.
# Aucun secret n'est affiché : pour un mot de passe ou une clé, seulement « présent » ou « absent ».
# Contrôle : code en ligne et version réellement en marche, services, fenêtre de maintenance (chaque adresse), verrou des
# paiements, migrations, établissements et Super Admin, abonnements et autres données commerciales (DS-3), tâches internes
# et écritures, sauvegardes, possibilité de restauration, données scolaires (empreinte), serveur.
# À la fin, un résumé : OK, ATTENTION ou BLOQUANT pour chaque point.
# Code de sortie : 0 aucun point BLOQUANT ; 1 au moins un point BLOQUANT ; 2 contrôle impossible (base muette, dossier absent).
# Une lecture qui échoue n'est jamais prise pour une absence (d'abonnement, de SMS, de compte sans double authentification…) :
# elle est BLOQUANTE.
#
# Ce qu'il lit sans rien écrire : la base (psql en lecture seule, dont pg_stat_activity et les compteurs d'écritures de
# pg_stat_user_tables), l'état des conteneurs (docker compose ps, exec printenv, exec node pour /api/v1/health, exec wget
# pour la configuration chargée dans Caddy, exec test pour le fragment de maintenance), les réponses du site (curl), le .env
# (seulement « présent » ou « absent » pour un secret), git (log, rev-parse, status sans verrou ni mise à jour de l'index),
# la crontab, les minuteries, les ports ouverts (ss), les files de l'API (redis-cli, nombres seulement), ~/.cahiora-maintenance,
# la place libre, les sauvegardes (lecture et gzip -t).
# Il n'arrête, ne démarre, ne recrée et ne reconfigure rien ; il n'installe rien ; il n'écrit aucun fichier.
#
# Sur le serveur (Terminal hPanel), sans rien changer au code en ligne, depuis un COMMIT EXACT (jamais une branche, qui
# peut bouger) : le rapport donne <COMMIT> (40 caractères) et l'empreinte sha256 attendue du script.
#   cd ~/ecole && git fetch -q origin <COMMIT> && git show <COMMIT>:controle-production.sh | sha256sum
#   (comparez avec l'empreinte du rapport ; si elle diffère, ne lancez rien)
#   sh -c "$(git show <COMMIT>:controle-production.sh)"
# git fetch n'ajoute que les objets de ce commit dans ~/ecole/.git : ni fichier du code en ligne, ni service, ni réglage.
# Une fois la mise à jour faite : cd ~/ecole && ATTENDU=<commit déployé> ./controle-production.sh
# Variables à placer devant sh (ou devant ./controle-production.sh), toutes facultatives :
#   FENETRE=ouverte   la fenêtre de maintenance doit être ouverte et protégée (sinon BLOQUANT) ; FENETRE=fermee : l'inverse
#   ATTENDU=<commit>  commit qui doit être en ligne après la mise à jour (obligatoire après la mise à jour)
#   EMPREINTE=<16 caractères>  empreinte des données scolaires relevée avant : elle doit être identique
#   DETAIL=1          empreinte de chaque table de l'école en plus

VERSION_REPETEE=fcb84eb
NOUVELLES="20261119120000_comptages_g5b 20261120090000_documents_g5c 20261121090000_acces_g5d1 20261122090000_paiements_g5d2 20261123090000_ajustements_g5"
# Les 51 tables des données de l'école (paramètres, comptes, élèves, notes, bulletins, finances des familles, SMS…).
TABLES_SCOLAIRES="academic_years announcements annual_decisions applications appreciations assessments attendance_records
attendance_sessions cash_closings class_subjects classes counters documents duplicate_reviews enrollment_events enrollments
fee_types grades guardians internship_periods internship_placements invoice_items invoices lessons levels payment_routes
payments public_honors receipts report_card_items report_card_runs report_cards rooms sanctions school_groups sites
sms_messages student_files student_guardians students subjects teacher_assignments teacher_subjects tenants terms
timetable_changes timetable_slots tracks user_roles users verification_entries"
NB_TABLES_SCOLAIRES=51
COMPTES_APP="'erp_app', 'erp_platform', 'erp_group', 'erp_owner', 'erp_stats'"

if [ "${CAHIORA_ESSAI_LOCAL:-}" = 1 ]; then
  # Essais sur un ordinateur de développement seulement (base d'essai, sans Docker ni réseau).
  ICI=$(pwd)
  sql() { PGOPTIONS='-c default_transaction_read_only=on' psql -h "${PGHOST:-/tmp}" -U postgres -d "${BASE:-erp}" -X -q -P pager=off -v ON_ERROR_STOP=1 "$@"; }
  dc() { return 1; }
  rc() { redis-cli "$@"; }
else
  cd "$HOME/ecole" 2>/dev/null || { echo "Dossier ~/ecole introuvable : contrôle impossible. Rien n'a été modifié."; exit 2; }
  ICI="$HOME/ecole"
  sql() { docker compose exec -T -e PGOPTIONS='-c default_transaction_read_only=on' postgres psql -U postgres -d erp -X -q -P pager=off -v ON_ERROR_STOP=1 "$@"; }
  dc() { docker compose "$@"; }
  rc() { docker compose exec -T redis redis-cli "$@"; }
fi
ETAT="$HOME/.cahiora-maintenance"
ERR='#ERREUR'
# val <requête> : une seule valeur, sans mise en forme ; « #ERREUR » si la lecture échoue (jamais vide à la place d'une erreur).
val() {
  if v=$(sql -At -c "$1" </dev/null 2>/dev/null); then printf '%s\n' "$v" | tr -d '\r'; else echo "$ERR"; fi
}
entier() { case "$1" in '' | *[!0-9]*) return 1 ;; esac; }
# lignes <table> [condition] : nombre de lignes, « - » si la table n'existe pas encore, « #ERREUR » si la lecture échoue.
lignes() {
  case "$(val "SELECT to_regclass('public.$1') IS NOT NULL")" in
    t) val "SELECT count(*) FROM $1 ${2:-}" ;;
    f) echo - ;;
    *) echo "$ERR" ;;
  esac
}
env_val() { grep "^$1=" "$ICI/.env" 2>/dev/null | tail -n 1 | cut -d= -f2- | sed "s/^[\"']//; s/[\"']\$//"; }
present() { if grep -q "^$1=." "$ICI/.env" 2>/dev/null; then echo présent; else echo absent; fi; }

RESUME=""
bloquants=0
point() { # point OK|ATTENTION|BLOQUANT <texte>
  RESUME="$RESUME
$(printf '%-9s %s' "$1" "$2")"
  if [ "$1" = BLOQUANT ]; then bloquants=$((bloquants + 1)); fi
}
# afficher <requête> <titre> : tableau pour la lecture ; une lecture impossible est BLOQUANTE.
afficher() { sql -c "$1" </dev/null 2>&1 || { echo "(lecture impossible)"; point BLOQUANT "lecture impossible : $2 (rien ne peut en être conclu)"; }; }
# illisible <valeur> <texte> : vrai (et BLOQUANT) si la valeur n'a pas pu être lue.
illisible() {
  case "$1" in "$ERR" | '') point BLOQUANT "lecture impossible : $2 (rien ne peut en être conclu ; envoyez-moi ce résultat)"; return 0 ;; esac
  return 1
}
LISTE_SQL=$(printf "'%s', " $TABLES_SCOLAIRES | sed 's/, $//')
# Compteurs d'écritures (lignes ajoutées, modifiées, supprimées) de chaque table : « table nombre » par ligne.
compteurs() { val "SELECT relname || ' ' || (n_tup_ins + n_tup_upd + n_tup_del) FROM pg_stat_user_tables WHERE schemaname = 'public' ORDER BY 1"; }
# ecart <avant> <après> : « table différence » pour chaque table dont le compteur a bougé (négatif : compteur remis à zéro).
ecart() { printf '%s\n--\n%s\n' "$1" "$2" | awk '$0 == "--" { b = 1; next } !b { a[$1] = $2; next } { d = $2 - (($1 in a) ? a[$1] : 0); if (d != 0) print $1, d }'; }
scolaires() { awk -v l=" $(echo $TABLES_SCOLAIRES) " 'index(l, " " $1 " ")'; }

echo "Contrôle final de la production, en lecture seule : $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
if [ "$(val "SELECT 1")" != 1 ]; then
  echo "La base ne répond pas : contrôle impossible. Rien n'a été modifié."
  exit 2
fi
compteurs_debut=$(compteurs)
apres=$(val "SELECT count(*) FROM _prisma_migrations WHERE migration_name = '20261123090000_ajustements_g5' AND finished_at IS NOT NULL AND rolled_back_at IS NULL")
if ! entier "$apres"; then echo "Migrations illisibles : contrôle impossible. Rien n'a été modifié."; exit 2; fi
[ "$apres" = 0 ] || apres=1
if [ "$apres" = 1 ]; then echo "Moment : APRÈS la mise à jour (migration des ajustements appliquée)"; else echo "Moment : AVANT la mise à jour"; fi
set -- $TABLES_SCOLAIRES
[ "$#" = "$NB_TABLES_SCOLAIRES" ] || point BLOQUANT "liste interne des tables de l'école : $# au lieu de $NB_TABLES_SCOLAIRES (script à corriger)"

echo
echo "== 1. Code en ligne et version réellement en marche"
head=$(git -C "$ICI" rev-parse HEAD </dev/null 2>/dev/null)
code=$(printf '%s' "$head" | cut -c1-7)
git -C "$ICI" log -1 --format='%h %ad %s' --date=iso </dev/null 2>/dev/null
echo "commit complet : ${head:-illisible}"
echo "branche : $(git -C "$ICI" rev-parse --abbrev-ref HEAD </dev/null 2>/dev/null)"
modifs=$(git -C "$ICI" --no-optional-locks status --short --untracked-files=no </dev/null 2>/dev/null | head -n 10)
if [ -n "$modifs" ]; then echo "fichiers suivis modifiés sur le serveur :"; printf '%s\n' "$modifs"
else echo "fichiers suivis modifiés sur le serveur : aucun"; fi
api_commit=""; web_commit=""
if [ "${CAHIORA_ESSAI_LOCAL:-}" != 1 ]; then
  api_commit=$(dc exec -T api printenv CAHIORA_COMMIT </dev/null 2>/dev/null | tr -d '\r')
  web_commit=$(dc exec -T web printenv CAHIORA_COMMIT </dev/null 2>/dev/null | tr -d '\r')
fi
echo "commit inscrit dans l'API en marche : ${api_commit:-aucun (image construite avant ce contrôle des versions)}"
echo "commit inscrit dans le site en marche : ${web_commit:-aucun (image construite avant ce contrôle des versions)}"
ATTENDU=$(printf '%s' "${ATTENDU:-}" | tr 'A-F' 'a-f' | tr -d ' ')
[ -z "$ATTENDU" ] || echo "commit attendu (ATTENDU) : $ATTENDU"
if [ "$apres" = 1 ]; then
  if [ -z "$ATTENDU" ]; then
    point BLOQUANT "commit attendu non donné : relancez avec ATTENDU=<commit déployé, donné dans le rapport> devant la commande"
  elif ! printf '%s' "$ATTENDU" | grep -qE '^[0-9a-f]{7,40}$'; then
    point BLOQUANT "commit attendu « $ATTENDU » invalide (7 à 40 caractères 0-9 a-f)"
  elif [ -z "$head" ]; then
    point BLOQUANT "commit du code en ligne illisible (git)"
  else
    case "$head" in
      "$ATTENDU"*)
        if [ -n "$modifs" ]; then point BLOQUANT "code en ligne = $code, mais des fichiers suivis ont été modifiés sur le serveur (voir partie 1) : la version en marche n'est pas exactement ce commit"
        elif [ "$api_commit" = "$head" ] && [ "$web_commit" = "$head" ]; then point OK "version en marche : commit $code, celui attendu ; l'API et le site ont été construits depuis ce commit"
        else
          for c in "API:$api_commit" "site:$web_commit"; do
            v=${c#*:}
            [ "$v" = "$head" ] || point BLOQUANT "${c%%:*} en marche construit depuis « ${v:-aucun commit inscrit} » et non depuis $code : relancez cd ~/ecole && ./installer-serveur.sh (sans nouvelle migration), puis ce contrôle"
          done
        fi ;;
      *) point BLOQUANT "code en ligne : $code au lieu du commit attendu $ATTENDU : envoyez-moi ce résultat" ;;
    esac
  fi
elif [ "$code" = "$VERSION_REPETEE" ]; then
  [ -z "$modifs" ] || point ATTENTION "fichiers du code modifiés à la main sur le serveur (voir partie 1)"
  point OK "code en ligne : $code, la version sur laquelle la mise à jour a été répétée"
else
  point BLOQUANT "code en ligne : ${code:-illisible} alors que la base n'a pas les migrations de la mise à jour (version répétée : $VERSION_REPETEE) : gardez la fenêtre de maintenance, envoyez-moi ce résultat"
fi

echo
echo "== 2. Services"
if [ "${CAHIORA_ESSAI_LOCAL:-}" = 1 ]; then
  echo "(essai local : pas de Docker)"
else
  dc ps --format '{{.Service}} : {{.Status}}' </dev/null
  marche=$(dc ps --status running --services </dev/null 2>/dev/null | tr '\n' ' ')
  manque=""
  for s in postgres api web caddy; do case " $marche" in *" $s "*) ;; *) manque="$manque $s" ;; esac; done
  [ -z "$manque" ] || point BLOQUANT "service(s) arrêté(s) :$manque"
  for s in redis clamav; do case " $marche" in *" $s "*) ;; *) point ATTENTION "service arrêté : $s" ;; esac; done
  api=$(dc exec -T api node -e "fetch('http://localhost:4000/api/v1/health').then(r => console.log(r.status === 200 ? 'oui' : 'erreur ' + r.status)).catch(() => console.log('NON'))" </dev/null 2>&1 | tail -n 1 | tr -d '\r')
  echo "l'API répond : $api"
  if [ "$api" = oui ]; then point OK "l'API répond"; else point BLOQUANT "l'API ne répond pas ($api)"; fi
  echo "Caddy : $(dc exec -T caddy caddy version </dev/null 2>/dev/null | tr -d '\r' | cut -d' ' -f1)"
fi

echo
echo "== 3. Fenêtre de maintenance (réponse réelle de chaque adresse : code HTTP et en-tête X-Cahiora-Maintenance)"
# Essais seulement (banc Docker en http) : ESSAI_SCHEMA=http, ESSAI_CURL (options de curl), ESSAI_LOCAL (Caddy local).
SCHEMA=${ESSAI_SCHEMA:-https}
LOCAL=${ESSAI_LOCAL:-127.0.0.1:443}
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
sonde() { # sonde <url> [options de curl] : « code entete sortie »
  u=$1; shift
  r=$(curl "$@" -s -o /dev/null -m 10 -D - -w 'cahiora-code=%{http_code}\n' "$u" </dev/null 2>/dev/null); x=$?
  c=$(printf '%s\n' "$r" | tr -d '\r' | sed -n 's/^cahiora-code=//p' | tail -n 1)
  if printf '%s\n' "$r" | tr -d '\r' | grep -qi '^x-cahiora-maintenance: *oui *$'; then m=oui; else m=non; fi
  echo "${c:-000} $m $x"
}
classe() {
  if [ "$3" != 0 ] || [ "$1" = 000 ]; then echo injoignable
  elif [ "$2" = oui ] && [ "$1" = 503 ]; then echo maintenance
  elif [ "$2" = oui ]; then echo anomalie
  elif [ "$1" = 200 ]; then echo ouverte
  else echo anomalie; fi
}
FENETRE_OUVERTE=0
[ "${FENETRE:-}" = ouverte ] && FENETRE_OUVERTE=1
[ -f "$ETAT/fenetre" ] && FENETRE_OUVERTE=1
VERDICT=""
if [ "${CAHIORA_ESSAI_LOCAL:-}" = 1 ]; then
  echo "(essai local : pas de Caddy ; fenêtre supposée ${FENETRE:-fermée})"
else
  dom=$(env_val PLATFORM_DOMAIN)
  dom=${dom:-cahiora.com}
  liste="$SCHEMA://$dom/plateforme/connexion $SCHEMA://$dom/groupe/connexion $SCHEMA://$dom/api/v1/health"
  ecoles=$(val "SELECT slug || ' ' || coalesce(domain, '') FROM tenants ORDER BY \"createdAt\"")
  liste_lue=oui
  if [ "$ecoles" = "$ERR" ]; then
    liste_lue=non
    point BLOQUANT "liste des écoles illisible : leurs adresses ne sont pas contrôlées, la fenêtre n'est donc pas vérifiée"
  else
    liste="$liste $(printf '%s\n' "$ecoles" | while read -r s d; do
      [ -n "$s" ] || continue
      echo "$SCHEMA://$s.$dom/connexion $SCHEMA://$s.$dom/api/v1/health"
      [ -z "$d" ] || echo "$SCHEMA://$d/connexion $SCHEMA://$d/api/v1/health"
    done)"
  fi
  n=0; nm=0; no=0; ni=0; na=0; nl=0
  set -f
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
        if [ "$6" = 0 ] && [ "$4" != 000 ]; then l="sur le serveur, Caddy répond $4 $([ "$5" = oui ] && echo 'avec' || echo 'sans') l'en-tête de maintenance"
        else l="Caddy ne répond pas non plus sur le serveur ($(raison "$6"))"; nl=$((nl + 1)); fi
        echo "  $u : INJOIGNABLE par le réseau ($(raison "$3")) ; $l" ;;
    esac
  done
  set +f
  if [ "$n" -gt 0 ] && [ "$nm" = "$n" ]; then VERDICT=ouverte
  elif [ "$n" -gt 0 ] && [ "$no" = "$n" ]; then VERDICT=fermee
  elif [ "$nm" -gt 0 ] && [ $((no + na)) -gt 0 ]; then VERDICT=partielle
  elif [ "$ni" -gt 0 ] && [ "$nl" = "$n" ]; then VERDICT=caddy_arrete
  elif [ "$ni" -gt 0 ]; then VERDICT=injoignable
  else VERDICT=anomalie; fi
  # Adresses des écoles non contrôlées : ni « ouverte » ni « fermée » (le point BLOQUANT est déjà noté).
  [ "$liste_lue" = oui ] || case "$VERDICT" in ouverte | fermee) VERDICT=incomplete ;; esac
  # Interface d'administration de Caddy : 127.0.0.1, puis [::1], puis localhost (le wget du conteneur n'essaie qu'une adresse,
  # et « localhost » peut y désigner ::1 alors que Caddy n'écoute que sur 127.0.0.1).
  cfg=$(for a in 127.0.0.1 '[::1]' localhost; do
    r=$(dc exec -T caddy wget -q -T 5 -O - "http://$a:2019/config/" </dev/null 2>/dev/null) && { printf '%s\n' "$r"; exit 0; }
  done; exit 1)
  case "$?:$cfg" in
    0:*'"apps"'*X-Cahiora-Maintenance* | 0:*X-Cahiora-Maintenance*'"apps"'*) chargee=maintenance ;;
    0:*'"apps"'*) chargee=habituelle ;;
    *) chargee=illisible ;;
  esac
  frag=non; dc exec -T caddy test -f /data/cahiora-maintenance/actif.caddy </dev/null >/dev/null 2>&1 && frag=oui
  temoin=non; [ -f "$ETAT/fenetre" ] && temoin="oui (depuis $(cat "$ETAT/fenetre" 2>/dev/null))"
  gardien=arrêté
  p=$(cat "$ETAT/gardien.pid" 2>/dev/null)
  if entier "$p" && [ -r "/proc/$p/cmdline" ] && tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -q cahiora-gardien; then gardien="en marche (processus $p)"; fi
  echo "adresses : $n contrôlée(s) ; maintenance $nm, site ouvert $no, injoignables $ni, anomalies $na"
  echo "configuration chargée dans Caddy : $chargee"
  echo "protection de la fenêtre : ouverte par maintenance.sh : $temoin ; fragment dans le volume de Caddy : $frag ; gardien : $gardien"
  if [ -f "$ETAT/journal.log" ]; then echo "-- journal du gardien (fin)"; tail -n 4 "$ETAT/journal.log"; fi
  case "$VERDICT" in ouverte | partielle) FENETRE_OUVERTE=1 ;; esac
  [ "$chargee" != maintenance ] || FENETRE_OUVERTE=1
  [ "$frag" = non ] || FENETRE_OUVERTE=1
  protegee=non; [ "$frag" = oui ] && [ "$temoin" != non ] && [ "$gardien" != arrêté ] && protegee=oui
  case "$VERDICT" in
    partielle) point BLOQUANT "maintenance PARTIELLE : $nm adresse(s) sur $n en maintenance, les autres non : aucune sauvegarde ni migration ; relancez maintenance.sh debut" ;;
    caddy_arrete) point BLOQUANT "Caddy ne répond pas du tout (arrêté ou en train de redémarrer) : fenêtre non vérifiable ; relancez ce contrôle dans une minute" ;;
    injoignable) point BLOQUANT "$ni adresse(s) injoignable(s) par le réseau (voir partie 3) : état de la fenêtre NON VÉRIFIÉ, ce n'est ni une ouverture ni une fermeture ; relancez ce contrôle" ;;
    anomalie) point BLOQUANT "réponses anormales du site (voir partie 3) : $na adresse(s)" ;;
  esac
  if [ "$FENETRE_OUVERTE" = 1 ]; then
    if [ "${FENETRE:-}" = fermee ]; then point BLOQUANT "la fenêtre de maintenance devait être fermée (FENETRE=fermee), elle ne l'est pas"
    elif [ "$VERDICT" = ouverte ] && [ "$chargee" = maintenance ] && [ "$protegee" = oui ]; then
      point OK "fenêtre de maintenance ouverte et protégée : les $n adresses répondent 503 avec l'en-tête de maintenance ; Caddy l'a chargée, le fragment et le gardien la gardent même s'il redémarre"
    elif [ "$VERDICT" = ouverte ] && [ "$chargee" = maintenance ]; then
      point BLOQUANT "fenêtre ouverte mais NON PROTÉGÉE contre un redémarrage de Caddy (fragment : $frag ; gardien : $gardien) : relancez maintenance.sh debut"
    elif [ "$VERDICT" = ouverte ]; then
      point BLOQUANT "les adresses répondent « maintenance », mais la configuration chargée dans Caddy est $chargee : relancez ce contrôle"
    elif [ "$VERDICT" = fermee ]; then
      point BLOQUANT "fenêtre de maintenance attendue, mais le site est OUVERT ($n adresses répondent normalement) : relancez maintenance.sh debut"
    else
      [ "${FENETRE:-}" != ouverte ] || point BLOQUANT "fenêtre de maintenance attendue (FENETRE=ouverte) mais non vérifiée (voir ci-dessus)"
    fi
  elif [ "$VERDICT" = fermee ] && [ "$chargee" = habituelle ]; then
    point OK "fenêtre de maintenance fermée : les $n adresses répondent normalement (200, sans l'en-tête de maintenance)"
  elif [ "$VERDICT" = fermee ]; then
    point BLOQUANT "les adresses répondent normalement, mais la configuration chargée dans Caddy est $chargee : relancez ce contrôle"
  fi
fi

echo
echo "== 4. Verrou des paiements et réglages (.env, sans aucune valeur secrète)"
v=$(env_val BILLING_PAYMENTS_UNLOCKED)
vc=""
[ "${CAHIORA_ESSAI_LOCAL:-}" = 1 ] || vc=$(dc exec -T api printenv BILLING_PAYMENTS_UNLOCKED </dev/null 2>/dev/null | tr -d '\r')
echo "BILLING_PAYMENTS_UNLOCKED dans .env : ${v:-absent}"
echo "BILLING_PAYMENTS_UNLOCKED dans l'API en marche : ${vc:-absent}"
if [ "$v" = true ] || [ "$vc" = true ]; then
  point BLOQUANT "verrou des paiements de Cahiora OUVERT (BILLING_PAYMENTS_UNLOCKED=true) : il doit rester fermé"
else
  point OK "verrou des paiements de Cahiora fermé (BILLING_PAYMENTS_UNLOCKED ${v:-absent du .env}) : aucun paiement réel possible"
fi
for k in PRODUCTION_SERVER PLATFORM_DOMAIN PAYMENT_PROVIDER ALLOW_SANDBOX_PAYMENTS SMS_PROVIDER ENFORCE_2FA BILLING_JOBS; do
  echo "$k = $(env_val $k)"
done
for k in CINETPAY_API_KEY CINETPAY_SITE_ID CINETPAY_SECRET_KEY BULKGATE_APPLICATION_ID BULKGATE_APPLICATION_TOKEN APP_ENCRYPTION_KEY ERP_PLATFORM_PASSWORD ERP_GROUP_PASSWORD ERP_STATS_PASSWORD; do
  echo "$k : $(present $k)"
done
pp=$(env_val PAYMENT_PROVIDER)
case "${pp:-sandbox}" in
  sandbox) echo "paiement en ligne des familles (scolarité) : non branché (prestataire d'essai)" ;;
  *) point ATTENTION "paiement en ligne des familles branché sur le prestataire « $pp » (scolarité, hors Cahiora)" ;;
esac

echo
echo "== 5. Migrations"
afficher "SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS appliquees,
  count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS en_echec,
  count(*) FILTER (WHERE rolled_back_at IS NOT NULL) AS annulees_autrefois FROM _prisma_migrations" "migrations"
afficher "SELECT migration_name AS derniere_migration, to_char(finished_at, 'YYYY-MM-DD HH24:MI') AS le FROM _prisma_migrations
  WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at DESC LIMIT 1" "dernière migration"
appliquees=$(val "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")
echec=$(val "SELECT coalesce(string_agg(migration_name, ' '), '(aucune)') FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL")
manquantes=$(val "SELECT coalesce(string_agg(nom, ' '), '(aucune)') FROM (VALUES ('20261018211319_init'), ('20261018211400_rls'), ('20261018213000_payment_routes'),
  ('20261019233527_parametrage_stages_ateliers'), ('20261020003000_plateforme'), ('20261020010000_plateforme_mot_de_passe'), ('20261021210000_frais_public_cible'),
  ('20261021220000_matieres_professeurs'), ('20261021230000_fin_annee'), ('20261021233000_eleves_honneur'), ('20261022231500_photo_pieces_eleve'),
  ('20261106100000_photo_site'), ('20261106140000_securite_lot2'), ('20261106160000_securite_lot3'), ('20261106180000_securite_lot6'),
  ('20261106190000_securite_lot8'), ('20261106200000_securite_lot13'), ('20261108200000_recuperation_2fa'), ('20261110120000_sms_parents'),
  ('20261112220000_groupes_g1'), ('20261113100000_groupes_g2_comptes'), ('20261113140000_reinscription_g4'), ('20261113190000_reinscription_g4_corrections'),
  ('20261114120000_facturation_g5a'), ('20261114180000_prestations_g5g')) a(nom)
  WHERE nom NOT IN (SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)")
echo "-- Les cinq migrations de la mise à jour (PR #13 à #17)"
nouvelles=0; lues=oui
for m in $NOUVELLES; do
  le=$(val "SELECT coalesce(to_char(max(finished_at), 'YYYY-MM-DD HH24:MI'), 'non') FROM _prisma_migrations WHERE migration_name = '$m' AND finished_at IS NOT NULL AND rolled_back_at IS NULL")
  case "$le" in
    non) echo "$m : pas encore appliquée" ;;
    "$ERR" | '') echo "$m : ILLISIBLE"; lues=non ;;
    *) echo "$m : appliquée le $le"; nouvelles=$((nouvelles + 1)) ;;
  esac
done
if ! entier "$appliquees" || [ "$lues" = non ]; then illisible "$ERR" "état des migrations"
elif illisible "$echec" "migrations en échec" || illisible "$manquantes" "migrations de la version en ligne"; then :
elif [ "$echec" != "(aucune)" ]; then
  point BLOQUANT "migration interrompue : $echec en échec, $nouvelles des 5 nouvelles terminées. Gardez la maintenance, ne relancez rien, envoyez-moi ce résultat (procédure « migration interrompue »)"
elif [ "$manquantes" != "(aucune)" ]; then
  point BLOQUANT "migration(s) de la version en ligne absente(s) : $manquantes"
elif [ "$nouvelles" = 0 ] && [ "$appliquees" = 25 ]; then
  point OK "migrations : 25 appliquées, aucune en échec, aucune des 5 nouvelles encore appliquée"
elif [ "$nouvelles" = 5 ] && [ "$appliquees" = 30 ]; then
  point OK "migrations : 30 appliquées, dont les 5 de la mise à jour, aucune en échec"
elif [ "$nouvelles" -gt 0 ] && [ "$nouvelles" -lt 5 ]; then
  point BLOQUANT "mise à jour partielle : $nouvelles des 5 nouvelles migrations appliquées ($appliquees en tout). Gardez la maintenance, envoyez-moi ce résultat (procédure « migration interrompue »)"
else
  point BLOQUANT "migrations : $appliquees appliquées, dont $nouvelles des 5 nouvelles (attendu : 25 et 0 avant, 30 et 5 après)"
fi

echo
echo "== 6. Établissements et comptes Super Admin"
afficher "SELECT t.slug, t.name AS nom, t.status AS etat,
  coalesce(to_jsonb(t)->>'commercialStatus', 'pas encore (TEST à la migration)') AS statut_commercial,
  g.name AS groupe, to_char(t.\"createdAt\", 'YYYY-MM-DD') AS cree_le
  FROM tenants t LEFT JOIN school_groups g ON g.id = t.group_id ORDER BY t.\"createdAt\"" "établissements"
echo "-- Comptes Super Admin (nom et domaine de l'adresse seulement ; aucun secret)"
afficher "SELECT a.name AS nom, '…@' || split_part(a.email, '@', 2) AS adresse, a.active AS actif, a.\"totpEnabled\" AS double_authentification,
  a.\"mustSetupTwoFactor\" AS nouvelle_2fa_exigee, (SELECT count(*) FROM platform_recovery_codes r WHERE r.\"adminId\" = a.id AND r.\"usedAt\" IS NULL) AS codes_secours_restants,
  to_char(a.\"lastLoginAt\", 'YYYY-MM-DD') AS derniere_connexion FROM platform_admins a ORDER BY a.\"createdAt\"" "comptes Super Admin"
# Une seule lecture : total, actifs, actifs avec une double authentification en état de marche, désactivés sans elle.
set -- $(val "SELECT count(*) || ' ' || count(*) FILTER (WHERE active IS TRUE) || ' ' ||
  count(*) FILTER (WHERE active IS TRUE AND \"totpEnabled\" IS TRUE AND \"mustSetupTwoFactor\" IS FALSE) || ' ' ||
  count(*) FILTER (WHERE active IS NOT TRUE AND \"totpEnabled\" IS NOT TRUE) FROM platform_admins")
if [ "$#" != 4 ] || ! entier "$1" || ! entier "$2" || ! entier "$3" || ! entier "$4"; then
  illisible "$ERR" "comptes Super Admin et double authentification"
elif [ "$2" = 0 ]; then point BLOQUANT "aucun compte Super Admin actif trouvé ($1 compte(s) en tout)"
elif [ "$3" != "$2" ]; then
  sans=$(val "SELECT string_agg(name, ', ' ORDER BY \"createdAt\") FROM platform_admins WHERE active IS TRUE AND (\"totpEnabled\" IS NOT TRUE OR \"mustSetupTwoFactor\" IS NOT FALSE)")
  point BLOQUANT "$(($2 - $3)) compte(s) Super Admin actif(s) SANS double authentification active, ou à reconfigurer après une récupération : $sans (à faire avant la mise à jour)"
else point OK "double authentification active pour les $2 compte(s) Super Admin actif(s) ($1 en tout)"; fi
if [ "$#" = 4 ] && entier "$4" && [ "$4" != 0 ]; then
  point ATTENTION "$4 compte(s) Super Admin désactivé(s) sans double authentification (ils ne peuvent pas se connecter ; à activer s'ils sont réactivés)"
fi
nb=$(val "SELECT count(*) FROM tenants")
if illisible "$nb" "établissements"; then :
elif [ "$apres" = 1 ]; then
  clients=$(val "SELECT count(*) FROM tenants WHERE \"commercialStatus\" IS DISTINCT FROM 'TEST'")
  if illisible "$clients" "statut commercial des établissements"; then :
  elif [ "$clients" = 0 ]; then point OK "les $nb établissement(s) sont en statut TEST : ni facturés, ni limités"
  else point BLOQUANT "$clients établissement(s) en client réel (ou sans statut) au lieu de TEST"; fi
else
  point OK "$nb établissement(s), tous passés en TEST par la migration (statut posé pour tous, sans exception)"
fi

echo
echo "== 7. Abonnements et autres données commerciales (DS-3)"
echo "-- Abonnements (essai, pilote, abonnement)"
afficher "SELECT t.slug, s.status AS etat, s.\"trialStart\" AS essai_du, s.\"trialEnd\" AS essai_au, s.\"pilotStart\" AS pilote_du,
  s.\"pilotEnd\" AS pilote_au, (s.\"acceptedAt\" IS NOT NULL) AS conditions_acceptees, to_char(s.\"createdAt\", 'YYYY-MM-DD HH24:MI') AS ouvert_le
  FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id ORDER BY s.\"createdAt\"" "abonnements"
echo "-- Données commerciales : lignes par table (« - » : table créée par la mise à jour)"
for t in subscriptions subscription_events billing_calendars commercial_terms billing_parameters billing_jobs platform_alerts \
  services service_versions service_rates service_rate_ends billing_counts count_corrections billing_documents billing_document_lines \
  billing_exclusion_links regularization_requests billing_payment_means billing_payments billing_allocations billing_credit_entries \
  billing_refunds billing_credit_transfers count_request_derogations; do
  l=$(lignes $t); echo "$t : $l"
  [ "$l" != "$ERR" ] || point BLOQUANT "lecture impossible : table $t (rien ne peut en être conclu)"
done
echo "-- Calendriers de facturation (échéances de comptage et de régularisation, sans effet sans abonnement)"
afficher "SELECT t.slug, c.\"yearLabel\" AS annee, max(c.version) AS version, max(c.\"initialCountDate\") AS comptage,
  max(c.\"firstRegularizationDate\") AS regularisation_1, max(c.\"finalRegularizationDate\") AS regularisation_2
  FROM billing_calendars c JOIN tenants t ON t.id = c.tenant_id GROUP BY t.slug, c.\"yearLabel\" ORDER BY 1, 2" "calendriers de facturation"
echo "-- Conditions commerciales enregistrées (titre et date seulement)"
afficher "SELECT version, title AS titre, \"effectiveFrom\" AS en_vigueur_le FROM commercial_terms ORDER BY version" "conditions commerciales"
abos=$(lignes subscriptions)
if [ "$abos" = - ]; then point BLOQUANT "DS-3 : table des abonnements introuvable : rien ne peut en être conclu ; envoyez-moi ce résultat"
elif illisible "$abos" "abonnements (DS-3)"; then :
elif [ "$abos" = 0 ]; then point OK "DS-3 : aucun abonnement en production (lecture réussie), la mise à jour n'est pas bloquée"
else
  detail=$(val "SELECT string_agg(t.slug || ' ' || s.status, ', ' ORDER BY s.\"createdAt\") FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id")
  if [ "$apres" = 1 ]; then quand="avant le passage de ces établissements en client réel"; else quand="avant la mise à jour"; fi
  point BLOQUANT "DS-3 : $abos abonnement(s) en production ($detail) : ARRÊT de la procédure ; je vous soumets le plan DS-3 $quand, rien n'est réinitialisé sans votre accord"
fi
pilote=$(val "SELECT count(*) FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id WHERE t.slug = 'saint-kisito' AND (s.status::text = 'PILOT' OR s.\"pilotStart\" IS NOT NULL)")
if illisible "$pilote" "pilote de Saint Kisito"; then :
elif [ "$pilote" = 0 ]; then point OK "pilote de Saint Kisito non activé"
else point BLOQUANT "un pilote est enregistré pour Saint Kisito (DS-3, DS-4)"; fi
delais=$(val "SELECT count(*) FROM billing_parameters WHERE key IN ('COMPLEMENT_DUE_DAYS', 'SERVICE_DUE_DAYS')")
if illisible "$delais" "délais de paiement DS-2"; then :
elif [ "$delais" = 0 ]; then point OK "délais de paiement DS-2 (30 j compléments, 15 j prestations) non activés"
else point ATTENTION "délai DS-2 déjà saisi ($delais version(s)) : il ne devait pas l'être avant la validation des conditions commerciales"; fi
docs=$(lignes billing_documents); pays=$(lignes billing_payments); moyens=$(lignes billing_payment_means)
if [ "$docs" = "$ERR" ] || [ "$pays" = "$ERR" ] || [ "$moyens" = "$ERR" ]; then illisible "$ERR" "documents, paiements et moyens de paiement de Cahiora"
elif [ "$docs" = - ]; then
  point OK "aucun document ni paiement de Cahiora (la version en ligne n'en produit pas)"
else
  if [ "$docs" = 0 ] && [ "$pays" = 0 ]; then point OK "aucun document ni paiement de Cahiora"
  else point ATTENTION "documents de Cahiora : $docs, paiements : $pays (aucun attendu)"; fi
  if [ "$moyens" = 0 ]; then point OK "aucun moyen de paiement enregistré"
  else point BLOQUANT "$moyens version(s) de moyen de paiement enregistrée(s) : aucune n'est attendue"; fi
fi
echo "-- SMS des 30 derniers jours, par type (ni numéro ni texte)"
afficher "SELECT kind AS type_sms, status AS etat, count(*) AS nombre FROM sms_messages WHERE \"createdAt\" > now() - interval '30 days' GROUP BY 1, 2 ORDER BY 1, 2" "SMS par type"
commerciaux=$(val "SELECT count(*) FROM sms_messages WHERE kind::text ILIKE ANY (ARRAY['%billing%', '%subscription%', '%abonnement%', '%factur%', '%commercial%'])")
if illisible "$commerciaux" "SMS commerciaux"; then :
elif [ "$commerciaux" = 0 ]; then point OK "aucun SMS commercial de Cahiora (lecture réussie)"
else point BLOQUANT "$commerciaux SMS de type facturation ou abonnement trouvés : aucun n'est attendu"; fi

echo
echo "== 8. Tâches internes et écritures (aucune écriture scolaire pendant la sauvegarde et la migration)"
if [ "$FENETRE_OUVERTE" = 1 ]; then echo "(fenêtre de maintenance ouverte : contrôles stricts)"; else echo "(fenêtre de maintenance fermée : les écritures du site sont normales)"; fi
echo "-- crontab de $(id -un) (lignes actives)"
taches=$(crontab -l 2>/dev/null </dev/null | grep -v '^[[:space:]]*#' | grep -v '^[[:space:]]*$')
if [ -n "$taches" ]; then printf '%s\n' "$taches"; else echo "(aucune)"; fi
echo "-- /etc/cron.d : $(ls /etc/cron.d 2>/dev/null | tr '\n' ' ')"
if echo "$taches" | grep -q sauvegarder; then
  point OK "sauvegarde automatique chaque nuit : active"
  # Heure de la prochaine (crontab « minute heure * * * », heure du serveur) : elle lit la base, sans rien écrire.
  set -f; set -- $(echo "$taches" | grep sauvegarder | head -n 1); set +f
  if entier "${1:-}" && entier "${2:-}"; then
    maintenant=$(( $(date +%H | sed 's/^0//') * 60 + $(date +%M | sed 's/^0//') ))
    dans=$(( ($2 * 60 + $1 - maintenant + 1440) % 1440 ))
    echo "prochaine sauvegarde automatique : $(printf '%02d:%02d' "$2" "$1") (heure du serveur), dans $dans min"
    [ "$FENETRE_OUVERTE" = 0 ] || [ "$dans" -gt 60 ] || point ATTENTION "la sauvegarde automatique de la nuit démarre dans $dans min, pendant la fenêtre : elle ne fait que lire, mais retarde la migration"
  fi
else point ATTENTION "sauvegarde automatique chaque nuit : ABSENTE de la crontab"; fi
echo "-- minuteries du système"
systemctl list-timers --no-pager 2>/dev/null </dev/null | head -n 12
ue=$(systemctl is-enabled unattended-upgrades 2>/dev/null </dev/null)
majs=non
if pgrep -x dpkg >/dev/null 2>&1 || pgrep -f 'bin/unattended-upgrade( |$)' >/dev/null 2>&1; then majs=OUI; fi
echo "mises à jour automatiques d'Ubuntu : ${ue:-inconnu} ; installation de paquets en cours maintenant : $majs"
if [ "$majs" = OUI ]; then
  if [ "$FENETRE_OUVERTE" = 1 ]; then point BLOQUANT "installation de paquets d'Ubuntu en cours pendant la fenêtre : elle peut redémarrer des services ; attendez sa fin"
  else point ATTENTION "installation de paquets d'Ubuntu en cours : attendez sa fin avant d'ouvrir la fenêtre"; fi
fi
bj=""
[ "${CAHIORA_ESSAI_LOCAL:-}" = 1 ] || bj=$(dc exec -T api printenv BILLING_JOBS </dev/null 2>/dev/null | tr -d '\r')
echo "-- Tâches internes de l'API : la facturation toutes les heures ($([ "$bj" = off ] && echo arrêtée || echo active), clients réels seulement) et l'envoi des SMS (files ci-dessous) ; aucune autre tâche n'écrit"
afficher "SELECT kind AS tache_deja_faite, count(*) AS fois, to_char(max(\"createdAt\"), 'YYYY-MM-DD HH24:MI') AS derniere FROM billing_jobs GROUP BY kind ORDER BY 1" "tâches de la facturation"
if [ "$apres" = 1 ]; then
  concernes=$(val "SELECT count(*) FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id WHERE t.\"commercialStatus\" = 'CLIENT'")
  qui="client réel avec un abonnement"
else
  concernes=$(val "SELECT count(*) FROM subscriptions WHERE status::text IN ('TRIAL', 'PILOT')")
  qui="essai ou pilote en cours"
fi
if illisible "$concernes" "abonnements traités par la tâche horaire"; then :
elif [ "$concernes" = 0 ]; then point OK "tâche horaire de la facturation : rien à traiter (aucun $qui), aucune échéance commerciale active"
else point BLOQUANT "tâche horaire de la facturation : $concernes $qui (DS-3)"; fi
# Files de l'API dans Redis (« notifications » : SMS de repli au plus 10 minutes après la notification, nouvelles
# tentatives) : un envoi déjà programmé part même pendant la maintenance et s'inscrit dans sms_messages. Nombres seulement.
echo "-- Files de tâches de l'API (Redis)"
file=""; dernier=""
if [ "$(rc PING </dev/null 2>/dev/null | tr -d '\r')" = PONG ]; then
  files=$(rc --scan --pattern 'bull:*:meta' </dev/null 2>/dev/null | tr -d '\r' | sed 's/^bull://; s/:meta$//')
  files=$(printf '%s\nnotifications\n' "$files" | sed '/^$/d' | sort -u)
  file=0
  for q in $files; do
    s=0
    for k in wait active paused; do x=$(rc LLEN "bull:$q:$k" </dev/null 2>/dev/null | tr -d '\r'); if entier "$x"; then s=$((s + x)); else file=""; fi; done
    for k in delayed prioritized waiting-children; do x=$(rc ZCARD "bull:$q:$k" </dev/null 2>/dev/null | tr -d '\r'); if entier "$x"; then s=$((s + x)); else file=""; fi; done
    echo "file « $q » : $s tâche(s) en attente ou en cours"
    [ -z "$file" ] || file=$((file + s))
  done
  if [ -n "$file" ] && [ "$file" -gt 0 ]; then
    # Score d'un envoi différé : son heure (millisecondes) fois 4096, plus un compteur.
    score=$(rc ZRANGE bull:notifications:delayed -1 -1 WITHSCORES </dev/null 2>/dev/null | tr -d '\r' | sed -n 2p | cut -d. -f1)
    if entier "$score"; then dernier=" (le dernier SMS différé vers $(date -u -d "@$((score / 4096000))" '+%H:%M UTC' 2>/dev/null))"; fi
  fi
fi
if [ -z "$file" ]; then
  echo "files : ILLISIBLES (Redis ne répond pas)"
  if [ "$FENETRE_OUVERTE" = 1 ]; then point BLOQUANT "file des SMS ILLISIBLE pendant la fenêtre (Redis ne répond pas) : rien ne garantit qu'aucun envoi n'écrira ; ne commencez pas la sauvegarde"
  else point ATTENTION "file des SMS non lue (Redis ne répond pas) ; elle doit être lisible et vide pendant la fenêtre"; fi
elif [ "$file" = 0 ]; then point OK "files de l'API vides (lecture réussie) : aucun envoi déjà programmé"
elif [ "$FENETRE_OUVERTE" = 1 ]; then
  point BLOQUANT "$file tâche(s) programmée(s) avant la fenêtre partiront encore$dernier : attendez, puis relancez le contrôle avant les sauvegardes"
else point OK "files de l'API : $file envoi(s) en attente (normal, site ouvert ; elles doivent être vides pendant la fenêtre, avant les sauvegardes)"; fi
echo "-- Requêtes en cours dans la base (hors ce contrôle)"
FILTRE="pid <> pg_backend_pid() AND backend_type = 'client backend' AND datname = current_database()"
afficher "SELECT usename AS compte, state AS etat, (backend_xid IS NOT NULL) AS ecriture_commencee, split_part(ltrim(query), ' ', 1) AS ordre,
  to_char(now() - coalesce(xact_start, query_start), 'HH24:MI:SS') AS depuis FROM pg_stat_activity WHERE $FILTRE
  AND (backend_xid IS NOT NULL OR (usename IN ($COMPTES_APP) AND state <> 'idle')) ORDER BY 5 DESC" "requêtes en cours"
set -- $(val "SELECT count(*) FILTER (WHERE backend_xid IS NOT NULL) || ' ' ||
  count(*) FILTER (WHERE usename IN ($COMPTES_APP) AND (state = 'active' OR state LIKE 'idle in transaction%')) FROM pg_stat_activity WHERE $FILTRE")
if [ "$#" != 2 ] || ! entier "$1" || ! entier "$2"; then illisible "$ERR" "requêtes en cours dans la base"
elif [ "$1" = 0 ] && [ "$2" = 0 ]; then point OK "aucune écriture ni requête de l'application en cours dans la base"
elif [ "$FENETRE_OUVERTE" = 1 ]; then point BLOQUANT "pendant la fenêtre : $1 écriture(s) commencée(s) et $2 requête(s) de l'application en cours dans la base : attendez une minute et relancez le contrôle"
else echo "($1 écriture(s) et $2 requête(s) en cours : normal, site ouvert)"; fi
if [ "$apres" != 1 ] && [ -s "$ETAT/ecritures" ]; then
  echo "-- Écritures depuis l'ouverture de la fenêtre (compteurs relevés par maintenance.sh debut)"
  base=$(cat "$ETAT/ecritures")
  if [ "$compteurs_debut" = "$ERR" ]; then illisible "$ERR" "compteurs d'écritures de la base"
  else
    d=$(ecart "$base" "$compteurs_debut")
    if [ -z "$d" ]; then echo "aucune"; point OK "aucune écriture dans la base depuis l'ouverture de la fenêtre"
    else
      if printf '%s\n' "$d" | awk '$2 < 0 { e = 1 } END { exit !e }'; then
        echo "compteurs remis à zéro depuis l'ouverture (redémarrage de la base ?) : $(printf '%s\n' "$d" | grep -c .) table(s)"
        point ATTENTION "compteurs d'écritures remis à zéro depuis l'ouverture de la fenêtre (redémarrage de la base ?) : l'empreinte fait foi"
      elif printf '%s\n' "$d" | sed 's/^/  /' && [ -n "$(printf '%s\n' "$d" | scolaires)" ]; then
        point BLOQUANT "ÉCRITURES dans les tables de l'école depuis l'ouverture de la fenêtre : $(printf '%s\n' "$d" | scolaires | tr '\n' ' ')— envoyez-moi ce résultat"
      else point ATTENTION "écritures hors des tables de l'école depuis l'ouverture de la fenêtre : $(printf '%s\n' "$d" | tr '\n' ' ')"; fi
    fi
  fi
elif [ "$apres" = 1 ] && [ "$FENETRE_OUVERTE" = 1 ]; then
  echo "-- Écritures depuis l'ouverture de la fenêtre : la migration a écrit dans la base ; l'empreinte des données scolaires fait foi (partie 11)"
fi
echo "-- Accès directs : ports publiés par les conteneurs (seul caddy doit en avoir)"
if [ "${CAHIORA_ESSAI_LOCAL:-}" = 1 ]; then echo "(essai local : pas de Docker)"
else
  ports=$(dc ps --format '{{.Service}}|{{.Ports}}' </dev/null 2>/dev/null)
  if [ -z "$ports" ]; then illisible "$ERR" "ports des conteneurs"
  else
    printf '%s\n' "$ports" | sed 's/^/  /'
    directs=$(printf '%s\n' "$ports" | awk -F'|' '$1 != "caddy" && $2 ~ /->/ { print $1 }' | tr '\n' ' ')
    if [ -n "$directs" ]; then point BLOQUANT "accès direct possible sans passer par Caddy (port publié) : $directs"
    else point OK "seul Caddy est joignable de l'extérieur : l'API, la base et Redis n'ont aucun port publié"; fi
  fi
  ecoute=$(ss -Hltn 2>/dev/null </dev/null | awk '{ n = split($4, a, ":"); print a[n] }' | sort -un | tr '\n' ' ')
  echo "ports en écoute sur le serveur : ${ecoute:-illisibles}"
  [ -n "$ecoute" ] || point ATTENTION "ports en écoute sur le serveur illisibles (commande ss) : seuls les ports des conteneurs ont été vérifiés"
  for p in 3000 4000 5432 6379; do
    case " $ecoute " in *" $p "*) point BLOQUANT "le port $p (site, API, base ou Redis) est ouvert directement sur le serveur" ;; esac
  done
fi

echo
echo "== 9. Sauvegardes"
SAUV="${SAUVEGARDE_DIR:-$HOME/sauvegardes}"
derniere=$(ls -1t "$SAUV"/base-*.sql 2>/dev/null | head -n 1)
ok_base=non
if [ -z "$derniere" ]; then
  echo "aucune sauvegarde de la base dans $SAUV"
  point BLOQUANT "aucune sauvegarde de la base dans $SAUV"
else
  D=$(basename "$derniere" .sql); D=${D#base-}
  age=$(( ($(date +%s) - $(stat -c %Y "$derniere")) / 3600 ))
  echo "dernière sauvegarde : $D (il y a $age h) ; sauvegardes gardées : $(ls -1 "$SAUV"/base-*.sql | wc -l)"
  for f in "base-$D.sql" "fichiers-$D.tar.gz" "env-$D.txt"; do
    if [ -s "$SAUV/$f" ]; then echo "  $(du -h "$SAUV/$f" | cut -f1)  $f"; else echo "  MANQUANT  $f"; fi
  done
  tail -n 20 "$derniere" | grep -q "PostgreSQL database dump complete" && ok_base=oui
  ok_fich=non; gzip -t "$SAUV/fichiers-$D.tar.gz" 2>/dev/null && ok_fich=oui
  echo "base complète (dernière ligne de pg_dump présente) : $ok_base ; fichiers envoyés lisibles : $ok_fich"
  if [ -f "$SAUV/journal.log" ]; then
    echo "-- fin du journal des sauvegardes"; tail -n 4 "$SAUV/journal.log"
    erreurs=$(tail -n 200 "$SAUV/journal.log" | grep -c ERREUR)
    [ "$erreurs" = 0 ] || point ATTENTION "journal des sauvegardes : $erreurs ligne(s) ERREUR récente(s)"
  fi
  if [ "$ok_base" != oui ]; then point BLOQUANT "dernière sauvegarde de la base incomplète ($D)"
  elif [ "$ok_fich" != oui ] || [ ! -s "$SAUV/env-$D.txt" ]; then point ATTENTION "dernière sauvegarde : base complète, mais fichiers envoyés ou .env manquants ($D)"
  elif [ "$age" -gt 26 ]; then point ATTENTION "dernière sauvegarde complète, mais vieille de $age h ($D)"
  else point OK "sauvegarde de la nuit complète : base, fichiers envoyés et .env ($D, il y a $age h)"; fi
fi
echo "-- copies faites avant une mise à jour"
ls -1t "$HOME"/copie-avant-*.sql 2>/dev/null | head -n 3 | while IFS= read -r f; do echo "  $(du -h "$f" | cut -f1)  $f"; done
echo "-- copies chiffrées préparées pour l'ordinateur (copie-hors-serveur.sh)"
hors=$(ls -1t "$HOME"/copies-hors-serveur/cahiora-*.tar.enc 2>/dev/null | head -n 1)
if [ -n "$hors" ]; then
  jours=$(( ($(date +%s) - $(stat -c %Y "$hors")) / 86400 ))
  echo "  dernière : $(basename "$hors") (il y a $jours j)"
  if [ "$jours" -le 8 ]; then point OK "copie hors du VPS : la dernière a été préparée il y a $jours j (présence sur votre ordinateur à confirmer)"
  else point ATTENTION "copie hors du VPS : la dernière a été préparée il y a $jours j ; une nouvelle est prévue juste avant la mise à jour"; fi
else
  echo "  aucune"
  point ATTENTION "aucune copie chiffrée hors du VPS préparée sur le serveur ; une est prévue juste avant la mise à jour"
fi

echo
echo "== 10. Restauration possible ?"
for s in sauvegarder.sh sauvegarder-avant-maj.sh restaurer-copie.sh copie-hors-serveur.sh; do
  if [ -x "$ICI/$s" ]; then echo "$s : présent"; else echo "$s : ABSENT"; point BLOQUANT "script $s absent ou non exécutable"; fi
done
roles=$(val "SELECT string_agg(rolname, ' ' ORDER BY rolname) FROM pg_roles WHERE rolname IN ('erp_owner', 'erp_app', 'erp_platform', 'erp_group', 'erp_stats')")
echo "rôles de la base nécessaires à une restauration : $roles"
[ "$roles" = "erp_app erp_group erp_owner erp_platform erp_stats" ] || point BLOQUANT "rôles de la base incomplets ou illisibles pour une restauration : $roles"
tables=$(val "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")
taille=$(val "SELECT pg_database_size(current_database())")
entier "$tables" || illisible "$ERR" "nombre de tables de la base"
entier "$taille" || { illisible "$ERR" "taille de la base"; taille=0; }
echo "base en ligne : $tables tables, $(val "SELECT pg_size_pretty(pg_database_size(current_database()))") ; $(val "SELECT version()" | cut -d, -f1)"
taille_copie=$taille
if [ -n "$derniere" ]; then
  copies=$(grep -c '^COPY public\.' "$derniere")
  echo "dernière sauvegarde : $copies tables copiées"
  migree=$(val "SELECT coalesce(extract(epoch FROM max(finished_at))::bigint, 0) FROM _prisma_migrations")
  entier "$migree" || migree=0
  if [ "$copies" = "$tables" ] && [ "$ok_base" = oui ]; then point OK "dernière sauvegarde restaurable : $copies tables sur $tables, copie complète"
  elif [ "$ok_base" = oui ] && [ "$(stat -c %Y "$derniere")" -lt "$migree" ]; then
    point OK "dernière sauvegarde faite avant la dernière migration ($copies tables) : la prochaine copiera les $tables tables"
  else point ATTENTION "dernière sauvegarde : $copies tables copiées pour $tables dans la base"; fi
  taille_copie=$(stat -c %s "$derniere")
fi
libre=$(df -Pk "$HOME" | awk 'NR == 2 {print $4}')
entier "$libre" || libre=0
# Besoin : 4 copies de la base (copie, vérification, état avant restauration, copie chiffrée), 2 Go pour les fichiers et
# 4 Go pour les images Docker de la nouvelle version.
besoin=$(( (4 * taille_copie + 2 * taille) / 1024 + 6 * 1024 * 1024 ))
echo "place libre : $((libre / 1024 / 1024)) Go ; besoin estimé pour les copies et la mise à jour : $((besoin / 1024 / 1024 + 1)) Go"
if [ "$libre" -gt "$besoin" ]; then point OK "place libre suffisante : $((libre / 1024 / 1024)) Go"
else point BLOQUANT "place libre insuffisante ou illisible : $((libre / 1024 / 1024)) Go pour un besoin estimé de $((besoin / 1024 / 1024 + 1)) Go"; fi
echo "(la restauration d'essai se fait à l'étape de la sauvegarde, dans une base temporaire supprimée ensuite)"

echo
echo "== 11. Données scolaires (elles ne doivent pas changer avec la mise à jour)"
afficher "SELECT t.slug,
  (SELECT count(*) FROM users x WHERE x.tenant_id = t.id) AS comptes,
  (SELECT count(*) FROM students x WHERE x.tenant_id = t.id) AS eleves,
  (SELECT count(*) FROM enrollments x WHERE x.tenant_id = t.id) AS inscriptions,
  (SELECT count(*) FROM grades x WHERE x.tenant_id = t.id) AS notes,
  (SELECT count(*) FROM report_cards x WHERE x.tenant_id = t.id) AS bulletins,
  (SELECT count(*) FROM invoices x WHERE x.tenant_id = t.id) AS factures_familles,
  (SELECT count(*) FROM payments x WHERE x.tenant_id = t.id) AS paiements_familles,
  (SELECT count(*) FROM attendance_records x WHERE x.tenant_id = t.id) AS presences,
  (SELECT count(*) FROM sms_messages x WHERE x.tenant_id = t.id) AS sms
  FROM tenants t ORDER BY t.\"createdAt\"" "données scolaires par établissement"
# Empreinte : chaque ligne des 51 tables de l'école, sans les colonnes qui bougent à chaque connexion (users) ni celles
# ajoutées par la mise à jour (tenants). Elle doit compter exactement les 51 tables, sinon elle ne prouve rien.
EMPREINTES="WITH cols AS (
  SELECT c.table_name, string_agg(format('%I', c.column_name), ', ' ORDER BY c.ordinal_position) AS cols
  FROM information_schema.columns c
  JOIN information_schema.tables b ON b.table_schema = c.table_schema AND b.table_name = c.table_name AND b.table_type = 'BASE TABLE'
  WHERE c.table_schema = 'public'
    AND c.table_name IN ($LISTE_SQL)
    AND NOT (c.table_name = 'tenants' AND c.column_name IN ('commercialStatus', 'commercialStatusAt'))
    AND NOT (c.table_name = 'users' AND c.column_name IN ('failedLogins', 'lockedUntil', 'totpLastStep', 'lastLoginAt', 'updatedAt'))
  GROUP BY c.table_name
), e AS (
  SELECT table_name, query_to_xml(format('SELECT count(*) AS n, md5(coalesce(string_agg(h, %L ORDER BY h), %L)) AS h FROM (SELECT md5(ROW(%s)::text) AS h FROM %I) s',
    '', '', cols, table_name), false, true, '') AS x FROM cols
)
SELECT table_name AS t, (xpath('/row/n/text()', x))[1]::text::bigint AS n, (xpath('/row/h/text()', x))[1]::text AS h FROM e"
set -- $(val "SELECT left(md5(string_agg(t || ':' || h, ',' ORDER BY t)), 16) || ' ' || count(*) || ' ' || coalesce(sum(n), 0) FROM ($EMPREINTES) z")
if [ "$#" != 3 ] || ! printf '%s' "$1" | grep -qE '^[0-9a-f]{16}$' || ! entier "$2" || ! entier "$3"; then
  echo "empreinte des données scolaires : ÉCHEC du calcul"
  point BLOQUANT "empreinte des données scolaires NON CALCULÉE : rien ne prouve que les données de l'école sont intactes ; envoyez-moi ce résultat"
else
  empreinte=$1
  echo "empreinte des données scolaires : $1 ($2 tables, $3 lignes)"
  if [ "$2" != "$NB_TABLES_SCOLAIRES" ]; then
    absentes=$(val "SELECT string_agg(t, ' ') FROM unnest(ARRAY[$LISTE_SQL]) t WHERE to_regclass('public.' || t) IS NULL")
    point BLOQUANT "empreinte calculée sur $2 tables au lieu de $NB_TABLES_SCOLAIRES (absentes : ${absentes:-?}) : elle ne prouve rien ; envoyez-moi ce résultat"
  else
    attendue=$(printf '%s' "${EMPREINTE:-}" | tr 'A-F' 'a-f' | grep -oE '[0-9a-f]{16}' | head -n 1)
    if [ -n "${EMPREINTE:-}" ] && [ -z "$attendue" ]; then point BLOQUANT "empreinte attendue « $EMPREINTE » illisible (16 caractères 0-9 a-f)"
    elif [ -n "$attendue" ] && [ "$attendue" != "$empreinte" ]; then
      point BLOQUANT "empreinte des données scolaires $empreinte DIFFÉRENTE de celle relevée avant ($attendue) : gardez la fenêtre, envoyez-moi ce résultat (DETAIL=1 donne la table en cause)"
    elif [ -n "$attendue" ]; then point OK "empreinte des données scolaires identique à celle relevée avant : $empreinte ($2 tables sur $NB_TABLES_SCOLAIRES, $3 lignes)"
    else point OK "empreinte des données scolaires : $empreinte ($2 tables sur $NB_TABLES_SCOLAIRES, $3 lignes) ; elle doit rester la même après la mise à jour"; fi
  fi
fi
if [ "${DETAIL:-}" = 1 ]; then
  afficher "SELECT t AS \"table\", n AS lignes, left(h, 12) AS empreinte FROM ($EMPREINTES) z ORDER BY 1" "empreinte par table"
fi

echo
echo "== 12. Serveur"
if [ "${CAHIORA_ESSAI_LOCAL:-}" = 1 ]; then
  echo "(essai local)"
else
  uptime
  free -h | head -n 2
  df -h / | tail -n 1
  docker system df 2>/dev/null </dev/null | head -n 5
  echo "mises à jour d'Ubuntu en attente : $(apt list --upgradable 2>/dev/null </dev/null | grep -c upgradable)"
  if [ -f /var/run/reboot-required ]; then echo "redémarrage demandé par Ubuntu : oui"; else echo "redémarrage demandé par Ubuntu : non"; fi
fi

echo
echo "== 13. Écritures dans la base pendant ce contrôle"
compteurs_fin=$(compteurs)
if [ "$compteurs_debut" = "$ERR" ] || [ "$compteurs_fin" = "$ERR" ]; then
  if [ "$FENETRE_OUVERTE" = 1 ]; then illisible "$ERR" "compteurs d'écritures de la base"; else echo "(compteurs illisibles)"; fi
else
  d=$(ecart "$compteurs_debut" "$compteurs_fin")
  if [ -z "$d" ]; then
    echo "aucune"
    [ "$FENETRE_OUVERTE" = 0 ] || point OK "aucune écriture dans la base pendant ce contrôle"
  else
    printf '%s\n' "$d" | sed 's/^/  /'
    if [ "$FENETRE_OUVERTE" = 0 ]; then echo "(normal, site ouvert)"
    elif [ -n "$(printf '%s\n' "$d" | scolaires)" ]; then
      point BLOQUANT "ÉCRITURES dans les tables de l'école pendant ce contrôle, fenêtre ouverte : $(printf '%s\n' "$d" | scolaires | tr '\n' ' ')— envoyez-moi ce résultat"
    else point ATTENTION "écritures hors des tables de l'école pendant ce contrôle : $(printf '%s\n' "$d" | tr '\n' ' ')"; fi
  fi
fi

echo
echo "== RÉSUMÉ ($([ "$apres" = 1 ] && echo 'après' || echo 'avant') la mise à jour ; fenêtre de maintenance : $([ "$FENETRE_OUVERTE" = 1 ] && echo ouverte || echo fermée))"
printf '%s\n' "$RESUME" | sed '/^$/d'
echo "Points bloquants : $bloquants"
echo "Rien n'a été modifié : contrôle en lecture seule. Copiez tout ce qui s'affiche dans votre réponse (au moins ce résumé)."
if [ "$bloquants" != 0 ]; then echo "Code de sortie : 1 (au moins un point BLOQUANT)"; exit 1; fi
echo "Code de sortie : 0 (aucun point bloquant)"
exit 0
