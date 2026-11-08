import { Tx } from './prisma.service';
import { normalizePhone } from './util';

/**
 * Réglages par pays : indicatif téléphonique, monnaie, fuseau horaire et nom de la facture normalisée de l'État.
 * Le Super Admin choisit le pays d'une école ; la monnaie et le fuseau en découlent et restent modifiables.
 * Les opérateurs Mobile Money ne sont pré-remplis que pour le Bénin (connus) : ailleurs, la direction les saisit.
 */
export interface Country {
  code: string;
  name: string;
  dial: string;
  currency: string;
  timezone: string;
  /// Facture normalisée de l'administration fiscale ; null = aucune connue pour ce pays.
  einvoice: string | null;
  mobileMoney: string[];
}

export const COUNTRIES: Country[] = [
  { code: 'BJ', name: 'Bénin', dial: '229', currency: 'XOF', timezone: 'Africa/Porto-Novo', einvoice: 'e-MECeF', mobileMoney: ['MTN MoMo', 'Moov Money'] },
  { code: 'BF', name: 'Burkina Faso', dial: '226', currency: 'XOF', timezone: 'Africa/Ouagadougou', einvoice: null, mobileMoney: [] },
  { code: 'CM', name: 'Cameroun', dial: '237', currency: 'XAF', timezone: 'Africa/Douala', einvoice: null, mobileMoney: [] },
  { code: 'CG', name: 'Congo', dial: '242', currency: 'XAF', timezone: 'Africa/Brazzaville', einvoice: null, mobileMoney: [] },
  { code: 'CI', name: "Côte d'Ivoire", dial: '225', currency: 'XOF', timezone: 'Africa/Abidjan', einvoice: 'FNE', mobileMoney: [] },
  { code: 'GA', name: 'Gabon', dial: '241', currency: 'XAF', timezone: 'Africa/Libreville', einvoice: null, mobileMoney: [] },
  { code: 'GN', name: 'Guinée', dial: '224', currency: 'GNF', timezone: 'Africa/Conakry', einvoice: null, mobileMoney: [] },
  { code: 'ML', name: 'Mali', dial: '223', currency: 'XOF', timezone: 'Africa/Bamako', einvoice: null, mobileMoney: [] },
  { code: 'NE', name: 'Niger', dial: '227', currency: 'XOF', timezone: 'Africa/Niamey', einvoice: null, mobileMoney: [] },
  { code: 'SN', name: 'Sénégal', dial: '221', currency: 'XOF', timezone: 'Africa/Dakar', einvoice: null, mobileMoney: [] },
  { code: 'TD', name: 'Tchad', dial: '235', currency: 'XAF', timezone: 'Africa/Ndjamena', einvoice: null, mobileMoney: [] },
  { code: 'TG', name: 'Togo', dial: '228', currency: 'XOF', timezone: 'Africa/Lome', einvoice: null, mobileMoney: [] },
];

export const COUNTRY_CODES = COUNTRIES.map((c) => c.code);

/** Pays connu, sinon le Bénin (pays des écoles existantes). */
export function country(code: string | null | undefined): Country {
  return COUNTRIES.find((c) => c.code === code) ?? COUNTRIES[0];
}

export const CURRENCIES = [...new Set(COUNTRIES.map((c) => c.currency))];

/** Libellé affiché d'une monnaie : FCFA pour les francs CFA d'Afrique de l'Ouest et centrale. */
export const currencyLabel = (code: string | null | undefined) => (!code || code === 'XOF' || code === 'XAF' ? 'FCFA' : code);

export const money = (n: number, currency?: string | null) => new Intl.NumberFormat('fr-FR').format(n).replace(/[\u00a0\u202f]/g, ' ') + ' ' + currencyLabel(currency);

export function validTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Date du jour (AAAA-MM-JJ) à l'heure de l'école. */
export function localDay(timezone: string | null | undefined, at = new Date()): string {
  const tz = timezone && validTimezone(timezone) ? timezone : 'UTC';
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

export interface Locale {
  country: Country;
  currency: string;
  timezone: string;
}

/** Pays, monnaie et fuseau de l'école courante (lecture dans la transaction de l'école). */
export async function tenantLocale(tx: Tx, tenantId: string): Promise<Locale> {
  const t = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { country: true, currency: true, timezone: true } });
  return { country: country(t.country), currency: t.currency, timezone: t.timezone };
}

/** Numéro normalisé avec l'indicatif du pays de l'école courante. */
export async function tenantPhone(tx: Tx, tenantId: string, raw: string): Promise<string> {
  return normalizePhone(raw, (await tenantLocale(tx, tenantId)).country.dial);
}

/** Opérateurs Mobile Money proposés au parent : ceux saisis par la direction, sinon ceux connus pour le pays. */
export function schoolOperators(tenant: { country: string; settings: unknown }): string[] {
  const own = (tenant.settings as { payments?: { operators?: unknown } } | null)?.payments?.operators;
  return Array.isArray(own) ? own.filter((x): x is string => typeof x === 'string') : country(tenant.country).mobileMoney;
}

/** Date du jour (AAAA-MM-JJ) à l'heure de l'école courante. */
export async function tenantToday(tx: Tx, tenantId: string): Promise<string> {
  return localDay((await tenantLocale(tx, tenantId)).timezone);
}
