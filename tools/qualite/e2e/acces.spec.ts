import { expect, Page, test } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { authenticator } = require('otplib');

/**
 * Lot G5d-1, dans un vrai navigateur, au bureau et au téléphone : accès selon le paiement de l'abonnement, décisions de
 * Dankou du 19 novembre 2026 (D-G5-30 A, D-G5-42 A, D-G5-43 A). Deux établissements fictifs, chacun à sa propre adresse
 * locale (« <nom>.localhost », champ domaine de l'établissement) :
 * - « délai de grâce » : essai terminé il y a 3 jours, accès complet encore 13 jours. Alerte à la connexion de la
 *   direction (sans couvrir la page), carte du tableau de bord, bandeau et compteur sur les autres pages, bouton
 *   « Régulariser mon abonnement », demande de régularisation ;
 * - « accès limité » : délai passé depuis 24 jours. Bandeau pour tout le personnel, saisie refusée avec son motif,
 *   consultation et régularisation ouvertes ;
 * puis le Super Admin répond à la demande et prolonge l'accès de l'établissement limité (avec un code), et chaque
 * direction lit le résultat. Lectures 7 A et 9 A, validées par Dankou le 20 novembre 2026, avec un troisième
 * établissement « préavis » (délai de grâce qui finit aujourd'hui, demande en attente) : le Super Admin lit le jour et
 * l'heure de la limitation avant de répondre, la réponse ouvre un préavis de 48 heures que la direction lit avec les
 * heures restantes ; le renouvellement exceptionnel d'une prolongation demande son propre motif et reste marqué.
 * Base de test seulement : abonnements fictifs posés dans la base, aucun paiement, aucun SMS.
 */
const url = process.env.DATABASE_ADMIN_URL ?? 'postgresql://erp_owner:erp_owner_dev@localhost:5432/erp_test';
if (!/\/erp_test(\?|$)/.test(url)) throw new Error('Base refusée : erp_test seulement');
const db = new PrismaClient({ datasources: { db: { url } } });
const SHOTS = process.env.E2E_SHOTS;
const SA_PW = 'Acces-E2E-2026';
const PW = 'Acces-Direction-E2E-2026';
const TZ = 'Africa/Porto-Novo';
const MESSAGE = 'Paiement prévu par Mobile Money la semaine prochaine (test de navigateur)';
const REPONSE = 'Bonjour, Cahiora vous enverra les instructions de paiement dès que les moyens de paiement seront activés (test de navigateur).';
const MOTIF = 'Paiement partiel reçu, solde promis par écrit (test de navigateur)';
const LIMITED_STAFF = 'L’abonnement Cahiora de l’établissement n’est pas régularisé : consultation, impression, export, caisse et régularisation restent possibles, et aucune donnée n’est supprimée.';
const LIMITED_REFUSAL = 'Accès limité : l’abonnement Cahiora de l’établissement n’est pas régularisé. Consultation, impression, export, caisse et régularisation restent possibles, et aucune donnée n’est supprimée.';
const AFTER = 'Ensuite, sans paiement validé, l’accès sera limité : consultation, impression, export, caisse et régularisation resteront possibles, et aucune donnée ne sera supprimée.';
const MESSAGE_PREAVIS = 'Le virement fictif part demain matin (test de navigateur du préavis)';
const MOTIF_RENOUVELLEMENT = 'Second versement promis pour la fin du mois, confirmé par écrit (test de navigateur)';

test.describe.configure({ mode: 'serial' });

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** Jour de Porto-Novo (plateforme et établissements fictifs), au format AAAA-MM-JJ. */
const localDay = (at = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
/** Même format que l'écran : « 14 novembre 2026 ». */
const frDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
/** Même format que les textes du serveur : « 1er décembre 2026 », puis « 3 décembre 2026 à 14 h 05 » à l'heure de Porto-Novo. */
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const frJour = (d: string) => {
  const [y, m, j] = d.split('-').map(Number);
  return `${j === 1 ? '1er' : j} ${MOIS[m - 1]} ${y}`;
};
const frHeure = (t: Date) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(t).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  return `${frJour(`${p.year}-${p.month}-${p.day}`)} à ${Number(p.hour)} h ${p.minute}`;
};
const at = (d: string) => new Date(`${d}T08:00:00Z`);

type Ecole = { id: string; name: string; domain: string; direction: string; comptable: string };
let T0 = '';
let saEmail = '';
let saName = '';
const G: Ecole = { id: '', name: '', domain: '', direction: '', comptable: '' };
const L: Ecole = { id: '', name: '', domain: '', direction: '', comptable: '' };
const N: Ecole = { id: '', name: '', domain: '', direction: '', comptable: '' };

