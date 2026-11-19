/**
 * Lot G5a de la facturation de Cahiora, de bout en bout sur la base de test (erp_test), avec des établissements, des
 * comptes et des conditions commerciales entièrement fictifs créés pour ce fichier. Aucun paiement, aucun SMS, aucune
 * facture. Numéros des tests obligatoires du cahier des charges (§19) : 3 (essai), 6 (calendriers), 15 (tarif jamais
 * rétroactif), 21 et 22 (pilote et alertes), 23 (cloisonnement), plus la double authentification et l'ajout seul.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { localDay } from '../src/common/country';
import { BillingJobsService } from '../src/modules/billing/billing-jobs';
import { addDays, calendarProposals, lastDayOfMonth, pilotEndDay, proposeCalendar } from '../src/modules/billing/billing-rules';
import { PlatformDb } from '../src/modules/platform/platform';

const TZ = 'Africa/Porto-Novo';
const PASSWORD = 'Facturation-G5a-2026';
const SA_PASSWORD = 'Plateforme-G5a-2026';
const stamp = Date.now().toString(36);
const TABLES = ['billing_parameters', 'billing_calendars', 'subscriptions', 'subscription_events', 'commercial_terms', 'billing_jobs', 'platform_alerts'];

let app: INestApplication;
let http: ReturnType<typeof request>;
const admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_ADMIN_URL } } });
const appDb = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
const groupDb = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_GROUP_URL } } });
const statsDb = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_STATS_URL } } });

type School = { id: string; slug: string; name: string; groupId: string; direction: string; directionId: string; comptable?: string };
const S: Record<'A' | 'B' | 'C', School> = {} as never;
const sa = { id: '', name: 'Super Admin facturation (fictif)', email: `g5a-${stamp}@test.local`, cookie: '', secret: '' };
const noTwoFactor = { email: `g5a-sans-2fa-${stamp}@test.local`, cookie: '' };
const today = localDay(TZ);
const terms: { future?: string; current?: string } = {};

/** Midi à Porto-Novo, le jour donné. */
const at = (d: string) => new Date(`${d}T11:00:00.000Z`);

function inTenant<T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>, client = admin) {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}

/** Code du moment de l'application d'authentification, jamais à moins de 3 secondes de la fin de sa période. */
async function code(secret = sa.secret) {
  const left = 30_000 - (Date.now() % 30_000);
  if (left < 3000) await new Promise((r) => setTimeout(r, left + 200));
  return authenticator.generate(secret);
}

const cookieOf = (r: request.Response) => (r.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('erp_pt='))!.split(';')[0];
const pf = {
  get: (url: string, cookie = sa.cookie) => http.get(`/api/v1/platform${url}`).set('Cookie', cookie),
  post: (url: string, body: object = {}, cookie = sa.cookie) => http.post(`/api/v1/platform${url}`).set('Cookie', cookie).send(body),
};
const school = (token: string) => ({
  get: (url: string) => http.get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
  post: (url: string, body: object = {}) => http.post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body),
});

async function login(s: School, phone: string) {
  const r = await http.post('/api/v1/auth/login').send({ tenant: s.slug, identifier: phone, password: PASSWORD });
  expect(r.status).toBe(200);
  return r.body.accessToken as string;
}

/** Établissement fictif, seul dans son groupe, avec un compte Direction (tout l'établissement) et, au besoin, un comptable. */
async function newSchool(k: 'A' | 'B' | 'C', withComptable = false): Promise<School> {
  const t = await admin.tenant.create({
    data: { slug: `g5a-${k.toLowerCase()}-${stamp}`, name: `École fictive G5a ${k} ${stamp}`, group: { create: { name: `Groupe fictif G5a ${k} ${stamp}` } } },
  });
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const people = await inTenant(t.id, async (tx) => {
    const add = async (phone: string, role: 'DIRECTION' | 'COMPTABLE', last: string) => {
      const u = await tx.user.create({ data: { tenantId: t.id, phone, firstName: 'Fictif', lastName: last, passwordHash: hash, mustChangePassword: false } });
      await tx.userRole.create({ data: { tenantId: t.id, userId: u.id, role } });
      return u.id;
    };
    const directionId = await add('+2290190006001', 'DIRECTION', `DIRECTION ${k}`);
    if (withComptable) await add('+2290190006002', 'COMPTABLE', `COMPTABLE ${k}`);
    return { directionId };
  });
  const s: School = { id: t.id, slug: t.slug, name: t.name, groupId: t.groupId, direction: '', directionId: people.directionId };
  s.direction = await login(s, '+2290190006001');
  if (withComptable) s.comptable = await login(s, '+2290190006002');
  return s;
}

