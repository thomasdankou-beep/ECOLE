import { cahioraMessage as accessMessage } from './access';
import { cahioraMessage as documentMessage } from './documents';
import {
  activeMeans, availableCredit, CANCEL_REFUSED, cancellationPlan, documentPayment, impute, losesPayment, matchesStatus, meansCode, meansError, meansOn, MeansVersion,
  normalizedReference, OpenDocument, paymentError, PAYMENTS_LOCKED, paymentsUnlocked, receiptNumber, RECEIPT_MENTION, refundDecisionError, refundRequestError,
  restoresAccess, transferError,
} from './payments-rules';

/**
 * Règles du lot G5d-2, sans base : plan validé par Dankou le 20 novembre 2026 (choix 1 A et 2 A), D-G5-15 A, D-G5-17 A,
 * D-G5-30 A, D-G5-43 A. Montants fictifs en francs CFA.
 */
const doc = (id: string, issueDate: string, balance: number, created = '2027-08-01T10:00:00Z'): OpenDocument => ({
  id, reference: `PROV-${id.toUpperCase()}`, issueDate, createdAt: new Date(created), balance,
});

describe('G5d-2 · verrou 1 du serveur (D-G5-33)', () => {
  it('fermé par défaut : seule la valeur exacte « true » l’ouvre', () => {
    expect(paymentsUnlocked({})).toBe(false);
    expect(paymentsUnlocked({ BILLING_PAYMENTS_UNLOCKED: '' })).toBe(false);
    expect(paymentsUnlocked({ BILLING_PAYMENTS_UNLOCKED: '1' })).toBe(false);
    expect(paymentsUnlocked({ BILLING_PAYMENTS_UNLOCKED: 'TRUE' })).toBe(false);
    expect(paymentsUnlocked({ BILLING_PAYMENTS_UNLOCKED: 'oui' })).toBe(false);
    expect(paymentsUnlocked({ BILLING_PAYMENTS_UNLOCKED: 'true' })).toBe(true);
  });
});

describe('G5d-2 · verrou 2 : moyens de paiement datés', () => {
  const v = (code: string, version: number, effectiveFrom: string, active: boolean, currency = 'XOF'): MeansVersion => ({
    id: `${code}-${version}`, code, version, name: code, instructions: 'Coordonnées fictives', currency, active, effectiveFrom,
  });
  const versions = [v('B', 1, '2027-08-01', true), v('B', 2, '2027-09-01', false), v('A', 1, '2027-08-10', true), v('A', 2, '2027-08-10', false), v('C', 1, '2027-08-01', true, 'XAF')];

  it('la version en vigueur : date d’effet la plus récente, puis la dernière version du même jour', () => {
    expect(meansOn(versions, '2027-07-31')).toEqual([]);
    expect(meansOn(versions, '2027-08-05').map((x) => x.id)).toEqual(['B-1', 'C-1']);
    expect(meansOn(versions, '2027-08-10').map((x) => x.id)).toEqual(['A-2', 'B-1', 'C-1']);
    expect(meansOn(versions, '2027-09-01').map((x) => x.id)).toEqual(['A-2', 'B-2', 'C-1']);
  });

  it('moyens activés dans la monnaie de l’établissement, aucun tant que le verrou 1 est fermé', () => {
    expect(activeMeans(versions, 'XOF', '2027-08-15', true).map((x) => x.id)).toEqual(['B-1']);
    expect(activeMeans(versions, 'XAF', '2027-08-15', true).map((x) => x.id)).toEqual(['C-1']);
    expect(activeMeans(versions, 'XOF', '2027-09-02', true)).toEqual([]);
    expect(activeMeans(versions, 'XOF', '2027-08-15', false)).toEqual([]);
  });

  it('un code stable tiré du premier nom', () => {
    expect(meansCode('MTN Mobile Money')).toBe('MTN_MOBILE_MONEY');
    expect(meansCode('Virement bancaire (BOA Bénin)')).toBe('VIREMENT_BANCAIRE_BOA_BENIN');
    expect(meansCode('  ')).toBe('MOYEN');
  });

  it('une nouvelle version : verrou 1 ouvert, coordonnées saisies, date d’effet à partir d’aujourd’hui', () => {
    const ok = { name: 'Moyen fictif', instructions: 'Numéro fictif 00 00 00 00', currency: 'XOF', active: true, effectiveFrom: '2027-08-01' };
    expect(meansError(ok, '2027-08-01', ['XOF'], false)).toBe(PAYMENTS_LOCKED);
    expect(meansError({ ...ok, active: false }, '2027-08-01', ['XOF'], false)).toBe(PAYMENTS_LOCKED);
    expect(meansError(ok, '2027-08-01', ['XOF'], true)).toBeNull();
    expect(meansError({ ...ok, effectiveFrom: '2027-07-31' }, '2027-08-01', ['XOF'], true)).toMatch(/passée/);
    expect(meansError({ ...ok, effectiveFrom: '2028-08-02' }, '2027-08-01', ['XOF'], true)).toMatch(/un an/);
    expect(meansError({ ...ok, instructions: 'abc' }, '2027-08-01', ['XOF'], true)).toMatch(/Coordonnées/);
    expect(meansError({ ...ok, currency: 'EUR' }, '2027-08-01', ['XOF'], true)).toMatch(/Monnaie/);
  });
});