/** Établissement fictif seul dans son groupe, à sa propre adresse locale, avec sa direction, une comptable et une année en cours. */
async function ecole(e: Ecole, slug: string, name: string, phones: [string, string]) {
  const t = await db.tenant.create({ data: { slug, name, timezone: TZ, domain: `${slug}.localhost`, group: { create: { name: `Groupe ${name}` } } } });
  Object.assign(e, { id: t.id, name: t.name, domain: t.domain, direction: phones[0], comptable: phones[1] });
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${t.id}, true)`;
    for (const [phone, role, last] of [[phones[0], 'DIRECTION', 'DIRECTION'], [phones[1], 'COMPTABLE', 'COMPTABLE']] as const) {
      const user = await tx.user.create({ data: { tenantId: t.id, phone, firstName: 'Fictive', lastName: `${last} ${name}`, passwordHash: hash, mustChangePassword: false } });
      await tx.userRole.create({ data: { tenantId: t.id, userId: user.id, role } });
    }
    const y = Number(T0.slice(0, 4)) - (T0.slice(5, 7) < '09' ? 1 : 0);
    await tx.academicYear.create({ data: { tenantId: t.id, label: `${y}-${y + 1}`, startDate: new Date(`${y}-09-14T00:00:00Z`), endDate: new Date(`${y + 1}-07-09T00:00:00Z`), isCurrent: true } });
  });
  return t;
}

test.beforeAll(async ({}, info) => {
  const suffix = info.project.name === 'telephone' ? '2' : '1';
  const stamp = Date.now().toString(36);
  T0 = localDay();
  saEmail = `e2e-acces-${suffix}@test.local`;
  saName = `Super Admin accès ${suffix}`;
  const sa = { name: saName, passwordHash: await argon2.hash(SA_PW, { type: argon2.argon2id }), active: true, mustChangePassword: false, mustSetupTwoFactor: false, failedLogins: 0, lockedUntil: null, totpEnabled: false, totpSecret: null, totpLastStep: null };
  const admin = await db.platformAdmin.upsert({ where: { email: saEmail }, update: sa, create: { email: saEmail, ...sa } });
  await db.platformRecoveryCode.deleteMany({ where: { adminId: admin.id } });

  // Délai de grâce : essai de 14 jours terminé il y a 3 jours, grâce de 15 jours (du lendemain au 15e jour).
  const g = await ecole(G, `e2e-g5d-grace-${suffix}-${stamp}`, `École fictive grâce ${suffix} ${stamp}`, [`+22901900083${suffix}1`, `+22901900083${suffix}2`]);
  const gEnd = addDays(T0, -3);
  const gs = await db.subscription.create({
    data: {
      tenantId: g.id, status: 'AWAITING_ACCEPTANCE', statusSince: at(addDays(gEnd, 1)), trialStart: new Date(addDays(gEnd, -13)), trialEnd: new Date(gEnd), trialDays: 14,
      graceStart: new Date(addDays(gEnd, 1)), graceEnd: new Date(addDays(gEnd, 15)),
    },
  });
  await db.subscriptionEvent.create({
    data: {
      subscriptionId: gs.id, tenantId: g.id, kind: 'TRIAL_ENDED', fromStatus: 'TRIAL', toStatus: 'AWAITING_ACCEPTANCE', actorKind: 'system', actorName: 'Préparation des tests de navigateur',
      data: { fixture: true, lastFreeDay: gEnd, graceDays: 15, graceStart: addDays(gEnd, 1), graceEnd: addDays(gEnd, 15) }, createdAt: at(addDays(gEnd, 1)),
    },
  });

  // Accès limité : essai terminé il y a 40 jours, grâce finie il y a 25 jours, limité le lendemain ; conditions jamais acceptées.
  const l = await ecole(L, `e2e-g5d-limite-${suffix}-${stamp}`, `École fictive limitée ${suffix} ${stamp}`, [`+22901900084${suffix}1`, `+22901900084${suffix}2`]);
  const lEnd = addDays(T0, -40);
  const limited = at(addDays(lEnd, 16));
  const ls = await db.subscription.create({
    data: {
      tenantId: l.id, status: 'LIMITED', statusSince: limited, limitedSince: limited, trialStart: new Date(addDays(lEnd, -13)), trialEnd: new Date(lEnd), trialDays: 14,
      graceStart: new Date(addDays(lEnd, 1)), graceEnd: new Date(addDays(lEnd, 15)),
    },
  });
  await db.subscriptionEvent.createMany({
    data: [
      {
        subscriptionId: ls.id, tenantId: l.id, kind: 'TRIAL_ENDED', fromStatus: 'TRIAL', toStatus: 'AWAITING_ACCEPTANCE', actorKind: 'system', actorName: 'Préparation des tests de navigateur',
        data: { fixture: true, lastFreeDay: lEnd, graceDays: 15, graceStart: addDays(lEnd, 1), graceEnd: addDays(lEnd, 15) }, createdAt: at(addDays(lEnd, 1)),
      },
      {
        subscriptionId: ls.id, tenantId: l.id, kind: 'ACCESS_LIMITED', fromStatus: 'AWAITING_ACCEPTANCE', toStatus: 'LIMITED', actorKind: 'system', actorName: 'Préparation des tests de navigateur',
        data: { fixture: true, lastFullAccessDay: addDays(lEnd, 15), graceEnd: addDays(lEnd, 15), extendedUntil: null }, createdAt: limited,
      },
    ],
  });

  // Préavis (lecture 7 A) : essai terminé il y a 15 jours, délai de grâce qui finit aujourd'hui, demande en attente.
  const n = await ecole(N, `e2e-g5d-preavis-${suffix}-${stamp}`, `École fictive préavis ${suffix} ${stamp}`, [`+22901900085${suffix}1`, `+22901900085${suffix}2`]);
  const nEnd = addDays(T0, -15);
  const ns = await db.subscription.create({
    data: {
      tenantId: n.id, status: 'AWAITING_ACCEPTANCE', statusSince: at(addDays(nEnd, 1)), trialStart: new Date(addDays(nEnd, -13)), trialEnd: new Date(nEnd), trialDays: 14,
      graceStart: new Date(addDays(nEnd, 1)), graceEnd: new Date(T0),
    },
  });
  await db.subscriptionEvent.create({
    data: {
      subscriptionId: ns.id, tenantId: n.id, kind: 'TRIAL_ENDED', fromStatus: 'TRIAL', toStatus: 'AWAITING_ACCEPTANCE', actorKind: 'system', actorName: 'Préparation des tests de navigateur',
      data: { fixture: true, lastFreeDay: nEnd, graceDays: 15, graceStart: addDays(nEnd, 1), graceEnd: T0 }, createdAt: at(addDays(nEnd, 1)),
    },
  });
  await db.regularizationRequest.create({
    data: { tenantId: n.id, subscriptionId: ns.id, status: 'PENDING', subscriptionStatus: 'AWAITING_ACCEPTANCE', message: MESSAGE_PREAVIS, requestedByName: `Fictive DIRECTION ${n.name}` },
  });
});

test.afterAll(async () => {
  await db.$disconnect();
});

async function shot(page: Page, name: string, toasts = false) {
  if (!SHOTS) return;
  // Les messages de confirmation s'effacent après quelques secondes : la capture les attend, sauf quand ils sont le sujet.
  if (!toasts) await expect(page.locator('div.fixed[aria-live="polite"] > *')).toHaveCount(0, { timeout: 8000 });
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png`, fullPage: true, animations: 'disabled' });
}

