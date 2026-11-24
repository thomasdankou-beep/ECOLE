import { expect, Page, test } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { COMPTES } from './comptes';
import { connexion } from './connexion';

/**
 * Lot G5b, dans un vrai navigateur, au bureau et au téléphone : « Effectifs facturables » de la direction (élèves « À
 * vérifier » hors de tout comptage et date confirmée introuvable, liste d'un comptage provisoire, exclusion d'une
 * inscription annulée par erreur de saisie avec un justificatif, décision, date d'un départ enregistré avant
 * l'historique) et les nombres du même comptage chez le Super Admin, sans aucun nom.
 * Base de test seulement ; élèves, calendrier et comptage fictifs. Le comptage est enregistré par la fonction de la base
 * (record_billing_count), avec une liste préparée ici : le calcul de la liste est vérifié par les essais de l'API.
 */
const url = process.env.DATABASE_ADMIN_URL ?? 'postgresql://erp_owner:erp_owner_dev@localhost:5432/erp_test';
if (!/\/erp_test(\?|$)/.test(url)) throw new Error('Base refusée : erp_test seulement');
const db = new PrismaClient({ datasources: { db: { url } } });
const SHOTS = process.env.E2E_SHOTS;
const SA_PW = 'Comptages-E2E-2026';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

test.describe.configure({ mode: 'serial' });

const day = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: string, n: number) => day(new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000));
const eleveTexte = (n: number) => `${n} élève${n > 1 ? 's' : ''}`;
const frDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
/** Jour courant et fin d'un jour dans le fuseau de l'école. */
const localDay = (tz: string, at = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
function endOfDay(date: string, tz: string) {
  const next = Date.parse(`${addDays(date, 1)}T00:00:00Z`);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(next)).map((x) => [x.type, x.value]));
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return new Date(next - (local - next) - 1);
}

let saEmail = '';
let ecole = '';
let R = '';
let reviewUntil = '';
let pupils = 0;
/** Premier comptage de l'école de démonstration sur cette base : la liste préparée ici est alors celle que Cahiora calcule. */
let neuve = false;
const eleves = { exclu: { nom: '', matricule: '' }, parti: { nom: '', matricule: '' }, verif: { nom: '', matricule: '' } };

