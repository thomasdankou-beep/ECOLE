'use client';

/**
 * École servie par cette adresse : domaine propre ou sous-domaine de la plateforme, résolu par l'API.
 * Sans école à cette adresse (accueil de la plateforme), l'école de l'installation (NEXT_PUBLIC_TENANT) sert de repli si elle est définie.
 */
let pending: Promise<string | null> | null = null;

export function resolveTenant(): Promise<string | null> {
  pending ??= fetch(`/api/v1/platform/resolve?host=${encodeURIComponent(location.host)}`)
    .then(async (r) => (r.ok ? ((await r.json()).slug as string | null) : null) || process.env.NEXT_PUBLIC_TENANT || null)
    .catch(() => {
      pending = null;
      return process.env.NEXT_PUBLIC_TENANT || null;
    });
  return pending;
}

/** Identifiant de l'école pour les appels publics ; erreur lisible si l'adresse ne désigne aucune école. */
export async function tenantOrThrow(): Promise<string> {
  const t = await resolveTenant();
  if (!t) throw new Error('Aucune école n’est servie à cette adresse.');
  return t;
}
