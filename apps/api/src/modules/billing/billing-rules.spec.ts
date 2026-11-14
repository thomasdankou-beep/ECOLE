import {
  addDays, calendarErrors, dueAlerts, daysLeft, frDay, isDay, parameterError, pilotEndDay, proposeCalendar, retroactiveChanges, trialEndDay, versionOn,
} from './billing-rules';

/** Règles du lot G5a, sans base : cahier des charges du lot G5 du 14 novembre 2026. */
describe('Facturation G5a : dates de l’essai et du pilote', () => {
  it('essai de 14 jours : le jour d’ouverture est le jour 1 (1er au 14 juillet, payant dès le 15)', () => {
    expect(trialEndDay('2027-07-01', 14)).toBe('2027-07-14');
    expect(addDays(trialEndDay('2027-07-01', 14), 1)).toBe('2027-07-15');
    expect(trialEndDay('2026-12-25', 14)).toBe('2027-01-07');
  });

  it('pilote de 3 mois : du 5 novembre 2026 au 4 février 2027 inclus', () => {
    expect(pilotEndDay('2026-11-05', 3)).toBe('2027-02-04');
    expect(pilotEndDay('2026-03-01', 3)).toBe('2026-05-31');
    // Quantième absent du mois d'arrivée : dernier jour de ce mois.
    expect(pilotEndDay('2027-01-31', 1)).toBe('2027-02-28');
    expect(pilotEndDay('2027-11-30', 3)).toBe('2028-02-29');
    expect(pilotEndDay('2026-11-05', 12)).toBe('2027-11-04');
  });

  it('alertes avant la fin du pilote : 30 puis 7 jours avant, une seule fois chacune, jamais après la fin', () => {
    const end = '2027-02-04';
    expect(dueAlerts('2027-01-04', end, [30, 7])).toEqual([]);
    expect(dueAlerts('2027-01-05', end, [30, 7])).toEqual([30]);
    expect(dueAlerts('2027-01-28', end, [30, 7])).toEqual([30, 7]);
    expect(dueAlerts(end, end, [7, 30, 7])).toEqual([30, 7]);
    expect(dueAlerts('2027-02-05', end, [30, 7])).toEqual([]);
    expect(daysLeft('2027-01-28', end)).toBe(8);
    expect(daysLeft('2027-02-05', end)).toBe(0);
  });

  it('dates lisibles et dates invalides', () => {
    expect(frDay('2027-02-04')).toBe('4 février 2027');
    expect(frDay('2026-11-01')).toBe('1er novembre 2026');
    expect(isDay('2027-02-29')).toBe(false);
    expect(isDay('2028-02-29')).toBe(true);
    expect(isDay('04/02/2027')).toBe(false);
  });
});

describe('Facturation G5a : paramètres datés (§2 et §15)', () => {
  const v = (id: string, value: number, effectiveFrom: string, createdAt: string, currency: string | null = 'XOF') => ({ id, key: 'PRICE_PER_PUPIL', currency, value, effectiveFrom, createdAt: new Date(createdAt) });
  const versions = [
    v('a', 500, '2026-11-14', '2026-11-14T08:00:00Z'),
    v('b', 600, '2027-09-01', '2026-12-01T08:00:00Z'),
    v('c', 650, '2027-09-01', '2026-12-02T08:00:00Z'),
    v('d', 300, '2026-11-14', '2026-11-14T08:00:00Z', 'XAF'),
  ];

  it('la valeur d’un jour est la version de date d’effet la plus récente jusqu’à ce jour, puis la dernière inscrite', () => {
    expect(versionOn(versions, 'PRICE_PER_PUPIL', 'XOF', '2026-11-13')).toBeNull();
    expect(versionOn(versions, 'PRICE_PER_PUPIL', 'XOF', '2026-11-14')?.value).toBe(500);
    expect(versionOn(versions, 'PRICE_PER_PUPIL', 'XOF', '2027-08-31')?.value).toBe(500);
    expect(versionOn(versions, 'PRICE_PER_PUPIL', 'XOF', '2027-09-01')?.value).toBe(650);
    expect(versionOn(versions, 'PRICE_PER_PUPIL', 'XAF', '2027-09-01')?.value).toBe(300);
    expect(versionOn(versions, 'PRICE_PER_PUPIL', 'GNF', '2027-09-01')).toBeNull();
  });

  it('une nouvelle valeur n’a jamais d’effet dans le passé, et chaque paramètre garde ses bornes', () => {
    const cur = ['XOF', 'XAF', 'GNF'];
    expect(parameterError('PRICE_PER_PUPIL', 'XOF', 600, '2026-11-13', '2026-11-14', cur)).toMatch(/ne peut pas être passée/);
    expect(parameterError('PRICE_PER_PUPIL', 'XOF', 600, '2026-11-14', '2026-11-14', cur)).toBeNull();
    expect(parameterError('PRICE_PER_PUPIL', null, 600, '2026-11-20', '2026-11-14', cur)).toMatch(/Monnaie/);
    expect(parameterError('TRIAL_DAYS', 'XOF', 14, '2026-11-20', '2026-11-14', cur)).toMatch(/ne dépend pas/);
    expect(parameterError('TRIAL_DAYS', null, 0, '2026-11-20', '2026-11-14', cur)).toMatch(/entre 1 et 90/);
    expect(parameterError('COMMISSION_PREMIUM', null, 2000, '2026-11-20', '2026-11-14', cur)).toBeNull();
    expect(parameterError('COMMISSION_PREMIUM', null, 10_001, '2026-11-20', '2026-11-14', cur)).toMatch(/entre 0 et 10000/);
    expect(parameterError('PRICE_PER_PUPIL', 'XOF', 499.5, '2026-11-20', '2026-11-14', cur)).toMatch(/entier/);
    expect(parameterError('INCONNU', null, 1, '2026-11-20', '2026-11-14', cur)).toBe('Paramètre inconnu');
  });
});

