#!/bin/sh
# CONTRÔLE FINAL DE LA PRODUCTION, EN LECTURE SEULE : ne modifie aucun fichier, aucune donnée, aucun service, aucun réglage.
# La base est ouverte en lecture seule (default_transaction_read_only) : toute écriture y serait refusée.
# Aucun secret n'est affiché : pour un mot de passe ou une clé, seulement « présent » ou « absent ».
# Contrôle : code en ligne, services, verrou des paiements, migrations, établissements, abonnements et autres données
# commerciales (DS-3), tâches planifiées, sauvegardes, possibilité de restauration, données scolaires (empreinte), serveur.
# À la fin, un résumé : OK, ATTENTION ou BLOQUANT pour chaque point.
# Il se relance tel quel juste avant et juste après la mise à jour : l'empreinte des données scolaires ne doit pas changer.
#
# Ce qu'il lit sans rien écrire : la base (psql en lecture seule), l'état des conteneurs (docker compose ps, exec printenv,
# exec node pour /api/v1/health), le .env (seulement « présent » ou « absent » pour un secret), git (log, rev-parse, status
# sans verrou ni mise à jour de l'index), la crontab, les minuteries, la file des SMS (redis-cli, nombres seulement),
# la place libre, les sauvegardes (lecture et gzip -t).
# Il n'arrête, ne démarre, ne recrée et ne reconfigure rien ; il n'installe rien ; il n'écrit aucun fichier.
#
# Sur le serveur (Terminal hPanel), sans rien changer au code en ligne, depuis un COMMIT EXACT (jamais une branche, qui
# peut bouger) : le rapport donne <COMMIT> (40 caractères) et l'empreinte sha256 attendue du script.
#   cd ~/ecole && git fetch -q origin <COMMIT> && git show <COMMIT>:controle-production.sh | sha256sum
#   (comparez avec l'empreinte du rapport ; si elle diffère, ne lancez rien)
#   sh -c "$(git show <COMMIT>:controle-production.sh)"
# git fetch n'ajoute que les objets de ce commit dans ~/ecole/.git : ni fichier du code en ligne, ni service, ni réglage.
# Une fois la mise à jour faite : cd ~/ecole && ./controle-production.sh
# Avec DETAIL=1 devant sh (ou devant ./controle-production.sh) : empreinte de chaque table de l'école en plus.

VERSION_REPETEE=fcb84eb
NOUVELLES="20261119120000_comptages_g5b 20261120090000_documents_g5c 20261121090000_acces_g5d1 20261122090000_paiements_g5d2 20261123090000_ajustements_g5"

if [ "${CAHIORA_ESSAI_LOCAL:-}" = 1 ]; then
  # Essais sur un ordinateur de développement seulement (base d'essai, sans Docker ni réseau).
  ICI=$(pwd)
  sql() { PGOPTIONS='-c default_transaction_read_only=on' psql -h "${PGHOST:-/tmp}" -U postgres -d "${BASE:-erp}" -X -q -P pager=off -v ON_ERROR_STOP=1 "$@"; }
  dc() { return 1; }
  rc() { redis-cli "$@"; }
else
  cd "$HOME/ecole" 2>/dev/null || { echo "Dossier ~/ecole introuvable"; exit 1; }
  ICI="$HOME/ecole"
  sql() { docker compose exec -T -e PGOPTIONS='-c default_transaction_read_only=on' postgres psql -U postgres -d erp -X -q -P pager=off -v ON_ERROR_STOP=1 "$@"; }
  dc() { docker compose "$@"; }
  rc() { docker compose exec -T redis redis-cli "$@"; }
fi
# val <requête> : une seule valeur, sans mise en forme (vide si la requête échoue).
val() { sql -At -c "$1" </dev/null 2>/dev/null | tr -d '\r'; }
# lignes <table> [condition] : nombre de lignes, ou « - » si la table n'existe pas encore.
lignes() {
  if [ "$(val "SELECT to_regclass('public.$1') IS NOT NULL")" = t ]; then val "SELECT count(*) FROM $1 ${2:-}"; else echo -; fi
}
env_val() { grep "^$1=" "$ICI/.env" 2>/dev/null | tail -n 1 | cut -d= -f2- | sed "s/^[\"']//; s/[\"']\$//"; }
present() { if grep -q "^$1=." "$ICI/.env" 2>/dev/null; then echo présent; else echo absent; fi; }