test.beforeAll(async ({}, info) => {
  const suffix = info.project.name === 'telephone' ? '2' : '1';
  const stamp = Date.now().toString(36).toUpperCase();
  saEmail = `e2e-comptages-${suffix}@test.local`;
  const sa = { name: `Super Admin comptages ${suffix}`, passwordHash: await argon2.hash(SA_PW, { type: argon2.argon2id }), active: true, mustChangePassword: false, mustSetupTwoFactor: false, failedLogins: 0, lockedUntil: null };
  await db.platformAdmin.upsert({ where: { email: saEmail }, update: sa, create: { email: saEmail, ...sa } });

  const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: 'saint-kisito' } });
  if ((tenant.settings as { demo?: boolean } | null)?.demo !== true) throw new Error("L'école de test n'est pas l'école de démonstration");
  ecole = tenant.name;
  const tz = tenant.timezone;
  const today = localDay(tz);
  // Abonnement de l'école de démonstration, hors période gratuite (fin d'essai simulée : base de test seulement).
  let sub = await db.subscription.findUnique({ where: { tenantId: tenant.id } });
  if (!sub) {
    sub = await db.subscription.create({ data: { tenantId: tenant.id, status: 'AWAITING_ACCEPTANCE', trialStart: new Date(`${addDays(today, -40)}T00:00:00Z`), trialEnd: new Date(`${addDays(today, -27)}T00:00:00Z`), trialDays: 14 } });
    await db.subscriptionEvent.create({ data: { subscriptionId: sub.id, tenantId: tenant.id, kind: 'TRIAL_ENDED', fromStatus: 'TRIAL', toStatus: 'AWAITING_ACCEPTANCE', actorKind: 'system', actorName: 'Préparation des tests de navigateur', data: { fixture: true } } });
  } else if (sub.status === 'TRIAL' || sub.status === 'PILOT') {
    throw new Error('L’école de démonstration est en période gratuite : aucun comptage du calendrier possible');
  }
  const lastFree = [sub.trialEnd, sub.pilotEnd].filter((d): d is Date => !!d).map(day).sort().pop() ?? '0000-01-01';

  const { year, items, version } = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;
    const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
    neuve = !(await tx.billingCount.findFirst({ where: { tenantId: tenant.id } }));
    // Jour du comptage : hier, ou le jour libre le plus proche avant (le second navigateur a le sien).
    const start = day(year.startDate);
    R = addDays(today, -1);
    while (R > lastFree && R > start && await tx.billingCount.findFirst({ where: { tenantId: tenant.id, yearLabel: year.label, kind: 'FIRST_REGULARIZATION', referenceDate: new Date(`${R}T00:00:00Z`) } })) R = addDays(R, -1);
    if (R <= lastFree || R <= addDays(start, 2)) throw new Error('Aucun jour libre pour le comptage fictif');
    const klass = await tx.class.findFirstOrThrow({ where: { academicYearId: year.id }, orderBy: { name: 'asc' } });
    // Trois élèves fictifs, propres à ce passage : l'un inscrit puis annulé par erreur de saisie, les deux autres partis
    // avant l'historique des inscriptions (inscription arrêtée sans aucune ligne d'historique), donc « À vérifier ».
    const pupil = async (key: 'exclu' | 'parti' | 'verif', lastName: string) => {
      const matricule = `E2E-G5B-${suffix}-${stamp}-${{ exclu: 1, parti: 2, verif: 3 }[key]}`;
      const status = key === 'exclu' ? 'ACTIVE' : 'WITHDRAWN';
      const s = await tx.student.create({ data: { tenantId: tenant.id, matricule, firstName: 'Élève', lastName, status } });
      eleves[key] = { nom: `${s.lastName} ${s.firstName}`, matricule };
      const e = await tx.enrollment.create({
        data: { tenantId: tenant.id, studentId: s.id, classId: klass.id, academicYearId: year.id, enrolledAt: year.startDate, type: 'NEW', status },
      });
      if (key === 'exclu') await tx.enrollmentEvent.create({ data: { tenantId: tenant.id, enrollmentId: e.id, kind: 'ENROLLED', data: { classId: klass.id, className: klass.name, type: 'NEW' }, createdAt: year.startDate } });
      return e;
    };
    const exclu = await pupil('exclu', `COMPTAGE EXCLUSION ${suffix}`);
    const parti = await pupil('parti', `COMPTAGE DEPART ${suffix}`);
    const verif = await pupil('verif', `COMPTAGE INTROUVABLE ${suffix}`);
    // Liste du comptage : les inscriptions actives de l'année inscrites au plus tard ce jour-là, celle annulée ensuite par
    // erreur (comptée ce jour-là), et les deux départs sans date (comptés et signalés).
    const active = await tx.enrollment.findMany({
      where: { academicYearId: year.id, status: 'ACTIVE', enrolledAt: { lte: endOfDay(R, tz) }, id: { notIn: [exclu.id, parti.id, verif.id] } },
      select: { id: true, classId: true, class: { select: { siteId: true } } },
    });
    const items = active.map((e) => ({ enrollmentId: e.id, classId: e.classId, siteId: e.class.siteId, counted: true, basis: 'ACTIVE', departureDate: null }));
    items.push({ enrollmentId: exclu.id, classId: exclu.classId, siteId: klass.siteId, counted: true, basis: 'ACTIVE', departureDate: null });
    for (const e of [parti, verif]) items.push({ enrollmentId: e.id, classId: e.classId, siteId: klass.siteId, counted: true, basis: 'DEPARTURE_UNKNOWN', departureDate: null });
    await tx.enrollment.update({ where: { id: exclu.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'Inscription saisie en double (fictive E2E)' } });
    await tx.enrollmentEvent.create({ data: { tenantId: tenant.id, enrollmentId: exclu.id, kind: 'CANCELLED', data: { reason: 'Inscription saisie en double (fictive E2E)', previousStatus: 'ACTIVE' } } });
    const last = await tx.billingCalendar.findFirst({ where: { tenantId: tenant.id, yearLabel: year.label }, orderBy: { version: 'desc' } });
    return { year, items, version: (last?.version ?? 0) + 1 };
  });

  const start = day(year.startDate);
  const initial = lastFree > start && lastFree < R ? lastFree : start;
  await db.billingCalendar.create({
    data: {
      tenantId: tenant.id, yearLabel: year.label, version, startDate: year.startDate, endDate: year.endDate, initialCountDate: new Date(`${initial}T00:00:00Z`),
      firstRegularizationDate: new Date(`${R}T00:00:00Z`), finalRegularizationDate: year.endDate, formula: 'MANUEL',
      reason: 'Calendrier fictif des tests de navigateur (lot G5b)', createdByName: 'Préparation des tests de navigateur',
    },
  });
  const [r] = await db.$queryRaw<{ count_pupils: number; count_review_until: Date }[]>`
    SELECT * FROM record_billing_count(${tenant.id}::uuid, ${year.id}::uuid, 'FIRST_REGULARIZATION', ${R}::date, 'PROVISIONAL', ${version}::int,
      ${JSON.stringify(items)}::jsonb, ${endOfDay(R, tz).toISOString()}::timestamptz, ${new Date().toISOString()}::timestamptz, ${today}::date)`;
  if (!r) throw new Error('Comptage fictif déjà enregistré pour ce jour');
  pupils = r.count_pupils;
  reviewUntil = day(r.count_review_until);
});

