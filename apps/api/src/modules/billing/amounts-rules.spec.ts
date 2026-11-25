import {
  addWorkingDays, AmountDecisions, billableCounts, billingLine, Closed, DECISIONS, DUE_TO_BE_FIXED, EXCLUSION_TARGET_WORKING_DAYS, exclusionDeadline, exclusionLate,
  exclusionOpen, exclusionTarget, firstPaidDayAfter, firstYearShare, groupDocument, isClosed, laterDueDate, Line, simulateYear, Tariff, YearStep, yearAmount, yearTariff,
} from './amounts-rules';
import { addDays, trialEndDay } from './billing-rules';

/**
 * Montants du lot G5c (étape 1), sans base. Les exemples chiffrés viennent des documents de Dankou et des propositions
 * qu'il a validées : cahier des charges G5 du 14 novembre 2026 (tests 1, 2, 7, 8, 9, 10 et 15), plan du 13 novembre
 * (« Simulations chiffrées » et tableau du prorata P1), rapport « Suite de la validation » du 16 novembre (section 4).
 */

const T: Tariff = { pricePerPupil: 500, minimum: 40_000 };
const YEAR = { label: '2026-2027', startDate: '2026-09-01', endDate: '2027-06-30' };
/** Année de Saint Kisito-GESA : du 14 septembre au 9 juillet, soit 11 mois. */
const SK = { label: '2026-2027', startDate: '2026-09-14', endDate: '2027-07-09' };
const SCHOOL: AmountDecisions = { firstYearDivisor: 'SCHOOL_MONTHS', rounding: null };

const ok = <X>(r: X | Closed): X => {
  if (isClosed(r)) throw new Error(r.message);
  return r;
};
const dues = (rows: (Line | Closed)[]) => rows.map((r) => (isClosed(r) ? r.decision : r.due));
const step = (kind: YearStep['kind'], date: string, pupils: number, tariff = T): YearStep => ({ kind, date, pupils, tariff });
const fullYear = (pupils: number[]) => [
  step('INITIAL', '2026-11-30', pupils[0]), step('FIRST_REGULARIZATION', '2027-03-31', pupils[1]), step('FINAL_REGULARIZATION', '2027-06-30', pupils[2]),
];
/** Première facture d'une école dont le premier jour payant est `firstPaid` (comptage figé la veille). */
const firstInvoice = (firstPaid: string, pupils: number, decisions: AmountDecisions, year = YEAR): Line | Closed => billingLine({
  kind: 'TRIAL_END', date: addDays(firstPaid, -1), year, pupils, previousPupils: 0, tariff: T, firstPaidDay: firstPaid, alreadyBilled: 0,
}, decisions);

describe('Montants G5c : aucune décision prise à la place de Dankou', () => {
  it('au 19 novembre 2026, ni le diviseur de la première année ni l’arrondi ne sont choisis', () => {
    expect(DECISIONS).toEqual({ firstYearDivisor: null, rounding: null });
  });
});

describe('Montants G5c : montant de l’année, MAX(élèves × prix ; minimum)', () => {
  it('test 1 : une école de moins de 80 élèves paie le minimum annuel', () => {
    for (const pupils of [0, 1, 50, 79]) {
      expect(ok(yearAmount(pupils, T, null, null))).toMatchObject({ amount: 40_000, minimumApplied: true, fullYear: 40_000 });
    }
  });

  it('test 2 : au-delà de 80 élèves, 500 F par élève ; à 80, les deux se valent (80 × 500 F = 40 000 F)', () => {
    expect(yearAmount(80, T, null, null)).toMatchObject({ amount: 40_000, minimumApplied: false });
    expect(yearAmount(81, T, null, null)).toMatchObject({ amount: 40_500, minimumApplied: false });
    expect(yearAmount(300, T, null, null)).toMatchObject({ amount: 150_000, share: null, rounded: false });
  });

  it('les montants viennent des paramètres en vigueur, jamais de valeurs écrites dans le code', () => {
    expect(yearAmount(100, { pricePerPupil: 600, minimum: 50_000 }, null, null)).toMatchObject({ amount: 60_000, pricePerPupil: 600, minimum: 50_000 });
    expect(yearAmount(100, { pricePerPupil: 600, minimum: 70_000 }, null, null)).toMatchObject({ amount: 70_000, minimumApplied: true });
  });

  it('refuse un nombre d’élèves, un prix ou un minimum qui n’est pas un entier valable', () => {
    expect(() => yearAmount(-1, T, null, null)).toThrow('Élèves facturables');
    expect(() => yearAmount(1.5, T, null, null)).toThrow('Élèves facturables');
    expect(() => yearAmount(10, { pricePerPupil: 0, minimum: 0 }, null, null)).toThrow('Prix par élève');
    expect(() => yearAmount(10, { pricePerPupil: 500, minimum: -1 }, null, null)).toThrow('Minimum annuel');
    expect(() => yearAmount(10, T, { months: 11, of: 10 }, null)).toThrow('année entière');
  });
});

