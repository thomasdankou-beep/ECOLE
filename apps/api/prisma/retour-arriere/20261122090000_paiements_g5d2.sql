-- Retour arrière de la migration 20261122090000_paiements_g5d2 (API arrêtée, avant de remettre le code précédent).
-- Retire les moyens de paiement, les paiements et leurs reçus provisoires, les imputations, les écritures de crédit, les
-- demandes de remboursement et les transferts de crédit, ainsi que les fonctions, les types, les contrôles et les droits
-- ajoutés par le lot G5d-2. Ne touche à aucune autre donnée : les documents de facturation du lot G5c (proformas et
-- avoirs), les abonnements et leur accès (lot G5d-1) restent tels qu'ils sont ; un abonnement rendu actif par un
-- paiement reste actif (le retour arrière ne retire jamais un accès). Si plusieurs lots doivent être retirés, passer
-- celui-ci d'abord, puis ceux de G5d-1, de G5c, de G5b, de G5g et de G5a.
-- Les imputations des avoirs déjà émis (et le crédit qu'un avoir a laissé au-delà de ce qui restait à payer) sont
-- recalculées par la migration : elles partent sans contrôle et reviennent à l'identique si la migration est rejouée.
-- Les lignes déjà inscrites dans les journaux de la plateforme, des groupes et des écoles, dans l'historique des
-- abonnements et dans les alertes du Super Admin restent : ils sont en ajout seul. Une fois le script passé, la
-- migration peut être rejouée par une nouvelle mise à jour.
-- Contrôle de sécurité : s'il existe un moyen de paiement, un paiement (même annulé), une demande de remboursement, un
-- transfert de crédit, une déduction ou une autre écriture de crédit que celle d'un avoir, le script les compte et
-- S'ARRÊTE sans rien changer. Pour passer outre en connaissance de cause seulement (ces données seront perdues, reçus
-- provisoires compris : gardez d'abord une sauvegarde hors du serveur) : PGOPTIONS="-c cahiora.forcer_retour=oui".
-- Lancement :
--   docker compose exec -T postgres psql -U postgres erp -v ON_ERROR_STOP=1 < apps/api/prisma/retour-arriere/20261122090000_paiements_g5d2.sql
BEGIN;

DO $$
DECLARE
  n_means int;
  n_payments int;
  n_refunds int;
  n_transfers int;
  n_entries int;
BEGIN
  SELECT count(*) INTO n_means FROM billing_payment_means;
  SELECT count(*) INTO n_payments FROM billing_payments;
  SELECT count(*) INTO n_refunds FROM billing_refunds;
  SELECT count(*) INTO n_transfers FROM billing_credit_transfers;
  SELECT count(*) INTO n_entries FROM billing_credit_entries WHERE kind <> 'CREDIT_NOTE_SURPLUS';
  IF n_means + n_payments + n_refunds + n_transfers + n_entries > 0 AND coalesce(current_setting('cahiora.forcer_retour', true), '') <> 'oui' THEN
    RAISE EXCEPTION 'Retour arrière arrêté, rien n''a été changé : % version(s) de moyen de paiement, % paiement(s) enregistré(s), % demande(s) de remboursement, % transfert(s) de crédit, % écriture(s) de crédit autres que celles des avoirs',
      n_means, n_payments, n_refunds, n_transfers, n_entries;
  END IF;
END $$;

DROP FUNCTION IF EXISTS grant_platform_payments_role();
DROP FUNCTION IF EXISTS current_tenant_payment_means(date);
DROP FUNCTION IF EXISTS current_tenant_billing_refunds();
DROP FUNCTION IF EXISTS current_tenant_billing_credit_entries();
DROP FUNCTION IF EXISTS current_tenant_billing_payments();
DROP FUNCTION IF EXISTS current_tenant_billing_credit();
DROP FUNCTION IF EXISTS current_tenant_billing_balances();
DROP FUNCTION IF EXISTS transfer_billing_credit(uuid, uuid, integer, text, text, text, text, uuid, text, text);
DROP FUNCTION IF EXISTS decide_billing_refund(uuid, text, text, date, text, text, text, text, uuid, text, text, date);
DROP FUNCTION IF EXISTS request_billing_refund(uuid, text, integer, text, text);
DROP FUNCTION IF EXISTS impute_billing_credit_note(uuid);
DROP FUNCTION IF EXISTS apply_billing_credit(uuid, text, uuid, text);
DROP FUNCTION IF EXISTS cancel_billing_payment(uuid, text, uuid, text, text);
DROP FUNCTION IF EXISTS record_billing_payment(uuid, uuid, integer, date, text, text, text, text, text, uuid, text, text, date);
DROP FUNCTION IF EXISTS add_billing_payment_means(text, boolean, text, text, text, boolean, date, text, uuid, text, date);
DROP FUNCTION IF EXISTS billing_write_allocations(uuid, uuid[], integer[], text, uuid, uuid, uuid, timestamp);
DROP FUNCTION IF EXISTS billing_plan_allocations(uuid, integer, uuid);
DROP FUNCTION IF EXISTS billing_grace_document(uuid);
DROP FUNCTION IF EXISTS billing_credit_reserved(uuid);
DROP FUNCTION IF EXISTS billing_credit_balance(uuid);
DROP FUNCTION IF EXISTS billing_payable_documents(uuid);

-- Tables du lot (leurs contrôles d'ajout seul, de même école et leurs droits partent avec elles), des plus dépendantes
-- aux moins dépendantes.
DROP TABLE IF EXISTS billing_allocations;
DROP TABLE IF EXISTS billing_credit_entries;
DROP TABLE IF EXISTS billing_credit_transfers;
DROP TABLE IF EXISTS billing_refunds;
DROP TABLE IF EXISTS billing_payments;
DROP TABLE IF EXISTS billing_payment_means;
DROP FUNCTION IF EXISTS billing_payments_guard();
DROP FUNCTION IF EXISTS billing_refunds_guard();
DROP TYPE IF EXISTS "BillingRefundStatus";
DROP TYPE IF EXISTS "BillingCreditEntryKind";
DROP TYPE IF EXISTS "BillingAllocationSource";

DELETE FROM _prisma_migrations WHERE migration_name = '20261122090000_paiements_g5d2';

COMMIT;
