import { AnnualOutcome } from '@prisma/client';

/**
 * Classe proposée à la réinscription (corrections du lot G4, demande de Dankou du 13 novembre 2026) :
 * - élève admis : une classe du niveau suivant, si la direction a défini ce niveau (Paramètres › Niveaux) ;
 * - élève non admis : une classe du même niveau que l'année précédente ;
 * - élève qui revient dans l'année (inscription annulée ou départ) : la classe qu'il avait cette année ;
 * - sans décision de fin d'année : aucune proposition.
 * Ce n'est qu'une proposition : la direction ou le secrétariat confirme ou change la classe avant de valider.
 * Entre plusieurs classes du bon niveau, on préfère le même site, puis la même filière, puis la même lettre
 * (5e A → 4e A). Une classe complète n'est jamais proposée ; deux classes aussi bonnes l'une que l'autre : on ne
 * choisit pas, la personne choisit.
 */

export type ClassChoice = {
  id: string; name: string; siteId: string; siteName: string; levelId: string; levelName: string; trackId: string | null; full: boolean;
};

export type ProposalBasis = 'ADMIS' | 'NON_ADMIS' | 'RETOUR' | 'SANS_DECISION';

export type Proposal = {
  basis: ProposalBasis;
  /** Niveau visé (classe supérieure ou même niveau), quand il est connu. */
  levelId: string | null;
  levelName: string | null;
  /** Classe présélectionnée, ou null quand la personne doit choisir. */
  classId: string | null;
  className: string | null;
  /** Explication affichée à l'écran. */
  note: string;
};

export type ProposalInput = {
  outcome: AnnualOutcome | null;
  /** Classe de l'inscription de l'année en cours, annulée ou terminée par un départ : l'élève y revient. */
  returningClassId?: string | null;
  /** Dernière classe de l'année précédente (absente pour un retour dans l'année). */
  from?: { className: string; siteId: string; trackId: string | null; levelId: string; levelName: string; nextLevelId: string | null; nextLevelName: string | null } | null;
  /** Classes de l'année en cours que la personne peut choisir (son périmètre). */
  classes: ClassChoice[];
  year: string;
};

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Partie du nom propre à la classe : « 5e A » → « a », « 1re année F3 » → « f3 », « Tle F3 » (niveau Terminale) → « f3 ». */
export function classSuffix(className: string, levelName: string) {
  const name = fold(className);
  const level = fold(levelName);
  if (level && name.startsWith(level)) return name.slice(level.length).trim();
  const words = name.split(' ');
  return words.length > 1 ? words[words.length - 1] : '';
}

export function proposeClass(input: ProposalInput): Proposal {
  const { classes, year } = input;
  if (input.returningClassId) {
    const same = classes.find((c) => c.id === input.returningClassId);
    const base = { basis: 'RETOUR' as const, levelId: same?.levelId ?? null, levelName: same?.levelName ?? null };
    if (same && !same.full) return { ...base, classId: same.id, className: same.name, note: `Retour dans sa classe de ${year} : ${same.name} · ${same.siteName}.` };
    return { ...base, classId: null, className: null, note: same ? `Sa classe de ${year}, ${same.name}, est complète : choisissez une classe.` : 'Choisissez la classe.' };
  }
  const from = input.from;
  if (!input.outcome || !from) {
    return { basis: 'SANS_DECISION', levelId: null, levelName: null, classId: null, className: null, note: 'Aucune décision de fin d’année enregistrée : choisissez la classe.' };
  }
  if (input.outcome === 'ADMIS' && !from.nextLevelId) {
    return {
      basis: 'ADMIS', levelId: null, levelName: null, classId: null, className: null,
      note: `Admis : le niveau qui suit ${from.levelName} n’est pas défini (Paramètres › Niveaux). Choisissez la classe.`,
    };
  }
  const admitted = input.outcome === 'ADMIS';
  const levelId = admitted ? from.nextLevelId! : from.levelId;
  const levelName = (admitted ? from.nextLevelName : from.levelName) ?? '';
  const base = { basis: input.outcome, levelId, levelName };
  const reason = admitted ? `Admis : classe supérieure (${levelName})` : `Non admis : même niveau (${levelName})`;
  const atLevel = classes.filter((c) => c.levelId === levelId);
  if (!atLevel.length) return { ...base, classId: null, className: null, note: `${reason}. Aucune classe de ${levelName} pour ${year} dans votre périmètre : choisissez une classe.` };
  // Même site d'abord ; un autre site seulement si le site de l'élève n'a aucune classe de ce niveau.
  const sameSite = atLevel.filter((c) => c.siteId === from.siteId);
  const pool = (sameSite.length ? sameSite : atLevel).filter((c) => !c.full);
  if (!pool.length) return { ...base, classId: null, className: null, note: `${reason}. Les classes de ${levelName} sont complètes : choisissez une classe.` };
  const suffix = classSuffix(from.className, from.levelName);
  const score = (c: ClassChoice) => (from.trackId && c.trackId === from.trackId ? 2 : 0) + (suffix && classSuffix(c.name, c.levelName) === suffix ? 1 : 0);
  const best = Math.max(...pool.map(score));
  const top = pool.filter((c) => score(c) === best);
  if (top.length > 1) {
    return { ...base, classId: null, className: null, note: `${reason}. Plusieurs classes possibles (${top.map((c) => c.name).sort().join(', ')}) : choisissez.` };
  }
  return { ...base, classId: top[0].id, className: top[0].name, note: `${reason} : ${top[0].name} · ${top[0].siteName}.` };
}
