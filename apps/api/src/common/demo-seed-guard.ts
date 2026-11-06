/**
 * Garde-fou du jeu de démonstration (SEC-038) : `npm run db:seed` recrée l'école « saint-kisito »
 * en effaçant d'abord ses données. Il ne doit jamais toucher une école réelle.
 */
export type SeedTarget = { slug: string; settings: unknown } | null;

/** L'école a été créée par le jeu de démonstration (il la marque `settings.demo = true`). */
export function isDemoTenant(t: SeedTarget): boolean {
  const s = t?.settings;
  return !!s && typeof s === 'object' && (s as Record<string, unknown>).demo === true;
}

/**
 * Raison du refus, ou null si le jeu de démonstration peut être (re)chargé.
 * - Une école existante sans la marque « démonstration » n'est jamais effacée, sans exception.
 * - Sur un serveur de production (PRODUCTION_SERVER=true, posé par installer-serveur.sh), le script
 *   refuse de tourner sauf autorisation écrite explicite ALLOW_DEMO_RESET=1.
 */
export function demoSeedRefusal(existing: SeedTarget, env: Record<string, string | undefined>): string | null {
  if (existing && !isDemoTenant(existing)) {
    return `L'école « ${existing.slug} » n'est pas une école de démonstration : elle contient de vraies données. Rien n'a été effacé.`;
  }
  if (env.PRODUCTION_SERVER === 'true' && env.ALLOW_DEMO_RESET !== '1') {
    return "Serveur de production : le jeu de démonstration n'est pas chargé ici. Rien n'a été modifié (ALLOW_DEMO_RESET=1 pour forcer sur un serveur de démonstration).";
  }
  return null;
}