describe('Montants G5c : seul le complément est facturé (D-G5-10 A)', () => {
  it('exemple du cahier des charges : 200, 230 puis 250 élèves donnent 100 000 F, 15 000 F puis 10 000 F', () => {
    const rows = simulateYear(YEAR, null, fullYear([200, 230, 250]), DECISIONS);
    expect(dues(rows)).toEqual([100_000, 15_000, 10_000]);
    expect(ok(rows[2])).toMatchObject({ amount: 125_000, alreadyBilled: 115_000, pupilsChange: 20 });
  });

  it('deuxième année, part entière (rapport du 16 novembre) : 320, 340 puis 345 élèves', () => {
    expect(dues(simulateYear(YEAR, null, fullYear([320, 340, 345]), DECISIONS))).toEqual([160_000, 10_000, 2_500]);
  });

  it('tests 7 et 8 : groupe de trois écoles déjà clientes (plan du 13 novembre), chacune calculée à part, minimum compris', () => {
    const a = simulateYear(YEAR, null, fullYear([50, 90, 92]), DECISIONS);
    const b = simulateYear(YEAR, null, fullYear([100, 100, 106]), DECISIONS);
    const c = simulateYear(YEAR, null, fullYear([200, 220, 220]), DECISIONS);
    expect(dues(a)).toEqual([40_000, 5_000, 1_000]);
    expect(dues(b)).toEqual([50_000, 0, 3_000]);
    expect(dues(c)).toEqual([100_000, 10_000, 0]);
    const totals = [0, 1, 2].map((i) => {
      const doc = groupDocument([{ establishment: 'A', line: a[i] }, { establishment: 'B', line: b[i] }, { establishment: 'C', line: c[i] }]);
      if (isClosed(doc)) throw new Error(doc.message);
      return doc.total;
    });
    expect(totals).toEqual([190_000, 15_000, 4_000]);
    expect([a, b, c].map((rows) => ok(rows[2]).amount)).toEqual([46_000, 53_000, 110_000]);
    // Aucun élève facturé deux fois : la somme des documents de l'année est le montant de l'année, pas plus.
    expect(totals.reduce((s, n) => s + n, 0)).toBe(209_000);
  });

  it('rien de nouveau à une date : relevé à 0 F, jamais un montant négatif', () => {
    const rows = simulateYear(YEAR, null, fullYear([60, 70, 79]), DECISIONS);
    expect(dues(rows)).toEqual([40_000, 0, 0]);
    expect(rows.every((r) => !isClosed(r) && r.creditToReview === 0)).toBe(true);
  });
});

