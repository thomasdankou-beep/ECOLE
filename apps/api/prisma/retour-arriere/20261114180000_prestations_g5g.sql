-- Retour arrière de la migration 20261114180000_prestations_g5g (API arrêtée, avant de remettre le code précédent).
-- Retire les tables, les fonctions, les types et les droits ajoutés par le lot G5g ; ne touche à aucune autre donnée,
-- ni à la facturation du lot G5a. Si les deux lots doivent être retirés, passer celui-ci d'abord.
-- Les lignes déjà inscrites dans les journaux de la plateforme, des groupes et des écoles restent : ils sont en ajout
-- seul. Une fois le script passé, la migration peut être rejouée par une nouvelle mise à jour.
-- Contrôle de sécurité : si les prestations contiennent autre chose que le catalogue initial (4 prestations, 4 versions,
-- 2 prix), le script les compte et S'ARRÊTE sans rien changer. Pour passer outre en connaissance de cause seulement (ces
-- données seront perdues : gardez d'abord une sauvegarde hors du serveur) : PGOPTIONS="-c cahiora.forcer_retour=oui".
-- Lancement :
--   docker compose exec -T postgres psql -U postgres erp -v ON_ERROR_STOP=1 < apps/api/prisma/retour-arriere/20261114180000_prestations_g5g.sql
BEGIN;

DO $$
DECLARE
  n_services int; n_versions int; n_rates int; n_ends int;
BEGIN
  SELECT count(*) INTO n_services FROM services;
  SELECT count(*) INTO n_versions FROM service_versions;
  SELECT count(*) INTO n_rates FROM service_rates;
  SELECT count(*) INTO n_ends FROM service_rate_ends;
  IF (n_services > 4 OR n_versions > 4 OR n_rates > 2 OR n_ends > 0)
     AND coalesce(current_setting('cahiora.forcer_retour', true), '') <> 'oui' THEN
    RAISE EXCEPTION 'Retour arrière arrêté, rien n''a été changé : les prestations contiennent des données saisies (prestations %, versions %, règles de prix %, arrêts %)',
      n_services, n_versions, n_rates, n_ends;
  END IF;
END $$;

DROP FUNCTION IF EXISTS grant_platform_services_role();
DROP TABLE IF EXISTS service_rate_ends, service_rates, service_versions, services;
DROP FUNCTION IF EXISTS service_rate_ends_check();
DROP TYPE IF EXISTS "ServiceRateKind";
DROP TYPE IF EXISTS "ServicePricing";
DELETE FROM _prisma_migrations WHERE migration_name = '20261114180000_prestations_g5g';

COMMIT;
