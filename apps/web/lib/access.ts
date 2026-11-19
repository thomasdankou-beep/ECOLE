'use client';

/**
 * Accès selon l'abonnement Cahiora, tel que l'établissement le lit (lot G5d-1, D-G5-30 A) : textes du bandeau, de
 * l'alerte de connexion de la direction et de la carte du tableau de bord. Les phases et les dates viennent de l'API
 * (/auth/me), qui les calcule au jour de l'établissement ; rien n'est recalculé ici.
 */

export type AccessPhase = 'FREE' | 'ACTIVE' | 'GRACE' | 'EXTENDED' | 'HELD' | 'DUE' | 'LIMITED' | 'WAITING';

/** Accès de l'établissement pour le personnel (null pour une famille, ou sans abonnement). */
export type SchoolAccess = {
  status: string; statusLabel: string; phase: AccessPhase;
  /** Dernier jour d'accès complet assuré (délai de grâce ou prolongation). */
  until: string | null;
  /** Jours d'accès complet restants, aujourd'hui compris : le compteur. */
  daysLeft: number | null;
  limitedFrom: string | null;
  pendingRequest: boolean; termsAccepted: boolean;
  /** La personne a le rôle Direction ; seule la direction de tout l'établissement régularise. */
  direction: boolean; canRegularize: boolean;
};

/** Phases où la direction est prévenue (bandeau, alerte de connexion, carte du tableau de bord). */
export const ALERT_PHASES: AccessPhase[] = ['GRACE', 'EXTENDED', 'HELD', 'DUE', 'WAITING', 'LIMITED'];

/** Page de l'abonnement, à sa section « Régulariser mon abonnement ». */
export const REGULARIZE_HREF = '/espace/parametres?rubrique=abonnement#regulariser';

/** Ce qui reste ouvert pendant l'accès limité (même texte que l'API). */
export const LIMITED_KEEPS = 'consultation, impression, export, caisse et régularisation restent possibles, et aucune donnée n’est supprimée';
export const LIMITED_WILL_KEEP = 'consultation, impression, export, caisse et régularisation resteront possibles, et aucune donnée ne sera supprimée';

const frDate = (d: string | null) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '—');
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Compteur : « Encore 15 jours », « Encore 2 jours », « Dernier jour ». */
export const counterText = (n: number) => (n <= 1 ? 'Dernier jour d’accès complet' : `Encore ${n} jours d’accès complet`);

/** Titre et texte d'une phase ; `staff` : personnel qui n'est pas de la direction (accès limité seulement). */
export function accessText(a: SchoolAccess, staff = false): { title: string; body: string; tone: 'warn' | 'bad' } {
  const pending = a.pendingRequest ? ' Votre demande de régularisation attend la réponse de Cahiora : tant qu’elle attend, l’accès ne sera pas limité.' : '';
  const after = ` Ensuite, sans paiement validé, l’accès sera limité : ${LIMITED_WILL_KEEP}.`;
  switch (a.phase) {
    case 'GRACE':
      return { tone: 'warn', title: `Abonnement Cahiora : ${lower(a.statusLabel)}`, body: `Délai de grâce en accès complet jusqu’au ${frDate(a.until)} inclus.${a.pendingRequest ? pending : after}` };
    case 'EXTENDED':
      return { tone: 'warn', title: 'Accès complet prolongé par Cahiora', body: `Jusqu’au ${frDate(a.until)} inclus.${a.pendingRequest ? pending : after}` };
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

/** L'alerte de la direction s'affiche une fois par connexion (et par onglet) : la clé s'efface à la connexion et à la déconnexion. */
export const loginAlert = {
  seen(userId: string) {
    try {
      return sessionStorage.getItem(ALERT_KEY) === userId;
    } catch {
      return false;
    }
  },
  done(userId: string) {
    try {
      sessionStorage.setItem(ALERT_KEY, userId);
    } catch {
      /* stockage indisponible : l'alerte reviendra au prochain chargement de la page */
    }
  },
  reset() {
    try {
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
