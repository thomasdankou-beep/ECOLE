import { classAt, endOfSchoolDay, enrollmentEpisodes, nameKey, stateAt } from './enrollments';

describe('Lot G4 · comparaison des noms pour les doublons possibles', () => {
  it('accents, majuscules, apostrophes, tirets et ordre des mots ne comptent pas', () => {
    expect(nameKey('Aya-Marie', "N'GUESSAN")).toBe('aya marie nguessan');
    expect(nameKey('NGUESSAN', 'aya marie')).toBe(nameKey('Aya-Marie', 'N’Guessan'));
    expect(nameKey('Brice', 'DÉGBÉ')).toBe(nameKey('degbe', 'BRICE'));
    expect(nameKey('Ifèoluwa', 'ADJOVI')).toBe('adjovi ifeoluwa');
  });

  it('deux prénoms différents ne se confondent pas (frères et sœurs)', () => {
    expect(nameKey('Koffi', 'DOSSOU')).not.toBe(nameKey('Sèna', 'DOSSOU'));
    expect(nameKey('Marie', 'AYA')).not.toBe(nameKey('Aya-Marie', 'KONE'));
    expect(nameKey(' ', '-')).toBe('');
  });
});

describe('Lot G4 · fin du jour de référence dans le fuseau de l’école', () => {
  it('Bénin (UTC+1) et Côte d’Ivoire (UTC+0)', () => {
    expect(endOfSchoolDay('2027-03-31', 'Africa/Porto-Novo').toISOString()).toBe('2027-03-31T22:59:59.999Z');
    expect(endOfSchoolDay('2027-06-30', 'Africa/Porto-Novo').toISOString()).toBe('2027-06-30T22:59:59.999Z');
    expect(endOfSchoolDay('2027-03-31', 'Africa/Abidjan').toISOString()).toBe('2027-03-31T23:59:59.999Z');
    expect(endOfSchoolDay('2028-02-29', 'Africa/Abidjan').toISOString()).toBe('2028-02-29T23:59:59.999Z');
  });

  it("un fuseau à heure d'été reste juste le jour du changement d'heure", () => {
    // Paris passe à l'heure d'été le dimanche 28 mars 2027 : minuit local du 29 mars = 22 h UTC le 28.
    expect(endOfSchoolDay('2027-03-27', 'Europe/Paris').toISOString()).toBe('2027-03-27T22:59:59.999Z');
    expect(endOfSchoolDay('2027-03-28', 'Europe/Paris').toISOString()).toBe('2027-03-28T21:59:59.999Z');
  });
});

