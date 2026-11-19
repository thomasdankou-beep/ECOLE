/**
 * Lot G5b, comptages des élèves facturables, de bout en bout sur la base de test (erp_test), avec des établissements,
 * des comptes et des élèves entièrement fictifs créés pour ce fichier. Aucun montant, aucune facture, aucun SMS.
 * Décisions du 19 novembre 2026 : D-G5-13 B (la direction décide d'une exclusion), D-G5-14 A (corrections pendant la
 * vérification), D-G5-16 A (départ enregistré avant l'historique : date du journal, la direction peut l'avancer ;
 * sans date, l'élève reste compté).
 *
 * Calendrier simulé autour d'aujourd'hui (T) : essai du T-30 au T-17, comptage initial le T-20 (pendant l'essai : jamais
 * fait), première régularisation le T-3, comptée le T-2 ; la direction vérifie aujourd'hui ; le comptage est figé le
 * lendemain du dernier jour de vérification.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { createHash } from 'crypto';
import { authenticator } from 'otplib';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { AuditService } from '../src/common/audit.service';
import { localDay } from '../src/common/country';
import { PrismaService } from '../src/common/prisma.service';
import { BillingJobsService } from '../src/modules/billing/billing-jobs';
import { addDays } from '../src/modules/billing/billing-rules';
import { CountsService } from '../src/modules/billing/counts';
import { FilesService } from '../src/modules/files/files.service';
import { PlatformDb } from '../src/modules/platform/platform';
import { endOfSchoolDay } from '../src/modules/students/enrollments';

const TZ = 'Africa/Porto-Novo';
const PASSWORD = 'Comptages-G5b-2026';
const SA_PASSWORD = 'Plateforme-G5b-2026';
const stamp = Date.now().toString(36);
const T = localDay(TZ);
const d = (n: number) => addDays(T, n);
/** Midi à Porto-Novo, le jour donné : l'instant simulé de la tâche planifiée. */
const at = (day: string) => new Date(`${day}T11:00:00.000Z`);
/** 9 h à Porto-Novo, le jour donné : instant d'une opération fictive passée. */
const morning = (day: string) => new Date(`${day}T08:00:00.000Z`);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

let app: INestApplication;
let http: ReturnType<typeof request>;
const admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_ADMIN_URL } } });
const appDb = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
const groupDb = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_GROUP_URL } } });
const statsDb = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_STATS_URL } } });

type School = { id: string; slug: string; name: string; groupId: string; direction: string; directionId: string; secretariat?: string; siteDirection?: string };
const K = {} as School; // l'établissement compté
const M = {} as School; // un établissement sans année scolaire à la fin de son essai
const sa = { id: '', name: 'Super Admin comptages (fictif)', email: `g5b-${stamp}@test.local`, cookie: '', secret: '' };

// Année scolaire de K, ses classes et ses sites.
const year = { id: '', label: '', start: d(-70), end: d(250) };
const klass: Record<'A' | 'B', { id: string; siteId: string }> = {} as never;
/** Inscriptions fictives de K : clé du cas → inscription et élève. */
const E: Record<string, { enrollmentId: string; studentId: string; matricule: string; lastName: string }> = {};
let trialEnd = '';
const R = d(-3);
let provisionalId = '';
let reviewUntil = '';

function inTenant<T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>, client = admin) {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}

async function code(secret = sa.secret) {
  const left = 30_000 - (Date.now() % 30_000);
  if (left < 3000) await new Promise((r) => setTimeout(r, left + 200));
  return authenticator.generate(secret);
}

const cookieOf = (r: request.Response) => (r.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('erp_pt='))!.split(';')[0];
const pf = {
  get: (url: string) => http.get(`/api/v1/platform${url}`).set('Cookie', sa.cookie),
  post: (url: string, body: object = {}) => http.post(`/api/v1/platform${url}`).set('Cookie', sa.cookie).send(body),
};
const as = (token: string) => ({
  get: (url: string) => http.get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
  post: (url: string, body: object = {}) => http.post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body),
});
const message = (r: request.Response) => JSON.stringify(r.body.message);

async function login(slug: string, phone: string) {
  const r = await http.post('/api/v1/auth/login').send({ tenant: slug, identifier: phone, password: PASSWORD });
  expect(r.status).toBe(200);
  return r.body.accessToken as string;
}

