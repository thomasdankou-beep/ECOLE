import { endErrors, lastDayOf, rateErrors, RateKind, rateText, serviceCode, servicePrice, ServiceRate, serviceVersionOn, versionErrors } from './services-rules';

/** Règles des prestations complémentaires (lot G5g), sans base : données entièrement fictives. */

let n = 0;
const at = (minutes: number) => new Date(Date.UTC(2026, 10, 14, 8, minutes));
function rate(kind: RateKind, value: number | null, from: string, extra: Partial<ServiceRate> = {}): ServiceRate {
  n += 1;
  const money = kind === 'PRICE' || kind === 'SPECIAL_PRICE' || kind === 'DISCOUNT_AMOUNT';
  return { id: `r${String(n).padStart(3, '0')}`, kind, tenantId: null, currency: money ? 'XOF' : null, value, effectiveFrom: from, effectiveTo: null, createdAt: at(n), ...extra };
}
const FIXED = { pricing: 'FIXED' as const, active: true };
const A = 'ecole-a';
const B = 'ecole-b';

describe('Prestations G5g : prix pour un établissement un jour donné (§7)', () => {
  const catalog = rate('PRICE', 15000, '2026-11-14');

  it('prix du catalogue, puis le nouveau prix à sa date d’effet seulement (test 16 : la formation à 15 000 FCFA)', () => {
    const later = rate('PRICE', 18000, '2027-01-01');
    expect(servicePrice(FIXED, [catalog, later], A, 'XOF', '2026-12-31')).toMatchObject({ amount: 15000, basis: 'CATALOG' });
    expect(servicePrice(FIXED, [catalog, later], A, 'XOF', '2027-01-01')).toMatchObject({ amount: 18000, basis: 'CATALOG' });
    expect(servicePrice(FIXED, [catalog, later], A, 'XOF', '2026-11-13')).toMatchObject({ amount: null, basis: 'MISSING' });
  });

  it('gratuite au catalogue, sur devis, désactivée, pas encore au catalogue, monnaie sans prix', () => {
    expect(servicePrice({ pricing: 'FREE', active: true }, [], A, 'XOF', '2026-11-20')).toMatchObject({ amount: 0, basis: 'FREE_SERVICE' });
    expect(servicePrice({ pricing: 'QUOTE', active: true }, [], A, 'XOF', '2026-11-20')).toMatchObject({ amount: null, basis: 'QUOTE', label: 'Sur devis' });
    expect(servicePrice({ pricing: 'FIXED', active: false }, [catalog], A, 'XOF', '2026-11-20')).toMatchObject({ amount: null, basis: 'INACTIVE' });
    expect(servicePrice(null, [catalog], A, 'XOF', '2026-11-20')).toMatchObject({ amount: null, basis: 'NOT_IN_CATALOG' });
    expect(servicePrice(FIXED, [catalog], A, 'XAF', '2026-11-20')).toMatchObject({ amount: null, basis: 'MISSING', label: 'INFORMATION MANQUANTE : aucun prix du catalogue en XAF' });
  });

  it('une seule règle, jamais de cumul : gratuité, puis tarif particulier, puis remise de l’établissement, puis remise pour tous', () => {
    const all10 = rate('DISCOUNT_PERCENT', 1000, '2026-11-14');
    const a5000 = rate('DISCOUNT_AMOUNT', 5000, '2026-11-14', { tenantId: A });
    const bSpecial = rate('SPECIAL_PRICE', 12000, '2026-11-14', { tenantId: B });
    const rates = [catalog, all10, a5000, bSpecial];
    expect(servicePrice(FIXED, rates, 'ecole-c', 'XOF', '2026-11-20')).toMatchObject({ amount: 13500, catalogAmount: 15000, basis: 'DISCOUNT', label: 'Remise pour tous les établissements' });
    expect(servicePrice(FIXED, rates, A, 'XOF', '2026-11-20')).toMatchObject({ amount: 10000, basis: 'DISCOUNT', label: 'Remise pour cet établissement' });
    // Le tarif particulier ne reçoit aucune remise en plus.
    expect(servicePrice(FIXED, rates, B, 'XOF', '2026-11-20')).toMatchObject({ amount: 12000, basis: 'SPECIAL_PRICE' });
    // La gratuité l'emporte sur tout : celle de l'établissement, sinon celle de tous.
    expect(servicePrice(FIXED, [...rates, rate('FREE', null, '2026-11-20', { tenantId: B })], B, 'XOF', '2026-11-20')).toMatchObject({ amount: 0, basis: 'FREE', label: 'Gratuité pour cet établissement' });
    expect(servicePrice(FIXED, [...rates, rate('FREE', null, '2026-12-01')], A, 'XOF', '2026-12-01')).toMatchObject({ amount: 0, basis: 'FREE', label: 'Gratuité pour tous les établissements' });
    expect(servicePrice(FIXED, [...rates, rate('FREE', null, '2026-12-01')], A, 'XOF', '2026-11-30')).toMatchObject({ amount: 10000 });
  });

  it('remise en pourcentage arrondie à l’unité ; un prix ne devient jamais négatif ; une remise en montant d’une autre monnaie ne compte pas', () => {
    expect(servicePrice(FIXED, [rate('PRICE', 999, '2026-11-14'), rate('DISCOUNT_PERCENT', 1250, '2026-11-14')], A, 'XOF', '2026-11-20').amount).toBe(874); // 874,125
    expect(servicePrice(FIXED, [rate('PRICE', 1001, '2026-11-14'), rate('DISCOUNT_PERCENT', 50, '2026-11-14')], A, 'XOF', '2026-11-20').amount).toBe(996); // 995,995
    expect(servicePrice(FIXED, [catalog, rate('DISCOUNT_AMOUNT', 20000, '2026-11-14')], A, 'XOF', '2026-11-20').amount).toBe(0);
    expect(servicePrice(FIXED, [catalog, rate('DISCOUNT_PERCENT', 10000, '2026-11-14')], A, 'XOF', '2026-11-20').amount).toBe(0);
    expect(servicePrice(FIXED, [catalog, rate('DISCOUNT_AMOUNT', 1000, '2026-11-14', { currency: 'XAF' })], A, 'XOF', '2026-11-20')).toMatchObject({ amount: 15000, basis: 'CATALOG' });
  });

  it('entre deux règles du même genre, celle qui a commencé le plus récemment ; à date égale, la dernière inscrite', () => {
    const general = rate('DISCOUNT_PERCENT', 1000, '2026-11-20'); // inscrite d'abord
    const june = rate('DISCOUNT_PERCENT', 2000, '2027-06-01', { effectiveTo: '2027-06-30' });
    const laterGeneral = rate('DISCOUNT_PERCENT', 500, '2026-11-20'); // même date, inscrite après
    const rates = [catalog, general, june, laterGeneral];
    expect(servicePrice(FIXED, rates, A, 'XOF', '2026-12-01').rule?.id).toBe(laterGeneral.id);
    expect(servicePrice(FIXED, rates, A, 'XOF', '2027-06-15')).toMatchObject({ amount: 12000, rule: june });
    expect(servicePrice(FIXED, rates, A, 'XOF', '2027-07-01').rule?.id).toBe(laterGeneral.id);
  });

  it('une règle arrêtée ne s’applique plus après son dernier jour ; une règle annulée ne s’applique jamais', () => {
    expect(lastDayOf(null, '2026-12-31')).toBe('2026-12-31');
    expect(lastDayOf('2027-03-31', '2026-12-31')).toBe('2026-12-31');
    expect(lastDayOf('2027-03-31', null)).toBe('2027-03-31');
    const stopped = rate('DISCOUNT_PERCENT', 1000, '2026-11-14', { tenantId: A, effectiveTo: lastDayOf(null, '2026-11-30') });
    expect(servicePrice(FIXED, [catalog, stopped], A, 'XOF', '2026-11-30').amount).toBe(13500);
    expect(servicePrice(FIXED, [catalog, stopped], A, 'XOF', '2026-12-01').amount).toBe(15000);
    const cancelled = rate('FREE', null, '2026-12-01', { tenantId: A, effectiveTo: '2026-11-30' });
    for (const d of ['2026-11-30', '2026-12-01', '2027-06-01']) expect(servicePrice(FIXED, [catalog, cancelled], A, 'XOF', d).basis).toBe('CATALOG');
  });

  it('sur devis : un tarif particulier ou une gratuité de l’établissement donne un prix ; sinon pas de montant', () => {
    const QUOTE = { pricing: 'QUOTE' as const, active: true };
    expect(servicePrice(QUOTE, [rate('SPECIAL_PRICE', 30000, '2026-11-14', { tenantId: A })], A, 'XOF', '2026-11-20')).toMatchObject({ amount: 30000, basis: 'SPECIAL_PRICE' });
    expect(servicePrice(QUOTE, [rate('FREE', null, '2026-11-14', { tenantId: A })], A, 'XOF', '2026-11-20')).toMatchObject({ amount: 0, basis: 'FREE' });
    expect(servicePrice(QUOTE, [rate('SPECIAL_PRICE', 30000, '2026-11-14', { tenantId: A })], B, 'XOF', '2026-11-20')).toMatchObject({ amount: null, basis: 'QUOTE' });
  });
});

