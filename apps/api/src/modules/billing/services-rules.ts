/**
 * Prestations complémentaires de Cahiora (lot G5g), sans accès à la base : versions datées du catalogue, prix du
 * catalogue datés, remises, tarifs particuliers et gratuités, et le prix qui s'applique à un établissement un jour donné.
 * Cahier des charges du lot G5 du 14 novembre 2026, sections 7 et 15. Les prestations ne sont jamais ajoutées d'office :
 * elles n'entrent dans un devis ou une facture que si quelqu'un les y ajoute (lot G5c).
 * Les dates sont des jours du calendrier (AAAA-MM-JJ). Les montants sont des entiers dans la monnaie de
 * l'établissement ; les pourcentages sont en centièmes (1500 = 15 %).
 */

import { currencyLabel } from '../../common/country';
import { addDays, isDay } from './billing-rules';

export type ServicePricing = 'FIXED' | 'FREE' | 'QUOTE';
export type RateKind = 'PRICE' | 'SPECIAL_PRICE' | 'DISCOUNT_PERCENT' | 'DISCOUNT_AMOUNT' | 'FREE';

export const PRICINGS: ServicePricing[] = ['FIXED', 'FREE', 'QUOTE'];
export const RATE_KINDS: RateKind[] = ['PRICE', 'SPECIAL_PRICE', 'DISCOUNT_PERCENT', 'DISCOUNT_AMOUNT', 'FREE'];

export const PRICING_LABELS: Record<ServicePricing, string> = {
  FIXED: 'Prix fixe',
  FREE: 'Gratuite',
  QUOTE: 'Sur devis',
};

export const RATE_LABELS: Record<RateKind, string> = {
  PRICE: 'Prix du catalogue',
  SPECIAL_PRICE: 'Tarif particulier',
  DISCOUNT_PERCENT: 'Remise en pourcentage',
  DISCOUNT_AMOUNT: 'Remise en montant',
  FREE: 'Gratuité',
};

/** Montant et monnaie : « 15 000 FCFA ». */
export function moneyText(n: number, currency: string) {
  return `${new Intl.NumberFormat('fr-FR').format(n).replace(/[  ]/g, ' ')} ${currencyLabel(currency)}`;
}

/** Pourcentage en centièmes : 1250 → « 12,5 % ». */
export function percentText(v: number) {
  return `${(v / 100).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} %`;
}

/** Ce que dit une règle, en clair : « Remise en pourcentage de 10 % ». */
export function rateText(r: { kind: RateKind; currency: string | null; value: number | null }) {
  if (r.kind === 'FREE' || r.value === null) return RATE_LABELS[r.kind];
  if (r.kind === 'DISCOUNT_PERCENT') return `${RATE_LABELS[r.kind]} de ${percentText(r.value)}`;
  const amount = moneyText(r.value, r.currency ?? '');
  return r.kind === 'DISCOUNT_AMOUNT' ? `${RATE_LABELS[r.kind]} de ${amount}` : `${RATE_LABELS[r.kind]} : ${amount}`;
}

// ---------------------------------------------------------------- Versions du catalogue

export interface ServiceVersion {
  id: string;
  version: number;
  name: string;
  description: string | null;
  pricing: ServicePricing;
  active: boolean;
  effectiveFrom: string;
  createdAt: Date;
}

/** Version en vigueur un jour donné : la date d'effet la plus récente jusqu'à ce jour, puis la dernière inscrite. */
export function serviceVersionOn<T extends Pick<ServiceVersion, 'version' | 'effectiveFrom'>>(versions: T[], day: string): T | null {
  return versions.filter((v) => v.effectiveFrom <= day).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.version - b.version).at(-1) ?? null;
}

// ---------------------------------------------------------------- Règles de prix

export interface ServiceRate {
  id: string;
  kind: RateKind;
  /** null : tous les établissements. */
  tenantId: string | null;
  currency: string | null;
  value: number | null;
  effectiveFrom: string;
  /** Dernier jour d'application, arrêt compris, ou null : sans fin. */
  effectiveTo: string | null;
  createdAt: Date;
}

