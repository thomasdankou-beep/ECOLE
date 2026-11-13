/**
 * Corrections du lot G4 (retour de Dankou du 13 novembre 2026), de bout en bout sur la base de test (erp_test) et des
 * données entièrement fictives :
 * 1. frais impayés signalés à la réinscription, sans la bloquer ; montants pour qui voit les finances ;
 * 2. classe proposée (admis : niveau suivant ; non admis : même niveau), confirmée ou changée avant validation ;
 * 3. sortie datée du jour de référence : l'élève n'est plus actif à la fin de ce jour ; dates et historique gardés ;
 * 4. élèves facturables à une date passée reconstruits depuis l'historique, jamais depuis l'état actuel seul ;
 * 6. contrôles d'accès entre établissements et entre sites, et garde de l'historique par la base elle-même.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { billableEnrollments } from '../src/modules/students/enrollments';

const PASSWORD = 'Kisito2026';
const PHONES = { direction: '+2290190000010', secretariat: '+2290190000011', teacher: '+2290190000001', comptable: '+2290190000013' };
const TZ = 'Africa/Porto-Novo';

let app: INestApplication;
let http: ReturnType<typeof request>;
const admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_ADMIN_URL } } });
const appDb = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
const tokens: Record<string, string> = {};
let tenantId = '';
let otherTenantId = '';
const sites: Record<string, string> = {};
const levels: Record<string, string> = {};
let year1 = '';
let year2 = '';
const classes: Record<string, string> = {};

/** Jour (AAAA-MM-JJ, UTC) décalé de `offset` jours. */
const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
/** Jour à l'heure de l'école, décalé de `offset` jours. */
const schoolDay = (offset = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() + offset * 86_400_000));

