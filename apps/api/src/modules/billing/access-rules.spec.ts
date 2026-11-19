import {
  accessPhase, AccessState, dueReminder, extensionError, graceWindow, LIMITED_REFUSAL, limitationDue, PAYMENT_MEANS_ACTIVE, requestError, restoredStatus, whenText,
} from './access-rules';
import { addDays, trialEndDay } from './billing-rules';

/**
 * Règles du lot G5d-1, sans base : décisions de Dankou du 19 novembre 2026 (D-G5-30 A, D-G5-41 A, D-G5-42 A, D-G5-43 A).
 * Essai de 14 jours du 1er au 14 juillet 2027 : rappels les 11, 13 et 14 juillet, grâce du 15 au 29 juillet, accès
 * limité le 30 juillet sans paiement validé (jour 30).
 */
const START = '2027-07-01';
const LAST_FREE = trialEndDay(START, 14);
const J = (n: number) => addDays(START, n - 1);
const { graceStart, graceEnd } = graceWindow(LAST_FREE, 15);
const state = (s: Partial<AccessState> = {}): AccessState => ({
  status: 'AWAITING_ACCEPTANCE', graceEnd, extendedUntil: null, pendingRequest: false, paymentMeansActive: false, ...s,
});

describe('Accès G5d-1 : rappels, délai de grâce et limitation (D-G5-30 A)', () => {
  it('rappels de l’essai aux jours 11, 13 et 14, jamais avant ni après', () => {
    expect(LAST_FREE).toBe('2027-07-14');
    expect(dueReminder(J(10), LAST_FREE)).toBeNull();
    expect(dueReminder(J(11), LAST_FREE)).toBe(3);
    // Le 12 : le rappel du 11 reste le plus récent (déjà parti, la clé de la tâche l'empêche de repartir).
    expect(dueReminder(J(12), LAST_FREE)).toBe(3);
    expect(dueReminder(J(13), LAST_FREE)).toBe(1);
    expect(dueReminder(J(14), LAST_FREE)).toBe(0);
    expect(dueReminder(J(15), LAST_FREE)).toBeNull();
  });

  it('passage en retard : seul le rappel le plus récent part, jamais plusieurs d’un coup', () => {
    // Serveur arrêté du 10 au 13 : le 14, seul le rappel du dernier jour part.
    expect(dueReminder(J(14), LAST_FREE)).toBe(0);
    expect(dueReminder(J(13), LAST_FREE)).toBe(1);
  });

  it('grâce de 15 jours : jours 15 à 29 en accès complet, accès limité dès le jour 30', () => {
    expect(graceStart).toBe(J(15));
    expect(graceEnd).toBe(J(29));
    expect(accessPhase(state(), J(15))).toEqual({ phase: 'GRACE', until: J(29), daysLeft: 15, limitedFrom: J(30) });
    expect(accessPhase(state(), J(29))).toEqual({ phase: 'GRACE', until: J(29), daysLeft: 1, limitedFrom: J(30) });
    expect(accessPhase(state(), J(30))).toEqual({ phase: 'DUE', until: null, daysLeft: null, limitedFrom: J(30) });
    expect(limitationDue(state(), J(29))).toBe(false);
    expect(limitationDue(state(), J(30))).toBe(true);
    // Conditions acceptées, paiement toujours attendu : même règle.
    expect(limitationDue(state({ status: 'AWAITING_PAYMENT' }), J(30))).toBe(true);
  });

  it('rappels pendant la grâce : 3 jours avant sa fin, la veille et le dernier jour', () => {
    expect(dueReminder(J(25), graceEnd)).toBeNull();
    expect(dueReminder(J(26), graceEnd)).toBe(3);
    expect(dueReminder(J(28), graceEnd)).toBe(1);
    expect(dueReminder(J(29), graceEnd)).toBe(0);
    expect(dueReminder(J(30), graceEnd)).toBeNull();
  });

  it('essai, pilote, abonnement payé ou déjà limité : rien à poser', () => {
    expect(accessPhase(state({ status: 'TRIAL' }), J(30)).phase).toBe('FREE');
    expect(accessPhase(state({ status: 'PILOT' }), J(30)).phase).toBe('FREE');
    expect(accessPhase(state({ status: 'ACTIVE' }), J(30)).phase).toBe('ACTIVE');
    expect(accessPhase(state({ status: 'LIMITED' }), J(30)).phase).toBe('LIMITED');
    expect(limitationDue(state({ status: 'LIMITED' }), J(40))).toBe(false);
  });

  it('gratuité finie avant le lot G5d, sans délai connu : jamais limité automatiquement', () => {
    expect(accessPhase(state({ graceEnd: null }), J(60))).toEqual({ phase: 'WAITING', until: null, daysLeft: null, limitedFrom: null });
    expect(limitationDue(state({ graceEnd: null }), J(60))).toBe(false);
  });
});