describe('Montants G5c : première année, part P1 (D-G5-2 provisoire, D-G5-3 A)', () => {
  it('tant que D-G5-29 n’est pas tranché, aucun montant de première année ; les années entières se calculent', () => {
    const r = firstInvoice('2026-11-19', 300, DECISIONS);
    expect(r).toMatchObject({ closed: true, decision: 'D-G5-29' });
    expect((r as Closed).message).toMatch(/^En attente de la décision D-G5-29/);
    expect(dues(simulateYear(YEAR, null, fullYear([200, 230, 250]), DECISIONS))).toEqual([100_000, 15_000, 10_000]);
  });

  it('dates d’arrivée (rapport du 16 novembre) : part sur les mois de l’année scolaire, minimum compris', () => {
    const cases: [string, number, number, number][] = [
      ['2026-11-19', 8, 120_000, 32_000],
      ['2027-02-01', 5, 75_000, 20_000],
      ['2027-06-15', 1, 15_000, 4_000],
    ];
    for (const [firstPaid, months, big, small] of cases) {
      expect(ok(firstInvoice(firstPaid, 300, SCHOOL))).toMatchObject({ share: { months, of: 10 }, amount: big, due: big });
      expect(ok(firstInvoice(firstPaid, 50, SCHOOL))).toMatchObject({ share: { months, of: 10 }, amount: small, minimumApplied: true });
    }
  });

  it('tableau du prorata P1 du plan du 13 novembre, option A (60, 150 et 400 élèves)', () => {
    const rows: [string, number[]][] = [
      ['2026-09-15', [40_000, 75_000, 200_000]],
      ['2026-11-03', [32_000, 60_000, 160_000]],
      ['2026-12-09', [28_000, 52_500, 140_000]],
      ['2027-03-01', [16_000, 30_000, 80_000]],
      ['2027-04-16', [12_000, 22_500, 60_000]],
      ['2027-06-29', [4_000, 7_500, 20_000]],
    ];
    for (const [firstPaid, expected] of rows) {
      expect([60, 150, 400].map((n) => ok(firstInvoice(firstPaid, n, SCHOOL)).amount)).toEqual(expected);
    }
  });

  it('variante de D-G5-29 : toujours diviser par 12 donne 8/12, soit 100 000 F au lieu de 120 000 F', () => {
    expect(ok(firstInvoice('2026-11-19', 300, { firstYearDivisor: 'TWELVE', rounding: null }))).toMatchObject({ share: { months: 8, of: 12 }, amount: 100_000 });
    expect(firstYearShare('2026-09-01', YEAR, 'TWELVE')).toEqual({ months: 10, of: 12 });
    expect(firstYearShare('2026-09-01', YEAR, 'SCHOOL_MONTHS')).toEqual({ months: 10, of: 10 });
  });

  it('arrivée avant la rentrée ou après la fin de l’année : fermé (D-G5-29, point 1)', () => {
    expect(firstInvoice('2026-08-20', 300, SCHOOL)).toMatchObject({
      closed: true, decision: 'D-G5-29',
      message: 'En attente de la décision D-G5-29 (première année d’un établissement) : premier jour payant, le 20 août 2026, hors de l’année scolaire 2026-2027 (avant la rentrée ou après la fin)',
    });
    expect(firstInvoice('2027-07-04', 300, SCHOOL)).toMatchObject({ closed: true, decision: 'D-G5-29' });
    expect(() => firstYearShare('2026-08-20', YEAR, 'SCHOOL_MONTHS')).toThrow('dans l’année scolaire');
  });

  it('comptage initial après la première facture : fermé (D-G5-4), et la suite de l’année avec lui', () => {
    // Rapport du 16 novembre : 300 élèves au 19 novembre, 310 au 30 novembre.
    const rows = simulateYear(YEAR, '2026-11-19', [
      step('TRIAL_END', '2026-11-18', 300), ...fullYear([310, 330, 335]),
    ], SCHOOL);
    expect(dues(rows)).toEqual([120_000, 'D-G5-4']);
    expect((rows[1] as Closed).message).toContain('comptage initial du 30 novembre 2026');
    // Plan du 13 novembre : 40 élèves à la fin de l'essai (minimum, part entière), 150 au 30 novembre.
    expect(dues(simulateYear(YEAR, '2026-09-15', [step('TRIAL_END', '2026-09-14', 40), step('INITIAL', '2026-11-30', 150)], SCHOOL)))
      .toEqual([40_000, 'D-G5-4']);
  });

  it('les arrivées de la première année gardent la même part : 30 élèves de plus coûtent 400 F chacun à 8/10', () => {
    const firstPaid = firstPaidDayAfter(trialEndDay('2026-10-20', 14));
    expect(firstPaid).toBe('2026-11-03');
    expect(ok(firstInvoice(firstPaid, 150, SCHOOL)).amount).toBe(60_000);
    const march = billingLine({
      kind: 'FIRST_REGULARIZATION', date: '2027-03-31', year: YEAR, pupils: 180, previousPupils: 150, tariff: T, firstPaidDay: firstPaid, alreadyBilled: 60_000,
    }, SCHOOL);
    expect(ok(march)).toMatchObject({ share: { months: 8, of: 10 }, amount: 72_000, due: 12_000 });
  });

  it('essai fini après le comptage initial : première facture puis les deux régularisations, à 7/10', () => {
    const rows = simulateYear(YEAR, '2026-12-10', [
      step('TRIAL_END', '2026-12-09', 300), step('FIRST_REGULARIZATION', '2027-03-31', 330), step('FINAL_REGULARIZATION', '2027-06-30', 335),
    ], SCHOOL);
    expect(dues(rows)).toEqual([105_000, 10_500, 1_750]);
    expect(ok(rows[2]).amount).toBe(117_250);
  });
});

