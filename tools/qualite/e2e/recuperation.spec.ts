import { Browser, expect, Page, test } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { COMPTES, MOT_DE_PASSE } from './comptes';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { authenticator } = require('otplib');

/**
 * Récupération sécurisée des comptes 2FA, dans un vrai navigateur, au bureau et au téléphone :
 * codes de récupération, connexion avec un code, nouveau téléphone, demande et validation par la direction,
 * code de réactivation et nouvelle double authentification obligatoire. Base de test seulement.
 */
const url = process.env.DATABASE_ADMIN_URL ?? 'postgresql://erp_owner:erp_owner_dev@localhost:5432/erp_test';
if (!/\/erp_test(\?|$)/.test(url)) throw new Error('Base refusée : erp_test seulement');
const db = new PrismaClient({ datasources: { db: { url } } });
const SHOTS = process.env.E2E_SHOTS;

test.describe.configure({ mode: 'serial' });

let comptable: string;
let direction2: string;
let saEmail: string;
let nom: string;
const SA_PW = 'Recuperation-E2E-2026';

test.beforeAll(async ({}, info) => {
  const suffix = info.project.name === 'telephone' ? '2' : '1';
  comptable = `+22901900097${suffix}1`;
  direction2 = `+22901900097${suffix}2`;
  saEmail = `e2e-recup-${suffix}@test.local`;
  nom = `COMPTA E2E${suffix}`;
  const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: 'saint-kisito' } });
  const hash = await argon2.hash(MOT_DE_PASSE, { type: argon2.argon2id });
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;
    for (const [phone, role, last] of [[comptable, 'COMPTABLE', 'COMPTA'], [direction2, 'DIRECTION', 'DIRECTRICE']] as const) {
      const data = { passwordHash: hash, mustChangePassword: false, failedLogins: 0, lockedUntil: null, status: 'ACTIVE' as const, totpEnabled: false, totpSecret: null, totpLastStep: null, twoFactorReenroll: false };
      const existing = await tx.user.findFirst({ where: { phone } });
      const user = existing ? await tx.user.update({ where: { id: existing.id }, data }) : await tx.user.create({ data: { tenantId: tenant.id, firstName: 'Fictif', lastName: `${last} E2E${suffix}`, phone, ...data } });
      await tx.recoveryCode.deleteMany({ where: { userId: user.id } });
      await tx.twoFactorRecoveryRequest.updateMany({ where: { userId: user.id, status: { in: ['PENDING', 'APPROVED'] } }, data: { status: 'CANCELLED' } });
      await tx.userRole.deleteMany({ where: { userId: user.id } });
      await tx.userRole.create({ data: { tenantId: tenant.id, userId: user.id, role } });
    }
  });
  const sa = { name: `Super Admin récupération ${suffix}`, passwordHash: await argon2.hash(SA_PW, { type: argon2.argon2id }), active: true, mustChangePassword: false, mustSetupTwoFactor: false, failedLogins: 0, lockedUntil: null, totpEnabled: false, totpSecret: null, totpLastStep: null };
  const admin = await db.platformAdmin.upsert({ where: { email: saEmail }, update: sa, create: { email: saEmail, ...sa } });
  await db.platformRecoveryCode.deleteMany({ where: { adminId: admin.id } });
});

