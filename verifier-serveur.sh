#!/bin/sh
# Vérification du serveur avant une mise à jour. LECTURE SEULE : ne modifie aucun fichier, aucune donnée, aucun service.
# - code en ligne (dernier commit, branche, fichiers modifiés), services, disque, sauvegardes ;
# - réglages du fichier .env dont la prochaine version a besoin (présent ou absent, jamais la valeur d'un secret) ;
# - base : migrations, écoles, volumes par école, comptes Super Admin, lignes par table, taille.
# La base est ouverte en lecture seule (default_transaction_read_only) : toute écriture y serait refusée.
#
# Sur le serveur (Terminal hPanel), sans rien changer au dossier ~/ecole :
#   cd ~/ecole && git fetch -q origin claude/project-thread-45wtn6-verif && git show FETCH_HEAD:verifier-serveur.sh | sh
# Une fois le script dans la version en ligne : ./verifier-serveur.sh
cd "$HOME/ecole" 2>/dev/null || { echo "Dossier ~/ecole introuvable"; exit 1; }

echo "== Code en ligne"
git log -1 --format='%h %ad %s' --date=iso </dev/null
echo "branche : $(git rev-parse --abbrev-ref HEAD </dev/null)"
git status --short </dev/null | head -10

echo "== Services"
docker compose ps --format '{{.Service}} : {{.Status}}' </dev/null

echo "== Disque et fichiers envoyés"
df -h / | tail -1
docker compose exec -T api sh -c 'du -sh "${STORAGE_DIR:-/repo/apps/api/storage}" 2>/dev/null' </dev/null

echo "== Sauvegardes"
ls -1t "$HOME/sauvegardes" 2>/dev/null | head -3
if crontab -l 2>/dev/null | grep -q sauvegarder; then echo "sauvegarde chaque nuit : active"; else echo "sauvegarde chaque nuit : ABSENTE"; fi
ls -1t "$HOME"/copie-avant-*.sql 2>/dev/null | head -2

echo "== Réglages (.env)"
for k in PRODUCTION_SERVER PLATFORM_DOMAIN SMS_PROVIDER ENFORCE_2FA; do
  echo "$k = $(grep "^$k=" .env | cut -d= -f2-)"
done
for k in ERP_PLATFORM_PASSWORD ERP_GROUP_PASSWORD ERP_STATS_PASSWORD APP_ENCRYPTION_KEY; do
  if grep -q "^$k=." .env; then echo "$k : présent"; else echo "$k : absent"; fi
done

echo "== Base (lecture seule)"
docker compose exec -T -e PGOPTIONS='-c default_transaction_read_only=on' postgres \
  psql -X -q -P pager=off -v ON_ERROR_STOP=1 -U postgres -d erp <<'SQL'
\echo '-- Migrations'
SELECT count(*) AS appliquees, count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) AS inachevees FROM _prisma_migrations;
SELECT migration_name AS derniere_migration, to_char(finished_at, 'YYYY-MM-DD HH24:MI') AS le FROM _prisma_migrations ORDER BY finished_at DESC NULLS FIRST LIMIT 1;
\echo '-- Écoles'
SELECT slug, name AS nom, status AS etat, to_char("createdAt", 'YYYY-MM-DD') AS creee,
       CASE WHEN settings->>'demo' = 'true' THEN 'oui' ELSE 'non' END AS demo
FROM tenants ORDER BY "createdAt";
\echo '-- Données par école'
SELECT t.slug,
  (SELECT count(*) FROM users x WHERE x.tenant_id = t.id) AS comptes,
  (SELECT count(*) FROM students x WHERE x.tenant_id = t.id) AS eleves,
  (SELECT count(*) FROM enrollments x WHERE x.tenant_id = t.id) AS inscriptions,
  (SELECT count(*) FROM invoices x WHERE x.tenant_id = t.id) AS factures_parents,
  (SELECT count(*) FROM payments x WHERE x.tenant_id = t.id) AS paiements,
  (SELECT count(*) FROM grades x WHERE x.tenant_id = t.id) AS notes,
  (SELECT count(*) FROM sms_messages x WHERE x.tenant_id = t.id) AS sms,
  (SELECT to_char(max(x."createdAt"), 'YYYY-MM-DD') FROM audit_logs x WHERE x.tenant_id = t.id) AS derniere_action
FROM tenants t ORDER BY t."createdAt";
\echo '-- Comptes Super Admin'
SELECT count(*) AS comptes, count(*) FILTER (WHERE active) AS actifs, count(*) FILTER (WHERE "totpEnabled") AS double_authentification FROM platform_admins;
\echo '-- Lignes par table (tables non vides)'
SELECT table_name AS "table", lignes FROM (
  SELECT table_name, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I', table_name), false, true, '')))[1]::text::bigint AS lignes
  FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE') x
WHERE lignes > 0 ORDER BY 1;
\echo '-- Taille de la base'
SELECT pg_size_pretty(pg_database_size(current_database())) AS taille;
SQL
echo "== Fin de la vérification : rien n'a été modifié."