describe('Corrections G4 · état d’une inscription rejoué depuis son historique', () => {
  const TZ = 'Africa/Porto-Novo';
  const t = (iso: string) => new Date(iso);
  const R1 = '2026-03-31';
  const R2 = '2026-06-30';
  const now = t('2026-11-13T12:00:00Z');
  const line = (kind: any, createdAt: string, data: Record<string, string> = {}) => ({ kind, createdAt: t(createdAt), data });
  const start = line('ENROLLED', '2025-09-15T08:00:00Z', { classId: 'c1' });
  const state = (status: string, journal: ReturnType<typeof line>[], date: string, knownAt = now) =>
    stateAt(enrollmentEpisodes({ enrolledAt: t('2025-09-15T08:00:00Z'), status }, journal), date, endOfSchoolDay(date, TZ), knownAt);

  it('sortie datée du jour R : plus active à la fin de ce jour (31 mars comme 30 juin), active la veille', () => {
    const exitR1 = [start, line('WITHDRAWN', '2026-03-31T15:00:00Z', { exitDate: R1 })];
    expect(state('WITHDRAWN', exitR1, R1)).toBe('INACTIVE');
    expect(state('WITHDRAWN', exitR1, '2026-03-30')).toBe('ACTIVE');
    const exitR2 = [start, line('TRANSFERRED', '2026-06-30T09:00:00Z', { exitDate: R2 })];
    expect(state('TRANSFERRED', exitR2, R2)).toBe('INACTIVE');
    expect(state('TRANSFERRED', exitR2, R1)).toBe('ACTIVE');
  });

  it('annulée avant R puis rétablie après R : pas active à R (l’état actuel dirait le contraire), active ensuite', () => {
    const j = [start, line('CANCELLED', '2026-03-20T10:00:00Z'), line('REINSTATED', '2026-04-10T09:00:00Z', { classId: 'c1' })];
    expect(state('ACTIVE', j, R1)).toBe('INACTIVE');
    expect(state('ACTIVE', j, R2)).toBe('ACTIVE');
  });

  it('partie avant R puis revenue après R : pas active à R ; revenue le soir du jour R : active à R', () => {
    const k = [start, line('WITHDRAWN', '2026-03-15T12:00:00Z', { exitDate: '2026-03-15' }), line('REINSTATED', '2026-04-12T09:00:00Z', { classId: 'c1' })];
    expect(state('ACTIVE', k, R1)).toBe('INACTIVE');
    expect(state('ACTIVE', k, R2)).toBe('ACTIVE');
    const o = [start, line('CANCELLED', '2026-03-10T10:00:00Z'), line('REINSTATED', '2026-03-31T18:00:00Z', { classId: 'c1' })];
    expect(state('ACTIVE', o, R1)).toBe('ACTIVE');
  });

  it('annulée après R : elle était active à R (règle validée), plus ensuite', () => {
    const c = [start, line('CANCELLED', '2026-04-01T10:00:00Z')];
    expect(state('CANCELLED', c, R1)).toBe('ACTIVE');
    expect(state('CANCELLED', c, R2)).toBe('INACTIVE');
  });

  it('sortie enregistrée après coup avec une date antérieure : le calcul figé à un instant ne change pas', () => {
    const l = [start, line('TRANSFERRED', '2026-04-05T10:00:00Z', { exitDate: '2026-03-25' })];
    expect(state('TRANSFERRED', l, R1, t('2026-04-01T00:00:00Z'))).toBe('ACTIVE');
    expect(state('TRANSFERRED', l, R1)).toBe('INACTIVE');
  });

  it('inscription enregistrée après l’instant du calcul : ignorée', () => {
    const late = [line('ENROLLED', '2026-03-31T10:00:00Z', { classId: 'c1' })];
    const episodes = enrollmentEpisodes({ enrolledAt: t('2026-03-31T10:00:00Z'), status: 'ACTIVE' }, late);
    expect(stateAt(episodes, R1, endOfSchoolDay(R1, TZ), t('2026-03-31T09:00:00Z'))).toBe('INACTIVE');
    expect(stateAt(episodes, R1, endOfSchoolDay(R1, TZ), now)).toBe('ACTIVE');
  });

  it('départ enregistré avant l’historique (sans date) : à vérifier, jamais compté ni écarté en silence', () => {
    expect(state('WITHDRAWN', [], R1)).toBe('UNKNOWN');
    // Rétablie ensuite : avant le retour on ne sait pas, après le retour elle est active.
    const back = [line('REINSTATED', '2026-04-12T09:00:00Z', { classId: 'c1', previousClassId: 'c0' })];
    expect(state('ACTIVE', back, R1)).toBe('UNKNOWN');
    expect(state('ACTIVE', back, R2)).toBe('ACTIVE');
    // Une inscription d'avant l'historique, toujours active : active.
    expect(state('ACTIVE', [], R1)).toBe('ACTIVE');
  });

  it('classe à la date R : changements de classe et retours rejoués', () => {
    const m = [start, line('CLASS_CHANGED', '2026-05-02T10:00:00Z', { fromClassId: 'c1', toClassId: 'c2' })];
    expect(classAt({ classId: 'c2' }, m, endOfSchoolDay(R1, TZ), now)).toBe('c1');
    expect(classAt({ classId: 'c2' }, m, endOfSchoolDay(R2, TZ), now)).toBe('c2');
    // Inscription d'avant l'historique : la classe d'origine vient du premier changement ou du premier retour.
    expect(classAt({ classId: 'c2' }, m.slice(1), endOfSchoolDay(R1, TZ), now)).toBe('c1');
    expect(classAt({ classId: 'c3' }, [line('REINSTATED', '2026-04-12T09:00:00Z', { classId: 'c3', previousClassId: 'c0' })], endOfSchoolDay(R1, TZ), now)).toBe('c0');
  });
});