const subscriptionOf = (tenantId: string) => admin.subscription.findUnique({ where: { tenantId } });
const eventsOf = (tenantId: string) => admin.subscriptionEvent.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } });
const notificationsOf = (tenantId: string) => inTenant(tenantId, (tx) => tx.notification.findMany({ orderBy: { createdAt: 'asc' } }));
const schoolJournal = (tenantId: string, action: string) => inTenant(tenantId, (tx) => tx.auditLog.findMany({ where: { action } }));

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  configureApp(app);
  await app.init();
  http = request(app.getHttpServer());

  S.A = await newSchool('A', true);
  S.B = await newSchool('B');
  S.C = await newSchool('C');

  // Super Admin fictif avec double authentification, et un second sans elle.
  for (const email of [sa.email, noTwoFactor.email]) {
    await admin.platformAdmin.create({ data: { email, name: email === sa.email ? sa.name : 'Super Admin sans 2FA (fictif)', passwordHash: await argon2.hash(SA_PASSWORD), mustChangePassword: false, mustSetupTwoFactor: false } });
  }
  sa.id = (await admin.platformAdmin.findUniqueOrThrow({ where: { email: sa.email } })).id;
  sa.cookie = cookieOf(await http.post('/api/v1/platform/auth/login').send({ email: sa.email, password: SA_PASSWORD }).expect(201));
  noTwoFactor.cookie = cookieOf(await http.post('/api/v1/platform/auth/login').send({ email: noTwoFactor.email, password: SA_PASSWORD }).expect(201));
  const setup = await pf.post('/auth/2fa/setup').expect(201);
  sa.secret = setup.body.secret;
  await pf.post('/auth/2fa/enable', { code: await code(), setupToken: setup.body.setupToken }).expect(201);
});

afterAll(async () => {
  await app?.close();
  await admin.platformAdmin.deleteMany({ where: { email: { in: [sa.email, noTwoFactor.email] } } });
  await Promise.all([admin.$disconnect(), appDb.$disconnect(), groupDb.$disconnect(), statsDb.$disconnect()]);
});