test.afterAll(async () => {
  await db.$disconnect();
});

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png`, fullPage: true });
}

/** Connexion jusqu'à l'étape suivant le mot de passe ; attend la minute suivante si la limite de 10 connexions est atteinte. */
async function motDePasse(page: Page, identifiant: string, attendu: RegExp) {
  for (let essai = 0; essai < 3; essai++) {
    await page.goto('/connexion');
    await page.getByLabel('Téléphone, e-mail ou matricule').fill(identifiant);
    await page.getByLabel('Mot de passe', { exact: true }).fill(MOT_DE_PASSE);
    await page.getByRole('button', { name: 'Se connecter' }).click();
    const limite = page.locator('p[role="alert"]').filter({ hasText: /Too Many Requests|Trop de/ });
    const suite = page.getByRole('heading', { name: attendu });
    await Promise.race([suite.waitFor(), page.waitForURL((u) => u.pathname.startsWith('/espace')), limite.waitFor()]);
    if (!(await limite.isVisible().catch(() => false))) return;
    await page.waitForTimeout(61_000);
  }
  throw new Error('Connexion impossible après 3 essais');
}


/** Valide le formulaire ; si la limite d'essais par minute de l'API est atteinte (elle fonctionne), attend et recommence. */
async function valider(page: Page, nom = 'Valider') {
  for (let essai = 0; essai < 3; essai++) {
    await page.getByRole('button', { name: nom }).click();
    const limite = page.locator('p[role="alert"]').filter({ hasText: /Too Many Requests|Trop de/ });
    await page.waitForLoadState('networkidle');
    if (!(await limite.isVisible().catch(() => false))) return;
    await page.waitForTimeout(61_000);
  }
}

async function nouvellePage(browser: Browser, info = test.info()) {
  const ctx = await browser.newContext({ ...info.project.use, serviceWorkers: 'block' });
  return ctx.newPage();
}

/** Lit le secret affiché sous le QR code et saisit le code du moment. */
async function scanner(page: Page) {
  const secret = (await page.locator('p.font-mono').filter({ hasText: /^[A-Z2-7]{16,}$/ }).first().textContent())!.trim();
  await page.getByLabel('Code à 6 chiffres').fill(authenticator.generate(secret));
  return secret;
}

async function lireCodes(page: Page) {
  const panel = page.getByTestId('recovery-codes');
  await expect(panel).toBeVisible();
  const codes = (await panel.locator('li').allTextContents()).map((c) => c.trim());
  expect(codes).toHaveLength(10);
  for (const c of codes) expect(c).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  return codes;
}

async function noterCodes(page: Page, bouton: RegExp) {
  const continuer = page.getByRole('button', { name: bouton });
  await expect(continuer).toBeDisabled();
  await page.getByLabel('J’ai noté ces codes en lieu sûr').check();
  await continuer.click();
}

test('codes de récupération, connexion avec un code, puis récupération validée par la direction', async ({ browser }) => {
  // 1. Activation de Google Authenticator : 10 codes affichés une fois.
  const p1 = await nouvellePage(browser);
  await motDePasse(p1, comptable, /Tableau|Accueil|Finances/);
  await p1.goto('/espace/compte');
  await p1.getByRole('button', { name: 'Configurer' }).click();
  await scanner(p1);
  await p1.getByRole('button', { name: 'Activer' }).click();
  const codes = await lireCodes(p1);
  await shot(p1, '1-codes-affiches');
  await noterCodes(p1, /C’est noté/);
  await expect(p1.getByText('10 sur 10 encore utilisables')).toBeVisible();
  await p1.context().close();

  // 2. Téléphone perdu : connexion avec un code de récupération, puis nouveau téléphone.
  const p2 = await nouvellePage(browser);
  await motDePasse(p2, comptable, /Code de sécurité/);
  await p2.getByRole('button', { name: 'Je n’ai plus accès à mon application d’authentification' }).click();
  await expect(p2.getByRole('heading', { name: 'Code de récupération' })).toBeVisible();
  await shot(p2, '2-saisie-code-recuperation');
  await p2.getByLabel('Code de récupération').fill(codes[0].toLowerCase());
  await valider(p2);
  await p2.waitForURL(/\/espace\/compte\?reconfigurer=1/);
  await expect(p2.getByText(/il vous en reste 9/)).toBeVisible();
  await p2.getByRole('button', { name: 'Configurer mon nouveau téléphone' }).click();
  await scanner(p2);
  await p2.getByRole('button', { name: 'Utiliser ce nouveau téléphone' }).click();
  const codes2 = await lireCodes(p2);
  expect(codes2.some((c) => codes.includes(c))).toBe(false);
  await noterCodes(p2, /C’est noté/);
  await p2.context().close();

  // 3. Le même code ne sert plus.
  const p3 = await nouvellePage(browser);
  await motDePasse(p3, comptable, /Code de sécurité/);
  await p3.getByRole('button', { name: 'Je n’ai plus accès à mon application d’authentification' }).click();
  await p3.getByLabel('Code de récupération').fill(codes[1]);
  await valider(p3);
  await expect(p3.locator('p[role="alert"]')).toContainText(/incorrect ou déjà utilisé/);
  await expect(p3.getByText('Téléphone et codes perdus ?')).toBeVisible();
  await shot(p3, '3-code-refuse');
  await p3.context().close();

  // 4. Téléphone et codes perdus : la direction ouvre la demande, une autre direction la valide.
  const d1 = await nouvellePage(browser);
  await motDePasse(d1, COMPTES.direction, /Tableau/);
  await d1.goto('/espace/recuperation');
  const option = d1.getByLabel('Compte concerné').locator('option', { hasText: nom });
  await d1.getByLabel('Compte concerné').selectOption({ value: (await option.first().getAttribute('value'))! });
  await d1.getByLabel('Vérification d’identité réalisée').selectOption('PIECE_IDENTITE');
  await d1.getByLabel('Précision sur la vérification').fill('CNI vue au bureau (test)');
  await d1.getByLabel('Motif').fill('Téléphone volé, codes perdus (test automatique)');
  await d1.getByRole('button', { name: 'Créer la demande' }).click();
  const carte = d1.getByTestId('recovery-request').filter({ hasText: nom }).filter({ hasText: 'En attente de validation' });
  await expect(carte).toBeVisible();
  // Le demandeur ne peut pas valider sa propre demande.
  await expect(carte.getByRole('button', { name: 'Valider' })).toHaveCount(0);
  await shot(d1, '4-demande-creee');
  await d1.context().close();

  const d2 = await nouvellePage(browser);
  await motDePasse(d2, direction2, /Tableau/);
  await d2.goto('/espace/recuperation');
  const aValider = d2.getByTestId('recovery-request').filter({ hasText: nom }).filter({ hasText: 'En attente de validation' });
  await aValider.getByRole('button', { name: 'Valider' }).click();
  await d2.getByLabel('Justification (vérification faite)').fill('Identité vérifiée');
  await d2.getByRole('button', { name: 'Valider et afficher le code' }).click();
  const zone = d2.getByTestId('activation-code');
  await expect(zone).toBeVisible();
  const activation = (await zone.locator('p').first().textContent())!.trim();
  expect(activation).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  await shot(d2, '5-code-reactivation');
  await d2.getByRole('button', { name: 'J’ai remis le code' }).click();
  await d2.context().close();

  // 5. Réactivation obligatoire : code remis en main propre, nouveau téléphone, nouveaux codes, puis l'espace.
  const p4 = await nouvellePage(browser);
  await motDePasse(p4, comptable, /Réactiver la double authentification/);
  await shot(p4, '6-saisie-code-reactivation');
  await p4.getByLabel('Code de réactivation').fill('AAAA-BBBB');
  await valider(p4);
  await expect(p4.locator('p[role="alert"]')).toContainText(/incorrect ou expiré/);
  await p4.getByLabel('Code de réactivation').fill(activation);
  await valider(p4);
  await expect(p4.getByRole('heading', { name: 'Nouveau téléphone' })).toBeVisible();
  await shot(p4, '7-nouveau-telephone');
  await scanner(p4);
  await p4.getByRole('button', { name: 'Activer sur ce téléphone' }).click();
  await lireCodes(p4);
  await shot(p4, '8-nouveaux-codes');
  await noterCodes(p4, /Accéder à mon espace/);
  await p4.waitForURL((u) => u.pathname === '/espace');
  await p4.context().close();
});

test('Super Admin : codes de récupération et connexion avec un code', async ({ browser }) => {
  const p = await nouvellePage(browser);
  await p.goto('/plateforme/connexion');
  await p.getByLabel('Adresse e-mail').fill(saEmail);
  await p.getByLabel('Mot de passe').fill(SA_PW);
  await p.getByRole('button', { name: 'Se connecter' }).click();
  await p.getByRole('button', { name: 'Configurer' }).click();
  await scanner(p);
  await p.getByRole('button', { name: 'Activer' }).click();
  const codes = await lireCodes(p);
  await noterCodes(p, /Accéder aux écoles/);
  await expect(p.getByText('Codes de récupération : 10 sur 10')).toBeVisible();
  await p.context().close();

  const q = await nouvellePage(browser);
  await q.goto('/plateforme/connexion');
  await q.getByLabel('Adresse e-mail').fill(saEmail);
  await q.getByLabel('Mot de passe').fill(SA_PW);
  await q.getByRole('button', { name: 'Se connecter' }).click();
  await q.getByRole('button', { name: 'Je n’ai plus accès à mon application d’authentification' }).click();
  await q.getByLabel('Code de récupération').fill(codes[3]);
  await valider(q);
  await expect(q.getByText(/il vous en reste 9/)).toBeVisible();
  await shot(q, '9-super-admin-code-utilise');
  await q.getByRole('button', { name: 'Configurer mon nouveau téléphone' }).click();
  await scanner(q);
  await q.getByRole('button', { name: 'Utiliser ce nouveau téléphone' }).click();
  await lireCodes(q);
  await q.context().close();
});
