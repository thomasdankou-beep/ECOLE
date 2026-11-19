-- Retour arrière de la migration 20261119120000_comptages_g5b (API arrêtée, avant de remettre le code précédent).
-- Retire les tables, les fonctions, les types et les droits ajoutés par le lot G5b ; ne touche à aucune autre donnée,
-- ni à la facturation des lots G5a et G5g. Si plusieurs lots doivent être retirés, passer celui-ci d'abord.
-- Les lignes déjà inscrites dans les journaux de la plateforme, des groupes et des écoles restent : ils sont en ajout
-- seul. Une fois le script passé, la migration peut être rejouée par une nouvelle mise à jour.
-- Contrôle de sécurité : s'il existe un comptage (et donc peut-être ses lignes et des demandes de correction), le script
-- les compte et S'ARRÊTE sans rien changer. Pour passer outre en connaissance de cause seulement (ces données seront perdues :
-- gardez d'abord une sauvegarde hors du serveur) : PGOPTIONS="-c cahiora.forcer_retour=oui".
-- Lancement :
--   docker compose exec -T postgres psql -U postgres erp -v ON_ERROR_STOP=1 < apps/api/prisma/retour-arriere/20261119120000_comptages_g5b.sql
BEGIN;

DO $$
DECLARE
  n_counts int;
BEGIN
  -- Une ligne de comptage ou une demande de correction pointe toujours vers un comptage (clé étrangère) : compter les
  -- comptages suffit, et la table des comptages se lit en entier (zone de la plateforme, sans filtre par école).
  SELECT count(*) INTO n_counts FROM billing_counts;
  IF n_counts > 0 AND coalesce(current_setting('cahiora.forcer_retour', true), '') <> 'oui' THEN
    RAISE EXCEPTION 'Retour arrière arrêté, rien n''a été changé : % comptage(s) des élèves facturables déjà enregistré(s)', n_counts;
  END IF;
END $$;

DROP FUNCTION IF EXISTS grant_platform_counts_role();
DROP FUNCTION IF EXISTS record_billing_count(uuid, uuid, text, date, text, integer, jsonb, timestamptz, timestamptz, date);
DROP FUNCTION IF EXISTS current_tenant_billing_counts();
DROP FUNCTION IF EXISTS request_count_correction(uuid, text, uuid, date, text, text, text, integer, uuid, text, text, date);
DROP FUNCTION IF EXISTS decide_count_correction(uuid, text, text, uuid, text, text);
DROP TABLE IF EXISTS count_corrections, billing_count_items, billing_counts;
DROP FUNCTION IF EXISTS count_corrections_guard();
DROP TYPE IF EXISTS "CountCorrectionStatus";
DROP TYPE IF EXISTS "CountCorrectionKind";
DROP TYPE IF EXISTS "BillingCountStage";
DROP TYPE IF EXISTS "BillingCountKind";
DELETE FROM _prisma_migrations WHERE migration_name = '20261119120000_comptages_g5b';

COMMIT;
