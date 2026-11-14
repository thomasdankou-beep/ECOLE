import { expect, Page, test } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { authenticator } = require('otplib');

/**
 * Lot G5g, dans un vrai navigateur, au bureau et au téléphone : « Prestations complémentaires » du Super Admin
 * (catalogue initial, nouvelle prestation, remise pour un établissement, prix du jour, arrêt d'une règle, version datée,
 * historique). Base de test seulement ; établissement, prestation et comptes fictifs ; le catalogue initial est
 * seulement lu. Aucun devis, aucune facture, aucun paiement, aucun SMS.
 */
const url = process.env.DATABASE_ADMIN_URL ?? 'postgresql://erp_owner:erp_owner_dev@localhost:5432/erp_test';
if (!/\/erp_test(\?|$)/.test(url)) throw new Error('Base refusée : erp_test seulement');
const db = new PrismaClient({ datasources: { db: { url } } });
const SHOTS = process.env.E2E_SHOTS;
const SA_PW = 'Prestations-E2E-2026';
const TZ = 'Africa/Porto-Novo';

test.describe.configure({ mode: 'serial' });

let saEmail: string;
let ecole: { id: string; name: string };
let prestation: string;

test.beforeAll(async ({}, info) => {
  const suffix = info.project.name === 'telephone' ? '2' : '1';
  const stamp = Date.now().toString(36);
  saEmail = `e2e-prestations-${suffix}@test.local`;
  prestation = `Atelier fictif E2E ${suffix} ${stamp}`;
  const sa = { name: `Super Admin prestations ${suffix}`, passwordHash: await argon2.hash(SA_PW, { type: argon2.argon2id }), active: true, mustChangePassword: false, mustSetupTwoFactor: false, failedLogins: 0, lockedUntil: null, totpEnabled: false, totpSecret: null, totpLastStep: null };
  const admin = await db.platformAdmin.upsert({ where: { email: saEmail }, update: sa, create: { email: saEmail, ...sa } });
  await db.platformRecoveryCode.deleteMany({ where: { adminId: admin.id } });
  // Un établissement fictif, seul dans son groupe : la remise de ce test ne vise que lui.
  const t = await db.tenant.create({ data: { slug: `e2e-g5g-${suffix}-${stamp}`, name: `École fictive prestations ${suffix} ${stamp}`, group: { create: { name: `Groupe fictif prestations ${suffix} ${stamp}` } } } });
  ecole = { id: t.id, name: t.name };
});

