'use client';

/**
 * Accès selon l'abonnement Cahiora, tel que l'établissement le lit (lot G5d-1, D-G5-30 A) : textes du bandeau, de
 * l'alerte de connexion de la direction et de la carte du tableau de bord. Les phases et les dates viennent de l'API
 * (/auth/me), qui les calcule au jour et à l'heure de l'établissement ; rien n'est recalculé ici. Lecture 7 A
 * (20 novembre 2026) : pendant le préavis qui suit une réponse de Cahiora, le jour et l'heure de la limitation, avec
 * un compteur en heures.
 */

export type AccessPhase = 'FREE' | 'ACTIVE' | 'GRACE' | 'EXTENDED' | 'NOTICE' | 'HELD' | 'DUE' | 'LIMITED' | 'WAITING';

/** Accès de l'établissement pour le personnel (null pour une famille, ou sans abonnement). */
export type SchoolAccess = {
  status: string; statusLabel: string; phase: AccessPhase;
  /** Dernier jour d'accès complet assuré (délai de grâce ou prolongation). */
  until: string | null;
  /** Jours d'accès complet restants, aujourd'hui compris : le compteur. */
  daysLeft: number | null;
  limitedFrom: string | null;
  /** Préavis en cours : fin (instant), son libellé à l'heure de l'établissement, heures restantes. */
  limitedAt: string | null; limitedAtLabel: string | null; hoursLeft: number | null;
  pendingRequest: boolean; termsAccepted: boolean;
  /** La personne a le rôle Direction ; seule la direction de tout l'établissement régularise. */
  direction: boolean; canRegularize: boolean;
};

/** Phases où la direction est prévenue (bandeau, alerte de connexion, carte du tableau de bord). */
export const ALERT_PHASES: AccessPhase[] = ['GRACE', 'EXTENDED', 'NOTICE', 'HELD', 'DUE', 'WAITING', 'LIMITED'];

/** Page de l'abonnement, à sa section « Régulariser mon abonnement ». */
export const REGULARIZE_HREF = '/espace/parametres?rubrique=abonnement#regulariser';

/** Ce qui reste ouvert pendant l'accès limité (même texte que l'API). */
export const LIMITED_KEEPS = 'consultation, impression, export, caisse et régularisation restent possibles, et aucune donnée n’est supprimée';
export const LIMITED_WILL_KEEP = 'consultation, impression, export, caisse et régularisation resteront possibles, et aucune donnée ne sera supprimée';

const frDate = (d: string | null) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '—');
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Compteur : « Encore 15 jours », « Encore 2 jours », « Dernier jour ». */
export const counterText = (n: number) => (n <= 1 ? 'Dernier jour d’accès complet' : `Encore ${n} jours d’accès complet`);

/** Compteur du préavis : « Encore 31 heures », « Dernière heure ». */
export const hoursText = (n: number) => (n <= 1 ? 'Dernière heure d’accès complet' : `Encore ${n} heures d’accès complet`);

/** Compteur d'une phase : jours pendant le délai ou la prolongation, heures pendant le préavis ; null sinon. */
export function accessCounter(a: Pick<SchoolAccess, 'phase' | 'daysLeft' | 'hoursLeft'>) {
  if (a.phase === 'NOTICE' && a.hoursLeft !== null) return hoursText(a.hoursLeft);
  if ((a.phase === 'GRACE' || a.phase === 'EXTENDED') && a.daysLeft !== null) return counterText(a.daysLeft);
  return null;
}

