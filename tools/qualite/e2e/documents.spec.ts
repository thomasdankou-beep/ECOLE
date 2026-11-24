import { expect, Page, test } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomUUID } from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { authenticator } = require('otplib');

/**
 * Lot G5c, dans un vrai navigateur, au bureau et au téléphone : « Factures et documents » du Super Admin (exclusion qui
 * touche un document émis, décidée avec un code, et avoir provisoire ; devis puis proforma de prestations) et, chez la
 * direction de l'établissement, « Documents de Cahiora » dans Abonnement Cahiora et une exclusion sur un comptage figé,
 * que Cahiora décide (D-G5-13 B, D-G5-14 A). Base de test seulement : établissement, élèves, comptage et document
 * d'abonnement fictifs, enregistrés par les fonctions de la base (record_billing_count, issue_billing_document,
 * request_count_correction), qui refont chaque contrôle. Aucun paiement, aucun SMS, aucune facture fiscale.
 *
 * L'établissement fictif est servi à sa propre adresse locale (« <nom>.localhost », champ domaine de l'établissement) :
 * sa direction s'y connecte sans toucher à l'école de démonstration.
 *
 * Le document d'abonnement est préparé directement dans la base : au 19 novembre 2026, la tâche planifiée n'en émet
 * aucun pour une première année (D-G5-29 et l'arrondi attendent la décision de Dankou). Sa ligne est celle d'une année
 * entière, sans part ni arrondi, comme une année de renouvellement ; « Prochain document de chaque client » dit donc
 * pour cet établissement que le comptage de la fin de la période gratuite n'est pas fait, ce qui n'est pas vérifié ici.
 */
const url = process.env.DATABASE_ADMIN_URL ?? 'postgresql://erp_owner:erp_owner_dev@localhost:5432/erp_test';
if (!/\/erp_test(\?|$)/.test(url)) throw new Error('Base refusée : erp_test seulement');
const db = new PrismaClient({ datasources: { db: { url } } });
const SHOTS = process.env.E2E_SHOTS;
const SA_PW = 'Documents-E2E-2026';
const PW = 'Documents-Direction-E2E-2026';
const PHONE = '+2290190008101';
const TZ = 'Africa/Porto-Novo';
const MENTION = 'Document provisoire, sans valeur fiscale : ce n’est pas une facture.';
/** Ce que porte un document à payer sans échéance (G5c-1, même texte que l'API). */
const DUE_TO_BE_FIXED = 'Échéance à fixer : délai proposé, en attente de la validation des conditions commerciales de Cahiora';
const CANCEL = 'Inscription saisie en double (fictive E2E)';
/** 82 élèves × 500 FCFA = 41 000 FCFA, au-dessus du minimum de 40 000 FCFA : une exclusion donne un avoir de 500 FCFA. */
const PUPILS = 82;

