/**
 * Moteur de calcul des moyennes (CDC §3.3), sans accès base : testé unitairement.
 *
 * - Moyenne d'une matière = Σ(poids × note sur 20) / Σ poids
 * - Moyenne générale = Σ(coefficient × moyenne matière) / Σ coefficients
 * - Arrondi au centième ; les moyennes de matière sont arrondies avant la moyenne générale,
 *   comme sur un bulletin papier (chaque ligne affichée sert au calcul).
 * - Note manquante : exclue ou comptée 0 (paramètre) ; élève dispensé : toujours exclu.
 */

export type MissingRule = 'exclude' | 'zero';

export interface GradeInput {
  score: number | null;
  maxScore: number;
  weight: number;
  absent?: boolean;
  exempt?: boolean;
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function subjectAverage(grades: GradeInput[], missing: MissingRule = 'exclude'): number | null {
  let sum = 0;
  let weights = 0;
  for (const g of grades) {
    if (g.exempt || g.weight <= 0) continue;
    let on20: number | null = g.score === null || g.score === undefined ? null : (g.score * 20) / g.maxScore;
    if (on20 === null) {
      if (missing === 'zero' && (g.absent || g.score === null)) on20 = 0;
      else continue;
    }
    sum += g.weight * on20;
    weights += g.weight;
  }
  return weights ? round2(sum / weights) : null;
}

export function generalAverage(subjects: { average: number | null; coefficient: number }[]): number | null {
  let sum = 0;
  let coefs = 0;
  for (const s of subjects) {
    if (s.average === null || s.coefficient <= 0) continue;
    sum += s.coefficient * round2(s.average);
    coefs += s.coefficient;
  }
  return coefs ? round2(sum / coefs) : null;
}

/** Rang avec ex æquo : deux moyennes égales ont le même rang, le suivant saute (1, 2, 2, 4). */
export function ranks<T extends { id: string; average: number | null }>(rows: T[]): Map<string, number> {
  const sorted = rows.filter((r) => r.average !== null).sort((a, b) => (b.average as number) - (a.average as number));
  const out = new Map<string, number>();
  sorted.forEach((r, i) => {
    const prev = sorted[i - 1];
    out.set(r.id, prev && prev.average === r.average ? (out.get(prev.id) as number) : i + 1);
  });
  return out;
}

export function stats(values: (number | null)[]) {
  const v = values.filter((x): x is number => x !== null);
  if (!v.length) return { mean: null, min: null, max: null, stddev: null };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const variance = v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length;
  return { mean: round2(mean), min: round2(Math.min(...v)), max: round2(Math.max(...v)), stddev: round2(Math.sqrt(variance)) };
}

/** Moyenne annuelle pondérée par les périodes (ex. T1 × 1, T2 × 1, T3 × 2). */
export function annualAverage(terms: { average: number | null; weight: number }[]): number | null {
  return generalAverage(terms.map((t) => ({ average: t.average, coefficient: t.weight })));
}

export function distinction(average: number | null, thresholds: { min: number; label: string }[]): string | null {
  if (average === null) return null;
  const t = [...thresholds].sort((a, b) => b.min - a.min).find((x) => average >= x.min);
  return t?.label ?? null;
}

/** Décision proposée en fin d'année : admis si la moyenne annuelle atteint le seuil saisi par l'école ; rien sans seuil ni moyenne. */
export function proposedOutcome(average: number | null, passMark: number | null): 'ADMIS' | 'NON_ADMIS' | null {
  if (average === null || passMark === null || passMark === undefined) return null;
  return average >= passMark ? 'ADMIS' : 'NON_ADMIS';
}