describe('Lot G5a · facturation : abonnements, gratuités, tarifs, calendriers (données fictives)', () => {
  it('Double authentification : chaque opération de facturation exige un code actuel ; sans 2FA ou avec un code faux, refusée et tracée', async () => {
    expect((await http.get('/api/v1/platform/billing/overview')).status).toBe(401);
    expect((await http.get('/api/v1/platform/billing/overview').set('Authorization', `Bearer ${S.A.direction}`)).status).toBe(401);
    const sans = await pf.post(`/billing/establishments/${S.A.id}/trial`, { startDate: today, code: '123456' }, noTwoFactor.cookie);
    expect(sans.status).toBe(403);
    expect(sans.body.message).toMatch(/double authentification/);
    const faux = await pf.post(`/billing/establishments/${S.A.id}/trial`, { startDate: today, code: '000000' });
    expect(faux.status).toBe(403);
    expect(faux.body.message).toMatch(/incorrect/);
    expect(await admin.platformAuditLog.count({ where: { adminId: sa.id, action: 'billing.2fa_failed' } })).toBe(1);
    expect(await subscriptionOf(S.A.id)).toBeNull();
    await admin.platformAdmin.update({ where: { id: sa.id }, data: { failedLogins: 0 } });
    // Les lectures ne demandent pas de code.
    expect((await pf.get('/billing/overview')).status).toBe(200);
  });

  it('Test 3 : essai gratuit de 14 jours, le jour d’ouverture comptant comme le premier ; un seul abonnement ; trois journaux', async () => {
    expect((await pf.post(`/billing/establishments/${S.A.id}/trial`, { startDate: addDays(today, -40), code: await code() })).status).toBe(400);
    expect((await pf.post('/billing/establishments/00000000-0000-4000-8000-000000000000/trial', { startDate: today, code: await code() })).status).toBe(404);
    const r = await pf.post(`/billing/establishments/${S.A.id}/trial`, { startDate: today, code: await code() });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'TRIAL', statusLabel: 'Essai gratuit', trialStart: today, trialEnd: addDays(today, 13), trialDays: 14, freeDaysLeft: 14 });
    expect((await pf.post(`/billing/establishments/${S.A.id}/trial`, { startDate: today, code: await code() })).status).toBe(409);

    const events = await eventsOf(S.A.id);
    expect(events.map((e) => [e.kind, e.actorKind, e.actorName])).toEqual([['TRIAL_OPENED', 'platform', sa.name]]);
    expect(await admin.platformAuditLog.count({ where: { action: 'billing.trial_opened', tenantId: S.A.id, adminId: sa.id } })).toBe(1);
    expect(await admin.groupAuditLog.count({ where: { action: 'billing.trial_opened', groupId: S.A.groupId } })).toBe(1);
    expect(await schoolJournal(S.A.id, 'billing.trial_opened')).toHaveLength(1);

    // La direction voit son essai, le tarif du jour, et un historique où le Super Admin s'appelle « Cahiora ».
    const v = await school(S.A.direction).get('/settings/subscription');
    expect(v.status).toBe(200);
    expect(v.body.subscription).toMatchObject({ status: 'TRIAL', trialStart: today, trialEnd: addDays(today, 13), freeDaysLeft: 14 });
    expect(v.body.tariff).toEqual({ pricePerPupil: 500, minimum: 40000 });
    expect(v.body.terms).toBeNull();
    expect(v.body.history).toHaveLength(1);
    expect(v.body.history[0]).toMatchObject({ kind: 'TRIAL_OPENED', label: 'Essai gratuit ouvert', actorName: 'Cahiora' });
    expect(JSON.stringify(v.body)).not.toContain(sa.name);
    // Paramètres : direction seulement.
    expect((await school(S.A.comptable!).get('/settings/subscription')).status).toBe(403);
  });

  it('Test 3 : à la fin de l’essai, aucun accès gratuit illimité : conditions à accepter, données conservées, une seule fois', async () => {
    const users = await inTenant(S.A.id, (tx) => tx.user.count());
    const lastDay = addDays(today, 13);
    const jobs = app.get(BillingJobsService);
    expect((await jobs.runDue(at(lastDay))).done).not.toContain(`trial-end:${S.A.name}`);
    expect((await subscriptionOf(S.A.id))!.status).toBe('TRIAL');
    expect((await jobs.runDue(at(addDays(lastDay, 1)))).done).toContain(`trial-end:${S.A.name}`);
    expect((await jobs.runDue(at(addDays(lastDay, 2)))).done).not.toContain(`trial-end:${S.A.name}`);

    const s = (await subscriptionOf(S.A.id))!;
    expect(s.status).toBe('AWAITING_ACCEPTANCE');
    expect((await eventsOf(S.A.id)).map((e) => [e.kind, e.fromStatus, e.toStatus, e.actorKind])).toEqual([
      ['TRIAL_OPENED', null, 'TRIAL', 'platform'], ['TRIAL_ENDED', 'TRIAL', 'AWAITING_ACCEPTANCE', 'system'],
    ]);
    expect(await admin.platformAlert.count({ where: { tenantId: S.A.id, kind: 'TRIAL_ENDED' } })).toBe(1);
    // Lot G5d-1 (D-G5-30 A) : le rappel du dernier jour de l'essai est parti la veille, puis la fin de l'essai.
    expect(await admin.billingJob.count({ where: { tenantId: S.A.id } })).toBe(2);
    const notes = await notificationsOf(S.A.id);
    expect(notes.map((n) => [n.kind, n.channel, n.userId])).toEqual([['billing.trial_reminder', 'IN_APP', S.A.directionId], ['billing.trial_ended', 'IN_APP', S.A.directionId]]);
    expect(notes[1].body).toMatch(/Paramètres › Abonnement Cahiora/);
    expect(await inTenant(S.A.id, (tx) => tx.user.count())).toBe(users);
    expect(await schoolJournal(S.A.id, 'billing.trial_ended')).toHaveLength(1);
    // Un pilote ne s'ouvre pas sur un abonnement qui attend l'acceptation.
    expect((await pf.post(`/billing/establishments/${S.A.id}/pilot`, { startDate: today, reason: 'Essai de conversion refusée', code: await code() })).status).toBe(409);
    // Lot G5d-1 : les passages simulés des tests suivants vont des mois plus loin ; la demande de régularisation de la
    // direction retient la limitation (D-G5-42 A), et A reste en attente d'acceptation pour la suite de ce fichier.
    expect((await school(S.A.direction).post('/settings/subscription/regularization-requests', { message: 'Demande fictive (test)' })).status).toBe(201);
  });

  it('Tests 21 et 22 : école pilote, N mois gratuits depuis l’activation saisie, alertes à 30 et 7 jours puis fin, chacune une seule fois', async () => {
    expect((await pf.post(`/billing/establishments/${S.B.id}/trial`, { startDate: today, code: await code() })).status).toBe(201);
    expect((await pf.post(`/billing/establishments/${S.B.id}/pilot`, { startDate: today, code: await code() })).status).toBe(400); // motif obligatoire
    expect((await pf.post(`/billing/establishments/${S.B.id}/pilot`, { startDate: addDays(today, 61), reason: 'Accord fictif', code: await code() })).status).toBe(400);
    const p = await pf.post(`/billing/establishments/${S.B.id}/pilot`, { startDate: today, reason: 'Accord écrit fictif avec la direction (test)', code: await code() });
    expect(p.status).toBe(201);
    const end1 = pilotEndDay(today, 3);
    expect(p.body).toMatchObject({ status: 'PILOT', statusLabel: 'École pilote partenaire CAHIORA', pilotStart: today, pilotEnd: end1, pilotMonths: 3 });

    // Nouvelle fin : jamais dans le passé, jamais la même, toujours avec un motif ; les alertes suivent la nouvelle date.
    expect((await pf.post(`/billing/establishments/${S.B.id}/pilot-end`, { pilotEnd: addDays(today, -1), reason: 'Date passée fictive', code: await code() })).status).toBe(400);
    expect((await pf.post(`/billing/establishments/${S.B.id}/pilot-end`, { pilotEnd: end1, reason: 'Même date fictive', code: await code() })).status).toBe(400);
    const end = addDays(end1, 10);
    const moved = await pf.post(`/billing/establishments/${S.B.id}/pilot-end`, { pilotEnd: end, reason: 'Prolongation fictive de dix jours', code: await code() });
    expect(moved.status).toBe(201);
    expect(moved.body.pilotEnd).toBe(end);
    expect((await school(S.B.direction).get('/settings/subscription')).body.subscription).toMatchObject({ status: 'PILOT', pilotStart: today, pilotEnd: end });

    const jobs = app.get(BillingJobsService);
    const mine = (done: string[]) => done.filter((d) => d.endsWith(`:${S.B.name}`));
    expect(mine((await jobs.runDue(at(addDays(end, -31)))).done)).toEqual([]);
    // Deux passages en même temps (deux serveurs) : l'alerte n'est faite qu'une fois.
    const twin = [new BillingJobsService(app.get(PlatformDb)), new BillingJobsService(app.get(PlatformDb))];
    const both = await Promise.all(twin.map((j) => j.runDue(at(addDays(end, -30)))));
    expect(mine(both.flatMap((r) => r.done))).toEqual([`pilot-alert-30:${S.B.name}`]);
    expect(mine((await jobs.runDue(at(addDays(end, -30)))).done)).toEqual([]);
    expect(mine((await jobs.runDue(at(addDays(end, -7)))).done)).toEqual([`pilot-alert-7:${S.B.name}`]);
    expect(mine((await jobs.runDue(at(end))).done)).toEqual([]);
    expect((await subscriptionOf(S.B.id))!.status).toBe('PILOT');
    expect(mine((await jobs.runDue(at(addDays(end, 1)))).done)).toEqual([`pilot-end:${S.B.name}`]);
    expect(mine((await jobs.runDue(at(addDays(end, 2)))).done)).toEqual([]);

    expect((await subscriptionOf(S.B.id))!.status).toBe('AWAITING_ACCEPTANCE');
    expect((await eventsOf(S.B.id)).map((e) => e.kind)).toEqual(['TRIAL_OPENED', 'PILOT_OPENED', 'PILOT_END_CHANGED', 'PILOT_ENDED']);
    expect((await eventsOf(S.B.id))[1]).toMatchObject({ fromStatus: 'TRIAL', toStatus: 'PILOT', reason: 'Accord écrit fictif avec la direction (test)' });
    const alerts = await admin.platformAlert.findMany({ where: { tenantId: S.B.id }, orderBy: { createdAt: 'asc' } });
    expect(alerts.map((a) => a.kind)).toEqual(['PILOT_ENDING', 'PILOT_ENDING', 'PILOT_ENDED']);
    expect(alerts[2].message).toMatch(/rien n'est facturé pour la période pilote/);
    expect(await admin.billingJob.count({ where: { tenantId: S.B.id } })).toBe(3);
    const notes = await notificationsOf(S.B.id);
    expect(notes.map((n) => [n.kind, n.channel])).toEqual([['billing.pilot_ending', 'IN_APP'], ['billing.pilot_ending', 'IN_APP'], ['billing.pilot_ended', 'IN_APP']]);
    // Aucun SMS.
    expect(await inTenant(S.B.id, (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM sms_messages`)).toEqual([{ n: 0 }]);
    // L'historique vu par l'école ne montre ni le motif ni le nom du Super Admin.
    const h = (await school(S.B.direction).get('/settings/subscription')).body.history as Record<string, unknown>[];
    expect(h.map((e) => e.kind)).toEqual(['PILOT_ENDED', 'PILOT_END_CHANGED', 'PILOT_OPENED', 'TRIAL_OPENED']);
    expect(JSON.stringify(h)).not.toMatch(/Accord écrit fictif|Prolongation fictive|Super Admin facturation/);
  });

  it('Acceptation des conditions : seulement la version en vigueur, par la direction de tout l’établissement, tarif du jour figé', async () => {
    // Avant toute version en vigueur connue de ce test : un identifiant quelconque est refusé.
    const unknown = await school(S.A.direction).post('/settings/subscription/accept', { termsId: '00000000-0000-4000-8000-000000000000', accepted: true });
    expect(unknown.status).toBe(400);
    expect((await school(S.A.direction).post('/settings/subscription/accept', { termsId: '00000000-0000-4000-8000-000000000000', accepted: false })).status).toBe(400);
    expect((await school(S.A.comptable!).post('/settings/subscription/accept', { termsId: '00000000-0000-4000-8000-000000000000', accepted: true })).status).toBe(403);

    // Conditions fictives : une version future, puis une version en vigueur aujourd'hui.
    const body = 'Texte fictif publié par les tests automatiques du lot G5a. Ce ne sont pas les conditions commerciales de Cahiora.';
    expect((await pf.post('/billing/terms', { title: 'Conditions fictives (test)', body, effectiveFrom: addDays(today, -1), code: await code() })).status).toBe(400);
    const f = await pf.post('/billing/terms', { title: `Conditions fictives futures ${stamp}`, body, effectiveFrom: addDays(today, 1), code: await code() });
    expect(f.status).toBe(201);
    terms.future = f.body.id;
    const c = await pf.post('/billing/terms', { title: `Conditions fictives ${stamp}`, body, effectiveFrom: today, code: await code() });
    expect(c.status).toBe(201);
    terms.current = c.body.id;
    expect(c.body.version).toBe(f.body.version + 1);
    expect((await pf.get('/billing/terms')).body.current.id).toBe(terms.current);
    const v = (await school(S.A.direction).get('/settings/subscription')).body;
    expect(v.terms).toMatchObject({ id: terms.current, title: `Conditions fictives ${stamp}`, effectiveFrom: today });

    const future = await school(S.A.direction).post('/settings/subscription/accept', { termsId: terms.future, accepted: true });
    expect(future.status).toBe(400);
    expect(future.body.message).toMatch(/remplacées par une nouvelle version/);
    const ok = await school(S.A.direction).post('/settings/subscription/accept', { termsId: terms.current, accepted: true });
    expect(ok.status).toBe(201);
    expect(ok.body).toEqual({ status: 'AWAITING_PAYMENT', statusLabel: 'En attente de paiement' });
    expect((await school(S.A.direction).post('/settings/subscription/accept', { termsId: terms.current, accepted: true })).status).toBe(409);

    const s = (await subscriptionOf(S.A.id))!;
    expect(s).toMatchObject({ status: 'AWAITING_PAYMENT', acceptedTermsId: terms.current, acceptedByName: 'Fictif DIRECTION A' });
    expect(s.acceptedTariff).toEqual({ currency: 'XOF', pricePerPupil: 500, minimum: 40000, day: today });
    const accepted = (await eventsOf(S.A.id)).at(-1)!;
    expect(accepted).toMatchObject({ kind: 'TERMS_ACCEPTED', fromStatus: 'AWAITING_ACCEPTANCE', toStatus: 'AWAITING_PAYMENT', actorKind: 'school', actorId: S.A.directionId });
    expect(await admin.platformAuditLog.count({ where: { action: 'billing.terms_accepted', tenantId: S.A.id } })).toBe(1);
    expect(await admin.groupAuditLog.count({ where: { action: 'billing.terms_accepted', groupId: S.A.groupId } })).toBe(1);
    expect(await schoolJournal(S.A.id, 'billing.terms_accepted')).toHaveLength(1);
    // Un établissement sans abonnement n'a rien à accepter.
    expect((await school(S.C.direction).post('/settings/subscription/accept', { termsId: terms.current, accepted: true })).status).toBe(409);
  });

  it('Test 15 : un nouveau tarif a une date d’effet jamais passée et ne change ni le tarif du jour ni un tarif déjà accepté', async () => {
    const yesterday = addDays(today, -1);
    const later = addDays(today, 400);
    const add = async (o: object) => pf.post('/billing/parameters', { reason: 'Changement fictif (test)', code: await code(), ...o });
    expect((await add({ key: 'PRICE_PER_PUPIL', currency: 'XOF', value: 600, effectiveFrom: yesterday })).status).toBe(400);
    expect((await add({ key: 'PRICE_PER_PUPIL', currency: null, value: 600, effectiveFrom: later })).status).toBe(400);
    expect((await add({ key: 'TRIAL_DAYS', value: 0, effectiveFrom: later })).status).toBe(400);
    expect((await add({ key: 'INCONNU', value: 1, effectiveFrom: later })).status).toBe(400);
    expect((await add({ key: 'PRICE_PER_PUPIL', currency: 'XOF', value: 600, effectiveFrom: later })).status).toBe(201);

    const p = (await pf.get('/billing/parameters')).body;
    const price = p.current.find((x: { key: string; currency: string | null }) => x.key === 'PRICE_PER_PUPIL' && x.currency === 'XOF');
    expect(price.value).toBe(500);
    expect(price.next.effectiveFrom <= later).toBe(true);
    expect(p.history.some((h: { key: string; value: number; effectiveFrom: string }) => h.key === 'PRICE_PER_PUPIL' && h.value === 600 && h.effectiveFrom === later)).toBe(true);
    // Le même calcul que celui de la base, lu par le rôle des écoles (sans droit sur la table).
    const value = async (d: string) => (await appDb.$queryRaw<{ v: number | null }[]>`SELECT billing_parameter_value('PRICE_PER_PUPIL', 'XOF', ${d}::date) AS v`)[0].v;
    expect(await value(today)).toBe(500);
    expect(await value(later)).toBe(600);
    expect((await subscriptionOf(S.A.id))!.acceptedTariff).toMatchObject({ pricePerPupil: 500, minimum: 40000 });
    expect((await school(S.B.direction).get('/settings/subscription')).body.tariff).toEqual({ pricePerPupil: 500, minimum: 40000 });
    expect(await admin.platformAuditLog.count({ where: { action: 'billing.parameter_added', adminId: sa.id } })).toBe(1);
  });

  it('Test 6 : chaque établissement a son calendrier, en versions, sans jamais changer une date passée', async () => {
    const year = (start: string) => `${start.slice(0, 4)}-${Number(start.slice(0, 4)) + 1}`;
    const save = async (s: School, o: Record<string, string | null>) => pf.post(`/billing/establishments/${s.id}/calendars`, { reason: 'Calendrier fictif (test)', code: await code(), ...o });
    // A : formule B ; C : formule A, sur d'autres dates.
    const aStart = addDays(today, 30);
    const aEnd = addDays(today, 330);
    const a = await save(S.A, { yearLabel: year(aStart), startDate: aStart, endDate: aEnd, formula: 'B', ...proposeCalendar(aStart, aEnd, 'B') });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ version: 1, formula: 'B', ...proposeCalendar(aStart, aEnd, 'B') });
    const cStart = addDays(today, 60);
    const cEnd = addDays(today, 420);
    expect((await save(S.C, { yearLabel: year(aStart), startDate: cStart, endDate: cEnd, formula: 'A', ...proposeCalendar(cStart, cEnd, 'A') })).status).toBe(201);
    const ofA = (await school(S.A.direction).get('/settings/subscription')).body.calendars;
    const ofC = (await school(S.C.direction).get('/settings/subscription')).body.calendars;
    expect(ofA).toEqual([expect.objectContaining({ yearLabel: year(aStart), version: 1, startDate: aStart, endDate: aEnd, formula: 'B' })]);
    expect(ofC).toEqual([expect.objectContaining({ yearLabel: year(aStart), version: 1, startDate: cStart, endDate: cEnd, formula: 'A' })]);

    // Année passée de A : une date passée ne change plus ; une date à venir s'ajoute dans une nouvelle version.
    const pStart = addDays(today, -400);
    const pEnd = addDays(today, -60);
    const past = { yearLabel: year(pStart), startDate: pStart, endDate: pEnd, formula: 'B', ...proposeCalendar(pStart, pEnd, 'B') };
    expect((await save(S.A, past)).status).toBe(201);
    const retro = await save(S.A, { ...past, firstRegularizationDate: addDays(past.firstRegularizationDate, 1) });
    expect(retro.status).toBe(400);
    expect(JSON.stringify(retro.body.message)).toMatch(/est passé, cette date ne change plus/);
    expect((await save(S.A, past)).status).toBe(400); // aucune date ne change
    const renewal = await save(S.A, { ...past, formula: 'MANUEL', renewalDate: addDays(today, 30) });
    expect(renewal.status).toBe(201);
    expect(renewal.body.version).toBe(2);
    expect((await save(S.A, { ...past, endDate: addDays(pStart, -1) })).status).toBe(400);
    const versions = (await pf.get(`/billing/establishments/${S.A.id}/calendars`)).body.versions as { yearLabel: string; version: number }[];
    expect(versions.map((x) => [x.yearLabel, x.version])).toEqual([[year(aStart), 1], [year(pStart), 2], [year(pStart), 1]].sort((x, y) => String(y[0]).localeCompare(String(x[0])) || Number(y[1]) - Number(x[1])));
    expect(await admin.groupAuditLog.count({ where: { action: 'billing.calendar_saved', groupId: S.A.groupId } })).toBe(3);
    // Dates proposées depuis l'année scolaire de l'école (lue par la plateforme : dates seulement), formules A et B provisoires.
    await inTenant(S.C.id, (tx) => tx.academicYear.create({ data: { tenantId: S.C.id, label: year(cStart), startDate: new Date(`${cStart}T00:00:00Z`), endDate: new Date(`${cEnd}T00:00:00Z`), isCurrent: true } }));
    const proposals = (await pf.get(`/billing/establishments/${S.C.id}/calendars`)).body;
    expect(proposals.schoolYears).toEqual([{ label: year(cStart), startDate: cStart, endDate: cEnd, isCurrent: true, proposals: calendarProposals(cStart, cEnd) }]);
    expect(proposals.schoolYears[0].proposals.B).toEqual({ applies: true, message: null, ...proposeCalendar(cStart, cEnd, 'B') });
  });

  it('Correction C0 : dates proposées pour toute année et recalculées, version ajustée marquée avec son motif, année de 6 mois ou moins en dates saisies (CAL-1)', async () => {
    const proposals = (start: string, end: string, cookie?: string) => pf.get(`/billing/calendar-proposals?${new URLSearchParams({ startDate: start, endDate: end })}`, cookie);
    // N'importe quelle rentrée et n'importe quelle fin, sans année scolaire enregistrée par l'école ; recalcul quand la fin change.
    const sk = await proposals('2026-09-14', '2027-07-09');
    expect(sk.status).toBe(200);
    expect(sk.body).toEqual({ startDate: '2026-09-14', endDate: '2027-07-09', proposals: calendarProposals('2026-09-14', '2027-07-09') });
    expect(sk.body.proposals.B).toEqual({ applies: true, message: null, initialCountDate: '2026-11-30', firstRegularizationDate: '2027-04-30', finalRegularizationDate: '2027-07-09' });
    expect((await proposals('2026-09-14', '2027-08-14')).body.proposals.B).toMatchObject({ firstRegularizationDate: '2027-05-31', finalRegularizationDate: '2027-08-14' });
    const short = (await proposals('2027-02-01', '2027-07-31')).body.proposals;
    for (const f of ['A', 'B']) expect(short[f]).toMatchObject({ applies: false, initialCountDate: null, message: expect.stringMatching(/ne s’applique pas à une année de 6 mois ou moins/) });
    expect((await proposals('2027-07-31', '2027-02-01')).body.message).toBe('La fin de l’année doit suivre son début');
    expect((await proposals('2026-09-01', '2028-03-31')).body.message).toBe('Une année scolaire dure au plus 18 mois');
    expect((await pf.get('/billing/calendar-proposals?startDate=hier&endDate=2027-07-31')).status).toBe(400);
    expect((await pf.get('/billing/calendar-proposals')).status).toBe(400);
    // Super Admin seulement.
    expect((await proposals('2026-09-14', '2027-07-09', '')).status).toBe(401);
    expect((await school(S.B.direction).get('/platform/billing/calendar-proposals?startDate=2026-09-14&endDate=2027-07-09')).status).toBe(401);

    const save = async (o: Record<string, string | null>) => pf.post(`/billing/establishments/${S.B.id}/calendars`, { reason: 'Calendrier fictif (test C0)', code: await code(), ...o });
    // Formule B dont la première régularisation est avancée de 10 jours : enregistrée « formule B », marquée ajustée, motif journalisé.
    const start = addDays(today, 40);
    const end = addDays(today, 340);
    const label = `${start.slice(0, 4)}-${Number(start.slice(0, 4)) + 1}`;
    const p = proposeCalendar(start, end, 'B');
    const adjusted = await save({ yearLabel: label, startDate: start, endDate: end, formula: 'B', ...p, firstRegularizationDate: addDays(p.firstRegularizationDate, -10), reason: 'Ajustée pour les congés (test C0)' });
    expect(adjusted.status).toBe(201);
    expect(adjusted.body).toMatchObject({ version: 1, formula: 'B', adjusted: true, reason: 'Ajustée pour les congés (test C0)' });
    const logged = await admin.platformAuditLog.findFirstOrThrow({ where: { action: 'billing.calendar_saved', tenantId: S.B.id }, orderBy: { createdAt: 'desc' } });
    expect(logged.data).toMatchObject({ version: 1, formula: 'B', adjusted: true, reason: 'Ajustée pour les congés (test C0)' });
    // Retour aux dates de la formule : nouvelle version, plus ajustée ; la liste des établissements montre la dernière.
    const back = await save({ yearLabel: label, startDate: start, endDate: end, formula: 'B', ...p });
    expect(back.body).toMatchObject({ version: 2, formula: 'B', adjusted: false });
    const listed = ((await pf.get('/billing/establishments')).body as { id: string; calendars: { version: number; adjusted: boolean }[] }[]).find((x) => x.id === S.B.id)!;
    expect(listed.calendars).toEqual([expect.objectContaining({ version: 2, adjusted: false })]);
    const versions = (await pf.get(`/billing/establishments/${S.B.id}/calendars`)).body.versions as { version: number; adjusted: boolean }[];
    expect(versions.map((v) => [v.version, v.adjusted])).toEqual([[2, false], [1, true]]);

    // Année de 6 mois (du 1er du mois au dernier jour du 6e mois) : formules A et B refusées, avant même le code ; dates saisies acceptées.
    const [y, m] = addDays(today, 60).split('-').map(Number);
    const sStart = `${y}-${String(m).padStart(2, '0')}-01`;
    const sEnd = lastDayOfMonth(y, m - 1 + 5);
    const sixMonths = { yearLabel: String(y), startDate: sStart, endDate: sEnd, initialCountDate: addDays(sStart, 30), firstRegularizationDate: addDays(sStart, 100), finalRegularizationDate: sEnd };
    for (const formula of ['B', 'A']) {
      const refused = await pf.post(`/billing/establishments/${S.B.id}/calendars`, { ...sixMonths, formula, reason: 'Session courte (test C0)', code: '000000' });
      expect(refused.status).toBe(400);
      expect(refused.body.message).toBe(`La formule ${formula} ne s’applique pas à une année de 6 mois ou moins (du mois de la rentrée au mois de la fin) : choisissez « Dates saisies à la main » et indiquez le motif`);
    }
    expect(await admin.platformAuditLog.count({ where: { action: 'billing.2fa_failed', adminId: sa.id, createdAt: { gte: logged.createdAt } } })).toBe(0);
    const manual = await save({ ...sixMonths, formula: 'MANUEL', reason: 'Session courte : dates de la direction (test C0)' });
    expect(manual.status).toBe(201);
    expect(manual.body).toMatchObject({ version: 1, formula: 'MANUEL', adjusted: false });
  });

  it('Test 23 : les écoles, les groupes et les statistiques n’ont aucun droit sur les tables de la facturation ; chaque direction ne voit que son établissement', async () => {
    for (const t of TABLES) {
      for (const db of [appDb, groupDb, statsDb]) await expect(db.$queryRawUnsafe(`SELECT count(*) FROM ${t}`)).rejects.toThrow(/permission denied/);
    }
    // Les fonctions de la base ne rendent que l'abonnement de l'école courante.
    expect(await appDb.$queryRaw`SELECT * FROM current_tenant_subscription()`).toEqual([]);
    expect(await inTenant(S.C.id, (tx) => tx.$queryRaw`SELECT * FROM current_tenant_subscription()`, appDb)).toEqual([]);
    const own = await inTenant(S.A.id, (tx) => tx.$queryRaw<{ status: string }[]>`SELECT status FROM current_tenant_subscription()`, appDb);
    expect(own).toEqual([{ status: 'AWAITING_PAYMENT' }]);
    const events = await inTenant(S.B.id, (tx) => tx.$queryRaw<Record<string, unknown>[]>`SELECT * FROM current_tenant_subscription_events()`, appDb);
    expect(events).toHaveLength(4);
    expect(Object.keys(events[0]).sort()).toEqual(['actor_kind', 'actor_name', 'created_at', 'data', 'from_status', 'kind', 'to_status']);
    expect(new Set(events.map((e) => e.actor_name))).toEqual(new Set(['Cahiora']));
    // Ni le groupe ni les statistiques n'appellent ces fonctions.
    await expect(groupDb.$queryRaw`SELECT * FROM current_tenant_subscription()`).rejects.toThrow(/permission denied/);
    await expect(statsDb.$queryRaw`SELECT billing_parameter_value('PRICE_PER_PUPIL', 'XOF', CURRENT_DATE)`).rejects.toThrow(/permission denied/);
    // La direction d'une école n'accepte pas pour une autre, même par requête directe.
    await expect(inTenant(S.C.id, (tx) => tx.$queryRaw`SELECT accept_commercial_terms(${terms.current}::uuid, ${S.B.directionId}::uuid, 'Intrus', NULL, ${today}::date)`, appDb))
      .rejects.toThrow(/seule la direction de tout l'établissement/);
    await expect(inTenant(S.B.id, (tx) => tx.$queryRaw`SELECT accept_commercial_terms(${terms.current}::uuid, ${S.A.directionId}::uuid, 'Intrus', NULL, ${today}::date)`, appDb))
      .rejects.toThrow(/seule la direction de tout l'établissement/);
    expect((await subscriptionOf(S.B.id))!.status).toBe('AWAITING_ACCEPTANCE');
    // Par l'API : C ne voit ni l'abonnement ni l'historique de A.
    const c = (await school(S.C.direction).get('/settings/subscription')).body;
    expect(c.subscription).toBeNull();
    expect(c.history).toEqual([]);
  });

  it('Ajout seul : ni le propriétaire de la base ni la plateforme ne modifient ou n’effacent l’historique, les tarifs, les conditions ou les tâches', async () => {
    const refused = (sql: string) => expect(admin.$executeRawUnsafe(sql)).rejects.toThrow();
    const A = S.A.id;
    await refused(`UPDATE subscription_events SET kind = 'X' WHERE tenant_id = '${A}'`);
    await refused(`DELETE FROM subscription_events WHERE tenant_id = '${A}'`);
    await refused(`UPDATE billing_parameters SET value = 1 WHERE key = 'PRICE_PER_PUPIL'`);
    await refused(`DELETE FROM billing_parameters WHERE key = 'PRICE_PER_PUPIL'`);
    await refused(`UPDATE commercial_terms SET body = 'X' WHERE id = '${terms.current}'`);
    await refused(`DELETE FROM commercial_terms WHERE id = '${terms.current}'`);
    await refused(`UPDATE billing_calendars SET "endDate" = "endDate" + 1 WHERE tenant_id = '${A}'`);
    await refused(`DELETE FROM billing_jobs WHERE tenant_id = '${A}'`);
    await refused(`DELETE FROM subscriptions WHERE tenant_id = '${A}'`);
    await refused(`UPDATE subscriptions SET tenant_id = '${S.C.id}' WHERE tenant_id = '${A}'`);
    await refused(`DELETE FROM platform_alerts WHERE tenant_id = '${A}'`);
    await refused(`UPDATE platform_alerts SET message = 'X' WHERE tenant_id = '${A}'`);
    for (const t of TABLES) await refused(`TRUNCATE ${t} CASCADE`);
    // Ouverture, fin de l'essai, demande de régularisation (lot G5d-1) et acceptation.
    expect(await admin.subscriptionEvent.count({ where: { tenantId: A } })).toBe(4);
    // Seule la lecture d'une alerte se note, une fois.
    const alert = await admin.platformAlert.findFirstOrThrow({ where: { tenantId: A } });
    expect((await pf.post(`/billing/alerts/${alert.id}/read`)).body).toEqual({ ok: true });
    expect((await pf.post(`/billing/alerts/${alert.id}/read`)).body).toEqual({ ok: false });
    expect((await admin.platformAlert.findUniqueOrThrow({ where: { id: alert.id } })).readById).toBe(sa.id);
  });

  it('Vue d’ensemble du Super Admin : états par établissement, montants absents tant que les documents et les paiements n’existent pas', async () => {
    const o = (await pf.get('/billing/overview')).body;
    expect(o.counts.establishments).toBeGreaterThanOrEqual(3);
    expect(o.counts.AWAITING_PAYMENT).toBeGreaterThanOrEqual(1);
    expect(o.counts.AWAITING_ACCEPTANCE).toBeGreaterThanOrEqual(1);
    expect(Object.values(o.amounts)).toEqual([null, null, null, null, null, null, null]);
    const list = (await pf.get('/billing/establishments')).body as { id: string; subscription: { status: string; acceptedTariff: unknown } | null; group: { id: string } }[];
    const byId = new Map(list.map((e) => [e.id, e]));
    expect(byId.get(S.A.id)!.subscription).toMatchObject({ status: 'AWAITING_PAYMENT', acceptedTariff: { pricePerPupil: 500 } });
    expect(byId.get(S.B.id)!.subscription!.status).toBe('AWAITING_ACCEPTANCE');
    expect(byId.get(S.C.id)!.subscription).toBeNull();
    expect(byId.get(S.A.id)!.group.id).toBe(S.A.groupId);
    const ev = (await pf.get(`/billing/establishments/${S.B.id}/events`)).body as { kind: string; reason: string | null; actorName: string }[];
    expect(ev.find((e) => e.kind === 'PILOT_OPENED')).toMatchObject({ reason: 'Accord écrit fictif avec la direction (test)', actorName: sa.name });
  });
});
