import {
  auditDepartureDays, BASIS_LABELS, CountCalendar, CountRecord, CountSubscription, countView, dueCounts, freeEndYear, isToCheck, ItemRow, RecordedCount, resolveItems,
  requestVoids, reviewOpen, sortCounts, TO_CHECK_BASES, VoidingRequest, voidingRequest,
} from './counts-rules';

/**
 * Règles des comptages du lot G5b, sans base : cahier des charges G5 §5 et décisions du 19 novembre 2026
 * (D-G5-13 B, D-G5-14 A, D-G5-16 A).
 */

const CAL: CountCalendar = {
  yearLabel: '2026-2027', version: 1, startDate: '2026-09-14', endDate: '2027-07-31', preparationFrom: '2026-08-01',
  initialCountDate: '2026-11-30', firstRegularizationDate: '2027-03-31', finalRegularizationDate: '2027-06-30',
};
const ACTIVE: CountSubscription = { status: 'ACTIVE', trialEnd: null, pilotEnd: null, endedTrial: null, endedPilot: null };
const done = (kind: RecordedCount['kind'], stage: RecordedCount['stage'], date: string, reviewUntil: string | null = null, yearLabel = '2026-2027'): RecordedCount =>
  ({ kind, stage, date, yearLabel, reviewUntil });