describe('Montants G5c : arrondi d’une part qui ne tombe pas juste', () => {
  it('de septembre à juin, à 500 F et 40 000 F, une part tombe toujours juste : aucun arrondi', () => {
    for (let months = 1; months <= 10; months++) {
      for (let pupils = 0; pupils <= 400; pupils++) {
        const r = yearAmount(pupils, T, { months, of: 10 }, null);
        if (isClosed(r) || r.rounded) throw new Error(`${pupils} élèves, ${months}/10`);
      }
    }
  });

  it('Saint Kisito-GESA (11 mois) : sans décision sur l’arrondi, fermé ; au franc inférieur, en faveur de l’école', () => {
    expect(firstYearShare('2027-03-01', SK, 'SCHOOL_MONTHS')).toEqual({ months: 5, of: 11 });
    expect(firstYearShare('2027-03-01', SK, 'TWELVE')).toEqual({ months: 5, of: 12 });
    expect(firstInvoice('2027-03-01', 300, SCHOOL, SK)).toMatchObject({ closed: true, decision: 'ARRONDI' });
    const floor: AmountDecisions = { firstYearDivisor: 'SCHOOL_MONTHS', rounding: 'FLOOR' };
    expect(ok(firstInvoice('2027-03-01', 300, floor, SK))).toMatchObject({ amount: 68_181, rounded: true });
    expect(ok(firstInvoice('2027-03-01', 50, floor, SK))).toMatchObject({ amount: 18_181, rounded: true, minimumApplied: true });
    // Quand la part tombe juste, rien à arrondir, même sans décision.
    expect(ok(firstInvoice('2027-03-01', 110, SCHOOL, SK))).toMatchObject({ amount: 25_000, rounded: false });
  });
});

describe('Montants G5c : tarif changé en cours d’année (test 15)', () => {
  const higher: Tariff = { pricePerPupil: 600, minimum: 40_000 };

  it('le premier document prend le tarif en vigueur ; la suite garde le même tarif, sinon fermé', () => {
    expect(yearTariff(null, higher)).toEqual(higher);
    expect(yearTariff(T, { ...T })).toEqual(T);
    expect(yearTariff(T, higher)).toMatchObject({ closed: true, decision: 'TARIF' });
  });

  it('un document déjà calculé garde ses prix ; le complément suivant attend la décision', () => {
    const rows = simulateYear(YEAR, null, [
      step('INITIAL', '2026-11-30', 200), step('FIRST_REGULARIZATION', '2027-03-31', 230, higher), step('FINAL_REGULARIZATION', '2027-06-30', 250, higher),
    ], DECISIONS);
    expect(dues(rows)).toEqual([100_000, 'TARIF']);
    expect(ok(rows[0])).toMatchObject({ pricePerPupil: 500, amount: 100_000 });
  });

  it('une nouvelle année reprend le tarif en vigueur à son premier document', () => {
    expect(dues(simulateYear({ label: '2027-2028', startDate: '2027-09-01', endDate: '2028-06-30' }, null, [
      step('INITIAL', '2027-11-30', 200, higher),
    ], DECISIONS))).toEqual([120_000]);
  });
});

