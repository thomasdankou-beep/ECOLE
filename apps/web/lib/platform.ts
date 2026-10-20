'use client';

import { ApiError } from './api';

/** Appels de l'espace Super Admin : session portée par un cookie httpOnly réservé à /api/v1/platform. */
export async function pf<T>(method: string, path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`/api/v1/platform${path}`, {
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