describe('Comptages G5b : comptages dus', () => {
  it('sans abonnement, aucun comptage', () => {
    expect(dueCounts('2026-12-01', null, [CAL], [])).toEqual([]);
  });

  it('fin d’essai : figé aussitôt, le lendemain du dernier jour gratuit, une seule fois', () => {
    const s = { ...ACTIVE, status: 'AWAITING_ACCEPTANCE', trialEnd: '2026-11-14', endedTrial: '2026-11-14' };
    // Le dernier jour gratuit n'est pas terminé : rien.
    expect(dueCounts('2026-11-14', s, [], [])).toEqual([]);
    expect(dueCounts('2026-11-15', s, [], [])).toEqual([
      { kind: 'TRIAL_END', stage: 'FROZEN', date: '2026-11-14', yearLabel: null, calendarVersion: null, reviewUntil: null },
    ]);
    expect(dueCounts('2026-11-20', s, [], [done('TRIAL_END', 'FROZEN', '2026-11-14', null, '2026-2027')])).toEqual([]);
  });

  it('fin d’essai annoncée mais pas encore terminée (événement absent) : rien', () => {
    expect(dueCounts('2026-11-20', { ...ACTIVE, status: 'TRIAL', trialEnd: '2026-11-14' }, [], [])).toEqual([]);
  });

  it('fin de pilote : figé aussitôt ; un essai puis un pilote donnent deux comptages, dans l’ordre', () => {
    const s = { status: 'AWAITING_ACCEPTANCE', trialEnd: '2026-11-14', pilotEnd: '2027-02-04', endedTrial: '2026-11-14', endedPilot: '2027-02-04' };
    expect(dueCounts('2027-02-05', s, [], []).map((d) => `${d.kind}:${d.date}`)).toEqual(['TRIAL_END:2026-11-14', 'PILOT_END:2027-02-04']);
  });

  it('dates du calendrier : provisoire le lendemain, puis figé le lendemain du dernier jour de vérification', () => {
    expect(dueCounts('2026-11-30', ACTIVE, [CAL], [])).toEqual([]);
    expect(dueCounts('2026-12-01', ACTIVE, [CAL], [])).toEqual([
      { kind: 'INITIAL', stage: 'PROVISIONAL', date: '2026-11-30', yearLabel: '2026-2027', calendarVersion: 1, reviewUntil: null },
    ]);
    const provisional = [done('INITIAL', 'PROVISIONAL', '2026-11-30', '2026-12-15')];
    // Vérification ouverte jusqu'au 15 décembre inclus.
    expect(dueCounts('2026-12-15', ACTIVE, [CAL], provisional)).toEqual([]);
    expect(dueCounts('2026-12-16', ACTIVE, [CAL], provisional)).toEqual([
      { kind: 'INITIAL', stage: 'FROZEN', date: '2026-11-30', yearLabel: '2026-2027', calendarVersion: 1, reviewUntil: '2026-12-15' },
    ]);
    expect(dueCounts('2026-12-16', ACTIVE, [CAL], [...provisional, done('INITIAL', 'FROZEN', '2026-11-30', '2026-12-15')])).toEqual([]);
  });

  it('serveur arrêté plusieurs mois : chaque comptage en retard, du plus ancien au plus récent', () => {
    const due = dueCounts('2027-07-02', ACTIVE, [CAL], []);
    expect(due.map((d) => `${d.kind}:${d.stage}:${d.date}`)).toEqual([
      'INITIAL:PROVISIONAL:2026-11-30', 'FIRST_REGULARIZATION:PROVISIONAL:2027-03-31', 'FINAL_REGULARIZATION:PROVISIONAL:2027-06-30',
    ]);
  });

  it('période gratuite : aucun comptage du calendrier pendant l’essai ou le pilote, ni pour une date qui y tombe', () => {
    expect(dueCounts('2026-12-01', { ...ACTIVE, status: 'TRIAL', trialEnd: '2026-12-10' }, [CAL], [])).toEqual([]);
    expect(dueCounts('2026-12-01', { ...ACTIVE, status: 'PILOT', pilotEnd: '2027-02-04' }, [CAL], [])).toEqual([]);
    // Pilote terminé le 4 février : le comptage initial du 30 novembre n'est jamais dû, la régularisation du 31 mars l'est.
    const after = { status: 'AWAITING_ACCEPTANCE', trialEnd: null, pilotEnd: '2027-02-04', endedTrial: null, endedPilot: '2027-02-04' };
    expect(dueCounts('2027-04-01', after, [CAL], [done('PILOT_END', 'FROZEN', '2027-02-04')]).map((d) => `${d.kind}:${d.date}`))
      .toEqual(['FIRST_REGULARIZATION:2027-03-31']);
    // Le dernier jour gratuit lui-même n'est pas compté par le calendrier.
    const onLastDay = { ...after, pilotEnd: '2026-11-30', endedPilot: '2026-11-30' };
    expect(dueCounts('2026-12-01', onLastDay, [CAL], []).map((d) => `${d.kind}:${d.date}`)).toEqual(['PILOT_END:2026-11-30']);
  });

  it('chaque année a ses comptages ; un comptage d’une autre année ne compte pas pour celle-ci', () => {
    const next: CountCalendar = { ...CAL, yearLabel: '2027-2028', version: 2, startDate: '2027-09-13', endDate: '2028-07-31', preparationFrom: null, initialCountDate: '2027-11-30', firstRegularizationDate: '2028-03-31', finalRegularizationDate: '2028-06-30' };
    const recorded = [done('INITIAL', 'FROZEN', '2026-11-30', '2026-12-15'), done('INITIAL', 'PROVISIONAL', '2027-11-30', '2027-12-15', '2026-2027')];
    const due = dueCounts('2027-12-01', ACTIVE, [CAL, next], recorded.slice(0, 1));
    expect(due.map((d) => `${d.yearLabel}:${d.kind}:${d.date}:v${d.calendarVersion}`)).toEqual([
      '2026-2027:FIRST_REGULARIZATION:2027-03-31:v1', '2026-2027:FINAL_REGULARIZATION:2027-06-30:v1', '2027-2028:INITIAL:2027-11-30:v2',
    ]);
    expect(dueCounts('2027-12-01', ACTIVE, [next], recorded).map((d) => d.yearLabel)).toEqual(['2027-2028']);
  });
});

