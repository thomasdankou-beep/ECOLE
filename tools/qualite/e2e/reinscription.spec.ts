import { expect, Locator, Page, test } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { COMPTES } from './comptes';
import { connexion } from './connexion';

/**
 * Lot G4 : la réinscription à l'écran, au bureau et au téléphone. Base de test seulement, données entièrement fictives :
 * une année passée (2025-2026), sa classe « 5e A » et quelques élèves fictifs qui n'ont pas encore d'inscription pour
 * l'année en cours sont ajoutés, deux d'entre eux avec une facture fictive impayée ; l'année en cours du jeu de
 * démonstration ne change pas. Corrections du lot G4 : classe proposée à confirmer, frais impayés signalés sans bloquer,
 * cartes au téléphone, niveau suivant dans les paramètres.
 */
const url = process.env.DATABASE_ADMIN_URL ?? 'postgresql://erp_owner:erp_owner_dev@localhost:5432/erp_test';
if (!/\/erp_test(\?|$)/.test(url)) throw new Error('Base refusée : erp_test seulement');
const db = new PrismaClient({ datasources: { db: { url } } });
const SHOTS = process.env.E2E_SHOTS;

test.describe.configure({ mode: 'serial' });
// Captures pour le rapport seulement (E2E_SHOTS) : images nettes. Sans E2E_SHOTS, les appareils restent ceux de la configuration.
if (SHOTS) test.use({ deviceScaleFactor: 2 });

type Eleve = { matricule: string; lastName: string; firstName: string; sex: 'M' | 'F'; birthDate: string; admis?: boolean; impaye?: [number, number] };
/** Élèves fictifs de 2025-2026, différents pour chaque appareil (les deux passages partagent la même base). `impaye` : [total, payé]. */
const ELEVES: Record<string, [Eleve, Eleve, Eleve]> = {
  bureau: [
    { matricule: 'SKG-25-0101', lastName: 'HOUNGBO', firstName: 'Rodrigue', sex: 'M', birthDate: '2013-03-02', admis: true, impaye: [45_000, 15_000] },
    { matricule: 'SKG-25-0102', lastName: 'AHOUANDJINOU', firstName: 'Carine', sex: 'F', birthDate: '2013-04-08', impaye: [12_000, 0] },
    { matricule: 'SKG-25-0103', lastName: 'AKPOVI', firstName: 'Nadège', sex: 'F', birthDate: '2013-02-14' },
  ],
  telephone: [
    { matricule: 'SKG-25-0201', lastName: 'GBAGUIDI', firstName: 'Fiacre', sex: 'M', birthDate: '2013-05-11', admis: true, impaye: [45_000, 15_000] },
    { matricule: 'SKG-25-0202', lastName: 'TCHIBOZO', firstName: 'Sandrine', sex: 'F', birthDate: '2013-05-19', impaye: [12_000, 0] },
    { matricule: 'SKG-25-0203', lastName: 'KPADONOU', firstName: 'Edwige', sex: 'F', birthDate: '2013-01-23' },
  ],
};

let eleves: [Eleve, Eleve, Eleve];
let ids: Record<string, string> = {};
/**
 * Reste à payer et part échue de chaque élève fictif, lus dans la base comme l'API les calcule : une relance sur la
 * même base garde les factures créées au passage précédent (les factures d'une inscription annulée restent dues).
 */
let reste: Record<string, { du: number; echu: number }> = {};
const fcfa = (n: number) => `${new Intl.NumberFormat('fr-FR').format(n).replace(/[\u00a0\u202f]/g, ' ')} FCFA`;
const impayes = (r: { du: number; echu: number }) => `${fcfa(r.du)}${r.echu ? ` (dont ${fcfa(r.echu)} échus)` : ''}`;
/**
 * Relance sur la même base : l'inscription de l'année laissée par le passage précédent est annulée (jamais supprimée),
 * et le dossier retrouvé à l'inscription la montre comme dernière classe, « inscription annulée ». Base neuve : rien.
 */