/** Établissement fictif créé il y a 60 jours, seul dans son groupe ; direction de tout l'établissement et, pour K, d'autres comptes. */
async function newSchool(s: School, key: string, full: boolean) {
  const t = await admin.tenant.create({
    data: {
      slug: `g5b-${key}-${stamp}`, name: `École fictive G5b ${key.toUpperCase()} ${stamp}`, timezone: TZ, createdAt: morning(d(-60)),
      group: { create: { name: `Groupe fictif G5b ${key.toUpperCase()} ${stamp}` } },
    },
  });
  Object.assign(s, { id: t.id, slug: t.slug, name: t.name, groupId: t.groupId });
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  await inTenant(t.id, async (tx) => {
    const add = async (phone: string, role: 'DIRECTION' | 'SECRETARIAT', last: string, siteId: string | null = null) => {
      const u = await tx.user.create({ data: { tenantId: t.id, phone, firstName: 'Fictif', lastName: last, passwordHash: hash, mustChangePassword: false } });
      await tx.userRole.create({ data: { tenantId: t.id, userId: u.id, role, siteId } });
      return u.id;
    };
    s.directionId = await add('+2290190007001', 'DIRECTION', `DIRECTION ${key}`);
    if (!full) return;
    const sites = await Promise.all(['Site fictif Nord', 'Site fictif Sud'].map((name) => tx.site.create({ data: { tenantId: t.id, name } })));
    const level = await tx.level.create({ data: { tenantId: t.id, name: '6e', cycle: 'COLLEGE', position: 1 } });
    const y = await tx.academicYear.create({ data: { tenantId: t.id, label: year.label, startDate: new Date(year.start), endDate: new Date(year.end), isCurrent: true } });
    year.id = y.id;
    for (const [name, i] of [['A', 0], ['B', 1]] as const) {
      const c = await tx.class.create({ data: { tenantId: t.id, academicYearId: y.id, siteId: sites[i].id, levelId: level.id, name: `6e ${name}` } });
      klass[name] = { id: c.id, siteId: sites[i].id };
    }
    await add('+2290190007002', 'SECRETARIAT', `SECRETARIAT ${key}`);
    await add('+2290190007003', 'DIRECTION', `DIRECTION SITE ${key}`, sites[0].id);
  });
  s.direction = await login(s.slug, '+2290190007001');
  if (full) {
    s.secretariat = await login(s.slug, '+2290190007002');
    s.siteDirection = await login(s.slug, '+2290190007003');
  }
}

let n = 0;
/**
 * Inscription fictive de K. `recordedAt` : moment où l'inscription a été saisie (ligne d'historique) ; `legacy` :
 * départ enregistré avant l'historique des inscriptions (aucune ligne, inscription et élève retirés, date inconnue).
 */
async function enrol(key: string, c: 'A' | 'B', enrolledAt: Date, opts: { recordedAt?: Date; legacy?: boolean } = {}) {
  const lastName = `COMPTE${String(++n).padStart(2, '0')}${stamp.toUpperCase()}`;
  E[key] = await inTenant(K.id, async (tx) => {
    const s = await tx.student.create({
      data: { tenantId: K.id, matricule: `G5B-${stamp}-${n}`, firstName: `Cas ${key}`, lastName, status: opts.legacy ? 'WITHDRAWN' : 'ACTIVE' },
    });
    const e = await tx.enrollment.create({
      data: { tenantId: K.id, studentId: s.id, classId: klass[c].id, academicYearId: year.id, enrolledAt, type: 'NEW', status: opts.legacy ? 'WITHDRAWN' : 'ACTIVE' },
    });
    if (!opts.legacy) {
      await tx.enrollmentEvent.create({ data: { tenantId: K.id, enrollmentId: e.id, kind: 'ENROLLED', data: { classId: klass[c].id, className: `6e ${c}`, type: 'NEW' }, createdAt: opts.recordedAt ?? enrolledAt } });
    }
    return { enrollmentId: e.id, studentId: s.id, matricule: s.matricule, lastName };
  });
}

/** Sortie datée, enregistrée à l'instant `recordedAt` : la ligne de l'inscription et sa ligne d'historique ensemble. */
const leave = (key: string, recordedAt: Date, exitDate: string) =>
  inTenant(K.id, async (tx) => {
    await tx.enrollment.update({ where: { id: E[key].enrollmentId }, data: { status: 'WITHDRAWN', exitDate: new Date(`${exitDate}T00:00:00Z`), exitReason: 'Départ fictif' } });
    await tx.enrollmentEvent.create({ data: { tenantId: K.id, enrollmentId: E[key].enrollmentId, kind: 'WITHDRAWN', data: { exitDate, reason: 'Départ fictif' }, createdAt: recordedAt } });
  });

const countsOf = (tenantId: string) => admin.billingCount.findMany({ where: { tenantId }, orderBy: [{ referenceDate: 'asc' }, { createdAt: 'asc' }] });
const itemsOf = (tenantId: string, countId: string) => inTenant(tenantId, (tx) => tx.billingCountItem.findMany({ where: { countId } }));
const keysOf = (items: { enrollmentId: string; counted?: boolean }[], counted = true) =>
  Object.keys(E).filter((k) => items.some((i) => i.enrollmentId === E[k].enrollmentId && (i.counted ?? true) === counted)).sort();