describe('Montants G5c : exclusion validée après un document (tests 9 et 10)', () => {
  it('école B du plan du 13 novembre : 100 élèves facturés 50 000 F, deux exclus, avoir de 1 000 F à valider', () => {
    const r = ok(billingLine({
      kind: 'INITIAL', date: '2026-11-30', year: YEAR, pupils: 98, previousPupils: 100, tariff: T, firstPaidDay: null, alreadyBilled: 50_000,
    }, DECISIONS));
    expect(r).toMatchObject({ amount: 49_000, due: 0, creditToReview: 1_000, pupilsChange: -2 });
  });

  it('école A, au minimum : 48 élèves après exclusion, toujours 40 000 F, aucun avoir', () => {
    const r = ok(billingLine({
      kind: 'INITIAL', date: '2026-11-30', year: YEAR, pupils: 48, previousPupils: 50, tariff: T, firstPaidDay: null, alreadyBilled: 40_000,
    }, DECISIONS));
    expect(r).toMatchObject({ amount: 40_000, due: 0, creditToReview: 0, minimumApplied: true });
  });

  it('première année à 8/10 : un élève exclu fait proposer 400 F', () => {
    const r = ok(billingLine({
      kind: 'TRIAL_END', date: '2026-11-18', year: YEAR, pupils: 299, previousPupils: 300, tariff: T, firstPaidDay: '2026-11-19', alreadyBilled: 120_000,
    }, SCHOOL));
    expect(r).toMatchObject({ amount: 119_600, creditToReview: 400, due: 0 });
  });

  it('un avoir validé compte dans le déjà demandé : le complément suivant part du montant net', () => {
    // École B : avoir de 1 000 F validé, puis 108 élèves facturables au 31 mars (98 + 10 arrivées).
    const rows = simulateYear(YEAR, null, [step('INITIAL', '2026-11-30', 100), step('FIRST_REGULARIZATION', '2027-03-31', 108)], DECISIONS, 1_000);
    expect(dues(rows)).toEqual([50_000, 5_000]);
    expect(ok(rows[1])).toMatchObject({ amount: 54_000, alreadyBilled: 49_000 });
  });

  it('D-G5-14 A : demande possible jusqu’à 30 jours après le document, ce jour compris', () => {
    expect(exclusionDeadline('2026-11-30')).toBe('2026-12-30');
    expect(exclusionOpen('2026-11-30', '2026-12-30')).toBe(true);
    expect(exclusionOpen('2026-11-30', '2026-12-31')).toBe(false);
  });
});

describe('Montants G5c : comptages qui donnent un document', () => {
  const c = (kind: YearStep['kind'], date: string, stage = 'FROZEN') => ({ kind, date, stage });

  it('fin d’essai figée (première facture le lendemain), puis les dates du calendrier, figées seulement', () => {
    const counts = [c('FIRST_REGULARIZATION', '2027-03-31'), c('INITIAL', '2026-11-30', 'PROVISIONAL'), c('INITIAL', '2026-11-30'), c('TRIAL_END', '2026-11-18')];
    expect(billableCounts(counts, '2026-11-18')).toEqual([c('TRIAL_END', '2026-11-18'), c('INITIAL', '2026-11-30'), c('FIRST_REGULARIZATION', '2027-03-31')]);
    expect(firstPaidDayAfter('2026-11-18')).toBe('2026-11-19');
  });

  it('un essai suivi d’un pilote : seule la fin du pilote donne la première facture ; la période gratuite n’est jamais facturée', () => {
    const counts = [c('TRIAL_END', '2026-11-14'), c('INITIAL', '2026-11-30'), c('PILOT_END', '2027-02-04'), c('FIRST_REGULARIZATION', '2027-03-31')];
    expect(billableCounts(counts, '2027-02-04').map((x) => x.kind)).toEqual(['PILOT_END', 'FIRST_REGULARIZATION']);
  });

  it('sans période gratuite : les dates du calendrier seulement', () => {
    expect(billableCounts([c('INITIAL', '2026-11-30'), c('TRIAL_END', '2026-10-01')], null).map((x) => x.kind)).toEqual(['INITIAL']);
  });
});