/** Une règle s'applique-t-elle ce jour-là ? */
export const rateOn = (r: Pick<ServiceRate, 'effectiveFrom' | 'effectiveTo'>, day: string) => r.effectiveFrom <= day && (r.effectiveTo === null || day <= r.effectiveTo);

/** Dernier jour réel d'une règle : le plus tôt de son dernier jour prévu et de son arrêt. */
export function lastDayOf(plannedTo: string | null, stoppedAt: string | null) {
  if (stoppedAt === null) return plannedTo;
  return plannedTo === null || stoppedAt < plannedTo ? stoppedAt : plannedTo;
}

/** Entre deux règles du même genre, celle qui a commencé le plus récemment ; à date égale, la dernière inscrite. */
function latest<T extends ServiceRate>(list: T[]): T | null {
  return [...list].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)).at(-1) ?? null;
}

export type PriceBasis = 'NOT_IN_CATALOG' | 'INACTIVE' | 'FREE_SERVICE' | 'FREE' | 'SPECIAL_PRICE' | 'QUOTE' | 'MISSING' | 'DISCOUNT' | 'CATALOG';

export type PriceResult = {
  /** Montant dû pour la prestation ; null quand il n'existe pas (sur devis, prix manquant, prestation non proposée). */
  amount: number | null;
  /** Prix du catalogue avant remise, quand il existe. */
  catalogAmount: number | null;
  currency: string;
  basis: PriceBasis;
  /** Règle retenue (gratuité, tarif particulier ou remise), pour l'afficher et, plus tard, la garder sur un document. */
  rule: ServiceRate | null;
  label: string;
};

/**
 * Prix d'une prestation pour un établissement, un jour donné. Une seule règle s'applique, jamais de cumul :
 * 0. pas encore au catalogue ou désactivée ce jour-là : aucun prix (elle n'est pas proposée) ;
 * 1. prestation gratuite au catalogue : 0 ;
 * 2. gratuité de l'établissement, sinon gratuité pour tous : 0 ;
 * 3. tarif particulier de l'établissement, dans sa monnaie : ce montant, sans autre remise ;
 * 4. prestation sur devis : pas de montant (il se saisira sur le devis) ;
 * 5. prix du catalogue dans la monnaie de l'établissement, moins la remise de l'établissement, sinon la remise pour
 *    tous ; une remise en pourcentage est arrondie à l'unité la plus proche ; un prix ne devient jamais négatif.
 * Entre deux règles du même genre et de même portée, celle qui a commencé le plus récemment l'emporte.
 */
export function servicePrice(version: Pick<ServiceVersion, 'pricing' | 'active'> | null, rates: ServiceRate[], tenantId: string, currency: string, day: string): PriceResult {
  const none = { currency, catalogAmount: null, amount: null, rule: null };
  if (!version) return { ...none, basis: 'NOT_IN_CATALOG', label: 'Pas encore au catalogue ce jour-là' };
  if (!version.active) return { ...none, basis: 'INACTIVE', label: 'Prestation désactivée ce jour-là : elle n’est pas proposée' };
  if (version.pricing === 'FREE') return { ...none, amount: 0, basis: 'FREE_SERVICE', label: 'Prestation gratuite' };

  const live = rates.filter((r) => rateOn(r, day));
  const own = (k: RateKind) => live.filter((r) => r.kind === k && r.tenantId === tenantId);
  const all = (k: RateKind) => live.filter((r) => r.kind === k && r.tenantId === null);
  const sameMoney = (r: ServiceRate) => r.currency === currency;

  const free = latest(own('FREE')) ?? latest(all('FREE'));
  if (free) return { ...none, amount: 0, basis: 'FREE', rule: free, label: free.tenantId ? 'Gratuité pour cet établissement' : 'Gratuité pour tous les établissements' };

  const special = latest(own('SPECIAL_PRICE').filter(sameMoney));
  if (special) return { ...none, amount: special.value, basis: 'SPECIAL_PRICE', rule: special, label: 'Tarif particulier de cet établissement' };

  if (version.pricing === 'QUOTE') return { ...none, basis: 'QUOTE', label: 'Sur devis' };

  const price = latest(all('PRICE').filter(sameMoney));
  if (!price || price.value === null) return { ...none, basis: 'MISSING', label: `INFORMATION MANQUANTE : aucun prix du catalogue en ${currency}` };
  const catalogAmount = price.value;

  const discounts = (scope: (k: RateKind) => ServiceRate[]) => [...scope('DISCOUNT_PERCENT'), ...scope('DISCOUNT_AMOUNT').filter(sameMoney)];
  const discount = latest(discounts(own)) ?? latest(discounts(all));
  if (!discount || discount.value === null) return { ...none, catalogAmount, amount: catalogAmount, basis: 'CATALOG', label: 'Prix du catalogue' };
  const amount = discount.kind === 'DISCOUNT_PERCENT'
    ? Math.max(0, Math.round((catalogAmount * (10_000 - discount.value)) / 10_000))
    : Math.max(0, catalogAmount - discount.value);
  return { ...none, catalogAmount, amount, basis: 'DISCOUNT', rule: discount, label: discount.tenantId ? 'Remise pour cet établissement' : 'Remise pour tous les établissements' };
}