RESUME=""
bloquants=0
maintenance=non
point() { # point OK|ATTENTION|BLOQUANT <texte>
  RESUME="$RESUME
$(printf '%-9s %s' "$1" "$2")"
  if [ "$1" = BLOQUANT ]; then bloquants=$((bloquants + 1)); fi
}

echo "Contrôle final de la production, en lecture seule : $(date -u '+%Y-%m-%d %H:%M UTC')"
if [ "$(val "SELECT 1")" != 1 ]; then
  echo "La base ne répond pas : contrôle impossible. Rien n'a été modifié."
  exit 1
fi
apres=$(val "SELECT count(*) FROM _prisma_migrations WHERE migration_name = '20261123090000_ajustements_g5' AND finished_at IS NOT NULL AND rolled_back_at IS NULL")
if [ "$apres" = 1 ]; then echo "Moment : APRÈS la mise à jour (migration des ajustements appliquée)"; else echo "Moment : AVANT la mise à jour"; fi

echo
echo "== 1. Code en ligne"
code=$(git -C "$ICI" rev-parse --short=7 HEAD </dev/null 2>/dev/null)
git -C "$ICI" log -1 --format='%h %ad %s' --date=iso </dev/null 2>/dev/null
echo "branche : $(git -C "$ICI" rev-parse --abbrev-ref HEAD </dev/null 2>/dev/null)"
modifs=$(git -C "$ICI" --no-optional-locks status --short --untracked-files=no </dev/null 2>/dev/null | head -n 10)
if [ -n "$modifs" ]; then
  echo "fichiers suivis modifiés sur le serveur :"; printf '%s\n' "$modifs"
  point ATTENTION "fichiers du code modifiés à la main sur le serveur (voir partie 1)"
else
  echo "fichiers suivis modifiés sur le serveur : aucun"
fi
if [ "$apres" = 1 ]; then
  point OK "code en ligne : $code (après la mise à jour)"
elif [ "$code" = "$VERSION_REPETEE" ]; then
  point OK "code en ligne : $code, la version sur laquelle la mise à jour a été répétée"
else
  point BLOQUANT "code en ligne : ${code:-inconnu} au lieu de $VERSION_REPETEE (version répétée) : envoyez-moi ce résultat avant toute suite"
fi

echo
echo "== 2. Services"
if [ "${CAHIORA_ESSAI_LOCAL:-}" = 1 ]; then
  echo "(essai local : pas de Docker ; site d'essai : ${ESSAI_URL:-aucun})"
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
fi
# Réponse réelle du site (et fenêtre de maintenance ouverte par maintenance.sh : en-tête X-Cahiora-Maintenance).
dom=$(env_val PLATFORM_DOMAIN)
dom=${dom:-cahiora.com}
sites="https://$dom/plateforme/connexion https://saint-kisito.$dom/connexion"
curl_essai=""
if [ "${CAHIORA_ESSAI_LOCAL:-}" = 1 ]; then sites=""; [ -z "${ESSAI_URL:-}" ] || { sites="$ESSAI_URL/plateforme/connexion $ESSAI_URL/connexion"; curl_essai="-k --noproxy localhost"; }; fi
if [ -n "$sites" ]; then
  for u in $sites; do
    r=$(curl $curl_essai -s -o /dev/null -m 20 -D - -w 'code=%{http_code}' "$u" </dev/null | tr -d '\r')
    c=$(printf '%s\n' "$r" | sed -n 's/^code=//p' | tail -n 1)
    if printf '%s\n' "$r" | grep -qi '^x-cahiora-maintenance: *oui'; then
      maintenance=oui; echo "$u : $c (fenêtre de maintenance)"
    else
      echo "$u : $c"
      [ "$c" = 200 ] || point ATTENTION "$u répond $c au lieu de 200"
    fi
  done
  if [ "$maintenance" = oui ]; then point OK "fenêtre de maintenance ouverte : le site répond « maintenance », aucune écriture scolaire possible"
  else echo "fenêtre de maintenance : fermée (le site est ouvert)"; fi