test.describe.configure({ mode: 'serial' });

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** Jour de Porto-Novo (plateforme et établissement fictif), au format AAAA-MM-JJ. */
const localDay = (at = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
/** Même format que l'écran : « 14 novembre 2026 ». */
const frDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
/** Fin d'un jour à Porto-Novo (UTC+1, sans heure d'été). */
const endOfDay = (d: string) => new Date(Date.parse(`${addDays(d, 1)}T00:00:00+01:00`) - 1);

let saEmail = '';
let saName = '';
let domain = '';
let T0 = '';
let D = '';
const ecole = { id: '', name: '', groupId: '', groupName: '' };
const eleves = { premier: { nom: '', matricule: '' }, second: { nom: '', matricule: '' } };
const abonnement = { id: '', reference: '' };
const devis = { id: '', reference: '' };

test.beforeAll(async ({}, info) => {
  const suffix = info.project.name === 'telephone' ? '2' : '1';
  const stamp = Date.now().toString(36);
  T0 = localDay();
  // Année scolaire commencée il y a 60 jours, essai terminé avant la rentrée (première année entière : aucune part à
  // calculer, donc aucune décision en attente) ; comptage initial il y a 40 jours.
  const year = { start: addDays(T0, -60), end: addDays(T0, 250), label: '' };
  year.label = `${year.start.slice(0, 4)}-${Number(year.start.slice(0, 4)) + 1}`;
  D = addDays(T0, -40);
  const trialEnd = addDays(year.start, -2);

  saEmail = `e2e-documents-${suffix}@test.local`;
  saName = `Super Admin documents ${suffix}`;
  const sa = { name: saName, passwordHash: await argon2.hash(SA_PW, { type: argon2.argon2id }), active: true, mustChangePassword: false, mustSetupTwoFactor: false, failedLogins: 0, lockedUntil: null, totpEnabled: false, totpSecret: null, totpLastStep: null };
  const admin = await db.platformAdmin.upsert({ where: { email: saEmail }, update: sa, create: { email: saEmail, ...sa } });
  await db.platformRecoveryCode.deleteMany({ where: { adminId: admin.id } });

  // Établissement fictif, seul dans son groupe (sa direction voit ses documents, D-G5-19), à sa propre adresse locale.
  domain = `e2e-g5c-${suffix}-${stamp}.localhost`;
  const t = await db.tenant.create({
    data: {
      commercialStatus: 'CLIENT', slug: `e2e-g5c-${suffix}-${stamp}`, name: `École fictive documents ${suffix} ${stamp}`, timezone: TZ, domain,
      group: { create: { name: `Groupe fictif documents ${suffix} ${stamp}` } },
    },
    include: { group: true },
  });
  Object.assign(ecole, { id: t.id, name: t.name, groupId: t.groupId, groupName: t.group.name });

  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const fx = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${t.id}, true)`;
    const user = await tx.user.create({ data: { tenantId: t.id, phone: PHONE, firstName: 'Fictive', lastName: `DIRECTION DOCUMENTS ${suffix}`, passwordHash: hash, mustChangePassword: false } });
    await tx.userRole.create({ data: { tenantId: t.id, userId: user.id, role: 'DIRECTION' } });
    const y = await tx.academicYear.create({ data: { tenantId: t.id, label: year.label, startDate: new Date(year.start), endDate: new Date(year.end), isCurrent: true } });
    const level = await tx.level.create({ data: { tenantId: t.id, name: '6e', cycle: 'COLLEGE', position: 1 } });
    const site = await tx.site.create({ data: { tenantId: t.id, name: 'Site fictif' } });
    const klass = await tx.class.create({ data: { tenantId: t.id, academicYearId: y.id, siteId: site.id, levelId: level.id, name: '6e fictive' } });
    const rows = Array.from({ length: PUPILS }, (_, i) => {
      const n = String(i + 1).padStart(2, '0');
      return { studentId: randomUUID(), enrollmentId: randomUUID(), matricule: `E2E-G5C-${suffix}-${stamp}-${n}`, lastName: `DOCUMENTS ${suffix} ${n}` };
    });
    await tx.student.createMany({ data: rows.map((r) => ({ id: r.studentId, tenantId: t.id, matricule: r.matricule, firstName: 'Élève', lastName: r.lastName })) });
    const enrolled = new Date(`${year.start}T08:00:00Z`);
    await tx.enrollment.createMany({
      data: rows.map((r) => ({ id: r.enrollmentId, tenantId: t.id, studentId: r.studentId, classId: klass.id, academicYearId: y.id, enrolledAt: enrolled, type: 'NEW' as const })),
    });
    await tx.enrollmentEvent.createMany({ data: rows.map((r) => ({ tenantId: t.id, enrollmentId: r.enrollmentId, kind: 'ENROLLED', data: { classId: klass.id, className: klass.name, type: 'NEW' }, createdAt: enrolled })) });
    return { userId: user.id, userName: `${user.firstName} ${user.lastName}`, yearId: y.id, klass, rows };
  });
  eleves.premier = { nom: `${fx.rows[0].lastName} Élève`, matricule: fx.rows[0].matricule };
  eleves.second = { nom: `${fx.rows[1].lastName} Élève`, matricule: fx.rows[1].matricule };

  // Conditions acceptées après l'essai (fin d'essai simulée, tarif figé de 500 FCFA et 40 000 FCFA) ; calendrier fictif.
  const sub = await db.subscription.create({
    data: {
      tenantId: t.id, status: 'AWAITING_PAYMENT', trialStart: new Date(addDays(trialEnd, -13)), trialEnd: new Date(trialEnd), trialDays: 14,
      acceptedAt: new Date(`${addDays(trialEnd, 1)}T09:00:00Z`), acceptedByName: fx.userName, acceptedTariff: { currency: 'XOF', pricePerPupil: 500, minimum: 40000, day: addDays(trialEnd, 1) },
    },
  });
  await db.subscriptionEvent.create({
    data: { subscriptionId: sub.id, tenantId: t.id, kind: 'TRIAL_ENDED', fromStatus: 'TRIAL', toStatus: 'AWAITING_ACCEPTANCE', actorKind: 'system', actorName: 'Préparation des tests de navigateur', data: { fixture: true, lastFreeDay: trialEnd } },
  });
  await db.billingCalendar.create({
    data: {
      tenantId: t.id, yearLabel: year.label, version: 1, startDate: new Date(year.start), endDate: new Date(year.end), initialCountDate: new Date(D),
      firstRegularizationDate: new Date(addDays(T0, 60)), finalRegularizationDate: new Date(addDays(T0, 200)), formula: 'MANUEL',
      reason: 'Calendrier fictif des tests de navigateur (lot G5c)', createdByName: 'Préparation des tests de navigateur',
    },
  });

  // Comptage initial : provisoire, puis figé après la vérification (le jour du gel est simulé quinze jours plus tard ;
  // la base n'accepte un gel qu'après la vérification). Les 82 élèves sont comptés.
  const items = fx.rows.map((r) => ({ enrollmentId: r.enrollmentId, classId: fx.klass.id, siteId: fx.klass.siteId, counted: true, basis: 'ACTIVE', departureDate: null }));
  const at = endOfDay(D).toISOString();
  const known = new Date().toISOString();
  await db.$queryRaw`SELECT * FROM record_billing_count(${t.id}::uuid, ${fx.yearId}::uuid, 'INITIAL', ${D}::date, 'PROVISIONAL', 1, ${JSON.stringify(items)}::jsonb,
    ${at}::timestamptz, ${known}::timestamptz, ${T0}::date)`;
  const [frozen] = await db.$queryRaw<{ count_id: string; count_pupils: number }[]>`
    SELECT * FROM record_billing_count(${t.id}::uuid, ${fx.yearId}::uuid, 'INITIAL', ${D}::date, 'FROZEN', 1, ${JSON.stringify(items)}::jsonb,
      ${at}::timestamptz, ${known}::timestamptz, ${addDays(T0, 15)}::date)`;
  if (frozen?.count_pupils !== PUPILS) throw new Error('Comptage fictif non enregistré');

  // Proforma de l'abonnement de cette année, émise aujourd'hui, comme la tâche planifiée : 82 × 500 = 41 000 FCFA.
  const line = {
    tenantId: t.id, label: `${t.name} · Comptage initial du ${frDate(D)}`, amount: 41000, countId: frozen.count_id, pupils: PUPILS, pupilsChange: PUPILS,
    pricePerPupil: 500, minimum: 40000, minimumApplied: false, fullYear: 41000, shareMonths: null, shareOf: null, yearAmount: 41000, alreadyBilled: 0,
  };
  const data = {
    title: `Abonnement Cahiora ${year.label} · Comptage initial du ${frDate(D)}`, mention: MENTION, client: { groupId: t.groupId, name: t.group.name },
    establishments: [{ tenantId: t.id, name: t.name }], tariff: { currency: 'XOF', pricePerPupil: 500, minimum: 40000 }, countKind: 'INITIAL', countDate: D, fixture: true,
  };
  const [doc] = await db.$queryRaw<{ document_id: string; document_reference: string }[]>`
    SELECT * FROM issue_billing_document(${t.groupId}::uuid, 'SUBSCRIPTION', 'XOF', ${T0}::date, NULL::date, ${year.label}, NULL::uuid, ${JSON.stringify(data)}::jsonb,
      ${JSON.stringify([line])}::jsonb, 'system', NULL::uuid, 'Préparation des tests de navigateur')`;
  Object.assign(abonnement, { id: doc.document_id, reference: doc.document_reference });

  // Les deux premières inscriptions sont annulées ensuite pour erreur de saisie ; la direction demande l'exclusion de
  // la première (déjà demandée par le document : c'est Cahiora qui décide).
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${t.id}, true)`;
    for (const r of fx.rows.slice(0, 2)) {
      await tx.enrollment.update({ where: { id: r.enrollmentId }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: CANCEL } });
      await tx.enrollmentEvent.create({ data: { tenantId: t.id, enrollmentId: r.enrollmentId, kind: 'CANCELLED', data: { reason: CANCEL, previousStatus: 'ACTIVE' } } });
    }
    await tx.$queryRaw`
      SELECT request_count_correction(${frozen.count_id}::uuid, 'EXCLUSION', ${fx.rows[0].enrollmentId}::uuid, NULL::date,
        ${'Élève saisi deux fois : voir le registre (test de navigateur)'}, NULL, NULL, NULL::int, ${fx.userId}::uuid, ${fx.userName}, NULL, ${T0}::date) AS id`;
  });
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

