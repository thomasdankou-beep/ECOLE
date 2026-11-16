'use client';

import { ApiError } from './api';

/**
 * Console du groupe (lot G2) : session portée par un cookie httpOnly réservé à /api/v1/group, distinct de celui
 * du Super Admin et des jetons des écoles.
 */
export async function gp<T>(method: string, path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`/api/v1/group${path}`, {
      method, credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Pas de connexion. Vérifiez votre réseau et réessayez.');
  }
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const m = data?.message;
    throw new ApiError(r.status, Array.isArray(m) ? m.join(' · ') : m ?? 'Une erreur est survenue');
  }
  return data as T;
}

export type GroupRole = 'GENERAL' | 'FINANCIER' | 'PEDAGOGIQUE';

export const GROUP_ROLE_LABELS: Record<GroupRole, string> = {
  GENERAL: 'Responsable général du groupe',
  FINANCIER: 'Responsable financier du groupe',
  PEDAGOGIQUE: 'Responsable pédagogique du groupe',
};

export const GROUP_ROLE_HINTS: Record<GroupRole, string> = {
  GENERAL: 'Tout ce que voit le groupe, plus ses comptes et son journal.',
  FINANCIER: 'Chiffres financiers et factures Cahiora (à venir).',
  PEDAGOGIQUE: 'Effectifs, assiduité et résultats (à venir), sans les finances.',
};

/** Compte de la console tel que l'API le montre : jamais de mot de passe, de secret ni de code. */
export type GroupAccount = {
  id: string; firstName: string; lastName: string; phone: string | null; email: string | null; role: GroupRole; roleLabel: string;
  active: boolean; locked: boolean; pendingFirstLogin: boolean; totpEnabled: boolean; lastLoginAt: string | null; createdAt: string; self?: boolean;
};

export type GroupLog = { id: string; action: string; actorKind: string; actorName: string | null; data: Record<string, unknown> | null; ip: string | null; createdAt: string };

/** Libellés du journal d'un groupe : actions de Cahiora sur le groupe et actions de ses propres comptes. */
export const GROUP_ACTIONS: Record<string, string> = {
  'group.created': 'Groupe créé',
  'group.created_for_school': 'Groupe créé au nom de l’école',
  'group.updated': 'Fiche du groupe modifiée',
  'group.school_created': 'Nouvelle école créée dans le groupe',
  'group.school_joined': 'École rattachée au groupe',
  'group.school_left': 'École retirée du groupe',
  'group.deleted': 'Groupe supprimé',
  'group.suspended': 'Accès à la console suspendu par Cahiora',
  'group.reactivated': 'Accès à la console rétabli par Cahiora',
  'group.account_created': 'Compte de la console créé',
  'group.account_updated': 'Compte de la console modifié',
  'group.account_reset': 'Accès d’un compte remis (nouveau mot de passe provisoire)',
  'group.auth.login': 'Connexion',
  'group.auth.failed': 'Mot de passe incorrect',
  'group.auth.locked': 'Compte bloqué 15 minutes après 5 erreurs',
  'group.auth.refused': 'Connexion refusée',
  'group.auth.2fa_failed': 'Code de double authentification incorrect',
  'group.auth.2fa_enabled': 'Double authentification activée',
  'group.auth.2fa_reset': 'Nouveau téléphone pour la double authentification',
  'group.auth.recovery_codes_generated': 'Codes de récupération créés',
  'group.auth.recovery_code_used': 'Connexion avec un code de récupération',
  'group.auth.recovery_code_failed': 'Code de récupération incorrect',
  'group.auth.password_changed': 'Mot de passe changé',
  'group.auth.logout': 'Déconnexion',
  'group.auth.session_revoked': 'Session fermée',
  'group.auth.sessions_revoked': 'Autres sessions fermées',
};

const FIELD_LABELS: Record<string, string> = {
  name: 'nom', legalName: 'raison sociale', promoter: 'promoteur', phone: 'téléphone', email: 'e-mail', address: 'adresse', country: 'pays', taxId: 'identifiant fiscal',
};

/** Détail lisible d'une ligne du journal d'un groupe. */
export function groupLogDetail(r: Pick<GroupLog, 'action' | 'data'>) {
  const d = r.data ?? {};
  if (typeof d.tenantName === 'string') return d.tenantName;
  if (r.action === 'group.updated') return `Modifié : ${Object.keys(d).map((k) => FIELD_LABELS[k] ?? k).join(', ')}`;
  if (r.action === 'group.account_updated') {
    const parts = [typeof d.role === 'string' ? `rôle : ${d.role}` : null, d.active === false ? 'désactivé' : d.active === true ? 'réactivé' : null].filter(Boolean);
    return `${d.name ?? ''}${parts.length ? ` · ${parts.join(', ')}` : ''}`;
  }
  if (r.action === 'group.account_created') return `${d.name ?? ''}${d.role ? ` · ${d.role}` : ''}`;
  if (r.action === 'group.auth.refused' && typeof d.reason === 'string') return d.reason;
  if (r.action === 'group.auth.recovery_code_used' && typeof d.remaining === 'number') return `Codes restants : ${d.remaining}`;
  return typeof d.name === 'string' ? d.name : null;
}

/** État lisible d'un compte. */
export function accountState(a: GroupAccount): { label: string; tone: 'good' | 'warn' | 'bad' | 'info' } {
  if (!a.active) return { label: 'Désactivé', tone: 'bad' };
  if (a.locked) return { label: 'Bloqué 15 min', tone: 'warn' };
  if (a.pendingFirstLogin) return { label: 'Première connexion à faire', tone: 'info' };
  return { label: 'Actif', tone: 'good' };
}

export const dateTime = (d: string | null) => (d ? new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