fi

echo
echo "== 3. Verrou des paiements et réglages (.env, sans aucune valeur secrète)"
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
echo "== 4. Migrations"
sql </dev/null -c "SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS appliquees,
  count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS en_echec,
  count(*) FILTER (WHERE rolled_back_at IS NOT NULL) AS annulees_autrefois FROM _prisma_migrations"
sql </dev/null -c "SELECT migration_name AS derniere_migration, to_char(finished_at, 'YYYY-MM-DD HH24:MI') AS le FROM _prisma_migrations
  WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at DESC LIMIT 1"
appliquees=$(val "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")
echec=$(val "SELECT string_agg(migration_name, ' ') FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL")
manquantes=$(val "SELECT string_agg(nom, ' ') FROM (VALUES ('20261018211319_init'), ('20261018211400_rls'), ('20261018213000_payment_routes'),
  ('20261019233527_parametrage_stages_ateliers'), ('20261020003000_plateforme'), ('20261020010000_plateforme_mot_de_passe'), ('20261021210000_frais_public_cible'),
  ('20261021220000_matieres_professeurs'), ('20261021230000_fin_annee'), ('20261021233000_eleves_honneur'), ('20261022231500_photo_pieces_eleve'),
  ('20261106100000_photo_site'), ('20261106140000_securite_lot2'), ('20261106160000_securite_lot3'), ('20261106180000_securite_lot6'),
  ('20261106190000_securite_lot8'), ('20261106200000_securite_lot13'), ('20261108200000_recuperation_2fa'), ('20261110120000_sms_parents'),
  ('20261112220000_groupes_g1'), ('20261113100000_groupes_g2_comptes'), ('20261113140000_reinscription_g4'), ('20261113190000_reinscription_g4_corrections'),
  ('20261114120000_facturation_g5a'), ('20261114180000_prestations_g5g')) a(nom)
  WHERE nom NOT IN (SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)")
echo "-- Les cinq migrations de la mise à jour (PR #13 à #17)"
nouvelles=0
for m in $NOUVELLES; do
  le=$(val "SELECT to_char(max(finished_at), 'YYYY-MM-DD HH24:MI') FROM _prisma_migrations WHERE migration_name = '$m' AND finished_at IS NOT NULL AND rolled_back_at IS NULL")
  if [ -n "$le" ]; then echo "$m : appliquée le $le"; nouvelles=$((nouvelles + 1)); else echo "$m : pas encore appliquée"; fi
done
if [ -n "$echec" ]; then
  point BLOQUANT "migration interrompue : $echec en échec, $nouvelles des 5 nouvelles terminées. Gardez la maintenance, ne relancez rien, envoyez-moi ce résultat (procédure « migration interrompue »)"
