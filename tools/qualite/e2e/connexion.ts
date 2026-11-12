import { Page } from '@playwright/test';
import { MOT_DE_PASSE } from './comptes';

/**
 * Connexion par le formulaire. L'API limite à 10 connexions par minute et par adresse : si la limite est
 * atteinte (ce qui prouve au passage qu'elle fonctionne), on attend la minute suivante.
 */
export async function connexion(page: Page, identifiant: string, motDePasse = MOT_DE_PASSE) {
  for (let essai = 0; essai < 3; essai++) {
    await page.goto('/connexion');
    await page.getByLabel('Téléphone, e-mail ou matricule').fill(identifiant);
    await page.getByLabel('Mot de passe', { exact: true }).fill(motDePasse);
    await page.getByRole('button', { name: 'Se connecter' }).click();
    const limite = page.getByRole('alert').filter({ hasText: /Too Many Requests|Trop de/ });
    await Promise.race([page.waitForURL((u) => u.pathname.startsWith('/espace')), limite.waitFor()]);
    if (new URL(page.url()).pathname.startsWith('/espace')) return;
    await page.waitForTimeout(61_000);
  }
  throw new Error('Connexion impossible après 3 essais');
}
