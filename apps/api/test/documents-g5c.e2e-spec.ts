/**
 * Lot G5c, documents provisoires de l'abonnement, de bout en bout sur la base de test (erp_test), avec des
 * établissements, des comptes et des élèves entièrement fictifs créés pour ce fichier. Aucun paiement, aucun SMS, aucune
 * facture : des proformas et des relevés provisoires (cahier des charges G5 du 14 novembre 2026, §16).
 *
 * Au 19 novembre 2026, ni la part de la première année (D-G5-29) ni l'arrondi ne sont tranchés : la tâche planifiée
 * n'émet donc rien pour une première année. Les essais remplacent ensuite ces réponses par les propositions de Dankou
 * (mois de l'année scolaire, franc inférieur), pour vérifier ce qui suivra ses réponses.
 *
 * Calendrier simulé autour d'aujourd'hui (T) : année scolaire de 11 mois (du 1er du mois M-2 au dernier jour du mois
 * M+8), essai du T-20 au T-7, comptage initial le T-15 (pendant l'essai : jamais fait), première régularisation le T-3,
 * régularisation finale le T+100. 90 élèves à la fin de l'essai ; ensuite un départ et 11 arrivées.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomUUID } from 'crypto';
import { authenticator } from 'otplib';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { localDay, money } from '../src/common/country';
import { PrismaService } from '../src/common/prisma.service';
import { AmountDecisions, DECISIONS, isClosed, Line } from '../src/modules/billing/amounts-rules';
import { BillingService } from '../src/modules/billing/billing';
import { BillingJobsService } from '../src/modules/billing/billing-jobs';
import { addDays, frDay, lastDayOfMonth, monthsSpanned } from '../src/modules/billing/billing-rules';
import { CountsService } from '../src/modules/billing/counts';
import { COUNT_KIND_LABELS } from '../src/modules/billing/counts-rules';
import { FilesService } from '../src/modules/files/files.service';
import { BillingDocumentsService, PROVISIONAL_MENTION } from '../src/modules/billing/documents';
import { nextLine } from '../src/modules/billing/documents-rules';
import { PlatformDb } from '../src/modules/platform/platform';

const TZ = 'Africa/Porto-Novo';
const PASSWORD = 'Documents-G5c-2026';
const SA_PASSWORD = 'Plateforme-G5c-2026';
const stamp = Date.now().toString(36);
const T = localDay(TZ);
const d = (n: number) => addDays(T, n);
/** Midi à Porto-Novo, le jour donné : l'instant simulé de la tâche planifiée. */
const at = (day: string) => new Date(`${day}T11:00:00.000Z`);
const morning = (day: string) => new Date(`${day}T08:00:00.000Z`);
/** Propositions de Dankou pour D-G5-29 (point 3) et l'arrondi, pas encore tranchées : seulement dans ces essais. */
const PROPOSED: AmountDecisions = { firstYearDivisor: 'SCHOOL_MONTHS', rounding: 'FLOOR' };

let app: INestApplication;
let http: ReturnType<typeof request>;
const admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_ADMIN_URL } } });
const appDb = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
const groupDb = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_GROUP_URL } } });
const statsDb = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_STATS_URL } } });

type School = { id: string; slug: string; name: string; groupId: string; groupName: string; direction: string; directionId: string; secretariat?: string; yearId: string };
const K = {} as School; // école indépendante facturée
const O = {} as School; // école indépendante sans abonnement
const G1 = {} as School; // trois établissements d'un même groupe
const G2 = {} as School;
const G3 = {} as School;
const L = {} as School; // école indépendante : exclusion avant tout document, puis au minimum
const sa = { id: '', name: 'Super Admin documents (fictif)', email: `g5c-${stamp}@test.local`, cookie: '', secret: '' };

const [ty, tm] = T.split('-').map(Number);
const year = { label: '', start: addDays(lastDayOfMonth(ty, tm - 4), 1), end: lastDayOfMonth(ty, tm + 7) };
const R = d(-3);
const FINAL = d(100);
let termsId = '';
let trialEnd = '';
type Pupil = { studentId: string; enrollmentId: string; m: string };
let kFirst: Pupil[] = []; // 90 élèves de K à la rentrée (le premier part le T-5)
let kLate: Pupil[] = []; // 11 arrivées du T-5