elif [ -n "$manquantes" ]; then
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
echo "== 5. Établissements"
sql </dev/null -c "SELECT t.slug, t.name AS nom, t.status AS etat,
  coalesce(to_jsonb(t)->>'commercialStatus', 'pas encore (TEST à la migration)') AS statut_commercial,
  g.name AS groupe, to_char(t.\"createdAt\", 'YYYY-MM-DD') AS cree_le
  FROM tenants t LEFT JOIN school_groups g ON g.id = t.group_id ORDER BY t.\"createdAt\""
echo "-- Comptes Super Admin (nom et domaine de l'adresse seulement ; aucun secret)"
sql </dev/null -c "SELECT a.name AS nom, '…@' || split_part(a.email, '@', 2) AS adresse, a.active AS actif, a.\"totpEnabled\" AS double_authentification,
  a.\"mustSetupTwoFactor\" AS nouvelle_2fa_exigee, (SELECT count(*) FROM platform_recovery_codes r WHERE r.\"adminId\" = a.id AND r.\"usedAt\" IS NULL) AS codes_secours_restants,
  to_char(a.\"lastLoginAt\", 'YYYY-MM-DD') AS derniere_connexion FROM platform_admins a ORDER BY a.\"createdAt\""
admins=$(val "SELECT count(*) FROM platform_admins")
sans2fa=$(val "SELECT string_agg(name, ', ' ORDER BY \"createdAt\") FROM platform_admins WHERE active AND (NOT \"totpEnabled\" OR \"mustSetupTwoFactor\")")
inactifs=$(val "SELECT string_agg(name, ', ' ORDER BY \"createdAt\") FROM platform_admins WHERE NOT active AND NOT \"totpEnabled\"")
if [ "${admins:-0}" = 0 ]; then point BLOQUANT "aucun compte Super Admin trouvé"
elif [ -n "$sans2fa" ]; then point BLOQUANT "compte(s) Super Admin actif(s) SANS double authentification active, ou à reconfigurer après une récupération : $sans2fa (à faire avant la mise à jour)"
else point OK "double authentification active pour tous les comptes Super Admin actifs ($admins compte(s) en tout)"; fi
[ -z "$inactifs" ] || point ATTENTION "compte(s) Super Admin désactivé(s) sans double authentification : $inactifs (ils ne peuvent pas se connecter ; à activer s'ils sont réactivés)"
nb=$(val "SELECT count(*) FROM tenants")
if [ "$nb" = 1 ]; then etabs="l'établissement est"; else etabs="les $nb établissements sont"; fi
if [ "$apres" = 1 ]; then
  clients=$(val "SELECT count(*) FROM tenants WHERE \"commercialStatus\" <> 'TEST'")
  if [ "$clients" = 0 ]; then point OK "$etabs en statut TEST : ni facturés, ni limités"
  else point BLOQUANT "$clients établissement(s) en client réel au lieu de TEST"; fi
else
  point OK "$nb établissement(s), tous passés en TEST par la migration (statut posé pour tous, sans exception)"
fi

echo
echo "== 6. Abonnements et autres données commerciales (DS-3)"
echo "-- Abonnements (essai, pilote, abonnement)"
sql </dev/null -c "SELECT t.slug, s.status AS etat, s.\"trialStart\" AS essai_du, s.\"trialEnd\" AS essai_au, s.\"pilotStart\" AS pilote_du,
  s.\"pilotEnd\" AS pilote_au, (s.\"acceptedAt\" IS NOT NULL) AS conditions_acceptees, to_char(s.\"createdAt\", 'YYYY-MM-DD HH24:MI') AS ouvert_le
  FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id ORDER BY s.\"createdAt\""
echo "-- Données commerciales : lignes par table (« - » : table créée par la mise à jour)"
for t in subscriptions subscription_events billing_calendars commercial_terms billing_parameters billing_jobs platform_alerts \
  services service_versions service_rates service_rate_ends billing_counts count_corrections billing_documents billing_document_lines \
  billing_exclusion_links regularization_requests billing_payment_means billing_payments billing_allocations billing_credit_entries \
  billing_refunds billing_credit_transfers; do
  echo "$t : $(lignes $t)"
done
echo "-- Calendriers de facturation (échéances de comptage et de régularisation, sans effet sans abonnement)"
sql </dev/null -c "SELECT t.slug, c.\"yearLabel\" AS annee, max(c.version) AS version, max(c.\"initialCountDate\") AS comptage,
  max(c.\"firstRegularizationDate\") AS regularisation_1, max(c.\"finalRegularizationDate\") AS regularisation_2
  FROM billing_calendars c JOIN tenants t ON t.id = c.tenant_id GROUP BY t.slug, c.\"yearLabel\" ORDER BY 1, 2"
echo "-- Conditions commerciales enregistrées (titre et date seulement)"
sql </dev/null -c "SELECT version, title AS titre, \"effectiveFrom\" AS en_vigueur_le FROM commercial_terms ORDER BY version"
abos=$(lignes subscriptions)
if [ "$abos" = 0 ]; then
  point OK "DS-3 : aucun abonnement en production, la mise à jour n'est pas bloquée"
else
  detail=$(val "SELECT string_agg(t.slug || ' ' || s.status, ', ' ORDER BY s.\"createdAt\") FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id")
  if [ "$apres" = 1 ]; then quand="avant le passage de ces établissements en client réel"; else quand="avant la mise à jour"; fi
  point BLOQUANT "DS-3 : $abos abonnement(s) en production ($detail) : ARRÊT de la procédure ; je vous soumets le plan DS-3 $quand, rien n'est réinitialisé sans votre accord"
fi
pilote=$(val "SELECT count(*) FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id WHERE t.slug = 'saint-kisito' AND (s.status::text = 'PILOT' OR s.\"pilotStart\" IS NOT NULL)")
if [ "$pilote" = 0 ]; then point OK "pilote de Saint Kisito non activé"; else point BLOQUANT "un pilote est enregistré pour Saint Kisito (DS-3, DS-4)"; fi
delais=$(val "SELECT count(*) FROM billing_parameters WHERE key IN ('COMPLEMENT_DUE_DAYS', 'SERVICE_DUE_DAYS')")
if [ "$delais" = 0 ]; then point OK "délais de paiement DS-2 (30 j compléments, 15 j prestations) non activés"
else point ATTENTION "délai DS-2 déjà saisi ($delais version(s)) : il ne devait pas l'être avant la validation des conditions commerciales"; fi
docs=$(lignes billing_documents); pays=$(lignes billing_payments); moyens=$(lignes billing_payment_means)
if [ "$docs" = - ]; then
  point OK "aucun document ni paiement de Cahiora (la version en ligne n'en produit pas)"
else
  if [ "$docs" = 0 ] && [ "$pays" = 0 ]; then point OK "aucun document ni paiement de Cahiora"
  else point ATTENTION "documents de Cahiora : $docs, paiements : $pays (aucun attendu)"; fi
  if [ "$moyens" = 0 ]; then point OK "aucun moyen de paiement enregistré"
  else point BLOQUANT "$moyens version(s) de moyen de paiement enregistrée(s) : aucune n'est attendue"; fi
fi
echo "-- SMS des 30 derniers jours, par type (ni numéro ni texte) : Cahiora n'envoie aucun SMS commercial (aucun type de facturation)"
sql </dev/null -c "SELECT kind AS type_sms, status AS etat, count(*) AS nombre FROM sms_messages WHERE \"createdAt\" > now() - interval '30 days' GROUP BY 1, 2 ORDER BY 1, 2"
commerciaux=$(val "SELECT count(*) FROM sms_messages WHERE kind ILIKE ANY (ARRAY['%billing%', '%subscription%', '%abonnement%', '%factur%', '%commercial%'])")
if [ "${commerciaux:-0}" = 0 ]; then point OK "aucun SMS commercial de Cahiora"
else point BLOQUANT "$commerciaux SMS de type facturation ou abonnement trouvés : aucun n'est attendu"; fi

echo
echo "== 7. Tâches planifiées"
echo "-- crontab de $(id -un) (lignes actives)"
taches=$(crontab -l 2>/dev/null </dev/null | grep -v '^[[:space:]]*#' | grep -v '^[[:space:]]*$')
if [ -n "$taches" ]; then printf '%s\n' "$taches"; else echo "(aucune)"; fi
echo "-- /etc/cron.d : $(ls /etc/cron.d 2>/dev/null | tr '\n' ' ')"
echo "-- minuteries du système"
systemctl list-timers --no-pager 2>/dev/null </dev/null | head -n 12
ue=$(systemctl is-enabled unattended-upgrades 2>/dev/null </dev/null)
echo "mises à jour automatiques d'Ubuntu : ${ue:-inconnu}"
if echo "$taches" | grep -q sauvegarder; then point OK "sauvegarde automatique chaque nuit : active"
else point ATTENTION "sauvegarde automatique chaque nuit : ABSENTE de la crontab"; fi
bj=""
[ "${CAHIORA_ESSAI_LOCAL:-}" = 1 ] || bj=$(dc exec -T api printenv BILLING_JOBS </dev/null 2>/dev/null | tr -d '\r')
echo "-- Tâche horaire de la facturation, dans l'API : $([ "$bj" = off ] && echo arrêtée || echo 'active (toutes les heures)')"
sql </dev/null -c "SELECT kind AS tache_deja_faite, count(*) AS fois, to_char(max(\"createdAt\"), 'YYYY-MM-DD HH24:MI') AS derniere FROM billing_jobs GROUP BY kind ORDER BY 1"
if [ "$apres" = 1 ]; then
  concernes=$(val "SELECT count(*) FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id WHERE t.\"commercialStatus\" = 'CLIENT'")
  qui="client réel avec un abonnement"
else
  concernes=$(val "SELECT count(*) FROM subscriptions WHERE status::text IN ('TRIAL', 'PILOT')")
  qui="essai ou pilote en cours"
fi
if [ "$concernes" = 0 ]; then point OK "tâches planifiées de la facturation : rien à traiter (aucun $qui), aucune échéance commerciale active"
else point BLOQUANT "tâches planifiées de la facturation : $concernes $qui (DS-3)"; fi
# SMS déjà programmés par l'API (file « notifications » : SMS de repli au plus 10 minutes après la notification, nouvelles
# tentatives) : ils partent même pendant la maintenance et s'inscrivent dans sms_messages. Lecture des nombres seulement.
file=""
f1=$(rc LLEN bull:notifications:wait </dev/null 2>/dev/null | tr -d '\r')
f2=$(rc LLEN bull:notifications:active </dev/null 2>/dev/null | tr -d '\r')
f3=$(rc ZCARD bull:notifications:delayed </dev/null 2>/dev/null | tr -d '\r')
f4=$(rc ZCARD bull:notifications:prioritized </dev/null 2>/dev/null | tr -d '\r')
f5=$(rc LLEN bull:notifications:paused </dev/null 2>/dev/null | tr -d '\r')
case "$f1:$f2:$f3:$f4:$f5" in
  *[!0-9:]* | :* | *::* | *:) ;;
  *) file=$((f1 + f2 + f3 + f4 + f5)) ;;
esac
dernier=""
if [ -n "$file" ] && [ "$f3" -gt 0 ]; then
  # Score d'un envoi différé : son heure (millisecondes) fois 4096, plus un compteur.
  score=$(rc ZRANGE bull:notifications:delayed -1 -1 WITHSCORES </dev/null 2>/dev/null | tr -d '\r' | sed -n 2p | cut -d. -f1)
  case "$score" in '' | *[!0-9]*) ;; *) dernier=" (le dernier vers $(date -u -d "@$((score / 4096000))" '+%H:%M UTC' 2>/dev/null))" ;; esac