// ---------------------------------------------------------------- Saisie

/** Erreurs du nom et de la description d'une prestation (messages pour l'écran). */
export function serviceTextErrors(name: unknown, description: unknown): string[] {
  const errors: string[] = [];
  if (typeof name !== 'string' || name.trim().length < 3 || name.trim().length > 120) errors.push('Nom : de 3 à 120 caractères');
  if (description !== null && description !== undefined && (typeof description !== 'string' || description.length > 2000)) errors.push('Description : 2 000 caractères au plus');
  return errors;
}

export interface VersionInput {
  name: string;
  description: string | null;
  pricing: ServicePricing;
  active: boolean;
  effectiveFrom: string;
}

/**
 * Erreurs d'une nouvelle version (création ou changement) : nom, description, mode de prix, date d'effet jamais passée.
 * `last` est la dernière version inscrite : une version identique à elle est refusée (rien à changer).
 */
export function versionErrors(v: VersionInput, today: string, last: Omit<VersionInput, 'effectiveFrom'> | null): string[] {
  const errors = serviceTextErrors(v.name, v.description);
  if (!PRICINGS.includes(v.pricing)) errors.push('Mode de prix : prix fixe, gratuite ou sur devis');
  if (!isDay(v.effectiveFrom)) errors.push('Date d’effet invalide');
  else if (v.effectiveFrom < today) errors.push('La date d’effet ne peut pas être passée : un changement ne s’applique jamais avant sa saisie');
  if (!last && !v.active) errors.push('Une nouvelle prestation commence active');
  if (last && errors.length === 0) {
    const same = last.name === v.name.trim() && (last.description ?? null) === (v.description?.trim() || null) && last.pricing === v.pricing && last.active === v.active;
    if (same) errors.push('Rien n’a changé par rapport à la dernière version');
  }
  return errors;
}

export interface RateInput {
  kind: RateKind;
  tenantId: string | null;
  /** Monnaie de l'établissement visé, ou monnaie choisie pour une règle de tous les établissements. */
  currency: string | null;
  value: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
}

/**
 * Erreurs d'une nouvelle règle (messages pour l'écran). Jamais rétroactive : elle commence au plus tôt aujourd'hui.
 * Un prix du catalogue vaut pour tous les établissements et n'a pas de fin : un nouveau prix le remplace.
 * `currencies` : les monnaies permises (celle de l'établissement visé, ou celles des établissements clients).
 */