test.afterAll(async () => {
  await db.$disconnect();
});

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png`, fullPage: true });
}

async function tientEnLargeur(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

test('Direction : liste d’un comptage provisoire, exclusion d’une inscription annulée par erreur avec justificatif, décision, date d’un départ', async ({ page }) => {
  await connexion(page, COMPTES.direction);
  await page.goto('/espace/parametres?rubrique=abonnement');
  await page.getByRole('button', { name: 'Effectifs facturables' }).last().click();
  await expect(page.getByRole('heading', { name: 'Effectifs facturables', exact: true })).toBeVisible();
  await expect(page.getByText(`Vérification ouverte jusqu’au ${frDate(reviewUntil)} inclus.`, { exact: false }).first()).toBeVisible();
  await tientEnLargeur(page);
  await shot(page, 'g5b-1-comptages');

  // G5b-2 : les élèves partis sans date connue sont « À vérifier » sur la page même, hors de tout comptage : comptés tant
  // que la direction ne fixe pas leur date ou ne confirme pas qu'elle est introuvable, jamais retirés d'office.
  const dlg = page.getByRole('dialog');
  await expect(page.getByText('Aucun élève n’est retiré sans votre décision.', { exact: false })).toBeVisible();
  const aVerifier = (e: { matricule: string }) => page.getByRole('list', { name: /^Élèves à vérifier, année / }).locator(':scope > li', { hasText: e.matricule });
  for (const e of [eleves.parti, eleves.verif]) {
    await expect(aVerifier(e).getByText('À vérifier', { exact: true })).toBeVisible();
    await expect(aVerifier(e).getByRole('button', { name: `Fixer la date de départ de ${e.nom}` })).toBeVisible();
    await expect(aVerifier(e).getByRole('button', { name: `Date de départ introuvable pour ${e.nom}` })).toBeVisible();
  }
  // Date introuvable, confirmée avec une justification : l'élève reste compté, sans être « À vérifier » ; sa date peut
  // encore être fixée.
  await aVerifier(eleves.verif).getByRole('button', { name: `Date de départ introuvable pour ${eleves.verif.nom}` }).click();
  await expect(page.getByRole('dialog', { name: `Date de départ introuvable : ${eleves.verif.nom}` })).toBeVisible();
  await expect(dlg.getByText('L’élève reste compté, comme sans réponse', { exact: false })).toBeVisible();
  await dlg.getByLabel('Justification').fill('Registre des sorties et dossier consultés : aucune date (test de navigateur)');
  await shot(page, 'g5b-1b-date-introuvable');
  await dlg.getByRole('button', { name: 'Confirmer : date introuvable' }).click();
  await expect(dlg).toBeHidden();
  await expect(aVerifier(eleves.verif).getByText('Date introuvable confirmée', { exact: true })).toBeVisible();
  await expect(aVerifier(eleves.verif).getByRole('button', { name: `Date de départ introuvable pour ${eleves.verif.nom}` })).toHaveCount(0);
  await expect(aVerifier(eleves.verif).getByRole('button', { name: `Fixer la date de départ de ${eleves.verif.nom}` })).toBeVisible();
  await expect(aVerifier(eleves.parti).getByText('À vérifier', { exact: true })).toBeVisible();
  await tientEnLargeur(page);

  await page.getByRole('button', { name: `Voir la liste : Première régularisation du ${frDate(R)}, provisoire`, exact: true }).click();
  await expect(page.getByRole('heading', { name: `Première régularisation du ${frDate(R)}`, exact: true })).toBeVisible();
  await expect(page.getByText('Comptés', { exact: true }).locator('..')).toContainText(String(pupils));
  // Ce que donnerait le comptage figé maintenant : sur une base neuve, la même liste que le comptage provisoire ; quand la
  // base a déjà servi aux autres essais (téléphone, nouvel essai), seules les différences dues aux corrections comptent.
  const resume = page.getByText('Si la vérification se terminait maintenant', { exact: false });
  const lire = async () => {
    const t = (await resume.textContent()) ?? '';
    return { n: Number(/maintenant : (\d+) élève/.exec(t)?.[1] ?? NaN), retires: Number(/(\d+) retirés? /.exec(t)?.[1] ?? 0) };
  };
  await expect(resume).toBeVisible();
  const avant = await lire();
  if (neuve) {
    expect(avant).toEqual({ n: pupils, retires: 0 });
    await expect(resume).toContainText('Aucun ajout, aucun retrait.');
  }
  await tientEnLargeur(page);
  await shot(page, 'g5b-2-liste');

  // Exclusion : inscription annulée par erreur de saisie, justificatif joint ; elle attend la décision de la direction.
  await page.getByRole('group', { name: 'Afficher' }).getByRole('button', { name: /^Inscriptions annulées/ }).click();
  const exclu = page.locator('li', { hasText: eleves.exclu.matricule });
  await expect(exclu.getByText('Inscription annulée depuis : « Inscription saisie en double (fictive E2E) ».')).toBeVisible();
  await exclu.getByRole('button', { name: 'Demander l’exclusion' }).click();
  await expect(dlg.getByText('Un départ réel ne s’exclut jamais', { exact: false })).toBeVisible();
  await dlg.getByLabel('Justification').fill('Élève saisi deux fois : voir le registre (test de navigateur)');
  await dlg.locator('input[type=file]').setInputFiles({ name: 'registre.png', mimeType: 'image/png', buffer: PNG });
  await expect(dlg.getByText('registre.png')).toBeVisible();
  await shot(page, 'g5b-3-exclusion');
  await dlg.getByRole('button', { name: 'Demander l’exclusion' }).click();
  await expect(dlg).toBeHidden();
  // Dans « Demandes de correction » : le matricule y figure entre parenthèses.
  const demande = page.locator('li', { hasText: `(${eleves.exclu.matricule})` });
  await expect(demande.getByText('En attente de décision')).toBeVisible();
  await expect(demande.getByRole('link', { name: 'Justificatif' })).toBeVisible();
  // Décision : un refus exige un motif ; validée.
  await demande.getByRole('button', { name: 'Décider' }).click();
  await dlg.getByRole('button', { name: 'Refuser' }).click();
  await expect(dlg.getByText('Un refus exige un motif (5 caractères au moins).')).toBeVisible();
  await dlg.getByRole('button', { name: 'Valider l’exclusion' }).click();
  await expect(dlg).toBeHidden();
  await expect(demande.getByText('Validée', { exact: true })).toBeVisible();
  await expect(exclu.getByText('Exclusion validée.')).toBeVisible();
  await expect(exclu.getByText('Ne sera plus compté si la vérification se termine maintenant.')).toBeVisible();
  await expect(resume).toContainText(`maintenant : ${eleveTexte(avant.n - 1)}.`);

  // Départs enregistrés avant l'historique, sans date : comptés et signalés. Celui dont la date est confirmée introuvable
  // (page des effectifs) reste compté, sans être « À vérifier » ; pour l'autre, la direction fixe la date.
  await page.getByRole('group', { name: 'Afficher' }).getByRole('button', { name: /^À vérifier/ }).click();
  const verif = page.locator('li', { hasText: eleves.verif.matricule });
  await expect(verif.getByText('Date de départ confirmée introuvable : l’élève reste compté.', { exact: false })).toBeVisible();
  await expect(verif.getByText('Compté', { exact: true })).toBeVisible();
  await expect(verif.getByRole('button', { name: 'Date introuvable' })).toHaveCount(0);
  const confirmee = page.locator('li', { hasText: `(${eleves.verif.matricule})` });
  await expect(confirmee.getByText('Date de départ introuvable, confirmée (élève compté)')).toBeVisible();
  await expect(confirmee.getByText('hors comptage', { exact: false })).toBeVisible();
  await expect(confirmee.getByText('Validée', { exact: true })).toBeVisible();
  const parti = page.locator('li', { hasText: eleves.parti.matricule });
  await expect(parti.getByText('Aucune date de départ connue : l’élève reste compté tant que vous ne fixez pas sa date ou ne confirmez pas qu’elle est introuvable. Il n’est jamais retiré sans votre décision.')).toBeVisible();
  await expect(parti.getByRole('button', { name: 'Date introuvable' })).toBeVisible();
  await parti.getByRole('button', { name: 'Dater le départ' }).click();
  await dlg.getByLabel('Date du départ').fill(addDays(R, -2));
  await dlg.getByLabel('Justification').fill('Date relevée dans le registre des sorties (test de navigateur)');
  await shot(page, 'g5b-4-date-depart');
  await dlg.getByRole('button', { name: 'Enregistrer la date' }).click();
  await expect(dlg).toBeHidden();
  await expect(parti.getByText('Ne sera plus compté si la vérification se termine maintenant.')).toBeVisible();
  await expect(resume).toContainText(`maintenant : ${eleveTexte(avant.n - 2)}.`);
  await expect(resume).toContainText(`${avant.retires + 2} retirés (exclusion validée ou départ daté)`);
  const date = page.locator('li', { hasText: `(${eleves.parti.matricule})` });
  await expect(date.getByText(`Date de départ : ${frDate(addDays(R, -2))}`)).toBeVisible();
  await expect(date.getByText('Validée', { exact: true })).toBeVisible();
  await tientEnLargeur(page);
  // Capture sans les messages de confirmation (ils disparaissent seuls après quelques secondes).
  if (SHOTS) await expect(page.getByText('Date de départ enregistrée', { exact: true })).toBeHidden({ timeout: 10_000 });
  await shot(page, 'g5b-5-apres-corrections');
});

test('Super Admin : les nombres du comptage dans « Établissements clients », jamais un nom', async ({ page }) => {
  await page.goto('/plateforme/connexion');
  await page.getByLabel('Adresse e-mail').fill(saEmail);
  await page.getByLabel('Mot de passe').fill(SA_PW);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await page.getByRole('group', { name: 'Rubrique' }).getByRole('button', { name: 'Commercial et facturation', exact: true }).click();
  await page.getByRole('group', { name: 'Commercial et facturation' }).getByRole('button', { name: 'Établissements clients', exact: true }).click();
  const fiche = page.locator('li', { hasText: ecole }).filter({ hasText: 'Dernier comptage' }).first();
  await expect(fiche.getByText(/Dernier comptage : .* : \d+ élèves?/)).toBeVisible();
  await page.getByRole('button', { name: `Comptages des élèves de ${ecole}` }).click();
  const dlg = page.getByRole('dialog');
  const ligne = dlg.locator('li', { hasText: `Première régularisation du ${frDate(R)}` });
  await expect(ligne.getByText(eleveTexte(pupils), { exact: true })).toBeVisible();
  await expect(ligne.getByText(`Vérification par la direction jusqu’au ${frDate(reviewUntil)} inclus.`)).toBeVisible();
  await expect(dlg.getByText('Des nombres seulement', { exact: false })).toBeVisible();
  for (const e of Object.values(eleves)) {
    await expect(dlg.getByText(e.matricule)).toHaveCount(0);
    await expect(dlg.getByText(e.nom)).toHaveCount(0);
  }
  await tientEnLargeur(page);
  await shot(page, 'g5b-6-super-admin');
});