fi
if [ -n "$file" ]; then echo "-- file des SMS de l'application : $file envoi(s) en attente$dernier"; else echo "-- file des SMS de l'application : non lue"; fi
if [ -z "$file" ]; then point ATTENTION "file des SMS non lue (Redis ne répond pas)"
elif [ "$file" = 0 ]; then point OK "file des SMS vide : aucun envoi déjà programmé"
elif [ "$maintenance" = oui ]; then
  point BLOQUANT "$file SMS programmé(s) avant la fenêtre partiront encore$dernier : attendez, puis relancez le contrôle avant les sauvegardes"
else point OK "file des SMS : $file envoi(s) en attente (normal, site ouvert ; la file doit être vide pendant la fenêtre, avant les sauvegardes)"; fi

echo
echo "== 8. Sauvegardes"
SAUV="${SAUVEGARDE_DIR:-$HOME/sauvegardes}"
derniere=$(ls -1t "$SAUV"/base-*.sql 2>/dev/null | head -n 1)
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
  ok_base=non; tail -n 20 "$derniere" | grep -q "PostgreSQL database dump complete" && ok_base=oui
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
echo "== 9. Restauration possible ?"
for s in sauvegarder.sh sauvegarder-avant-maj.sh restaurer-copie.sh copie-hors-serveur.sh; do
  if [ -x "$ICI/$s" ]; then echo "$s : présent"; else echo "$s : ABSENT"; point BLOQUANT "script $s absent ou non exécutable"; fi