describe('G5d-2 · imputation (choix 1 A)', () => {
  const docs = [doc('c', '2027-09-30', 20_000), doc('a', '2027-07-30', 100_000), doc('b', '2027-08-31', 50_000)];

  it('d’abord le document indiqué, même plus récent qu’un autre impayé', () => {
    expect(impute(20_000, 'c', docs)).toEqual({ allocations: [{ documentId: 'c', reference: 'PROV-C', amount: 20_000 }], credit: 0 });
  });

  it('le surplus va aux autres documents impayés, du plus ancien au plus récent, puis au crédit (test 12 : paiement excédentaire)', () => {
    const r = impute(200_000, 'b', docs);
    expect(r.allocations).toEqual([
      { documentId: 'b', reference: 'PROV-B', amount: 50_000 }, { documentId: 'a', reference: 'PROV-A', amount: 100_000 }, { documentId: 'c', reference: 'PROV-C', amount: 20_000 },
    ]);
    expect(r.credit).toBe(30_000);
  });

  it('paiement partiel : le document indiqué reste partiellement payé (test 11)', () => {
    expect(impute(60_000, 'a', docs)).toEqual({ allocations: [{ documentId: 'a', reference: 'PROV-A', amount: 60_000 }], credit: 0 });
  });

  it('un document déjà payé indiqué : tout va aux autres, puis au crédit', () => {
    const r = impute(30_000, 'z', [...docs, doc('z', '2027-06-30', 0)]);
    expect(r.allocations.map((a) => a.documentId)).toEqual(['a']);
    expect(r.credit).toBe(0);
    expect(impute(10_000, 'a', [doc('a', '2027-07-30', 0)])).toEqual({ allocations: [], credit: 10_000 });
  });

  it('un crédit qui se déduit, sans document indiqué : du plus ancien au plus récent ; à date égale, l’émission la plus ancienne', () => {
    const same = [doc('y', '2027-08-31', 5_000, '2027-08-31T12:00:00Z'), doc('x', '2027-08-31', 5_000, '2027-08-31T09:00:00Z')];
    expect(impute(7_000, null, same).allocations).toEqual([{ documentId: 'x', reference: 'PROV-X', amount: 5_000 }, { documentId: 'y', reference: 'PROV-Y', amount: 2_000 }]);
  });

  it('montant invalide refusé', () => {
    expect(() => impute(-1, null, docs)).toThrow('Montant invalide');
    expect(() => impute(1.5, null, docs)).toThrow('Montant invalide');
  });
});

describe('G5d-2 · état du paiement d’un document (§8)', () => {
  const today = '2027-08-15';
  it('en attente, partiellement payé, payé, en retard, annulé par avoir, rien à payer', () => {
    expect(documentPayment({ total: 100_000, credited: 0, paid: 0, dueDate: '2027-08-31' }, today)).toMatchObject({ status: 'PENDING', label: 'En attente', balance: 100_000 });
    expect(documentPayment({ total: 100_000, credited: 0, paid: 40_000, dueDate: '2027-08-31' }, today)).toMatchObject({ status: 'PARTIAL', label: 'Partiellement payé', balance: 60_000 });
    expect(documentPayment({ total: 100_000, credited: 5_000, paid: 95_000, dueDate: '2027-08-01' }, today)).toMatchObject({ status: 'PAID', label: 'Payé', balance: 0, overdue: false, due: 95_000 });
    expect(documentPayment({ total: 100_000, credited: 0, paid: 0, dueDate: '2027-08-14' }, today)).toMatchObject({ status: 'PENDING', label: 'En retard', overdue: true });
    expect(documentPayment({ total: 100_000, credited: 0, paid: 1, dueDate: '2027-08-14' }, today)).toMatchObject({ status: 'PARTIAL', label: 'Partiellement payé, en retard' });
    expect(documentPayment({ total: 100_000, credited: 100_000, paid: 0, dueDate: '2027-08-14' }, today)).toMatchObject({ status: 'CANCELLED', label: 'Annulé par avoir', overdue: false });
    expect(documentPayment({ total: 0, credited: 0, paid: 0, dueDate: null }, today)).toMatchObject({ status: 'NOTHING_DUE', label: 'Rien à payer' });
    // Sans échéance (complément d'une régularisation, INFORMATION MANQUANTE dans G5c) : jamais « en retard ».
    expect(documentPayment({ total: 10_000, credited: 0, paid: 0, dueDate: null }, today).overdue).toBe(false);
  });

  it('filtres des rapports', () => {
    const late = documentPayment({ total: 100_000, credited: 0, paid: 0, dueDate: '2027-08-14' }, today);
    expect(matchesStatus(late, 'OVERDUE')).toBe(true);
    expect(matchesStatus(late, 'PENDING')).toBe(true);
    expect(matchesStatus(late, 'PAID')).toBe(false);
    expect(matchesStatus(late, null)).toBe(true);
  });
});

