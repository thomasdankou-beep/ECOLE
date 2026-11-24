import { expect, Page, test } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomUUID } from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { authenticator } = require('otplib');

/**
 * Lot G5d-2, dans un vrai navigateur, au bureau et au téléphone : paiements de l'abonnement enregistrés à la main par le
 * Super Admin (D-G5-17 A), plan validé par Dankou le 20 novembre 2026 (« Tout valider » : choix 1 A et 2 A, D-G5-15 A,
 * D-G5-43 A). Le serveur des essais tourne verrou ouvert (BILLING_PAYMENTS_UNLOCKED=true dans le workflow des tests
 * seulement) ; partout ailleurs, production comprise, le verrou reste fermé par défaut.
 * Un établissement fictif en francs CFA d'Afrique centrale (XAF : aucun autre essai n'y touche), seul dans son groupe, à
 * sa propre adresse locale, en délai de grâce, conditions acceptées, avec deux proformas fictives de l'abonnement :
 * - le Super Admin crée un moyen de paiement fictif (verrou 2), enregistre un paiement partiel avec son justificatif et
 *   le code (essai 11 du cahier), ouvre le justificatif et imprime le reçu provisoire ;
 * - la direction lit le moyen et ses instructions, l'état de chaque document et le reçu provisoire, qu'elle imprime ;
 * - le Super Admin saisit un paiement excédentaire erroné, l'annule par une contre-écriture motivée, le refait (essai 12) :
 *   le surplus devient un crédit et l'accès complet revient (choix 2 A) ; rapport financier de l'établissement. La
 *   ressaisie désigne la saisie annulée, une seule fois (ajustement G5d2-5 du 20 novembre 2026) : sans elle, la même
 *   référence est refusée ; chaque paiement a son propre justificatif ;
 * - la direction lit l'accès rendu, le reçu annulé, son crédit, et en demande le remboursement (essai 14) ;
 * - le Super Admin rembourse avec sa preuve, puis désactive le moyen fictif par une nouvelle version ;
 * - la direction lit le remboursement.
 * Base de test seulement : aucun prestataire appelé, aucun SMS, aucune facture.
 */
const url = process.env.DATABASE_ADMIN_URL ?? 'postgresql://erp_owner:erp_owner_dev@localhost:5432/erp_test';
if (!/\/erp_test(\?|$)/.test(url)) throw new Error('Base refusée : erp_test seulement');
const db = new PrismaClient({ datasources: { db: { url } } });
const SHOTS = process.env.E2E_SHOTS;
const SA_PW = 'Paiements-E2E-2026';
const PW = 'Paiements-Direction-E2E-2026';
const TZ = 'Africa/Douala';
const CUR = 'XAF';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
/** CRC-32 d'un bloc PNG (type et données). */
const crc32 = (b: Buffer) => {
  let c = ~0;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
};
let preuves = 0;
/**
 * Justificatif fictif, différent à chaque appel (un bloc de texte en plus) : un même justificatif joint à deux paiements
 * exige le motif d'un autre versement (ajustement G5d2-5).
 */
const preuve = (name: string) => {
  const data = Buffer.concat([Buffer.from('tEXt'), Buffer.from(`Comment\0preuve fictive ${Date.now()} ${++preuves}`)]);
  const chunk = Buffer.alloc(data.length + 8);
  chunk.writeUInt32BE(data.length - 4, 0);
  data.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(data), data.length + 4);
  return { name, mimeType: 'image/png', buffer: Buffer.concat([PNG.subarray(0, PNG.length - 12), chunk, PNG.subarray(PNG.length - 12)]) };
};
const INSTRUCTIONS = 'Coordonnées fictives des tests de navigateur : aucun compte réel. Indiquez la référence du document.';
const NOTE = 'Commentaire interne fictif (test de navigateur)';
const MOTIF_ANNULATION = 'Montant mal saisi : 85 000 au lieu de 55 000 (test de navigateur)';
const MESSAGE_REMB = 'Merci de rembourser le trop-perçu par virement (test de navigateur)';
const MOYEN_REMB = 'Virement fictif (test de navigateur)';
const RECEIPT_MENTION = 'Reçu provisoire, sans valeur fiscale.';