done
roles=$(val "SELECT string_agg(rolname, ' ' ORDER BY rolname) FROM pg_roles WHERE rolname IN ('erp_owner', 'erp_app', 'erp_platform', 'erp_group', 'erp_stats')")
echo "rôles de la base nécessaires à une restauration : $roles"
[ "$roles" = "erp_app erp_group erp_owner erp_platform erp_stats" ] || point BLOQUANT "rôles de la base incomplets pour une restauration : $roles"
tables=$(val "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")
taille=$(val "SELECT pg_database_size(current_database())")
echo "base en ligne : $tables tables, $(val "SELECT pg_size_pretty(pg_database_size(current_database()))") ; $(val "SELECT version()" | cut -d, -f1)"
if [ -n "$derniere" ]; then
  copies=$(grep -c '^COPY public\.' "$derniere")
  echo "dernière sauvegarde : $copies tables copiées"
  migree=$(val "SELECT coalesce(extract(epoch FROM max(finished_at))::bigint, 0) FROM _prisma_migrations")
  if [ "$copies" = "$tables" ] && [ "$ok_base" = oui ]; then point OK "dernière sauvegarde restaurable : $copies tables sur $tables, copie complète"
  elif [ "$ok_base" = oui ] && [ "$(stat -c %Y "$derniere")" -lt "${migree:-0}" ]; then
    point OK "dernière sauvegarde faite avant la dernière migration ($copies tables) : la prochaine copiera les $tables tables"
  else point ATTENTION "dernière sauvegarde : $copies tables copiées pour $tables dans la base"; fi
  taille_copie=$(stat -c %s "$derniere")
