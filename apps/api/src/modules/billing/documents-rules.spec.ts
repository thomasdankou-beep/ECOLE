import { AmountDecisions, Closed, DECISIONS, firstDueDate, isClosed, Line } from './amounts-rules';
import { CountFact, creditLine, creditLineLabel, EstablishmentFacts, groupPlan, LineFact, nextLine, NextLine, PlannedEstablishment } from './documents-rules';

/**
 * Prochain document de l'abonnement (lot G5c, étape 2), sans base : quel comptage figé donne le document suivant, avec
 * ce que les documents déjà émis ont demandé ; document du groupe ; cas fermés. Mêmes exemples que amounts-rules.spec.ts
 * (rapport « Suite de la validation » du 16 novembre 2026, section 4).
 */

const SCHOOL: AmountDecisions = { firstYearDivisor: 'SCHOOL_MONTHS', rounding: null };
const Y1 = { label: '2026-2027', startDate: '2026-09-01', endDate: '2027-06-30' };
const Y2 = { label: '2027-2028', startDate: '2027-09-01', endDate: '2028-06-30' };
const T = { pricePerPupil: 500, minimum: 40_000 };

let n = 0;
const count = (kind: CountFact['kind'], date: string, cumulative: number, yearLabel = Y1.label, stage = 'FROZEN'): CountFact => ({ id: `c${++n}`, kind, stage, date, yearLabel, cumulative });
const sub = (c: CountFact, l: Line, at = new Date(`${c.date}T12:00:00Z`)): LineFact => ({
  documentKind: 'SUBSCRIPTION', yearLabel: c.yearLabel, countId: c.id, referenceDate: c.date, amount: l.due, pupils: l.pupils, pricePerPupil: l.pricePerPupil,
  minimum: l.minimum, shareMonths: l.share?.months ?? null, shareOf: l.share?.of ?? null, createdAt: at,
});
const facts = (over: Partial<EstablishmentFacts>): EstablishmentFacts => ({
  tenantId: 't1', name: 'École fictive', tariff: T, lastFreeDay: '2026-11-18', counts: [], lines: [], years: { [Y1.label]: Y1, [Y2.label]: Y2 }, ...over,
});
const readyLine = (r: NextLine): Line => {
  if (r.state !== 'READY') throw new Error(`${r.state} : ${r.message}`);
  if (isClosed(r.line)) throw new Error(r.line.message);
  return r.line;
};
const closedOf = (r: NextLine): Closed => {
  if (r.state !== 'READY' || !isClosed(r.line)) throw new Error('calcul fermé attendu');
  return r.line;
};