describe('Comptages G5b : année comptée à la fin d’un essai ou d’un pilote', () => {
  const years = [
    { id: 'y1', label: '2026-2027', startDate: '2026-09-14', endDate: '2027-07-31' },
    { id: 'y0', label: '2025-2026', startDate: '2025-09-15', endDate: '2026-07-31' },
  ];
  it('calendrier qui couvre la date, période de préparation comprise : l’année préparée', () => {
    expect(freeEndYear('2026-08-20', [CAL], years)?.label).toBe('2026-2027');
    expect(freeEndYear('2026-12-01', [CAL], years)?.label).toBe('2026-2027');
  });
  it('sans calendrier qui couvre la date : l’année scolaire de l’école qui la contient', () => {
    expect(freeEndYear('2026-03-10', [CAL], years)?.label).toBe('2025-2026');
    expect(freeEndYear('2026-08-20', [], years)).toBeNull();
  });
  it('calendrier d’une année absente de l’école : l’année de l’école, sinon aucune (comptage en attente)', () => {
    const other = { ...CAL, yearLabel: '2027' };
    expect(freeEndYear('2026-12-01', [other], years)?.label).toBe('2026-2027');
    expect(freeEndYear('2026-12-01', [other], [])).toBeNull();
  });
});

describe('Comptages G5b : liste des élèves', () => {
  const row = (id: string, state: ItemRow['state'], unknown: ItemRow['unknown'] = null): ItemRow =>
    ({ enrollmentId: id, studentId: `s-${id}`, classId: 'c1', siteId: null, state, unknown });
  const since = new Date('2026-09-14T08:00:00Z');

  it('inscription active comptée, inscription partie ou pas encore arrivée absente, liste triée', () => {
    const items = resolveItems('2026-11-30', [row('b', 'ACTIVE'), row('a', 'ACTIVE'), row('c', 'INACTIVE')], { direction: new Map(), audit: new Map() }, new Set());
    expect(items).toEqual([
      { enrollmentId: 'a', classId: 'c1', siteId: null, counted: true, basis: 'ACTIVE', departureDate: null },
      { enrollmentId: 'b', classId: 'c1', siteId: null, counted: true, basis: 'ACTIVE', departureDate: null },
    ]);
  });

  it('D-G5-16 A : départ d’avant l’historique daté par le journal, compté seulement si le départ est après le jour R', () => {
    const rows = [row('a', 'UNKNOWN', { since, before: null }), row('b', 'UNKNOWN', { since, before: null })];
    const audit = new Map([['a', '2026-11-30'], ['b', '2026-12-01']]);
    const items = resolveItems('2026-11-30', rows, { direction: new Map(), audit }, new Set());
    // Parti le jour R : plus présent ce jour-là, comme une sortie datée.
    expect(items).toEqual([{ enrollmentId: 'b', classId: 'c1', siteId: null, counted: true, basis: 'DEPARTURE_AUDIT', departureDate: '2026-12-01' }]);
  });

  it('D-G5-16 A : sans aucune date, l’élève est compté et signalé ; la date de la direction l’emporte sur celle du journal', () => {
    const rows = [row('a', 'UNKNOWN', { since, before: null }), row('b', 'UNKNOWN', { since, before: null })];
    const items = resolveItems('2026-11-30', rows, { direction: new Map([['b', '2026-11-02']]), audit: new Map([['b', '2026-12-05']]) }, new Set());
    expect(items).toEqual([{ enrollmentId: 'a', classId: 'c1', siteId: null, counted: true, basis: 'DEPARTURE_UNKNOWN', departureDate: null }]);
    const later = resolveItems('2026-11-30', rows, { direction: new Map([['b', '2026-12-02']]), audit: new Map([['b', '2026-12-05']]) }, new Set());
    expect(later.find((i) => i.enrollmentId === 'b')).toMatchObject({ counted: true, basis: 'DEPARTURE_DIRECTION', departureDate: '2026-12-02' });
  });

  it('exclusion validée : gardée dans la liste, non comptée', () => {
    const items = resolveItems('2026-11-30', [row('a', 'ACTIVE'), row('b', 'ACTIVE')], { direction: new Map(), audit: new Map() }, new Set(['b']));
    expect(items.map((i) => `${i.enrollmentId}:${i.counted}:${i.basis}`)).toEqual(['a:true:ACTIVE', 'b:false:EXCLUDED']);
  });

  it('date du journal : première sortie de l’élève dans la période, déjà écrite à l’instant du comptage, au jour de l’école', () => {
    const knownAt = new Date('2026-12-16T00:00:00Z');
    const rows = [
      row('a', 'UNKNOWN', { since, before: null }),
      row('b', 'UNKNOWN', { since, before: new Date('2026-10-01T00:00:00Z') }),
      row('c', 'ACTIVE'),
    ];
    const logs = [
      // Avant l'arrivée : ignorée.
      { entityId: 's-a', createdAt: new Date('2026-09-01T10:00:00Z') },
      // 23 h 30 UTC le 19 octobre = 0 h 30 le 20 octobre à Porto-Novo (UTC+1).
      { entityId: 's-a', createdAt: new Date('2026-10-19T23:30:00Z') },
      { entityId: 's-a', createdAt: new Date('2026-11-02T10:00:00Z') },
      // Après le retour de l'élève : ignorée.
      { entityId: 's-b', createdAt: new Date('2026-10-05T10:00:00Z') },
      // Écrite après l'instant du comptage : ignorée.
      { entityId: 's-c', createdAt: new Date('2026-12-20T10:00:00Z') },
    ];
    const days = auditDepartureDays(rows, logs, knownAt, 'Africa/Porto-Novo');
    expect([...days.entries()]).toEqual([['a', '2026-10-20']]);
    expect(auditDepartureDays(rows, logs, new Date('2026-10-01T00:00:00Z'), 'Africa/Porto-Novo').size).toBe(0);
  });
});