function inTenant<X>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<X>, client = admin) {
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

async function login(slug: string, phone: string) {
  const r = await http.post('/api/v1/auth/login').send({ tenant: slug, identifier: phone, password: PASSWORD });
  expect(r.status).toBe(200);
  return r.body.accessToken as string;
}

/** Établissement fictif créé il y a 60 jours, avec son année scolaire, sa direction et, si demandé, un secrétariat. */
async function newSchool(s: School, key: string, group: { id: string; name: string } | null, secretariat = false) {
  const groupName = group?.name ?? `Groupe fictif G5c ${key.toUpperCase()} ${stamp}`;
  const t = await admin.tenant.create({
    data: {
      slug: `g5c-${key}-${stamp}`, name: `École fictive G5c ${key.toUpperCase()} ${stamp}`, timezone: TZ, createdAt: morning(d(-60)),
      group: group ? { connect: { id: group.id } } : { create: { name: groupName } },
    },
  });
  Object.assign(s, { id: t.id, slug: t.slug, name: t.name, groupId: t.groupId, groupName });
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  await inTenant(t.id, async (tx) => {
    const add = async (phone: string, role: 'DIRECTION' | 'SECRETARIAT', last: string) => {
      const u = await tx.user.create({ data: { tenantId: t.id, phone, firstName: 'Fictif', lastName: last, passwordHash: hash, mustChangePassword: false } });
      await tx.userRole.create({ data: { tenantId: t.id, userId: u.id, role } });
      return u.id;
    };
    s.directionId = await add('+2290190008001', 'DIRECTION', `DIRECTION ${key}`);
    if (secretariat) await add('+2290190008002', 'SECRETARIAT', `SECRETARIAT ${key}`);
    s.yearId = (await tx.academicYear.create({ data: { tenantId: t.id, label: year.label, startDate: new Date(year.start), endDate: new Date(year.end), isCurrent: true } })).id;
  });
  s.direction = await login(s.slug, '+2290190008001');
  if (secretariat) s.secretariat = await login(s.slug, '+2290190008002');
}

/** Classe fictive d'un établissement (niveau et site compris). */
function newClass(s: School) {
  return inTenant(s.id, async (tx) => {
    const level = await tx.level.create({ data: { tenantId: s.id, name: '6e', cycle: 'COLLEGE', position: 1 } });
    const site = await tx.site.create({ data: { tenantId: s.id, name: 'Site fictif' } });
    return tx.class.create({ data: { tenantId: s.id, academicYearId: s.yearId, siteId: site.id, levelId: level.id, name: '6e fictive' } });
  });
}

/** `n` élèves fictifs d'un établissement (K par défaut) inscrits le jour `day` (inscription et ligne d'historique). */
async function enrol(n: number, day: string, classId: string, s: School = K): Promise<Pupil[]> {
  return inTenant(s.id, async (tx) => {
    const rows = Array.from({ length: n }, () => ({ studentId: randomUUID(), enrollmentId: randomUUID(), m: randomUUID().slice(0, 8) }));
    await tx.student.createMany({ data: rows.map((r) => ({ id: r.studentId, tenantId: s.id, matricule: `G5C-${stamp}-${r.m}`, firstName: 'Élève', lastName: `FICTIF${r.m.toUpperCase()}` })) });
    await tx.enrollment.createMany({
      data: rows.map((r) => ({ id: r.enrollmentId, tenantId: s.id, studentId: r.studentId, classId, academicYearId: s.yearId, enrolledAt: morning(day), type: 'NEW' as const })),
    });
    await tx.enrollmentEvent.createMany({ data: rows.map((r) => ({ tenantId: s.id, enrollmentId: r.enrollmentId, kind: 'ENROLLED', data: { classId, type: 'NEW' }, createdAt: morning(day) })) });
    return rows;
  });
}

const docsOf = (groupId: string) => admin.billingDocument.findMany({ where: { groupId }, orderBy: [{ issueDate: 'asc' }, { createdAt: 'asc' }], include: { lines: { orderBy: { position: 'asc' } } } });
const mine = (done: string[], s: School) => done.filter((x) => x.endsWith(`:${s.groupName}`));
const svc = () => app.get(BillingDocumentsService);
const platform = () => app.get(PlatformDb);

/** Lignes que l'API enverrait pour le prochain document de chaque établissement d'un groupe (mêmes règles, décisions données). */
async function computed(groupId: string, decisions: AmountDecisions) {
  const f = await svc().facts(groupId);
  return f.establishments.flatMap((e) => {
    const next = nextLine(e, decisions);
    if (next.state !== 'READY' || isClosed(next.line)) return [];
    const l: Line = next.line;
    return [{
      tenantId: e.tenantId, label: `${e.name} · essai fictif`, amount: l.due, countId: next.count.id, pupils: l.pupils, pupilsChange: l.pupilsChange,
      pricePerPupil: l.pricePerPupil, minimum: l.minimum, minimumApplied: l.minimumApplied, fullYear: l.fullYear, shareMonths: l.share?.months ?? null,
      shareOf: l.share?.of ?? null, yearAmount: l.amount, alreadyBilled: l.alreadyBilled,
    }];
  });
}
type JsonLine = Awaited<ReturnType<typeof computed>>[number];

/** Émission directe par le rôle de la plateforme, comme l'API (fonction issue_billing_document). */
function issue(groupId: string, lines: object[], o: { kind?: string; year?: string; due?: string | null; issueDay?: string; related?: string | null } = {}) {
  const data = { mention: PROVISIONAL_MENTION, test: 'G5c' };
  return platform().$queryRaw<{ document_id: string; document_reference: string; document_total: number }[]>`
    SELECT * FROM issue_billing_document(${groupId}::uuid, ${o.kind ?? 'SUBSCRIPTION'}, 'XOF', ${o.issueDay ?? T}::date, ${o.due ?? null}::date, ${o.year ?? year.label},
      ${o.related ?? null}::uuid, ${JSON.stringify(data)}::jsonb, ${JSON.stringify(lines)}::jsonb, 'platform', ${sa.id}::uuid, ${sa.name})`;
}

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  configureApp(app);
  await app.init();
  http = request(app.getHttpServer());

  const y = Number(year.start.slice(0, 4));
  year.label = `${y}-${y + 1}`;
  await newSchool(K, 'k', null, true);
  await newSchool(O, 'o', null);
  await newSchool(G1, 'g1', null);
  await newSchool(G2, 'g2', { id: G1.groupId, name: G1.groupName });

  await admin.platformAdmin.create({ data: { email: sa.email, name: sa.name, passwordHash: await argon2.hash(SA_PASSWORD), mustChangePassword: false, mustSetupTwoFactor: false } });
  sa.id = (await admin.platformAdmin.findUniqueOrThrow({ where: { email: sa.email } })).id;
  sa.cookie = cookieOf(await http.post('/api/v1/platform/auth/login').send({ email: sa.email, password: SA_PASSWORD }).expect(201));
  const setup = await pf.post('/auth/2fa/setup').expect(201);
  sa.secret = setup.body.secret;
  await pf.post('/auth/2fa/enable', { code: await code(), setupToken: setup.body.setupToken }).expect(201);

  // Élèves fictifs de K : 90 à la rentrée ; l'un part le T-5, onze arrivent le T-5 (après l'essai, avant la régularisation).
  const klass = await newClass(K);
  kFirst = await enrol(90, year.start, klass.id);
  kLate = await enrol(11, d(-5), klass.id);
  await inTenant(K.id, async (tx) => {
    await tx.enrollment.update({ where: { id: kFirst[0].enrollmentId }, data: { status: 'WITHDRAWN', exitDate: new Date(`${d(-5)}T00:00:00Z`), exitReason: 'Départ fictif' } });
    await tx.enrollmentEvent.create({ data: { tenantId: K.id, enrollmentId: kFirst[0].enrollmentId, kind: 'WITHDRAWN', data: { exitDate: d(-5), reason: 'Départ fictif' }, createdAt: morning(d(-5)) } });
  });
});

afterAll(async () => {
  if (app) svc().decisions = DECISIONS;
  await app?.close();
  await admin.platformAdmin.deleteMany({ where: { email: sa.email } });
  await Promise.all([admin.$disconnect(), appDb.$disconnect(), groupDb.$disconnect(), statsDb.$disconnect()]);
});

/** Mois payés de la première année (D-G5-2) et montant au franc inférieur : la formule des propositions, écrite à part. */
const months = () => monthsSpanned(addDays(trialEnd, 1), year.end);
const share = (full: number) => Math.floor((full * months()) / 11);

