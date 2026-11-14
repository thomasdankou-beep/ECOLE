/** Libellés des actions de la facturation (lot G5a) dans les journaux de la plateforme et des groupes. */
export const BILLING_ACTIONS: Record<string, string> = {
  'billing.trial_opened': 'Facturation : essai gratuit ouvert',
  'billing.pilot_opened': 'Facturation : école pilote partenaire activée',
  'billing.pilot_end_changed': 'Facturation : fin de la période pilote modifiée',
  'billing.pilot_alert': 'Facturation : alerte avant la fin de la période pilote',
  'billing.trial_ended': 'Facturation : essai terminé, conditions à accepter',
  'billing.pilot_ended': 'Facturation : période pilote terminée, conditions à accepter',
  'billing.calendar_saved': 'Facturation : calendrier enregistré',
  'billing.terms_accepted': 'Facturation : conditions commerciales acceptées par la direction',
  'billing.terms_published': 'Facturation : conditions commerciales publiées',
  'billing.parameter_added': 'Facturation : nouvelle valeur d’un paramètre tarifaire',
  'billing.parameters.initial': 'Facturation : paramètres tarifaires initiaux (mise à jour de Cahiora)',
  'billing.2fa_failed': 'Facturation : code de double authentification incorrect',
};