/** Aucun défilement horizontal de la page (téléphone Android d'abord). */
async function tientEnLargeur(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

let secret = '';
/**
 * Code de l'application d'authentification, assez loin de la fin de sa fenêtre de 30 secondes pour être encore bon
 * à l'envoi. Avec les captures, la marge couvre leur attente de la fin des messages (jusqu'à 8 secondes).
 */
async function code(page: Page) {
  const marge = SHOTS ? 12_000 : 3000;
  const reste = 30_000 - (Date.now() % 30_000);
  if (reste < marge) await page.waitForTimeout(reste + 200);
  return authenticator.generate(secret) as string;
}

/** Nouvelle connexion du Super Admin, double authentification déjà active : un code d'une fenêtre pas encore utilisée. */
async function connexionPlateforme(page: Page) {
  await page.goto('/plateforme/connexion');
  await page.getByLabel('Adresse e-mail').fill(saEmail);
  await page.getByLabel('Mot de passe').fill(SA_PW);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  const champ = page.getByLabel('Code', { exact: true });
  await expect(champ).toBeVisible();
  const last = (await db.platformAdmin.findUniqueOrThrow({ where: { email: saEmail } })).totpLastStep ?? 0;
  const attente = (Number(last) + 1) * 30_000 - Date.now();
  if (attente > 0) await page.waitForTimeout(attente + 200);
  await champ.fill(await code(page));
  await page.getByRole('button', { name: 'Valider' }).click();
  await page.waitForURL((u) => u.pathname === '/plateforme');
}

async function rubrique(page: Page, groupe: string, nom: string) {
  await page.getByRole('group', { name: groupe }).getByRole('button', { name: nom, exact: true }).click();
}

/** Adresse locale d'un établissement fictif (même port que le site des essais). */
function adresse(e: Ecole) {
  const u = new URL(process.env.WEB_URL ?? 'http://localhost:3000');
  u.hostname = e.domain;
  return u.origin;
}

/** Connexion à l'adresse de l'établissement, après la fin de toute session ; l'API limite à 10 connexions par minute. */
async function connexion(page: Page, e: Ecole, phone: string) {
  await page.context().clearCookies();
  for (let essai = 0; essai < 3; essai++) {
    await page.goto(`${adresse(e)}/connexion`);
    await page.getByLabel('Téléphone, e-mail ou matricule').fill(phone);
    await page.getByLabel('Mot de passe', { exact: true }).fill(PW);
    await page.getByRole('button', { name: 'Se connecter' }).click();
    const limite = page.getByRole('alert').filter({ hasText: /Too Many Requests|Trop de/ });
    await Promise.race([page.waitForURL((u) => u.pathname.startsWith('/espace')), limite.waitFor()]);
    if (new URL(page.url()).pathname.startsWith('/espace')) return;
    await page.waitForTimeout(61_000);
  }
  throw new Error('Connexion impossible après 3 essais');
}

const toast = (page: Page) => page.locator('div.fixed[aria-live="polite"]');

test('Direction en délai de grâce : alerte à la connexion, compteur, « Régulariser mon abonnement » et demande de régularisation', async ({ page }) => {
  await connexion(page, G, G.direction);
  const lastDay = frDate(addDays(T0, 12));
  // Alerte de connexion, posée dans un coin : la page reste utilisable. Le tableau de bord a sa carte, pas de bandeau.
  const alerte = page.getByRole('alertdialog', { name: 'Abonnement Cahiora : en attente d’acceptation des conditions' });
  await expect(alerte).toBeVisible();
  await expect(alerte.getByTestId('compteur-acces')).toHaveText('Encore 13 jours d’accès complet');
  await expect(alerte).toContainText(`Délai de grâce en accès complet jusqu’au ${lastDay} inclus. ${AFTER}`);
  const carte = page.getByRole('region', { name: 'Abonnement Cahiora' });
  await expect(carte).toHaveCount(1);
  await expect(carte.getByTestId('compteur-acces')).toHaveText('Encore 13 jours d’accès complet');
  await tientEnLargeur(page);
  await shot(page, 'g5d-1-alerte-connexion');

  // Lecture 3 ajustée le 20 novembre 2026 : un autre onglet de la même connexion ne répète pas l'alerte.
  const onglet = await page.context().newPage();
  await onglet.goto(`${adresse(G)}/espace`);
  await expect(onglet.getByRole('region', { name: 'Abonnement Cahiora' }).getByTestId('compteur-acces')).toHaveText('Encore 13 jours d’accès complet');
  await onglet.waitForTimeout(500);
  await expect(onglet.getByRole('alertdialog')).toHaveCount(0);
  await onglet.close();
  await expect(alerte).toBeVisible();

  // Le bouton de la carte répond alors que l'alerte est ouverte : elle ne bloque rien.
  await carte.getByRole('link', { name: 'Régulariser mon abonnement' }).click();
  await page.waitForURL((u) => u.pathname === '/espace/parametres' && u.hash === '#regulariser');
  await expect(page.getByRole('heading', { name: 'Régulariser mon abonnement', exact: true })).toBeVisible();
  await alerte.getByRole('button', { name: 'Fermer l’alerte' }).click();
  await expect(alerte).toBeHidden();

  // Hors du tableau de bord : le bandeau permanent, avec le compteur.
  const bandeau = page.getByRole('region', { name: 'Abonnement Cahiora' });
  await expect(bandeau).toContainText('Abonnement Cahiora : en attente d’acceptation des conditions');
  await expect(bandeau.getByTestId('compteur-acces')).toHaveText('Encore 13 jours d’accès complet');
  // La page de l'abonnement : délai, montant, échéance, paiement, moyens de paiement.
  await expect(page.getByText(`Délai de grâce en accès complet du ${frDate(addDays(T0, -2))} au ${lastDay} inclus.`)).toBeVisible();
  const section = page.locator('#regulariser');
  await expect(section).toContainText('Première étape :');
  await expect(section).toContainText('Indiqué après l’acceptation des conditions et le comptage de vos élèves.');
  await expect(section).toContainText('Pas encore fixée');
  await expect(section).toContainText('Aucun paiement validé par Cahiora pour le moment.');
  await expect(section).toContainText('Aucun moyen de paiement n’est encore activé par Cahiora : envoyez une demande de régularisation, Cahiora vous répondra.');
  await section.getByLabel('Message pour Cahiora (facultatif)').fill(MESSAGE);
  await tientEnLargeur(page);
  await shot(page, 'g5d-2-regulariser');

  // Demande envoyée : datée, en attente de Cahiora ; tant qu'elle attend, l'accès ne sera pas limité.
  await section.getByRole('button', { name: 'Envoyer la demande à Cahiora' }).click();
  await expect(toast(page)).toContainText('Demande de régularisation envoyée à Cahiora');
  await expect(section).toContainText('attend la réponse de Cahiora. Tant qu’elle attend, l’accès ne sera pas limité.');
  await expect(section.getByRole('button', { name: 'Envoyer la demande à Cahiora' })).toHaveCount(0);
  const demandes = section.getByRole('list', { name: 'Demandes de régularisation' }).locator(':scope > li');
  await expect(demandes).toHaveCount(1);
  await expect(demandes.first()).toContainText('En attente de Cahiora');
  await expect(demandes.first()).toContainText(`« ${MESSAGE} »`);
  await expect(bandeau).toContainText('Votre demande de régularisation attend la réponse de Cahiora : tant qu’elle attend, l’accès ne sera pas limité.');
  const r = await db.regularizationRequest.findFirstOrThrow({ where: { tenantId: G.id } });
  expect(r).toMatchObject({ status: 'PENDING', message: MESSAGE, subscriptionStatus: 'AWAITING_ACCEPTANCE' });
  await tientEnLargeur(page);
  await shot(page, 'g5d-3-demande-envoyee');

  // Une seule alerte par connexion : rien au rechargement, ni dans un nouvel onglet.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Régulariser mon abonnement', exact: true })).toBeVisible();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  const autre = await page.context().newPage();
  await autre.goto(`${adresse(G)}/espace`);
  await expect(autre.getByRole('region', { name: 'Abonnement Cahiora' }).getByTestId('compteur-acces')).toHaveText('Encore 13 jours d’accès complet');
  await autre.waitForTimeout(500);
  await expect(autre.getByRole('alertdialog')).toHaveCount(0);
  await autre.close();

  // Nouvelle connexion dans le même navigateur : l'alerte revient.
  await connexion(page, G, G.direction);
  await expect(page.getByRole('alertdialog', { name: 'Abonnement Cahiora : en attente d’acceptation des conditions' })).toBeVisible();
});

test('Accès limité : bandeau pour tout le personnel, saisie refusée avec son motif, consultation et régularisation ouvertes', async ({ page }) => {
  // Comptable : bandeau sans bouton, aucune alerte de connexion, consultation possible.
  await connexion(page, L, L.comptable);
  const bandeau = page.getByRole('region', { name: 'Abonnement Cahiora' });
  await expect(bandeau).toContainText('Accès limité');
  await expect(bandeau).toContainText(`${LIMITED_STAFF} Pour toute autre saisie, voyez avec la direction de l’établissement.`);
  await expect(bandeau.getByRole('link', { name: 'Régulariser mon abonnement' })).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await page.goto(`${adresse(L)}/espace/paiements`);
  await expect(page.getByRole('heading', { name: 'Paiements', exact: true })).toBeVisible();
  await expect(bandeau).toContainText('Accès limité');
  await tientEnLargeur(page);
  await shot(page, 'g5d-4-limite-personnel');

  // Direction : alerte de connexion « Accès limité », sans compteur.
  await connexion(page, L, L.direction);
  const alerte = page.getByRole('alertdialog', { name: 'Accès limité' });
  await expect(alerte).toContainText(LIMITED_STAFF);
  await expect(page.getByTestId('compteur-acces')).toHaveCount(0);
  await tientEnLargeur(page);
  await shot(page, 'g5d-5-limite-direction');
  await alerte.getByRole('button', { name: 'Plus tard' }).click();
  await expect(alerte).toBeHidden();

  // Une saisie est refusée, avec son motif ; rien n'est enregistré.
  await page.goto(`${adresse(L)}/espace/annonces`);
  await page.getByRole('button', { name: 'Nouvelle annonce' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Titre').fill('Réunion des parents (test de navigateur)');
  await dlg.getByLabel('Message').fill('Annonce fictive, refusée pendant l’accès limité.');
  await dlg.getByRole('button', { name: 'Envoyer' }).click();
  await expect(toast(page)).toContainText(LIMITED_REFUSAL);
  await shot(page, 'g5d-6-saisie-refusee', true);
  const annonces = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${L.id}, true)`;
    return tx.announcement.count({ where: { tenantId: L.id } });
  });
  expect(annonces).toBe(0);
  await page.keyboard.press('Escape');

  // La régularisation reste ouverte : la page de l'abonnement, depuis le bandeau.
  await page.getByRole('region', { name: 'Abonnement Cahiora' }).getByRole('link', { name: 'Régulariser mon abonnement' }).click();
  await expect(page.getByRole('heading', { name: 'Régulariser mon abonnement', exact: true })).toBeVisible();
  await expect(page.getByText('Accès limité depuis le', { exact: false })).toBeVisible();
  await expect(page.locator('#regulariser').getByRole('button', { name: 'Envoyer la demande à Cahiora' })).toBeVisible();
  await expect(page.getByText('Délai passé sans paiement validé : accès limité').first()).toBeVisible();
  await tientEnLargeur(page);
  await shot(page, 'g5d-7-limite-abonnement');
});

test('Super Admin : réponse à la demande de régularisation et prolongation qui lève l’accès limité, avec un code', async ({ page }) => {
  await page.goto('/plateforme/connexion');
  await page.getByLabel('Adresse e-mail').fill(saEmail);
  await page.getByLabel('Mot de passe').fill(SA_PW);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  // Double authentification d'abord : chaque réponse et chaque prolongation demandent un code.
  await page.getByRole('button', { name: 'Configurer' }).click();
  secret = (await page.locator('p.font-mono').filter({ hasText: /^[A-Z2-7]{16,}$/ }).first().textContent())!.trim();
  await page.getByLabel('Code à 6 chiffres').fill(await code(page));
  await page.getByRole('button', { name: 'Activer' }).click();
  await expect(page.getByTestId('recovery-codes')).toBeVisible();
  await page.getByLabel('J’ai noté ces codes en lieu sûr').check();
  await page.getByRole('button', { name: /Accéder aux écoles/ }).click();

  await rubrique(page, 'Rubrique', 'Commercial et facturation');
  await rubrique(page, 'Commercial et facturation', 'Accès des clients');
  await expect(page.getByText('Aucun moyen de paiement n’est activé (lot G5d-2)', { exact: false })).toBeVisible();
  const enAttente = page.getByRole('list', { name: 'Demandes de régularisation en attente' }).locator(':scope > li', { hasText: G.name });
  await expect(enAttente).toContainText(`« ${MESSAGE} »`);
  await expect(enAttente).toContainText('En attente d’acceptation des conditions');
  const clients = page.getByRole('list', { name: 'Clients en attente ou en accès limité' });
  const cG = clients.locator(':scope > li', { hasText: G.name });
  const cL = clients.locator(':scope > li', { hasText: L.name });
  await expect(cG).toContainText(`Accès complet jusqu’au ${frDate(addDays(T0, 12))} (encore 13 jours)`);
  await expect(cG).toContainText('Demande de régularisation du');
  await expect(cL.getByText('Accès limité', { exact: true }).first()).toBeVisible();
  await expect(cL).toContainText('Accès limité depuis le');
  await expect(cL).toContainText('Conditions commerciales pas encore acceptées.');
  await tientEnLargeur(page);
  await shot(page, 'g5d-8-acces-clients');

  // Réponse : un code faux est refusé ; avec le bon, la demande passe dans les demandes répondues.
  await enAttente.getByRole('button', { name: `Répondre à ${G.name}` }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toContainText(`« ${MESSAGE} »`);
  // Lecture 7 A : avant d'envoyer, le jour et l'heure de la limitation ; la grâce finit dans plus de 48 heures, sans préavis.
  await expect(dlg.getByTestId('apres-reponse')).toHaveText(
    `Sans paiement validé ni prolongation, l’accès sera limité à partir du ${frJour(addDays(T0, 13))} à 0 h 00, à la fin du délai d’accès complet : la réponse ne change pas cette date.`,
  );
  await dlg.getByLabel('Réponse').fill(REPONSE);
  await dlg.getByLabel('Code de votre application d’authentification').fill('000000');
  await dlg.getByRole('button', { name: 'Envoyer la réponse' }).click();
  await expect(dlg.getByText('Code de votre application incorrect ou expiré')).toBeVisible();
  await dlg.getByLabel('Code de votre application d’authentification').fill(await code(page));
  await tientEnLargeur(page);
  await shot(page, 'g5d-9-reponse');
  await dlg.getByRole('button', { name: 'Envoyer la réponse' }).click();
  await expect(dlg).toBeHidden();
  await expect(page.getByRole('list', { name: 'Demandes de régularisation en attente' }).locator(':scope > li', { hasText: G.name })).toHaveCount(0);
  await page.locator('summary', { hasText: /^Demandes répondues/ }).click();
  const repondue = page.getByRole('list', { name: 'Demandes répondues' }).locator(':scope > li', { hasText: G.name });
  await expect(repondue).toContainText(`par ${saName} : ${REPONSE}`);

  // Prolongation de l'établissement limité : la date doit dépasser le délai de grâce ; la limitation est levée.
  await cL.getByRole('button', { name: `Prolonger l’accès de ${L.name}` }).click();
  await expect(dlg).toContainText('la limitation est levée dès l’enregistrement');
  await dlg.getByLabel('Dernier jour d’accès complet').fill(addDays(T0, 20));
  await dlg.getByLabel('Motif').fill(MOTIF);
  await dlg.getByLabel('Code de votre application d’authentification').fill(await code(page));
  await tientEnLargeur(page);
  await shot(page, 'g5d-10-prolongation');
  await dlg.getByRole('button', { name: 'Prolonger l’accès' }).click();
  await expect(dlg).toBeHidden();
  await expect(cL).toContainText('Prolongation de Cahiora');
  await expect(cL).toContainText(`Accès complet prolongé jusqu’au ${frDate(addDays(T0, 20))} (encore 21 jours).`);
  const s = await db.subscription.findUniqueOrThrow({ where: { tenantId: L.id } });
  expect({ status: s.status, extendedUntil: s.extendedUntil?.toISOString().slice(0, 10), limitedSince: s.limitedSince }).toEqual({ status: 'AWAITING_ACCEPTANCE', extendedUntil: addDays(T0, 20), limitedSince: null });
  const ev = await db.subscriptionEvent.findFirstOrThrow({ where: { tenantId: L.id, kind: 'ACCESS_EXTENDED' } });
  expect(ev).toMatchObject({ fromStatus: 'LIMITED', toStatus: 'AWAITING_ACCEPTANCE', reason: MOTIF, actorName: saName });
  await shot(page, 'g5d-11-prolongation-faite');
});

test('Directions : réponse de Cahiora lue dans l’abonnement ; accès complet rendu par la prolongation', async ({ page }) => {
  // La demande a sa réponse : elle ne retient plus la limitation, l'alerte le dit ; la réponse reste dans l'abonnement.
  await connexion(page, G, G.direction);
  const alerte = page.getByRole('alertdialog', { name: 'Abonnement Cahiora : en attente d’acceptation des conditions' });
  await expect(alerte).toContainText(AFTER);
  await alerte.getByRole('link', { name: 'Régulariser mon abonnement' }).click();
  await expect(alerte).toBeHidden();
  const section = page.locator('#regulariser');
  const demande = section.getByRole('list', { name: 'Demandes de régularisation' }).locator(':scope > li');
  await expect(demande).toHaveCount(1);
  await expect(demande.first()).toContainText('Réponse reçue');
  await expect(demande.first()).toContainText(`Réponse de Cahiora, le`);
  await expect(demande.first()).toContainText(REPONSE);
  await expect(section.getByRole('button', { name: 'Envoyer la demande à Cahiora' })).toBeVisible();
  await expect(page.getByText(saName)).toHaveCount(0);
  await tientEnLargeur(page);
  await shot(page, 'g5d-12-reponse-lue');
  await page.goto(`${adresse(G)}/espace/notifications`);
  await expect(page.getByText('Réponse de Cahiora à votre demande de régularisation').first()).toBeVisible();

  // Prolongation : accès complet jusqu'à sa date, avec le compteur ; la saisie repasse ; le motif reste chez Cahiora.
  await connexion(page, L, L.direction);
  const prolongee = page.getByRole('alertdialog', { name: 'Accès complet prolongé par Cahiora' });
  await expect(prolongee.getByTestId('compteur-acces')).toHaveText('Encore 21 jours d’accès complet');
  await expect(prolongee).toContainText(`Jusqu’au ${frDate(addDays(T0, 20))} inclus. ${AFTER}`);
  await tientEnLargeur(page);
  await shot(page, 'g5d-13-prolongation-lue');
  await prolongee.getByRole('button', { name: 'Plus tard' }).click();
  await page.goto(`${adresse(L)}/espace/parametres?rubrique=abonnement`);
  await expect(page.getByText(`Accès complet prolongé par Cahiora jusqu’au ${frDate(addDays(T0, 20))} inclus.`)).toBeVisible();
  await expect(page.getByText(MOTIF)).toHaveCount(0);
  await page.goto(`${adresse(L)}/espace/annonces`);
  await page.getByRole('button', { name: 'Nouvelle annonce' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Titre').fill('Réunion des parents (test de navigateur)');
  await dlg.getByLabel('Message').fill('Annonce fictive, acceptée pendant la prolongation.');
  await dlg.getByRole('button', { name: 'Envoyer' }).click();
  await expect(dlg).toBeHidden();
  await expect(toast(page)).not.toContainText('Accès limité');

  // Comptable : plus de bandeau, l'accès est complet.
  await connexion(page, L, L.comptable);
  await expect(page.getByRole('heading').first()).toBeVisible();
  await expect(page.getByRole('region', { name: 'Abonnement Cahiora' })).toHaveCount(0);
});

test('Super Admin : jour et heure de la limitation lus avant la réponse (préavis de 48 heures) ; renouvellement exceptionnel motivé et marqué', async ({ page }) => {
  await connexionPlateforme(page);
  await rubrique(page, 'Rubrique', 'Commercial et facturation');
  await rubrique(page, 'Commercial et facturation', 'Accès des clients');
  const enAttente = page.getByRole('list', { name: 'Demandes de régularisation en attente' }).locator(':scope > li', { hasText: N.name });
  await expect(enAttente).toContainText(`« ${MESSAGE_PREAVIS} »`);
  await enAttente.getByRole('button', { name: `Répondre à ${N.name}` }).click();
  const dlg = page.getByRole('dialog');
  // Le délai finit aujourd'hui : la réponse ouvre un préavis de 48 heures, et le Super Admin le lit avant d'envoyer.
  await expect(dlg.getByTestId('apres-reponse')).toContainText('Le délai d’accès complet finit dans moins de 48 heures : votre réponse ouvre un préavis de 48 heures, une seule fois pour cette échéance.');
  await dlg.getByLabel('Réponse').fill(REPONSE);
  await dlg.getByLabel('Code de votre application d’authentification').fill(await code(page));
  await tientEnLargeur(page);
  await shot(page, 'g5d-14-preavis-annonce');
  await dlg.getByRole('button', { name: 'Envoyer la réponse' }).click();
  await expect(dlg).toBeHidden();
  const s = await db.subscription.findUniqueOrThrow({ where: { tenantId: N.id } });
  expect(s.noticeUntil).not.toBeNull();
  expect(s.noticeUntil!.getTime() - Date.now()).toBeGreaterThan(47 * 3_600_000);
  const clients = page.getByRole('list', { name: 'Clients en attente ou en accès limité' });
  const cN = clients.locator(':scope > li', { hasText: N.name });
  await expect(cN).toContainText('Préavis après la réponse');
  await expect(cN).toContainText(`Préavis après la réponse de Cahiora : accès complet jusqu’au ${frHeure(s.noticeUntil!)}`);

  // Lecture 9 A : nouvelle date plus tardive pour la prolongation de l'établissement limité, donc renouvellement exceptionnel.
  const cL = clients.locator(':scope > li', { hasText: L.name });
  await cL.getByRole('button', { name: `Prolonger l’accès de ${L.name}` }).click();
  await expect(dlg).toContainText(`Prolongation actuelle jusqu’au ${frDate(addDays(T0, 20))} : une date plus tardive est un renouvellement exceptionnel ; une date plus proche avance la fin.`);
  const fin = dlg.getByLabel('Dernier jour d’accès complet');
  // 30 jours au plus depuis la fin de la prolongation en cours.
  await expect(fin).toHaveAttribute('max', addDays(T0, 50));
  await fin.fill(addDays(T0, 40));
  await expect(dlg).toContainText('Renouvellement exceptionnel : il sera marqué comme tel au journal et dans cette liste');
  // Son propre motif : celui de la prolongation précédente est refusé.
  await dlg.getByLabel('Motif du renouvellement exceptionnel').fill(MOTIF);
  await dlg.getByLabel('Code de votre application d’authentification').fill(await code(page));
  await dlg.getByRole('button', { name: 'Prolonger l’accès' }).click();
  await expect(dlg.getByText('Renouvellement exceptionnel : donnez son propre motif, différent de celui de la prolongation précédente')).toBeVisible();
  await tientEnLargeur(page);
  await shot(page, 'g5d-15-renouvellement-motif-refuse');
  await dlg.getByLabel('Motif du renouvellement exceptionnel').fill(MOTIF_RENOUVELLEMENT);
  await dlg.getByLabel('Code de votre application d’authentification').fill(await code(page));
  await dlg.getByRole('button', { name: 'Prolonger l’accès' }).click();
  await expect(dlg).toBeHidden();
  await expect(cL).toContainText('Renouvellement exceptionnel');
  await expect(cL).toContainText(`Accès complet prolongé jusqu’au ${frDate(addDays(T0, 40))} (encore 41 jours).`);
  const ev = await db.subscriptionEvent.findFirstOrThrow({ where: { tenantId: L.id, kind: 'ACCESS_EXTENSION_RENEWED' } });
  expect(ev).toMatchObject({ reason: MOTIF_RENOUVELLEMENT, actorName: saName, data: { until: addDays(T0, 40), previousUntil: addDays(T0, 20), kind: 'renewal' } });
  await shot(page, 'g5d-16-renouvellement-marque');
});

test('Direction pendant le préavis : jour et heure de la limitation, heures restantes, dans l’alerte, le bandeau et l’abonnement', async ({ page }) => {
  const s = await db.subscription.findUniqueOrThrow({ where: { tenantId: N.id } });
  const fin = frHeure(s.noticeUntil!);
  await connexion(page, N, N.direction);
  const alerte = page.getByRole('alertdialog', { name: 'Préavis avant l’accès limité' });
  await expect(alerte).toBeVisible();
  await expect(alerte.getByTestId('compteur-acces')).toHaveText(/^\s*Encore 4[78] heures d’accès complet\s*$/);
  await expect(alerte).toContainText(`Cahiora a répondu à votre demande de régularisation : l’accès reste complet jusqu’au ${fin}. ${AFTER}`);
  await tientEnLargeur(page);
  await shot(page, 'g5d-17-preavis-alerte');
  await alerte.getByRole('button', { name: 'Plus tard' }).click();
  await expect(alerte).toBeHidden();
  await page.goto(`${adresse(N)}/espace/parametres?rubrique=abonnement`);
  const bandeau = page.getByRole('region', { name: 'Abonnement Cahiora' });
  await expect(bandeau).toContainText('Préavis avant l’accès limité');
  await expect(bandeau.getByTestId('compteur-acces')).toHaveText(/^\s*Encore 4[78] heures d’accès complet\s*$/);
  await expect(page.getByText(`Préavis après la réponse de Cahiora : accès complet jusqu’au ${fin}.`)).toBeVisible();
  const demande = page.locator('#regulariser').getByRole('list', { name: 'Demandes de régularisation' }).locator(':scope > li').first();
  await expect(demande).toContainText(REPONSE);
  await tientEnLargeur(page);
  await shot(page, 'g5d-18-preavis-abonnement');
});
