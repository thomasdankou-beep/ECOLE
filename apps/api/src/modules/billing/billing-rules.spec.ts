import {
  addDays, calendarErrors, calendarProposal, calendarProposals, daysBetween, dueAlerts, daysLeft, frDay, isAdjusted, isDay, lastDayOfMonth, monthsSpanned, parameterError,
  pilotEndDay, proposeCalendar, retroactiveChanges, trialEndDay, versionOn, yearDatesError,
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

describe('Correction C0 du calendrier (19 novembre 2026) : toutes dates, recalcul, « ajustée », années courtes (CAL-1)', () => {
  it('une proposition pour n’importe quelle rentrée et n’importe quelle fin, recalculée quand l’une change', () => {
    expect(calendarProposal('2026-09-14', '2027-07-09', 'B')).toEqual({ applies: true, message: null, initialCountDate: '2026-11-30', firstRegularizationDate: '2027-04-30', finalRegularizationDate: '2027-07-09' });
    // Même rentrée, fin repoussée au 14 août : la première régularisation suit (31 mai), la finale aussi.
    expect(calendarProposal('2026-09-14', '2027-08-14', 'B')).toMatchObject({ applies: true, firstRegularizationDate: '2027-05-31', finalRegularizationDate: '2027-08-14' });
    // Rentrée le 30 septembre : même comptage initial qu'une rentrée le 1er (décision CAL-2, option A : règle actuelle).
    expect(calendarProposal('2026-09-30', '2027-06-30', 'B').initialCountDate).toBe('2026-11-30');
    expect(calendarProposal('2026-09-01', '2027-06-30', 'B').initialCountDate).toBe('2026-11-30');
    expect(calendarProposal('2026-09-14', '2027-07-09', 'A')).toMatchObject({ applies: true, firstRegularizationDate: '2027-04-11' });
  });

  it('année de 6 mois ou moins, du mois de la rentrée au mois de la fin : aucune formule, dates saisies à la main avec un motif', () => {
    expect(monthsSpanned('2026-09-01', '2027-06-30')).toBe(10);
    expect(monthsSpanned('2027-02-01', '2027-07-31')).toBe(6);
    expect(monthsSpanned('2027-01-15', '2027-07-14')).toBe(7);
    for (const [start, end] of [['2027-02-01', '2027-07-31'], ['2027-03-01', '2027-06-30'], ['2027-01-01', '2027-06-30'], ['2027-05-31', '2027-06-01']]) {
      for (const formula of ['A', 'B'] as const) {
        const p = calendarProposal(start, end, formula);
        expect(p).toMatchObject({ applies: false, initialCountDate: null, firstRegularizationDate: null, finalRegularizationDate: null });
        expect(p.message).toBe(`La formule ${formula} ne s’applique pas à une année de 6 mois ou moins (du mois de la rentrée au mois de la fin) : choisissez « Dates saisies à la main » et indiquez le motif`);
      }
    }
    // Janvier à juin : la formule A donnerait des dates valides, mais la décision CAL-1 vaut pour toutes les années de 6 mois ou moins.
    expect(calendarErrors({ startDate: '2027-01-01', endDate: '2027-06-30', ...proposeCalendar('2027-01-01', '2027-06-30', 'A') })).toEqual([]);
    // 15 janvier au 14 juillet : 7 mois touchés, la formule B s'applique.
    expect(calendarProposal('2027-01-15', '2027-07-14', 'B')).toMatchObject({ applies: true, initialCountDate: '2027-03-31', firstRegularizationDate: '2027-04-30' });
  });

  it('début et fin de l’année contrôlés avant toute proposition', () => {
    expect(yearDatesError('2026-09-01', '2027-06-30')).toBeNull();
    expect(yearDatesError('2026-02-30', '2027-06-30')).toBe('Début de l’année scolaire : date invalide');
    expect(yearDatesError('2026-09-01', undefined)).toBe('Fin de l’année scolaire : date invalide');
    expect(yearDatesError(['2026-09-01'], '2027-06-30')).toBe('Début de l’année scolaire : date invalide');
    expect(yearDatesError('2027-06-30', '2026-09-01')).toBe('La fin de l’année doit suivre son début');
    expect(yearDatesError('2026-09-01', '2028-03-31')).toBe('Une année scolaire dure au plus 18 mois');
    expect(calendarProposals('2027-06-30', '2026-09-01')).toBeNull();
    expect(Object.keys(calendarProposals('2026-09-01', '2027-06-30')!)).toEqual(['B', 'A']);
  });

  it('balayage de chaque rentrée de 2026 : une formule s’applique si et seulement si l’année dure plus de 6 mois, et ses dates sont alors valides', () => {
    // Fins : chaque jour de 140 à 230 jours après la rentrée (là où passe la limite des 6 mois), puis chaque fin de mois
    // jusqu'à 18 mois. Le 19 novembre 2026, chaque fin possible (200 750 années) a aussi été essayée, hors de cette suite.
    let pairs = 0;
    for (let start = '2026-01-01'; start <= '2026-12-31'; start = addDays(start, 1)) {
      const [y, m] = start.split('-').map(Number);
      const ends = new Set<string>();
      for (let n = 140; n <= 230; n++) ends.add(addDays(start, n));
      for (let k = 0; k < 18; k++) ends.add(lastDayOfMonth(y, m - 1 + k));
      for (const end of ends) {
        if (end <= start || daysBetween(start, end) > 550) continue;
        pairs++;
        const all = calendarProposals(start, end)!;
        for (const formula of ['A', 'B'] as const) {
          const p = all[formula];
          if (p.applies !== monthsSpanned(start, end) > 6) throw new Error(`${formula} ${start} → ${end} : ${JSON.stringify(p)}`);
          if (p.applies && calendarErrors({ startDate: start, endDate: end, ...(p as { initialCountDate: string; firstRegularizationDate: string; finalRegularizationDate: string }) }).length) {
            throw new Error(`${formula} ${start} → ${end} : dates proposées refusées`);
          }
        }
      }
    }
    expect(pairs).toBeGreaterThan(365 * 100);
  });

  it('même balayage que le rapport du 16 novembre : 636 années, 432 avec des dates proposées par la formule B', () => {
    let total = 0;
    let applies = 0;
    for (let m = 0; m < 12; m++) {
      for (const day of [1, 15, 'fin'] as const) {
        const start = day === 'fin' ? lastDayOfMonth(2026, m) : `2026-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        for (let months = 1; months <= 18; months++) {
          const end = lastDayOfMonth(2026, m + months - 1);
          if (end <= start || daysBetween(start, end) > 550) continue;
          total++;
          if (calendarProposal(start, end, 'B').applies) applies++;
        }
      }
    }
    expect([total, applies]).toEqual([636, 432]);
  });

  it('une version A ou B dont une date calculée a été changée à la main est « ajustée » ; la préparation et le renouvellement n’y comptent pas', () => {
    const p = proposeCalendar('2026-09-14', '2027-07-09', 'B');
    const v = { startDate: '2026-09-14', endDate: '2027-07-09', ...p };
    expect(isAdjusted(v, 'B')).toBe(false);
    expect(isAdjusted({ ...v, preparationFrom: '2026-08-01', renewalDate: '2027-07-10' }, 'B')).toBe(false);
    expect(isAdjusted({ ...v, firstRegularizationDate: '2027-04-15' }, 'B')).toBe(true);
    expect(isAdjusted({ ...v, initialCountDate: '2026-12-15' }, 'B')).toBe(true);
    expect(isAdjusted({ ...v, finalRegularizationDate: '2027-07-01' }, 'B')).toBe(true);
    // Les dates de la formule B ne sont pas celles de la formule A ; des dates saisies ne sont jamais « ajustées ».
    expect(isAdjusted(v, 'A')).toBe(true);
    expect(isAdjusted({ ...v, firstRegularizationDate: '2027-04-15' }, 'MANUEL')).toBe(false);
  });
});
