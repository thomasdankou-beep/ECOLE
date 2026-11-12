import { expect, Page, test } from '@playwright/test';
import { COMPTES, PROVISOIRE, SUPER_ADMIN } from './comptes';
import { connexion } from './connexion';

/** SEC-043 : les protections visibles à l'écran, vérifiées dans un vrai navigateur, au bureau et au téléphone. */

/** Liens du menu, ouvert si besoin (au téléphone il est replié). */
async function liensDuMenu(page: Page) {
  await page.getByRole('heading').first().waitFor();
  const ouvrir = page.getByRole('button', { name: 'Ouvrir le menu' });
  if (await ouvrir.isVisible().catch(() => false)) await ouvrir.click();
  return page.locator('a[href^="/espace"]').evaluateAll((as) => [...new Set(as.map((a) => a.getAttribute('href')))]);
}

test('la page de connexion refuse un mauvais mot de passe sans dire si le compte existe', async ({ page }) => {
  // Le message du formulaire (l'annonceur de pages de Next.js est une alerte vide). Si la limite de 10 connexions
  // par minute est atteinte par les tests précédents, on attend la minute suivante, comme dans connexion().
  const alerte = page.getByRole('alert').filter({ hasText: /\S/ });
  const limite = /Too Many Requests|Trop de/;
  for (let essai = 0; essai < 2; essai++) {
    await page.goto('/connexion');
    await page.getByLabel('Téléphone, e-mail ou matricule').fill(COMPTES.comptable);
    await page.getByLabel('Mot de passe', { exact: true }).fill('mauvais-mot-de-passe');
    await page.getByRole('button', { name: 'Se connecter' }).click();
    await expect(alerte).toBeVisible();
    if (!limite.test(await alerte.innerText())) break;
    await page.waitForTimeout(61_000);
  }
  await expect(alerte).not.toHaveText(limite);
  await expect(page).toHaveURL(/\/connexion/);
});

for (const [role, identifiant] of Object.entries(COMPTES)) {
  test(`connexion et menu selon le rôle : ${role}`, async ({ page }) => {
    await connexion(page, identifiant);
    await expect(page).toHaveURL(/\/espace/);
    const liens = await liensDuMenu(page);
    expect(liens).toContain('/espace/compte');
    // Seule la direction voit le journal d'audit, le personnel et les paramètres.
    for (const reserve of ['/espace/audit', '/espace/personnel', '/espace/parametres']) {
      if (role === 'direction') expect(liens).toContain(reserve);
      else expect(liens).not.toContain(reserve);
    }
  });
}

test("un enseignant qui tape l'adresse du journal d'audit ne voit aucune ligne", async ({ page }) => {
  await connexion(page, COMPTES.enseignant);
  await page.goto('/espace/audit');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(0);
});

test('la direction lit le journal, page par page, avec l’export', async ({ page }) => {
  await connexion(page, COMPTES.direction);
  await page.goto('/espace/audit');
  await expect(page.getByRole('heading', { name: 'Journal d’audit' })).toBeVisible();
  await expect(page.locator('tbody tr').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Export/ })).toBeVisible();
  // Aucune page ne déborde en largeur (téléphone compris) : le tableau défile dans son cadre.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test('un mot de passe provisoire oblige à le changer avant toute autre page', async ({ page }, info) => {
  test.skip(info.project.name !== 'bureau', 'le compte provisoire ne sert qu’une fois');
  await connexion(page, PROVISOIRE.identifiant, PROVISOIRE.motDePasse);
  await expect(page).toHaveURL(/\/espace\/compte\?premiere=1/);
  await page.goto('/espace/eleves');
  await expect(page).toHaveURL(/\/espace\/compte\?premiere=1/);
  await page.getByLabel('Mot de passe actuel').fill(PROVISOIRE.motDePasse);
  await page.getByLabel('Nouveau mot de passe').fill(PROVISOIRE.nouveau);
  await page.getByLabel('Confirmer').fill(PROVISOIRE.nouveau);
  await page.getByRole('button', { name: 'Changer le mot de passe' }).click();
  await page.waitForTimeout(1000);
  await page.goto('/espace/eleves');
  await expect(page).toHaveURL(/\/espace\/eleves/);
});

test('sans connexion, l’espace renvoie vers la page de connexion', async ({ page }) => {
  await page.goto('/espace/eleves');
  await page.waitForURL(/\/connexion/);
});

test('Super Admin : espace séparé, inaccessible avec un compte d’école', async ({ page }) => {
  await connexion(page, COMPTES.direction);
  await page.goto('/plateforme');
  await page.waitForURL(/\/plateforme\/connexion/);
  await page.getByLabel('Adresse e-mail').fill(SUPER_ADMIN.email);
  await page.getByLabel('Mot de passe').fill(SUPER_ADMIN.motDePasse);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await page.waitForURL(/\/plateforme$/);
  await expect(page.getByText('saint-kisito').first()).toBeVisible();
});

test('pages publiques : accueil et pré-inscription', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText(/Saint Kisito/).first()).toBeVisible();
  await page.goto('/preinscription');
  await expect(page.getByRole('button', { name: /Envoyer/ })).toBeVisible();
});

test('politique de contenu (SEC-047) : en-tête présent et aucune page ne la dépasse', async ({ page }) => {
  const ecarts: string[] = [];
  page.on('console', (m) => { if (/Content Security Policy|Content-Security-Policy/i.test(m.text())) ecarts.push(m.text()); });
  const r = await page.goto('/');
  expect(r?.headers()['content-security-policy-report-only']).toContain("default-src 'self'");
  await page.goto('/preinscription');
  await connexion(page, COMPTES.direction);
  for (const p of ['/espace', '/espace/eleves', '/espace/audit', '/espace/parametres', '/espace/emploi-du-temps']) {
    await page.goto(p);
    await page.getByRole('heading').first().waitFor();
    await page.waitForTimeout(500);
  }
  expect(ecarts).toEqual([]);
});

test('documentation de l’API fermée en production (SEC-045)', async ({ request }) => {
  // Caddy envoie /api/* à l'API : c'est donc l'API qui doit répondre 404.
  const api = process.env.API_URL ?? 'http://localhost:4000';
  expect((await request.get(`${api}/api/docs`)).status()).toBe(404);
  expect((await request.get(`${api}/api/v1/public/saint-kisito`)).status()).toBe(200);
});