else
  taille_copie=${taille:-0}
fi
libre=$(df -Pk "$HOME" | awk 'NR == 2 {print $4}')
# Besoin : 4 copies de la base (copie, vérification, état avant restauration, copie chiffrée), 2 Go pour les fichiers et
# 4 Go pour les images Docker de la nouvelle version.
besoin=$(( (4 * ${taille_copie:-0} + 2 * ${taille:-0}) / 1024 + 6 * 1024 * 1024 ))
echo "place libre : $((libre / 1024 / 1024)) Go ; besoin estimé pour les copies et la mise à jour : $((besoin / 1024 / 1024 + 1)) Go"
if [ "$libre" -gt "$besoin" ]; then point OK "place libre suffisante : $((libre / 1024 / 1024)) Go"
else point BLOQUANT "place libre insuffisante : $((libre / 1024 / 1024)) Go pour un besoin estimé de $((besoin / 1024 / 1024 + 1)) Go"; fi
echo "(la restauration d'essai se fait à l'étape de la sauvegarde, dans une base temporaire supprimée ensuite)"

echo
echo "== 10. Données scolaires (elles ne doivent pas changer avec la mise à jour)"
sql </dev/null -c "SELECT t.slug,
  (SELECT count(*) FROM users x WHERE x.tenant_id = t.id) AS comptes,
  (SELECT count(*) FROM students x WHERE x.tenant_id = t.id) AS eleves,
  (SELECT count(*) FROM enrollments x WHERE x.tenant_id = t.id) AS inscriptions,
  (SELECT count(*) FROM grades x WHERE x.tenant_id = t.id) AS notes,
  (SELECT count(*) FROM report_cards x WHERE x.tenant_id = t.id) AS bulletins,
  (SELECT count(*) FROM invoices x WHERE x.tenant_id = t.id) AS factures_familles,
  (SELECT count(*) FROM payments x WHERE x.tenant_id = t.id) AS paiements_familles,
  (SELECT count(*) FROM attendance_records x WHERE x.tenant_id = t.id) AS presences,
  (SELECT count(*) FROM sms_messages x WHERE x.tenant_id = t.id) AS sms
  FROM tenants t ORDER BY t.\"createdAt\""
