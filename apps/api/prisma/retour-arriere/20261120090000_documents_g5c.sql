-- Retour arrière de la migration 20261120090000_documents_g5c (API arrêtée, avant de remettre le code précédent).
-- Retire les tables, les fonctions, le type et les droits ajoutés par le lot G5c ; ne touche à aucune autre donnée,
-- ni aux comptages du lot G5b, ni à la facturation des lots G5a et G5g. Si plusieurs lots doivent être retirés, passer
-- celui-ci d'abord, puis ceux de G5b, de G5g et de G5a.
-- Les lignes déjà inscrites dans les journaux de la plateforme, des groupes et des écoles restent : ils sont en ajout
-- seul. Une fois le script passé, la migration peut être rejouée par une nouvelle mise à jour.
-- Contrôle de sécurité : s'il existe un document (proforma, avoir, devis), le script les compte et S'ARRÊTE sans rien
-- changer. Pour passer outre en connaissance de cause seulement (ces documents seront perdus : gardez d'abord une
-- sauvegarde hors du serveur) : PGOPTIONS="-c cahiora.forcer_retour=oui".
-- Lancement :
--   docker compose exec -T postgres psql -U postgres erp -v ON_ERROR_STOP=1 < apps/api/prisma/retour-arriere/20261120090000_documents_g5c.sql
BEGIN;

DO $$
DECLARE
  n_documents int;
BEGIN
  -- Une ligne pointe toujours vers son document (clé étrangère) : compter les documents suffit, et la table se lit en
  -- entier (zone de la plateforme, sans filtre par école).
  SELECT count(*) INTO n_documents FROM billing_documents;
  IF n_documents > 0 AND coalesce(current_setting('cahiora.forcer_retour', true), '') <> 'oui' THEN
    RAISE EXCEPTION 'Retour arrière arrêté, rien n''a été changé : % document(s) provisoire(s) déjà émis', n_documents;
  END IF;
END $$;

DROP FUNCTION IF EXISTS grant_platform_documents_role();
DROP FUNCTION IF EXISTS issue_billing_document(uuid, text, text, date, date, text, uuid, jsonb, jsonb, text, uuid, text);
DROP FUNCTION IF EXISTS current_tenant_billing_documents();
DROP FUNCTION IF EXISTS current_tenant_sees_billing_documents();
DROP TABLE IF EXISTS billing_document_lines, billing_documents;
DROP FUNCTION IF EXISTS billing_already_billed(uuid, text);
DROP FUNCTION IF EXISTS billing_year_amount(integer, integer, integer, integer, integer);
DROP TYPE IF EXISTS "BillingDocumentKind";
DELETE FROM _prisma_migrations WHERE migration_name = '20261120090000_documents_g5c';

COMMIT;
