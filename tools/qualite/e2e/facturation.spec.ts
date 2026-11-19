import { expect, Page, test } from '@playwright/test';
import { Prisma, PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { COMPTES } from './comptes';
import { connexion } from './connexion';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { authenticator } = require('otplib');

/**
 * Lot G5a, dans un vrai navigateur, au bureau et au téléphone : « Commercial et facturation » du Super Admin (essai,
 * calendrier, paramètres, conditions, journal) et « Abonnement Cahiora » de la direction (lecture et acceptation des
 * conditions). Base de test seulement ; établissement, conditions et comptes fictifs ; aucun paiement, aucun SMS.
 */
const url = process.env.DATABASE_ADMIN_URL ?? 'postgresql://erp_owner:erp_owner_dev@localhost:5432/erp_test';
if (!/\/erp_test(\?|$)/.test(url)) throw new Error('Base refusée : erp_test seulement');
const db = new PrismaClient({ datasources: { db: { url } } });
const SHOTS = process.env.E2E_SHOTS;
const SA_PW = 'Facturation-E2E-2026';

test.describe.configure({ mode: 'serial' });

let saEmail: string;
let ecole: string;
let titre: string;

test.beforeAll(async ({}, info) => {
  const suffix = info.project.name === 'telephone' ? '2' : '1';
  const stamp = Date.now().toString(36);
  saEmail = `e2e-facturation-${suffix}@test.local`;
  titre = `Conditions fictives E2E ${suffix} ${stamp}`;
  const sa = { name: `Super Admin facturation ${suffix}`, passwordHash: await argon2.hash(SA_PW, { type: argon2.argon2id }), active: true, mustChangePassword: false, mustSetupTwoFactor: false, failedLogins: 0, lockedUntil: null, totpEnabled: false, totpSecret: null, totpLastStep: null };
  const admin = await db.platformAdmin.upsert({ where: { email: saEmail }, update: sa, create: { email: saEmail, ...sa } });
  await db.platformRecoveryCode.deleteMany({ where: { adminId: admin.id } });
  // Un établissement fictif sans abonnement, seul dans son groupe.
  const t = await db.tenant.create({ data: { slug: `e2e-g5a-${suffix}-${stamp}`, name: `École fictive facturation ${suffix} ${stamp}`, group: { create: { name: `Groupe fictif facturation ${suffix} ${stamp}` } } } });
  ecole = t.name;
  // École de démonstration : fin d'essai simulée (on ne peut pas attendre 14 jours dans un test). Base de test seulement.
  const demo = await db.tenant.findUniqueOrThrow({ where: { slug: 'saint-kisito' } });
  const data = { status: 'AWAITING_ACCEPTANCE' as const, statusSince: new Date(), acceptedTermsId: null, acceptedAt: null, acceptedByName: null, acceptedTariff: Prisma.DbNull };
  const old = await db.subscription.findUnique({ where: { tenantId: demo.id } });
  const sub = old
    ? await db.subscription.update({ where: { id: old.id }, data })
    : await db.subscription.create({ data: { tenantId: demo.id, trialStart: new Date(Date.now() - 20 * 86_400_000), trialEnd: new Date(Date.now() - 7 * 86_400_000), trialDays: 14, ...data } });
  await db.subscriptionEvent.create({
    data: { subscriptionId: sub.id, tenantId: demo.id, kind: 'TRIAL_ENDED', fromStatus: 'TRIAL', toStatus: 'AWAITING_ACCEPTANCE', actorKind: 'system', actorName: 'Préparation des tests de navigateur', data: { fixture: true } },
  });
});

test.afterAll(async () => {
  await db.$disconnect();
});

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png`, fullPage: true });
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

test('Super Admin : double authentification, puis essai, calendrier, paramètres datés, conditions et journal', async ({ page }) => {
  await page.goto('/plateforme/connexion');
  await page.getByLabel('Adresse e-mail').fill(saEmail);
  await page.getByLabel('Mot de passe').fill(SA_PW);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  // Double authentification d'abord : la facturation l'exige.
  await page.getByRole('button', { name: 'Configurer' }).click();
  secret = (await page.locator('p.font-mono').filter({ hasText: /^[A-Z2-7]{16,}$/ }).first().textContent())!.trim();
  await page.getByLabel('Code à 6 chiffres').fill(await code(page));
  await page.getByRole('button', { name: 'Activer' }).click();
  await expect(page.getByTestId('recovery-codes')).toBeVisible();
  await page.getByLabel('J’ai noté ces codes en lieu sûr').check();
  await page.getByRole('button', { name: /Accéder aux écoles/ }).click();

  await rubrique(page, 'Rubrique', 'Commercial et facturation');
  await expect(page.getByRole('heading', { name: 'Commercial et facturation' })).toBeVisible();
  for (const nom of ['Vue d’ensemble', 'Abonnements', 'Établissements clients', 'Factures et documents', 'Paiements', 'Avoirs et crédits', 'Prestations complémentaires', 'Parrainage', 'Partenaires et commissions', 'SMS et crédits', 'Rapports financiers', 'Paramètres tarifaires']) {
    await expect(page.getByRole('group', { name: 'Commercial et facturation' }).getByRole('button', { name: nom, exact: true })).toBeVisible();
  }
  await expect(page.getByText('Facturé et encaissé ne se confondent jamais', { exact: false })).toBeVisible();
  await shot(page, '1-vue-ensemble');

  // Paramètres tarifaires : valeurs du cahier des charges, alertes du pilote provisoires ; conditions fictives publiées.
  await rubrique(page, 'Commercial et facturation', 'Paramètres tarifaires');
  const prix = page.locator('tr', { hasText: 'Prix par élève et par année scolaire' });
  await expect(prix).toContainText('500 FCFA');
  await expect(page.locator('tr', { hasText: 'Minimum annuel par établissement' })).toContainText('40 000 FCFA');
  await expect(page.locator('tr', { hasText: 'Première alerte avant la fin d’un pilote' })).toContainText('Provisoire (D-G5-38)');
  await page.getByRole('button', { name: 'Publier une version' }).click();
  const publier = page.getByRole('dialog');
  await publier.getByLabel('Titre').fill(titre);
  await publier.getByLabel('Texte des conditions').fill('Texte fictif publié par les tests de navigateur du lot G5a. Ce ne sont pas les conditions commerciales de Cahiora.');
  await publier.getByLabel('Code de votre application d’authentification').fill(await code(page));
  await publier.getByRole('button', { name: 'Publier' }).click();
  await expect(publier).toBeHidden();
  await expect(page.getByText(titre)).toBeVisible();
  await shot(page, '2-parametres-tarifaires');

  // Abonnements : essai gratuit de l'établissement fictif, avec un code.
  await rubrique(page, 'Commercial et facturation', 'Abonnements');
  const ligne = page.locator('tr', { hasText: ecole });
  await expect(ligne.getByText('Aucun abonnement')).toBeVisible();
  await ligne.getByRole('button', { name: 'Ouvrir l’essai' }).click();
  const essai = page.getByRole('dialog');
  await essai.getByLabel('Code de votre application d’authentification').fill('000000');
  await essai.getByRole('button', { name: 'Ouvrir l’essai' }).click();
  await expect(essai.getByText('Code de votre application incorrect ou expiré')).toBeVisible();
  await essai.getByLabel('Code de votre application d’authentification').fill(await code(page));
  await essai.getByRole('button', { name: 'Ouvrir l’essai' }).click();
  await expect(essai).toBeHidden();
  await expect(ligne.getByText('Essai gratuit', { exact: true })).toBeVisible();
  await expect(ligne.getByText('encore 14 jours')).toBeVisible();
  await ligne.getByRole('button', { name: `Historique de l’abonnement de ${ecole}` }).click();
  await expect(page.getByRole('dialog').getByText('Essai gratuit ouvert')).toBeVisible();
  await shot(page, '3-abonnements-historique');
  await page.keyboard.press('Escape');

  // Établissements clients : un calendrier propre à l'établissement (correction C0 du 19 novembre 2026).
  await rubrique(page, 'Commercial et facturation', 'Établissements clients');
  const ouvrirCalendrier = () => page.getByRole('button', { name: `Calendrier de facturation de ${ecole}` }).click();
  await ouvrirCalendrier();
  const cal = page.getByRole('dialog');
  const enregistrer = cal.getByRole('button', { name: 'Enregistrer cette version' });
  await cal.getByLabel(/^Année scolaire/).fill('2026-2027');
  // Formule B (choisie par défaut) : dates proposées pour toute rentrée et toute fin, recalculées quand l'une change.
  await cal.getByLabel('Début de l’année scolaire').fill('2026-09-14');
  await cal.getByLabel('Fin de l’année scolaire').fill('2027-08-14');
  await expect(cal.getByLabel('Comptage initial')).toHaveValue('2026-11-30');
  await expect(cal.getByLabel('Première régularisation')).toHaveValue('2027-05-31');
  await expect(cal.getByLabel('Régularisation finale')).toHaveValue('2027-08-14');
  await cal.getByLabel('Fin de l’année scolaire').fill('2027-07-09');
  await expect(cal.getByLabel('Première régularisation')).toHaveValue('2027-04-30');
  await expect(cal.getByLabel('Régularisation finale')).toHaveValue('2027-07-09');
  // Année de 6 mois ou moins : la formule ne s'applique pas (décision CAL-1), les dates se saisissent à la main.
  await cal.getByLabel('Début de l’année scolaire').fill('2027-02-01');
  await cal.getByLabel('Fin de l’année scolaire').fill('2027-07-31');
  await expect(cal.getByText('La formule B ne s’applique pas à une année de 6 mois ou moins', { exact: false })).toBeVisible();
  await expect(enregistrer).toBeDisabled();
  await shot(page, '4a-calendrier-annee-courte');
  await cal.getByRole('button', { name: 'Saisir les dates à la main' }).click();
  await expect(cal.getByLabel('Formule des dates proposées')).toHaveValue('MANUEL');
  await expect(enregistrer).toBeEnabled();
  // Retour à la formule B, puis la première régularisation avancée à la main : la version sera « ajustée », avec son motif.
  await cal.getByLabel('Début de l’année scolaire').fill('2026-09-14');
  await cal.getByLabel('Fin de l’année scolaire').fill('2027-07-09');
  await cal.getByLabel('Formule des dates proposées').selectOption('B');
  await expect(cal.getByLabel('Première régularisation')).toHaveValue('2027-04-30');
  await cal.getByLabel('Première régularisation').fill('2027-04-15');
  await expect(cal.getByText('cette version sera enregistrée comme « formule B, ajustée »', { exact: false })).toBeVisible();
  await cal.getByLabel('Motif').fill('Première régularisation avancée avant les congés (test de navigateur)');
  await cal.getByLabel('Code de votre application d’authentification').fill(await code(page));
  await shot(page, '4-calendrier-ajuste');
  await enregistrer.click();
  await expect(cal).toBeHidden();
  // Dans la fiche de cet établissement : d'autres établissements fictifs peuvent avoir le même calendrier.
  const fiche = page.locator('li', { hasText: ecole });
  await expect(fiche.getByText(/2026-2027 \(version 1, formule B, provisoire, ajustée\)/)).toBeVisible();
  await expect(fiche.getByText('Motif de l’ajustement : Première régularisation avancée avant les congés (test de navigateur)')).toBeVisible();

  // Une autre année, aux dates saisies à la main.
  await ouvrirCalendrier();
  await cal.getByLabel(/^Année scolaire/).fill('2027-2028');
  await cal.getByLabel('Formule des dates proposées').selectOption('MANUEL');
  await cal.getByLabel('Début de l’année scolaire').fill('2027-09-13');
  await cal.getByLabel('Fin de l’année scolaire').fill('2028-07-07');
  await cal.getByLabel('Comptage initial').fill('2027-11-30');
  await cal.getByLabel('Première régularisation').fill('2028-04-28');
  await cal.getByLabel('Régularisation finale').fill('2028-07-07');
  await cal.getByLabel('Motif').fill('Calendrier fictif saisi par le test de navigateur');
  await cal.getByLabel('Code de votre application d’authentification').fill(await code(page));
  await enregistrer.click();
  await expect(cal).toBeHidden();
  await expect(fiche.getByText(/2027-2028 \(version 1, dates saisies\)/)).toBeVisible();

  // Journal de la plateforme (rechargé) : l'ouverture de l'essai y figure.
  await page.reload();
  await rubrique(page, 'Rubrique', 'Journal');
  await expect(page.getByText('Facturation : essai gratuit ouvert').first()).toBeVisible();
});

test('Direction : lire et accepter les conditions commerciales à la fin de l’essai ; le tarif du jour est figé', async ({ page }) => {
  await connexion(page, COMPTES.direction);
  await page.goto('/espace/parametres?rubrique=abonnement');
  await expect(page.getByRole('heading', { name: 'Votre abonnement Cahiora' })).toBeVisible();
  await expect(page.getByText('En attente d’acceptation des conditions')).toBeVisible();
  await expect(page.getByText(titre)).toBeVisible();
  const accepter = page.getByRole('button', { name: 'Accepter les conditions' });
  await expect(accepter).toBeDisabled();
  await tientEnLargeur(page);
  await shot(page, '5-direction-conditions');
  await page.getByLabel(/J’ai lu et j’accepte les conditions commerciales de Cahiora/).check();
  await accepter.click();
  await expect(page.getByText('En attente de paiement', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Votre tarif' })).toBeVisible();
  await expect(page.getByText(/500 FCFA/).first()).toBeVisible();
  await expect(page.getByText('Conditions commerciales acceptées par la direction').first()).toBeVisible();
  await tientEnLargeur(page);
  await shot(page, '6-direction-acceptees');
});