const mine = (done: string[], s: School) => done.filter((x) => x.endsWith(`:${s.name}`));
/** Empreinte attendue d'une liste (même règle que la base) : inscriptions triées, « inscription:motif:date de départ ». */
const listHash = (items: { enrollmentId: string; basis: string; departureDate: string | Date | null }[]) =>
  createHash('sha256').update([...items]
    .map((i) => `${i.enrollmentId}:${i.basis}:${i.departureDate instanceof Date ? i.departureDate.toISOString().slice(0, 10) : i.departureDate ?? ''}`)
    .sort().join(',')).digest('hex');

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  configureApp(app);
  await app.init();
  http = request(app.getHttpServer());

  const y = Number(year.start.slice(0, 4));
  year.label = `${y}-${y + 1}`;
  await newSchool(K, 'k', true);
  await newSchool(M, 'm', false);

  await admin.platformAdmin.create({ data: { email: sa.email, name: sa.name, passwordHash: await argon2.hash(SA_PASSWORD), mustChangePassword: false, mustSetupTwoFactor: false } });
  sa.id = (await admin.platformAdmin.findUniqueOrThrow({ where: { email: sa.email } })).id;
  sa.cookie = cookieOf(await http.post('/api/v1/platform/auth/login').send({ email: sa.email, password: SA_PASSWORD }).expect(201));
  const setup = await pf.post('/auth/2fa/setup').expect(201);
  sa.secret = setup.body.secret;
  await pf.post('/auth/2fa/enable', { code: await code(), setupToken: setup.body.setupToken }).expect(201);

  // Élèves fictifs de K, inscrits à la rentrée sauf mention contraire.
  const rentree = morning(year.start);
  await enrol('a1_actif', 'A', rentree);
  await enrol('a2_actifSud', 'B', rentree);
  await enrol('c1_erreur', 'A', rentree); // annulée aujourd'hui par erreur de saisie, exclusion validée
  await enrol('c2_erreurRefusee', 'A', rentree); // annulée aujourd'hui, exclusion refusée
  await enrol('w1_departReel', 'B', rentree);
  await leave('w1_departReel', morning(d(-1)), d(-1)); // parti après le jour R : compté, jamais exclu
  await enrol('g1_partiEntre', 'A', rentree);
  await leave('g1_partiEntre', morning(d(-12)), d(-12)); // présent à la fin de l'essai, parti avant R
  await enrol('u1_journal', 'A', rentree, { legacy: true }); // départ d'avant l'historique, journal du T-10
  await enrol('u2_dateDirection', 'A', rentree, { legacy: true }); // sans date ; la direction le date du T-5
  await enrol('u3_sansDate', 'B', rentree, { legacy: true }); // sans date : reste compté et signalé
  await enrol('l1_saisieTardive', 'A', morning(d(-10)), { recordedAt: new Date() }); // arrivé le T-10, saisi aujourd'hui
  await inTenant(K.id, (tx) => tx.auditLog.create({
    data: { tenantId: K.id, userId: null, userName: 'Secrétariat fictif', action: 'student.withdrawn', entity: 'Student', entityId: E.u1_journal.studentId, createdAt: morning(d(-10)) },
  }));
});

afterAll(async () => {
  await app?.close();
  await admin.platformAdmin.deleteMany({ where: { email: sa.email } });
  await Promise.all([admin.$disconnect(), appDb.$disconnect(), groupDb.$disconnect(), statsDb.$disconnect()]);
});

