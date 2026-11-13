import { ClassChoice, classSuffix, proposeClass, ProposalInput } from './reenrollment';

/** Classes fictives de l'année en cours : deux sites, deux classes de 4e à Togbin, une à Hêdomey. */
const C = (id: string, name: string, levelId: string, levelName: string, siteId: string, over: Partial<ClassChoice> = {}): ClassChoice => ({
  id, name, levelId, levelName, siteId, siteName: siteId === 'tog' ? 'Togbin' : 'Hêdomey', trackId: null, full: false, ...over,
});
const classes: ClassChoice[] = [
  C('4a', '4e A', 'L4', '4e', 'tog'),
  C('4b', '4e B', 'L4', '4e', 'tog'),
  C('4c', '4e C', 'L4', '4e', 'hed'),
  C('5a', '5e A', 'L5', '5e', 'tog'),
  C('2f3', '2e année F3', 'A2', '2e année', 'hed', { trackId: 'F3' }),
  C('2f4', '2e année F4', 'A2', '2e année', 'hed', { trackId: 'F4' }),
];
const from5eA = { className: '5e A', siteId: 'tog', trackId: null, levelId: 'L5', levelName: '5e', nextLevelId: 'L4', nextLevelName: '4e' };
const input = (over: Partial<ProposalInput>): ProposalInput => ({ outcome: 'ADMIS', from: from5eA, classes, year: '2027-2028', ...over });

describe('Corrections G4 · classe proposée à la réinscription', () => {
  it('admis : classe du niveau suivant, même site, même lettre', () => {
    expect(proposeClass(input({}))).toMatchObject({ basis: 'ADMIS', levelName: '4e', classId: '4a', className: '4e A', note: 'Admis : classe supérieure (4e) : 4e A · Togbin.' });
  });

  it('non admis : classe du même niveau (sa classe de l’an dernier quand elle existe encore)', () => {
    expect(proposeClass(input({ outcome: 'NON_ADMIS' }))).toMatchObject({ basis: 'NON_ADMIS', levelName: '5e', classId: '5a', className: '5e A' });
  });

  it('sans décision de fin d’année : aucune proposition', () => {
    expect(proposeClass(input({ outcome: null }))).toMatchObject({ basis: 'SANS_DECISION', classId: null, note: 'Aucune décision de fin d’année enregistrée : choisissez la classe.' });
  });

  it('niveau suivant non défini par la direction : aucune proposition, et on dit où le définir', () => {
    const r = proposeClass(input({ from: { ...from5eA, nextLevelId: null, nextLevelName: null } }));
    expect(r).toMatchObject({ basis: 'ADMIS', classId: null });
    expect(r.note).toContain('Paramètres › Niveaux');
  });

  it('même filière d’abord (1re année F3 → 2e année F3)', () => {
    const from = { className: '1re année F3', siteId: 'hed', trackId: 'F3', levelId: 'A1', levelName: '1re année', nextLevelId: 'A2', nextLevelName: '2e année' };
    expect(proposeClass(input({ from })).classId).toBe('2f3');
    expect(proposeClass(input({ from: { ...from, trackId: 'F4', className: '1re année F4' } })).classId).toBe('2f4');
  });

  it('deux classes aussi bonnes l’une que l’autre : on ne choisit pas', () => {
    const r = proposeClass(input({ from: { ...from5eA, className: '5e' } }));
    expect(r).toMatchObject({ classId: null, levelName: '4e' });
    expect(r.note).toBe('Admis : classe supérieure (4e). Plusieurs classes possibles (4e A, 4e B) : choisissez.');
  });

  it('une classe complète n’est jamais proposée ; toutes complètes : à choisir', () => {
    const fullA = classes.map((c) => (c.id === '4a' ? { ...c, full: true } : c));
    expect(proposeClass(input({ classes: fullA })).classId).toBe('4b');
    const allFull = classes.map((c) => (c.siteId === 'tog' && c.levelId === 'L4' ? { ...c, full: true } : c));
    const r = proposeClass(input({ classes: allFull }));
    expect(r.classId).toBeNull();
    expect(r.note).toContain('sont complètes');
  });

  it('autre site seulement si le site de l’élève n’a aucune classe de ce niveau', () => {
    const fromHed = { ...from5eA, siteId: 'hed', className: '5e A' };
    expect(proposeClass(input({ from: fromHed })).classId).toBe('4c');
    const onlyTog = classes.filter((c) => c.id !== '4c');
    expect(proposeClass(input({ from: fromHed, classes: onlyTog })).classId).toBe('4a');
  });

  it('périmètre : seules les classes que la personne peut choisir sont proposées', () => {
    const hedOnly = classes.filter((c) => c.siteId === 'hed');
    const r = proposeClass(input({ from: { ...from5eA, nextLevelId: 'L5', nextLevelName: '5e' }, classes: hedOnly }));
    expect(r.classId).toBeNull();
    expect(r.note).toContain('dans votre périmètre');
  });

  it('retour dans l’année (départ puis retour) : sa classe de cette année, si elle a de la place', () => {
    expect(proposeClass(input({ returningClassId: '4b' }))).toMatchObject({ basis: 'RETOUR', classId: '4b', className: '4e B' });
    const full = classes.map((c) => (c.id === '4b' ? { ...c, full: true } : c));
    expect(proposeClass(input({ returningClassId: '4b', classes: full }))).toMatchObject({ basis: 'RETOUR', classId: null });
  });

  it('lettre ou filière de la classe, quelle que soit l’écriture', () => {
    expect(classSuffix('5e A', '5e')).toBe('a');
    expect(classSuffix('1re Année F3', '1re année')).toBe('f3');
    expect(classSuffix('Tle F3', 'Terminale')).toBe('f3');
    expect(classSuffix('CM2', 'CM2')).toBe('');
  });
});
