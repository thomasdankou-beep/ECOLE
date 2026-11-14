-- Retour arrière de la migration 20261114120000_facturation_g5a (API arrêtée, avant de remettre le code précédent).
-- Retire les tables, les fonctions, le type et les droits ajoutés par le lot G5a ; ne touche à aucune autre donnée.
-- Les lignes déjà inscrites dans les journaux de la plateforme, des groupes et des écoles restent : ils sont en ajout
-- seul. Une fois le script passé, la migration peut être rejouée par une nouvelle mise à jour.
-- Contrôle de sécurité : si la facturation contient déjà des données saisies (abonnement, historique, calendrier,
-- conditions commerciales, tâche, alerte, ou une valeur de paramètre en plus des dix valeurs initiales), le script les
-- compte et S'ARRÊTE sans rien changer. Pour passer outre en connaissance de cause seulement (ces données seront
-- perdues : gardez d'abord une sauvegarde hors du serveur) : PGOPTIONS="-c cahiora.forcer_retour=oui".
-- Lancement :
--   docker compose exec -T postgres psql -U postgres erp -v ON_ERROR_STOP=1 < apps/api/prisma/retour-arriere/20261114120000_facturation_g5a.sql
BEGIN;

DO $$
DECLARE
  n_sub int; n_ev int; n_cal int; n_terms int; n_jobs int; n_alerts int; n_params int;
BEGIN
  SELECT count(*) INTO n_sub FROM subscriptions;
  SELECT count(*) INTO n_ev FROM subscription_events;
  SELECT count(*) INTO n_cal FROM billing_calendars;
  SELECT count(*) INTO n_terms FROM commercial_terms;
  SELECT count(*) INTO n_jobs FROM billing_jobs;
  SELECT count(*) INTO n_alerts FROM platform_alerts;
  SELECT count(*) INTO n_params FROM billing_parameters;
  IF (n_sub + n_ev + n_cal + n_terms + n_jobs + n_alerts > 0 OR n_params > 10)
     AND coalesce(current_setting('cahiora.forcer_retour', true), '') <> 'oui' THEN
    RAISE EXCEPTION 'Retour arrière arrêté, rien n''a été changé : la facturation contient déjà des données (abonnements %, historique %, calendriers %, conditions %, tâches %, alertes %, valeurs de paramètres %)',
      n_sub, n_ev, n_cal, n_terms, n_jobs, n_alerts, n_params;
  END IF;
END $$;

DROP FUNCTION IF EXISTS accept_commercial_terms(uuid, uuid, text, text, date);
DROP FUNCTION IF EXISTS current_tenant_billing_calendars();
DROP FUNCTION IF EXISTS current_tenant_subscription_events();
DROP FUNCTION IF EXISTS current_tenant_subscription();
DROP FUNCTION IF EXISTS current_commercial_terms(date);
DROP FUNCTION IF EXISTS billing_parameter_value(text, text, date);
DROP FUNCTION IF EXISTS grant_platform_billing_role();
DROP TABLE IF EXISTS subscription_events, subscriptions, billing_calendars, billing_parameters, commercial_terms, billing_jobs, platform_alerts;
DROP FUNCTION IF EXISTS subscriptions_guard();
DROP FUNCTION IF EXISTS platform_alerts_guard();
DROP TYPE IF EXISTS "SubscriptionStatus";
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_platform') THEN
    REVOKE SELECT (id, tenant_id, label, "startDate", "endDate", "isCurrent") ON academic_years FROM erp_platform;
  END IF;
END $$;
DELETE FROM _prisma_migrations WHERE migration_name = '20261114120000_facturation_g5a';

COMMIT;