async function rubrique(page: Page, groupe: string, nom: string) {
  await page.getByRole('group', { name: groupe }).getByRole('button', { name: nom, exact: true }).click();
}

/** Adresse locale de l'établissement fictif (même port que le site des essais). */
function adresse() {
  const u = new URL(process.env.WEB_URL ?? 'http://localhost:3000');
  u.hostname = domain;
  return u.origin;
}

/** Connexion de la direction à l'adresse de l'établissement ; l'API limite à 10 connexions par minute et par adresse. */
async function connexionDirection(page: Page) {
  for (let essai = 0; essai < 3; essai++) {
    await page.goto(`${adresse()}/connexion`);
    await page.getByLabel('Téléphone, e-mail ou matricule').fill(PHONE);
    await page.getByLabel('Mot de passe', { exact: true }).fill(PW);
    await page.getByRole('button', { name: 'Se connecter' }).click();
    const limite = page.getByRole('alert').filter({ hasText: /Too Many Requests|Trop de/ });
    await Promise.race([page.waitForURL((u) => u.pathname.startsWith('/espace')), limite.waitFor()]);
    if (new URL(page.url()).pathname.startsWith('/espace')) return;
    await page.waitForTimeout(61_000);
  }
  throw new Error('Connexion impossible après 3 essais');
}