describe('G5d-2 · reçus provisoires et saisie d’un paiement', () => {
  it('reçus dans leur propre suite, toujours sans valeur fiscale (test 25)', () => {
    expect(receiptNumber(1)).toBe('PROV-REC-000001');
    expect(receiptNumber(123456)).toBe('PROV-REC-123456');
    expect(RECEIPT_MENTION).toBe('Reçu provisoire, sans valeur fiscale.');
    expect(receiptNumber(7)).not.toMatch(/FACT|FAC-|FA-/);
  });

  it('une référence de transaction se compare sans espaces ni casse', () => {
    expect(normalizedReference(' mp 2027.0801 abc ')).toBe('MP2027.0801ABC');
    expect(normalizedReference('MP2027.0801ABC')).toBe(normalizedReference('mp2027.0801abc'));
  });

  it('saisie : montant entier, date ni future ni avant le document, référence', () => {
    const ok = { amount: 100_000, paidOn: '2027-08-10', transactionRef: 'MP-0001' };
    expect(paymentError(ok, '2027-08-15', '2027-07-30')).toBeNull();
    expect(paymentError({ ...ok, amount: 0 }, '2027-08-15', '2027-07-30')).toMatch(/Montant/);
    expect(paymentError({ ...ok, amount: 10.5 }, '2027-08-15', '2027-07-30')).toMatch(/Montant/);
    expect(paymentError({ ...ok, paidOn: '2027-08-16' }, '2027-08-15', '2027-07-30')).toMatch(/futur/);
    expect(paymentError({ ...ok, paidOn: '2027-07-29' }, '2027-08-15', '2027-07-30')).toBe('Un paiement ne précède pas le document qu’il règle (émis le 30 juillet 2027)');
    expect(paymentError({ ...ok, transactionRef: ' a ' }, '2027-08-15', '2027-07-30')).toMatch(/Référence/);
  });
});

describe('G5d-2 · accès (choix 2 A, D-G5-30 A, D-G5-43 A)', () => {
  it('accès complet quand le document qui a ouvert le délai de grâce est entièrement payé', () => {
    expect(restoresAccess('AWAITING_PAYMENT', true, 0)).toBe(true);
    expect(restoresAccess('LIMITED', true, 0)).toBe(true);
  });

  it('un paiement partiel laisse l’accès tel qu’il est', () => {
    expect(restoresAccess('AWAITING_PAYMENT', true, 1)).toBe(false);
    expect(restoresAccess('LIMITED', true, 60_000)).toBe(false);
  });

  it('jamais sans conditions acceptées, sans document, ni pour un essai, un pilote ou un abonnement déjà actif', () => {
    expect(restoresAccess('LIMITED', false, 0)).toBe(false);
    expect(restoresAccess('AWAITING_PAYMENT', true, null)).toBe(false);
    for (const s of ['TRIAL', 'PILOT', 'AWAITING_ACCEPTANCE', 'ACTIVE']) expect(restoresAccess(s, true, 0)).toBe(false);
  });

  it('une annulation remet en attente un abonnement actif dont le premier document n’est plus payé', () => {
    expect(losesPayment('ACTIVE', 100_000)).toBe(true);
    expect(losesPayment('ACTIVE', 0)).toBe(false);
    expect(losesPayment('AWAITING_PAYMENT', 100_000)).toBe(false);
    expect(losesPayment('ACTIVE', null)).toBe(false);
  });
});