/** Titre et texte d'une phase ; `staff` : personnel qui n'est pas de la direction (accès limité seulement). */
export function accessText(a: SchoolAccess, staff = false): { title: string; body: string; tone: 'warn' | 'bad' } {
  const pending = a.pendingRequest ? ' Votre demande de régularisation attend la réponse de Cahiora : tant qu’elle attend, l’accès ne sera pas limité.' : '';
  const after = ` Ensuite, sans paiement validé, l’accès sera limité : ${LIMITED_WILL_KEEP}.`;
  switch (a.phase) {
    case 'GRACE':
      return { tone: 'warn', title: `Abonnement Cahiora : ${lower(a.statusLabel)}`, body: `Délai de grâce en accès complet jusqu’au ${frDate(a.until)} inclus.${a.pendingRequest ? pending : after}` };
    case 'EXTENDED':
      return { tone: 'warn', title: 'Accès complet prolongé par Cahiora', body: `Jusqu’au ${frDate(a.until)} inclus.${a.pendingRequest ? pending : after}` };
    case 'NOTICE':
      return {
        tone: 'warn', title: 'Préavis avant l’accès limité',
        body: `Cahiora a répondu à votre demande de régularisation : l’accès reste complet jusqu’au ${a.limitedAtLabel ?? frDate(a.until)}.${a.pendingRequest ? pending : after}`,
      };
    case 'HELD':
      return { tone: 'warn', title: `Abonnement Cahiora : ${lower(a.statusLabel)}`, body: 'Le délai d’accès complet est passé. Votre demande de régularisation attend la réponse de Cahiora : tant qu’elle attend, l’accès n’est pas limité.' };
    case 'DUE':
      return { tone: 'bad', title: `Abonnement Cahiora : ${lower(a.statusLabel)}`, body: `Le délai d’accès complet est passé sans paiement validé : l’accès va être limité ; ${LIMITED_WILL_KEEP}.` };
    case 'LIMITED':
      return {
        tone: 'bad', title: 'Accès limité',
        body: `L’abonnement Cahiora de l’établissement n’est pas régularisé : ${LIMITED_KEEPS}.${staff ? ' Pour toute autre saisie, voyez avec la direction de l’établissement.' : ''}`,
      };
    default:
      return { tone: 'warn', title: `Abonnement Cahiora : ${lower(a.statusLabel)}`, body: 'Votre période gratuite est terminée : régularisez votre abonnement pour continuer. Vos données sont conservées.' };
  }
}

/** Le bandeau s'affiche : accès limité pour tout le personnel ; délai en cours ou passé pour la direction. */
export const showsAccess = (a: SchoolAccess | null | undefined): a is SchoolAccess => !!a && (a.phase === 'LIMITED' || (a.direction && ALERT_PHASES.includes(a.phase)));

// ---------------------------------------------------------------- Alerte de connexion de la direction

const ALERT_KEY = 'cahiora.alerte-abonnement';

/** Empreinte courte de la connexion (personne et session) : le navigateur ne garde ni l'une ni l'autre en clair. */
function fingerprint(userId: string, sessionId: string | null) {
  let h = 0x811c9dc5;
  for (const c of `${userId}:${sessionId ?? ''}`) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(36);
}

/**
 * L'alerte de la direction s'affiche une fois par connexion, pour tous les onglets de cette connexion (lecture 3,
 * ajustée par Dankou le 20 novembre 2026) : la marque, posée dès que l'alerte s'affiche, est partagée par les onglets
 * du navigateur ; une nouvelle connexion ouvre une autre session, donc une nouvelle alerte. La marque s'efface aussi à
 * la connexion et à la déconnexion.
 */
export const loginAlert = {
  /** Vrai si l'alerte n'a pas encore été montrée pendant cette connexion ; la marque est alors posée aussitôt. */
  take(userId: string, sessionId: string | null): boolean {
    const mark = fingerprint(userId, sessionId);
    try {
      if (localStorage.getItem(ALERT_KEY) === mark) return false;
      localStorage.setItem(ALERT_KEY, mark);
    } catch {
      /* stockage indisponible : l'alerte s'affiche, comme à une nouvelle connexion */
    }
    return true;
  },
  /** Deux onglets ouverts au même instant : celui qui voit la marque posée par l'autre ferme son alerte. */
  onShownElsewhere(userId: string, sessionId: string | null, fn: () => void) {
    const mark = fingerprint(userId, sessionId);
    const listener = (e: StorageEvent) => {
      if (e.key === ALERT_KEY && e.newValue === mark) fn();
    };
    window.addEventListener('storage', listener);
    return () => window.removeEventListener('storage', listener);
  },
  reset() {
    try {
      localStorage.removeItem(ALERT_KEY);
      // Marque de l'ancienne règle (une alerte par onglet), si elle traîne encore.
      sessionStorage.removeItem(ALERT_KEY);
    } catch {
      /* rien à effacer */
    }
  },
};

// ---------------------------------------------------------------- Mise à jour après une demande ou une acceptation

const listeners = new Set<() => void>();
/** Demande à relire l'accès (bandeau, alerte, carte) : après une demande de régularisation ou une acceptation. */
export const accessChanged = () => listeners.forEach((l) => l());
export function onAccessChanged(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
