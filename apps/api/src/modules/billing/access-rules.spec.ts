import {
  accessPhase, AccessState, answerOutcome, answerOutcomeText, dayStart, dueReminder, extensionError, extensionKind, extensionMaxUntil, frDateTime, graceWindow,
  LIMITED_REFUSAL, limitationDue, noticeReminderDue, requestError, restoredStatus, whenText,
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
  status: 'AWAITING_ACCEPTANCE', graceEnd, extendedUntil: null, pendingRequest: false, paymentMeansActive: false, notice: null, ...s,
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
    expect(accessPhase(state(), J(15))).toEqual({ phase: 'GRACE', until: J(29), daysLeft: 15, limitedFrom: J(30), limitedAt: null, hoursLeft: null });
    expect(accessPhase(state(), J(29))).toEqual({ phase: 'GRACE', until: J(29), daysLeft: 1, limitedFrom: J(30), limitedAt: null, hoursLeft: null });
    expect(accessPhase(state(), J(30))).toEqual({ phase: 'DUE', until: null, daysLeft: null, limitedFrom: J(30), limitedAt: null, hoursLeft: null });
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
    expect(accessPhase(state({ graceEnd: null }), J(60))).toEqual({ phase: 'WAITING', until: null, daysLeft: null, limitedFrom: null, limitedAt: null, hoursLeft: null });
    expect(limitationDue(state({ graceEnd: null }), J(60))).toBe(false);
  });
});

