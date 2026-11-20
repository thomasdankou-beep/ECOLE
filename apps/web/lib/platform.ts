'use client';

import { ApiError } from './api';

/**
 * Appels de l'espace Super Admin : session portée par un cookie httpOnly réservé à /api/v1/platform. Un formulaire avec
 * fichier (FormData : justificatif d'un paiement, lot G5d-2) part tel quel, le navigateur pose son en-tête.
 */
export async function pf<T>(method: string, path: string, body?: unknown): Promise<T> {
  let r: Response;
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  try {
    r = await fetch(`/api/v1/platform${path}`, {
      method, credentials: 'same-origin',
      headers: body === undefined || isForm ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
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