test.afterAll(async () => {
  await db.$disconnect();
});

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  // Les messages de confirmation s'effacent après quelques secondes : la capture les attend, pour ne rien masquer.
  await expect(page.locator('div.fixed[aria-live="polite"] > *')).toHaveCount(0, { timeout: 8000 });
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png`, fullPage: true });
}

/** Aucun défilement horizontal de la page (téléphone Android d'abord). */
async function tientEnLargeur(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

let secret = '';
/** Code du moment, jamais à moins de 3 secondes de la fin de sa période de 30 secondes. */
async function code(page: Page) {
  const reste = 30_000 - (Date.now() % 30_000);
  if (reste < 3000) await page.waitForTimeout(reste + 200);
  return authenticator.generate(secret) as string;
}

async function rubrique(page: Page, groupe: string, nom: string) {
  await page.getByRole('group', { name: groupe }).getByRole('button', { name: nom, exact: true }).click();
}

/** Jour de la plateforme (Porto-Novo), au format AAAA-MM-JJ, décalé de n jours. */
function jour(n = 0) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  return new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
/** Même format que l'écran : « 14 novembre 2026 ». */
const frDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

test('Super Admin : catalogue initial, nouvelle prestation, remise pour un établissement, prix du jour, arrêt, version datée et historique', async ({ page }) => {
  await page.goto('/plateforme/connexion');
  await page.getByLabel('Adresse e-mail').fill(saEmail);
  await page.getByLabel('Mot de passe').fill(SA_PW);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  // Double authentification d'abord : chaque changement du catalogue demande un code.
  await page.getByRole('button', { name: 'Configurer' }).click();
  secret = (await page.locator('p.font-mono').filter({ hasText: /^[A-Z2-7]{16,}$/ }).first().textContent())!.trim();
  await page.getByLabel('Code à 6 chiffres').fill(await code(page));
  await page.getByRole('button', { name: 'Activer' }).click();
  await expect(page.getByTestId('recovery-codes')).toBeVisible();
  await page.getByLabel('J’ai noté ces codes en lieu sûr').check();
  await page.getByRole('button', { name: /Accéder aux écoles/ }).click();

  // « Tarification et prestations » des paramètres tarifaires mène aux prestations complémentaires.
  await rubrique(page, 'Rubrique', 'Commercial et facturation');
  await rubrique(page, 'Commercial et facturation', 'Paramètres tarifaires');
  await expect(page.getByRole('heading', { name: 'Tarification et prestations' })).toBeVisible();
  await page.getByRole('button', { name: 'Ouvrir les prestations complémentaires' }).click();
  await expect(page.getByRole('heading', { name: 'Catalogue des prestations' })).toBeVisible();

  // Catalogue initial du cahier des charges (§7), lu seulement : prix datés, descriptions à rédiger.
  // Lignes du tableau du catalogue (le premier de la page), pas celles des règles.
  const ligne = (nom: string) => page.locator('table').first().locator('tr', { has: page.getByText(nom, { exact: true }) });
  await expect(ligne('Configuration autonome')).toContainText('Gratuite');
  await expect(ligne('Formation et prise en main')).toContainText('15 000 FCFA');
  await expect(ligne('Paramétrage complet')).toContainText('50 000 FCFA');
  await expect(ligne('Intervention sur site')).toContainText('Sur devis');
  await expect(ligne('Formation et prise en main')).toContainText('Description : INFORMATION MANQUANTE');
  await expect(ligne('Configuration autonome').getByRole('button', { name: 'Remise, tarif particulier ou gratuité pour Configuration autonome' })).toHaveCount(0);
  await tientEnLargeur(page);
  await shot(page, '1-catalogue');

  // Nouvelle prestation fictive à 20 000 FCFA : un code faux est refusé, le bon l'ajoute au catalogue.
  await page.getByRole('button', { name: 'Nouvelle prestation' }).click();
  const creer = page.getByRole('dialog');
  await creer.getByLabel('Nom').fill(prestation);
  await creer.getByLabel('Description').fill('Prestation fictive des tests de navigateur du lot G5g.');
  await creer.getByLabel('Mode de prix').selectOption('FIXED');
  await creer.getByLabel('Prix de départ').fill('20 000');
  await creer.getByLabel('Motif').fill('Prestation fictive créée par le test de navigateur');
  await creer.getByLabel('Code de votre application d’authentification').fill('000000');
  await creer.getByRole('button', { name: 'Ajouter au catalogue' }).click();
  await expect(creer.getByText('Code de votre application incorrect ou expiré')).toBeVisible();
  await creer.getByLabel('Code de votre application d’authentification').fill(await code(page));
  await shot(page, '2-nouvelle-prestation');
  await creer.getByRole('button', { name: 'Ajouter au catalogue' }).click();
  await expect(creer).toBeHidden();
  await expect(ligne(prestation)).toContainText('20 000 FCFA');
  await expect(ligne(prestation)).toContainText('Active');

  // Remise de 10 % pour l'établissement fictif seulement.
  await page.getByRole('button', { name: `Remise, tarif particulier ou gratuité pour ${prestation}` }).click();
  const regle = page.getByRole('dialog');
  await regle.getByRole('combobox', { name: /^Règle/ }).selectOption('DISCOUNT_PERCENT');
  await regle.getByRole('combobox', { name: /^Pour/ }).selectOption(ecole.id);
  await regle.getByRole('textbox', { name: /^Pourcentage/ }).fill('10');
  await regle.getByLabel('Motif').fill('Remise fictive du test de navigateur');
  await regle.getByLabel('Code de votre application d’authentification').fill(await code(page));
  await regle.getByRole('button', { name: 'Enregistrer la règle' }).click();
  await expect(regle).toBeHidden();
  const remise = page.locator('tr', { hasText: ecole.name }).filter({ hasText: 'Remise en pourcentage de 10 %' });
  await expect(remise).toContainText(prestation);
  await expect(remise).toContainText(`du ${frDate(jour())}, sans fin`);
  await expect(remise.getByText('En cours', { exact: true })).toBeVisible();

  // Prix du jour pour cet établissement : 18 000 FCFA, avec la règle appliquée ; simple consultation.
  await page.getByRole('combobox', { name: /^Établissement/ }).selectOption(ecole.id);
  const prix = page.getByRole('list', { name: 'Prix des prestations pour cet établissement' }).locator('li', { hasText: prestation });
  await expect(prix).toContainText('18 000 FCFA');
  await expect(prix).toContainText('Remise pour cet établissement (prix du catalogue : 20 000 FCFA)');
  await expect(page.getByRole('list', { name: 'Prix des prestations pour cet établissement' }).locator('li', { hasText: 'Formation et prise en main' })).toContainText('15 000 FCFA');
  await tientEnLargeur(page);
  await shot(page, '3-remise-et-prix');

  // Arrêter la remise : dernier jour aujourd'hui ; dès demain, le prix du catalogue revient.
  await page.getByRole('button', { name: `Arrêter : Remise en pourcentage de 10 %, ${ecole.name}` }).click();
  const arret = page.getByRole('dialog');
  await expect(arret.getByLabel('Dernier jour d’application')).toHaveValue(jour());
  await arret.getByLabel('Motif').fill('Arrêt fictif du test de navigateur');
  await arret.getByLabel('Code de votre application d’authentification').fill(await code(page));
  await arret.getByRole('button', { name: 'Arrêter la règle' }).click();
  await expect(arret).toBeHidden();
  await expect(remise).toContainText(`du ${frDate(jour())} au ${frDate(jour())}`);
  await expect(page.getByRole('button', { name: `Arrêter : Remise en pourcentage de 10 %, ${ecole.name}` })).toHaveCount(0);
  await page.getByRole('combobox', { name: /^Établissement/ }).selectOption(ecole.id);
  await page.getByLabel(/^Jour/).fill(jour(1));
  await expect(prix).toContainText('20 000 FCFA');
  await expect(prix).toContainText('Prix du catalogue');

  // Version datée : la prestation ne sera plus proposée dans 30 jours ; rien ne change avant.
  await page.getByRole('button', { name: `Modifier ${prestation}` }).click();
  const version = page.getByRole('dialog');
  await version.getByLabel('Proposée aux établissements (active)').uncheck();
  await version.getByLabel('Date d’effet').fill(jour(30));
  await version.getByLabel('Motif').fill('Désactivation fictive du test de navigateur');
  await version.getByLabel('Code de votre application d’authentification').fill(await code(page));
  await version.getByRole('button', { name: 'Enregistrer cette version' }).click();
  await expect(version).toBeHidden();
  await expect(ligne(prestation)).toContainText('Active');
  await expect(ligne(prestation)).toContainText(`Le ${frDate(jour(30))} : désactivée`);

  // Historique : tout reste, avec l'auteur et le motif.
  await page.getByRole('button', { name: `Historique de ${prestation}` }).click();
  const histo = page.getByRole('dialog');
  for (const titre of ['Prestation créée', 'Version 2', 'Prix du catalogue · tous les établissements', `Remise en pourcentage · ${ecole.name}`, `Règle arrêtée · ${ecole.name}`]) {
    await expect(histo.getByText(titre, { exact: true })).toBeVisible();
  }
  await expect(histo.getByText('Motif : Arrêt fictif du test de navigateur')).toBeVisible();
  await expect(histo.getByText(/Super Admin prestations/).first()).toBeVisible();
  await shot(page, '4-historique');
  await page.keyboard.press('Escape');

  // Journal de la plateforme (rechargé) : la création de la prestation y figure.
  await page.reload();
  await rubrique(page, 'Rubrique', 'Journal');
  await expect(page.getByText('Prestations : nouvelle prestation').first()).toBeVisible();
});
