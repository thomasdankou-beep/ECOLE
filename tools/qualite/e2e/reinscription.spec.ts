import { expect, Locator, Page, test } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { COMPTES } from './comptes';
import { connexion } from './connexion';

/**
 * Lot G4 : la réinscription à l'écran, au bureau et au téléphone. Base de test seulement, données entièrement fictives :
 * une année passée (2025-2026), sa classe « 5e A » et quelques élèves fictifs qui n'ont pas encore d'inscription pour
 * l'année en cours sont ajoutés ; l'année en cours du jeu de démonstration ne change pas.
 */
const url = process.env.DATABASE_ADMIN_URL ?? 'postgresql://erp_owner:erp_owner_dev@localhost:5432/erp_test';
if (!/\/erp_test(\?|$)/.test(url)) throw new Error('Base refusée : erp_test seulement');
const db = new PrismaClient({ datasources: { db: { url } } });
const SHOTS = process.env.E2E_SHOTS;

test.describe.configure({ mode: 'serial' });
// Captures pour le rapport seulement (E2E_SHOTS) : images nettes. Sans E2E_SHOTS, les appareils restent ceux de la configuration.
if (SHOTS) test.use({ deviceScaleFactor: 2 });

type Eleve = { matricule: string; lastName: string; firstName: string; sex: 'M' | 'F'; birthDate: string; admis?: boolean };
/** Élèves fictifs de 2025-2026, différents pour chaque appareil (les deux passages partagent la même base). */
const ELEVES: Record<string, [Eleve, Eleve, Eleve]> = {
  bureau: [
    { matricule: 'SKG-25-0101', lastName: 'HOUNGBO', firstName: 'Rodrigue', sex: 'M', birthDate: '2013-03-02', admis: true },
    { matricule: 'SKG-25-0102', lastName: 'AHOUANDJINOU', firstName: 'Carine', sex: 'F', birthDate: '2013-04-08' },
    { matricule: 'SKG-25-0103', lastName: 'AKPOVI', firstName: 'Nadège', sex: 'F', birthDate: '2013-02-14' },
  ],
  telephone: [
    { matricule: 'SKG-25-0201', lastName: 'GBAGUIDI', firstName: 'Fiacre', sex: 'M', birthDate: '2013-05-11', admis: true },
    { matricule: 'SKG-25-0202', lastName: 'TCHIBOZO', firstName: 'Sandrine', sex: 'F', birthDate: '2013-05-19' },
    { matricule: 'SKG-25-0203', lastName: 'KPADONOU', firstName: 'Edwige', sex: 'F', birthDate: '2013-01-23' },
  ],
};

let eleves: [Eleve, Eleve, Eleve];
let ids: Record<string, string> = {};
let telephoneParent = '';
/** Matricule du nouvel élève inscrit malgré la ressemblance (test 2), dont la direction tranche le cas (test 3). */
let nouveau = '';

test.beforeAll(async ({}, info) => {
  eleves = ELEVES[info.project.name] ?? ELEVES.bureau;
  telephoneParent = info.project.name === 'telephone' ? '0196550201' : '0196550101';
  const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: 'saint-kisito' } });
  if ((tenant.settings as any)?.demo !== true) throw new Error("L'école de test n'est pas l'école de démonstration");
  ids = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;
    const year = await tx.academicYear.findFirst({ where: { label: '2025-2026' } })
      ?? await tx.academicYear.create({ data: { tenantId: tenant.id, label: '2025-2026', startDate: new Date('2025-09-15'), endDate: new Date('2026-07-03') } });
    const current = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
    const togbin = await tx.site.findFirstOrThrow({ where: { name: 'Togbin' } });
    const level = await tx.level.findFirstOrThrow({ where: { name: '5e' } });
    const direction = await tx.user.findFirstOrThrow({ where: { phone: COMPTES.direction } });
    const klass = await tx.class.findFirst({ where: { academicYearId: year.id, name: '5e A' } })
      ?? await tx.class.create({ data: { tenantId: tenant.id, academicYearId: year.id, siteId: togbin.id, levelId: level.id, name: '5e A', capacity: 50 } });
    const out: Record<string, string> = {};
    for (const e of eleves) {
      const { admis, birthDate, ...identity } = e;
      const s = await tx.student.findFirst({ where: { matricule: e.matricule } })
        ?? await tx.student.create({ data: { tenantId: tenant.id, ...identity, birthDate: new Date(birthDate) } });
      out[e.matricule] = s.id;
      const past = await tx.enrollment.findFirst({ where: { studentId: s.id, academicYearId: year.id } });
      if (!past) await tx.enrollment.create({ data: { tenantId: tenant.id, studentId: s.id, classId: klass.id, academicYearId: year.id } });
      if (admis) await tx.annualDecision.upsert({
        where: { studentId_academicYearId: { studentId: s.id, academicYearId: year.id } },
        update: {},
        create: { tenantId: tenant.id, studentId: s.id, academicYearId: year.id, classId: klass.id, outcome: 'ADMIS', decidedById: direction.id },
      });
      // Nouvel essai sur la même base (relance, ou nouvelle tentative en CI) : l'inscription de l'année laissée par le
      // passage précédent est annulée (jamais supprimée), pour que l'élève redevienne « à réinscrire ».
      await tx.enrollment.updateMany({
        where: { studentId: s.id, academicYearId: current.id, status: { not: 'CANCELLED' } },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'Remise à zéro avant un nouveau passage des tests de navigateur' },
      });
    }
    return out;
  });
});