describe('Comptages G5b : vérification et affichage', () => {
  const rec = (over: Partial<CountRecord>): CountRecord => ({
    id: 'x', yearLabel: '2026-2027', kind: 'INITIAL', referenceDate: '2026-11-30', stage: 'PROVISIONAL', calendarVersion: 1, pupils: 10, cumulative: 10, toCheck: 0,
    excluded: 0, listHash: 'h', at: new Date(), knownAt: new Date(), reviewUntil: '2026-12-15', timeZone: 'Africa/Porto-Novo', createdAt: new Date(), ...over,
  });

  it('vérification ouverte jusqu’au dernier jour inclus, jamais pour un comptage figé', () => {
    expect(reviewOpen({ stage: 'PROVISIONAL', reviewUntil: '2026-12-15' }, '2026-12-15', false)).toBe(true);
    expect(reviewOpen({ stage: 'PROVISIONAL', reviewUntil: '2026-12-15' }, '2026-12-16', false)).toBe(false);
    expect(reviewOpen({ stage: 'PROVISIONAL', reviewUntil: '2026-12-15' }, '2026-12-10', true)).toBe(false);
    expect(reviewOpen({ stage: 'FROZEN', reviewUntil: '2026-12-15' }, '2026-12-10', false)).toBe(false);
  });

  it('un provisoire est « figé depuis » quand le comptage figé de la même date existe', () => {
    const p = rec({ id: 'p' });
    const f = rec({ id: 'f', stage: 'FROZEN' });
    expect(countView(p, '2026-12-10', [p])).toMatchObject({ kindLabel: 'Comptage initial', stageLabel: 'Provisoire', reviewOpen: true, frozen: false });
    expect(countView(p, '2026-12-10', [p, f])).toMatchObject({ reviewOpen: false, frozen: true });
    expect(countView(f, '2026-12-16', [p, f])).toMatchObject({ stageLabel: 'Définitif', frozen: true });
  });

  it('les plus récents d’abord, le figé avant le provisoire de la même date', () => {
    const rows = [
      rec({ id: '1' }), rec({ id: '2', stage: 'FROZEN' }), rec({ id: '3', kind: 'TRIAL_END', referenceDate: '2026-11-14', stage: 'FROZEN' }),
      rec({ id: '4', kind: 'FIRST_REGULARIZATION', referenceDate: '2027-03-31' }),
    ];
    expect(sortCounts(rows).map((r) => r.id)).toEqual(['4', '2', '1', '3']);
  });
});