describe('Lot G5c · documents provisoires de l’abonnement (données fictives)', () => {
  it('fin de l’essai : comptage figé, conditions acceptées, mais aucun document tant que D-G5-29 n’est pas tranché', async () => {
    expect(monthsSpanned(year.start, year.end)).toBe(11);
    for (const s of [K, G1, G2]) {
      const r = await pf.post(`/billing/establishments/${s.id}/trial`, { startDate: d(-20), code: await code() });
      expect(r.status).toBe(201);
      trialEnd = r.body.trialEnd;
    }
    expect(trialEnd).toBe(d(-7));
    const cal = await pf.post(`/billing/establishments/${K.id}/calendars`, {
      yearLabel: year.label, startDate: year.start, endDate: year.end, initialCountDate: d(-15), firstRegularizationDate: R, finalRegularizationDate: FINAL,
      formula: 'MANUEL', reason: 'Calendrier fictif (test G5c)', code: await code(),
    });
    expect(cal.status).toBe(201);
    await app.get(BillingJobsService).runDue(at(d(-6)));
    await app.get(CountsService).runDue(at(d(-6)));
    const trialCount = await admin.billingCount.findFirstOrThrow({ where: { tenantId: K.id, kind: 'TRIAL_END' } });
    expect(trialCount).toMatchObject({ stage: 'FROZEN', pupils: 90, cumulative: 90 });

    const body = 'Texte fictif publié par les tests automatiques du lot G5c. Ce ne sont pas les conditions commerciales de Cahiora.';
    const terms = await pf.post('/billing/terms', { title: `Conditions fictives G5c ${stamp}`, body, effectiveFrom: T, code: await code() });
    expect(terms.status).toBe(201);
    termsId = terms.body.id;
    for (const s of [K, G1, G2]) {
      const ok = await as(s.direction).post('/settings/subscription/accept', { termsId, accepted: true });
      expect(ok.status).toBe(201);
      expect(ok.body.status).toBe('AWAITING_PAYMENT');
    }
    // L'acceptation a tenté le document aussitôt : rien, la part de la première année attend la réponse de Dankou.
    expect(await docsOf(K.groupId)).toHaveLength(0);
    expect(mine((await svc().runDue()).done, K)).toEqual([]);
    const list = (await pf.get('/billing/documents')).body;
    expect(list.decisions).toEqual({ firstYearDivisor: null, rounding: null });
    const plan = list.plans.find((p: { groupId: string }) => p.groupId === K.groupId);
    expect(plan).toMatchObject({ state: 'CLOSED', decision: 'D-G5-29' });
    expect(plan.message).toMatch(/mois de l’année scolaire ou 12 mois/);
    expect(plan.establishments[0].next).toMatchObject({ state: 'CLOSED', decision: 'D-G5-29', countKind: 'TRIAL_END', countDate: trialEnd });
    const school = await as(K.direction).get('/settings/billing-documents');
    expect(school.status).toBe(200);
    expect(school.body).toMatchObject({ documents: [], groupPending: null, mention: PROVISIONAL_MENTION });
  });

  it('année de 11 mois : une part qui ne tombe pas juste attend la décision sur l’arrondi', async () => {
    svc().decisions = { firstYearDivisor: 'SCHOOL_MONTHS', rounding: null };
    expect(mine((await svc().runDue()).done, K)).toEqual([]);
    const plan = (await pf.get('/billing/documents')).body.plans.find((p: { groupId: string }) => p.groupId === K.groupId);
    expect(plan).toMatchObject({ state: 'CLOSED', decision: 'ARRONDI' });
    expect(plan.message).toContain(`la part ${months()}/11 ne donne pas un montant entier`);
  });

  it('première demande, avec les propositions de Dankou : un seul document même lancé deux fois en même temps, échéance à la fin de la grâce', async () => {
    const twins = [0, 1].map(() => {
      const s = new BillingDocumentsService(app.get(PlatformDb), app.get(PrismaService), app.get(FilesService), app.get(BillingService));
      s.decisions = PROPOSED;
      return s;
    });
    const both = await Promise.all(twins.map((s) => s.runDue()));
    const amount = share(45_000);
    expect(both.flatMap((r) => mine(r.done, K))).toEqual([`document:TRIAL_END:${trialEnd}:${amount}:${K.groupName}`]);
    svc().decisions = PROPOSED;
    expect(mine((await svc().runDue()).done, K)).toEqual([]);

    const [doc] = await docsOf(K.groupId);
    expect(doc).toMatchObject({ kind: 'SUBSCRIPTION', currency: 'XOF', total: amount, yearLabel: year.label, createdByKind: 'system', createdByName: 'Cahiora (tâche planifiée)' });
    expect(doc.reference).toMatch(/^PROV-[0-9A-F]{10}$/);
    expect(doc.issueDate.toISOString().slice(0, 10)).toBe(T);
    // D-G5-30 A : 15 jours de grâce après le dernier jour gratuit.
    expect(doc.dueDate!.toISOString().slice(0, 10)).toBe(d(8));
    expect(doc.data).toMatchObject({
      mention: PROVISIONAL_MENTION, client: { groupId: K.groupId, name: K.groupName }, establishments: [{ tenantId: K.id, name: K.name }],
      tariff: { currency: 'XOF', pricePerPupil: 500, minimum: 40_000 }, countKind: 'TRIAL_END', countDate: trialEnd, statement: false, graceEnd: d(8), rounded: 'FLOOR',
      decisions: PROPOSED,
    });
    expect(doc.lines).toHaveLength(1);
    expect(doc.lines[0]).toMatchObject({
      tenantId: K.id, position: 1, amount, countKind: 'TRIAL_END', pupils: 90, pupilsChange: 90, pricePerPupil: 500, minimum: 40_000, minimumApplied: false,
      fullYear: 45_000, shareMonths: months(), shareOf: 11, yearAmount: amount, alreadyBilled: 0, serviceId: null,
    });
    expect(doc.lines[0].label).toBe(`${K.name} · Fin de l’essai gratuit du ${frDay(trialEnd)}`);
    // La direction est prévenue dans l'application (aucun SMS) ; elle voit son document.
    const notes = await inTenant(K.id, (tx) => tx.notification.findMany({ where: { userId: K.directionId, kind: 'billing.document_issued' } }));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ channel: 'IN_APP' });
    expect(notes[0].body).toContain(doc.reference);
    expect(notes[0].body).toContain(PROVISIONAL_MENTION);
    const seen = (await as(K.direction).get('/settings/billing-documents')).body;
    expect(seen.documents).toHaveLength(1);
    expect(seen.documents[0]).toMatchObject({ reference: doc.reference, label: 'Proforma de l’abonnement', total: amount, dueDate: d(8), lines: [{ pupils: 90, amount }] });
  });

  it('la base refait les contrôles : montant, déjà demandé, complément, comptage figé, client, monnaie, un seul document par comptage', async () => {
    // Comptage de la régularisation : provisoire le lendemain, figé après les 15 jours de vérification de la direction.
    await app.get(CountsService).runDue(at(d(-2)));
    const provisional = await admin.billingCount.findFirstOrThrow({ where: { tenantId: K.id, kind: 'FIRST_REGULARIZATION', stage: 'PROVISIONAL' } });
    const reviewUntil = provisional.reviewUntil!.toISOString().slice(0, 10);
    await app.get(CountsService).runDue(at(addDays(reviewUntil, 1)));
    const frozen = await admin.billingCount.findFirstOrThrow({ where: { tenantId: K.id, kind: 'FIRST_REGULARIZATION', stage: 'FROZEN' } });
    // Un départ ne réduit jamais le montant : 100 élèves à la date, 101 élèves distincts dans l'année.
    expect(frozen).toMatchObject({ pupils: 100, cumulative: 101 });

    const [good] = await computed(K.groupId, PROPOSED);
    expect(good).toMatchObject({ countId: frozen.id, pupils: 101, pupilsChange: 11, alreadyBilled: share(45_000), yearAmount: share(50_500), shareMonths: months(), shareOf: 11 });
    const refused = async (lines: Partial<JsonLine>[], pattern: RegExp, o: Parameters<typeof issue>[2] = {}) => expect(issue(K.groupId, lines, o)).rejects.toThrow(pattern);
    await refused([{ ...good, yearAmount: good.yearAmount + 1 }], /montant de l'année faux/);
    await refused([{ ...good, minimumApplied: true }], /montant de l'année faux/);
    await refused([{ ...good, alreadyBilled: 0, amount: good.yearAmount }], /déjà demandé faux/);
    await refused([{ ...good, amount: good.amount + 1 }], /complément faux/);
    await refused([{ ...good, pupilsChange: 101 }], /écart d'élèves faux/);
    const fewer = { pupils: 100, fullYear: 50_000, yearAmount: share(50_000), amount: share(50_000) - share(45_000), pupilsChange: 10 };
    await refused([{ ...good, ...fewer }], /élèves facturables différents du comptage figé/);
    await refused([{ ...good, countId: provisional.id }], /comptage figé de cet établissement et de cette année attendu/);
    await refused([{ ...good, tenantId: O.id }], /hors de ce client/);
    await refused([good, { ...good }], /une seule fois dans un document d'abonnement/);
    await refused([{ ...good, countId: undefined }], /vient d'un comptage figé/);
    await refused([good], /échéance avant la date du document/, { due: d(-1) });
    await refused([{ ...good, alreadyBilled: 0, amount: good.yearAmount }], /comptage figé de cet établissement et de cette année attendu/, { year: '2099-2100' });
    await refused([good], /un avoir touche toujours un document émis/, { kind: 'CREDIT_NOTE' });
    await refused([good], /ce document ne peut pas être lié/, { related: (await docsOf(K.groupId))[0].id });
    await refused([], /document incomplet/);
    // Le comptage de la fin de l'essai a déjà son document : jamais facturé deux fois (test 8).
    const trialCount = await admin.billingCount.findFirstOrThrow({ where: { tenantId: K.id, kind: 'TRIAL_END' } });
    const again = (await docsOf(K.groupId))[0].lines[0];
    await refused([{
      tenantId: K.id, label: 'Doublon', amount: 0, countId: trialCount.id, pupils: 90, pupilsChange: 0, pricePerPupil: 500, minimum: 40_000, minimumApplied: false,
      fullYear: 45_000, shareMonths: again.shareMonths, shareOf: 11, yearAmount: again.yearAmount!, alreadyBilled: again.amount,
    }], /ce comptage a déjà son document/);
    expect(await docsOf(K.groupId)).toHaveLength(1);
  });

  it('test 15 : un tarif accepté différent de celui du premier document de l’année n’émet rien ; un document émis garde ses prix', async () => {
    const before = await admin.subscription.findUniqueOrThrow({ where: { tenantId: K.id } });
    await admin.subscription.update({ where: { tenantId: K.id }, data: { acceptedTariff: { ...(before.acceptedTariff as object), pricePerPupil: 600 } } });
    try {
      expect(mine((await svc().runDue()).done, K)).toEqual([]);
      const plan = (await pf.get('/billing/documents')).body.plans.find((p: { groupId: string }) => p.groupId === K.groupId);
      expect(plan).toMatchObject({ state: 'CLOSED', decision: 'TARIF' });
    } finally {
      await admin.subscription.update({ where: { tenantId: K.id }, data: { acceptedTariff: before.acceptedTariff as Prisma.InputJsonValue } });
    }
    const [doc] = await docsOf(K.groupId);
    expect(doc.lines[0]).toMatchObject({ pricePerPupil: 500, minimum: 40_000 });
  });

  it('régularisation : seul le complément est facturé, à la même part ; puis relevé à 0 F quand rien n’a changé (tests 7, 8 et 9)', async () => {
    const reviewUntil = (await admin.billingCount.findFirstOrThrow({ where: { tenantId: K.id, kind: 'FIRST_REGULARIZATION', stage: 'PROVISIONAL' } })).reviewUntil!.toISOString().slice(0, 10);
    const day1 = addDays(reviewUntil, 1);
    const complement = share(50_500) - share(45_000);
    expect(mine((await svc().runDue(at(day1))).done, K)).toEqual([`document:FIRST_REGULARIZATION:${R}:${complement}:${K.groupName}`]);
    const [, second] = await docsOf(K.groupId);
    expect(second).toMatchObject({ total: complement, dueDate: null });
    expect(second.issueDate.toISOString().slice(0, 10)).toBe(day1);
    expect(second.lines[0]).toMatchObject({ countKind: 'FIRST_REGULARIZATION', pupils: 101, pupilsChange: 11, yearAmount: share(50_500), alreadyBilled: share(45_000), amount: complement, shareMonths: months() });
    expect(second.data).toMatchObject({ statement: false, graceEnd: null, countKind: 'FIRST_REGULARIZATION' });

    // Régularisation finale : mêmes élèves, aucun complément ; un relevé à 0 F, jamais un montant négatif.
    await app.get(CountsService).runDue(at(addDays(FINAL, 1)));
    const p = await admin.billingCount.findFirstOrThrow({ where: { tenantId: K.id, kind: 'FINAL_REGULARIZATION', stage: 'PROVISIONAL' } });
    const day2 = addDays(p.reviewUntil!.toISOString().slice(0, 10), 1);
    await app.get(CountsService).runDue(at(day2));
    expect(mine((await svc().runDue(at(day2))).done, K)).toEqual([`document:FINAL_REGULARIZATION:${FINAL}:0:${K.groupName}`]);
    const docs = await docsOf(K.groupId);
    expect(docs).toHaveLength(3);
    expect(docs[2]).toMatchObject({ total: 0, dueDate: null });
    expect(docs[2].data).toMatchObject({ statement: true });
    expect(docs[2].lines[0]).toMatchObject({ pupils: 101, pupilsChange: 0, yearAmount: share(50_500), alreadyBilled: share(50_500), amount: 0 });
    // Aucun élève facturé deux fois : la somme des documents de l'année est le montant de l'année.
    expect(docs.reduce((s, x) => s + x.total, 0)).toBe(share(50_500));
    const notes = await inTenant(K.id, (tx) => tx.notification.findMany({ where: { userId: K.directionId, kind: 'billing.document_issued' }, orderBy: { createdAt: 'asc' } }));
    expect(notes.map((x) => x.title)).toEqual([
      expect.stringContaining('Document provisoire de votre abonnement Cahiora'), expect.stringContaining('Document provisoire de votre abonnement Cahiora'),
      'Relevé de votre abonnement Cahiora : rien à payer',
    ]);
    const seen = (await as(K.direction).get('/settings/billing-documents')).body.documents;
    expect(seen.map((x: { label: string; total: number }) => `${x.label}:${x.total}`)).toEqual([
      'Relevé de l’abonnement, rien à payer:0', `Proforma de l’abonnement:${complement}`, `Proforma de l’abonnement:${share(45_000)}`,
    ]);
    expect(mine((await svc().runDue(at(day2))).done, K)).toEqual([]);
  });

  it('groupe de plusieurs établissements : la base sait le consolider, la tâche attend D-G5-31 et D-G5-32 ; les écoles du groupe ne voient rien (D-G5-19)', async () => {
    // Deux établissements à la même date : fermé tant que D-G5-32 (élève transféré) n'est pas tranché.
    await app.get(CountsService).runDue(at(d(-6)));
    expect(mine((await svc().runDue()).done, G1)).toEqual([]);
    let plan = (await pf.get('/billing/documents')).body.plans.find((p: { groupId: string }) => p.groupId === G1.groupId);
    expect(plan).toMatchObject({ state: 'CLOSED', decision: 'D-G5-32' });
    expect(plan.establishments.map((e: { next: { state: string } }) => e.next.state)).toEqual(['READY', 'READY']);

    // Un troisième établissement, à une autre date (essai commencé 5 jours plus tôt) : D-G5-31.
    await newSchool(G3, 'g3', { id: G1.groupId, name: G1.groupName });
    expect((await pf.post(`/billing/establishments/${G3.id}/trial`, { startDate: d(-25), code: await code() })).status).toBe(201);
    await app.get(BillingJobsService).runDue(at(d(-11)));
    await app.get(CountsService).runDue(at(d(-11)));
    plan = (await pf.get('/billing/documents')).body.plans.find((p: { groupId: string }) => p.groupId === G1.groupId);
    expect(plan).toMatchObject({ state: 'CLOSED', decision: 'D-G5-31' });
    expect(plan.message).toContain(`${G3.name} : rien à cette date`);
    // Conditions pas encore acceptées par G3 : la base refuse aussi sa ligne.
    const g3Count = await admin.billingCount.findFirstOrThrow({ where: { tenantId: G3.id, kind: 'TRIAL_END' } });
    const [g1Line, g2Line] = await computed(G1.groupId, PROPOSED);
    expect([g1Line, g2Line].map((l) => l.tenantId)).toEqual([G1.id, G2.id]);
    const g3Base = { ...g1Line, tenantId: G3.id, countId: g3Count.id };
    await expect(issue(G1.groupId, [g3Base])).rejects.toThrow(/conditions commerciales ne sont pas acceptées/);
    expect((await as(G3.direction).post('/settings/subscription/accept', { termsId, accepted: true })).status).toBe(201);
    const g3 = (await computed(G1.groupId, PROPOSED)).find((l) => l.tenantId === G3.id)!;
    await expect(issue(G1.groupId, [g1Line, g3])).rejects.toThrow(/dates différentes : en attente de la décision D-G5-31/);

    // Même date : la base consolide (tests 7 et 8), chaque établissement calculé à part, minimum compris.
    expect(g1Line).toMatchObject({ pupils: 0, minimumApplied: true, fullYear: 40_000, yearAmount: share(40_000) });
    const [r] = await issue(G1.groupId, [g1Line, g2Line]);
    expect(r.document_total).toBe(2 * share(40_000));
    expect((await docsOf(G1.groupId))[0].lines.map((l) => l.tenantId)).toEqual([g1Line.tenantId, g2Line.tenantId]);
    // L'école d'un groupe de plusieurs établissements ne voit encore aucun document.
    const seen = (await as(G1.direction).get('/settings/billing-documents')).body;
    expect(seen.documents).toEqual([]);
    expect(seen.groupPending).toMatch(/D-G5-19/);
    expect(await inTenant(G1.id, (tx) => tx.$queryRaw<unknown[]>`SELECT * FROM current_tenant_billing_documents()`, appDb)).toEqual([]);
  });

  it('test 23 : chaque école ne voit que ses documents ; direction seulement ; aucun accès direct aux tables', async () => {
    expect((await as(K.secretariat!).get('/settings/billing-documents')).status).toBe(403);
    expect((await as(O.direction).get('/settings/billing-documents')).body).toMatchObject({ documents: [], groupPending: null });
    expect(await inTenant(O.id, (tx) => tx.$queryRaw<unknown[]>`SELECT * FROM current_tenant_billing_documents()`, appDb)).toEqual([]);
    expect((await inTenant(K.id, (tx) => tx.$queryRaw<unknown[]>`SELECT * FROM current_tenant_billing_documents()`, appDb))).toHaveLength(3);
    // Rôle des écoles : ni les tables, ni l'émission ; groupes et statistiques : rien.
    for (const t of ['billing_documents', 'billing_document_lines']) {
      for (const db of [appDb, groupDb, statsDb]) await expect(db.$queryRawUnsafe(`SELECT count(*) FROM ${t}`)).rejects.toThrow(/permission denied/);
    }
    await expect(inTenant(K.id, (tx) => tx.$queryRaw`SELECT * FROM issue_billing_document(${K.groupId}::uuid, 'SUBSCRIPTION', 'XOF', ${T}::date, NULL, ${year.label},
      NULL, '{}'::jsonb, '[]'::jsonb, 'system', NULL, 'Intrus')`, appDb)).rejects.toThrow(/permission denied/);
    // Plateforme : lecture et émission par la fonction seulement.
    await expect(platform().$executeRawUnsafe(`UPDATE billing_documents SET total = 0 WHERE group_id = '${K.groupId}'`)).rejects.toThrow(/permission denied/);
    await expect(platform().$executeRawUnsafe(`INSERT INTO billing_documents (id, group_id, kind, reference, currency, "issueDate", total, data, "createdByKind", "createdByName")
      VALUES (gen_random_uuid(), '${K.groupId}', 'SUBSCRIPTION', 'X', 'XOF', now(), 0, '{}', 'system', 'Intrus')`)).rejects.toThrow(/permission denied/);
  });

  it('test 24 : aucune modification rétroactive d’un document, même par le propriétaire de la base', async () => {
    const refused = (sql: string) => expect(admin.$executeRawUnsafe(sql)).rejects.toThrow();
    await refused(`UPDATE billing_documents SET total = 0 WHERE group_id = '${K.groupId}'`);
    await refused(`UPDATE billing_documents SET "dueDate" = NULL WHERE group_id = '${K.groupId}'`);
    await refused(`DELETE FROM billing_documents WHERE group_id = '${K.groupId}'`);
    await refused(`UPDATE billing_document_lines SET amount = 0 WHERE tenant_id = '${K.id}'`);
    await refused(`DELETE FROM billing_document_lines WHERE tenant_id = '${K.id}'`);
    for (const t of ['billing_documents', 'billing_document_lines']) await refused(`TRUNCATE ${t} CASCADE`);
    expect((await docsOf(K.groupId)).map((x) => x.total)).toEqual([share(45_000), share(50_500) - share(45_000), 0]);
  });

  it('test 25 : aucune facture fiscale ; références provisoires et mention sur chaque document ; journaux de la plateforme, du groupe et de l’école', async () => {
    const [kinds] = await admin.$queryRaw<{ v: string[] }[]>`SELECT enum_range(NULL::"BillingDocumentKind")::text[] AS v`;
    expect(kinds.v).toEqual(['SUBSCRIPTION', 'CREDIT_NOTE', 'SERVICE_QUOTE', 'SERVICE_PROFORMA']);
    const all = await admin.billingDocument.findMany({ where: { groupId: { in: [K.groupId, G1.groupId] } } });
    expect(all).toHaveLength(4);
    for (const doc of all) {
      expect(doc.reference).toMatch(/^PROV-[0-9A-F]{10}$/);
      expect((doc.data as Record<string, unknown>).mention).toBe(PROVISIONAL_MENTION);
    }
    const list = (await pf.get('/billing/documents')).body;
    const k = list.documents.filter((x: { group: { id: string } }) => x.group.id === K.groupId);
    expect(k.map((x: { label: string }) => x.label)).toEqual(['Relevé de l’abonnement, rien à payer', 'Proforma de l’abonnement', 'Proforma de l’abonnement']);
    const one = (await pf.get(`/billing/documents/${k[2].id}`)).body;
    expect(one).toMatchObject({ reference: k[2].reference, lines: [{ tenant: { id: K.id, name: K.name }, pupils: 90, shareOf: 11 }] });
    expect((await pf.get(`/billing/documents/${randomUUID()}`)).status).toBe(404);
    // La tâche planifiée signe ses trois documents dans les trois journaux ; jamais un nom d'élève.
    const count = async (rows: Promise<{ action: string }[]>) => (await rows).filter((r) => r.action === 'billing.document_issued').length;
    expect(await count(admin.platformAuditLog.findMany({ where: { tenantId: K.id } }))).toBe(3);
    expect(await count(admin.groupAuditLog.findMany({ where: { groupId: K.groupId } }))).toBe(3);
    expect(await count(inTenant(K.id, (tx) => tx.auditLog.findMany({ where: { entity: 'BillingDocument' } })))).toBe(3);
    const text = JSON.stringify(await admin.groupAuditLog.findMany({ where: { groupId: K.groupId, action: 'billing.document_issued' } }));
    expect(text).not.toMatch(/FICTIF[0-9A-F]{8}/);
    expect(await admin.platformAlert.count({ where: { tenantId: K.id, kind: { startsWith: 'DOCUMENT' } } })).toBe(0);
  });
});

/** Jour au format des messages de la base (JJ/MM/AAAA). */
const dmy = (day: string) => day.split('-').reverse().join('/');
const dayOf = (x: Date | null) => x?.toISOString().slice(0, 10) ?? null;
const message = (r: request.Response) => JSON.stringify(r.body.message);
const cancel = (s: School, p: Pupil) => as(s.direction).post(`/students/${p.studentId}/enrollment/cancel`, { reason: 'Inscription saisie en double (fictive)' });
const exclusion = (p: Pupil) => ({ kind: 'EXCLUSION', enrollmentId: p.enrollmentId, justification: 'Élève saisi deux fois : voir le registre (fictif)' });
const frozen = (s: School, kind: 'TRIAL_END' | 'FIRST_REGULARIZATION' | 'FINAL_REGULARIZATION') =>
  admin.billingCount.findFirstOrThrow({ where: { tenantId: s.id, kind, stage: 'FROZEN' } });
const billed = async (s: School) =>
  (await platform().$queryRaw<{ billed: number }[]>`SELECT billing_already_billed(${s.id}::uuid, ${year.label}) AS billed`)[0].billed;
const correction = (s: School, id: string) => inTenant(s.id, (tx) => tx.countCorrection.findUniqueOrThrow({ where: { id } }));
const superAdmin = () => ({ id: sa.id, name: sa.name, ip: null });
type Item = { enrollmentId: string };
type Exclusion = { id: string; tenant: { id: string } };

describe('Lot G5c · exclusions après un document et avoirs provisoires (D-G5-13 B, D-G5-14 A ; données fictives)', () => {
  let issued = ''; // date du dernier document de K : le relevé de la régularisation finale
  let k1 = ''; // exclusion de K validée par le Super Admin, avec son avoir

  it('D-G5-14 A et D-G5-13 B : une exclusion qui touche un document se demande jusqu’à 30 jours après lui ; seul le Super Admin la décide', async () => {
    const docs = await docsOf(K.groupId);
    expect(docs.map((x) => x.kind)).toEqual(['SUBSCRIPTION', 'SUBSCRIPTION', 'SUBSCRIPTION']);
    issued = dayOf(docs[2].issueDate)!;
    const trial = await frozen(K, 'TRIAL_END');
    const url = `/settings/billing-counts/${trial.id}`;
    const pupil = kFirst[1];
    const item = async () => (await as(K.direction).get(url)).body.items.find((i: Item) => i.enrollmentId === pupil.enrollmentId);
    // Une inscription encore active ne s'exclut pas, même sur un comptage figé.
    expect(await item()).toMatchObject({ enrollmentStatus: 'ACTIVE', canExclude: false, documentDate: issued, decider: 'PLATFORM' });
    expect(message(await as(K.direction).post(`${url}/corrections`, exclusion(pupil)))).toMatch(/annulez-la d'abord/);
    expect((await cancel(K, pupil)).status).toBe(201);
    // Comptage figé et documents émis : la demande reste possible jusqu'à 30 jours après le dernier document qui a demandé l'élève.
    expect(await item()).toMatchObject({
      enrollmentStatus: 'CANCELLED', exclusion: null, canExclude: true, documentDate: issued, exclusionUntil: addDays(issued, 30), decider: 'PLATFORM',
    });
    const r = await as(K.direction).post(`${url}/corrections`, exclusion(pupil));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'PENDING' });
    k1 = r.body.id;

    // La direction ne la décide plus : un document émis est touché.
    const own = await as(K.direction).post(`/settings/billing-counts/corrections/${k1}/decision`, { decision: 'VALIDATED' });
    expect(own.status).toBe(400);
    expect(message(own)).toMatch(/le Super Admin de Cahiora la décide \(D-G5-13 B\)/);
    const view = (await as(K.direction).get(url)).body;
    expect(view.corrections.find((k: { id: string }) => k.id === k1)).toMatchObject({ kind: 'EXCLUSION', status: 'PENDING', decider: 'PLATFORM', decidedByKind: null });
    expect(await item()).toMatchObject({ exclusion: { id: k1, status: 'PENDING' }, canExclude: false });

    // Le Super Admin est alerté, avec le matricule, jamais le nom de l'élève.
    const alerts = await admin.platformAlert.findMany({ where: { tenantId: K.id, kind: 'COUNT_EXCLUSION_TO_DECIDE' } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toBe(`Demande d'exclusion à décider : ${K.name}, inscription G5C-${stamp}-${pupil.m} déjà demandée par le document du ${dmy(issued)} (D-G5-13 B)`);
  });

  it('le Super Admin voit la demande et l’avoir qu’elle donnerait ; il décide avec son code ; l’avoir provisoire suit, sinon rien n’est inscrit', async () => {
    const docs = await docsOf(K.groupId);
    const last = docs[2];
    const avoir = share(50_500) - share(50_000);
    const list = await pf.get('/billing/exclusions');
    expect(list.status).toBe(200);
    expect(list.body.mention).toBe(PROVISIONAL_MENTION);
    expect(list.body.waiting).toBeGreaterThanOrEqual(1);
    const row = list.body.exclusions.find((x: Exclusion) => x.id === k1);
    expect(row).toMatchObject({
      tenant: { id: K.id, name: K.name }, currency: 'XOF', status: 'PENDING', countKind: 'TRIAL_END', referenceDate: trialEnd, yearLabel: year.label,
      matricule: `G5C-${stamp}-${kFirst[1].m}`, className: '6e fictive', cancelReason: 'Inscription saisie en double (fictive)',
      justification: 'Élève saisi deux fois : voir le registre (fictif)', fileUrl: null, documentDate: issued, requestDeadline: addDays(issued, 30),
      preview: {
        related: last.reference, state: 'READY', alreadyBilled: share(50_500), amount: avoir,
        year: { pupils: 100, fullYear: 50_000, amount: share(50_000), minimumApplied: false, share: { months: months(), of: 11 } },
      },
    });
    expect(row.requestedByName).toMatch(/DIRECTION k/);
    // Le Super Admin ne voit jamais le nom d'un élève.
    expect(JSON.stringify(list.body)).not.toMatch(/FICTIF[0-9A-F]{8}/);

    const decide = (body: object) => pf.post(`/billing/exclusions/${k1}/decision`, body);
    expect((await decide({ tenantId: K.id, decision: 'VALIDATED' })).status).toBe(400);
    expect(message(await decide({ tenantId: K.id, decision: 'REFUSED', code: await code() }))).toMatch(/Un refus exige un motif/);
    expect(message(await decide({ tenantId: O.id, decision: 'VALIDATED', code: await code() }))).toMatch(/demande d'exclusion introuvable/);
    // Avoir refusé par la base (ici daté avant le relevé, qui est simulé plus tard dans l'année) : la décision n'est pas inscrite non plus.
    expect(message(await decide({ tenantId: K.id, decision: 'VALIDATED', code: await code() }))).toMatch(/jamais daté avant le document auquel il est lié/);
    expect(await correction(K, k1)).toMatchObject({ status: 'PENDING', decidedAt: null });
    expect(await docsOf(K.groupId)).toHaveLength(3);

    // Le lendemain du relevé : décision et avoir dans la même opération.
    const done = await svc().decideExclusion(superAdmin(), k1, { tenantId: K.id, decision: 'VALIDATED', code: await code() }, at(addDays(issued, 1)));
    expect(done).toMatchObject({ status: 'VALIDATED', message: null, credit: { total: avoir, reference: expect.stringMatching(/^PROV-[0-9A-F]{10}$/) } });
    const credit = (await docsOf(K.groupId)).find((x) => x.kind === 'CREDIT_NOTE')!;
    expect(credit).toMatchObject({
      id: done.credit!.documentId, total: avoir, currency: 'XOF', dueDate: null, yearLabel: year.label, relatedDocumentId: last.id, createdByKind: 'platform',
      createdById: sa.id, createdByName: sa.name,
    });
    expect(dayOf(credit.issueDate)).toBe(addDays(issued, 1));
    expect(credit.data).toMatchObject({
      title: `Avoir provisoire · abonnement Cahiora ${year.label}`, mention: PROVISIONAL_MENTION, client: { groupId: K.groupId, name: K.groupName },
      establishments: [{ tenantId: K.id, name: K.name }], related: { documentId: last.id, reference: last.reference, countKind: 'FINAL_REGULARIZATION', countDate: FINAL },
      tariff: { currency: 'XOF', pricePerPupil: 500, minimum: 40_000 }, rounded: 'FLOOR',
    });
    expect(credit.lines).toHaveLength(1);
    expect(credit.lines[0]).toMatchObject({
      tenantId: K.id, amount: avoir, countId: null, countKind: 'FINAL_REGULARIZATION', pupils: 100, pupilsChange: -1, pricePerPupil: 500, minimum: 40_000,
      minimumApplied: false, fullYear: 50_000, shareMonths: months(), shareOf: 11, yearAmount: share(50_000), alreadyBilled: share(50_500),
      relatedLineId: last.lines[0].id, correctionId: k1, serviceId: null,
    });
    expect(dayOf(credit.lines[0].referenceDate)).toBe(FINAL);
    expect(credit.lines[0].label).toBe(`${K.name} · Avoir après exclusion d’une inscription erronée (${COUNT_KIND_LABELS.FINAL_REGULARIZATION.toLowerCase()} du ${frDay(FINAL)})`);
    // Déjà demandé pour l'année : les documents moins l'avoir ; jamais un remboursement automatique.
    expect(await billed(K)).toBe(share(50_000));
    expect(await correction(K, k1)).toMatchObject({ status: 'VALIDATED', decidedByKind: 'platform', decidedById: sa.id, decidedByName: sa.name, decisionNote: null });
    expect(message(await decide({ tenantId: K.id, decision: 'REFUSED', note: 'Changement d’avis (fictif)', code: await code() }))).toMatch(/déjà reçu une décision/);

    // La direction (école indépendante) est prévenue dans l'application, avec l'avoir, et le voit avec ses documents.
    const notes = await inTenant(K.id, (tx) => tx.notification.findMany({ where: { userId: K.directionId, kind: 'billing.count_exclusion_validated' } }));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ channel: 'IN_APP', title: 'Exclusion validée par Cahiora' });
    expect(notes[0].body).toContain(`Avoir provisoire ${done.credit!.reference} de ${money(avoir, 'XOF')}`);
    expect(notes[0].body).toContain(PROVISIONAL_MENTION);
    const seen = (await as(K.direction).get('/settings/billing-documents')).body.documents;
    expect(seen.find((x: { kind: string }) => x.kind === 'CREDIT_NOTE')).toMatchObject({
      label: 'Avoir provisoire', reference: done.credit!.reference, total: avoir, relatedDocumentId: last.id, lines: [{ pupils: 100, pupilsChange: -1, amount: avoir }],
    });
    const trial = await frozen(K, 'TRIAL_END');
    const view = (await as(K.direction).get(`/settings/billing-counts/${trial.id}`)).body;
    expect(view.corrections.find((k: { id: string }) => k.id === k1)).toMatchObject({ status: 'VALIDATED', decidedByKind: 'platform', decidedByName: sa.name, decider: null });
    expect(view.items.find((i: Item) => i.enrollmentId === kFirst[1].enrollmentId)).toMatchObject({ exclusion: { id: k1, status: 'VALIDATED' }, canExclude: false });
    // Le comptage figé, lui, ne change jamais.
    expect(await admin.billingCount.findUniqueOrThrow({ where: { id: trial.id } })).toMatchObject({ pupils: 90, cumulative: 90 });

    // Journaux : la plateforme (avec le matricule), le groupe (sans), l'école ; la décision et l'avoir.
    expect(await admin.platformAuditLog.count({ where: { tenantId: K.id, adminId: sa.id, action: 'billing.count_exclusion_validated' } })).toBe(1);
    expect(await admin.platformAuditLog.count({ where: { tenantId: K.id, adminId: sa.id, action: 'billing.credit_note_issued' } })).toBe(1);
    const group = await admin.groupAuditLog.findMany({ where: { groupId: K.groupId, action: { in: ['billing.count_exclusion_validated', 'billing.credit_note_issued'] } } });
    expect(group.map((x) => `${x.actorKind}:${x.action}`).sort()).toEqual(['platform:billing.count_exclusion_validated', 'platform:billing.credit_note_issued']);
    const school = await inTenant(K.id, (tx) => tx.auditLog.findMany({ where: { action: { in: ['billing.count_exclusion_validated', 'billing.credit_note_issued'] } } }));
    expect(school.map((x) => x.action).sort()).toEqual(['billing.count_exclusion_validated', 'billing.credit_note_issued']);
    expect(JSON.stringify(await admin.groupAuditLog.findMany({ where: { groupId: K.groupId } }))).not.toMatch(/FICTIF[0-9A-F]{8}|G5C-/);
  });

  it('la base refait le calcul de l’avoir : élèves, écart, montant, document touché, prix, exclusion, date ; un seul avoir par exclusion', async () => {
    const trial = await frozen(K, 'TRIAL_END');
    const pupil = kFirst[2];
    expect((await cancel(K, pupil)).status).toBe(201);
    const r = await as(K.direction).post(`/settings/billing-counts/${trial.id}/corrections`, exclusion(pupil));
    expect(r.status).toBe(201);
    const k2: string = r.body.id;
    const docs = await docsOf(K.groupId);
    const [first, , last] = docs;
    const day = addDays(issued, 2);
    const good = {
      tenantId: K.id, label: 'Avoir fictif', amount: share(50_000) - share(49_500), pupils: 99, pupilsChange: -1, pricePerPupil: 500, minimum: 40_000,
      minimumApplied: false, fullYear: 49_500, shareMonths: months(), shareOf: 11, yearAmount: share(49_500), alreadyBilled: share(50_000),
      relatedLineId: last.lines[0].id, correctionId: k2,
    };
    const credit = (lines: object[], o: Parameters<typeof issue>[2] = {}) => issue(K.groupId, lines, { kind: 'CREDIT_NOTE', related: last.id, issueDay: day, ...o });
    const refused = (lines: object[], pattern: RegExp, o: Parameters<typeof issue>[2] = {}) => expect(credit(lines, o)).rejects.toThrow(pattern);
    // Exclusion encore en attente : pas d'avoir.
    await refused([good], /exclusion de cet établissement validée par le Super Admin après ce document attendue/);
    // La direction ne peut pas décider, la base non plus par son rôle ; le Super Admin, par la fonction de la plateforme.
    await expect(inTenant(K.id, (tx) => tx.$queryRaw`SELECT * FROM decide_count_exclusion_platform(${K.id}::uuid, ${k2}::uuid, 'VALIDATED', NULL, ${sa.id}::uuid, ${sa.name}, NULL)`, appDb))
      .rejects.toThrow(/permission denied/);
    await expect(platform().$queryRaw`SELECT * FROM decide_count_exclusion_platform(${K.id}::uuid, ${k2}::uuid, 'MAYBE', NULL, ${sa.id}::uuid, ${sa.name}, NULL)`)
      .rejects.toThrow(/décision inconnue/);
    const [decided] = await platform().$queryRaw<{ document_date: Date; year_label: string }[]>`
      SELECT * FROM decide_count_exclusion_platform(${K.id}::uuid, ${k2}::uuid, 'VALIDATED', NULL, ${sa.id}::uuid, ${sa.name}, NULL)`;
    expect({ date: dayOf(decided.document_date), year: decided.year_label }).toEqual({ date: issued, year: year.label });

    await refused([{ ...good, pupils: 100, pupilsChange: 0, fullYear: 50_000, yearAmount: share(50_000), amount: 1 }], /élèves facturables après l'exclusion faux/);
    await refused([{ ...good, pupilsChange: -2 }], /écart d'élèves faux/);
    await refused([{ ...good, amount: good.amount + 1 }], /montant de l'avoir faux/);
    await refused([{ ...good, amount: 0 }], /un avoir vient d'une exclusion validée et touche une ligne d'abonnement/);
    await refused([{ ...good, countId: last.lines[0].countId }], /un avoir vient d'une exclusion validée et touche une ligne d'abonnement/);
    await refused([{ ...good, alreadyBilled: share(50_500) }], /déjà demandé faux/);
    await refused([{ ...good, relatedLineId: first.lines[0].id }], /ligne touchée inconnue/);
    await refused([{ ...good, relatedLineId: first.lines[0].id }], /un avoir touche le dernier document d'abonnement de l'établissement pour l'année/, { related: first.id });
    await refused([{ ...good, pricePerPupil: 600, fullYear: 59_400, yearAmount: share(59_400) }], /prix, minimum et part de la ligne touchée attendus/);
    await refused([{ ...good, correctionId: k1 }], /cette exclusion a déjà son avoir/);
    await refused([good, { ...good }], /un avoir a une seule ligne/);
    await refused([good], /jamais daté avant le document auquel il est lié/, { issueDay: T });
    await refused([good], /ce document ne peut pas être lié/, { related: (await docsOf(K.groupId)).find((x) => x.kind === 'CREDIT_NOTE')!.id });

    const [ok] = await credit([good]);
    expect(ok.document_total).toBe(share(50_000) - share(49_500));
    expect(await billed(K)).toBe(share(49_500));
    await refused([{ ...good, alreadyBilled: share(49_500), pupilsChange: 0 }], /cette exclusion a déjà son avoir/);
    expect((await docsOf(K.groupId)).filter((x) => x.kind === 'CREDIT_NOTE').map((x) => x.total)).toEqual([share(50_500) - share(50_000), ok.document_total]);
  });

  it('D-G5-14 A : plus de demande 30 jours après le document ; un refus du Super Admin exige un motif et prévient la direction', async () => {
    const trial = await frozen(K, 'TRIAL_END');
    const pupil = kFirst[3];
    expect((await cancel(K, pupil)).status).toBe(201);
    const ask = (today: string, kind = 'EXCLUSION', departure: string | null = null, p = pupil) => inTenant(K.id, (tx) => tx.$queryRaw<{ id: string }[]>`
      SELECT request_count_correction(${trial.id}::uuid, ${kind}, ${p.enrollmentId}::uuid, ${departure}::date, 'Élève saisi deux fois (fictif)', NULL, NULL,
        NULL::integer, ${K.directionId}::uuid, 'Fictif DIRECTION k', NULL, ${today}::date) AS id`, appDb);
    await expect(ask(addDays(issued, 31))).rejects.toThrow(`délai passé : une exclusion se demande au plus tard 30 jours après le document concerné, émis le ${dmy(issued)} (D-G5-14 A)`);
    const [{ id: k3 }] = await ask(addDays(issued, 30));
    // Un comptage figé ne reçoit plus de date de départ ; une inscription qu'il ne compte pas ne s'y exclut pas.
    await expect(ask(T, 'DEPARTURE_DATE', d(-5), kFirst[0])).rejects.toThrow(/la vérification de ce comptage est terminée : seule une exclusion se demande encore \(D-G5-14 A\)/);
    expect((await cancel(K, kLate[0])).status).toBe(201);
    expect(message(await as(K.direction).post(`/settings/billing-counts/${trial.id}/corrections`, exclusion(kLate[0])))).toMatch(/n'est pas comptée dans ce comptage figé/);

    const decide = (body: object) => pf.post(`/billing/exclusions/${k3}/decision`, body);
    expect(message(await decide({ tenantId: K.id, decision: 'REFUSED', note: 'abc', code: await code() }))).toMatch(/Un refus exige un motif/);
    const note = 'Les deux dossiers sont deux élèves différents (fictif)';
    const no = await decide({ tenantId: K.id, decision: 'REFUSED', note, code: await code() });
    expect(no.status).toBe(201);
    expect(no.body).toEqual({ status: 'REFUSED', credit: null, message: null });
    expect(await correction(K, k3)).toMatchObject({ status: 'REFUSED', decidedByKind: 'platform', decisionNote: note });
    expect(message(await decide({ tenantId: K.id, decision: 'VALIDATED', code: await code() }))).toMatch(/déjà reçu une décision/);
    const notes = await inTenant(K.id, (tx) => tx.notification.findMany({ where: { userId: K.directionId, kind: 'billing.count_exclusion_refused' } }));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ title: 'Exclusion refusée par Cahiora', body: `Le Super Admin de Cahiora a refusé l’exclusion demandée : ${note}` });
    // Un refus n'émet rien.
    expect((await docsOf(K.groupId)).filter((x) => x.kind === 'CREDIT_NOTE')).toHaveLength(2);
  });

  it('avant tout document, la direction décide, même sur un comptage figé ; le document suit les élèves facturables ; au minimum, aucun avoir', async () => {
    await newSchool(L, 'l', null);
    const pupils = await enrol(3, year.start, (await newClass(L)).id, L);
    expect((await pf.post(`/billing/establishments/${L.id}/trial`, { startDate: d(-20), code: await code() })).status).toBe(201);
    await app.get(BillingJobsService).runDue(at(d(-6)));
    await app.get(CountsService).runDue(at(d(-6)));
    const trial = await frozen(L, 'TRIAL_END');
    expect(trial).toMatchObject({ pupils: 3, cumulative: 3 });
    const url = `/settings/billing-counts/${trial.id}`;

    // Aucun document émis : sans limite de date, la direction décide (D-G5-13 B) ; aucune alerte de la plateforme.
    expect((await cancel(L, pupils[0])).status).toBe(201);
    expect((await as(L.direction).get(url)).body.items.find((i: Item) => i.enrollmentId === pupils[0].enrollmentId)).toMatchObject({
      canExclude: true, documentDate: null, exclusionUntil: null, decider: 'SCHOOL',
    });
    const r = await as(L.direction).post(`${url}/corrections`, exclusion(pupils[0]));
    expect(r.status).toBe(201);
    expect((await as(L.direction).get(url)).body.corrections.find((k: { id: string }) => k.id === r.body.id)).toMatchObject({ status: 'PENDING', decider: 'SCHOOL' });
    expect(await admin.platformAlert.count({ where: { tenantId: L.id, kind: 'COUNT_EXCLUSION_TO_DECIDE' } })).toBe(0);
    expect(message(await pf.post(`/billing/exclusions/${r.body.id}/decision`, { tenantId: L.id, decision: 'VALIDATED', code: await code() })))
      .toMatch(/ne touche aucun document émis : la direction de l'établissement la décide \(D-G5-13 B\)/);
    expect((await as(L.direction).post(`/settings/billing-counts/corrections/${r.body.id}/decision`, { decision: 'VALIDATED' })).body).toEqual({ status: 'VALIDATED' });
    expect(await correction(L, r.body.id)).toMatchObject({ status: 'VALIDATED', decidedByKind: 'school' });
    // Élèves facturables du comptage figé : l'exclusion validée est retirée ; le comptage, lui, ne change pas.
    expect(await platform().$queryRaw`SELECT * FROM billing_counts_billable(${L.id}::uuid)`).toEqual([{ count_id: trial.id, billable: 2 }]);
    expect(await admin.billingCount.findUniqueOrThrow({ where: { id: trial.id } })).toMatchObject({ pupils: 3, cumulative: 3 });

    // L'acceptation des conditions émet le premier document (propositions de Dankou) : deux élèves, au minimum annuel.
    expect((await as(L.direction).post('/settings/subscription/accept', { termsId, accepted: true })).status).toBe(201);
    const [doc] = await docsOf(L.groupId);
    expect(doc.lines[0]).toMatchObject({ countId: trial.id, pupils: 2, pupilsChange: 2, minimumApplied: true, fullYear: 40_000, yearAmount: share(40_000), amount: share(40_000) });
    const issuedL = dayOf(doc.issueDate)!;

    // Après le document : le Super Admin décide ; au minimum, la décision s'inscrit sans avoir.
    expect((await cancel(L, pupils[1])).status).toBe(201);
    const r2 = await as(L.direction).post(`${url}/corrections`, exclusion(pupils[1]));
    expect(r2.status).toBe(201);
    expect(await admin.platformAlert.count({ where: { tenantId: L.id, kind: 'COUNT_EXCLUSION_TO_DECIDE' } })).toBe(1);
    const row = (await pf.get('/billing/exclusions')).body.exclusions.find((x: Exclusion) => x.id === r2.body.id);
    expect(row).toMatchObject({
      status: 'PENDING', documentDate: issuedL, requestDeadline: addDays(issuedL, 30),
      preview: { related: doc.reference, state: 'NONE', amount: 0, message: 'Au minimum annuel, rien ne change : aucun avoir', year: { pupils: 1, minimumApplied: true } },
    });
    const done = await pf.post(`/billing/exclusions/${r2.body.id}/decision`, { tenantId: L.id, decision: 'VALIDATED', code: await code() });
    expect(done.status).toBe(201);
    expect(done.body).toEqual({ status: 'VALIDATED', credit: null, message: 'Au minimum annuel, rien ne change : aucun avoir' });
    expect((await docsOf(L.groupId)).map((x) => x.kind)).toEqual(['SUBSCRIPTION']);
    expect(await billed(L)).toBe(share(40_000));
    expect(await platform().$queryRaw`SELECT * FROM billing_counts_billable(${L.id}::uuid)`).toEqual([{ count_id: trial.id, billable: 1 }]);
    const notes = await inTenant(L.id, (tx) => tx.notification.findMany({ where: { userId: L.directionId, kind: 'billing.count_exclusion_validated' } }));
    expect(notes.map((x) => x.body)).toEqual(['Le Super Admin de Cahiora a validé l’exclusion demandée. Au minimum annuel, rien ne change : aucun avoir.']);

    // Liste du Super Admin : les décisions qui lui reviennent, jamais celles de la direction.
    const mineOnly = (await pf.get('/billing/exclusions')).body.exclusions.filter((x: Exclusion) => [K.id, L.id].includes(x.tenant.id));
    expect(mineOnly.map((x: Exclusion & { status: string }) => `${x.tenant.id === K.id ? 'K' : 'L'}:${x.status}`).sort()).toEqual([
      'K:REFUSED', 'K:VALIDATED', 'K:VALIDATED', 'L:VALIDATED',
    ]);
  });
});