test.afterAll(async () => {
  await db.$disconnect();
});

/** Capture pour le rapport : la page entière, ou l'écran seul quand une fenêtre de dialogue est ouverte. */
async function shot(page: Page, name: string, fullPage = true) {
  if (!SHOTS) return;
  // La page finit de charger ses autres rubriques avant la capture, pour une image entière.
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png`, fullPage });
}

/** Choisit l'option de la liste dont le texte commence par `debut` (les effectifs entre parenthèses changent). */
async function choisir(select: Locator, debut: string) {
  const value = await select.locator('option', { hasText: debut }).first().getAttribute('value');
  await select.selectOption(value!);
}

test('Secrétariat : onglet Réinscriptions, réinscription sur le dossier existant, parcours conservé', async ({ page }) => {
  const [p1] = eleves;
  const nom = `${p1.lastName} ${p1.firstName}`;
  await connexion(page, COMPTES.secretariat);
  await page.goto('/espace/eleves?vue=reinscriptions');
  const vues = page.getByRole('group', { name: 'Vue' });
  await expect(vues.getByRole('button', { name: 'Réinscriptions' })).toHaveAttribute('aria-pressed', 'true');
  // Le secrétariat ne tranche pas les doublons : l'onglet n'apparaît pas.
  await expect(vues.getByRole('button', { name: 'Doublons possibles' })).toHaveCount(0);
  await expect(page.getByText('Réinscriptions pour 2026-2027')).toBeVisible();
  await expect(page.getByText(/Élèves de 2025-2026 qui n’ont pas encore d’inscription pour 2026-2027/)).toBeVisible();

  await page.getByLabel('Rechercher un élève à réinscrire').fill(p1.lastName);
  const ligne = page.locator('tr', { hasText: p1.matricule });
  await expect(ligne.getByText('5e A · Togbin')).toBeVisible();
  await expect(ligne.getByText('Admis', { exact: true })).toBeVisible();
  await ligne.getByLabel(`Sélectionner ${nom}`).check();
  await expect(page.getByText('1 élève(s) sélectionné(s)')).toBeVisible();
  await shot(page, 'g4-1-onglet-reinscriptions');

  await page.getByRole('button', { name: 'Réinscrire la sélection' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByText(`Réinscrire ${nom}`)).toBeVisible();
  await expect(dlg.getByText('Pour 2026-2027, sur le dossier existant : même matricule, historique conservé.')).toBeVisible();
  await choisir(dlg.getByLabel('Classe 2026-2027'), '4e A ·');
  await dlg.getByRole('button', { name: 'Réinscrire', exact: true }).click();
  await expect(dlg.getByText('1 élève(s) réinscrit(s) en 4e A.')).toBeVisible();
  await shot(page, 'g4-2-reinscription-faite', false);
  await dlg.locator('button', { hasText: 'Fermer' }).click(); // le bouton du bas (la croix porte le même nom)
  await expect(dlg).toBeHidden();
  await expect(page.locator('tr', { hasText: p1.matricule })).toHaveCount(0);

  // Le dossier : même matricule, la classe de l'année et le parcours des deux années.
  await page.goto(`/espace/eleves/${ids[p1.matricule]}`);
  await expect(page.getByRole('heading', { name: nom })).toBeVisible();
  await expect(page.getByText(`${p1.matricule} · 4e A · Togbin`)).toBeVisible();
  const parcours = page.getByRole('heading', { name: 'Parcours' }).locator('xpath=ancestor::*[self::section or self::div][1]/..');
  const cetteAnnee = parcours.locator('li', { hasText: '2026-2027' }).first();
  await expect(cetteAnnee.getByText('Réinscription', { exact: true })).toBeVisible();
  await expect(cetteAnnee.getByText(/Réinscription en 4e A \(venant de 5e A, 2025-2026\)/)).toBeVisible();
  await expect(parcours.locator('li', { hasText: '2025-2026 · 5e A (Togbin)' }).first().getByText('Année terminée')).toBeVisible();
  await shot(page, 'g4-3-parcours');
});

test('Secrétariat : un élève qui a déjà un dossier est proposé à la réinscription ; sinon, un motif pour la direction', async ({ page }) => {
  const [, p2, p3] = eleves;
  await connexion(page, COMPTES.secretariat);
  await page.goto('/espace/inscription');
  const remplir = async (e: Eleve) => {
    const eleve = page.getByRole('heading', { name: 'L’élève' }).locator('..');
    await eleve.getByLabel('Nom', { exact: true }).fill(e.lastName);
    await eleve.getByLabel('Prénoms', { exact: true }).fill(e.firstName);
    await eleve.getByLabel('Date de naissance').fill(e.birthDate);
    await choisir(eleve.getByLabel(/^Classe/), '4e A ·'); // le nom d'une liste comprend l'option affichée
    const parents = page.getByRole('heading', { name: 'Parents et tuteurs' }).locator('xpath=../..');
    await parents.getByLabel('Nom', { exact: true }).fill(e.lastName);
    await parents.getByLabel('Prénoms', { exact: true }).fill('Parent fictif');
    await parents.getByLabel('Téléphone').fill(telephoneParent);
    await page.getByRole('button', { name: 'Enregistrer l’inscription' }).click();
  };

  // Même nom et même date de naissance qu'un élève de l'an dernier : l'inscription s'arrête et propose son dossier.
  await remplir(p2);
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByText('Un dossier ressemble à cet élève')).toBeVisible();
  const fiche = dlg.locator('div', { hasText: p2.matricule }).filter({ has: page.getByRole('button', { name: 'Réinscrire sur ce dossier' }) }).last();
  await expect(fiche.getByText('même nom et même date de naissance', { exact: false })).toBeVisible();
  await expect(fiche.getByText('Dernière classe : 5e A · Togbin (2025-2026)')).toBeVisible();
  await shot(page, 'g4-4-dossier-qui-ressemble', false);
  await fiche.getByRole('button', { name: 'Réinscrire sur ce dossier' }).click();
  await expect(page.getByText('Réinscription enregistrée')).toBeVisible();
  await expect(page.getByText(new RegExp(`${p2.lastName} ${p2.firstName} est réinscrit\\(e\\) en 4e A pour 2026-2027`))).toBeVisible();
  await expect(page.getByText(p2.matricule, { exact: false })).toBeVisible();
  await shot(page, 'g4-5-reinscription-depuis-la-saisie');

  // Un homonyme : « ce n'est pas le même élève », avec un motif ; le dossier est créé et la direction vérifiera.
  await page.getByRole('button', { name: 'Nouvelle inscription' }).click();
  await remplir(p3);
  await expect(dlg.getByText('Un dossier ressemble à cet élève')).toBeVisible();
  await dlg.getByLabel('Pourquoi (la direction vérifiera)').fill('Homonyme : autre famille, vérifié sur l’extrait de naissance (données fictives)');
  await dlg.getByRole('button', { name: 'Inscrire comme nouvel élève' }).click();
  await expect(page.getByText('Inscription enregistrée')).toBeVisible();
  nouveau = (await page.locator('p', { hasText: 'Matricule attribué' }).locator('span.font-mono').innerText()).trim();
  expect(nouveau).toMatch(/^SKG-/);
  expect(nouveau).not.toBe(p3.matricule);
});

test('Direction : doublons possibles, décision sans fusion, puis annulation d’une inscription avec son motif', async ({ page }) => {
  const [p1, , p3] = eleves;
  await connexion(page, COMPTES.direction);
  await page.goto('/espace/eleves?vue=doublons');
  const carte = page.locator('div').filter({ hasText: nouveau }).filter({ has: page.getByRole('button', { name: 'Élèves différents' }) }).last();
  await expect(carte.getByText('même nom et même date de naissance')).toBeVisible();
  await expect(carte.getByText(p3.matricule)).toBeVisible();
  await expect(carte.getByText(/Homonyme : autre famille/)).toBeVisible();
  await shot(page, 'g4-6-doublons-a-verifier');
  await carte.getByRole('button', { name: 'Élèves différents' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Note (facultatif)').fill('Vérifié avec les deux familles (données fictives)');
  await dlg.getByRole('button', { name: 'Enregistrer la décision' }).click();
  await expect(dlg).toBeHidden();
  const decision = page.locator('tr', { hasText: nouveau });
  await expect(decision.getByText('Élèves différents')).toBeVisible();
  await expect(page.locator('div').filter({ hasText: nouveau }).filter({ has: page.getByRole('button', { name: 'Élèves différents' }) })).toHaveCount(0);
  await shot(page, 'g4-7-decision-enregistree');

  // Annulation par la direction : rien n'est supprimé, l'inscription reste dans le parcours, marquée annulée.
  await page.goto(`/espace/eleves/${ids[p1.matricule]}`);
  await page.getByRole('button', { name: 'Annuler l’inscription' }).click();
  const annuler = page.getByRole('dialog');
  await expect(annuler.getByText(/Rien n’est supprimé/)).toBeVisible();
  await annuler.getByLabel('Motif de l’annulation').fill('Réinscription saisie pour le test (données fictives)');
  await annuler.getByRole('button', { name: 'Annuler l’inscription' }).click();
  await expect(annuler).toBeHidden();
  await expect(page.getByText(`${p1.matricule} · Sans classe`)).toBeVisible();
  const ligne = page.locator('li', { hasText: '2026-2027' }).filter({ hasText: 'Inscription annulée' }).first();
  await expect(ligne.getByText(/Annulée le .* : Réinscription saisie pour le test/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Réinscrire pour 2026-2027' })).toBeVisible();
  await shot(page, 'g4-8-inscription-annulee');
});