# Empreinte : chaque ligne des tables de l'école (paramètres, comptes, élèves, notes, bulletins, finances des familles…),
# sans les colonnes qui bougent à chaque connexion (users) ni celles ajoutées par la mise à jour (tenants).
EMPREINTES="WITH cols AS (
  SELECT c.table_name, string_agg(format('%I', c.column_name), ', ' ORDER BY c.ordinal_position) AS cols
  FROM information_schema.columns c
  JOIN information_schema.tables b ON b.table_schema = c.table_schema AND b.table_name = c.table_name AND b.table_type = 'BASE TABLE'
  WHERE c.table_schema = 'public'
    AND c.table_name IN ('academic_years', 'announcements', 'annual_decisions', 'applications', 'appreciations', 'assessments',
      'attendance_records', 'attendance_sessions', 'cash_closings', 'class_subjects', 'classes', 'counters', 'documents', 'duplicate_reviews',
      'enrollment_events', 'enrollments', 'fee_types', 'grades', 'guardians', 'internship_periods', 'internship_placements', 'invoice_items',
      'invoices', 'lessons', 'levels', 'payment_routes', 'payments', 'public_honors', 'receipts', 'report_card_items', 'report_card_runs',
      'report_cards', 'rooms', 'sanctions', 'school_groups', 'sites', 'sms_messages', 'student_files', 'student_guardians', 'students',
      'subjects', 'teacher_assignments', 'teacher_subjects', 'tenants', 'terms', 'timetable_changes', 'timetable_slots', 'tracks',
      'user_roles', 'users', 'verification_entries')
    AND NOT (c.table_name = 'tenants' AND c.column_name IN ('commercialStatus', 'commercialStatusAt'))
    AND NOT (c.table_name = 'users' AND c.column_name IN ('failedLogins', 'lockedUntil', 'totpLastStep', 'lastLoginAt', 'updatedAt'))
  GROUP BY c.table_name
), e AS (
  SELECT table_name, query_to_xml(format('SELECT count(*) AS n, md5(coalesce(string_agg(h, %L ORDER BY h), %L)) AS h FROM (SELECT md5(ROW(%s)::text) AS h FROM %I) s',
    '', '', cols, table_name), false, true, '') AS x FROM cols
)
SELECT table_name AS t, (xpath('/row/n/text()', x))[1]::text::bigint AS n, (xpath('/row/h/text()', x))[1]::text AS h FROM e"
empreinte=$(val "SELECT left(md5(string_agg(t || ':' || h, ',' ORDER BY t)), 16) || ' (' || count(*) || ' tables, ' || sum(n) || ' lignes)' FROM ($EMPREINTES) z")
echo "empreinte des données scolaires : ${empreinte:-ÉCHEC du calcul}"
if [ -n "$empreinte" ]; then point OK "empreinte des données scolaires : $empreinte (doit rester la même après la mise à jour)"
else point ATTENTION "empreinte des données scolaires non calculée"; fi
if [ "${DETAIL:-}" = 1 ]; then
  sql </dev/null -c "SELECT t AS \"table\", n AS lignes, left(h, 12) AS empreinte FROM ($EMPREINTES) z ORDER BY 1"
fi

echo
echo "== 11. Serveur"
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
echo "== RÉSUMÉ ($([ "$apres" = 1 ] && echo 'après' || echo 'avant') la mise à jour ; fenêtre de maintenance : $([ "$maintenance" = oui ] && echo ouverte || echo fermée))"
printf '%s\n' "$RESUME" | sed '/^$/d'
echo "Points bloquants : $bloquants"
echo "Rien n'a été modifié : contrôle en lecture seule. Copiez tout ce qui s'affiche dans votre réponse (au moins ce résumé)."