describe('Accès G5d-1 : demande de régularisation (D-G5-42 A) et prolongation (D-G5-43 A)', () => {
  it('une demande en attente, sans moyen de paiement activé, empêche la limitation', () => {
    expect(PAYMENT_MEANS_ACTIVE).toBe(false);
    expect(accessPhase(state({ pendingRequest: true }), J(30)).phase).toBe('HELD');
    expect(limitationDue(state({ pendingRequest: true }), J(45))).toBe(false);
    // Pendant la grâce, la demande ne change rien au compteur.
    expect(accessPhase(state({ pendingRequest: true }), J(20)).phase).toBe('GRACE');
    // Avec un moyen de paiement activé (lot G5d-2), la demande ne retient plus la limitation.
    expect(limitationDue(state({ pendingRequest: true, paymentMeansActive: true }), J(30))).toBe(true);
  });

  it('prolongation au-delà de la grâce : accès complet jusqu’à sa date de fin, puis limitation', () => {
    const ext = state({ extendedUntil: '2027-08-15' });
    expect(accessPhase(ext, J(20))).toEqual({ phase: 'EXTENDED', until: '2027-08-15', daysLeft: 27, limitedFrom: '2027-08-16' });
    expect(accessPhase(ext, '2027-08-15')).toEqual({ phase: 'EXTENDED', until: '2027-08-15', daysLeft: 1, limitedFrom: '2027-08-16' });
    expect(limitationDue(ext, '2027-08-15')).toBe(false);
    expect(limitationDue(ext, '2027-08-16')).toBe(true);
    // Une prolongation qui s'arrête avant la fin de la grâce ne la raccourcit pas.
    expect(accessPhase(state({ extendedUntil: J(20) }), J(18))).toEqual({ phase: 'GRACE', until: J(29), daysLeft: 12, limitedFrom: J(30) });
    // Sans délai connu, une prolongation finie fait poser la limitation.
    expect(accessPhase(state({ graceEnd: null, extendedUntil: '2027-08-15' }), '2027-08-10').phase).toBe('EXTENDED');
    expect(limitationDue(state({ graceEnd: null, extendedUntil: '2027-08-15' }), '2027-08-16')).toBe(true);
  });

  it('prolongation : abonnement en attente ou limité, date de fin à venir, au-delà de la grâce, au plus un an', () => {
    expect(extensionError('TRIAL', '2027-08-15', J(20), graceEnd)).toMatch(/en attente ou en accès limité \(état actuel : Essai gratuit\)/);
    expect(extensionError('ACTIVE', '2027-08-15', J(20), graceEnd)).toMatch(/Abonnement actif/);
    expect(extensionError('AWAITING_PAYMENT', '15/08/2027', J(20), graceEnd)).toBe('Date de fin : date invalide');
    expect(extensionError('LIMITED', J(31), J(32), graceEnd)).toBe('La date de fin ne peut pas être passée');
    expect(extensionError('AWAITING_ACCEPTANCE', J(29), J(20), graceEnd)).toBe('Le délai de grâce court déjà jusqu’au 29 juillet 2027 : choisissez une date de fin plus tardive');
    expect(extensionError('LIMITED', '2028-08-20', J(40), graceEnd)).toBe('Date de fin : au plus un an après aujourd’hui');
    expect(extensionError('LIMITED', J(40), J(40), graceEnd)).toBeNull();
    expect(extensionError('AWAITING_PAYMENT', '2027-08-15', J(20), graceEnd)).toBeNull();
    expect(extensionError('AWAITING_PAYMENT', '2027-08-15', J(20), null)).toBeNull();
  });

  it('demande de régularisation : abonnement en attente ou limité, une seule à la fois', () => {
    expect(requestError(null, false)).toBe('Aucun abonnement n’est encore ouvert pour votre établissement');
    expect(requestError('TRIAL', false)).toBe('Votre abonnement n’attend pas de régularisation (état : Essai gratuit)');
    expect(requestError('ACTIVE', false)).toMatch(/Abonnement actif/);
    expect(requestError('AWAITING_PAYMENT', true)).toBe('Une demande de régularisation attend déjà la réponse de Cahiora');
    expect(requestError('AWAITING_ACCEPTANCE', false)).toBeNull();
    expect(requestError('LIMITED', false)).toBeNull();
  });

  it('limitation levée : en attente d’acceptation ou de paiement selon les conditions', () => {
    expect(restoredStatus(null)).toBe('AWAITING_ACCEPTANCE');
    expect(restoredStatus(new Date())).toBe('AWAITING_PAYMENT');
  });
});

describe('Accès G5d-1 : textes', () => {
  it('échéances lisibles', () => {
    expect(whenText('2027-07-11', '2027-07-14')).toBe('dans 3 jours, le 14 juillet 2027');
    expect(whenText('2027-07-13', '2027-07-14')).toBe('demain, le 14 juillet 2027');
    expect(whenText('2027-08-01', '2027-08-01')).toBe('aujourd’hui, le 1er août 2027');
  });

  it('refus pendant l’accès limité : le personnel lit pourquoi, une famille seulement de contacter l’établissement', () => {
    expect(LIMITED_REFUSAL.staff).toBe(
      'Accès limité : l’abonnement Cahiora de l’établissement n’est pas régularisé. Consultation, impression, export, caisse et régularisation restent possibles, et aucune donnée n’est supprimée.',
    );
    expect(LIMITED_REFUSAL.family).not.toMatch(/abonnement|Cahiora/);
  });
});