async function login(identifier: string) {
  const r = await http.post('/api/v1/auth/login').send({ tenant: 'saint-kisito', identifier, password: PASSWORD });
  expect(r.status).toBe(200);
  return r.body.accessToken as string;
}
const as = (who: string) => ({
  get: (url: string) => http.get(`/api/v1${url}`).set('Authorization', `Bearer ${tokens[who]}`),
  post: (url: string, body?: object) => http.post(`/api/v1${url}`).set('Authorization', `Bearer ${tokens[who]}`).send(body ?? {}),
  patch: (url: string, body?: object) => http.patch(`/api/v1${url}`).set('Authorization', `Bearer ${tokens[who]}`).send(body ?? {}),
});
function inTenant<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, tid = tenantId, client = admin) {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tid}, true)`;
    return fn(tx);
  });
}
const sid = async (matricule: string) => (await inTenant((tx) => tx.student.findFirstOrThrow({ where: { matricule }, select: { id: true } }))).id;
const userId = async (phone: string) => (await inTenant((tx) => tx.user.findFirstOrThrow({ where: { phone }, select: { id: true } }))).id;
async function secretariatSites(siteId: string | null) {
  const id = await userId(PHONES.secretariat);
  await inTenant((tx) => tx.userRole.updateMany({ where: { userId: id, role: 'SECRETARIAT' }, data: { siteId } }));
  tokens.secretariat = await login(PHONES.secretariat);
}
/** Impayés attendus d'après les factures (même définition que l'application) : reste dû, et part échue au jour de l'école. */
async function expectedDebt(studentId: string) {
  const invoices = await inTenant((tx) => tx.invoice.findMany({ where: { studentId, status: { not: 'CANCELLED' } } }));
  const today = schoolDay();
  const due = invoices.reduce((n, i) => n + i.total - i.paid, 0);
  const overdue = invoices.filter((i) => (i.status === 'OPEN' || i.status === 'PARTIAL') && i.dueDate.toISOString().slice(0, 10) < today).reduce((n, i) => n + Math.max(0, i.total - i.paid), 0);
  return { due, overdue };
}

beforeAll(async () => {
  execSync('npx ts-node --transpile-only prisma/seed.ts', { env: process.env, stdio: 'ignore', cwd: `${__dirname}/..` });
  tenantId = (await admin.tenant.findUniqueOrThrow({ where: { slug: 'saint-kisito' } })).id;
  const other = await admin.tenant.findUnique({ where: { slug: 'autre-ecole-g4' } })
    ?? await admin.tenant.create({ data: { slug: 'autre-ecole-g4', name: 'Autre école G4 (fictive)', group: { create: { name: 'Autre école G4 (fictive)' } } } });
  otherTenantId = other.id;
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  configureApp(app);
  await app.init();
  app.get(NotificationsService).fallbackDelayMs = 50;
  http = request(app.getHttpServer());
  for (const [k, phone] of Object.entries(PHONES)) tokens[k] = await login(phone);
  const settings = (await as('direction').get('/settings')).body;
  for (const s of settings.sites) sites[s.name] = s.id;
  for (const l of settings.levels) levels[l.name] = l.id;
  year1 = settings.currentYear.id;
  const f3 = settings.tracks.find((t: any) => t.code === 'F3').id;
  const f4 = settings.tracks.find((t: any) => t.code === 'F4').id;

  // Décisions de fin d'année 2026-2027 (fictives), avant d'ouvrir l'année suivante.
  const director = await userId(PHONES.direction);
  const decide = async (matricule: string, outcome: 'ADMIS' | 'NON_ADMIS') => {
    const id = await sid(matricule);
    const e = await inTenant((tx) => tx.enrollment.findFirstOrThrow({ where: { studentId: id, academicYearId: year1 } }));
    await inTenant((tx) => tx.annualDecision.create({ data: { tenantId, studentId: id, academicYearId: year1, classId: e.classId, outcome, decidedById: director } }));
  };
  await decide('SKG-26-0013', 'ADMIS'); // 4e A (Togbin) → 3e
  await decide('SKG-26-0015', 'ADMIS');
  await decide('SKG-26-0012', 'NON_ADMIS'); // reste en 4e
  await decide('SKG-26-0001', 'ADMIS'); // 1re année F3 (Hêdomey) → 2e année
  await decide('SKG-26-0002', 'NON_ADMIS'); // reste en 1re année
  await decide('SKG-26-0003', 'NON_ADMIS');
  // SKG-26-0014 : aucune décision.

  const y = await as('direction').post('/academic-years', {
    label: '2027-2028', startDate: day(-2), endDate: day(250),
    terms: [{ name: 'Trimestre 1', startDate: day(-2), endDate: day(80) }, { name: 'Trimestre 2', startDate: day(81), endDate: day(160) }, { name: 'Trimestre 3', startDate: day(161), endDate: day(250) }],
  });
  expect(y.status).toBe(201);
  year2 = y.body.id;
  expect((await as('direction').post(`/academic-years/${year2}/current`)).status).toBe(201);
  for (const [name, site, level, trackId, capacity] of [
    ['3e A', 'Togbin', '3e', null, 40], ['3e B', 'Togbin', '3e', null, 40], ['3e C', 'Hêdomey', '3e', null, 40], ['4e A', 'Togbin', '4e', null, 40],
    ['2e année F3', 'Hêdomey', '2e année', f3, 40], ['2e année F4', 'Hêdomey', '2e année', f4, 40], ['1re année F3', 'Hêdomey', '1re année', f3, 1],
  ] as const) {
    const c = await as('direction').post('/classes', { name, siteId: sites[site], levelId: levels[level], trackId, capacity });
    expect(c.status).toBe(201);
    classes[name] = c.body.id;
  }
}, 180000);

afterAll(async () => {
  await app?.close();
  await admin.$disconnect();
  await appDb.$disconnect();
});

describe('Corrections G4 · 2. classe proposée, confirmée ou changée avant validation', () => {
  const item = async (matricule: string, who = 'secretariat') => (await as(who).get('/students/reenrollment')).body.items.find((i: any) => i.matricule === matricule);

  it('admis : classe du niveau suivant (même site, même lettre) ; non admis : même niveau ; sans décision : à choisir', async () => {
    expect((await item('SKG-26-0013')).proposal).toMatchObject({ basis: 'ADMIS', levelName: '3e', classId: classes['3e A'], className: '3e A' });
    expect((await item('SKG-26-0012')).proposal).toMatchObject({ basis: 'NON_ADMIS', levelName: '4e', classId: classes['4e A'], className: '4e A' });
    expect((await item('SKG-26-0014')).proposal).toMatchObject({ basis: 'SANS_DECISION', classId: null });
    // Même filière d'abord : 1re année F3 → 2e année F3, pas 2e année F4.
    expect((await item('SKG-26-0001')).proposal).toMatchObject({ basis: 'ADMIS', classId: classes['2e année F3'] });
    expect((await item('SKG-26-0002')).proposal).toMatchObject({ basis: 'NON_ADMIS', classId: classes['1re année F3'] });
  });

  it('le passage d’un niveau à l’autre se règle dans Paramètres › Niveaux, par la direction seulement', async () => {
    const patch = (who: string, id: string, body: object) => as(who).patch(`/levels/${id}`, body);
    expect((await patch('secretariat', levels['4e'], { nextLevelId: null })).status).toBe(403);
    expect((await patch('direction', levels['4e'], { nextLevelId: levels['4e'] })).status).toBe(400);
    // Un niveau d'une autre école : introuvable (contrôle « même école »).
    const foreign = await inTenant((tx) => tx.level.create({ data: { tenantId: otherTenantId, name: 'Niveau d’une autre école', cycle: 'COLLEGE', position: 1 } }), otherTenantId);
    expect((await patch('direction', levels['4e'], { nextLevelId: foreign.id })).status).toBe(404);
    // Sans niveau suivant, plus de proposition pour un admis de 4e, et l'écran dit où le définir.
    expect((await patch('direction', levels['4e'], { nextLevelId: null })).status).toBe(200);
    const without = (await item('SKG-26-0013')).proposal;
    expect(without).toMatchObject({ basis: 'ADMIS', classId: null });
    expect(without.note).toContain('Paramètres › Niveaux');
    expect((await patch('direction', levels['4e'], { nextLevelId: levels['3e'] })).status).toBe(200);
    expect((await item('SKG-26-0013')).proposal.classId).toBe(classes['3e A']);
    const audit = await inTenant((tx) => tx.auditLog.findMany({ where: { action: 'level.updated', entityId: levels['4e'] } }));
    expect(audit.length).toBe(2);
    // La base refuse aussi un niveau d'une autre école, même si le code se trompait.
    await expect(inTenant((tx) => tx.level.update({ where: { id: levels['4e'] }, data: { nextLevelId: foreign.id } }))).rejects.toThrow();
    await expect(inTenant((tx) => tx.$executeRaw`UPDATE levels SET "nextLevelId" = id WHERE id = ${levels['4e']}::uuid`)).rejects.toThrow(/levels_next_level_check/);
  });

  it('le dossier propose la même classe ; la réinscription garde la proposition et la classe confirmée', async () => {
    const id = await sid('SKG-26-0013');
    const file = (await as('direction').get(`/students/${id}`)).body;
    expect(file.reenrollProposal).toMatchObject({ basis: 'ADMIS', classId: classes['3e A'] });
    // La classe proposée est confirmée telle quelle.
    const ok = await as('secretariat').post(`/students/${id}/reenroll`, { classId: classes['3e A'] });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ className: '3e A', followedProposal: true });
    // Non admis, proposé en 4e A, mis en 3e B par la personne : accepté, et l'écart reste écrit.
    const ange = await sid('SKG-26-0012');
    const changed = await as('direction').post(`/students/${ange}/reenroll`, { classId: classes['3e B'] });
    expect(changed.status).toBe(201);
    expect(changed.body.followedProposal).toBe(false);
    const e = await inTenant((tx) => tx.enrollment.findFirstOrThrow({ where: { studentId: ange, academicYearId: year2 }, include: { events: true } }));
    expect(e.events[0].data).toMatchObject({ proposedClassId: classes['4e A'], proposedClass: '4e A', proposalBasis: 'NON_ADMIS', followedProposal: false });
    const audit = await inTenant((tx) => tx.auditLog.findFirstOrThrow({ where: { action: 'student.reenrolled', entityId: ange } }));
    expect(audit.data).toMatchObject({ proposedClass: '4e A', followedProposal: false, classId: classes['3e B'] });
    // Une classe est toujours exigée : aucune réinscription « automatique » sans classe confirmée.
    expect((await as('secretariat').post(`/students/${await sid('SKG-26-0014')}/reenroll`, {})).status).toBe(400);
  });

  it('une classe complète n’est plus proposée', async () => {
    expect((await as('secretariat').post(`/students/${await sid('SKG-26-0002')}/reenroll`, { classId: classes['1re année F3'] })).status).toBe(201);
    const p = (await item('SKG-26-0003')).proposal; // non admis aussi, mais la seule place est prise
    expect(p).toMatchObject({ basis: 'NON_ADMIS', classId: null });
    expect(p.note).toContain('complètes');
  });

  it('un secrétariat limité à un site ne voit que les élèves et les classes proposées de son site', async () => {
    await secretariatSites(sites['Hêdomey']);
    try {
      const items = (await as('secretariat').get('/students/reenrollment')).body.items;
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((i: any) => i.fromClass.site.name === 'Hêdomey')).toBe(true);
      const hedomey = new Set([classes['3e C'], classes['2e année F3'], classes['2e année F4'], classes['1re année F3']]);
      expect(items.every((i: any) => !i.proposal.classId || hedomey.has(i.proposal.classId))).toBe(true);
      expect((await as('secretariat').get(`/students/${await sid('SKG-26-0015')}`)).status).toBe(403);
    } finally {
      await secretariatSites(null);
    }
  });
});

describe('Corrections G4 · 1. frais impayés : avertissement sans blocage', () => {
  it('la liste signale les impayés ; la direction et le secrétariat voient le reste dû et la part échue', async () => {
    const id = await sid('SKG-26-0015');
    const debt = await expectedDebt(id);
    expect(debt.due).toBeGreaterThan(0);
    for (const who of ['direction', 'secretariat']) {
      const row = (await as(who).get('/students/reenrollment')).body.items.find((i: any) => i.id === id);
      expect(row).toMatchObject({ unpaid: true, balance: debt.due, overdue: debt.overdue });
    }
    // Les rôles sans accès à la réinscription ne voient pas la liste.
    expect((await as('comptable').get('/students/reenrollment')).status).toBe(403);
    expect((await as('teacher').get('/students/reenrollment')).status).toBe(403);
  });

  it('un élève à jour de ses paiements n’est pas signalé', async () => {
    const id = await sid('SKG-26-0016');
    await inTenant((tx) => tx.$executeRaw`UPDATE invoices SET paid = total, status = 'PAID' WHERE "studentId" = ${id}::uuid AND status <> 'CANCELLED'`);
    const row = (await as('direction').get('/students/reenrollment')).body.items.find((i: any) => i.id === id);
    expect(row).toMatchObject({ unpaid: false, balance: 0, overdue: 0 });
    const file = (await as('direction').get(`/students/${id}`)).body;
    expect(file).toMatchObject({ unpaid: false, reenrollable: true });
  });

  it('la réinscription d’un élève qui doit encore des frais n’est pas bloquée ; le montant reste tracé pour la direction', async () => {
    const id = await sid('SKG-26-0015');
    const debt = await expectedDebt(id);
    const file = (await as('direction').get(`/students/${id}`)).body;
    expect(file).toMatchObject({ unpaid: true, balance: debt.due, overdue: debt.overdue, reenrollable: true });
    const r = await as('secretariat').post(`/students/${id}/reenroll`, { classId: classes['3e A'] });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ unpaid: true, balance: debt.due, overdue: debt.overdue });
    const e = await inTenant((tx) => tx.enrollment.findFirstOrThrow({ where: { studentId: id, academicYearId: year2 }, include: { events: true } }));
    expect(e.events[0].data).toMatchObject({ unpaid: true });
    // Le montant n'est pas recopié dans l'historique de l'inscription (il reste dans le journal d'audit de la direction).
    expect(e.events[0].data).not.toHaveProperty('balanceDue');
    expect(e.events[0].data).not.toHaveProperty('balance');
    const audit = await inTenant((tx) => tx.auditLog.findFirstOrThrow({ where: { action: 'student.reenrolled', entityId: id } }));
    expect(audit.data).toMatchObject({ unpaid: true, balanceDue: debt.due, overdue: debt.overdue });
  });

  it('ni l’enseignant ni le comptable ne reçoivent l’avertissement ou la proposition (rôles sans réinscription)', async () => {
    const id = await sid('SKG-26-0005');
    expect((await as('teacher').get(`/students/${id}`)).status).toBe(403); // plus dans ses classes cette année
    const compta = (await as('comptable').get(`/students/${await sid('SKG-26-0013')}`)).body;
    expect(compta).not.toHaveProperty('unpaid');
    expect(compta).not.toHaveProperty('reenrollProposal');
    expect(compta.balance).toEqual(expect.any(Number)); // le comptable garde le solde, comme avant
  });
});

describe('Corrections G4 · 3. sortie : dates et historique conservés', () => {
  it('une sortie ne peut pas précéder l’inscription, ni le retour de l’élève ; l’historique garde tout', async () => {
    const id = await sid('SKG-26-0014');
    expect((await as('secretariat').post(`/students/${id}/reenroll`, { classId: classes['3e B'] })).status).toBe(201);
    const leave = (exitDate: string) => as('secretariat').post(`/students/${id}/withdraw`, { status: 'TRANSFERRED', reason: 'Déménagement', exitDate });
    const before = await leave(schoolDay(-1));
    expect(before.status).toBe(400);
    expect(before.body.message).toMatch(/précède son inscription/);
    expect((await leave(schoolDay(0))).status).toBe(201);
    // Retour : sa classe de l'année est proposée ; ici la personne choisit une autre classe, ce qui reste écrit.
    expect((await as('direction').get(`/students/${id}`)).body.reenrollProposal).toMatchObject({ basis: 'RETOUR', classId: classes['3e B'] });
    const back = await as('secretariat').post(`/students/${id}/reenroll`, { classId: classes['3e A'] });
    expect(back.body).toMatchObject({ reinstated: true, followedProposal: false });
    const e = await inTenant((tx) => tx.enrollment.findFirstOrThrow({ where: { studentId: id, academicYearId: year2 }, include: { events: { orderBy: { createdAt: 'asc' } } } }));
    expect(e.events.map((x) => x.kind)).toEqual(['REENROLLED', 'TRANSFERRED', 'REINSTATED']);
    expect(e.events[1].data).toMatchObject({ exitDate: schoolDay(0), reason: 'Déménagement', className: '3e B' });
    expect(e.events[2].data).toMatchObject({
      previousStatus: 'TRANSFERRED', previousClassId: classes['3e B'], previousClass: '3e B', exitDate: schoolDay(0), exitReason: 'Déménagement', classId: classes['3e A'],
      proposalBasis: 'RETOUR', proposedClass: '3e B', followedProposal: false,
    });
    expect(e).toMatchObject({ status: 'ACTIVE', exitDate: null, classId: classes['3e A'] });
    const again = await leave(schoolDay(-1));
    expect(again.status).toBe(400);
    expect(again.body.message).toMatch(/précède le retour de l’élève/);
  });

  it('un dossier retrouvé à l’inscription signale que sa dernière inscription a été annulée', async () => {
    const id = await sid('SKG-26-0017');
    const s = await inTenant((tx) => tx.student.findUniqueOrThrow({ where: { id } }));
    expect((await as('secretariat').post(`/students/${id}/reenroll`, { classId: classes['4e A'] })).status).toBe(201);
    expect((await as('direction').post(`/students/${id}/enrollment/cancel`, { reason: 'Réinscription saisie par erreur (fictive)' })).status).toBe(201);
    const r = await as('secretariat').post('/students', {
      firstName: s.firstName, lastName: s.lastName, sex: 'M', birthDate: '2012-06-20', classId: classes['4e A'],
      guardians: [{ firstName: 'Parent', lastName: 'FICTIF', phone: '0197666017', relation: 'Mère', isPrimary: true }],
    });
    expect(r.status).toBe(409);
    expect(r.body.candidates).toEqual([expect.objectContaining({
      matricule: 'SKG-26-0017', lastClass: '4e A', lastYear: '2027-2028', lastSite: 'Togbin', lastCancelled: true, enrolledThisYear: false, otherSite: false,
    })]);
  });
});

describe('Corrections G4 · 6. la base garde l’historique des inscriptions', () => {
  let enrollmentId = '';
  beforeAll(async () => {
    const id = await sid('SKG-26-0013');
    enrollmentId = (await inTenant((tx) => tx.enrollment.findFirstOrThrow({ where: { studentId: id, academicYearId: year2 } }))).id;
  });
  const asOwner = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => inTenant(fn);
  const asApp = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => inTenant(fn, tenantId, appDb);

  it('changer la classe, l’état, la sortie ou l’annulation sans ligne d’historique : refusé, même pour le propriétaire', async () => {
    for (const run of [asOwner, asApp]) {
      await expect(run((tx) => tx.$executeRaw`UPDATE enrollments SET status = 'WITHDRAWN', "exitDate" = '2027-01-10' WHERE id = ${enrollmentId}::uuid`)).rejects.toThrow(/sans ligne dans son historique/);
      await expect(run((tx) => tx.$executeRaw`UPDATE enrollments SET "classId" = ${classes['3e B']}::uuid WHERE id = ${enrollmentId}::uuid`)).rejects.toThrow(/sans ligne dans son historique/);
    }
    expect(await inTenant((tx) => tx.enrollment.findUniqueOrThrow({ where: { id: enrollmentId } }))).toMatchObject({ status: 'ACTIVE', classId: classes['3e A'], exitDate: null });
  });

  it('avec sa ligne d’historique dans la même transaction : accepté', async () => {
    await asApp(async (tx) => {
      await tx.$executeRaw`UPDATE enrollments SET "classId" = ${classes['3e B']}::uuid WHERE id = ${enrollmentId}::uuid`;
      await tx.enrollmentEvent.create({ data: { tenantId, enrollmentId, kind: 'CLASS_CHANGED', data: { fromClassId: classes['3e A'], fromClass: '3e A', toClassId: classes['3e B'], toClass: '3e B' } } });
    });
    expect((await inTenant((tx) => tx.enrollment.findUniqueOrThrow({ where: { id: enrollmentId } }))).classId).toBe(classes['3e B']);
  });

  it('élève, année, date d’inscription et type d’une inscription ne se modifient jamais', async () => {
    for (const run of [asOwner, asApp]) {
      await expect(run((tx) => tx.$executeRaw`UPDATE enrollments SET "enrolledAt" = '2026-01-01' WHERE id = ${enrollmentId}::uuid`)).rejects.toThrow(/ne se modifient pas/);
      await expect(run((tx) => tx.$executeRaw`UPDATE enrollments SET "academicYearId" = ${year1}::uuid WHERE id = ${enrollmentId}::uuid`)).rejects.toThrow(/ne se modifient pas/);
      await expect(run((tx) => tx.$executeRaw`UPDATE enrollments SET type = 'NEW' WHERE id = ${enrollmentId}::uuid`)).rejects.toThrow(/ne se modifient pas/);
    }
  });

  it('une école ne lit ni ne compte les inscriptions d’une autre école', async () => {
    const r = await inTenant((tx) => billableEnrollments(tx, year2, schoolDay(0), TZ), otherTenantId);
    expect(r).toMatchObject({ count: 0, items: [], toReview: [] });
    expect(await inTenant((tx) => tx.enrollmentEvent.count(), otherTenantId)).toBe(0);
  });
});

describe('Corrections G4 · 4. élèves facturables rejoués depuis l’historique (31 mars, 30 juin ; aucune facture)', () => {
  // Une année passée fictive (2025-2026) et des inscriptions dont l'historique est daté : ce qui s'est passé avant et
  // après chaque date de référence est connu. Écrit directement dans la base de test, ligne d'historique comprise.
  const R1 = '2026-03-31';
  const R2 = '2026-06-30';
  let pastYear = '';
  const past: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let n = 0;

  async function enrol(key: string, klass: '5e A' | '5e B', enrolledAt: string, status: 'ACTIVE' | 'WITHDRAWN' = 'ACTIVE') {
    ids[key] = await inTenant(async (tx) => {
      const s = await tx.student.create({ data: { tenantId, matricule: `SKG-25-9${String(++n).padStart(3, '0')}`, firstName: `Cas ${key}`, lastName: 'FACTURABLE' } });
      const e = await tx.enrollment.create({ data: { tenantId, studentId: s.id, classId: past[klass], academicYearId: pastYear, enrolledAt: new Date(enrolledAt), type: 'NEW', status } });
      // Une inscription « d'avant l'historique » (départ sans date) n'a aucune ligne : c'est le cas à vérifier.
      if (status === 'ACTIVE') await tx.enrollmentEvent.create({ data: { tenantId, enrollmentId: e.id, kind: 'ENROLLED', data: { classId: past[klass], className: klass, type: 'NEW' }, createdAt: new Date(enrolledAt) } });
      return e.id;
    });
  }
  /** Une opération datée : la ligne de l'inscription et sa ligne d'historique, dans la même transaction. */
  const step = (key: string, at: string, kind: 'CANCELLED' | 'WITHDRAWN' | 'TRANSFERRED' | 'REINSTATED' | 'CLASS_CHANGED', data: Record<string, string>, row: Prisma.EnrollmentUpdateInput) =>
    inTenant(async (tx) => {
      await tx.enrollment.update({ where: { id: ids[key] }, data: row });
      await tx.enrollmentEvent.create({ data: { tenantId, enrollmentId: ids[key], kind, data, createdAt: new Date(at) } });
    });
  const cancel = (key: string, at: string) => step(key, at, 'CANCELLED', { reason: 'Saisie de test' }, { status: 'CANCELLED', cancelledAt: new Date(at), cancelReason: 'Saisie de test' });
  const leave = (key: string, at: string, exitDate: string, kind: 'WITHDRAWN' | 'TRANSFERRED' = 'WITHDRAWN') =>
    step(key, at, kind, { exitDate, reason: 'Test' }, { status: kind, exitDate: new Date(`${exitDate}T00:00:00Z`), exitReason: 'Test' });
  const back = (key: string, at: string) =>
    step(key, at, 'REINSTATED', { classId: past['5e A'], className: '5e A', previousClassId: past['5e A'] }, { status: 'ACTIVE', cancelledAt: null, cancelReason: null, exitDate: null, exitReason: null });
  const count = (date: string, knownAt?: Date) => inTenant((tx) => billableEnrollments(tx, pastYear, date, TZ, knownAt));
  const keys = (r: { items: { enrollmentId: string }[] }) => Object.keys(ids).filter((k) => r.items.some((i) => i.enrollmentId === ids[k])).sort();

  beforeAll(async () => {
    await inTenant(async (tx) => {
      const y = await tx.academicYear.create({ data: { tenantId, label: '2025-2026', startDate: new Date('2025-09-15'), endDate: new Date('2026-07-03') } });
      pastYear = y.id;
      for (const [name, site] of [['5e A', 'Togbin'], ['5e B', 'Hêdomey']] as const) {
        past[name] = (await tx.class.create({ data: { tenantId, academicYearId: y.id, siteId: sites[site], levelId: levels['5e'], name } })).id;
      }
    });
    const sept = '2025-09-15T08:00:00Z';
    await enrol('a_active', '5e A', sept);
    await enrol('b_cancelledBeforeR1', '5e A', sept);
    await cancel('b_cancelledBeforeR1', '2026-03-30T10:00:00Z');
    await enrol('c_cancelledAfterR1', '5e A', sept);
    await cancel('c_cancelledAfterR1', '2026-04-01T10:00:00Z');
    await enrol('d_exitOnR1', '5e A', sept);
    await leave('d_exitOnR1', '2026-03-31T15:00:00Z', R1);
    await enrol('e_exitOnR2', '5e B', sept);
    await leave('e_exitOnR2', '2026-06-30T09:00:00Z', R2, 'TRANSFERRED');
    await enrol('f_exitAfterR1', '5e A', sept);
    await leave('f_exitAfterR1', '2026-04-02T09:00:00Z', '2026-04-02', 'TRANSFERRED');
    await enrol('g_enrolledAfterR1', '5e B', '2026-04-03T08:00:00Z');
    await enrol('h_lateEveningR1', '5e A', '2026-03-31T22:30:00Z'); // 23 h 30 à Porto-Novo, encore le 31 mars
    await enrol('i_nextMorning', '5e A', '2026-03-31T23:30:00Z'); // 0 h 30 le 1er avril à Porto-Novo
    await enrol('j_cancelledThenBack', '5e A', sept);
    await cancel('j_cancelledThenBack', '2026-03-20T10:00:00Z');
    await back('j_cancelledThenBack', '2026-04-10T09:00:00Z');
    await enrol('k_leftThenBack', '5e A', sept);
    await leave('k_leftThenBack', '2026-03-15T12:00:00Z', '2026-03-15');
    await back('k_leftThenBack', '2026-04-12T09:00:00Z');
    await enrol('l_backdatedExit', '5e A', sept);
    await leave('l_backdatedExit', '2026-04-05T10:00:00Z', '2026-03-25', 'TRANSFERRED');
    await enrol('m_classChange', '5e A', sept);
    await step('m_classChange', '2026-05-02T10:00:00Z', 'CLASS_CHANGED', { fromClassId: past['5e A'], fromClass: '5e A', toClassId: past['5e B'], toClass: '5e B' }, { class: { connect: { id: past['5e B'] } } });
    await enrol('n_legacyExit', '5e A', sept, 'WITHDRAWN');
    await enrol('o_backOnR1Evening', '5e A', sept);
    await cancel('o_backOnR1Evening', '2026-03-10T10:00:00Z');
    await back('o_backOnR1Evening', '2026-03-31T18:00:00Z'); // 19 h à Porto-Novo, le 31 mars
  });

  it('31 mars : actives à la fin du jour, dans le fuseau de l’école ; sortie ce jour-là : non comptée', async () => {
    const r = await count(R1);
    expect(keys(r)).toEqual(['a_active', 'c_cancelledAfterR1', 'e_exitOnR2', 'f_exitAfterR1', 'h_lateEveningR1', 'm_classChange', 'o_backOnR1Evening']);
    expect(r).toMatchObject({ date: R1, timeZone: TZ, count: 7 });
    expect(r.at.toISOString()).toBe('2026-03-31T22:59:59.999Z');
    expect(r.toReview.map((x) => x.enrollmentId)).toEqual([ids.n_legacyExit]);
  });

  it('30 juin : arrivées et retours comptés, départs et annulations d’avant exclus ; sortie le 30 juin : non comptée', async () => {
    const r = await count(R2);
    expect(keys(r)).toEqual(['a_active', 'g_enrolledAfterR1', 'h_lateEveningR1', 'i_nextMorning', 'j_cancelledThenBack', 'k_leftThenBack', 'm_classChange', 'o_backOnR1Evening']);
    expect(r.toReview.map((x) => x.enrollmentId)).toEqual([ids.n_legacyExit]);
  });

  it('le calcul ne suit pas l’état actuel : annulée puis rétablie, ou partie puis revenue après le 31 mars, elle ne comptait pas ce jour-là', async () => {
    const now = await inTenant((tx) => tx.enrollment.findMany({ where: { id: { in: [ids.j_cancelledThenBack, ids.k_leftThenBack] } } }));
    // Leur état actuel est « active, sans annulation ni sortie » : une lecture de l'état actuel les aurait comptées.
    expect(now.every((e) => e.status === 'ACTIVE' && e.cancelledAt === null && e.exitDate === null && e.enrolledAt < new Date('2026-03-31'))).toBe(true);
    const r1 = await count(R1);
    expect(r1.items.some((i) => i.enrollmentId === ids.j_cancelledThenBack || i.enrollmentId === ids.k_leftThenBack)).toBe(false);
  });

  it('un calcul figé à un instant se refait à l’identique, même après une sortie enregistrée plus tard avec une date antérieure', async () => {
    const knownAt = new Date('2026-04-01T00:00:00Z');
    const frozen = await count(R1, knownAt);
    expect(keys(frozen)).toContain('l_backdatedExit'); // sortie du 25 mars, enregistrée le 5 avril : inconnue le 1er avril
    expect(await count(R1, knownAt)).toEqual(frozen);
    expect(keys(await count(R1))).not.toContain('l_backdatedExit'); // aujourd'hui, la sortie est connue
  });

  it('classe et site à la date de référence ; les deux sites d’un établissement s’additionnent', async () => {
    const r1 = await count(R1);
    const r2 = await count(R2);
    expect(r1.items.find((i) => i.enrollmentId === ids.m_classChange)).toMatchObject({ classId: past['5e A'], siteId: sites['Togbin'] });
    expect(r2.items.find((i) => i.enrollmentId === ids.m_classChange)).toMatchObject({ classId: past['5e B'], siteId: sites['Hêdomey'] });
    const bySite = (r: typeof r1) => r.items.reduce((m, i) => m.set(i.siteId, (m.get(i.siteId) ?? 0) + 1), new Map<string | null, number>());
    expect([...bySite(r1).values()].reduce((a, b) => a + b, 0)).toBe(r1.count);
    expect(bySite(r1).get(sites['Hêdomey'])).toBe(1); // e_exitOnR2
    expect(bySite(r2).get(sites['Hêdomey'])).toBe(2); // g_enrolledAfterR1, m_classChange
  });

  it('régularisations : jamais deux fois le même élève ; arrivées et départs entre le 31 mars et le 30 juin identifiés ; aucune facture', async () => {
    const invoices = await inTenant((tx) => tx.invoice.count());
    const r1 = await count(R1);
    const r2 = await count(R2);
    for (const r of [r1, r2]) expect(new Set(r.items.map((i) => i.studentId)).size).toBe(r.count);
    const s1 = new Set(r1.items.map((i) => i.studentId));
    const s2 = new Set(r2.items.map((i) => i.studentId));
    const name = async (set: Set<string>, keep: (id: string) => boolean) => {
      const rows = await inTenant((tx) => tx.enrollment.findMany({ where: { studentId: { in: [...set].filter(keep) }, academicYearId: pastYear }, select: { id: true } }));
      return Object.keys(ids).filter((k) => rows.some((x) => x.id === ids[k])).sort();
    };
    // Arrivés entre les deux dates (à ajouter au 30 juin), partis entre les deux (déjà comptés au 31 mars, sans remboursement automatique).
    expect(await name(s2, (id) => !s1.has(id))).toEqual(['g_enrolledAfterR1', 'i_nextMorning', 'j_cancelledThenBack', 'k_leftThenBack']);
    expect(await name(s1, (id) => !s2.has(id))).toEqual(['c_cancelledAfterR1', 'e_exitOnR2', 'f_exitAfterR1']);
    expect(await inTenant((tx) => tx.invoice.count())).toBe(invoices);
  });

  it('les inscriptions enregistrées par l’application elle-même se rejouent de la même façon', async () => {
    const today = await inTenant((tx) => billableEnrollments(tx, year2, schoolDay(0), TZ));
    const has = (matricule: string) => today.items.some((i) => i.matricule === matricule);
    expect(has('SKG-26-0013')).toBe(true); // réinscrit aujourd'hui
    expect(has('SKG-26-0014')).toBe(true); // parti aujourd'hui puis revenu aujourd'hui
    expect(has('SKG-26-0011')).toBe(false); // pas réinscrit pour 2027-2028
    expect(today.toReview).toEqual([]);
    expect(new Set(today.items.map((i) => i.studentId)).size).toBe(today.count);
  });
});