describe('Accès G5d-1 : demande de régularisation (D-G5-42 A) et prolongation (D-G5-43 A)', () => {
  it('une demande en attente, sans moyen de paiement activé, empêche la limitation', () => {
    expect(accessPhase(state({ pendingRequest: true }), J(30)).phase).toBe('HELD');
    expect(limitationDue(state({ pendingRequest: true }), J(45))).toBe(false);
    // Pendant la grâce, la demande ne change rien au compteur.
    expect(accessPhase(state({ pendingRequest: true }), J(20)).phase).toBe('GRACE');
    // Avec un moyen de paiement activé (lot G5d-2), la demande ne retient plus la limitation.
    expect(limitationDue(state({ pendingRequest: true, paymentMeansActive: true }), J(30))).toBe(true);
  });

  it('prolongation au-delà de la grâce : accès complet jusqu’à sa date de fin, puis limitation', () => {
    const ext = state({ extendedUntil: '2027-08-15' });
    expect(accessPhase(ext, J(20))).toEqual({ phase: 'EXTENDED', until: '2027-08-15', daysLeft: 27, limitedFrom: '2027-08-16', limitedAt: null, hoursLeft: null });
    expect(accessPhase(ext, '2027-08-15')).toEqual({ phase: 'EXTENDED', until: '2027-08-15', daysLeft: 1, limitedFrom: '2027-08-16', limitedAt: null, hoursLeft: null });
    expect(limitationDue(ext, '2027-08-15')).toBe(false);
    expect(limitationDue(ext, '2027-08-16')).toBe(true);
    // Une prolongation qui s'arrête avant la fin de la grâce ne la raccourcit pas.
    expect(accessPhase(state({ extendedUntil: J(20) }), J(18))).toEqual({ phase: 'GRACE', until: J(29), daysLeft: 12, limitedFrom: J(30), limitedAt: null, hoursLeft: null });
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

/**
 * Lecture 7 A, validée par Dankou le 20 novembre 2026 : jamais moins de 48 heures entre la réponse de Cahiora à une
 * demande de régularisation et la limitation, une seule fois par échéance. Porto-Novo est à UTC+1 : le 30 juillet 2027
 * (jour 30, premier jour d'accès limité) commence le 29 juillet à 23 h UTC.
 */
describe('Lecture 7 A : préavis de 48 heures après la réponse de Cahiora', () => {
  const TZ = 'Africa/Porto-Novo';
  const start = (d: string) => dayStart(d, TZ);
  /** Instant à l'heure de Porto-Novo : jour n, heure h. */
  const T = (n: number, h: number, m = 0) => new Date(Date.parse(`${J(n)}T00:00:00.000Z`) + ((h - 1) * 60 + m) * 60_000);
  const H = 3_600_000;
  const view = (now: Date, s: Partial<AccessState> = {}) => accessPhase(state(s), J(Number(((now.getTime() + H - Date.parse(`${START}T00:00:00Z`)) / 86_400_000) | 0) + 1), now);

  it('début d’un jour et heure lisible, au fuseau de l’établissement', () => {
    expect(start(J(30)).toISOString()).toBe('2027-07-29T23:00:00.000Z');
    expect(dayStart(J(30), 'Africa/Abidjan').toISOString()).toBe('2027-07-30T00:00:00.000Z');
    expect(frDateTime(new Date('2027-07-31T13:05:00.000Z'), TZ)).toBe('31 juillet 2027 à 14 h 05');
    expect(frDateTime(new Date('2027-07-31T23:00:00.000Z'), TZ)).toBe('1er août 2027 à 0 h 00');
    expect(T(29, 10).toISOString()).toBe('2027-07-29T09:00:00.000Z');
  });

  it('réponse plus de 48 heures avant la limitation : pas de préavis, la limitation reste au jour 30 à 0 h', () => {
    const now = T(20, 12);
    expect(view(now).phase).toBe('GRACE');
    expect(answerOutcome(view(now), now, 48, false, start)).toEqual({ kind: 'scheduled', limitedAt: start(J(30)), hours: null, noticeGiven: false });
    // 49 heures avant : toujours sans préavis.
    expect(answerOutcome(view(T(27, 23)), T(27, 23), 48, false, start)).toEqual({ kind: 'scheduled', limitedAt: start(J(30)), hours: null, noticeGiven: false });
  });

  it('réponse moins de 48 heures avant la limitation : préavis jusqu’à 48 heures après la réponse', () => {
    // 47 heures avant la fin de la grâce.
    expect(answerOutcome(view(T(28, 1)), T(28, 1), 48, false, start)).toEqual({ kind: 'notice', limitedAt: T(30, 1), hours: 48, noticeGiven: false });
    // Le dernier jour de grâce à 10 h : la limitation passe du jour 30 à 0 h au jour 31 à 10 h.
    expect(answerOutcome(view(T(29, 10)), T(29, 10), 48, false, start)).toEqual({ kind: 'notice', limitedAt: T(31, 10), hours: 48, noticeGiven: false });
    // Délai passé (la demande retenait la limitation) : 48 heures à partir de la réponse.
    expect(answerOutcome(view(T(33, 9)), T(33, 9), 48, false, start)).toEqual({ kind: 'notice', limitedAt: T(35, 9), hours: 48, noticeGiven: false });
  });

  it('une seule fois par échéance : une nouvelle réponse n’ouvre pas un second préavis', () => {
    const notice = { until: T(35, 9), lastDay: J(35) };
    // Pendant le préavis, une deuxième demande puis sa réponse : le préavis court toujours, sans être renouvelé.
    expect(answerOutcome(view(T(34, 15), { notice }), T(34, 15), 48, true, start)).toEqual({ kind: 'notice-running', limitedAt: T(35, 9), hours: null, noticeGiven: true });
    // Après le préavis : limitation dans l'heure.
    expect(answerOutcome(view(T(36, 9), { notice }), T(36, 9), 48, true, start)).toEqual({ kind: 'now', limitedAt: null, hours: null, noticeGiven: true });
  });

  it('préavis réglé à 0 ou sans valeur en vigueur : la règle d’avant reste (limitation au prochain passage)', () => {
    expect(answerOutcome(view(T(33, 9)), T(33, 9), 0, false, start)).toEqual({ kind: 'now', limitedAt: null, hours: null, noticeGiven: false });
    expect(answerOutcome(view(T(33, 9)), T(33, 9), null, false, start)).toEqual({ kind: 'now', limitedAt: null, hours: null, noticeGiven: false });
    expect(answerOutcome(view(T(29, 10)), T(29, 10), null, false, start)).toEqual({ kind: 'scheduled', limitedAt: start(J(30)), hours: null, noticeGiven: false });
  });

  it('aucune limitation prévue : rien à annoncer', () => {
    for (const status of ['TRIAL', 'PILOT', 'ACTIVE', 'LIMITED'] as const) expect(answerOutcome(view(T(33, 9), { status }), T(33, 9), 48, false, start)).toEqual({ kind: 'none', limitedAt: null, hours: null, noticeGiven: false });
    expect(answerOutcome(view(T(33, 9), { graceEnd: null }), T(33, 9), 48, false, start)).toEqual({ kind: 'none', limitedAt: null, hours: null, noticeGiven: false });
  });

  it('pendant le préavis : accès complet jusqu’à son heure de fin, compteur en heures ; puis la limitation est due', () => {
    const notice = { until: T(31, 10), lastDay: J(31) };
    // Le préavis ouvert le dernier jour de grâce prend le relais tout de suite.
    expect(view(T(29, 12), { notice })).toEqual({ phase: 'NOTICE', until: J(31), daysLeft: 3, limitedFrom: J(31), limitedAt: T(31, 10).toISOString(), hoursLeft: 46 });
    expect(view(T(31, 9, 30), { notice })).toMatchObject({ phase: 'NOTICE', hoursLeft: 1, daysLeft: 1 });
    expect(view(T(31, 10), { notice }).phase).toBe('DUE');
    expect(limitationDue(state({ notice }), J(31))).toBe(true);
    // Une nouvelle demande pendant le préavis : le préavis reste affiché ; à sa fin, la demande retient la limitation.
    expect(view(T(30, 12), { notice, pendingRequest: true }).phase).toBe('NOTICE');
    expect(view(T(31, 11), { notice, pendingRequest: true }).phase).toBe('HELD');
  });

  it('préavis plus court que le délai ou la prolongation : il ne change rien', () => {
    // Fin du préavis pendant le dernier jour de grâce : la grâce court jusqu'à minuit.
    expect(view(T(29, 8), { notice: { until: T(29, 14), lastDay: J(29) } }).phase).toBe('GRACE');
    // Prolongation donnée après le préavis, plus longue : elle prime.
    expect(view(T(30, 12), { notice: { until: T(31, 10), lastDay: J(31) }, extendedUntil: J(40) })).toMatchObject({ phase: 'EXTENDED', until: J(40) });
  });

  it('rappel dans les dernières 24 heures du préavis, jamais après sa fin', () => {
    const until = T(31, 10);
    expect(noticeReminderDue(until, T(30, 9))).toBe(false);
    expect(noticeReminderDue(until, T(30, 10))).toBe(true);
    expect(noticeReminderDue(until, T(31, 9))).toBe(true);
    expect(noticeReminderDue(until, T(31, 10))).toBe(false);
  });

  it('ce que lit la direction dans la réponse', () => {
    const keeps = ' En accès limité, consultation, impression, export, caisse et régularisation restent possibles, et aucune donnée n’est supprimée.';
    expect(answerOutcomeText({ kind: 'notice', limitedAt: T(31, 10), hours: 48, noticeGiven: false }, TZ))
      .toBe(`Sans paiement validé, l’accès sera limité à partir du 31 juillet 2027 à 10 h 00 : Cahiora vous laisse un préavis de 48 heures après cette réponse.${keeps}`);
    expect(answerOutcomeText({ kind: 'scheduled', limitedAt: start(J(30)), hours: null, noticeGiven: false }, TZ)).toBe(`Sans paiement validé, l’accès sera limité à partir du 30 juillet 2027 à 0 h 00.${keeps}`);
    expect(answerOutcomeText({ kind: 'notice-running', limitedAt: T(35, 9), hours: null, noticeGiven: true }, TZ))
      .toBe(`Sans paiement validé, l’accès sera limité à partir du 4 août 2027 à 9 h 00, à la fin du préavis déjà donné pour cette échéance.${keeps}`);
    expect(answerOutcomeText({ kind: 'now', limitedAt: null, hours: null, noticeGiven: true }, TZ)).toBe(`Le préavis de cette échéance a déjà été donné : sans paiement validé, l’accès sera limité dans l’heure.${keeps}`);
    expect(answerOutcomeText({ kind: 'none', limitedAt: null, hours: null, noticeGiven: false }, TZ)).toBe('');
  });
});

/** Lecture 9 A, validée par Dankou le 20 novembre 2026 : 30 jours au plus par prolongation, renouvellements compris. */
describe('Lecture 9 A : prolongation de 30 jours au plus, renouvellements exceptionnels', () => {
  it('30 jours depuis la fin de l’accès complet en cours, ou depuis aujourd’hui si elle est passée', () => {
    // Pendant la grâce : depuis sa fin (jour 29).
    expect(extensionMaxUntil(J(20), graceEnd, null, 30)).toBe(J(59));
    // Accès limité, grâce passée : depuis aujourd'hui.
    expect(extensionMaxUntil(J(40), graceEnd, null, 30)).toBe(J(70));
    // Renouvellement pendant la prolongation : depuis sa fin ; après elle : depuis aujourd'hui.
    expect(extensionMaxUntil(J(45), graceEnd, J(59), 30)).toBe(J(89));
    expect(extensionMaxUntil(J(65), graceEnd, J(59), 30)).toBe(J(95));
    // Une prolongation d'une échéance passée (avant la grâce actuelle) ne compte pas.
    expect(extensionMaxUntil(J(20), graceEnd, J(10), 30)).toBe(J(59));
    // Sans durée en vigueur, seul le garde-fou d'un an compte ; il reste au-delà.
    expect(extensionMaxUntil(J(20), graceEnd, null, null)).toBe(addDays(J(20), 366));
    expect(extensionMaxUntil(J(20), graceEnd, addDays(J(20), 350), 30)).toBe(addDays(J(20), 366));
  });

  it('première prolongation, renouvellement exceptionnel ou fin avancée', () => {
    expect(extensionKind(J(40), graceEnd, null)).toBe('first');
    expect(extensionKind(J(40), graceEnd, J(10))).toBe('first');
    expect(extensionKind(J(70), graceEnd, J(59))).toBe('renewal');
    expect(extensionKind(J(50), graceEnd, J(59))).toBe('shortened');
    expect(extensionKind(J(40), null, J(35))).toBe('renewal');
  });

  it('au-delà de 30 jours : refus avec la date la plus tardive ; raccourcir reste possible ; le garde-fou d’un an reste', () => {
    const msg = 'Une prolongation dure 30 jours au plus, renouvellement compris, depuis la fin de l’accès complet en cours : choisissez au plus tard le ';
    expect(extensionError('AWAITING_PAYMENT', J(60), J(20), graceEnd, null, 30)).toBe(`${msg}28 août 2027`);
    expect(extensionError('AWAITING_PAYMENT', J(59), J(20), graceEnd, null, 30)).toBeNull();
    expect(extensionError('LIMITED', J(71), J(40), graceEnd, null, 30)).toBe(`${msg}8 septembre 2027`);
    expect(extensionError('AWAITING_PAYMENT', J(90), J(45), graceEnd, J(59), 30)).toBe(`${msg}27 septembre 2027`);
    expect(extensionError('AWAITING_PAYMENT', J(89), J(45), graceEnd, J(59), 30)).toBeNull();
    expect(extensionError('AWAITING_PAYMENT', J(50), J(45), graceEnd, J(59), 30)).toBeNull();
    expect(extensionError('LIMITED', '2028-08-20', J(40), graceEnd, null, 30)).toBe('Date de fin : au plus un an après aujourd’hui');
  });
});