describe('Montants G5c : document d’un groupe', () => {
  const line = (date: string, due: number) => ok(billingLine({
    kind: 'INITIAL', date, year: YEAR, pupils: due / 500, previousPupils: 0, tariff: T, firstPaidDay: null, alreadyBilled: 0,
  }, DECISIONS));

  it('établissements facturés à des dates différentes : fermé (D-G5-31)', () => {
    const doc = groupDocument([{ establishment: 'A', line: line('2026-11-30', 50_000) }, { establishment: 'B', line: line('2026-12-31', 60_000) }]);
    expect(doc).toMatchObject({ closed: true, decision: 'D-G5-31' });
    expect((doc as Closed).message).toContain('le 30 novembre 2026, le 31 décembre 2026');
  });

  it('un établissement fermé ferme le document du groupe, avec sa raison', () => {
    const doc = groupDocument([{ establishment: 'A', line: line('2026-11-30', 50_000) }, { establishment: 'B', line: firstInvoice('2026-11-19', 300, DECISIONS) }]);
    expect(doc).toMatchObject({ closed: true, decision: 'D-G5-29' });
  });

  it('même date : une ligne par établissement et le total', () => {
    const doc = groupDocument([{ establishment: 'A', line: line('2026-11-30', 50_000) }, { establishment: 'B', line: line('2026-11-30', 60_000) }]);
    expect(doc).toMatchObject({ date: '2026-11-30', total: 110_000 });
    expect(() => groupDocument([])).toThrow('au moins un établissement');
  });
});

describe('Ajustements G5c-1 : échéance de chaque document à payer (délais proposés, pas activés)', () => {
  it('rien à payer : aucune échéance', () => {
    expect(laterDueDate('2027-04-01', 0, 30)).toEqual({ dueDate: null, rule: 'NOTHING_DUE' });
  });

  it('délai sans version en vigueur : « échéance à fixer », jamais une date inventée', () => {
    expect(laterDueDate('2027-04-01', 25_000, null)).toEqual({ dueDate: null, rule: 'TO_BE_FIXED' });
    expect(DUE_TO_BE_FIXED).toContain('en attente de la validation des conditions commerciales');
  });

  it('délai en vigueur : la date du document plus ce délai', () => {
    expect(laterDueDate('2027-04-01', 25_000, 30)).toEqual({ dueDate: '2027-05-01', rule: 'PARAMETER' });
    expect(laterDueDate('2027-01-20', 15_000, 15)).toEqual({ dueDate: '2027-02-04', rule: 'PARAMETER' });
  });

  it('délai invalide ou date invalide : refus', () => {
    expect(() => laterDueDate('2027-04-01', 25_000, 0)).toThrow('1 au moins');
    expect(() => laterDueDate('2027-04-01', 25_000, 1.5)).toThrow('nombre entier');
    expect(() => laterDueDate('01/04/2027', 25_000, 30)).toThrow();
  });
});

describe('Ajustements G5c-7 : objectif de 7 jours ouvrés pour une demande d’exclusion', () => {
  it('jours ouvrés : du lundi au vendredi (jours fériés : INFORMATION MANQUANTE, non retirés)', () => {
    expect(EXCLUSION_TARGET_WORKING_DAYS).toBe(7);
    // Vendredi 20 novembre 2026 + 7 jours ouvrés : mardi 1er décembre.
    expect(addWorkingDays('2026-11-20', 7)).toBe('2026-12-01');
    // Samedi + 1 jour ouvré : lundi.
    expect(addWorkingDays('2026-11-21', 1)).toBe('2026-11-23');
    expect(addWorkingDays('2026-11-23', 0)).toBe('2026-11-23');
  });

  it('l’objectif part de la demande, ou du document émis après elle (la demande revient alors à Cahiora)', () => {
    expect(exclusionTarget('2026-11-20', null)).toBe('2026-12-01');
    expect(exclusionTarget('2026-11-20', '2026-11-10')).toBe('2026-12-01');
    // Document du mercredi 25 novembre : vendredi 4 décembre.
    expect(exclusionTarget('2026-11-20', '2026-11-25')).toBe('2026-12-04');
  });

  it('en retard seulement si la demande attend encore après le dernier jour ; jamais acceptée d’office', () => {
    expect(exclusionLate('PENDING', '2026-12-01', '2026-12-01')).toBe(false);
    expect(exclusionLate('PENDING', '2026-12-01', '2026-12-02')).toBe(true);
    expect(exclusionLate('VALIDATED', '2026-12-01', '2026-12-09')).toBe(false);
    expect(exclusionLate('REFUSED', '2026-12-01', '2026-12-09')).toBe(false);
  });
});