describe('Facturation G5a : calendriers propres à chaque établissement (§3, formule provisoire D-G5-28)', () => {
  it('formule B : septembre à juin → 30 novembre, 31 mars, 30 juin ; octobre à juillet ; janvier à décembre', () => {
    expect(proposeCalendar('2026-09-01', '2027-06-30', 'B')).toEqual({ initialCountDate: '2026-11-30', firstRegularizationDate: '2027-03-31', finalRegularizationDate: '2027-06-30' });
    expect(proposeCalendar('2026-10-01', '2027-07-31', 'B')).toEqual({ initialCountDate: '2026-12-31', firstRegularizationDate: '2027-04-30', finalRegularizationDate: '2027-07-31' });
    expect(proposeCalendar('2027-01-04', '2027-12-31', 'B')).toEqual({ initialCountDate: '2027-03-31', firstRegularizationDate: '2027-09-30', finalRegularizationDate: '2027-12-31' });
    // Saint Kisito-GESA (démonstration) : rentrée le 14 septembre, fin le 9 juillet.
    expect(proposeCalendar('2026-09-14', '2027-07-09', 'B')).toEqual({ initialCountDate: '2026-11-30', firstRegularizationDate: '2027-04-30', finalRegularizationDate: '2027-07-09' });
  });

  it('formule A : première régularisation à 70 % de l’année', () => {
    expect(proposeCalendar('2026-09-01', '2027-06-30', 'A')).toEqual({ initialCountDate: '2026-11-30', firstRegularizationDate: '2027-03-31', finalRegularizationDate: '2027-06-30' });
    // Rentrée le 14 septembre, fin le 9 juillet : 298 jours, 70 % = 209 jours → 11 avril (formule B : 30 avril).
    expect(proposeCalendar('2026-09-14', '2027-07-09', 'A').firstRegularizationDate).toBe('2027-04-11');
  });

  it('contrôles d’un calendrier saisi', () => {
    const ok = { startDate: '2026-09-01', endDate: '2027-06-30', initialCountDate: '2026-11-30', firstRegularizationDate: '2027-03-31', finalRegularizationDate: '2027-06-30', preparationFrom: '2026-07-15', renewalDate: '2027-07-01' };
    expect(calendarErrors(ok)).toEqual([]);
    expect(calendarErrors({ ...ok, preparationFrom: null, renewalDate: null })).toEqual([]);
    expect(calendarErrors({ ...ok, endDate: '2026-08-01' })).toContain('La fin de l’année doit suivre son début');
    expect(calendarErrors({ ...ok, firstRegularizationDate: '2026-11-01' })).toContain('Ordre attendu : comptage initial, puis première régularisation, puis régularisation finale');
    expect(calendarErrors({ ...ok, finalRegularizationDate: '2027-07-15' })).toContain('La régularisation finale tombe au plus tard le dernier jour de l’année');
    expect(calendarErrors({ ...ok, preparationFrom: '2026-01-01' })).toContain('La préparation commence avant la rentrée, au plus 6 mois avant');
    expect(calendarErrors({ ...ok, initialCountDate: '2026-02-30' })).toEqual(['Comptage initial : date invalide']);
    expect(calendarErrors({ ...ok, endDate: '2028-06-30', finalRegularizationDate: '2028-06-30' })).toContain('Une année scolaire dure au plus 18 mois');
  });

  it('nouvelle version : une date passée ne change plus, aucune date n’est déplacée dans le passé', () => {
    const v1 = { startDate: '2026-09-01', endDate: '2027-06-30', initialCountDate: '2026-11-30', firstRegularizationDate: '2027-03-31', finalRegularizationDate: '2027-06-30' };
    const today = '2026-12-10';
    expect(retroactiveChanges(v1, { ...v1, firstRegularizationDate: '2027-04-15' }, today)).toEqual([]);
    expect(retroactiveChanges(v1, { ...v1, initialCountDate: '2026-12-31' }, today)).toEqual(['Comptage initial : le 30 novembre 2026 est passé, cette date ne change plus']);
    expect(retroactiveChanges(v1, { ...v1, firstRegularizationDate: '2026-12-01' }, today)).toEqual(['Première régularisation : une date ne peut pas être déplacée dans le passé']);
    expect(retroactiveChanges(v1, { ...v1, renewalDate: '2027-07-01' }, today)).toEqual([]);
  });
});