let derniereAnnulee: Record<string, string> = {};
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
      const { admis, impaye, birthDate, ...identity } = e;
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
      // Facture fictive de 2025-2026, échue et pas entièrement payée : la réinscription doit la signaler sans bloquer.
      if (impaye) {
        const number = `E2E-IMPAYE-${e.matricule}`;
        if (!await tx.invoice.findFirst({ where: { number } })) await tx.invoice.create({
          data: {
            tenantId: tenant.id, number, studentId: s.id, label: 'Scolarité 2025-2026 (facture fictive de test)', total: impaye[0], paid: impaye[1],
            dueDate: new Date('2026-02-05'), status: impaye[1] ? 'PARTIAL' : 'OPEN', createdById: direction.id,
          },
        });
      }
      // Nouvel essai sur la même base (relance, ou nouvelle tentative en CI) : l'inscription de l'année laissée par le
      // passage précédent est annulée (jamais supprimée), avec sa ligne d'historique (la base refuse un changement
      // d'inscription sans historique), pour que l'élève redevienne « à réinscrire ».
      const left = await tx.enrollment.findMany({ where: { studentId: s.id, academicYearId: current.id, status: { not: 'CANCELLED' } } });
      for (const l of left) {
        const reason = 'Remise à zéro avant un nouveau passage des tests de navigateur';
        await tx.enrollment.update({ where: { id: l.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason, cancelledById: direction.id } });
        await tx.enrollmentEvent.create({
          data: { tenantId: tenant.id, enrollmentId: l.id, kind: 'CANCELLED', data: { reason, previousStatus: l.status, classId: l.classId }, actorId: direction.id, actorName: 'Tests de navigateur' },
        });
      }
      const derniere = await tx.enrollment.findFirst({
        where: { studentId: s.id }, orderBy: { academicYear: { startDate: 'desc' } }, include: { class: { include: { site: true } }, academicYear: true },
      });
      if (derniere?.status === 'CANCELLED') {
        derniereAnnulee[e.matricule] = `Dernière classe : ${derniere.class.name} · ${derniere.class.site.name} (${derniere.academicYear.label}), inscription annulée`;
      }
      // Reste dû : factures non annulées ; part échue : factures ouvertes dont l'échéance est passée, au jour de l'école.
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Porto-Novo' }).format(new Date());
      const factures = await tx.invoice.findMany({ where: { studentId: s.id, status: { not: 'CANCELLED' } } });
      reste[e.matricule] = {
        du: factures.reduce((n, f) => n + f.total - f.paid, 0),
        echu: factures.filter((f) => f.status !== 'PAID' && f.dueDate.toISOString().slice(0, 10) < today).reduce((n, f) => n + Math.max(0, f.total - f.paid), 0),
      };
    }
    return out;
  });
});

test.afterAll(async () => {
  await db.$disconnect();
});

const auTelephone = () => test.info().project.name === 'telephone';