test('Super Admin : exclusion qui touche un document, décidée avec un code, avoir provisoire ; devis puis proforma de prestations', async ({ page }) => {
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
  await rubrique(page, 'Commercial et facturation', 'Factures et documents');
  await expect(page.getByRole('heading', { name: 'Documents provisoires', exact: true })).toBeVisible();
  await expect(page.getByText(MENTION).first()).toBeVisible();
  // Décisions encore ouvertes : affichées comme telles, jamais présumées.
  await expect(page.getByText('en attente de votre décision (D-G5-29)')).toBeVisible();

  // La proforma de l'abonnement, provisoire, dans les documents émis.
  const emis = page.getByRole('list', { name: 'Documents émis' }).locator(':scope > li');
  await expect(emis.filter({ hasText: abonnement.reference })).toContainText('Proforma de l’abonnement');
  await expect(emis.filter({ hasText: abonnement.reference })).toContainText('41 000 FCFA');

  // Exclusion à décider : établissement, inscription et avoir qu'elle donnerait ; jamais le nom de l'élève.
  const demande = page.getByRole('list', { name: 'Exclusions à décider' }).locator(':scope > li', { hasText: ecole.name });
  await expect(demande).toContainText(`Inscription ${eleves.premier.matricule}`);
  await expect(demande).toContainText(`Si elle est validée : avoir provisoire de 500 FCFA sur le document ${abonnement.reference}`);
  await expect(demande).toContainText('81 élèves après l’exclusion : 40 500 FCFA pour l’année, 41 000 FCFA déjà demandés.');
  // Ajustements G5c-7 et G5c-9 : objectif de 7 jours ouvrés (aucune acceptation d'office) et document d'origine.
  await expect(page.getByText('Objectif de Cahiora : décider dans les 7 jours ouvrés (lundi à vendredi ; jours fériés : INFORMATION MANQUANTE). Aucune demande n’est acceptée d’office.', { exact: false })).toBeVisible();
  await expect(demande).toContainText('(objectif de 7 jours ouvrés)');
  await expect(demande).toContainText(`Document d’origine : ${abonnement.reference}`);
  await expect(page.getByText(eleves.premier.nom)).toHaveCount(0);
  await tientEnLargeur(page);
  await shot(page, 'g5c-1-documents');

  // Décision : un refus exige un motif ; un code faux est refusé ; validée avec le bon code, l'avoir suit.
  await page.getByRole('button', { name: `Décider : inscription ${eleves.premier.matricule}, ${ecole.name}` }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByText(`Annulation : « ${CANCEL} »`, { exact: false })).toBeVisible();
  await dlg.getByLabel('Code de votre application d’authentification').fill('000000');
  await dlg.getByRole('button', { name: 'Refuser' }).click();
  await expect(dlg.getByText('Un refus exige un motif (5 caractères au moins).')).toBeVisible();
  await dlg.getByRole('button', { name: 'Valider l’exclusion' }).click();
  await expect(dlg.getByText('Code de votre application incorrect ou expiré')).toBeVisible();
  await dlg.getByLabel('Motif de la décision').fill('Doublon vérifié dans le registre (test de navigateur)');
  await dlg.getByLabel('Code de votre application d’authentification').fill(await code(page));
  await shot(page, 'g5c-2-decision');
  await dlg.getByRole('button', { name: 'Valider l’exclusion' }).click();
  await expect(dlg).toBeHidden();
  await expect(page.getByRole('list', { name: 'Exclusions à décider' }).locator(':scope > li', { hasText: ecole.name })).toHaveCount(0);
  await page.locator('summary', { hasText: /^Décisions prises/ }).click();
  const decidee = page.locator('details li', { hasText: `${ecole.name} · ${eleves.premier.matricule}` });
  await expect(decidee).toContainText('Validée');
  await expect(decidee).toContainText(`par ${saName} : « Doublon vérifié dans le registre (test de navigateur) »`);
  // G5c-9 : l'exclusion, son document d'origine et son avoir, reliés.
  const avoirEmis = await db.billingDocument.findFirstOrThrow({ where: { groupId: ecole.groupId, kind: 'CREDIT_NOTE' } });
  await expect(decidee).toContainText(`Document d’origine : ${abonnement.reference}`);
  await expect(decidee).toContainText(`Avoir : ${avoirEmis.reference} (− 500 FCFA)`);

  // L'avoir provisoire : 500 FCFA sur la proforma de l'abonnement, avec son calcul.
  const avoir = emis.filter({ hasText: 'Avoir provisoire' }).filter({ hasText: ecole.groupName });
  await expect(avoir).toContainText('− 500 FCFA');
  await avoir.getByRole('button', { name: /^Voir Avoir provisoire/ }).click();
  await expect(dlg.getByText(MENTION)).toBeVisible();
  await expect(dlg.getByText(`Document corrigé : ${abonnement.reference}`)).toBeVisible();
  await expect(dlg.getByLabel('Exclusion de cet avoir')).toContainText(`Exclusion de l’inscription ${eleves.premier.matricule}`);
  await expect(dlg.getByLabel('Exclusion de cet avoir')).toContainText(`Document d’origine : ${abonnement.reference}`);
  const lignes = dlg.getByRole('list', { name: 'Lignes du document' });
  await expect(lignes).toContainText(`${ecole.name} · Avoir après exclusion d’une inscription erronée`);
  await expect(lignes).toContainText('81 élèves (-1) × 500 FCFA, minimum 40 000 FCFA : 40 500 FCFA pour l’année, 41 000 FCFA déjà demandés');
  await expect(dlg.getByText('Total', { exact: true }).locator('..')).toContainText('− 500 FCFA');
  await tientEnLargeur(page);
  await shot(page, 'g5c-3-avoir');
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();

  // Devis : intervention sur site (prestation sur devis, prix saisi) et formation au prix du catalogue du jour.
  await page.getByRole('button', { name: 'Devis ou proforma de prestations' }).click();
  await dlg.getByRole('combobox', { name: /^Établissement/ }).selectOption(ecole.id);
  await dlg.getByRole('group', { name: 'Document' }).getByRole('button', { name: 'Devis', exact: true }).click();
  await expect(dlg.getByRole('list', { name: 'Prestations du catalogue' }).locator(':scope > li', { hasText: 'Formation et prise en main' })).toContainText('15 000 FCFA');
  await dlg.getByLabel('Quantité : Intervention sur site').fill('2');
  await dlg.getByLabel('Prix unitaire : Intervention sur site').fill('25 000');
  await dlg.getByLabel('Quantité : Formation et prise en main').fill('1');
  await expect(dlg.getByText('Total', { exact: true }).locator('..')).toContainText('65 000 FCFA');
  await expect(dlg.getByText('Durée de validité d’un devis : INFORMATION MANQUANTE, aucune date n’est inscrite.', { exact: false })).toBeVisible();
  await dlg.getByLabel('Code de votre application d’authentification').fill(await code(page));
  await tientEnLargeur(page);
  await shot(page, 'g5c-4-devis');
  await dlg.getByRole('button', { name: 'Émettre le devis' }).click();
  await expect(dlg).toBeHidden();
  const q = await db.billingDocument.findFirstOrThrow({ where: { groupId: ecole.groupId, kind: 'SERVICE_QUOTE' }, orderBy: { createdAt: 'desc' } });
  Object.assign(devis, { id: q.id, reference: q.reference });
  await expect(emis.filter({ hasText: devis.reference })).toContainText('Devis de prestations');
  await expect(emis.filter({ hasText: devis.reference })).toContainText('65 000 FCFA');

  // Proforma qui reprend le devis tel quel : aucune prestation à choisir, échéance non fixée.
  await page.getByRole('button', { name: 'Devis ou proforma de prestations' }).click();
  await dlg.getByRole('combobox', { name: /^Établissement/ }).selectOption(ecole.id);
  await expect(dlg.getByRole('group', { name: 'Document' }).getByRole('button', { name: 'Proforma', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await dlg.getByRole('combobox', { name: /^Reprendre un devis/ }).selectOption(devis.id);
  await expect(dlg.getByRole('list', { name: 'Prestations du catalogue' })).toHaveCount(0);
  // G5c-1 : délai de la proforma proposé, non activé : « Échéance à fixer ».
  await expect(dlg.getByText('Échéance d’une proforma : sa date plus le délai des paramètres tarifaires, s’il est activé ; sinon « Échéance à fixer ».', { exact: false })).toBeVisible();
  await dlg.getByLabel('Code de votre application d’authentification').fill(await code(page));
  await shot(page, 'g5c-5-proforma');
  await dlg.getByRole('button', { name: 'Émettre la proforma' }).click();
  await expect(dlg).toBeHidden();
  const proforma = emis.filter({ hasText: 'Proforma de prestations' }).filter({ hasText: ecole.groupName });
  await expect(proforma).toContainText('65 000 FCFA');
  await proforma.getByRole('button', { name: /^Voir Proforma de prestations/ }).click();
  await expect(dlg.getByText(`Document lié : ${devis.reference}`)).toBeVisible();
  await expect(dlg.getByRole('list', { name: 'Lignes du document' })).toContainText('2 × 25 000 FCFA (prix saisi sur le devis)');
  await expect(dlg.getByText(DUE_TO_BE_FIXED)).toBeVisible();
  await tientEnLargeur(page);
  await shot(page, 'g5c-6-proforma-detail');
  await page.keyboard.press('Escape');
  // Le devis a sa proforma : il n'est plus proposé.
  await page.getByRole('button', { name: 'Devis ou proforma de prestations' }).click();
  await dlg.getByRole('combobox', { name: /^Établissement/ }).selectOption(ecole.id);
  await expect(dlg.getByRole('list', { name: 'Prestations du catalogue' })).toBeVisible();
  await expect(dlg.getByRole('combobox', { name: /^Reprendre un devis/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('Direction : documents de Cahiora dans « Abonnement Cahiora », exclusion sur un comptage figé que Cahiora décide', async ({ page }) => {
  await connexionDirection(page);
  await page.goto(`${adresse()}/espace/parametres?rubrique=abonnement`);
  await expect(page.getByRole('heading', { name: 'Documents de Cahiora', exact: true })).toBeVisible();
  await expect(page.getByText(MENTION).first()).toBeVisible();
  const docs = page.getByRole('list', { name: 'Documents de Cahiora' }).locator(':scope > li');
  await expect(docs).toHaveCount(4);
  // Un document par sa référence exacte (un avoir ou une proforma cite aussi celle du document qu'il reprend).
  const doc = (ref: string) => docs.filter({ has: page.getByText(ref, { exact: true }) });
  const avoir = await db.billingDocument.findFirstOrThrow({ where: { groupId: ecole.groupId, kind: 'CREDIT_NOTE' } });
  const proforma = await db.billingDocument.findFirstOrThrow({ where: { groupId: ecole.groupId, kind: 'SERVICE_PROFORMA' } });
  await expect(doc(abonnement.reference)).toContainText('Proforma de l’abonnement');
  await expect(doc(abonnement.reference)).toContainText('41 000 FCFA');
  await expect(doc(avoir.reference)).toContainText('− 500 FCFA');
  await expect(doc(avoir.reference)).toContainText(`Sur proforma de l’abonnement ${abonnement.reference}`);
  await expect(doc(devis.reference)).toContainText('Devis de prestations');
  await expect(doc(proforma.reference)).toContainText(`Reprend devis de prestations ${devis.reference}`);
  // Détail : le calcul de la proforma de l'abonnement ; l'échéance non fixée de la proforma de prestations.
  await doc(abonnement.reference).locator('summary').click();
  await expect(doc(abonnement.reference)).toContainText(`82 élèves (+82) au ${frDate(D)} × 500 FCFA, minimum 40 000 FCFA : 41 000 FCFA pour l’année, 0 FCFA déjà demandés`);
  await doc(proforma.reference).locator('summary').click();
  await expect(doc(proforma.reference)).toContainText('2 × 25 000 FCFA');
  await expect(doc(proforma.reference).getByText(DUE_TO_BE_FIXED)).toBeVisible();
  await expect(doc(proforma.reference)).toContainText('échéance à fixer');
  await tientEnLargeur(page);
  await shot(page, 'g5c-7-direction-documents');

  // Effectifs facturables : le comptage figé ; l'exclusion validée par Cahiora ; celle du second élève se demande encore
  // jusqu'à 30 jours après le document, et c'est Cahiora qui la décide.
  await page.getByRole('button', { name: 'Effectifs facturables' }).last().click();
  await page.getByRole('button', { name: `Voir la liste : Comptage initial du ${frDate(D)}, définitif`, exact: true }).click();
  await expect(page.getByText('Comptage figé : il ne change plus', { exact: false })).toBeVisible();
  await page.getByRole('group', { name: 'Afficher' }).getByRole('button', { name: /^Inscriptions annulées/ }).click();
  const premier = page.locator('li', { hasText: eleves.premier.matricule });
  const second = page.locator('li', { hasText: eleves.second.matricule });
  await expect(premier.getByText('Exclusion validée après le gel : retiré des élèves facturés ; le comptage figé reste tel quel.')).toBeVisible();
  const limite = frDate(addDays(T0, 30));
  await expect(second.getByText(`Exclusion possible jusqu’au ${limite} inclus, 30 jours après le document de Cahiora du ${frDate(T0)} : Cahiora décide.`)).toBeVisible();
  const decision = page.locator('li', { hasText: `(${eleves.premier.matricule})` });
  await expect(decision.getByText('Validée', { exact: true })).toBeVisible();
  await expect(decision).toContainText(`par Cahiora (${saName})`);
  await expect(decision).toContainText('Motif de la décision : Doublon vérifié dans le registre (test de navigateur)');
  await tientEnLargeur(page);
  await shot(page, 'g5c-8-comptage-fige');

  await second.getByRole('button', { name: 'Demander l’exclusion' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByText(`Demande possible jusqu’au ${limite} inclus.`)).toBeVisible();
  await expect(dlg.getByText('Cahiora la valide ou la refuse', { exact: false })).toBeVisible();
  await dlg.getByLabel('Justification').fill('Élève inscrit par erreur dans cet établissement (test de navigateur)');
  await shot(page, 'g5c-9-demande');
  await dlg.getByRole('button', { name: 'Demander l’exclusion' }).click();
  await expect(dlg).toBeHidden();
  await expect(second.getByText('Exclusion demandée, en attente de la décision de Cahiora.')).toBeVisible();
  const attente = page.locator('li', { hasText: `(${eleves.second.matricule})` });
  await expect(attente.getByText('Décision de Cahiora attendue')).toBeVisible();
  await expect(attente).toContainText('Cahiora décide');
  // La direction ne décide pas une exclusion qui touche un document émis (D-G5-13 B).
  await expect(attente.getByRole('button', { name: 'Décider' })).toHaveCount(0);
  await tientEnLargeur(page);
  await shot(page, 'g5c-10-attente-cahiora');
});