test.describe.configure({ mode: 'serial' });

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** Jour de Cahiora (Porto-Novo, même heure que Douala), au format AAAA-MM-JJ. */
const localDay = (at = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Porto-Novo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
/** Même format que l'écran : « 14 novembre 2026 ». */
const frDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const at = (d: string) => new Date(`${d}T08:00:00Z`);

type Ecole = { id: string; name: string; domain: string; groupId: string; direction: string; comptable: string };
let T0 = '';
let saEmail = '';
let saName = '';
let MOYEN = '';
let REF1 = '';
let REF2 = '';
let REF_REMB = '';
const E: Ecole = { id: '', name: '', domain: '', groupId: '', direction: '', comptable: '' };
/** Proformas fictives : la fin de la gratuité (document du délai de grâce), puis un complément. */
const DOC = { fin: '', complement: '' };
/** Reçus provisoires émis par le Super Admin, lus dans la console. */
const RECU = { partiel: '', errone: '', corrige: '' };

/** Proforma provisoire du lot G5c, posée dans la base comme l'écrit la tâche planifiée (une ligne pour l'établissement). */
async function proforma(reference: string, issue: string, amount: number, countKind: 'TRIAL_END' | 'FIRST_REGULARIZATION', due: string | null) {
  const id = randomUUID();
  await db.$executeRaw`INSERT INTO billing_documents (id, group_id, kind, reference, currency, "issueDate", "dueDate", total, "yearLabel", data, "createdByKind", "createdByName", "createdAt")
    VALUES (${id}::uuid, ${E.groupId}::uuid, 'SUBSCRIPTION'::"BillingDocumentKind", ${reference}, ${CUR}, ${issue}::date, ${due}::date, ${amount}, '2026-2027',
            ${JSON.stringify({ title: 'Proforma fictive (test de navigateur du lot G5d-2)' })}::jsonb, 'system', 'Cahiora (tâche planifiée)', ${`${issue}T00:10:00`}::timestamp)`;
  await db.$executeRaw`INSERT INTO billing_document_lines (id, "documentId", tenant_id, position, label, amount, "countKind", "referenceDate")
    VALUES (gen_random_uuid(), ${id}::uuid, ${E.id}::uuid, 1, 'Ligne fictive (test de navigateur)', ${amount}, ${countKind}::"BillingCountKind", ${issue}::date)`;
}

test.beforeAll(async ({}, info) => {
  const suffix = info.project.name === 'telephone' ? '2' : '1';
  const stamp = Date.now().toString(36);
  T0 = localDay();
  saEmail = `e2e-paiements-${suffix}@test.local`;
  saName = `Super Admin paiements ${suffix}`;
  MOYEN = `Virement fictif XAF ${suffix} ${stamp}`;
  REF1 = `VIR-E2E-${suffix}-${stamp}-1`;
  REF2 = `VIR-E2E-${suffix}-${stamp}-2`;
  REF_REMB = `RMB-E2E-${suffix}-${stamp}`;
  const sa = { name: saName, passwordHash: await argon2.hash(SA_PW, { type: argon2.argon2id }), active: true, mustChangePassword: false, mustSetupTwoFactor: false, failedLogins: 0, lockedUntil: null, totpEnabled: false, totpSecret: null, totpLastStep: null };
  const admin = await db.platformAdmin.upsert({ where: { email: saEmail }, update: sa, create: { email: saEmail, ...sa } });
  await db.platformRecoveryCode.deleteMany({ where: { adminId: admin.id } });

  // Établissement fictif du Cameroun (XAF), seul dans son groupe, à sa propre adresse locale.
  const slug = `e2e-g5d2-${suffix}-${stamp}`;
  const t = await db.tenant.create({
    data: {
      commercialStatus: 'CLIENT', slug, name: `École fictive paiements ${suffix} ${stamp}`, country: 'CM', currency: CUR, timezone: TZ, domain: `${slug}.localhost`,
      group: { create: { name: `Groupe fictif paiements ${suffix} ${stamp}` } },
    },
  });
  Object.assign(E, { id: t.id, name: t.name, domain: t.domain, groupId: t.groupId, direction: `+22901900086${suffix}1`, comptable: `+22901900086${suffix}2` });
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${t.id}, true)`;
    for (const [phone, role, last] of [[E.direction, 'DIRECTION', 'DIRECTION'], [E.comptable, 'COMPTABLE', 'COMPTABLE']] as const) {
      const user = await tx.user.create({ data: { tenantId: t.id, phone, firstName: 'Fictive', lastName: `${last} ${t.name}`, passwordHash: hash, mustChangePassword: false } });
      await tx.userRole.create({ data: { tenantId: t.id, userId: user.id, role } });
    }
    const y = Number(T0.slice(0, 4)) - (T0.slice(5, 7) < '09' ? 1 : 0);
    await tx.academicYear.create({ data: { tenantId: t.id, label: `${y}-${y + 1}`, startDate: new Date(`${y}-09-14T00:00:00Z`), endDate: new Date(`${y + 1}-07-09T00:00:00Z`), isCurrent: true } });
  });

  // Essai de 14 jours fini il y a 10 jours, conditions acceptées le lendemain ; délai de grâce jusqu'au 5e jour à venir.
  const end = addDays(T0, -10);
  const s = await db.subscription.create({
    data: {
      tenantId: t.id, status: 'AWAITING_PAYMENT', statusSince: at(addDays(end, 1)), trialStart: new Date(addDays(end, -13)), trialEnd: new Date(end), trialDays: 14,
      acceptedAt: at(addDays(end, 1)), acceptedByName: `Fictive DIRECTION ${t.name}`, acceptedTariff: { currency: CUR, pricePerPupil: 500, minimum: 40000, day: addDays(end, 1) },
      graceStart: new Date(addDays(end, 1)), graceEnd: new Date(addDays(end, 15)),
    },
  });
  await db.subscriptionEvent.create({
    data: {
      subscriptionId: s.id, tenantId: t.id, kind: 'TRIAL_ENDED', fromStatus: 'TRIAL', toStatus: 'AWAITING_ACCEPTANCE', actorKind: 'system', actorName: 'Préparation des tests de navigateur',
      data: { fixture: true, lastFreeDay: end, graceDays: 15, graceStart: addDays(end, 1), graceEnd: addDays(end, 15) }, createdAt: at(addDays(end, 1)),
    },
  });
  DOC.fin = `PROV-E2E-G5D2-${suffix}-${stamp}-1`.toUpperCase();
  DOC.complement = `PROV-E2E-G5D2-${suffix}-${stamp}-2`.toUpperCase();
  await proforma(DOC.fin, addDays(end, 1), 60_000, 'TRIAL_END', addDays(T0, 5));
  await proforma(DOC.complement, addDays(T0, -2), 10_000, 'FIRST_REGULARIZATION', null);
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
/** Code de l'application d'authentification, assez loin de la fin de sa fenêtre de 30 secondes pour être encore bon à l'envoi. */
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

/** Adresse locale de l'établissement fictif (même port que le site des essais). */
function adresse() {
  const u = new URL(process.env.WEB_URL ?? 'http://localhost:3000');
  u.hostname = E.domain;
  return u.origin;
}

/** Connexion de la direction à l'adresse de l'établissement, après la fin de toute session ; l'API limite à 10 connexions par minute. */
async function connexionDirection(page: Page) {
  await page.context().clearCookies();
  for (let essai = 0; essai < 3; essai++) {
    await page.goto(`${adresse()}/connexion`);
    await page.getByLabel('Téléphone, e-mail ou matricule').fill(E.direction);
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
const ligneEcole = (page: Page) => page.getByRole('list', { name: 'Établissements et documents à payer' }).locator(':scope > li', { hasText: E.name });
const paiementsEcole = (page: Page) => page.getByRole('table', { name: 'Paiements enregistrés' }).locator('tbody tr', { hasText: E.name });

/**
 * Saisie d'un paiement reçu dans la console, avec son justificatif et le code ; `ressaisie` : reçu de la saisie annulée
 * que ce paiement remplace, refusé d'abord sans elle quand la référence est la sienne (ajustement G5d2-5).
 */
async function enregistrer(page: Page, o: { montant: string; reference: string; attendu: string; apercu: string; note?: string; capture?: string; ressaisie?: string }) {
  await ligneEcole(page).getByRole('button', { name: `Enregistrer un paiement de ${E.name}` }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByLabel('Document concerné')).toHaveValue(await documentId(DOC.fin));
  await expect(dlg).toContainText(`Montant attendu : ${o.attendu}`);
  await expect(dlg.getByLabel('Date du paiement')).toHaveValue(T0);
  await dlg.getByLabel('Montant reçu').fill(o.montant);
  await expect(dlg).toContainText(o.apercu);
  await dlg.getByLabel('Moyen de paiement').selectOption({ label: MOYEN });
  await dlg.getByLabel('Référence de la transaction').fill(o.reference);
  await dlg.getByLabel('Justificatif du paiement').setInputFiles(preuve('preuve-fictive.png'));
  if (o.note) await dlg.getByLabel('Commentaire interne (facultatif)').fill(o.note);
  await dlg.getByLabel('Code de votre application d’authentification').fill(await code(page));
  if (o.ressaisie) {
    const choix = dlg.getByLabel('Ressaisie d’un paiement annulé');
    await expect(choix).toHaveValue('');
    await dlg.getByRole('button', { name: 'Enregistrer le paiement' }).click();
    await expect(dlg.getByText(`Cette référence est celle du paiement annulé du reçu ${o.ressaisie} : enregistrez la ressaisie de ce paiement en le désignant`)).toBeVisible();
    await choix.selectOption((await choix.locator('option', { hasText: o.ressaisie }).getAttribute('value'))!);
    await dlg.getByLabel('Code de votre application d’authentification').fill(await code(page));
  }
  await tientEnLargeur(page);
  if (o.capture) await shot(page, o.capture);
  await dlg.getByRole('button', { name: 'Enregistrer le paiement' }).click();
  await expect(toast(page)).toContainText('Paiement enregistré : reçu provisoire émis');
  await expect(dlg).toBeHidden();
}

async function documentId(reference: string) {
  return (await db.billingDocument.findUniqueOrThrow({ where: { reference } })).id;
}

/** Numéro du reçu provisoire d'une saisie, lu dans le tableau des paiements de la console. */
async function recuDe(page: Page, reference: string) {
  const row = paiementsEcole(page).filter({ hasText: reference });
  await expect(row).toHaveCount(1);
  const n = (await row.locator('td').first().locator('span').first().textContent())!.trim();
  expect(n).toMatch(/^PROV-REC-\d{6,}$/);
  return n;
}

test('Super Admin : moyen de paiement fictif (verrou 2), paiement partiel avec justificatif et code, reçu provisoire imprimable', async ({ page }) => {
  await page.goto('/plateforme/connexion');
  await page.getByLabel('Adresse e-mail').fill(saEmail);
  await page.getByLabel('Mot de passe').fill(SA_PW);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  // Double authentification d'abord : chaque opération de facturation demande un code.
  await page.getByRole('button', { name: 'Configurer' }).click();
  secret = (await page.locator('p.font-mono').filter({ hasText: /^[A-Z2-7]{16,}$/ }).first().textContent())!.trim();
  await page.getByLabel('Code à 6 chiffres').fill(await code(page));
  await page.getByRole('button', { name: 'Activer' }).click();
  await expect(page.getByTestId('recovery-codes')).toBeVisible();
  await page.getByLabel('J’ai noté ces codes en lieu sûr').check();
  await page.getByRole('button', { name: /Accéder aux écoles/ }).click();

  await rubrique(page, 'Rubrique', 'Commercial et facturation');
  await rubrique(page, 'Commercial et facturation', 'Paiements');
  // Verrou 1 : ouvert sur le serveur des essais seulement, la console le dit.
  await expect(page.getByTestId('verrou-paiements')).toContainText('Verrou du serveur ouvert. Cahiora enregistre à la main les paiements qu’il a reçus : aucun prestataire n’est appelé');
  const ligne = ligneEcole(page);
  await expect(ligne).toContainText(DOC.fin);
  await expect(ligne).toContainText('Aucun moyen de paiement activé pour cet établissement.');
  await expect(ligne.getByRole('button', { name: `Enregistrer un paiement de ${E.name}` })).toBeDisabled();

  // Verrou 2 : le moyen fictif, daté, motivé, avec le code ; rien n'est prérempli hors la date du jour.
  await page.getByRole('button', { name: 'Nouveau moyen' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByLabel('Nom du moyen')).toHaveValue('');
  await expect(dlg.getByRole('textbox', { name: /^Date d’effet/ })).toHaveValue(T0);
  const actif = dlg.getByLabel('Activé : montré aux établissements de cette monnaie à partir de la date d’effet');
  await expect(actif).not.toBeChecked();
  await dlg.getByLabel('Nom du moyen').fill(MOYEN);
  await dlg.getByLabel('Coordonnées et instructions').fill(INSTRUCTIONS);
  await dlg.getByRole('combobox', { name: /^Monnaie/ }).selectOption(CUR);
  await actif.check();
  await dlg.getByLabel('Motif').fill('Moyen fictif des tests de navigateur du lot G5d-2');
  await dlg.getByLabel('Code de votre application d’authentification').fill('000000');
  await dlg.getByRole('button', { name: 'Enregistrer la version' }).click();
  await expect(dlg.getByText('Code de votre application incorrect ou expiré')).toBeVisible();
  await dlg.getByLabel('Code de votre application d’authentification').fill(await code(page));
  await tientEnLargeur(page);
  await shot(page, 'g5d2-1-moyen-de-paiement');
  await dlg.getByRole('button', { name: 'Enregistrer la version' }).click();
  await expect(dlg).toBeHidden();
  const moyen = page.getByRole('list', { name: 'Moyens de paiement' }).locator(':scope > li', { hasText: MOYEN });
  await expect(moyen).toContainText('Activé');
  await expect(moyen).toContainText(`${CUR} · version 1 depuis le ${frDate(T0)}`);
  await expect(ligne).toContainText(`Moyens activés pour cet établissement : ${MOYEN}`);

  // Essai 11 : paiement partiel de la proforma de la fin de la gratuité ; l'accès ne change pas (D-G5-43 A).
  await enregistrer(page, { montant: '20000', reference: REF1, attendu: '60 000 FCFA', apercu: 'Paiement partiel : il restera 40 000 FCFA sur ce document ; l’accès ne change pas (D-G5-43 A).', note: NOTE, capture: 'g5d2-2-paiement-partiel' });
  await expect(ligne.locator('tr', { hasText: DOC.fin })).toContainText('Partiellement payé');
  await expect(ligne).toContainText(`Document de la fin de la gratuité : ${DOC.fin}, reste 40 000 FCFA ; l’accès complet revient quand il est entièrement payé.`);
  await expect(ligne).toContainText('En attente de paiement');
  RECU.partiel = await recuDe(page, REF1);
  await tientEnLargeur(page);
  await shot(page, 'g5d2-3-paiements-console');

  // Détail : justificatif par un lien signé et temporaire, commentaire interne, imputation ; reçu provisoire à imprimer.
  await paiementsEcole(page).filter({ hasText: REF1 }).getByRole('button', { name: `Détail du paiement ${RECU.partiel}` }).click();
  await expect(dlg).toContainText(NOTE);
  await expect(dlg).toContainText(`Imputé sur ${DOC.fin} : 20 000 FCFA`);
  await expect(dlg).toContainText(`par ${saName}`);
  const lien = await dlg.getByRole('link', { name: 'Ouvrir le justificatif' }).getAttribute('href');
  const fichier = await page.request.get(lien!);
  expect([fichier.status(), fichier.headers()['content-type']]).toEqual([200, 'image/png']);
  await shot(page, 'g5d2-4-detail-paiement');
  const [recu] = await Promise.all([page.context().waitForEvent('page'), dlg.getByRole('link', { name: 'Reçu provisoire à imprimer' }).click()]);
  const article = recu.getByRole('article', { name: `Reçu provisoire ${RECU.partiel}` });
  await expect(article).toContainText(`${RECEIPT_MENTION} Ce n’est pas une facture.`);
  await expect(article).toContainText('20 000 FCFA');
  await expect(article).toContainText(DOC.fin);
  await expect(article).toContainText('Identité légale de l’émetteur : INFORMATION MANQUANTE');
  await expect(article).not.toContainText(NOTE);
  await tientEnLargeur(recu);
  await shot(recu, 'g5d2-5-recu-console');
  await recu.close();

  const s = await db.subscription.findUniqueOrThrow({ where: { tenantId: E.id } });
  expect(s.status).toBe('AWAITING_PAYMENT');
});

test('Direction : moyen de paiement et ses instructions, état des documents, reçu provisoire à imprimer', async ({ page }) => {
  await connexionDirection(page);
  // Délai de grâce : l'alerte de connexion reste, le paiement partiel ne change pas l'accès.
  const alerte = page.getByRole('alertdialog');
  await expect(alerte).toBeVisible();
  await alerte.getByRole('button', { name: 'Fermer l’alerte' }).click();
  await page.goto(`${adresse()}/espace/parametres?rubrique=abonnement`);
  const reg = page.locator('#regulariser');
  await expect(reg).toContainText('Payez par l’un des moyens ci-dessous, avec la référence du document : Cahiora enregistre votre paiement et vous recevez un reçu provisoire.');
  const moyens = reg.getByRole('list', { name: 'Moyens de paiement activés par Cahiora' });
  await expect(moyens).toContainText(MOYEN);
  await expect(moyens).toContainText(INSTRUCTIONS);
  await expect(reg).toContainText('Payé : 20 000 FCFA ; reste à payer : 50 000 FCFA.');

  const pay = page.locator('#paiements-cahiora');
  await expect(pay.getByRole('heading', { name: 'Paiements et crédit' })).toBeVisible();
  const etat = pay.getByRole('list', { name: 'État du paiement des documents' }).locator(':scope > li');
  await expect(etat).toHaveCount(2);
  await expect(etat.filter({ hasText: DOC.fin })).toContainText('Payé 20 000 FCFA sur 60 000 FCFA, reste 40 000 FCFA');
  await expect(etat.filter({ hasText: DOC.fin })).toContainText('Partiellement payé');
  await expect(etat.filter({ hasText: DOC.complement })).toContainText('En attente');
  await expect(pay).toContainText(`${RECEIPT_MENTION} Ce n’est pas une facture.`);
  const recus = pay.getByRole('list', { name: 'Reçus provisoires' }).locator(':scope > li');
  await expect(recus).toHaveCount(1);
  await expect(recus.first()).toContainText(RECU.partiel);
  await expect(recus.first()).toContainText(`Paiement validé par Cahiora · paiement du ${frDate(T0)}, ${MOYEN}`);
  await expect(pay).toContainText('Aucun crédit disponible à rembourser.');
  // Le commentaire interne et le nom de l'agent restent à Cahiora.
  await expect(page.locator('body')).not.toContainText(NOTE);
  await expect(page.locator('body')).not.toContainText(saName);
  await tientEnLargeur(page);
  await shot(page, 'g5d2-6-direction-paiement-partiel');

  await recus.first().getByRole('link', { name: `Voir et imprimer le reçu ${RECU.partiel}` }).click();
  await page.waitForURL((u) => u.pathname.startsWith('/espace/recu-cahiora/'));
  const article = page.getByRole('article', { name: `Reçu provisoire ${RECU.partiel}` });
  await expect(article).toContainText(`${RECEIPT_MENTION} Ce n’est pas une facture.`);
  await expect(article).toContainText('20 000 FCFA');
  await expect(article).toContainText(REF1);
  await expect(article).not.toContainText(saName);
  await expect(page.getByRole('button', { name: 'Imprimer' })).toBeEnabled();
  await tientEnLargeur(page);
  await shot(page, 'g5d2-7-direction-recu');
  // À l'impression : le reçu seul, sans le bouton.
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('button', { name: 'Imprimer' })).toBeHidden();
  await expect(article).toBeVisible();
  await page.emulateMedia({ media: 'screen' });
});

test('Super Admin : paiement excédentaire erroné annulé par une contre-écriture, puis refait ; accès complet rendu, crédit, rapport', async ({ page }) => {
  await connexionPlateforme(page);
  await rubrique(page, 'Rubrique', 'Commercial et facturation');
  await rubrique(page, 'Commercial et facturation', 'Paiements');
  const ligne = ligneEcole(page);
  const dlg = page.getByRole('dialog');

  // Saisie erronée (85 000 au lieu de 55 000) : le document est payé, l'accès complet revient…
  await enregistrer(page, { montant: '85000', reference: REF2, attendu: '40 000 FCFA', apercu: 'Surplus de 45 000 FCFA : aux autres documents à payer, puis en crédit de l’établissement.' });
  RECU.errone = await recuDe(page, REF2);
  await expect(ligne).toContainText('Abonnement actif');
  await expect(ligne).toContainText('Crédit disponible : 35 000 FCFA.');
  // … puis s'annule une seule fois, par une contre-écriture motivée : rien n'est effacé, l'accès revient en attente.
  await paiementsEcole(page).filter({ hasText: RECU.errone }).getByRole('button', { name: `Détail du paiement ${RECU.errone}` }).click();
  await expect(dlg).toContainText(`Imputé sur ${DOC.fin} : 40 000 FCFA`);
  await expect(dlg).toContainText(`Imputé sur ${DOC.complement} : 10 000 FCFA`);
  await dlg.getByLabel('Motif de l’annulation').fill(MOTIF_ANNULATION);
  await dlg.getByLabel('Code de votre application d’authentification').fill(await code(page));
  await tientEnLargeur(page);
  await shot(page, 'g5d2-8-annulation');
  await dlg.getByRole('button', { name: 'Annuler la saisie' }).click();
  await expect(toast(page)).toContainText('Saisie annulée par une contre-écriture');
  await expect(dlg).toBeHidden();
  await expect(paiementsEcole(page).filter({ hasText: RECU.errone })).toContainText('Annulé (contre-écriture)');
  await expect(ligne).toContainText('En attente de paiement');
  await expect(ligne).toContainText(`Document de la fin de la gratuité : ${DOC.fin}, reste 40 000 FCFA`);
  await expect(ligne).toContainText('Crédit disponible : 0 FCFA.');
  await paiementsEcole(page).filter({ hasText: RECU.errone }).getByRole('button', { name: `Détail du paiement ${RECU.errone}` }).click();
  await expect(dlg).toContainText(`Saisie annulée le`);
  await expect(dlg).toContainText(`par ${saName} : ${MOTIF_ANNULATION}`);
  await expect(dlg).toContainText(`Reprise sur ${DOC.fin} : 40 000 FCFA`);
  await expect(dlg.getByRole('button', { name: 'Annuler la saisie' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();

  // Ajustement G5d2-5 : la saisie annulée attend sa ressaisie, qui la désigne.
  const aRessaisir = page.getByRole('list', { name: 'Saisies annulées pas encore ressaisies' });
  await page.getByText('Saisies annulées pas encore ressaisies', { exact: false }).click();
  await expect(aRessaisir.locator(':scope > li', { hasText: RECU.errone })).toContainText(REF2);

  // Essai 12 : le bon montant, avec la même référence (celle d'une saisie annulée sert au paiement corrigé, qui la
  // désigne). Le paiement va au document concerné, puis au complément, puis devient un crédit ; l'accès complet revient (choix 2 A).
  await enregistrer(page, {
    montant: '55000', reference: REF2, attendu: '40 000 FCFA', apercu: 'Surplus de 15 000 FCFA : aux autres documents à payer, puis en crédit de l’établissement.',
    capture: 'g5d2-9-paiement-excedentaire', ressaisie: RECU.errone,
  });
  const corrige = paiementsEcole(page).filter({ hasText: REF2 }).filter({ hasText: 'Validé' });
  RECU.corrige = (await corrige.locator('td').first().locator('span').first().textContent())!.trim();
  expect(RECU.corrige).not.toBe(RECU.errone);
  await expect(corrige).toContainText(`ressaisie de ${RECU.errone}`);
  await expect(paiementsEcole(page).filter({ hasText: 'Annulé (contre-écriture)' }).filter({ hasText: RECU.errone })).toContainText(`ressaisi par ${RECU.corrige}`);
  await expect(page.getByRole('list', { name: 'Saisies annulées pas encore ressaisies' }).locator(':scope > li', { hasText: RECU.errone })).toHaveCount(0);
  await expect(ligne).toContainText('Abonnement actif');
  await expect(ligne).toContainText(`Document de la fin de la gratuité : ${DOC.fin}, entièrement payé.`);
  await expect(ligne).toContainText('Crédit disponible : 5 000 FCFA.');
  await expect(ligne.locator('tr', { hasText: DOC.complement })).toContainText('Payé');
  await expect(paiementsEcole(page).filter({ hasText: RECU.corrige }).filter({ hasText: 'Validé' })).toContainText('dont 5 000 FCFA en crédit');
  await tientEnLargeur(page);
  await shot(page, 'g5d2-10-acces-rendu');
  const s = await db.subscription.findUniqueOrThrow({ where: { tenantId: E.id } });
  expect([s.status, s.limitedSince]).toEqual(['ACTIVE', null]);

  // Rapport financier de l'établissement : facturé, encaissé et crédit ne se confondent jamais.
  await rubrique(page, 'Commercial et facturation', 'Rapports financiers');
  const filtres = page.getByRole('form', { name: 'Filtres du rapport' });
  await filtres.getByLabel('Établissement').selectOption({ label: E.name });
  await filtres.getByRole('button', { name: 'Afficher' }).click();
  await expect(page.getByTestId('total-billed')).toHaveText('70 000 FCFA');
  await expect(page.getByTestId('total-collected')).toHaveText('75 000 FCFA');
  await expect(page.getByTestId('total-unpaid')).toHaveText('0');
  await expect(page.getByTestId('total-credits')).toHaveText('5 000 FCFA');
  await expect(page.getByRole('table', { name: 'Documents du rapport' }).locator('tbody tr')).toHaveCount(2);
  await tientEnLargeur(page);
  await shot(page, 'g5d2-11-rapport');
});

test('Direction : accès complet rendu, reçu annulé lisible, crédit et demande de remboursement', async ({ page }) => {
  await connexionDirection(page);
  await page.waitForTimeout(500);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await page.goto(`${adresse()}/espace/parametres?rubrique=abonnement`);
  await expect(page.locator('#regulariser')).toHaveCount(0);
  const pay = page.locator('#paiements-cahiora');
  await expect(pay).toContainText('Payé : 70 000 FCFA ; rien ne reste à payer.');
  const etat = pay.getByRole('list', { name: 'État du paiement des documents' }).locator(':scope > li');
  await expect(etat.filter({ hasText: DOC.fin })).toContainText('Payé 60 000 FCFA sur 60 000 FCFA');
  await expect(etat.filter({ hasText: DOC.complement })).toContainText('Payé 10 000 FCFA sur 10 000 FCFA');
  const recus = pay.getByRole('list', { name: 'Reçus provisoires' }).locator(':scope > li');
  await expect(recus).toHaveCount(3);
  await expect(recus.filter({ hasText: RECU.errone })).toContainText('Saisie annulée par Cahiora');
  await expect(recus.filter({ hasText: RECU.corrige })).toContainText('5 000 FCFA en crédit');
  await expect(page.locator('body')).not.toContainText(MOTIF_ANNULATION);
  await expect(pay).toContainText('Disponible : 5 000 FCFA.');

  // Essai 14 : la direction de tout l'établissement demande le remboursement de son crédit disponible.
  await pay.getByLabel('Montant à rembourser').fill('5000');
  await pay.getByLabel('Message pour Cahiora (facultatif)').fill(MESSAGE_REMB);
  await tientEnLargeur(page);
  await shot(page, 'g5d2-12-direction-credit');
  await pay.getByRole('button', { name: 'Demander le remboursement' }).click();
  await expect(toast(page)).toContainText('Demande de remboursement envoyée à Cahiora');
  const demandes = pay.getByRole('list', { name: 'Demandes de remboursement' }).locator(':scope > li');
  await expect(demandes).toHaveCount(1);
  await expect(demandes.first()).toContainText('Demande de 5 000 FCFA');
  await expect(demandes.first()).toContainText('Demandé');
  await expect(demandes.first()).toContainText(`« ${MESSAGE_REMB} »`);
  await expect(pay).toContainText('Disponible : 0 FCFA (5 000 FCFA réservés par votre demande de remboursement).');
  await expect(pay).toContainText('Une demande de remboursement attend la décision de Cahiora : son montant est réservé.');
  await expect(pay.getByRole('button', { name: 'Demander le remboursement' })).toHaveCount(0);
  await tientEnLargeur(page);
  await shot(page, 'g5d2-13-demande-remboursement');

  // Le reçu de la saisie annulée reste lisible, marqué ANNULÉ.
  await recus.filter({ hasText: RECU.errone }).getByRole('link', { name: `Voir et imprimer le reçu ${RECU.errone}` }).click();
  const article = page.getByRole('article', { name: `Reçu provisoire ${RECU.errone}` });
  await expect(article).toContainText('ANNULÉ');
  await expect(article).toContainText(/Saisie annulée par Cahiora le .+ : ce reçu ne vaut plus\./);
  await expect(article).not.toContainText(MOTIF_ANNULATION);
  await tientEnLargeur(page);
  await shot(page, 'g5d2-14-recu-annule');
});

test('Super Admin : remboursement avec sa preuve, puis le moyen fictif désactivé par une nouvelle version', async ({ page }) => {
  await connexionPlateforme(page);
  await rubrique(page, 'Rubrique', 'Commercial et facturation');
  await rubrique(page, 'Commercial et facturation', 'Avoirs et crédits');
  const demande = page.getByRole('list', { name: 'Demandes de remboursement en attente' }).locator(':scope > li', { hasText: E.name });
  await expect(demande).toContainText('5 000 FCFA');
  await expect(demande).toContainText(`« ${MESSAGE_REMB} »`);
  const credit = page.getByRole('list', { name: 'Crédits des établissements' }).locator(':scope > li', { hasText: E.name });
  await expect(credit).toContainText('5 000 FCFA réservés');
  await demande.getByRole('button', { name: `Décider la demande de ${E.name}` }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByLabel('Décision')).toHaveValue('REFUNDED');
  await expect(dlg.getByLabel('Date du remboursement')).toHaveValue(T0);
  await dlg.getByLabel('Moyen du remboursement').fill(MOYEN_REMB);
  await dlg.getByLabel('Référence du remboursement').fill(REF_REMB);
  await dlg.getByLabel('Preuve du remboursement').setInputFiles(preuve('preuve-remboursement-fictive.png'));
  await dlg.getByLabel('Code de votre application d’authentification').fill(await code(page));
  await tientEnLargeur(page);
  await shot(page, 'g5d2-15-remboursement');
  await dlg.getByRole('button', { name: 'Enregistrer la décision' }).click();
  await expect(toast(page)).toContainText('Remboursement enregistré');
  await expect(dlg).toBeHidden();
  await expect(demande).toHaveCount(0);
  await expect(credit).toContainText('Disponible : 0 FCFA');
  await page.locator('summary', { hasText: /^Demandes décidées/ }).click();
  const decidee = page.getByRole('list', { name: 'Demandes de remboursement décidées' }).locator(':scope > li', { hasText: E.name });
  await expect(decidee).toContainText('Remboursé');
  await expect(decidee).toContainText(`Remboursé le ${frDate(T0)} (${MOYEN_REMB}, référence ${REF_REMB})`);
  await expect(decidee).toContainText(`par ${saName}`);
  await tientEnLargeur(page);
  await shot(page, 'g5d2-16-avoirs-credits');
  const r = await db.billingRefund.findFirstOrThrow({ where: { tenantId: E.id } });
  expect(r).toMatchObject({ status: 'REFUNDED', amount: 5_000, refundRef: REF_REMB });

  // Fin des essais : le moyen fictif est désactivé par une nouvelle version, jamais modifié ni effacé.
  await rubrique(page, 'Commercial et facturation', 'Paiements');
  const moyen = page.getByRole('list', { name: 'Moyens de paiement' }).locator(':scope > li', { hasText: MOYEN });
  await moyen.getByRole('button', { name: 'Nouvelle version' }).click();
  await expect(dlg.getByRole('combobox', { name: /^Monnaie/ })).toBeDisabled();
  await expect(dlg.getByLabel('Nom du moyen')).toHaveValue(MOYEN);
  await dlg.getByLabel('Activé : montré aux établissements de cette monnaie à partir de la date d’effet').uncheck();
  await dlg.getByLabel('Motif').fill('Fin des tests de navigateur du lot G5d-2');
  await dlg.getByLabel('Code de votre application d’authentification').fill(await code(page));
  await dlg.getByRole('button', { name: 'Enregistrer la version' }).click();
  await expect(dlg).toBeHidden();
  await expect(moyen).toContainText('Désactivé');
  await expect(moyen).toContainText('version 2');
  await expect(ligneEcole(page)).toContainText('Aucun moyen de paiement activé pour cet établissement.');
});

test('Direction : remboursement lu, crédit à zéro, mouvements du crédit', async ({ page }) => {
  await connexionDirection(page);
  await page.goto(`${adresse()}/espace/parametres?rubrique=abonnement`);
  const pay = page.locator('#paiements-cahiora');
  const demandes = pay.getByRole('list', { name: 'Demandes de remboursement' }).locator(':scope > li');
  await expect(demandes.first()).toContainText('Remboursé');
  await expect(demandes.first()).toContainText(`Remboursé par Cahiora le ${frDate(T0)} (${MOYEN_REMB}, référence ${REF_REMB}).`);
  await expect(pay).toContainText('Disponible : 0 FCFA.');
  await expect(pay).toContainText('Aucun crédit disponible à rembourser.');
  await pay.locator('summary', { hasText: /^Mouvements du crédit/ }).click();
  await expect(pay).toContainText(RECU.corrige);
  await tientEnLargeur(page);
  await shot(page, 'g5d2-17-direction-rembourse');
});