describe('G5d-2 · crédits, remboursements et transferts (D-G5-15 A, §9)', () => {
  it('le montant d’une demande de remboursement en attente est réservé', () => {
    expect(availableCredit(30_000, 0)).toBe(30_000);
    expect(availableCredit(30_000, 10_000)).toBe(20_000);
    expect(availableCredit(10_000, 10_000)).toBe(0);
  });

  it('annulation d’un paiement : crédit disponible d’abord, puis les déductions les plus récentes ; refusée si le crédit est parti', () => {
    expect(cancellationPlan(0, 0, [])).toEqual({ reverse: [], error: null });
    expect(cancellationPlan(30_000, 30_000, [])).toEqual({ reverse: [], error: null });
    const uses = [{ id: 'u1', remaining: 10_000, createdAt: new Date('2027-09-01') }, { id: 'u2', remaining: 15_000, createdAt: new Date('2027-10-01') }];
    expect(cancellationPlan(30_000, 10_000, uses)).toEqual({ reverse: [{ id: 'u2', amount: 15_000 }, { id: 'u1', amount: 5_000 }], error: null });
    expect(cancellationPlan(30_000, 0, [{ id: 'u1', remaining: 10_000, createdAt: new Date('2027-09-01') }])).toEqual({ reverse: [], error: CANCEL_REFUSED });
  });

  it('demande de remboursement : une à la fois, au plus le crédit disponible ; un crédit consommé ne se rembourse pas (test 14)', () => {
    expect(refundRequestError(10_000, 30_000, false)).toBeNull();
    expect(refundRequestError(10_000, 30_000, true)).toMatch(/attend déjà/);
    expect(refundRequestError(40_000, 30_000, false)).toBe('Montant : au plus le crédit disponible (30000)');
    expect(refundRequestError(1, 0, false)).toBe('Aucun crédit disponible à rembourser');
    expect(refundRequestError(0, 30_000, false)).toMatch(/Montant/);
  });

  it('décision : un remboursement porte sa preuve, un refus son motif', () => {
    const ok = { decision: 'REFUNDED' as const, refundedOn: '2027-09-10', means: 'Virement fictif', reference: 'VIR-0001' };
    expect(refundDecisionError(ok, '2027-09-15', '2027-09-05')).toBeNull();
    expect(refundDecisionError({ ...ok, refundedOn: '2027-09-16' }, '2027-09-15', '2027-09-05')).toMatch(/futur/);
    expect(refundDecisionError({ ...ok, refundedOn: '2027-09-04' }, '2027-09-15', '2027-09-05')).toMatch(/précède/);
    expect(refundDecisionError({ ...ok, reference: 'a' }, '2027-09-15', '2027-09-05')).toMatch(/Référence/);
    expect(refundDecisionError({ ...ok, means: '' }, '2027-09-15', '2027-09-05')).toMatch(/Moyen/);
    expect(refundDecisionError({ decision: 'REFUSED', note: 'non' }, '2027-09-15', '2027-09-05')).toMatch(/motif/);
    expect(refundDecisionError({ decision: 'REFUSED', note: 'Crédit déjà déduit du document suivant' }, '2027-09-15', '2027-09-05')).toBeNull();
  });

  it('transfert : même groupe, même monnaie, au plus le crédit disponible, avec l’autorisation et un motif', () => {
    const ok = {
      fromGroupId: 'g', toGroupId: 'g', fromCurrency: 'XOF', toCurrency: 'XOF', sameTenant: false, amount: 10_000, available: 30_000,
      authorizedBy: 'Promoteur du groupe, lettre du 2 septembre 2027', reason: 'Crédit reporté sur le second site',
    };
    expect(transferError(ok)).toBeNull();
    expect(transferError({ ...ok, toGroupId: 'h' })).toMatch(/même groupe/);
    expect(transferError({ ...ok, sameTenant: true })).toMatch(/autre établissement/);
    expect(transferError({ ...ok, toCurrency: 'XAF' })).toMatch(/monnaie/);
    expect(transferError({ ...ok, amount: 40_000 })).toMatch(/au plus/);
    expect(transferError({ ...ok, authorizedBy: '' })).toMatch(/Autorisation/);
    expect(transferError({ ...ok, reason: 'ok' })).toMatch(/Motif/);
  });
});

describe('Messages de la base rendus à l’écran', () => {
  it('le message « CAHIORA: … » est lu sans l’apostrophe inverse dont Prisma l’entoure (défaut trouvé par les essais du lot G5d-2)', () => {
    // Forme exacte d'une erreur levée par une fonction de la base, relevée sur Prisma 6.19.
    const raised = new Error('\nInvalid `prisma.$queryRaw()` invocation:\n\n\nRaw query failed. Code: `P0001`. Message: `ERROR: CAHIORA: un moyen de paiement porte déjà ce nom : modifiez-le plutôt`');
    expect(accessMessage(raised)).toBe('Un moyen de paiement porte déjà ce nom : modifiez-le plutôt');
    expect(documentMessage(raised)).toBe('un moyen de paiement porte déjà ce nom : modifiez-le plutôt');
    expect(accessMessage(new Error('Raw query failed. Code: `23505`. Message: `ERROR: duplicate key`'))).toBeNull();
  });
});