describe('Ajustements G5b-2 : élève parti sans date connue, « À vérifier »', () => {
  const since = new Date('2026-09-14T08:00:00Z');
  const row = (id: string): ItemRow => ({ enrollmentId: id, studentId: `s-${id}`, classId: 'c1', siteId: null, state: 'UNKNOWN', unknown: { since, before: null } });
  const none = { direction: new Map<string, string>(), audit: new Map<string, string>() };

  it('sans date connue : compté et « À vérifier », jamais retiré par un silence', () => {
    const [a] = resolveItems('2026-11-30', [row('a')], none, new Set());
    expect(a).toMatchObject({ counted: true, basis: 'DEPARTURE_UNKNOWN', departureDate: null });
    expect(isToCheck(a)).toBe(true);
    expect(BASIS_LABELS.DEPARTURE_UNKNOWN.startsWith('À vérifier')).toBe(true);
    expect(BASIS_LABELS.DEPARTURE_AUDIT.startsWith('À vérifier')).toBe(true);
    expect(TO_CHECK_BASES).toEqual(['DEPARTURE_AUDIT', 'DEPARTURE_UNKNOWN']);
  });

  it('date confirmée introuvable par la direction : toujours compté, plus « À vérifier »', () => {
    const [a] = resolveItems('2026-11-30', [row('a')], { ...none, confirmed: new Set(['a']) }, new Set());
    expect(a).toMatchObject({ counted: true, basis: 'DEPARTURE_CONFIRMED', departureDate: null });
    expect(isToCheck(a)).toBe(false);
  });

  it('date fixée par la direction : elle l’emporte sur une confirmation antérieure', () => {
    const before = resolveItems('2026-11-30', [row('a')], { ...none, direction: new Map([['a', '2026-10-15']]), confirmed: new Set(['a']) }, new Set());
    expect(before).toEqual([]);
    const [after] = resolveItems('2026-11-30', [row('a')], { ...none, direction: new Map([['a', '2026-12-10']]), confirmed: new Set(['a']) }, new Set());
    expect(after).toMatchObject({ counted: true, basis: 'DEPARTURE_DIRECTION', departureDate: '2026-12-10' });
    expect(isToCheck(after)).toBe(false);
  });

  it('date du journal après le jour R : compté et « À vérifier » ; confirmée introuvable, compté sans l’être', () => {
    const audit = new Map([['a', '2026-12-05']]);
    const [a] = resolveItems('2026-11-30', [row('a')], { ...none, audit }, new Set());
    expect(a).toMatchObject({ counted: true, basis: 'DEPARTURE_AUDIT', departureDate: '2026-12-05' });
    expect(isToCheck(a)).toBe(true);
    const [b] = resolveItems('2026-11-30', [row('a')], { ...none, audit, confirmed: new Set(['a']) }, new Set());
    expect(b).toMatchObject({ counted: true, basis: 'DEPARTURE_CONFIRMED', departureDate: '2026-12-05' });
    // Date du journal le jour R ou avant : l'élève était déjà parti, confirmé ou non.
    expect(resolveItems('2026-12-05', [row('a')], { ...none, audit, confirmed: new Set(['a']) }, new Set())).toEqual([]);
  });

  it('une inscription exclue n’est jamais « À vérifier »', () => {
    const [a] = resolveItems('2026-11-30', [row('a')], none, new Set(['a']));
    expect(a).toMatchObject({ counted: false, basis: 'EXCLUDED' });
    expect(isToCheck(a)).toBe(false);
  });
});

