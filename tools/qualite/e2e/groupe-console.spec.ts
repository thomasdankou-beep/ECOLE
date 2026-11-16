import { Browser, expect, Page, test } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { SUPER_ADMIN } from './comptes';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { authenticator } = require('otplib');

/**
 * Lot G2 : console du promoteur dans un vrai navigateur, au bureau et au téléphone (données fictives).
 * Le Super Admin crée le groupe et le compte du promoteur ; le promoteur fait sa première connexion (mot de passe,
 * double authentification, codes de récupération), voit sa console, se reconnecte avec un code, puis avec un
 * code de récupération. Base de test seulement.
 */

const url = process.env.DATABASE_ADMIN_URL ?? 'postgresql://erp_owner:erp_owner_dev@localhost:5432/erp_test';
if (!/\/erp_test(\?|$)/.test(url)) throw new Error('Base refusée : erp_test seulement');
const db = new PrismaClient({ datasources: { db: { url } } });
const SHOTS = process.env.E2E_SHOTS;
const MOT_DE_PASSE = 'Console-E2E-2026';

test.afterAll(async () => {
  await db.$disconnect();
});

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png`, fullPage: true });
}

async function nouvellePage(browser: Browser) {
  const ctx = await browser.newContext({ ...test.info().project.use, serviceWorkers: 'block' });
  return ctx.newPage();
}

/** Aucune barre de défilement horizontale (téléphone compris). */
async function largeurOk(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

/** Identifiant et mot de passe ; attend la minute suivante si la limite de 10 connexions par minute est atteinte. */
async function identifiants(page: Page, identifiant: string, motDePasse: string, attendu: RegExp) {
  for (let essai = 0; essai < 3; essai++) {
    await page.goto('/groupe/connexion');
    await page.getByLabel('Téléphone ou e-mail').fill(identifiant);
    await page.getByLabel('Mot de passe').fill(motDePasse);
    await page.getByRole('button', { name: 'Se connecter' }).click();
    const limite = page.getByRole('alert').filter({ hasText: /Too Many Requests|Trop de/ });
    const suite = page.getByRole('heading', { name: attendu });
    await Promise.race([suite.waitFor(), limite.waitFor()]);
    if (await suite.isVisible()) return;
    await page.waitForTimeout(61_000);
  }
  throw new Error('Connexion impossible après 3 essais');
}

test('Super Admin : compte du promoteur ; promoteur : première connexion, console, reconnexion avec un code puis un code de récupération', async ({ browser }, info) => {
  const nom = `Groupe console E2E ${info.project.name} ${Date.now().toString(36)}`;
  const telephone = `01${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

  // 1. Le Super Admin crée le groupe, puis le compte du promoteur (responsable général proposé pour le premier compte).
  const sa = await nouvellePage(browser);
  await sa.goto('/plateforme/connexion');
  await sa.getByLabel('Adresse e-mail').fill(SUPER_ADMIN.email);
  await sa.getByLabel('Mot de passe').fill(SUPER_ADMIN.motDePasse);
  await sa.getByRole('button', { name: 'Se connecter' }).click();
  await sa.waitForURL(/\/plateforme$/);
  await sa.getByRole('group', { name: 'Rubrique' }).getByRole('button', { name: 'Groupes', exact: true }).click();
  await sa.getByRole('button', { name: 'Nouveau groupe' }).click();
  const nouveau = sa.getByRole('dialog');
  await nouveau.getByLabel('Nom du groupe').fill(nom);
  await nouveau.getByLabel('Promoteur').fill('Promoteur FICTIF');
  await nouveau.getByRole('button', { name: 'Créer le groupe' }).click();
  await expect(nouveau).toBeHidden();
  const ligne = sa.locator('tr', { hasText: nom });
  await expect(ligne.getByText('Aucun compte')).toBeVisible();
  await ligne.getByRole('button', { name: `Console du groupe ${nom}` }).click();
  const console_ = sa.getByRole('dialog');
  await expect(console_.getByText('Aucun compte', { exact: true })).toBeVisible();
  await console_.getByRole('button', { name: 'Nouveau compte' }).click();
  await console_.getByLabel('Prénom').fill('Awa');
  await console_.getByLabel('Nom', { exact: true }).fill('Promotrice');
  await console_.getByLabel('Téléphone').fill(telephone);
  await expect(console_.getByLabel('Rôle')).toHaveValue('GENERAL');
  await console_.getByRole('button', { name: 'Créer le compte' }).click();
  const remis = console_.getByRole('status');
  await expect(remis).toContainText('Compte créé : Awa PROMOTRICE');
  const provisoire = (await remis.locator('b.font-mono').textContent())!.trim();
  await expect(console_.getByText('Première connexion à faire')).toBeVisible();
  await shot(sa, 'g2-1-super-admin-compte-cree');
  await sa.context().close();

  // 2. Première connexion du promoteur : trois étapes, aucune console avant la double authentification.
  const p = await nouvellePage(browser);
  await identifiants(p, telephone, provisoire, /Étape 1 sur 3/);
  await p.getByLabel('Nouveau mot de passe').fill(MOT_DE_PASSE);
  await p.getByLabel('Confirmer le mot de passe').fill(MOT_DE_PASSE);
  await p.getByRole('button', { name: 'Enregistrer mon mot de passe' }).click();
  await expect(p.getByRole('heading', { name: /Étape 2 sur 3/ })).toBeVisible();
  await expect(p.getByAltText('QR code de configuration')).toBeVisible();
  await shot(p, 'g2-2-double-authentification');
  // La console reste fermée tant que la double authentification n'est pas activée.
  const avant = await p.request.get('/api/v1/group/auth/me');
  expect(avant.status()).toBe(401);
  const secret = (await p.locator('p.font-mono').filter({ hasText: /^[A-Z2-7]{16,}$/ }).first().textContent())!.trim();
  await p.getByLabel('Code à 6 chiffres').fill(authenticator.generate(secret));
  await p.getByRole('button', { name: 'Activer' }).click();
  await expect(p.getByRole('heading', { name: /Étape 3 sur 3/ })).toBeVisible();
  const codes = (await p.getByTestId('recovery-codes').locator('li').allTextContents()).map((c) => c.trim());
  expect(codes).toHaveLength(10);
  const ouvrir = p.getByRole('button', { name: 'Ouvrir la console' });
  await expect(ouvrir).toBeDisabled();
  await p.getByLabel('J’ai noté ces codes en lieu sûr').check();
  await ouvrir.click();

  // 3. La console : le groupe, ses établissements (aucun ici), ses comptes, son journal ; aucune donnée d'élève.
  await p.waitForURL(/\/groupe$/);
  await expect(p.getByRole('heading', { name: nom })).toBeVisible();
  await expect(p.getByText('Aucun établissement')).toBeVisible();
  await expect(p.getByText(/La console ne montre jamais de liste d’élèves ni de dossier individuel/)).toBeVisible();
  await largeurOk(p);
  await shot(p, 'g2-3-console-vue-d-ensemble');
  const rubrique = p.getByRole('group', { name: 'Rubrique' });
  await rubrique.getByRole('button', { name: 'Comptes', exact: true }).click();
  await expect(p.locator('tr', { hasText: 'Awa PROMOTRICE' }).getByText('vous')).toBeVisible();
  await expect(p.getByRole('button', { name: 'Nouveau compte' })).toBeVisible();
  await largeurOk(p);
  await rubrique.getByRole('button', { name: 'Journal', exact: true }).click();
  await expect(p.getByText('Double authentification activée')).toBeVisible();
  await expect(p.getByText('Connexion', { exact: true }).first()).toBeVisible();
  await rubrique.getByRole('button', { name: 'Mon compte', exact: true }).click();
  await expect(p.getByText(/Codes de récupération encore utilisables/)).toContainText('10');
  await expect(p.getByText('Cet appareil')).toBeVisible();
  await largeurOk(p);
  await shot(p, 'g2-4-mon-compte');
  await p.getByRole('button', { name: 'Se déconnecter' }).click();
  await p.waitForURL(/\/groupe\/connexion$/);
  expect((await p.request.get('/api/v1/group/auth/me')).status()).toBe(401);

  // 4. Reconnexion : le code de l'application est demandé (comme si 30 secondes étaient passées depuis l'activation).
  await db.groupAccount.updateMany({ where: { phone: `+229${telephone}` }, data: { totpLastStep: null } });
  await identifiants(p, telephone, MOT_DE_PASSE, /^Double authentification$/);
  await p.getByLabel('Code', { exact: true }).fill('000000');
  await p.getByRole('button', { name: 'Valider' }).click();
  await expect(p.locator('p[role="alert"]')).toContainText('Code incorrect');
  await p.getByLabel('Code', { exact: true }).fill(authenticator.generate(secret));
  await p.getByRole('button', { name: 'Valider' }).click();
  await p.waitForURL(/\/groupe$/);
  await expect(p.getByRole('heading', { name: nom })).toBeVisible();
  await p.getByRole('button', { name: 'Se déconnecter' }).click();
  await p.waitForURL(/\/groupe\/connexion$/);

  // 5. Téléphone perdu : un code de récupération ouvre la console et propose de configurer le nouveau téléphone.
  await identifiants(p, telephone, MOT_DE_PASSE, /^Double authentification$/);
  await p.getByRole('button', { name: 'Je n’ai plus accès à mon application d’authentification' }).click();
  await p.getByLabel('Code de récupération').fill(codes[0]);
  await p.getByRole('button', { name: 'Valider' }).click();
  await p.waitForURL(/\/groupe\?reconfigurer=1/);
  await expect(p.getByText(/Vous vous êtes connecté avec un code de récupération \(il vous en reste 9\)/)).toBeVisible();
  await p.getByRole('button', { name: 'Configurer mon nouveau téléphone' }).click();
  const nouveauSecret = (await p.locator('p.font-mono').filter({ hasText: /^[A-Z2-7]{16,}$/ }).first().textContent())!.trim();
  expect(nouveauSecret).not.toBe(secret);
  await p.getByLabel('Code à 6 chiffres').fill(authenticator.generate(nouveauSecret));
  await p.getByRole('button', { name: 'Utiliser ce nouveau téléphone' }).click();
  await expect(p.getByText('Nouveaux codes de récupération')).toBeVisible();
  const nouveauxCodes = (await p.getByTestId('recovery-codes').locator('li').allTextContents()).map((c) => c.trim());
  expect(nouveauxCodes).toHaveLength(10);
  expect(nouveauxCodes).not.toContain(codes[1]);
  await largeurOk(p);
  await shot(p, 'g2-5-nouveau-telephone');
  await p.getByLabel('J’ai noté ces codes en lieu sûr').check();
  await p.getByRole('button', { name: 'C’est noté' }).click();
  await expect(p.getByText(/Codes de récupération encore utilisables/)).toContainText('10');
  await p.context().close();
});