describe('Prestations G5g : versions datées du catalogue (§15)', () => {
  const v = (version: number, effectiveFrom: string, active = true) => ({ version, effectiveFrom, active });

  it('la version d’un jour est celle de date d’effet la plus récente jusqu’à ce jour ; à date égale, la dernière inscrite', () => {
    const versions = [v(1, '2026-11-14'), v(2, '2027-01-01', false), v(3, '2026-11-14')];
    expect(serviceVersionOn(versions, '2026-11-13')).toBeNull();
    expect(serviceVersionOn(versions, '2026-12-31')?.version).toBe(3);
    expect(serviceVersionOn(versions, '2027-01-01')?.version).toBe(2);
  });

  it('nom, description, mode de prix et date d’effet contrôlés ; jamais rétroactif ; une version identique est refusée', () => {
    const ok = { name: 'Formation des enseignants', description: null, pricing: 'FIXED' as const, active: true, effectiveFrom: '2026-11-14' };
    expect(versionErrors(ok, '2026-11-14', null)).toEqual([]);
    expect(versionErrors({ ...ok, name: ' x ' }, '2026-11-14', null)).toEqual(['Nom : de 3 à 120 caractères']);
    expect(versionErrors({ ...ok, description: 'd'.repeat(2001) }, '2026-11-14', null)).toEqual(['Description : 2 000 caractères au plus']);
    expect(versionErrors({ ...ok, effectiveFrom: '2026-11-13' }, '2026-11-14', null)).toEqual(['La date d’effet ne peut pas être passée : un changement ne s’applique jamais avant sa saisie']);
    expect(versionErrors({ ...ok, pricing: 'GRATUIT' as never }, '2026-11-14', null)).toEqual(['Mode de prix : prix fixe, gratuite ou sur devis']);
    expect(versionErrors({ ...ok, active: false }, '2026-11-14', null)).toEqual(['Une nouvelle prestation commence active']);
    expect(versionErrors(ok, '2026-11-14', ok)).toEqual(['Rien n’a changé par rapport à la dernière version']);
    expect(versionErrors({ ...ok, active: false }, '2026-11-14', ok)).toEqual([]);
    expect(versionErrors({ ...ok, description: 'Deux demi-journées' }, '2026-11-14', ok)).toEqual([]);
  });
});