describe('Documents G5c : prochain document d’un établissement', () => {
  it('rien tant que les conditions ne sont pas acceptées, ni sans fin de gratuité, ni avant le comptage de la fin de la gratuité', () => {
    expect(nextLine(facts({ tariff: null }), SCHOOL)).toMatchObject({ state: 'NOT_CLIENT' });
    expect(nextLine(facts({ lastFreeDay: null }), SCHOOL)).toMatchObject({ state: 'MISSING', message: expect.stringContaining('INFORMATION MANQUANTE') });
    expect(nextLine(facts({ counts: [count('INITIAL', '2026-11-30', 310)] }), SCHOOL)).toMatchObject({ state: 'WAITING', message: expect.stringContaining('18 novembre 2026') });
    expect(nextLine(facts({ counts: [count('TRIAL_END', '2026-11-18', 300, Y1.label, 'PROVISIONAL')] }), SCHOOL)).toMatchObject({ state: 'WAITING' });
  });

  it('première demande : le comptage de la fin de l’essai, fermée tant que D-G5-29 n’est pas tranché', () => {
    const c = count('TRIAL_END', '2026-11-18', 300);
    expect(closedOf(nextLine(facts({ counts: [c] }), DECISIONS)).decision).toBe('D-G5-29');
    const r = nextLine(facts({ counts: [c] }), SCHOOL);
    expect(r).toMatchObject({ state: 'READY', first: true, count: c });
    expect(readyLine(r)).toMatchObject({ share: { months: 8, of: 10 }, amount: 120_000, alreadyBilled: 0, due: 120_000, pupilsChange: 300 });
  });

  it('exemple d’une année entière (section 4) : chaque date facture le complément, la part de 8/10 reste celle du premier document', () => {
    const trial = count('TRIAL_END', '2026-11-18', 300);
    const initial = count('INITIAL', '2026-11-30', 310);
    const march = count('FIRST_REGULARIZATION', '2027-03-31', 330);
    const june = count('FINAL_REGULARIZATION', '2027-06-30', 335);
    const counts = [june, march, initial, trial];
    const lines: LineFact[] = [];
    // D-G5-4 n'est pas tranché : le comptage initial de la première année reste fermé, et la suite de l'année avec lui.
    lines.push(sub(trial, readyLine(nextLine(facts({ counts, lines }), SCHOOL))));
    const blocked = nextLine(facts({ counts, lines }), SCHOOL);
    expect(blocked).toMatchObject({ state: 'READY', count: initial });
    expect(closedOf(blocked).decision).toBe('D-G5-4');
    // Sans le comptage initial (comptage tombé pendant l'essai, par exemple), les deux régularisations suivent.
    const without = counts.filter((c) => c !== initial);
    const dues: number[] = [lines[0].amount];
    for (const c of [march, june]) {
      const l = readyLine(nextLine(facts({ counts: without, lines }), SCHOOL));
      expect(l).toMatchObject({ kind: c.kind, share: { months: 8, of: 10 } });
      dues.push(l.due);
      lines.push(sub(c, l));
    }
    expect(dues).toEqual([120_000, 12_000, 2_000]);
    expect(nextLine(facts({ counts: without, lines }), SCHOOL)).toMatchObject({ state: 'NOTHING' });
  });

  it('D-G5-3 A : la part de la première année reste celle du premier document, même si les dates de l’année changent ensuite', () => {
    const trial = count('TRIAL_END', '2026-11-18', 300);
    const march = count('FIRST_REGULARIZATION', '2027-03-31', 330);
    const lines = [sub(trial, readyLine(nextLine(facts({ counts: [trial] }), SCHOOL)))];
    const longer = { ...Y1, endDate: '2027-07-31' };
    const l = readyLine(nextLine(facts({ counts: [trial, march], lines, years: { [Y1.label]: longer } }), DECISIONS));
    expect(l).toMatchObject({ share: { months: 8, of: 10 }, amount: 132_000, due: 12_000 });
  });

  it('deuxième année : part entière, sans aucune décision en attente', () => {
    const trial = count('TRIAL_END', '2026-11-18', 300);
    const lines = [sub(trial, readyLine(nextLine(facts({ counts: [trial] }), SCHOOL)))];
    const next = [count('INITIAL', '2027-11-30', 320, Y2.label), count('FIRST_REGULARIZATION', '2028-03-31', 340, Y2.label), count('FINAL_REGULARIZATION', '2028-06-30', 345, Y2.label)];
    const dues: number[] = [];
    for (const c of next) {
      const l = readyLine(nextLine(facts({ counts: [trial, ...next], lines }), DECISIONS));
      expect(l).toMatchObject({ yearLabel: Y2.label, share: null });
      dues.push(l.due);
      lines.push(sub(c, l));
    }
    expect(dues).toEqual([160_000, 10_000, 2_500]);
  });

  it('un avoir validé compte dans le déjà demandé ; l’écart d’élèves part du dernier document, avoir compris', () => {
    const trial = count('TRIAL_END', '2026-11-18', 0);
    const initial = count('INITIAL', '2027-11-30', 100, Y2.label);
    const march = count('FIRST_REGULARIZATION', '2028-03-31', 108, Y2.label);
    const lines = [sub(trial, readyLine(nextLine(facts({ counts: [trial] }), SCHOOL)))];
    const first = readyLine(nextLine(facts({ counts: [trial, initial], lines }), DECISIONS));
    expect(first).toMatchObject({ amount: 50_000, due: 50_000 });
    lines.push(sub(initial, first));
    // Exemple de l'école B (plan du 13 novembre) : deux inscriptions exclues, avoir de 1 000 F validé.
    lines.push({ ...sub(initial, first), documentKind: 'CREDIT_NOTE', countId: null, amount: 1_000, pupils: 98, createdAt: new Date('2028-01-12T12:00:00Z') });
    const l = readyLine(nextLine(facts({ counts: [trial, initial, march], lines }), DECISIONS));
    // 108 élèves en mars, 98 après l'avoir : 10 élèves de plus, 5 000 F.
    expect(l).toMatchObject({ alreadyBilled: 49_000, amount: 54_000, due: 5_000, pupilsChange: 10 });
  });

  it('test 15 : un tarif différent de celui du premier document de l’année ferme le calcul (TARIF) ; l’année suivante le reprend', () => {
    const trial = count('TRIAL_END', '2026-11-18', 0);
    const initial = count('INITIAL', '2027-11-30', 320, Y2.label);
    const march = count('FIRST_REGULARIZATION', '2028-03-31', 340, Y2.label);
    const lines = [sub(trial, readyLine(nextLine(facts({ counts: [trial] }), SCHOOL)))];
    lines.push(sub(initial, readyLine(nextLine(facts({ counts: [trial, initial], lines }), DECISIONS))));
    const changed = nextLine(facts({ counts: [trial, initial, march], lines, tariff: { pricePerPupil: 600, minimum: 40_000 } }), DECISIONS);
    expect(closedOf(changed).decision).toBe('TARIF');
  });

  it('arrivée après la fin de l’année : fermé (D-G5-29, point 1) ; dates d’une année absentes : INFORMATION MANQUANTE', () => {
    const late = count('TRIAL_END', '2027-07-04', 300);
    expect(closedOf(nextLine(facts({ counts: [late], lastFreeDay: '2027-07-04' }), SCHOOL)).decision).toBe('D-G5-29');
    expect(nextLine(facts({ counts: [count('TRIAL_END', '2026-11-18', 300, '2030-2031')] }), SCHOOL))
      .toMatchObject({ state: 'MISSING', message: 'INFORMATION MANQUANTE : dates de l’année scolaire 2030-2031' });
  });

  it('un essai suivi d’un pilote : seule la fin du pilote donne la première demande', () => {
    const trial = count('TRIAL_END', '2026-10-10', 120);
    const pilot = count('PILOT_END', '2027-01-31', 150);
    const r = nextLine(facts({ counts: [trial, pilot], lastFreeDay: '2027-01-31' }), SCHOOL);
    expect(r).toMatchObject({ state: 'READY', first: true, count: pilot });
    expect(readyLine(r)).toMatchObject({ share: { months: 5, of: 10 }, fullYear: 75_000, amount: 37_500 });
  });

  it('échéance de la première demande : dernier jour de grâce (D-G5-30 A, 15 jours), ou le jour du document s’il vient après', () => {
    expect(firstDueDate('2026-11-18', '2026-11-19')).toBe('2026-12-03');
    expect(firstDueDate('2026-11-18', '2026-12-10')).toBe('2026-12-10');
  });
});