describe('Lecture 3 (24 novembre 2026, soir) : élève revenu après une exclusion ou une contestation acceptée', () => {
  const at = (d: string) => new Date(`${d}T23:59:59.999Z`);
  const count = (d: string) => ({ referenceDate: d, at: at(d) });
  const request = (o: Partial<VoidingRequest> = {}): VoidingRequest => ({
    id: 'k1', status: 'VALIDATED', departureDate: null, requestedAt: new Date('2026-12-10T09:00:00Z'), decidedAt: new Date('2026-12-12T10:00:00Z'), ...o,
  });

  it('exclusion validée : toutes les lignes de l’élève sont annulées tant qu’il n’est pas revenu', () => {
    expect(requestVoids(request(), [], count('2026-11-30'))).toBe(true);
    expect(requestVoids(request(), [], count('2027-03-31'))).toBe(true);
  });

  it('contestation acceptée : annule le comptage du départ et les suivants, jamais un comptage d’avant le départ', () => {
    const k = request({ departureDate: '2027-02-10' });
    expect(requestVoids(k, [], count('2026-11-30'))).toBe(false);
    expect(requestVoids(k, [], count('2027-03-31'))).toBe(true);
    expect(requestVoids(k, [], count('2027-02-10'))).toBe(true);
  });

  it('retour après la demande : les comptages faits depuis le comptent de nouveau, les précédents restent annulés', () => {
    const back = [new Date('2027-01-20T08:00:00Z')];
    expect(requestVoids(request(), back, count('2026-11-30'))).toBe(true);
    expect(requestVoids(request(), back, count('2027-03-31'))).toBe(false);
  });

  it('un retour d’avant la demande ne compte pas : seul un retour après la demande rend l’élève facturable', () => {
    const before = [new Date('2026-12-01T08:00:00Z')];
    expect(requestVoids(request(), before, count('2027-03-31'))).toBe(true);
  });

  it('demande choisie : validée seulement, décidée à l’instant donné, autre que celle écartée', () => {
    const refused = request({ id: 'k0', status: 'REFUSED' });
    const pending = request({ id: 'k2', status: 'PENDING', decidedAt: null });
    const k = request();
    expect(voidingRequest([refused, pending], [], count('2027-03-31'))).toBeNull();
    expect(voidingRequest([refused, k], [], count('2027-03-31'))).toBe(k);
    expect(voidingRequest([k], [], count('2027-03-31'), { until: new Date('2026-12-11T00:00:00Z') })).toBeNull();
    expect(voidingRequest([k], [], count('2027-03-31'), { until: new Date('2026-12-13T00:00:00Z') })).toBe(k);
    expect(voidingRequest([k], [], count('2027-03-31'), { except: 'k1' })).toBeNull();
  });

  it('nouvelle demande après le retour : une exclusion annule de nouveau toute l’inscription, une contestation à partir du départ', () => {
    const first = request();
    const back = [new Date('2027-01-20T08:00:00Z')];
    const again = { requestedAt: new Date('2027-05-15T09:00:00Z'), decidedAt: new Date('2027-05-16T09:00:00Z') };
    expect(voidingRequest([first], back, count('2027-03-31'))).toBeNull();
    // Exclusion : l'inscription rétablie était elle-même une erreur, le comptage du 31 mars l'a compté à tort.
    const exclusion = request({ id: 'k3', ...again });
    expect(voidingRequest([first, exclusion], back, count('2027-03-31'))).toBe(exclusion);
    // Contestation : parti le 2 mai, il reste compté le 31 mars (lecture 2), plus le 30 juin.
    const contest = request({ id: 'k4', departureDate: '2027-05-02', ...again });
    expect(voidingRequest([first, contest], back, count('2027-03-31'))).toBeNull();
    expect(voidingRequest([first, contest], back, count('2027-06-30'))).toBe(contest);
  });
});
