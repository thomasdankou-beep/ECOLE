'use client';

/**
 * Client de l'API : jeton d'accès en mémoire (jamais dans le stockage du navigateur),
 * renouvellement silencieux par le cookie httpOnly, rôle actif transmis à chaque appel.
 */
let accessToken: string | null = null;
let activeRole: string | null = null;
let refreshing: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

export class ApiError extends Error {
  /** `code` et `body` : erreur métier qui porte des données (ex. DOUBLON_POSSIBLE et les dossiers qui ressemblent). */
  constructor(public status: number, message: string, public code?: string, public body?: any) {
    super(message);
  }
}

export function setSession(token: string | null) {
  accessToken = token;
  if (!token) listeners.forEach((l) => l());
}
export function setActiveRole(role: string | null) {
  activeRole = role;
}

/**
 * Session de la connexion en cours, lue dans le jeton d'accès (le même pour tous les onglets de cette connexion,
 * renouvellements compris) : sert à ce qui ne doit se produire qu'une fois par connexion. Rien n'est vérifié ici :
 * l'API reste seule juge du jeton.
 */
export function currentSessionId(): string | null {
  try {
    const part = accessToken?.split('.')[1];
    if (!part) return null;
    const payload = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as { sid?: unknown };
    return typeof payload.sid === 'string' ? payload.sid : null;
  } catch {
    return null;
  }
}
export function onSessionLost(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export async function refreshSession(): Promise<boolean> {
  if (!refreshing) {
    refreshing = fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'same-origin' })
      .then(async (r) => {
        if (!r.ok) return false;
        const body = await r.json();
        accessToken = body.accessToken;
        return true;
      })
      .catch(() => false)
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

async function call<T>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (activeRole) headers['X-Active-Role'] = activeRole;
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'Pas de connexion. Vérifiez votre réseau et réessayez.');
  }
  if (res.status === 401 && retry && !path.startsWith('/auth/login')) {
    if (await refreshSession()) return call<T>(method, path, body, false);
    setSession(null);
  }
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  const data = type.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const obj = typeof data === 'object' && data ? data : null;
    throw new ApiError(res.status, obj?.message ?? 'Une erreur est survenue', typeof obj?.code === 'string' ? obj.code : undefined, obj ?? undefined);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => call<T>('GET', path),
  post: <T>(path: string, body?: unknown) => call<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => call<T>('PUT', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => call<T>('PATCH', path, body ?? {}),
  del: <T>(path: string) => call<T>('DELETE', path),
  /** Téléchargement authentifié (export CSV). */
  async download(path: string, filename: string) {
    const text = await call<string>('GET', path);
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    a.click();
    URL.revokeObjectURL(url);
  },
};

export async function publicGet<T>(path: string): Promise<T> {
  const r = await fetch(`/api/v1${path}`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, data?.message ?? 'Erreur');
  return data as T;
}

export async function publicPost<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`/api/v1${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, data?.message ?? 'Erreur');
  return data as T;
}