describe('Documents G5c : document du client', () => {
  const planned = (name: string, r: NextLine): PlannedEstablishment => ({ tenantId: name, name, next: r });
  /** Établissement dont la première année est passée : son prochain document est un comptage initial de 2027-2028. */
  const at = (date: string, pupils: number) => {
    const free = count('TRIAL_END', '2026-11-18', 0);
    const c = count('INITIAL', date, pupils, Y2.label);
    const lines = [sub(free, readyLine(nextLine(facts({ counts: [free] }), SCHOOL)))];
    return nextLine(facts({ counts: [free, c], lines }), DECISIONS);
  };

  it('école indépendante : le document a sa ligne et son total ; rien à émettre sans ligne prête', () => {
    const plan = groupPlan([planned('A', at('2027-11-30', 200))]);
    expect(plan).toMatchObject({ state: 'READY', date: '2027-11-30', yearLabel: Y2.label, total: 100_000, first: false });
    expect(groupPlan([planned('A', { state: 'NOTHING', message: '' })])).toMatchObject({ state: 'NOTHING' });
  });

  it('un établissement fermé ferme le document, avec sa raison', () => {
    const trial = count('TRIAL_END', '2026-11-18', 300);
    expect(groupPlan([planned('A', nextLine(facts({ counts: [trial] }), DECISIONS))])).toMatchObject({ state: 'CLOSED', closed: { decision: 'D-G5-29' } });
  });

  it('groupe de plusieurs établissements : dates différentes ou établissement sans document à la date, fermé (D-G5-31)', () => {
    const plan = groupPlan([planned('A', at('2027-11-30', 200)), planned('B', at('2027-12-31', 100))]);
    expect(plan).toMatchObject({ state: 'CLOSED', closed: { decision: 'D-G5-31' } });
    const alone = groupPlan([planned('A', at('2027-11-30', 200)), planned('B', { state: 'NOT_CLIENT', message: '' })]);
    expect(alone).toMatchObject({ state: 'CLOSED', closed: { decision: 'D-G5-31', message: expect.stringContaining('B : rien à cette date') } });
  });

  it('groupe de plusieurs établissements à la même date : fermé tant que D-G5-32 (élève transféré) n’est pas tranché', () => {
    const plan = groupPlan([planned('A', at('2027-11-30', 200)), planned('B', at('2027-11-30', 100))]);
    expect(plan).toMatchObject({ state: 'CLOSED', closed: { decision: 'D-G5-32', message: expect.stringContaining('groupe de 2 établissements') } });
  });
});