describe('Prestations G5g : saisie et arrêt des règles', () => {
  const r = { kind: 'DISCOUNT_PERCENT' as RateKind, tenantId: null, currency: null, value: 1000, effectiveFrom: '2026-11-14', effectiveTo: null };

  it('contrôles d’une nouvelle règle, jamais rétroactive', () => {
    expect(rateErrors('FIXED', r, '2026-11-14', ['XOF'])).toEqual([]);
    expect(rateErrors('FIXED', { ...r, effectiveFrom: '2026-11-13' }, '2026-11-14', ['XOF'])).toEqual(['La date d’effet ne peut pas être passée : un changement ne s’applique jamais avant sa saisie']);
    expect(rateErrors('FIXED', { ...r, value: 0 }, '2026-11-14', ['XOF'])).toEqual(['Remise : entre 0,01 % et 100 %']);
    expect(rateErrors('FIXED', { ...r, value: 10001 }, '2026-11-14', ['XOF'])).toEqual(['Remise : entre 0,01 % et 100 %']);
    expect(rateErrors('FIXED', { ...r, effectiveTo: '2026-11-13' }, '2026-11-14', ['XOF'])).toEqual(['Le dernier jour suit la date d’effet']);
    expect(rateErrors('FIXED', { ...r, kind: 'PRICE', currency: 'XOF', value: 20000, tenantId: 'ecole-a' }, '2026-11-14', ['XOF'])).toEqual(['Le prix du catalogue vaut pour tous les établissements : pour un seul, choisissez un tarif particulier']);
    expect(rateErrors('FIXED', { ...r, kind: 'PRICE', currency: 'XOF', value: 20000, effectiveTo: '2027-01-01' }, '2026-11-14', ['XOF'])).toEqual(['Un prix du catalogue n’a pas de dernier jour : un nouveau prix le remplace']);
    expect(rateErrors('FIXED', { ...r, kind: 'SPECIAL_PRICE', currency: 'XOF', value: 12000 }, '2026-11-14', ['XOF'])).toEqual(['Un tarif particulier vise un établissement']);
    expect(rateErrors('FIXED', { ...r, kind: 'SPECIAL_PRICE', tenantId: 'ecole-a', currency: 'XAF', value: 12000 }, '2026-11-14', ['XOF'])).toEqual(['Monnaie : celle de l’établissement']);
    expect(rateErrors('FIXED', { ...r, kind: 'DISCOUNT_AMOUNT', currency: 'XOF', value: 0 }, '2026-11-14', ['XOF'])).toEqual(['Remise : montant entier, au moins 1']);
    expect(rateErrors('FIXED', { ...r, kind: 'FREE', value: 5 }, '2026-11-14', ['XOF'])).toEqual(['Une gratuité n’a pas de montant']);
    expect(rateErrors('FREE', r, '2026-11-14', ['XOF'])).toEqual(['Prestation gratuite au catalogue : ni prix, ni remise, ni tarif particulier, ni gratuité à ajouter']);
    expect(rateErrors('QUOTE', r, '2026-11-14', ['XOF'])).toHaveLength(1);
    expect(rateErrors('QUOTE', { ...r, kind: 'FREE', value: null, tenantId: 'ecole-a' }, '2026-11-14', ['XOF'])).toEqual([]);
  });

  it('arrêt : jamais dans le passé, une seule fois, seulement pour raccourcir ; annulation la veille du début ; jamais un prix du catalogue', () => {
    const live = { kind: 'DISCOUNT_PERCENT' as RateKind, effectiveFrom: '2026-11-01', plannedTo: null, stopped: false };
    expect(endErrors(live, '2026-11-14', '2026-11-14')).toEqual([]);
    expect(endErrors(live, '2026-11-13', '2026-11-14')).toEqual(['Le dernier jour est au plus tôt aujourd’hui : une règle ne s’arrête jamais dans le passé']);
    expect(endErrors({ ...live, stopped: true }, '2026-11-20', '2026-11-14')).toEqual(['Cette règle est déjà arrêtée']);
    expect(endErrors({ ...live, plannedTo: '2026-11-30' }, '2026-11-30', '2026-11-14')).toEqual(['Une règle se raccourcit seulement : pour la prolonger, créez-en une nouvelle']);
    expect(endErrors({ ...live, plannedTo: '2026-11-10' }, '2026-11-14', '2026-11-14')).toEqual(['Cette règle est déjà terminée']);
    expect(endErrors({ ...live, kind: 'PRICE' }, '2026-11-20', '2026-11-14')).toEqual(['Un prix du catalogue ne s’arrête pas : un nouveau prix le remplace']);
    const future = { ...live, effectiveFrom: '2026-12-01' };
    expect(endErrors(future, '2026-11-30', '2026-11-14')).toEqual([]);
    expect(endErrors(future, '2026-11-20', '2026-11-14')).toEqual(['Le dernier jour suit la date d’effet (ou la veille, pour annuler une règle qui n’a pas commencé)']);
    expect(endErrors(future, '2026-12-15', '2026-11-14')).toEqual([]);
  });

  it('codes stables et textes des règles', () => {
    expect(serviceCode('Formation et prise en main')).toBe('FORMATION_ET_PRISE_EN_MAIN');
    expect(serviceCode('  Paramétrage complet !')).toBe('PARAMETRAGE_COMPLET');
    expect(serviceCode('Intervention sur site (journée)')).toBe('INTERVENTION_SUR_SITE_JOURNEE');
    expect(serviceCode('€€€')).toBe('PRESTATION');
    expect(serviceCode('a'.repeat(80))).toHaveLength(48);
    expect(rateText({ kind: 'DISCOUNT_PERCENT', currency: null, value: 1250 })).toBe('Remise en pourcentage de 12,5 %');
    expect(rateText({ kind: 'DISCOUNT_AMOUNT', currency: 'XOF', value: 5000 })).toBe('Remise en montant de 5 000 FCFA');
    expect(rateText({ kind: 'SPECIAL_PRICE', currency: 'XOF', value: 12000 })).toBe('Tarif particulier : 12 000 FCFA');
    expect(rateText({ kind: 'FREE', currency: null, value: null })).toBe('Gratuité');
  });
});
