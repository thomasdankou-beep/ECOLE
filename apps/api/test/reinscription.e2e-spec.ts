/**
 * Lot G4 · réinscription, de bout en bout, sur la base de test (erp_test) et des données entièrement fictives.
 * Scénario réel : la direction crée l'année suivante, l'active, crée ses classes, puis réinscrit les élèves de
 * l'année précédente sur leur dossier (même matricule). Contrôles demandés par Dankou le 13 novembre 2026 :
 * unicité des inscriptions, conservation des historiques, aucun doublon automatique, données de facturation.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { consoleSms } from '../src/modules/notifications/sms.provider';
import { billableEnrollments } from '../src/modules/students/enrollments';

const PASSWORD = 'Kisito2026';
const PHONES = { direction: '+2290190000010', secretariat: '+2290190000011', teacher: '+2290190000001', comptable: '+2290190000013', parent: '+2290197000001' };

let app: INestApplication;
let http: ReturnType<typeof request>;
const admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_ADMIN_URL } } });
const appDb = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
const tokens: Record<string, string> = {};
let tenantId = '';
let otherTenantId = '';
const sites: Record<string, string> = {};
let year1 = '';
let year2 = '';
const newClasses: Record<string, string> = {};

/** Jour (AAAA-MM-JJ, UTC) décalé de `offset` jours par rapport au jour du test. */
const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

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
function inTenant<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, tid = tenantId) {
  return admin.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tid}, true)`;
    return fn(tx);
  });
}
/** Même chose avec le rôle de l'application (erp_app), soumis à ses droits réduits. */
function asApp<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  return appDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}
const sid = async (matricule: string) => (await inTenant((tx) => tx.student.findFirstOrThrow({ where: { matricule }, select: { id: true } }))).id;
const userId = async (phone: string) => (await inTenant((tx) => tx.user.findFirstOrThrow({ where: { phone }, select: { id: true } }))).id;
/** Limite (ou rend à tout l'établissement) le compte du secrétariat, puis se reconnecte. */
async function secretariatSites(siteId: string | null) {
  const id = await userId(PHONES.secretariat);
  await inTenant((tx) => tx.userRole.updateMany({ where: { userId: id, role: 'SECRETARIAT' }, data: { siteId } }));
  tokens.secretariat = await login(PHONES.secretariat);
}
const pupil = (over: Record<string, unknown> = {}) => ({
  firstName: 'Test', lastName: 'FICTIF', sex: 'M', classId: '',
  guardians: [{ firstName: 'Parent', lastName: 'FICTIF', phone: '0197666001', relation: 'Mère', isPrimary: true }],
  ...over,
});

beforeAll(async () => {
  execSync('npx ts-node --transpile-only prisma/seed.ts', { env: process.env, stdio: 'ignore', cwd: `${__dirname}/..` });
  const t = await admin.tenant.findUniqueOrThrow({ where: { slug: 'saint-kisito' } });
  tenantId = t.id;
  // Un autre établissement fictif, pour l'étanchéité des nouvelles tables.
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
  tokens.student = await login('SKG-26-0001');
  const settings = (await as('direction').get('/settings')).body;
  for (const s of settings.sites) sites[s.name] = s.id;
  year1 = settings.currentYear.id;
}, 180000);

afterAll(async () => {
  await app?.close();
  await admin.$disconnect();
  await appDb.$disconnect();
});

describe('Lot G4 · unicité et conservation, garanties par la base elle-même', () => {
  it('une seule inscription par élève et par année : un second enregistrement est refusé', async () => {
    const id = await sid('SKG-26-0013');
    const e = await inTenant((tx) => tx.enrollment.findFirstOrThrow({ where: { studentId: id, academicYearId: year1 } }));
    await expect(inTenant((tx) => tx.enrollment.create({ data: { tenantId, studentId: id, classId: e.classId, academicYearId: year1 } }))).rejects.toThrow(/Unique constraint/);
  });

  it("élèves, inscriptions et factures ne se suppriment jamais ; l'historique des inscriptions ne se modifie pas", async () => {
    const id = await sid('SKG-26-0013');
    // Même le propriétaire des tables est arrêté par les déclencheurs…
    await expect(inTenant((tx) => tx.$executeRaw`DELETE FROM students WHERE id = ${id}::uuid`)).rejects.toThrow(/ajout seul/);
    await expect(inTenant((tx) => tx.$executeRaw`DELETE FROM enrollments WHERE "studentId" = ${id}::uuid`)).rejects.toThrow(/ajout seul/);
    await expect(inTenant((tx) => tx.$executeRaw`DELETE FROM invoices WHERE "studentId" = ${id}::uuid`)).rejects.toThrow(/ajout seul/);
    // … et le rôle de l'application n'a même pas le droit de le demander.
    await expect(asApp((tx) => tx.$executeRaw`DELETE FROM students WHERE id = ${id}::uuid`)).rejects.toThrow(/permission denied/);
    await expect(asApp((tx) => tx.$executeRaw`DELETE FROM enrollments WHERE "studentId" = ${id}::uuid`)).rejects.toThrow(/permission denied/);
    await expect(asApp((tx) => tx.$executeRaw`DELETE FROM invoices WHERE "studentId" = ${id}::uuid`)).rejects.toThrow(/permission denied/);
    await expect(asApp((tx) => tx.$executeRaw`TRUNCATE enrollment_events`)).rejects.toThrow(/permission denied/);
    const privileges = await admin.$queryRaw<{ t: string; del: boolean; upd: boolean }[]>`
      SELECT t, has_table_privilege('erp_app', t, 'DELETE') AS del, has_table_privilege('erp_app', t, 'UPDATE') AS upd
      FROM unnest(ARRAY['students', 'enrollments', 'invoices', 'duplicate_reviews', 'enrollment_events']) AS t ORDER BY t`;
    expect(privileges).toEqual([
      { t: 'duplicate_reviews', del: false, upd: true },
      { t: 'enrollment_events', del: false, upd: false },
      { t: 'enrollments', del: false, upd: true },
      { t: 'invoices', del: false, upd: true },
      { t: 'students', del: false, upd: true },
    ]);
  });

  it("un bulletin publié ne se supprime plus ; un bulletin non publié peut toujours être recalculé", async () => {
    const id = await sid('SKG-26-0013');
    const e = await inTenant((tx) => tx.enrollment.findFirstOrThrow({ where: { studentId: id, academicYearId: year1 } }));
    const term = await inTenant((tx) => tx.term.findFirstOrThrow({ where: { academicYearId: year1 }, orderBy: { position: 'asc' } }));
    const draft = await inTenant((tx) => tx.reportCard.create({ data: { tenantId, studentId: id, classId: e.classId, termId: term.id, classSize: 8, verifyCode: 'G4-BROUILLON-0013' } }));
    expect(await inTenant((tx) => tx.reportCard.deleteMany({ where: { id: draft.id } }))).toEqual({ count: 1 });
    const published = await inTenant((tx) => tx.reportCard.create({
      data: { tenantId, studentId: id, classId: e.classId, termId: term.id, classSize: 8, average: 12.5, rank: 3, verifyCode: 'G4-PUBLIE-0013', publishedAt: new Date() },
    }));
    await expect(inTenant((tx) => tx.reportCard.delete({ where: { id: published.id } }))).rejects.toThrow(/bulletin publié ne se supprime pas/);
  });

  it("annulation : la base exige une date et un motif ; l'historique et les doublons sont cloisonnés par école", async () => {
    const id = await sid('SKG-26-0013');
    await expect(inTenant((tx) => tx.$executeRaw`UPDATE enrollments SET status = 'CANCELLED' WHERE "studentId" = ${id}::uuid`)).rejects.toThrow(/enrollments_cancel_check/);
    await expect(inTenant((tx) => tx.$executeRaw`UPDATE enrollments SET status = 'CANCELLED', "cancelledAt" = now() WHERE "studentId" = ${id}::uuid`)).rejects.toThrow(/enrollments_cancel_check/);
    const rls = await admin.$queryRaw<{ table: string; rls: boolean; forced: boolean }[]>`
      SELECT relname AS table, relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class WHERE relname IN ('enrollment_events', 'duplicate_reviews') ORDER BY 1`;
    expect(rls).toEqual([{ table: 'duplicate_reviews', rls: true, forced: true }, { table: 'enrollment_events', rls: true, forced: true }]);
    // Une ligne d'historique ne peut pas viser l'inscription d'une autre école (contrôle « même école », SEC-001).
    const e = await inTenant((tx) => tx.enrollment.findFirstOrThrow({ where: { studentId: id } }));
    await expect(inTenant((tx) => tx.enrollmentEvent.create({ data: { tenantId: otherTenantId, enrollmentId: e.id, kind: 'ENROLLED' } }), otherTenantId)).rejects.toThrow();
  });
});

describe('Lot G4 · départ et annulation (année en cours)', () => {
  it('départ : date de sortie et motif obligatoires, ni avant la rentrée ni dans le futur ; historique daté', async () => {
    const id = await sid('SKG-26-0011'); // Sèna DOSSOU, enfant du compte parent de démonstration
    const s = as('secretariat');
    const go = (body: object) => s.post(`/students/${id}/withdraw`, { status: 'TRANSFERRED', reason: 'Déménagement à Parakou', exitDate: day(0), ...body });
    expect((await go({ exitDate: undefined })).status).toBe(400);
    expect((await go({ exitDate: '2026-09-01' })).status).toBe(400); // avant la rentrée du 14 septembre 2026
    expect((await go({ exitDate: day(5) })).status).toBe(400);
    expect((await go({ reason: 'ab' })).status).toBe(400);
    expect((await go({})).status).toBe(201);
    expect((await go({})).status).toBe(400); // déjà parti(e)
    const file = (await as('direction').get(`/students/${id}`)).body;
    expect(file).toMatchObject({ status: 'TRANSFERRED', currentClass: null, reenrollable: true, matricule: 'SKG-26-0011' });
    const [e] = file.enrollments;
    expect(e).toMatchObject({ status: 'TRANSFERRED', exitReason: 'Déménagement à Parakou' });
    expect(e.exitDate.slice(0, 10)).toBe(day(0));
    expect(e.events.map((x: any) => [x.kind, x.data])).toEqual([['TRANSFERRED', { exitDate: day(0), reason: 'Déménagement à Parakou', className: '4e A' }]]);
    // La famille voit le départ, pas le motif interne ni l'historique détaillé.
    const seen = (await as('parent').get(`/students/${id}`)).body;
    expect(seen.enrollments[0].status).toBe('TRANSFERRED');
    expect(seen.enrollments[0]).not.toHaveProperty('exitReason');
    expect(seen.enrollments[0].events).toBeUndefined();
    expect(seen.reenrollable).toBe(false);
  });

  it("annulation : direction seulement, motif obligatoire, rien n'est supprimé, la classe ne le compte plus", async () => {
    const id = await sid('SKG-26-0017');
    const before = (await as('direction').get('/classes')).body.find((c: any) => c.name === '4e A').studentCount;
    expect((await as('secretariat').post(`/students/${id}/enrollment/cancel`, { reason: 'Saisi en double' })).status).toBe(403);
    expect((await as('direction').post(`/students/${id}/enrollment/cancel`, { reason: 'abc' })).status).toBe(400);
    expect((await as('direction').post(`/students/${id}/enrollment/cancel`, { reason: 'Inscrit par erreur dans cette école' })).status).toBe(201);
    expect((await as('direction').post(`/students/${id}/enrollment/cancel`, { reason: 'Une seconde fois' })).status).toBe(409);
    const e = await inTenant((tx) => tx.enrollment.findFirstOrThrow({ where: { studentId: id }, include: { events: true } }));
    expect(e).toMatchObject({ status: 'CANCELLED', cancelReason: 'Inscrit par erreur dans cette école', cancelledById: await userId(PHONES.direction) });
    expect(e.cancelledAt).toBeInstanceOf(Date);
    expect(e.events.map((x) => x.kind)).toEqual(['CANCELLED']);
    expect((await as('direction').get('/classes')).body.find((c: any) => c.name === '4e A').studentCount).toBe(before - 1);
    const row = (await as('direction').get('/students')).body.find((s: any) => s.id === id);
    expect(row).toMatchObject({ matricule: 'SKG-26-0017', class: null, enrollmentStatus: 'CANCELLED' });
    expect(await inTenant((tx) => tx.auditLog.count({ where: { action: 'student.enrollment_cancelled', entityId: id } }))).toBe(1);
  });
});

describe('Lot G4 · aucun doublon automatique', () => {
  let classId = '';
  beforeAll(async () => {
    classId = (await as('direction').get('/classes')).body.find((c: any) => c.name === '6e A').id;
  });

  it("même nom (accents, majuscules et ordre ignorés) et même date de naissance : l'inscription s'arrête et propose le dossier", async () => {
    const r = await as('secretariat').post('/students', pupil({ firstName: 'AGBO', lastName: 'gildas', birthDate: '2012-06-20', classId }));
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('DOUBLON_POSSIBLE');
    expect(r.body.candidates).toEqual([expect.objectContaining({
      matricule: 'SKG-26-0013', reason: 'NOM_NAISSANCE', reasonLabel: 'même nom et même date de naissance', lastClass: '4e A', lastSite: 'Togbin', enrolledThisYear: true, otherSite: false,
    })]);
    const accents = await as('secretariat').post('/students', pupil({ firstName: 'Brice', lastName: 'Degbe', birthDate: '2012-06-20', classId }));
    expect(accents.status).toBe(409);
    expect(accents.body.candidates[0].matricule).toBe('SKG-26-0015');
    expect(await inTenant((tx) => tx.student.count({ where: { lastName: { in: ['GILDAS', 'DEGBE'] } } }))).toBe(0);
  });

  it('même nom et un parent au même numéro (sans date de naissance) : doublon possible aussi', async () => {
    const r = await as('secretariat').post('/students', pupil({ firstName: 'Ange', lastName: 'Hounsa', classId, guardians: [{ firstName: 'Mère', lastName: 'HOUNSA', phone: '0197000112', relation: 'Mère' }] }));
    expect(r.status).toBe(409);
    expect(r.body.candidates).toEqual([expect.objectContaining({ matricule: 'SKG-26-0012', reason: 'NOM_TELEPHONE' })]);
  });

  it("un homonyme (autre date de naissance, autre parent) s'inscrit normalement", async () => {
    const r = await as('secretariat').post('/students', pupil({ firstName: 'Ange', lastName: 'HOUNSA', birthDate: '2013-01-05', classId, guardians: [{ firstName: 'Père', lastName: 'HOUNSA', phone: '0197666010', relation: 'Père' }] }));
    expect(r.status).toBe(201);
    expect(r.body.matricule).not.toBe('SKG-26-0012');
    const e = await inTenant((tx) => tx.enrollment.findFirstOrThrow({ where: { studentId: r.body.id }, include: { events: true } }));
    expect(e).toMatchObject({ type: 'NEW', status: 'ACTIVE' });
    expect(e.events.map((x) => x.kind)).toEqual(['ENROLLED']);
    expect(await inTenant((tx) => tx.duplicateReview.count({ where: { OR: [{ studentId: r.body.id }, { otherId: r.body.id }] } }))).toBe(0);
  });

  it('« ce n’est pas le même élève » : motif obligatoire, dossier créé, paire soumise à la direction, rien de fusionné', async () => {
    const body = pupil({ firstName: 'Faïzath', lastName: 'MOUSSA', birthDate: '2012-06-20', classId, confirmNotDuplicate: true });
    expect((await as('secretariat').post('/students', body)).status).toBe(400); // sans motif
    const unread = async (who: string) => (await as(who).get('/notifications')).body.unreadCount as number;
    const [directionBefore, secretariatBefore, comptableBefore] = [await unread('direction'), await unread('secretariat'), await unread('comptable')];
    const smsBefore = consoleSms.sent.length;
    const r = await as('secretariat').post('/students', { ...body, duplicateNote: 'Jumelle homonyme, autre famille, vérifié sur l’acte de naissance' });
    expect(r.status).toBe(201);
    // La direction est prévenue dans l'application (pas de SMS) ; ni le secrétariat qui a saisi, ni le comptable.
    expect(await unread('direction')).toBe(directionBefore + 1);
    const note = (await as('direction').get('/notifications')).body.items.find((n: any) => n.title === 'Doublon possible à vérifier');
    expect(note.body).toContain(`(${r.body.matricule}) ressemble au dossier SKG-26-0014`);
    expect(await unread('secretariat')).toBe(secretariatBefore);
    expect(await unread('comptable')).toBe(comptableBefore);
    await new Promise((done) => setTimeout(done, 200)); // au-delà du délai de repli des SMS (50 ms en test)
    expect(consoleSms.sent.slice(smsBefore).filter((m) => m.to === PHONES.direction || /Doublon/.test(m.text))).toEqual([]);
    const original = await sid('SKG-26-0014');
    const review = await inTenant((tx) => tx.duplicateReview.findFirstOrThrow({ where: { studentId: r.body.id } }));
    expect(review).toMatchObject({ otherId: original, status: 'PENDING', reason: 'NOM_NAISSANCE', decidedAt: null });
    expect(await inTenant((tx) => tx.student.count({ where: { id: { in: [original, r.body.id] } } }))).toBe(2);
    const audit = await inTenant((tx) => tx.auditLog.findFirstOrThrow({ where: { action: 'student.enrolled', entityId: r.body.id } }));
    expect(audit.data).toMatchObject({ duplicatesSignalled: ['SKG-26-0014'] });
  });

  it('la direction voit les doublons possibles et tranche ; le secrétariat ne tranche pas ; aucune fusion', async () => {
    expect((await as('secretariat').get('/students/duplicates')).status).toBe(403);
    const list = (await as('direction').get('/students/duplicates')).body;
    const pending = list.pending.find((p: any) => p.other?.matricule === 'SKG-26-0014');
    expect(pending).toMatchObject({ reason: 'NOM_NAISSANCE', note: expect.stringContaining('Jumelle') });
    expect(pending.id).toEqual(expect.any(String));
    const decide = (body: object) => as('direction').post('/students/duplicates/decision', body);
    expect((await as('secretariat').post('/students/duplicates/decision', { studentId: pending.student.id, otherId: pending.other.id, decision: 'DIFFERENT' })).status).toBe(403);
    // Deux dossiers qui ne se ressemblent pas ne font pas un doublon.
    expect((await decide({ studentId: pending.student.id, otherId: await sid('SKG-26-0001'), decision: 'SAME' })).status).toBe(400);
    expect((await decide({ studentId: pending.student.id, otherId: pending.other.id, decision: 'DIFFERENT', note: 'Deux élèves, vérifié' })).status).toBe(201);
    const after = (await as('direction').get('/students/duplicates')).body;
    expect(after.pending.some((p: any) => p.other?.matricule === 'SKG-26-0014')).toBe(false);
    expect(after.decided[0]).toMatchObject({ status: 'DIFFERENT', decisionNote: 'Deux élèves, vérifié' });
    expect(await inTenant((tx) => tx.student.count({ where: { lastName: 'MOUSSA' } }))).toBe(2);
    expect(await inTenant((tx) => tx.auditLog.count({ where: { action: 'student.duplicate_decided' } }))).toBe(1);
  });

  it('un doublon déjà en base (saisi avant le lot G4) est repéré et proposé à la direction', async () => {
    const original = await sid('SKG-26-0018');
    const klass = (await as('direction').get('/classes')).body.find((c: any) => c.name === '4e A');
    const copy = await inTenant(async (tx) => {
      const s = await tx.student.create({ data: { tenantId, matricule: 'SKG-26-9018', firstName: 'Yasmine', lastName: 'SOGLO', birthDate: new Date('2012-06-20') } });
      await tx.enrollment.create({ data: { tenantId, studentId: s.id, classId: klass.id, academicYearId: year1 } });
      return s.id;
    });
    const list = (await as('direction').get('/students/duplicates')).body;
    const found = list.pending.find((p: any) => p.student?.id === copy);
    expect(found).toMatchObject({ id: null, reason: 'NOM_NAISSANCE', other: { id: original, matricule: 'SKG-26-0018' } });
    expect((await as('direction').post('/students/duplicates/decision', { studentId: copy, otherId: original, decision: 'SAME', note: 'Même élève saisi deux fois' })).status).toBe(201);
    // « Même élève » ne fusionne ni n'annule rien : la direction annule elle-même l'inscription en trop.
    expect(await inTenant((tx) => tx.enrollment.count({ where: { studentId: { in: [copy, original] }, status: 'ACTIVE' } }))).toBe(2);
    expect((await as('direction').post(`/students/${copy}/enrollment/cancel`, { reason: 'Doublon de SKG-26-0018' })).status).toBe(201);
  });

  it("un secrétariat limité à un site apprend qu'un dossier existe sur l'autre site, sans en voir le détail", async () => {
    await secretariatSites(sites['Hêdomey']);
    try {
      const hedomey = (await as('direction').get('/classes')).body.find((c: any) => c.name === '1re année F3');
      const r = await as('secretariat').post('/students', pupil({ firstName: 'Gildas', lastName: 'AGBO', birthDate: '2012-06-20', classId: hedomey.id }));
      expect(r.status).toBe(409);
      expect(r.body.candidates).toEqual([{
        id: null, matricule: 'SKG-26-0013', firstName: 'Gildas', lastName: 'AGBO', birthDate: null, reason: 'NOM_NAISSANCE', reasonLabel: 'même nom et même date de naissance',
        lastClass: null, lastYear: '2026-2027', lastSite: 'Togbin', enrolledThisYear: true, otherSite: true,
      }]);
    } finally {
      await secretariatSites(null);
    }
  });
});

describe('Lot G4 · pré-inscriptions rattachées à un site (GRP-003)', () => {
  const application = (over: object = {}) => ({ studentFirstName: 'Afi', studentLastName: 'SITE', wantedLevel: '6e', guardianName: 'Parent Site', guardianPhone: '+2290196000201', ...over });
  const submit = (over: object) => http.post('/api/v1/public/saint-kisito/applications').send(application(over));
  const saved = (reference: string) => inTenant((tx) => tx.application.findFirstOrThrow({ where: { reference } }));

  it('le formulaire public propose les sites ; la demande garde le site choisi (ou aucun : « indifférent »)', async () => {
    const school = (await http.get('/api/v1/public/saint-kisito')).body;
    expect(school.sites.map((s: any) => s.name).sort()).toEqual(['Hêdomey', 'Togbin']);
    const togbin = await submit({ studentFirstName: 'Togbin', siteId: sites['Togbin'] });
    expect(togbin.status).toBe(201);
    expect(await saved(togbin.body.reference)).toMatchObject({ siteId: sites['Togbin'], wantedSite: 'Togbin' });
    const legacy = await submit({ studentFirstName: 'Ancien', wantedSite: 'hêdomey' });
    expect(await saved(legacy.body.reference)).toMatchObject({ siteId: sites['Hêdomey'], wantedSite: 'Hêdomey' });
    const any = await submit({ studentFirstName: 'Indifferent' });
    expect(await saved(any.body.reference)).toMatchObject({ siteId: null });
    expect((await submit({ siteId: '00000000-0000-4000-8000-000000000000' })).status).toBe(400);
    const otherSchoolSite = await inTenant(async (tx) => (await tx.site.findFirst()) ?? tx.site.create({ data: { tenantId: otherTenantId, name: 'Site d’une autre école' } }), otherTenantId);
    expect((await submit({ siteId: otherSchoolSite.id })).status).toBe(400);
  });

  it('un secrétariat limité à un site ne voit, ne reçoit et ne traite que les demandes de son site', async () => {
    await secretariatSites(sites['Hêdomey']);
    try {
      const unread = async (who: string) => (await as(who).get('/notifications')).body.unreadCount as number;
      const notifiedBefore = await unread('secretariat');
      const directionBefore = await unread('direction');
      const t = await submit({ studentFirstName: 'Pourtogbin', siteId: sites['Togbin'] });
      const h = await submit({ studentFirstName: 'Pourhedomey', siteId: sites['Hêdomey'] });
      expect(await unread('secretariat')).toBe(notifiedBefore + 1);
      const notes = JSON.stringify((await as('secretariat').get('/notifications')).body.items);
      expect(notes).toContain('Pourhedomey');
      expect(notes).not.toContain('Pourtogbin');
      // Aucun secrétariat ne couvre Togbin : la direction de tout l'établissement est prévenue à sa place.
      expect(await unread('direction')).toBe(directionBefore + 1);
      expect(JSON.stringify((await as('direction').get('/notifications')).body.items)).toContain('Pourtogbin');

      const listed = (await as('secretariat').get('/applications')).body;
      expect(listed.items.every((a: any) => a.siteId === sites['Hêdomey'])).toBe(true);
      expect(listed.items.some((a: any) => a.reference === h.body.reference)).toBe(true);
      expect(Object.values(listed.funnel as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(listed.items.length);
      const togbinApp = await saved(t.body.reference);
      const hedomeyApp = await saved(h.body.reference);
      expect((await as('secretariat').patch(`/applications/${togbinApp.id}`, { status: 'EN_TEST' })).status).toBe(403);
      expect((await as('secretariat').patch(`/applications/${hedomeyApp.id}`, { status: 'RECU', siteId: sites['Togbin'] })).status).toBe(403);
      // Inscrire depuis une demande d'un autre site : refusé, et rien n'est créé.
      const f3 = (await as('direction').get('/classes')).body.find((c: any) => c.name === '1re année F3');
      const enrol = await as('secretariat').post('/students', pupil({ firstName: 'Pourtogbin', lastName: 'SITE', classId: f3.id, applicationId: togbinApp.id }));
      expect(enrol.status).toBe(403);
      expect(await inTenant((tx) => tx.student.count({ where: { firstName: 'Pourtogbin' } }))).toBe(0);
      // La direction (tout l'établissement) rattache une demande « indifférente » à un site, sans SMS à la famille.
      const any = await submit({ studentFirstName: 'Sanssite', guardianPhone: '+2290196000202' });
      const anyApp = await saved(any.body.reference);
      expect((await as('secretariat').get('/applications')).body.items.some((a: any) => a.id === anyApp.id)).toBe(false);
      const sms = consoleSms.sent.length;
      expect((await as('direction').patch(`/applications/${anyApp.id}`, { status: 'RECU', siteId: sites['Hêdomey'] })).status).toBe(200);
      expect(consoleSms.sent.length).toBe(sms);
      expect((await as('secretariat').get('/applications')).body.items.some((a: any) => a.id === anyApp.id)).toBe(true);
    } finally {
      await secretariatSites(null);
    }
  });
});

describe("Lot G4 · réinscription pour la nouvelle année, sur le même dossier", () => {
  let history: (id: string) => Promise<unknown>;

  beforeAll(async () => {
    // L'année suivante, créée puis activée par la direction comme dans l'application. Dates relatives au jour du test,
    // pour que les règles de la date de sortie (pas avant la rentrée, pas dans le futur) restent vérifiables.
    const y = await as('direction').post('/academic-years', {
      label: '2027-2028', startDate: day(-2), endDate: day(250),
      terms: [{ name: 'Trimestre 1', startDate: day(-2), endDate: day(80) }, { name: 'Trimestre 2', startDate: day(81), endDate: day(160) }, { name: 'Trimestre 3', startDate: day(161), endDate: day(250) }],
    });
    expect(y.status).toBe(201);
    year2 = y.body.id;
    // Avant d'activer l'année : un bulletin publié et une décision de fin d'année pour l'élève suivi.
    const p = await sid('SKG-26-0013');
    const e = await inTenant((tx) => tx.enrollment.findFirstOrThrow({ where: { studentId: p, academicYearId: year1 } }));
    const director = await userId(PHONES.direction);
    await inTenant((tx) => tx.annualDecision.create({ data: { tenantId, studentId: p, academicYearId: year1, classId: e.classId, outcome: 'ADMIS', decidedById: director } }));
    expect((await as('direction').post(`/academic-years/${year2}/current`)).status).toBe(201);
    const settings = (await as('direction').get('/settings')).body;
    const level = (name: string) => settings.levels.find((l: any) => l.name === name).id;
    const f3 = settings.tracks.find((t: any) => t.code === 'F3').id;
    for (const [name, site, levelId, trackId, capacity] of [['3e A', 'Togbin', level('3e'), null, 40], ['2e année F3', 'Hêdomey', level('2e année'), f3, 40], ['3e B', 'Togbin', level('3e'), null, 1]] as const) {
      const c = await as('direction').post('/classes', { name, siteId: sites[site], levelId, trackId, capacity });
      expect(c.status).toBe(201);
      newClasses[name] = c.body.id;
    }
    history = (id: string) => inTenant(async (tx) => ({
      student: await tx.student.findUniqueOrThrow({ where: { id } }),
      guardians: await tx.studentGuardian.findMany({ where: { studentId: id }, orderBy: { id: 'asc' } }),
      grades: await tx.grade.findMany({ where: { studentId: id }, orderBy: { id: 'asc' } }),
      reportCards: await tx.reportCard.findMany({ where: { studentId: id }, include: { items: true }, orderBy: { id: 'asc' } }),
      invoices: await tx.invoice.findMany({ where: { studentId: id }, include: { items: true, payments: { include: { receipt: true } } }, orderBy: { id: 'asc' } }),
      attendance: await tx.attendanceRecord.findMany({ where: { studentId: id }, orderBy: { id: 'asc' } }),
      decisions: await tx.annualDecision.findMany({ where: { studentId: id } }),
      pastEnrollment: await tx.enrollment.findFirstOrThrow({ where: { studentId: id, academicYearId: year1 } }),
    }));
  });

  it("la liste des élèves à réinscrire : ceux de l'an dernier sans inscription cette année, avec leur classe et leur résultat", async () => {
    expect((await as('teacher').get('/students/reenrollment')).status).toBe(403);
    expect((await as('comptable').get('/students/reenrollment')).status).toBe(403);
    const r = (await as('secretariat').get('/students/reenrollment')).body;
    expect(r.toYear).toEqual({ id: year2, label: '2027-2028' });
    expect(r.fromYear).toEqual({ id: year1, label: '2026-2027' });
    const matricules = r.items.map((i: any) => i.matricule);
    // Partis (0011) ou inscription annulée (0017, 9018) : pas dans la liste ; tous les autres y sont.
    expect(matricules).toEqual(expect.arrayContaining(['SKG-26-0001', 'SKG-26-0013', 'SKG-26-0016', 'SKG-26-0018']));
    expect(matricules.filter((m: string) => ['SKG-26-0011', 'SKG-26-0017', 'SKG-26-9018'].includes(m))).toEqual([]);
    const gildas = r.items.find((i: any) => i.matricule === 'SKG-26-0013');
    expect(gildas).toMatchObject({ outcome: 'ADMIS', fromClass: { name: '4e A', level: '4e', site: { name: 'Togbin' } } });
    // Une année qui n'est pas antérieure est refusée.
    expect((await as('secretariat').get(`/students/reenrollment?fromYearId=${year2}`)).status).toBe(400);
  });

  it('réinscription : même dossier et même matricule ; notes, bulletins, paiements, absences et décisions intacts', async () => {
    const id = await sid('SKG-26-0013');
    const before = await history(id);
    const r = await as('secretariat').post(`/students/${id}/reenroll`, { classId: newClasses['3e A'] });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ id, matricule: 'SKG-26-0013', className: '3e A', year: '2027-2028', invoices: 0, reinstated: false });
    expect(await history(id)).toEqual(before);
    const enrollments = await inTenant((tx) => tx.enrollment.findMany({ where: { studentId: id }, include: { academicYear: true, events: true }, orderBy: { enrolledAt: 'asc' } }));
    expect(enrollments.map((e) => [e.academicYear.label, e.status, e.type])).toEqual([['2026-2027', 'ACTIVE', null], ['2027-2028', 'ACTIVE', 'RETURNING']]);
    expect(enrollments[1].events.map((e) => [e.kind, e.data])).toEqual([['REENROLLED', { classId: newClasses['3e A'], className: '3e A', fromYear: '2026-2027', fromClass: '4e A', studentStatusBefore: 'ACTIVE' }]]);
    expect(await inTenant((tx) => tx.student.count({ where: { matricule: 'SKG-26-0013' } }))).toBe(1);
    const file = (await as('direction').get(`/students/${id}`)).body;
    expect(file.currentClass).toMatchObject({ name: '3e A' });
    expect(file.enrollments.map((e: any) => e.academicYear.label)).toEqual(['2027-2028', '2026-2027']);
    expect(file.reenrollable).toBe(false);
    expect(file.currentYear).toEqual({ id: year2, label: '2027-2028' });
    // Le bulletin publié, les notes et les paiements de l'an dernier restent consultables par la famille et le comptable.
    expect((await as('direction').get(`/finance/invoices?studentId=${id}`)).body.length).toBe((before as any).invoices.length);
    expect(await inTenant((tx) => tx.auditLog.count({ where: { action: 'student.reenrolled', entityId: id } }))).toBe(1);
  });

  it('une seconde réinscription la même année est refusée, et la liste ne propose plus cet élève', async () => {
    const id = await sid('SKG-26-0013');
    const again = await as('secretariat').post(`/students/${id}/reenroll`, { classId: newClasses['3e A'] });
    expect(again.status).toBe(409);
    expect(again.body.message).toMatch(/déjà inscrit\(e\) pour 2027-2028 \(3e A\)/);
    expect(await inTenant((tx) => tx.enrollment.count({ where: { studentId: id, academicYearId: year2 } }))).toBe(1);
    const items = (await as('secretariat').get('/students/reenrollment')).body.items;
    expect(items.some((i: any) => i.id === id)).toBe(false);
    // L'inscription « nouvel élève » ne contourne pas la règle : elle s'arrête sur le dossier existant.
    const dup = await as('secretariat').post('/students', pupil({ firstName: 'Gildas', lastName: 'AGBO', birthDate: '2012-06-20', classId: newClasses['3e A'] }));
    expect(dup.status).toBe(409);
    expect(dup.body.candidates[0]).toMatchObject({ matricule: 'SKG-26-0013', enrolledThisYear: true });
  });

  it("classe d'une année passée, élève ou classe hors du périmètre, classe complète : refusés", async () => {
    const id = await sid('SKG-26-0012');
    const oldClass = (await inTenant((tx) => tx.class.findFirstOrThrow({ where: { academicYearId: year1, name: '4e A' } }))).id;
    expect((await as('secretariat').post(`/students/${id}/reenroll`, { classId: oldClass })).status).toBe(400);
    // Classe de 1 place déjà prise.
    expect((await as('secretariat').post(`/students/${await sid('SKG-26-0014')}/reenroll`, { classId: newClasses['3e B'] })).status).toBe(201);
    const full = await as('secretariat').post(`/students/${id}/reenroll`, { classId: newClasses['3e B'] });
    expect(full.status).toBe(409);
    expect(full.body.message).toMatch(/complète/);
    await secretariatSites(sites['Hêdomey']);
    try {
      // Élève de Togbin, secrétariat de Hêdomey : refusé, même vers une classe de Hêdomey.
      expect((await as('secretariat').post(`/students/${id}/reenroll`, { classId: newClasses['2e année F3'] })).status).toBe(403);
      // Élève de Hêdomey vers une classe de Togbin : refusé aussi.
      expect((await as('secretariat').post(`/students/${await sid('SKG-26-0002')}/reenroll`, { classId: newClasses['3e A'] })).status).toBe(403);
      const listed = (await as('secretariat').get('/students/reenrollment')).body.items;
      expect(listed.length).toBeGreaterThan(0);
      expect(listed.every((i: any) => i.fromClass.site.name === 'Hêdomey')).toBe(true);
      expect((await as('secretariat').post(`/students/${await sid('SKG-26-0002')}/reenroll`, { classId: newClasses['2e année F3'] })).status).toBe(201);
    } finally {
      await secretariatSites(null);
    }
    expect(await inTenant((tx) => tx.enrollment.count({ where: { studentId: id, academicYearId: year2 } }))).toBe(0);
  });

  it("un secrétariat limité à un site ouvre le dossier d'un ancien élève de son site pour le réinscrire, jamais celui d'un autre site", async () => {
    const hedomey = await sid('SKG-26-0005');
    await secretariatSites(sites['Hêdomey']);
    try {
      const former = await as('secretariat').get(`/students/${hedomey}`);
      expect(former.status).toBe(200);
      expect(former.body).toMatchObject({ matricule: 'SKG-26-0005', currentClass: null, reenrollable: true });
      expect(former.body.enrollments.map((e: any) => e.academicYear.label)).toEqual(['2026-2027']);
      expect((await as('secretariat').get(`/students/${await sid('SKG-26-0015')}`)).status).toBe(403);
    } finally {
      await secretariatSites(null);
    }
    // Les autres rôles n'y gagnent rien : un enseignant ne voit pas un élève qui n'est plus dans ses classes.
    expect((await as('teacher').get(`/students/${hedomey}`)).status).toBe(403);
  });

  it("frais : la réinscription facture les frais « anciens élèves » de la nouvelle année, jamais ceux des nouveaux", async () => {
    for (const [name, amount, audience] of [['Réinscription 2027-2028', 3500, 'RETURNING'], ['Inscription 2027-2028', 5000, 'NEW'], ['Frais généraux 2027-2028', 2500, 'ALL']] as const) {
      expect((await as('direction').post('/finance/fee-types', { name, amount, audience })).status).toBe(201);
    }
    const id = await sid('SKG-26-0012');
    const r = await as('secretariat').post(`/students/${id}/reenroll`, { classId: newClasses['3e A'], createInvoices: true });
    expect(r.status).toBe(201);
    expect(r.body.invoices).toBe(2);
    const labels = (await as('direction').get(`/finance/invoices?studentId=${id}`)).body.map((i: any) => i.label);
    expect(labels).toEqual(expect.arrayContaining(['Réinscription 2027-2028', 'Frais généraux 2027-2028']));
    expect(labels).not.toContain('Inscription 2027-2028');
  });

  it("annulée puis réinscrite : la même inscription est rétablie (jamais une seconde), sans nouvelle facture", async () => {
    const id = await sid('SKG-26-0012');
    const invoices = await inTenant((tx) => tx.invoice.count({ where: { studentId: id } }));
    const first = await inTenant((tx) => tx.enrollment.findFirstOrThrow({ where: { studentId: id, academicYearId: year2 } }));
    expect((await as('direction').post(`/students/${id}/enrollment/cancel`, { reason: 'Famille partie avant la rentrée' })).status).toBe(201);
    expect((await as('secretariat').get('/students/reenrollment')).body.items.some((i: any) => i.id === id)).toBe(true);
    const r = await as('secretariat').post(`/students/${id}/reenroll`, { classId: newClasses['3e A'], createInvoices: true });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ reinstated: true, enrollmentId: first.id, invoices: 0 });
    const e = await inTenant((tx) => tx.enrollment.findFirstOrThrow({ where: { studentId: id, academicYearId: year2 }, include: { events: { orderBy: { createdAt: 'asc' } } } }));
    expect(e).toMatchObject({ id: first.id, status: 'ACTIVE', cancelledAt: null, cancelReason: null, cancelledById: null, enrolledAt: first.enrolledAt });
    expect(e.events.map((x) => x.kind)).toEqual(['REENROLLED', 'CANCELLED', 'REINSTATED']);
    expect(e.events[2].data).toMatchObject({ previousStatus: 'CANCELLED', cancelReason: 'Famille partie avant la rentrée' });
    expect(await inTenant((tx) => tx.invoice.count({ where: { studentId: id } }))).toBe(invoices);
  });

  it("élève parti l'an dernier : réinscrit depuis son dossier ; si cette réinscription est annulée, il redevient « transféré »", async () => {
    const id = await sid('SKG-26-0011'); // parti le jour du test (voir plus haut)
    const r = await as('direction').post(`/students/${id}/reenroll`, { classId: newClasses['3e A'] });
    expect(r.status).toBe(201);
    expect((await inTenant((tx) => tx.student.findUniqueOrThrow({ where: { id } }))).status).toBe('ACTIVE');
    expect((await as('direction').post(`/students/${id}/enrollment/cancel`, { reason: 'Réinscrit par erreur' })).status).toBe(201);
    const s = await inTenant((tx) => tx.student.findUniqueOrThrow({ where: { id } }));
    expect(s.status).toBe('TRANSFERRED');
    const last = await inTenant((tx) => tx.enrollmentEvent.findFirstOrThrow({ where: { enrollment: { studentId: id, academicYearId: year2 }, kind: 'CANCELLED' } }));
    expect(last.data).toMatchObject({ studentStatusRestored: 'TRANSFERRED' });
  });

  it("départ dans la nouvelle année puis retour : l'inscription est rétablie, la sortie reste dans l'historique", async () => {
    const id = await sid('SKG-26-0016');
    expect((await as('secretariat').post(`/students/${id}/reenroll`, { classId: newClasses['3e A'] })).status).toBe(201);
    expect((await as('secretariat').post(`/students/${id}/withdraw`, { status: 'WITHDRAWN', reason: 'Abandon', exitDate: day(0) })).status).toBe(201);
    expect((await as('secretariat').post(`/students/${id}/reenroll`, { classId: newClasses['3e A'] })).body).toMatchObject({ reinstated: true });
    const e = await inTenant((tx) => tx.enrollment.findFirstOrThrow({ where: { studentId: id, academicYearId: year2 }, include: { events: { orderBy: { createdAt: 'asc' } } } }));
    expect(e).toMatchObject({ status: 'ACTIVE', exitDate: null, exitReason: null });
    expect(e.events.map((x) => x.kind)).toEqual(['REENROLLED', 'WITHDRAWN', 'REINSTATED']);
    expect(e.events[2].data).toMatchObject({ previousStatus: 'WITHDRAWN', exitDate: day(0), exitReason: 'Abandon', studentStatusBefore: 'WITHDRAWN' });
  });

  it("réinscription depuis une pré-inscription : la demande passe « inscrite », ne sert qu'une fois et reste dans le périmètre du site", async () => {
    const submit = async (over: object) => {
      const r = await http.post('/api/v1/public/saint-kisito/applications')
        .send({ studentFirstName: 'Rachidatou', studentLastName: 'ASSOGBA', wantedLevel: '2e année', guardianName: 'Parent Assogba', guardianPhone: '+2290196000301', ...over });
      expect(r.status).toBe(201);
      return (await inTenant((tx) => tx.application.findFirstOrThrow({ where: { reference: r.body.reference } }))).id;
    };
    const forHedomey = await submit({ siteId: sites['Hêdomey'] });
    const forTogbin = await submit({ siteId: sites['Togbin'] });
    const id = await sid('SKG-26-0003'); // élève de Hêdomey, pas encore réinscrit
    await secretariatSites(sites['Hêdomey']);
    try {
      expect((await as('secretariat').post(`/students/${id}/reenroll`, { classId: newClasses['2e année F3'], applicationId: forTogbin })).status).toBe(403);
      expect((await as('secretariat').post(`/students/${id}/reenroll`, { classId: newClasses['2e année F3'], applicationId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
      expect(await inTenant((tx) => tx.enrollment.count({ where: { studentId: id, academicYearId: year2 } }))).toBe(0);
      const r = await as('secretariat').post(`/students/${id}/reenroll`, { classId: newClasses['2e année F3'], applicationId: forHedomey });
      expect(r.status).toBe(201);
    } finally {
      await secretariatSites(null);
    }
    expect(await inTenant((tx) => tx.application.findUniqueOrThrow({ where: { id: forHedomey } }))).toMatchObject({ status: 'INSCRIT', studentId: id });
    expect(await inTenant((tx) => tx.application.findUniqueOrThrow({ where: { id: forTogbin } }))).toMatchObject({ status: 'RECU', studentId: null });
    const audit = await inTenant((tx) => tx.auditLog.findFirstOrThrow({ where: { action: 'student.reenrolled', entityId: id } }));
    expect(audit.data).toMatchObject({ applicationId: forHedomey });
    // La même demande ne sert pas une seconde fois : ni pour un autre ancien élève, ni pour un nouvel élève.
    const other = await sid('SKG-26-0004');
    const again = await as('secretariat').post(`/students/${other}/reenroll`, { classId: newClasses['2e année F3'], applicationId: forHedomey });
    expect(again.status).toBe(409);
    expect(again.body.message).toBe('Cette pré-inscription a déjà servi à inscrire un élève (SKG-26-0003)');
    const fresh = await as('secretariat').post('/students', pupil({ firstName: 'Rachidatou', lastName: 'ASSOGBA', classId: newClasses['2e année F3'], applicationId: forHedomey }));
    expect(fresh.status).toBe(409);
    expect(fresh.body.message).toMatch(/déjà servi à inscrire un élève \(SKG-26-0003\)/);
    expect(await inTenant((tx) => tx.enrollment.count({ where: { studentId: other, academicYearId: year2 } }))).toBe(0);
    expect(await inTenant((tx) => tx.student.count({ where: { lastName: 'ASSOGBA' } }))).toBe(0);
  });

  it("l'historique des inscriptions n'est visible que de la direction et du secrétariat", async () => {
    const id = await sid('SKG-26-0001');
    expect((await as('secretariat').post(`/students/${id}/reenroll`, { classId: newClasses['2e année F3'] })).status).toBe(201);
    const full = (await as('secretariat').get(`/students/${id}`)).body;
    expect(full.enrollments[0].events.map((x: any) => x.kind)).toEqual(['REENROLLED']);
    for (const who of ['parent', 'student', 'comptable']) {
      const r = (await as(who).get(`/students/${id}`)).body;
      expect(r.enrollments[0].events).toBeUndefined();
      expect(r.reenrollable).toBe(false);
    }
  });
});

describe('Lot G4 · élèves facturables à une date de référence (préparation de la facturation, aucune facture)', () => {
  const R = '2027-03-31';
  const at = (iso: string) => new Date(iso);
  let ids: Record<string, string> = {};

  beforeAll(async () => {
    // Inscriptions de la nouvelle année aux dates voulues (base de test seulement).
    const take = async (matricule: string) => {
      const id = await sid(matricule);
      const e = await inTenant((tx) => tx.enrollment.findUnique({ where: { studentId_academicYearId: { studentId: id, academicYearId: year2 } } }));
      if (!e) expect((await as('direction').post(`/students/${id}/reenroll`, { classId: newClasses[matricule <= 'SKG-26-0010' ? '2e année F3' : '3e A'] })).status).toBe(201);
      return (await inTenant((tx) => tx.enrollment.findUniqueOrThrow({ where: { studentId_academicYearId: { studentId: id, academicYearId: year2 } } }))).id;
    };
    ids = {
      active: await take('SKG-26-0003'),
      cancelledBefore: await take('SKG-26-0004'),
      cancelledAfter: await take('SKG-26-0005'),
      exitOnR: await take('SKG-26-0006'),
      exitAfter: await take('SKG-26-0007'),
      enrolledAfter: await take('SKG-26-0008'),
      lateEvening: await take('SKG-26-0009'),
      nextMorning: await take('SKG-26-0010'),
    };
    const set = (id: string, data: Prisma.EnrollmentUpdateInput) => inTenant((tx) => tx.enrollment.update({ where: { id }, data }));
    const early = at('2027-03-01T09:00:00Z');
    for (const id of Object.values(ids)) await set(id, { enrolledAt: early });
    await set(ids.cancelledBefore, { status: 'CANCELLED', cancelledAt: at('2027-03-30T10:00:00Z'), cancelReason: 'Test' });
    await set(ids.cancelledAfter, { status: 'CANCELLED', cancelledAt: at('2027-04-01T10:00:00Z'), cancelReason: 'Test' });
    await set(ids.exitOnR, { status: 'WITHDRAWN', exitDate: at(`${R}T00:00:00Z`), exitReason: 'Test' });
    await set(ids.exitAfter, { status: 'TRANSFERRED', exitDate: at('2027-04-02T00:00:00Z'), exitReason: 'Test' });
    await set(ids.enrolledAfter, { enrolledAt: at('2027-04-03T08:00:00Z') });
    await set(ids.lateEvening, { enrolledAt: at(`${R}T22:30:00Z`) }); // 23 h 30 à Porto-Novo, encore le 31 mars
    await set(ids.nextMorning, { enrolledAt: at(`${R}T23:30:00Z`) }); // 0 h 30 le 1er avril à Porto-Novo
  });

  const billable = (date: string) => inTenant((tx) => billableEnrollments(tx, year2, date, 'Africa/Porto-Novo'));

  it('compte les inscriptions actives à la fin du jour R, dans le fuseau de l’école', async () => {
    const rows = await billable(R);
    const got = new Set(rows.map((r) => r.id));
    expect(got.has(ids.active)).toBe(true);
    expect(got.has(ids.cancelledBefore)).toBe(false); // annulée avant R
    expect(got.has(ids.cancelledAfter)).toBe(true); // annulée après R : elle était active à R
    expect(got.has(ids.exitOnR)).toBe(false); // sortie le jour R
    expect(got.has(ids.exitAfter)).toBe(true); // sortie après R
    expect(got.has(ids.enrolledAfter)).toBe(false); // inscrite après R
    expect(got.has(ids.lateEvening)).toBe(true);
    expect(got.has(ids.nextMorning)).toBe(false);
  });

  it("un élève n'est jamais compté deux fois dans la même école pour la même année ; rien d'une autre école", async () => {
    const rows = await billable(R);
    expect(new Set(rows.map((r) => r.studentId)).size).toBe(rows.length);
    expect(rows.every((r) => r.student.matricule.startsWith('SKG-'))).toBe(true);
    // La veille, l'inscription annulée le 30 mars comptait encore ; la sortie du 31 mars aussi.
    const before = new Set((await billable('2027-03-29')).map((r) => r.id));
    expect(before.has(ids.cancelledBefore)).toBe(true);
    expect(before.has(ids.exitOnR)).toBe(true);
    // Aucune facture n'est créée par ce calcul.
    const invoices = await inTenant((tx) => tx.invoice.count());
    await billable(R);
    expect(await inTenant((tx) => tx.invoice.count())).toBe(invoices);
  });
});