describe('Documents G5c : avoir après l’exclusion validée d’une inscription erronée (règle du 13 novembre, D-G5-13 B)', () => {
  const whole = { pricePerPupil: 500, minimum: 40_000, shareMonths: null, shareOf: null };

  it('année entière : déjà demandé moins le montant recalculé sans l’élève ; l’écart d’élèves suit le dernier document', () => {
    // 250 élèves demandés (125 000 F), une inscription erronée exclue : 249 élèves, 124 500 F, avoir de 500 F.
    expect(creditLine({ related: whole, pupils: 249, previousPupils: 250, alreadyBilled: 125_000 }, DECISIONS)).toMatchObject({
      state: 'READY', amount: 500, pupilsChange: -1, alreadyBilled: 125_000, year: { pupils: 249, fullYear: 124_500, amount: 124_500, share: null },
    });
  });

  it('au minimum, rien ne change : aucun avoir (79 élèves demandés au minimum, 78 après l’exclusion)', () => {
    expect(creditLine({ related: whole, pupils: 78, previousPupils: 79, alreadyBilled: 40_000 }, DECISIONS)).toMatchObject({
      state: 'NONE', message: 'Au minimum annuel, rien ne change : aucun avoir', year: { minimumApplied: true, amount: 40_000 },
    });
    // 81 élèves (40 500 F) puis 79 : l'avoir s'arrête au minimum (500 F, pas 1 000 F).
    expect(creditLine({ related: whole, pupils: 79, previousPupils: 81, alreadyBilled: 40_500 }, DECISIONS)).toMatchObject({ state: 'READY', amount: 500 });
  });

  it('première année : la part du document touché s’applique ; une part qui ne tombe pas juste attend l’arrondi', () => {
    const p810 = { ...whole, shareMonths: 8, shareOf: 10 };
    // 300 élèves à 8/10 : 120 000 F ; 299 : 119 600 F ; avoir de 400 F.
    expect(creditLine({ related: p810, pupils: 299, previousPupils: 300, alreadyBilled: 120_000 }, DECISIONS)).toMatchObject({
      state: 'READY', amount: 400, year: { share: { months: 8, of: 10 }, amount: 119_600 },
    });
    const p911 = { ...whole, shareMonths: 9, shareOf: 11 };
    expect(creditLine({ related: p911, pupils: 100, previousPupils: 101, alreadyBilled: 41_318 }, DECISIONS)).toMatchObject({ state: 'CLOSED', closed: { decision: 'ARRONDI' } });
    // 101 élèves à 9/11 au franc inférieur : 41 318 F ; 100 : 40 909 F ; avoir de 409 F.
    expect(creditLine({ related: p911, pupils: 100, previousPupils: 101, alreadyBilled: 41_318 }, { ...DECISIONS, rounding: 'FLOOR' })).toMatchObject({
      state: 'READY', amount: 409, year: { amount: 40_909, rounded: true },
    });
  });

  it('un élève déjà retiré par un avoir ne donne rien de plus', () => {
    expect(creditLine({ related: whole, pupils: 249, previousPupils: 249, alreadyBilled: 124_500 }, DECISIONS)).toMatchObject({
      state: 'NONE', message: 'Rien n’a été demandé en plus pour cet élève : aucun avoir',
    });
    expect(creditLineLabel('École fictive', 'FIRST_REGULARIZATION', '2027-03-31')).toBe('École fictive · Avoir après exclusion d’une inscription erronée (première régularisation du 31 mars 2027)');
  });

  it('le document suivant part de l’avoir : écart d’élèves avec l’avoir, déjà demandé net des avoirs', () => {
    const trial = count('TRIAL_END', '2026-11-18', 300);
    const march = count('FIRST_REGULARIZATION', '2027-03-31', 309, Y1.label);
    const first = readyLine(nextLine(facts({ counts: [trial] }), SCHOOL));
    const lines: LineFact[] = [sub(trial, first)];
    // Exclusion validée après le premier document : avoir de 400 F (299 élèves).
    lines.push({ ...sub(trial, first), documentKind: 'CREDIT_NOTE', countId: null, amount: 400, pupils: 299, createdAt: new Date('2026-12-01T12:00:00Z') });
    // Le comptage d'initial n'existe pas dans cet exemple : la régularisation de mars suit directement.
    const next = readyLine(nextLine(facts({ counts: [trial, march], lines }), SCHOOL));
    expect(next).toMatchObject({ pupils: 309, pupilsChange: 10, alreadyBilled: 119_600, amount: 123_600, due: 4_000 });
  });
});