describe('Lot G5b · comptages des élèves facturables (données fictives)', () => {
  it('fin d’essai : comptage figé aussitôt avec l’historique de la fin du dernier jour gratuit, une seule fois', async () => {
    for (const s of [K, M]) {
      const r = await pf.post(`/billing/establishments/${s.id}/trial`, { startDate: d(-30), code: await code() });
      expect(r.status).toBe(201);
      trialEnd = r.body.trialEnd;
    }
    // Le comptage initial (T-20) tombe pendant l'essai ; la régularisation (T-3) après.
    expect(trialEnd >= d(-20) && trialEnd < R).toBe(true);
    const cal = await pf.post(`/billing/establishments/${K.id}/calendars`, {
      yearLabel: year.label, startDate: year.start, endDate: year.end, initialCountDate: d(-20), firstRegularizationDate: R, finalRegularizationDate: d(100),
      formula: 'MANUEL', reason: 'Calendrier fictif (test G5b)', code: await code(),
    });
    expect(cal.status).toBe(201);
    const counts = app.get(CountsService);
    // Pendant l'essai, et le dernier jour gratuit lui-même : rien.
    expect(mine((await counts.runDue(at(trialEnd))).done, K)).toEqual([]);
    // Fin de l'essai constatée par la tâche de l'abonnement (lot G5a), puis le comptage.
    const jobs = app.get(BillingJobsService);
    expect(mine((await jobs.runDue(at(addDays(trialEnd, 1)))).done, K)).toEqual([`trial-end:${K.name}`]);
    const first = (await counts.runDue(at(addDays(trialEnd, 1)))).done;
    expect(mine(first, K)).toEqual([`count-frozen:TRIAL_END:${trialEnd}:${K.name}`]);
    // M n'a aucune année scolaire : son comptage attend (voir plus bas).
    expect(mine(first, M)).toEqual([`count-blocked:TRIAL_END:${trialEnd}:${M.name}`]);
    expect(mine((await counts.runDue(at(addDays(trialEnd, 2)))).done, K)).toEqual([]);

    const [c] = await countsOf(K.id);
    expect(c).toMatchObject({ kind: 'TRIAL_END', stage: 'FROZEN', yearLabel: year.label, academicYearId: year.id, calendarVersion: null, reviewUntil: null, timeZone: TZ });
    expect(c.at.toISOString()).toBe(endOfSchoolDay(trialEnd, TZ).toISOString());
    expect(c.knownAt.toISOString()).toBe(c.at.toISOString());
    const items = await itemsOf(K.id, c.id);
    // Le départ du journal (T-10) et la sortie de g1 (T-12) n'étaient pas encore écrits à la fin de l'essai.
    expect(keysOf(items)).toEqual(['a1_actif', 'a2_actifSud', 'c1_erreur', 'c2_erreurRefusee', 'g1_partiEntre', 'u1_journal', 'u2_dateDirection', 'u3_sansDate', 'w1_departReel']);
    expect(items.filter((i) => i.basis === 'DEPARTURE_UNKNOWN').length).toBe(3);
    expect(c).toMatchObject({ pupils: 9, cumulative: 9, toCheck: 3, excluded: 0 });
    expect(c.listHash).toBe(listHash(items));
    // Classe et site de chaque élève à la date.
    expect(items.find((i) => i.enrollmentId === E.a2_actifSud.enrollmentId)).toMatchObject({ classId: klass.B.id, siteId: klass.B.siteId });
  });

  it('aucun comptage pendant la période gratuite : le comptage initial tombé pendant l’essai n’est jamais fait', async () => {
    const counts = app.get(CountsService);
    expect(mine((await counts.runDue(at(d(-19)))).done, K)).toEqual([]);
    expect(await admin.billingCount.count({ where: { tenantId: K.id, kind: 'INITIAL' } })).toBe(0);
    // La base refuse aussi un comptage d'une date gratuite, même demandé directement par la plateforme.
    const platform = app.get(PlatformDb);
    await expect(platform.$queryRaw`SELECT * FROM record_billing_count(${K.id}::uuid, ${year.id}::uuid, 'INITIAL', ${d(-20)}::date, 'PROVISIONAL', 1,
      '[]'::jsonb, ${endOfSchoolDay(d(-20), TZ).toISOString()}::timestamptz, ${at(d(-19)).toISOString()}::timestamptz, ${d(-19)}::date)`)
      .rejects.toThrow(/aucun comptage pendant une période gratuite/);
    // Ni un jour pas encore terminé, ni une fin d'essai qui n'a pas eu lieu.
    await expect(platform.$queryRaw`SELECT * FROM record_billing_count(${K.id}::uuid, ${year.id}::uuid, 'FIRST_REGULARIZATION', ${R}::date, 'PROVISIONAL', 1,
      '[]'::jsonb, ${endOfSchoolDay(R, TZ).toISOString()}::timestamptz, ${at(R).toISOString()}::timestamptz, ${R}::date)`)
      .rejects.toThrow(/pas encore terminé/);
    await expect(platform.$queryRaw`SELECT * FROM record_billing_count(${K.id}::uuid, ${year.id}::uuid, 'PILOT_END', ${trialEnd}::date, 'FROZEN', NULL,
      '[]'::jsonb, ${endOfSchoolDay(trialEnd, TZ).toISOString()}::timestamptz, ${endOfSchoolDay(trialEnd, TZ).toISOString()}::timestamptz, ${d(-1)}::date)`)
      .rejects.toThrow(/ne s'est pas terminée à cette date/);
  });

  it('régularisation : comptage provisoire le lendemain, vérification ouverte, liste nominative pour la direction', async () => {
    const counts = app.get(CountsService);
    expect(mine((await counts.runDue(at(R))).done, K)).toEqual([]);
    expect(mine((await counts.runDue(at(d(-2)))).done, K)).toEqual([`count-provisional:FIRST_REGULARIZATION:${R}:${K.name}`]);
    const c = (await countsOf(K.id)).find((x) => x.kind === 'FIRST_REGULARIZATION')!;
    provisionalId = c.id;
    reviewUntil = c.reviewUntil!.toISOString().slice(0, 10);
    expect(reviewUntil >= T).toBe(true);
    expect(c).toMatchObject({ stage: 'PROVISIONAL', calendarVersion: 1, pupils: 7, toCheck: 2, excluded: 0, cumulative: 9 });
    expect(c.knownAt.toISOString()).toBe(at(d(-2)).toISOString());
    const items = await itemsOf(K.id, c.id);
    // u1 : parti le T-10 d'après le journal (avant R) ; g1 : sortie datée du T-12 ; l1 : pas encore saisi au moment du comptage.
    expect(keysOf(items)).toEqual(['a1_actif', 'a2_actifSud', 'c1_erreur', 'c2_erreurRefusee', 'u2_dateDirection', 'u3_sansDate', 'w1_departReel']);

    const list = await as(K.direction).get('/settings/billing-counts');
    expect(list.status).toBe(200);
    expect(list.body.counts.map((x: { kind: string; stage: string }) => `${x.kind}:${x.stage}`)).toEqual(['FIRST_REGULARIZATION:PROVISIONAL', 'TRIAL_END:FROZEN']);
    expect(list.body.counts[0]).toMatchObject({ kindLabel: 'Première régularisation', stageLabel: 'Provisoire', reviewOpen: true, frozen: false, reviewUntil, pendingRequests: 0 });
    const one = await as(K.direction).get(`/settings/billing-counts/${provisionalId}`);
    expect(one.status).toBe(200);
    expect(one.body.items).toHaveLength(7);
    const u2 = one.body.items.find((i: { enrollmentId: string }) => i.enrollmentId === E.u2_dateDirection.enrollmentId);
    expect(u2).toMatchObject({ matricule: E.u2_dateDirection.matricule, className: '6e A', siteName: 'Site fictif Nord', basis: 'DEPARTURE_UNKNOWN', canDate: true, canExclude: false });
    expect(u2.basisLabel).toMatch(/sans date : compté/);
    // La notification de la direction pointe vers la vérification.
    const notes = await inTenant(K.id, (tx) => tx.notification.findMany({ where: { userId: K.directionId, kind: 'billing.count_recorded' } }));
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toMatch(/Paramètres › Effectifs facturables/);
  });

  it('D-G5-14 A : exclusion d’une inscription annulée par erreur de saisie, avec justificatif ; décision de la direction ; jamais un départ réel', async () => {
    const url = `/settings/billing-counts/${provisionalId}/corrections`;
    const exclusion = (key: string) => ({ kind: 'EXCLUSION', enrollmentId: E[key].enrollmentId, justification: 'Élève saisi deux fois (fictif)' });
    // Une inscription encore active, ou un départ réel, ne s'excluent pas.
    expect(message(await as(K.direction).post(url, exclusion('c1_erreur')))).toMatch(/annulez-la d'abord/);
    expect(message(await as(K.direction).post(url, exclusion('w1_departReel')))).toMatch(/un départ réel ne s'exclut jamais/);
    for (const key of ['c1_erreur', 'c2_erreurRefusee']) {
      expect((await as(K.direction).post(`/students/${E[key].studentId}/enrollment/cancel`, { reason: 'Inscription saisie en double (fictive)' })).status).toBe(201);
    }
    const r1 = await http.post(`/api/v1${url}`).set('Authorization', `Bearer ${K.direction}`)
      .field('kind', 'EXCLUSION').field('enrollmentId', E.c1_erreur.enrollmentId).field('justification', 'Élève saisi deux fois : voir le registre (fictif)')
      .attach('file', PNG, { filename: 'registre.png', contentType: 'image/png' });
    expect(r1.status).toBe(201);
    expect(r1.body).toMatchObject({ status: 'PENDING' });
    expect(message(await as(K.direction).post(url, exclusion('c1_erreur')))).toMatch(/déjà en cours ou validée/);
    expect((await as(K.direction).post(url, { ...exclusion('c2_erreurRefusee'), justification: 'abc' })).status).toBe(400);
    const r2 = await as(K.direction).post(url, exclusion('c2_erreurRefusee'));
    expect(r2.status).toBe(201);
    expect((await as(K.direction).get('/settings/billing-counts')).body.counts[0].pendingRequests).toBe(2);

    const decide = (id: string, body: object) => as(K.direction).post(`/settings/billing-counts/corrections/${id}/decision`, body);
    expect(message(await decide(r2.body.id, { decision: 'REFUSED' }))).toMatch(/un refus exige un motif/);
    expect((await decide(r2.body.id, { decision: 'REFUSED', note: 'Les deux dossiers sont deux élèves différents (fictif)' })).body).toEqual({ status: 'REFUSED' });
    expect((await decide(r1.body.id, { decision: 'VALIDATED' })).body).toEqual({ status: 'VALIDATED' });
    expect(message(await decide(r1.body.id, { decision: 'REFUSED', note: 'Changement d’avis' }))).toMatch(/déjà reçu une décision/);

    const one = (await as(K.direction).get(`/settings/billing-counts/${provisionalId}`)).body;
    const c1 = one.corrections.find((k: { id: string }) => k.id === r1.body.id);
    expect(c1).toMatchObject({ kind: 'EXCLUSION', status: 'VALIDATED', matricule: E.c1_erreur.matricule });
    expect(`${c1.requestedByName} / ${c1.decidedByName}`).toMatch(/DIRECTION k .*DIRECTION k/);
    expect(c1.fileUrl).toMatch(/^\/api\/v1\/files\?key=/);
    expect(one.corrections.find((k: { id: string }) => k.id === r2.body.id)).toMatchObject({ status: 'REFUSED', decisionNote: 'Les deux dossiers sont deux élèves différents (fictif)' });
    expect(one.items.find((i: { enrollmentId: string }) => i.enrollmentId === E.c1_erreur.enrollmentId)).toMatchObject({
      enrollmentStatus: 'CANCELLED', cancelReason: 'Inscription saisie en double (fictive)', exclusion: { id: r1.body.id, status: 'VALIDATED' }, canExclude: false,
    });
    // Le comptage provisoire, lui, ne change jamais.
    expect((await countsOf(K.id)).find((x) => x.id === provisionalId)).toMatchObject({ pupils: 7, excluded: 0 });
  });

  it('D-G5-16 A : date d’un départ enregistré avant l’historique, fixée par la direction : jamais dans le futur, avant l’arrivée ou après le journal', async () => {
    const url = `/settings/billing-counts/${provisionalId}/corrections`;
    const dated = (key: string, departureDate: string) => as(K.direction).post(url, { kind: 'DEPARTURE_DATE', enrollmentId: E[key].enrollmentId, departureDate, justification: 'Date relevée dans le registre (fictif)' });
    expect(message(await dated('u2_dateDirection', d(1)))).toMatch(/futur/);
    expect(message(await dated('u2_dateDirection', d(-90)))).toMatch(/précède l’arrivée/);
    expect(message(await dated('u1_journal', d(-9)))).toMatch(/seulement l’avancer/);
    expect(message(await dated('a1_actif', d(-5)))).toMatch(/pas de départ enregistré avant l’historique/);
    expect((await as(K.direction).post(url, { kind: 'DEPARTURE_DATE', enrollmentId: E.u2_dateDirection.enrollmentId, justification: 'Sans date (fictif)' })).status).toBe(400);
    const ok = await dated('u2_dateDirection', d(-5));
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ status: 'VALIDATED' });
    expect(await inTenant(K.id, (tx) => tx.auditLog.count({ where: { action: 'billing.count_departure_dated', entityId: ok.body.id } }))).toBe(1);
  });

  it('pendant la vérification : la liste telle qu’elle serait figée maintenant (saisie tardive ajoutée, exclusion et départ daté retirés)', async () => {
    const one = (await as(K.direction).get(`/settings/billing-counts/${provisionalId}`)).body;
    expect(one.count).toMatchObject({ reviewOpen: true, pupils: 7 });
    expect(one.live.pupils).toBe(6);
    expect(one.live.added.map((i: { enrollmentId: string }) => i.enrollmentId)).toEqual([E.l1_saisieTardive.enrollmentId]);
    expect(one.live.removed).toBe(2);
    const stillCounted = Object.fromEntries(one.items.map((i: { enrollmentId: string; stillCounted: boolean }) => [i.enrollmentId, i.stillCounted]));
    expect(stillCounted[E.c1_erreur.enrollmentId]).toBe(false);
    expect(stillCounted[E.u2_dateDirection.enrollmentId]).toBe(false);
    expect(stillCounted[E.c2_erreurRefusee.enrollmentId]).toBe(true);
  });

  it('droits : la direction de tout l’établissement seulement corrige ; secrétariat refusé ; une autre école ne voit et ne touche rien', async () => {
    expect((await as(K.secretariat!).get('/settings/billing-counts')).status).toBe(403);
    // GRP-001 : un ancien compte Direction limité à un site est refusé partout ; la base exige aussi tout l'établissement.
    expect((await as(K.siteDirection!).get('/settings/billing-counts')).status).toBe(403);
    const url = `/settings/billing-counts/${provisionalId}/corrections`;
    const body = { kind: 'DEPARTURE_DATE', enrollmentId: E.u3_sansDate.enrollmentId, departureDate: d(-4), justification: 'Essai d’un compte limité à un site' };
    expect((await as(K.siteDirection!).post(url, body)).status).toBe(403);
    expect((await as(K.secretariat!).post(url, body)).status).toBe(403);
    // Autre établissement : le comptage de K est introuvable, en lecture comme en écriture.
    expect((await as(M.direction).get(`/settings/billing-counts/${provisionalId}`)).status).toBe(404);
    expect(message(await as(M.direction).post(url, { ...body, kind: 'EXCLUSION', departureDate: undefined }))).toMatch(/comptage introuvable/);
    const pending = await as(K.direction).post(url, { kind: 'EXCLUSION', enrollmentId: E.c2_erreurRefusee.enrollmentId, justification: 'Nouvelle demande après le refus (fictif)' });
    expect(pending.status).toBe(201);
    expect(message(await as(M.direction).post(`/settings/billing-counts/corrections/${pending.body.id}/decision`, { decision: 'VALIDATED' }))).toMatch(/introuvable/);
    expect((await as(M.direction).get('/settings/billing-counts')).body.counts).toEqual([]);
    // Par requête directe avec le rôle des écoles : la direction d'une école ne corrige pas une autre école.
    await expect(inTenant(M.id, (tx) => tx.$queryRaw`SELECT request_count_correction(${provisionalId}::uuid, 'DEPARTURE_DATE', ${E.u3_sansDate.enrollmentId}::uuid,
      ${d(-4)}::date, 'Intrusion fictive', NULL, NULL, NULL, ${K.directionId}::uuid, 'Intrus', NULL, ${T}::date)`, appDb)).rejects.toThrow(/seule la direction de tout l'établissement/);
    await expect(inTenant(M.id, (tx) => tx.$queryRaw`SELECT request_count_correction(${provisionalId}::uuid, 'DEPARTURE_DATE', ${E.u3_sansDate.enrollmentId}::uuid,
      ${d(-4)}::date, 'Intrusion fictive', NULL, NULL, NULL, ${M.directionId}::uuid, 'Intrus', NULL, ${T}::date)`, appDb)).rejects.toThrow(/comptage introuvable/);
  });

  it('fin de la vérification : comptage figé une seule fois, même lancé deux fois en même temps ; corrections fermées ; cumul et empreinte', async () => {
    const counts = app.get(CountsService);
    expect(mine((await counts.runDue(at(reviewUntil))).done, K)).toEqual([]);
    const twin = [0, 1].map(() => new CountsService(app.get(PrismaService), app.get(PlatformDb), app.get(FilesService), app.get(AuditService)));
    const both = await Promise.all(twin.map((s) => s.runDue(at(addDays(reviewUntil, 1)))));
    expect(both.flatMap((r) => mine(r.done, K))).toEqual([`count-frozen:FIRST_REGULARIZATION:${R}:${K.name}`]);
    expect(mine((await counts.runDue(at(addDays(reviewUntil, 2)))).done, K)).toEqual([]);

    const frozen = (await countsOf(K.id)).find((x) => x.kind === 'FIRST_REGULARIZATION' && x.stage === 'FROZEN')!;
    expect(frozen.knownAt.toISOString()).toBe(endOfSchoolDay(reviewUntil, TZ).toISOString());
    const items = await itemsOf(K.id, frozen.id);
    expect(keysOf(items)).toEqual(['a1_actif', 'a2_actifSud', 'c2_erreurRefusee', 'l1_saisieTardive', 'u3_sansDate', 'w1_departReel']);
    expect(keysOf(items, false)).toEqual(['c1_erreur']);
    expect(items.find((i) => i.enrollmentId === E.c1_erreur.enrollmentId)).toMatchObject({ basis: 'EXCLUDED', counted: false });
    // La demande d'exclusion de c2 restée en attente ne vaut rien ; u3, sans date, reste compté et signalé.
    expect(items.find((i) => i.enrollmentId === E.u3_sansDate.enrollmentId)).toMatchObject({ basis: 'DEPARTURE_UNKNOWN', counted: true });
    // Cumul de l'année : élèves comptés à la fin de l'essai ou à R, sans l'exclusion validée.
    expect(frozen).toMatchObject({ pupils: 6, toCheck: 1, excluded: 1, cumulative: 9, reviewUntil: null, calendarVersion: 1 });
    expect(frozen.listHash).toBe(listHash(items));

    const list = (await as(K.direction).get('/settings/billing-counts')).body.counts;
    expect(list.map((x: { kind: string; stage: string; frozen: boolean; reviewOpen: boolean }) => `${x.kind}:${x.stage}:${x.frozen}:${x.reviewOpen}`)).toEqual([
      'FIRST_REGULARIZATION:FROZEN:true:false', 'FIRST_REGULARIZATION:PROVISIONAL:true:false', 'TRIAL_END:FROZEN:true:false',
    ]);
    const url = `/settings/billing-counts/${provisionalId}/corrections`;
    expect(message(await as(K.direction).post(url, { kind: 'DEPARTURE_DATE', enrollmentId: E.u3_sansDate.enrollmentId, departureDate: d(-4), justification: 'Trop tard (fictif)' })))
      .toMatch(/vérification de ce comptage est terminée/);
    const one = (await as(K.direction).get(`/settings/billing-counts/${frozen.id}`)).body;
    expect(one.live).toBeNull();
    expect(one.items.every((i: { canDate: boolean; canExclude: boolean }) => !i.canDate && !i.canExclude)).toBe(true);
    const notes = await inTenant(K.id, (tx) => tx.notification.findMany({ where: { userId: K.directionId, kind: 'billing.count_frozen' }, orderBy: { createdAt: 'asc' } }));
    expect(notes.map((x) => x.title)).toHaveLength(2);
    expect(notes[1].body).toMatch(/La vérification est terminée/);
  });

  it('Super Admin : les nombres de chaque comptage, jamais un nom ni un matricule ; journaux de la plateforme, du groupe et de l’école', async () => {
    const list = (await pf.get('/billing/establishments')).body as { id: string; counts: Record<string, unknown>[] }[];
    const k = list.find((e) => e.id === K.id)!;
    expect(k.counts.map((c) => `${c.kind}:${c.stage}:${c.pupils}:${c.cumulative}:${c.toCheck}:${c.excluded}`)).toEqual([
      'FIRST_REGULARIZATION:FROZEN:6:9:1:1', 'FIRST_REGULARIZATION:PROVISIONAL:7:9:2:0', 'TRIAL_END:FROZEN:9:9:3:0',
    ]);
    expect(Object.keys(k.counts[0]).sort()).toEqual([
      'at', 'calendarVersion', 'createdAt', 'cumulative', 'excluded', 'frozen', 'id', 'kind', 'kindLabel', 'knownAt', 'listHash', 'pupils', 'referenceDate',
      'reviewOpen', 'reviewUntil', 'stage', 'stageLabel', 'timeZone', 'toCheck', 'yearLabel',
    ]);
    const text = JSON.stringify(list);
    for (const e of Object.values(E)) {
      expect(text).not.toContain(e.lastName);
      expect(text).not.toContain(e.enrollmentId);
    }
    // Journaux : la tâche planifiée et la direction, dans la plateforme et le groupe (sans matricule) et dans l'école.
    const platform = await admin.platformAuditLog.findMany({ where: { tenantId: K.id, action: { startsWith: 'billing.count' } } });
    const actions = (rows: { action: string }[]) => rows.map((r) => r.action).sort();
    const expected = [
      'billing.count_departure_dated', 'billing.count_exclusion_refused', 'billing.count_exclusion_requested', 'billing.count_exclusion_requested',
      'billing.count_exclusion_requested', 'billing.count_exclusion_validated', 'billing.count_frozen', 'billing.count_frozen', 'billing.count_recorded',
    ];
    expect(actions(platform)).toEqual(expected);
    expect(actions(await admin.groupAuditLog.findMany({ where: { groupId: K.groupId, action: { startsWith: 'billing.count' } } }))).toEqual(expected);
    expect(actions(await inTenant(K.id, (tx) => tx.auditLog.findMany({ where: { action: { startsWith: 'billing.count' } } })))).toEqual(expected);
    const groupText = JSON.stringify(await admin.groupAuditLog.findMany({ where: { groupId: K.groupId } }));
    for (const e of Object.values(E)) expect(groupText).not.toContain(e.matricule);
    // Les comptages ordinaires ne font pas d'alerte à la plateforme.
    expect(await admin.platformAlert.count({ where: { tenantId: K.id, kind: { startsWith: 'COUNT' } } })).toBe(0);
  });

  it('année scolaire absente à la fin de l’essai : comptage en attente, une alerte et une notification une seule fois, puis fait dès que l’année existe', async () => {
    const counts = app.get(CountsService);
    // L'essai de M s'est terminé en même temps que celui de K ; son comptage attend depuis (premier essai ci-dessus),
    // et les passages suivants de la tâche n'ont rien ajouté.
    expect((await admin.subscription.findUniqueOrThrow({ where: { tenantId: M.id } })).status).toBe('AWAITING_ACCEPTANCE');
    expect(mine((await counts.runDue(at(addDays(trialEnd, 4)))).done, M)).toEqual([]);
    const alerts = await admin.platformAlert.findMany({ where: { tenantId: M.id, kind: 'COUNT_BLOCKED' } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toMatch(/aucune année scolaire de l’école ne contient cette date/);
    const notes = await inTenant(M.id, (tx) => tx.notification.findMany({ where: { kind: 'billing.count_blocked' } }));
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toMatch(/Paramètres › Année et périodes/);
    expect(await admin.billingCount.count({ where: { tenantId: M.id } })).toBe(0);

    await inTenant(M.id, (tx) => tx.academicYear.create({ data: { tenantId: M.id, label: year.label, startDate: new Date(year.start), endDate: new Date(year.end), isCurrent: true } }));
    expect(mine((await counts.runDue(at(addDays(trialEnd, 5)))).done, M)).toEqual([`count-frozen:TRIAL_END:${trialEnd}:${M.name}`]);
    expect(await admin.billingCount.findFirstOrThrow({ where: { tenantId: M.id } })).toMatchObject({ kind: 'TRIAL_END', pupils: 0, cumulative: 0 });
    expect(await admin.platformAlert.count({ where: { tenantId: M.id, kind: 'COUNT_BLOCKED' } })).toBe(1);
    expect((await as(M.direction).get('/settings/billing-counts')).body.counts).toHaveLength(1);
  });

  it('ajout seul et droits de la base : rien ne se modifie ni ne s’efface ; écoles, groupes et statistiques sans accès direct', async () => {
    const refused = (sql: string, tenantId = K.id) => expect(inTenant(tenantId, (tx) => tx.$executeRawUnsafe(sql))).rejects.toThrow();
    await refused(`UPDATE billing_counts SET pupils = 0 WHERE tenant_id = '${K.id}'`);
    await refused(`DELETE FROM billing_counts WHERE tenant_id = '${K.id}'`);
    await refused(`UPDATE billing_count_items SET counted = NOT counted WHERE tenant_id = '${K.id}'`);
    await refused(`DELETE FROM billing_count_items WHERE tenant_id = '${K.id}'`);
    await refused(`UPDATE count_corrections SET justification = 'X' WHERE tenant_id = '${K.id}'`);
    await refused(`UPDATE count_corrections SET status = 'PENDING' WHERE tenant_id = '${K.id}' AND status <> 'PENDING'`);
    await refused(`DELETE FROM count_corrections WHERE tenant_id = '${K.id}'`);
    for (const t of ['billing_counts', 'billing_count_items', 'count_corrections']) await refused(`TRUNCATE ${t} CASCADE`);
    expect(await admin.billingCount.count({ where: { tenantId: K.id } })).toBe(3);

    // Rôle des écoles : ni la table des comptages, ni l'écriture ; les listes et les demandes de son école seulement.
    await expect(appDb.$queryRawUnsafe('SELECT count(*) FROM billing_counts')).rejects.toThrow(/permission denied/);
    await expect(inTenant(K.id, (tx) => tx.$executeRawUnsafe(`DELETE FROM count_corrections WHERE tenant_id = '${K.id}'`), appDb)).rejects.toThrow(/permission denied/);
    await expect(inTenant(K.id, (tx) => tx.$executeRawUnsafe(`UPDATE billing_count_items SET counted = false WHERE tenant_id = '${K.id}'`), appDb)).rejects.toThrow(/permission denied/);
    await expect(inTenant(K.id, (tx) => tx.$queryRaw`SELECT * FROM record_billing_count(${K.id}::uuid, ${year.id}::uuid, 'FINAL_REGULARIZATION', ${R}::date, 'PROVISIONAL', 1,
      '[]'::jsonb, now(), now(), ${T}::date)`, appDb)).rejects.toThrow(/permission denied/);
    expect(await inTenant(K.id, (tx) => tx.billingCountItem.count(), appDb)).toBe(9 + 7 + 7);
    expect(await inTenant(M.id, (tx) => tx.billingCountItem.count({ where: { tenantId: K.id } }), appDb)).toBe(0);
    expect(await inTenant(M.id, (tx) => tx.countCorrection.count(), appDb)).toBe(0);
    // Groupes et statistiques : aucun accès.
    for (const db of [groupDb, statsDb]) {
      for (const t of ['billing_counts', 'billing_count_items', 'count_corrections']) await expect(db.$queryRawUnsafe(`SELECT count(*) FROM ${t}`)).rejects.toThrow(/permission denied/);
    }
    // Plateforme : les nombres seulement, jamais les listes nominatives ni les demandes.
    const platform = app.get(PlatformDb);
    expect(await platform.billingCount.count({ where: { tenantId: K.id } })).toBe(3);
    await expect(platform.$queryRawUnsafe('SELECT count(*) FROM billing_count_items')).rejects.toThrow(/permission denied/);
    await expect(platform.$queryRawUnsafe('SELECT count(*) FROM count_corrections')).rejects.toThrow(/permission denied/);
    await expect(platform.$queryRawUnsafe('SELECT * FROM current_tenant_billing_counts()')).rejects.toThrow(/permission denied/);
  });
});
