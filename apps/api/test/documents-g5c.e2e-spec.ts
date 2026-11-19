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
import { localDay } from '../src/common/country';
import { PrismaService } from '../src/common/prisma.service';
import { AmountDecisions, DECISIONS, isClosed, Line } from '../src/modules/billing/amounts-rules';
import { BillingJobsService } from '../src/modules/billing/billing-jobs';
import { addDays, frDay, lastDayOfMonth, monthsSpanned } from '../src/modules/billing/billing-rules';
import { CountsService } from '../src/modules/billing/counts';
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
const sa = { id: '', name: 'Super Admin documents (fictif)', email: `g5c-${stamp}@test.local`, cookie: '', secret: '' };

const [ty, tm] = T.split('-').map(Number);
const year = { label: '', start: addDays(lastDayOfMonth(ty, tm - 4), 1), end: lastDayOfMonth(ty, tm + 7) };
const R = d(-3);
const FINAL = d(100);
let termsId = '';
let trialEnd = '';

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

/** `n` élèves fictifs de K inscrits le jour `day` (inscription et ligne d'historique) ; renvoie leurs inscriptions. */
async function enrol(n: number, day: string, classId: string) {
  return inTenant(K.id, async (tx) => {
    const rows = Array.from({ length: n }, () => ({ studentId: randomUUID(), enrollmentId: randomUUID(), m: randomUUID().slice(0, 8) }));
    await tx.student.createMany({ data: rows.map((r) => ({ id: r.studentId, tenantId: K.id, matricule: `G5C-${stamp}-${r.m}`, firstName: 'Élève', lastName: `FICTIF${r.m.toUpperCase()}` })) });
    await tx.enrollment.createMany({
      data: rows.map((r) => ({ id: r.enrollmentId, tenantId: K.id, studentId: r.studentId, classId, academicYearId: K.yearId, enrolledAt: morning(day), type: 'NEW' as const })),
    });
    await tx.enrollmentEvent.createMany({ data: rows.map((r) => ({ tenantId: K.id, enrollmentId: r.enrollmentId, kind: 'ENROLLED', data: { classId, type: 'NEW' }, createdAt: morning(day) })) });
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
function issue(groupId: string, lines: Partial<JsonLine>[], o: { kind?: string; year?: string; due?: string | null; issueDay?: string; related?: string | null } = {}) {
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
  const klass = await inTenant(K.id, async (tx) => {
    const level = await tx.level.create({ data: { tenantId: K.id, name: '6e', cycle: 'COLLEGE', position: 1 } });
    const site = await tx.site.create({ data: { tenantId: K.id, name: 'Site fictif' } });
    return tx.class.create({ data: { tenantId: K.id, academicYearId: K.yearId, siteId: site.id, levelId: level.id, name: '6e fictive' } });
  });
  const first = await enrol(90, year.start, klass.id);
  await enrol(11, d(-5), klass.id);
  await inTenant(K.id, async (tx) => {
    await tx.enrollment.update({ where: { id: first[0].enrollmentId }, data: { status: 'WITHDRAWN', exitDate: new Date(`${d(-5)}T00:00:00Z`), exitReason: 'Départ fictif' } });
    await tx.enrollmentEvent.create({ data: { tenantId: K.id, enrollmentId: first[0].enrollmentId, kind: 'WITHDRAWN', data: { exitDate: d(-5), reason: 'Départ fictif' }, createdAt: morning(d(-5)) } });
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
      const s = new BillingDocumentsService(app.get(PlatformDb), app.get(PrismaService));
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