/** Capture pour le rapport : la page entière (depuis le haut), ou l'écran seul quand une fenêtre de dialogue est ouverte. */
async function shot(page: Page, name: string, fullPage = true) {
  if (!SHOTS) return;
  // La page finit de charger ses autres rubriques avant la capture, pour une image entière.
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
  // En haut de page : l'en-tête fixe ne se retrouve pas au milieu de l'image.
  if (fullPage) await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png`, fullPage });
}

/** Choisit l'option de la liste dont le texte commence par `debut` (les effectifs entre parenthèses changent). */
async function choisir(select: Locator, debut: string) {
  const value = await select.locator('option', { hasText: debut }).first().getAttribute('value');
  await select.selectOption(value!);
}

/** Un élève de la liste des réinscriptions : une carte au téléphone, une ligne du tableau au bureau. */
const ligneEleve = (page: Page, matricule: string) =>
  auTelephone() ? page.locator(`li[data-matricule="${matricule}"]`) : page.locator('tr', { hasText: matricule });

/**
 * Au téléphone, rien dans la page ne défile de côté (ni la page, ni un tableau). Les rangées de pastilles (rubriques,
 * vues) se font glisser du doigt, par conception : elles ne comptent pas.
 */
async function sansDefilementDeCote(page: Page) {
  if (!auTelephone()) return;
  const deborde = await page.evaluate(() => {
    const page = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
    const blocs = [...document.querySelectorAll('main *')].filter((el) => {
      const style = getComputedStyle(el);
      return el.getAttribute('role') !== 'group' && (style.overflowX === 'auto' || style.overflowX === 'scroll')
        && el.scrollWidth > el.clientWidth + 1 && (el as HTMLElement).offsetParent !== null;
    }).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 3).join('.')}`);
    return { page, blocs };
  });
  expect(deborde).toEqual({ page: false, blocs: [] });
}

