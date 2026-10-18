import { annualAverage, distinction, generalAverage, ranks, stats, subjectAverage } from './grading';

describe('Moteur de calcul des moyennes (CDC §3.3)', () => {
  it("reproduit l'exemple du cahier des charges : 116 / 9 = 12,89", () => {
    expect(generalAverage([
      { average: 12, coefficient: 3 },
      { average: 15, coefficient: 4 },
      { average: 10, coefficient: 2 },
    ])).toBe(12.89);
  });

  it('pondère les évaluations par leur poids', () => {
    // Interrogation 12 (poids 1), devoir 14 (poids 1), composition 9 (poids 2) → (12 + 14 + 18) / 4 = 11
    expect(subjectAverage([
      { score: 12, maxScore: 20, weight: 1 },
      { score: 14, maxScore: 20, weight: 1 },
      { score: 9, maxScore: 20, weight: 2 },
    ])).toBe(11);
  });

  it('ramène sur 20 une note sur 10', () => {
    expect(subjectAverage([{ score: 7.5, maxScore: 10, weight: 1 }])).toBe(15);
  });

  it('exclut une note manquante par défaut, ou la compte 0 selon le paramètre', () => {
    const g = [
      { score: 16, maxScore: 20, weight: 1 },
      { score: null, maxScore: 20, weight: 1, absent: true },
    ];
    expect(subjectAverage(g, 'exclude')).toBe(16);
    expect(subjectAverage(g, 'zero')).toBe(8);
  });

  it("n'inclut jamais un élève dispensé", () => {
    expect(subjectAverage([{ score: 10, maxScore: 20, weight: 1 }, { score: 0, maxScore: 20, weight: 1, exempt: true }], 'zero')).toBe(10);
    expect(subjectAverage([{ score: null, maxScore: 20, weight: 1, exempt: true }])).toBeNull();
  });

  it('arrondit au centième', () => {
    expect(subjectAverage([{ score: 10, maxScore: 20, weight: 1 }, { score: 11, maxScore: 20, weight: 1 }, { score: 11, maxScore: 20, weight: 1 }])).toBe(10.67);
  });

  it('ignore les matières sans moyenne dans la moyenne générale', () => {
    expect(generalAverage([{ average: 14, coefficient: 2 }, { average: null, coefficient: 5 }])).toBe(14);
    expect(generalAverage([])).toBeNull();
  });

  it('classe avec ex æquo (1, 2, 2, 4)', () => {
    const r = ranks([
      { id: 'a', average: 15 }, { id: 'b', average: 12.5 }, { id: 'c', average: 12.5 }, { id: 'd', average: 9 }, { id: 'e', average: null },
    ]);
    expect([r.get('a'), r.get('b'), r.get('c'), r.get('d'), r.get('e')]).toEqual([1, 2, 2, 4, undefined]);
  });

  it('calcule les statistiques de classe', () => {
    expect(stats([10, 12, 14, null])).toEqual({ mean: 12, min: 10, max: 14, stddev: 1.63 });
    expect(stats([null])).toEqual({ mean: null, min: null, max: null, stddev: null });
  });

  it('pondère la moyenne annuelle par période (T1 × 1, T2 × 1, T3 × 2)', () => {
    expect(annualAverage([{ average: 10, weight: 1 }, { average: 12, weight: 1 }, { average: 14, weight: 2 }])).toBe(12.5);
  });

  it('attribue la distinction la plus haute atteinte', () => {
    const t = [{ min: 12, label: "Tableau d'honneur" }, { min: 14, label: 'Encouragements' }, { min: 16, label: 'Félicitations' }];
    expect(distinction(16, t)).toBe('Félicitations');
    expect(distinction(14.99, t)).toBe('Encouragements');
    expect(distinction(12, t)).toBe("Tableau d'honneur");
    expect(distinction(11.99, t)).toBeNull();
  });
});