export function rateErrors(pricing: ServicePricing, r: RateInput, today: string, currencies: string[]): string[] {
  const errors: string[] = [];
  if (!RATE_KINDS.includes(r.kind)) return ['Genre de règle inconnu'];
  const money = r.kind === 'PRICE' || r.kind === 'SPECIAL_PRICE' || r.kind === 'DISCOUNT_AMOUNT';
  if (pricing === 'FREE') errors.push('Prestation gratuite au catalogue : ni prix, ni remise, ni tarif particulier, ni gratuité à ajouter');
  else if (pricing === 'QUOTE' && (r.kind === 'PRICE' || r.kind === 'DISCOUNT_PERCENT' || r.kind === 'DISCOUNT_AMOUNT')) {
    errors.push('Prestation sur devis : pas de prix du catalogue ni de remise ; un tarif particulier ou une gratuité reste possible pour un établissement');
  }
  if (r.kind === 'PRICE' && r.tenantId) errors.push('Le prix du catalogue vaut pour tous les établissements : pour un seul, choisissez un tarif particulier');
  if (r.kind === 'SPECIAL_PRICE' && !r.tenantId) errors.push('Un tarif particulier vise un établissement');
  if (money) {
    if (!r.currency || !currencies.includes(r.currency)) errors.push(r.tenantId ? 'Monnaie : celle de l’établissement' : 'Monnaie : choisissez une monnaie prise en charge');
    const min = r.kind === 'DISCOUNT_AMOUNT' ? 1 : 0;
    if (!Number.isInteger(r.value) || (r.value as number) < min || (r.value as number) > 100_000_000) {
      errors.push(r.kind === 'DISCOUNT_AMOUNT' ? 'Remise : montant entier, au moins 1' : 'Montant : nombre entier, 0 ou plus');
    }
  } else if (r.kind === 'DISCOUNT_PERCENT') {
    if (r.currency !== null) errors.push('Une remise en pourcentage n’a pas de monnaie');
    if (!Number.isInteger(r.value) || (r.value as number) < 1 || (r.value as number) > 10_000) errors.push('Remise : entre 0,01 % et 100 %');
  } else {
    if (r.value !== null) errors.push('Une gratuité n’a pas de montant');
    if (r.currency !== null) errors.push('Une gratuité n’a pas de monnaie');
  }
  if (!isDay(r.effectiveFrom)) errors.push('Date d’effet invalide');
  else if (r.effectiveFrom < today) errors.push('La date d’effet ne peut pas être passée : un changement ne s’applique jamais avant sa saisie');
  if (r.effectiveTo !== null) {
    if (r.kind === 'PRICE') errors.push('Un prix du catalogue n’a pas de dernier jour : un nouveau prix le remplace');
    else if (!isDay(r.effectiveTo)) errors.push('Dernier jour invalide');
    else if (isDay(r.effectiveFrom) && r.effectiveTo < r.effectiveFrom) errors.push('Le dernier jour suit la date d’effet');
  }
  return errors;
}

/**
 * Arrêt d'une règle (remise, tarif particulier, gratuité) : elle s'applique encore jusqu'au dernier jour choisi, au
 * plus tôt aujourd'hui. Une règle qui n'a pas commencé peut être annulée : dernier jour = veille de sa date d'effet.
 * Une règle se raccourcit, ne s'allonge pas : pour la prolonger, on en crée une nouvelle. Un arrêt est définitif.
 * `plannedTo` : dernier jour prévu à la création de la règle.
 */
export function endErrors(r: { kind: RateKind; effectiveFrom: string; plannedTo: string | null; stopped: boolean }, lastDay: string, today: string): string[] {
  if (r.kind === 'PRICE') return ['Un prix du catalogue ne s’arrête pas : un nouveau prix le remplace'];
  if (r.stopped) return ['Cette règle est déjà arrêtée'];
  if (!isDay(lastDay)) return ['Dernier jour invalide'];
  if (r.plannedTo !== null && r.plannedTo < today) return ['Cette règle est déjà terminée'];
  const cancel = r.effectiveFrom > today && lastDay === addDays(r.effectiveFrom, -1);
  if (!cancel && lastDay < today) return ['Le dernier jour est au plus tôt aujourd’hui : une règle ne s’arrête jamais dans le passé'];
  if (!cancel && lastDay < r.effectiveFrom) return ['Le dernier jour suit la date d’effet (ou la veille, pour annuler une règle qui n’a pas commencé)'];
  if (r.plannedTo !== null && lastDay >= r.plannedTo) return ['Une règle se raccourcit seulement : pour la prolonger, créez-en une nouvelle'];
  return [];
}

// ---------------------------------------------------------------- Catalogue

/** Code stable d'une prestation, tiré de son premier nom : « Formation et prise en main » → FORMATION_ET_PRISE_EN_MAIN. */
export function serviceCode(name: string) {
  const code = name
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    .slice(0, 48).replace(/_+$/g, '');
  return code || 'PRESTATION';
}