test('Secrétariat : onglet Réinscriptions, classe proposée à confirmer, impayé signalé, parcours conservé', async ({ page }) => {
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
  const ligne = ligneEleve(page, p1.matricule);
  await expect(ligne.getByText('5e A · Togbin')).toBeVisible();
  await expect(ligne.getByText('Admis', { exact: true })).toBeVisible();
  // Admis, 5e → 4e (passage du jeu de démonstration) : 4e A, même site et même lettre.
  await expect(ligne.getByText('4e A', { exact: true })).toBeVisible();
  // Reste à payer : 45 000 − 15 000 = 30 000 F, échus (facture fictive du 05/02/2026), sur une base neuve. Le
  // secrétariat voit les finances.
  await expect(ligne.getByText(fcfa(reste[p1.matricule].du)).first()).toBeVisible();
  await expect(ligne.getByText(`dont ${fcfa(reste[p1.matricule].echu)} échus`)).toBeVisible();
  await expect(page.getByText('1 élève(s) ont des frais impayés.')).toBeVisible();
  await expect(page.getByText(/La réinscription n’est pas bloquée : appliquez les règles financières de votre établissement/)).toBeVisible();
  await sansDefilementDeCote(page);
  await ligne.getByLabel(`Sélectionner ${nom}`).check();
  await expect(page.getByText('1 élève(s) sélectionné(s)')).toBeVisible();
  await shot(page, 'g4-1-onglet-reinscriptions');

  await page.getByRole('button', { name: 'Réinscrire la sélection' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByText(`Réinscrire ${nom}`)).toBeVisible();
  await expect(dlg.getByText('Pour 2026-2027, sur le dossier existant : même matricule, historique conservé.')).toBeVisible();
  await expect(dlg.getByText('Admis : classe supérieure (4e) : 4e A · Togbin.')).toBeVisible();
  await expect(dlg.getByText('Cet élève a des frais impayés.')).toBeVisible();
  await expect(dlg.getByText(`Frais impayés : ${impayes(reste[p1.matricule])}`)).toBeVisible();
  // La classe proposée est déjà choisie, mais rien ne part sans la confirmation.
  const classe = dlg.getByLabel('Classe 2026-2027');
  await expect(classe.locator('option:checked')).toHaveText(/^4e A · Togbin/);
  const valider = dlg.getByRole('button', { name: 'Réinscrire', exact: true });
  await expect(valider).toBeDisabled();
  // Une autre classe peut être choisie : l'écart avec la proposition est affiché.
  await choisir(classe, '6e A ·');
  await expect(dlg.getByText('Vous avez choisi 6e A au lieu de la classe proposée (4e A).')).toBeVisible();
  await choisir(classe, '4e A ·');
  await expect(dlg.getByText(/Vous avez choisi/)).toHaveCount(0);
  await dlg.getByLabel('Je confirme la classe choisie').check();
  await expect(valider).toBeEnabled();
  await shot(page, 'g4-2-classe-a-confirmer', false);
  await valider.click();
  await expect(dlg.getByText('1 élève(s) réinscrit(s) en 4e A.')).toBeVisible();
  await dlg.locator('button', { hasText: 'Fermer' }).click(); // le bouton du bas (la croix porte le même nom)
  await expect(dlg).toBeHidden();
  await expect(ligneEleve(page, p1.matricule)).toHaveCount(0);

  // Le dossier : même matricule, la classe de l'année et le parcours des deux années, avec ce qui a été vérifié.
  await page.goto(`/espace/eleves/${ids[p1.matricule]}`);
  await expect(page.getByRole('heading', { name: nom })).toBeVisible();
  await expect(page.getByText(`${p1.matricule} · 4e A · Togbin`)).toBeVisible();
  const parcours = page.getByRole('heading', { name: 'Parcours' }).locator('xpath=ancestor::*[self::section or self::div][1]/..');
  const cetteAnnee = parcours.locator('li', { hasText: '2026-2027' }).first();
  await expect(cetteAnnee.getByText('Réinscription', { exact: true })).toBeVisible();
  await expect(cetteAnnee.getByText(/Réinscription en 4e A \(venant de 5e A, 2025-2026\) · classe proposée confirmée · frais impayés signalés/)).toBeVisible();
  await expect(parcours.locator('li', { hasText: '2025-2026 · 5e A (Togbin)' }).first().getByText('Année terminée')).toBeVisible();
  await shot(page, 'g4-3-parcours');
});

test('Secrétariat : un élève qui a déjà un dossier passe par la même confirmation ; sinon, un motif pour la direction', async ({ page }) => {
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
  await expect(fiche.getByText(derniereAnnulee[p2.matricule] ?? 'Dernière classe : 5e A · Togbin (2025-2026)', { exact: true })).toBeVisible();
  await shot(page, 'g4-4-dossier-qui-ressemble', false);
  await fiche.getByRole('button', { name: 'Réinscrire sur ce dossier' }).click();
  // Même fenêtre que l'onglet Réinscriptions : pas de décision de fin d'année, la classe du formulaire reste choisie,
  // l'impayé est signalé, et la classe se confirme.
  await expect(dlg.getByText(`Réinscrire ${p2.lastName} ${p2.firstName}`)).toBeVisible();
  await expect(dlg.getByText('Aucune décision de fin d’année enregistrée : choisissez la classe.')).toBeVisible();
  await expect(dlg.getByText('Cet élève a des frais impayés.')).toBeVisible();
  await expect(dlg.getByText(`Frais impayés : ${impayes(reste[p2.matricule])}`)).toBeVisible();
  await expect(dlg.getByLabel('Classe 2026-2027').locator('option:checked')).toHaveText(/^4e A · Togbin/);
  await expect(dlg.getByRole('button', { name: 'Réinscrire', exact: true })).toBeDisabled();
  await dlg.getByLabel('Je confirme la classe choisie').check();
  await shot(page, 'g4-5-confirmation-depuis-la-saisie', false);
  await dlg.getByRole('button', { name: 'Réinscrire', exact: true }).click();
  await expect(page.getByText('Réinscription enregistrée')).toBeVisible();
  await expect(page.getByText(new RegExp(`${p2.lastName} ${p2.firstName} est réinscrit\\(e\\) en 4e A pour 2026-2027`))).toBeVisible();
  await expect(page.getByText(p2.matricule, { exact: false })).toBeVisible();

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
  // La carte de la paire signalée à l'inscription (nouveau dossier et dossier d'origine), sans les blocs qui l'englobent
  // avec la liste des décisions. Sur une base déjà utilisée, le nouveau dossier ressemble aussi à celui du passage
  // précédent : cette autre paire reste à trancher, c'est normal.
  const paire = () => page.locator('div').filter({ hasText: nouveau }).filter({ hasText: p3.matricule }).filter({ hasNotText: 'Dernières décisions' })
    .filter({ has: page.getByRole('button', { name: 'Élèves différents' }) });
  const carte = paire().last();
  await expect(carte.getByText('même nom et même date de naissance')).toBeVisible();
  await expect(carte.getByText(p3.matricule)).toBeVisible();
  await expect(carte.getByText(/Homonyme : autre famille/)).toBeVisible();
  await shot(page, 'g4-6-doublons-a-verifier');
  await carte.getByRole('button', { name: 'Élèves différents' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Note (facultatif)').fill('Vérifié avec les deux familles (données fictives)');
  await dlg.getByRole('button', { name: 'Enregistrer la décision' }).click();
  await expect(dlg).toBeHidden();
  // Dernières décisions : une carte au téléphone, une ligne du tableau au bureau.
  const decision = auTelephone() ? page.locator('li', { hasText: nouveau }) : page.locator('tr', { hasText: nouveau });
  await expect(decision.getByText('Élèves différents')).toBeVisible();
  await expect(paire()).toHaveCount(0);
  await sansDefilementDeCote(page);
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
  await shot(page, 'g4-8-inscription-annulee');

  // Depuis le dossier aussi, la réinscription propose la classe et signale l'impayé (fenêtre fermée sans valider).
  await page.getByRole('button', { name: 'Réinscrire pour 2026-2027' }).click();
  const reinscrire = page.getByRole('dialog');
  await expect(reinscrire.getByText('Admis : classe supérieure (4e) : 4e A · Togbin.')).toBeVisible();
  await expect(reinscrire.getByText('Cet élève a des frais impayés.')).toBeVisible();
  await expect(reinscrire.getByRole('button', { name: 'Réinscrire', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(reinscrire).toBeHidden();
  await expect(page.getByText(`${p1.matricule} · Sans classe`)).toBeVisible();
});

test('Direction : Paramètres › Niveaux, le niveau suivant d’un élève admis se définit et se retire', async ({ page }) => {
  await connexion(page, COMPTES.direction);
  await page.goto('/espace/parametres?rubrique=structure');
  const niveaux = page.getByRole('heading', { name: 'Niveaux', exact: true }).locator('xpath=../..');
  await expect(niveaux.getByText(/La flèche indique le niveau suivant d’un élève admis/)).toBeVisible();
  await expect(niveaux.getByText('5e · Collège → 4e', { exact: true })).toBeVisible();
  const dlg = page.getByRole('dialog');
  const enregistrer = async () => { await dlg.getByRole('button', { name: 'Enregistrer' }).click(); await expect(dlg).toBeHidden(); };

  // CM2 (aucun autre test ne s'en sert) : retiré, puis remis à 6e, depuis n'importe quel état de départ.
  await niveaux.getByRole('button', { name: 'Modifier CM2', exact: true }).click();
  await dlg.getByLabel('Niveau suivant d’un élève admis').selectOption({ label: 'Aucun (pas de proposition)' });
  await enregistrer();
  await expect(niveaux.getByText('CM2 · Primaire', { exact: true })).toBeVisible();
  await niveaux.getByRole('button', { name: 'Modifier CM2', exact: true }).click();
  await expect(dlg.getByLabel('Niveau suivant d’un élève admis').locator('option:checked')).toHaveText('Aucun (pas de proposition)');
  // Un niveau ne se propose pas lui-même comme niveau suivant.
  await expect(dlg.getByLabel('Niveau suivant d’un élève admis').locator('option', { hasText: /^CM2 ·/ })).toHaveCount(0);
  await dlg.getByLabel('Niveau suivant d’un élève admis').selectOption({ label: '6e · Collège' });
  await shot(page, 'g4-9-niveau-suivant', false);
  await enregistrer();
  await expect(niveaux.getByText('CM2 · Primaire → 6e', { exact: true })).toBeVisible();
  await sansDefilementDeCote(page);
});
