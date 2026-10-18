export const fcfa = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : `${new Intl.NumberFormat('fr-FR').format(Math.round(n)).replace(/ | /g, ' ')} FCFA`;

export const num = (n: number | string | null | undefined, digits = 2) =>
  n === null || n === undefined || n === '' || Number.isNaN(Number(n))
    ? '—'
    : Number(n).toLocaleString('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const note = (n: number | string | null | undefined) =>
  n === null || n === undefined ? '—' : Number(n).toLocaleString('fr-FR', { maximumFractionDigits: 2 });

export const date = (d: string | Date | null | undefined, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }) =>
  d ? new Date(d).toLocaleDateString('fr-FR', { timeZone: 'UTC', ...opts }) : '—';

export const dateTime = (d: string | Date | null | undefined) =>
  d ? new Date(d).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

export const hhmm = (m: number) => `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`.replace(' h 00', ' h');

export const today = () => new Date().toISOString().slice(0, 10);

export const DAYS = ['', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

export const ROLE_LABEL: Record<string, string> = {
  DIRECTION: 'Direction',
  SECRETARIAT: 'Secrétariat',
  ENSEIGNANT: 'Enseignant',
  VIE_SCOLAIRE: 'Vie scolaire',
  COMPTABLE: 'Comptable',
  PARENT: 'Parent',
  ELEVE: 'Élève',
};

export const METHOD_LABEL: Record<string, string> = {
  CASH: 'Espèces',
  CHEQUE: 'Chèque',
  TRANSFER: 'Virement',
  MOBILE_MONEY_DESK: 'Mobile Money (bureau)',
  ONLINE: 'Mobile Money en ligne',
};
