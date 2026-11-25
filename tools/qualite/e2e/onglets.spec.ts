import { expect, Page, test } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { COMPTES } from './comptes';
import { connexion } from './connexion';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { authenticator } = require('otplib');

/**
 * Précision de Dankou du 24 novembre 2026 : « Vérifier l'affichage des onglets sur ordinateur, tablette et téléphone ».
 * Les rangées d'onglets les plus longues, à quatre largeurs (ordinateur 1366 px, tablette en paysage 1024 px et en
 * portrait 768 px, téléphone 412 px) : rubriques du Super Admin, « Commercial et facturation » (13 onglets) et
 * « Paramètres » de la direction de l'école de démonstration (client réel dans la base de test, donc avec « Effectifs
 * facturables »). À chaque largeur : la page ne défile jamais en largeur ; dès la tablette, tous les onglets sont visibles
 * d'un coup, sur une ou plusieurs lignes ; au téléphone, la rangée glisse et chaque onglet choisi se lit en entier.
 * Une seule fois, dans le projet « bureau » : l'essai pose lui-même chaque largeur. Base de test seulement, aucun SMS.
 */
const url = process.env.DATABASE_ADMIN_URL ?? 'postgresql://erp_owner:erp_owner_dev@localhost:5432/erp_test';
if (!/\/erp_test(\?|$)/.test(url)) throw new Error('Base refusée : erp_test seulement');
const db = new PrismaClient({ datasources: { db: { url } } });
const SHOTS = process.env.E2E_SHOTS;
const SA_EMAIL = 'e2e-onglets@test.local';
const SA_PW = 'Onglets-E2E-2026';

test.describe.configure({ mode: 'serial' });
// Captures pour le rapport seulement (E2E_SHOTS) : images nettes.
if (SHOTS) test.use({ deviceScaleFactor: 2 });

const LARGEURS = [
  { nom: 'ordinateur', width: 1366, height: 768 },
  { nom: 'tablette-paysage', width: 1024, height: 768 },
  { nom: 'tablette-portrait', width: 768, height: 1024 },
  { nom: 'telephone', width: 412, height: 915 },
] as const;

const RUBRIQUES = ['Écoles', 'Groupes', 'Commercial et facturation', 'Récupération des comptes', 'Journal'];
const FACTURATION = ['Vue d’ensemble', 'Abonnements', 'Accès des clients', 'Établissements clients', 'Factures et documents', 'Paiements', 'Avoirs et crédits',
  'Prestations complémentaires', 'Parrainage', 'Partenaires et commissions', 'SMS et crédits', 'Rapports financiers', 'Paramètres tarifaires'];
const PARAMETRES = ['Établissement', 'Logo et site public', 'Élèves à l’honneur', 'Classes et matières', 'Coefficients', 'Sites, salles, matières', 'Année et périodes',
  'Mentions et règles', 'Abonnement Cahiora', 'Effectifs facturables'];

test.beforeAll(async () => {
  const sa = { name: 'Super Admin onglets', passwordHash: await argon2.hash(SA_PW, { type: argon2.argon2id }), active: true, mustChangePassword: false, mustSetupTwoFactor: false, failedLogins: 0, lockedUntil: null, totpEnabled: false, totpSecret: null, totpLastStep: null };
  const admin = await db.platformAdmin.upsert({ where: { email: SA_EMAIL }, update: sa, create: { email: SA_EMAIL, ...sa } });
  await db.platformRecoveryCode.deleteMany({ where: { adminId: admin.id } });
});

test.afterAll(async () => {
  await db.$disconnect();
});

/** Aucun défilement horizontal de la page. */
async function tientEnLargeur(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

/**
 * Chaque onglet de la rangée : choisi, il est entier dans sa rangée et dans l'écran. Dès 768 px, la rangée ne glisse
 * pas : tous ses onglets sont visibles d'un coup.
 */
async function rangee(page: Page, groupe: string, noms: string[], large: boolean, apres?: (nom: string) => Promise<void>) {
  const box = page.getByRole('group', { name: groupe, exact: true });
  await expect(box).toBeVisible();
  if (large) expect(await box.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  for (const nom of noms) {
    const onglet = box.getByRole('button', { name: nom, exact: true });
    await onglet.click();
    await expect(onglet).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => onglet.evaluate((el) => {
      const r = el.parentElement!.getBoundingClientRect();
      const c = el.getBoundingClientRect();
      return c.left >= r.left - 1 && c.right <= r.right + 1 && c.left >= -1 && c.right <= window.innerWidth + 1;
    })).toBe(true);
    await tientEnLargeur(page);
    if (apres) await apres(nom);
  }
}

async function capture(page: Page, nom: string) {
  if (!SHOTS) return;
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${SHOTS}/onglets-${nom}.png`, animations: 'disabled' });
}

test('Super Admin : rubriques et « Commercial et facturation », de l’ordinateur au téléphone', async ({ page }, info) => {
  test.skip(info.project.name !== 'bureau', 'les largeurs sont posées par l’essai');
  await page.goto('/plateforme/connexion');
  await page.getByLabel('Adresse e-mail').fill(SA_EMAIL);
  await page.getByLabel('Mot de passe').fill(SA_PW);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  // « Commercial et facturation » demande la double authentification.
  await page.getByRole('button', { name: 'Configurer' }).click();
  const secret = (await page.locator('p.font-mono').filter({ hasText: /^[A-Z2-7]{16,}$/ }).first().textContent())!.trim();
  const reste = 30_000 - (Date.now() % 30_000);
  if (reste < 3000) await page.waitForTimeout(reste + 200);
  await page.getByLabel('Code à 6 chiffres').fill(authenticator.generate(secret));
  await page.getByRole('button', { name: 'Activer' }).click();
  await expect(page.getByTestId('recovery-codes')).toBeVisible();
  await page.getByLabel('J’ai noté ces codes en lieu sûr').check();
  await page.getByRole('button', { name: /Accéder aux écoles/ }).click();

  for (const l of LARGEURS) {
    await page.setViewportSize({ width: l.width, height: l.height });
    const large = l.width >= 768;
    await rangee(page, 'Rubrique', RUBRIQUES, large);
    await page.getByRole('group', { name: 'Rubrique', exact: true }).getByRole('button', { name: 'Commercial et facturation', exact: true }).click();
    await rangee(page, 'Commercial et facturation', FACTURATION, large);
    // Retour au premier onglet pour la capture : la rangée revient à son début.
    await page.getByRole('group', { name: 'Commercial et facturation', exact: true }).getByRole('button', { name: 'Vue d’ensemble', exact: true }).click();
    await capture(page, `${l.nom}-console`);
  }
});

test('Direction : onglets des paramètres, de l’ordinateur au téléphone', async ({ page }, info) => {
  test.skip(info.project.name !== 'bureau', 'les largeurs sont posées par l’essai');
  await connexion(page, COMPTES.direction);
  await page.goto('/espace/parametres');
  for (const l of LARGEURS) {
    await page.setViewportSize({ width: l.width, height: l.height });
    await rangee(page, 'Rubrique', PARAMETRES, l.width >= 768);
    await page.getByRole('group', { name: 'Rubrique', exact: true }).getByRole('button', { name: 'Abonnement Cahiora', exact: true }).click();
    await capture(page, `${l.nom}-parametres`);
  }
});
