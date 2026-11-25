/**
 * Lot G5d-1 de la facturation de Cahiora (accès selon le paiement), de bout en bout sur la base de test (erp_test),
 * avec des établissements, des comptes et des conditions commerciales entièrement fictifs créés pour ce fichier.
 * Décisions de Dankou du 19 novembre 2026 : D-G5-30 A (essai de 14 jours, rappels J11/J13/J14, 15 jours de grâce en
 * accès complet, puis accès limité sans rien supprimer), D-G5-41 A (rappels pendant la grâce), D-G5-42 A (une demande
 * de régularisation en attente retient la limitation), D-G5-43 A (prolongation avec une date de fin et un motif).
 * Lectures 7 A et 9 A validées par Dankou le 20 novembre 2026 : préavis de 48 heures après la réponse de Cahiora, une
 * fois par échéance ; prolongation de 30 jours au plus, renouvellements exceptionnels motivés et marqués.
 * Les passages de la tâche planifiée sont simulés jour par jour : J1 est le jour d'ouverture de l'essai (aujourd'hui).
 * Aucun paiement, aucun SMS, aucune facture.
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
import { frDateTime, LIMITED_REFUSAL } from '../src/modules/billing/access-rules';
import { BillingJobsService } from '../src/modules/billing/billing-jobs';
import { addDays, frDay } from '../src/modules/billing/billing-rules';
import { PlatformDb } from '../src/modules/platform/platform';

const TZ = 'Africa/Porto-Novo';
const PASSWORD = 'Acces-G5d1-2026';
const SA_PASSWORD = 'Plateforme-G5d1-2026';
const stamp = Date.now().toString(36);
const UUID = '00000000-0000-4000-8000-000000000000';
const REQ = '/settings/subscription/regularization-requests';

let app: INestApplication;
let http: ReturnType<typeof request>;
const admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_ADMIN_URL } } });
const appDb = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
const platformDb = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_PLATFORM_URL } } });
const groupDb = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_GROUP_URL } } });
const statsDb = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_STATS_URL } } });

type School = { id: string; slug: string; name: string; groupId: string; direction: string; directionId: string; comptable: string; parent: string };
const S: Record<'A' | 'B' | 'C' | 'D' | 'E', School> = {} as never;
const sa = { id: '', name: 'Super Admin accès (fictif)', email: `g5d1-${stamp}@test.local`, cookie: '', secret: '' };
const today = localDay(TZ);
/** Jour n de l'essai : J1 est aujourd'hui. */
const J = (n: number) => addDays(today, n - 1);
/** Midi à Porto-Novo, le jour donné. */
const at = (d: string) => new Date(`${d}T11:00:00.000Z`);
const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const mine = (done: string[], s: School) => done.filter((d) => d.endsWith(`:${s.name}`));
let termsId = '';

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
  get: (url: string) => http.get(`/api/v1/platform${url}`).set('Cookie', sa.cookie),
  post: (url: string, body: object = {}) => http.post(`/api/v1/platform${url}`).set('Cookie', sa.cookie).send(body),
};
const school = (token: string) => ({
  get: (url: string) => http.get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
  post: (url: string, body: object = {}) => http.post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body),
  patch: (url: string, body: object = {}) => http.patch(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body),
});

async function login(s: { slug: string }, phone: string) {
  const r = await http.post('/api/v1/auth/login').send({ tenant: s.slug, identifier: phone, password: PASSWORD });
  expect(r.status).toBe(200);
  return r.body.accessToken as string;
}

/** Établissement fictif, seul dans son groupe : direction de tout l'établissement, comptable et parent. */
async function newSchool(k: 'A' | 'B' | 'C' | 'D' | 'E'): Promise<School> {
  const t = await admin.tenant.create({
    data: { commercialStatus: 'CLIENT', slug: `g5d1-${k.toLowerCase()}-${stamp}`, name: `École fictive G5d-1 ${k} ${stamp}`, group: { create: { name: `Groupe fictif G5d-1 ${k} ${stamp}` } } },
  });
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const directionId = await inTenant(t.id, async (tx) => {
    const add = async (phone: string, role: 'DIRECTION' | 'COMPTABLE' | 'PARENT', last: string) => {
      const u = await tx.user.create({ data: { tenantId: t.id, phone, firstName: 'Fictif', lastName: last, passwordHash: hash, mustChangePassword: false } });
      await tx.userRole.create({ data: { tenantId: t.id, userId: u.id, role } });
      return u.id;
    };
    const id = await add('+2290190007001', 'DIRECTION', `DIRECTION ${k}`);
    await add('+2290190007002', 'COMPTABLE', `COMPTABLE ${k}`);
    await add('+2290190007003', 'PARENT', `PARENT ${k}`);
    await tx.academicYear.create({ data: { tenantId: t.id, label: '2026-2027', startDate: new Date('2026-09-14'), endDate: new Date('2027-07-31'), isCurrent: true } });
    return id;
  });
  const s = { id: t.id, slug: t.slug, name: t.name, groupId: t.groupId, directionId };
  return { ...s, direction: await login(s, '+2290190007001'), comptable: await login(s, '+2290190007002'), parent: await login(s, '+2290190007003') };
}

const subscriptionOf = (tenantId: string) => admin.subscription.findUniqueOrThrow({ where: { tenantId } });
const eventsOf = (tenantId: string) => admin.subscriptionEvent.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } });
const notificationsOf = (tenantId: string) => inTenant(tenantId, (tx) => tx.notification.findMany({ orderBy: { createdAt: 'asc' } }));
const schoolJournal = (tenantId: string, action: string) => inTenant(tenantId, (tx) => tx.auditLog.findMany({ where: { action } }));
const run = async (d: string) => (await app.get(BillingJobsService).runDue(at(d))).done;

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  configureApp(app);
  await app.init();
  http = request(app.getHttpServer());

  S.A = await newSchool('A');
  S.B = await newSchool('B');
  S.C = await newSchool('C');
  S.D = await newSchool('D');
  S.E = await newSchool('E');

  // Super Admin fictif avec double authentification.
  await admin.platformAdmin.create({ data: { email: sa.email, name: sa.name, passwordHash: await argon2.hash(SA_PASSWORD), mustChangePassword: false, mustSetupTwoFactor: false } });
  sa.id = (await admin.platformAdmin.findUniqueOrThrow({ where: { email: sa.email } })).id;
  sa.cookie = cookieOf(await http.post('/api/v1/platform/auth/login').send({ email: sa.email, password: SA_PASSWORD }).expect(201));
  const setup = await pf.post('/auth/2fa/setup').expect(201);
  sa.secret = setup.body.secret;
  await pf.post('/auth/2fa/enable', { code: await code(), setupToken: setup.body.setupToken }).expect(201);

  // Essais de 14 jours ouverts aujourd'hui (J1) pour A et B ; C devient école pilote tout de suite ; D n'a pas d'abonnement.
  for (const s of [S.A, S.B, S.C]) await pf.post(`/billing/establishments/${s.id}/trial`, { startDate: today, code: await code() }).expect(201);
  await pf.post(`/billing/establishments/${S.C.id}/pilot`, { startDate: today, reason: 'Accord fictif de pilote (test G5d-1)', code: await code() }).expect(201);
}, 60000);

afterAll(async () => {
  await app?.close();
  await admin.platformAdmin.deleteMany({ where: { email: sa.email } });
  await Promise.all([admin.$disconnect(), appDb.$disconnect(), platformDb.$disconnect(), groupDb.$disconnect(), statsDb.$disconnect()]);
});

describe('Lot G5d-1 · accès selon le paiement : rappels, délai de grâce, accès limité, demandes et prolongations (données fictives)', () => {
  it('rappels de l’essai aux 11e, 13e et 14e jours, une seule fois chacun, pour la direction seulement ; rien pour un pilote', async () => {
    expect(mine(await run(J(10)), S.A)).toEqual([]);
    const j11 = await run(J(11));
    expect(mine(j11, S.A)).toEqual([`trial-reminder-3:${S.A.name}`]);
    expect(mine(j11, S.B)).toEqual([`trial-reminder-3:${S.B.name}`]);
    // Le pilote garde ses alertes à 30 et 7 jours (D-G5-38) : pas de rappels de l'essai.
    expect(mine(j11, S.C)).toEqual([]);
    expect(mine(await run(J(11)), S.A)).toEqual([]);
    expect(mine(await run(J(12)), S.A)).toEqual([]);
    // Deux passages en même temps (deux serveurs) : un seul rappel.
    const twin = [new BillingJobsService(app.get(PlatformDb)), new BillingJobsService(app.get(PlatformDb))];
    const both = await Promise.all(twin.map((j) => j.runDue(at(J(13)))));
    expect(mine(both.flatMap((r) => r.done), S.A)).toEqual([`trial-reminder-1:${S.A.name}`]);
    expect(mine(await run(J(14)), S.A)).toEqual([`trial-reminder-0:${S.A.name}`]);
    expect((await subscriptionOf(S.A.id)).status).toBe('TRIAL');

    const notes = await notificationsOf(S.A.id);
    expect(notes.map((n) => [n.kind, n.channel, n.userId])).toEqual(Array(3).fill(['billing.trial_reminder', 'IN_APP', S.A.directionId]));
    expect(notes.map((n) => n.title)).toEqual(['Votre essai de Cahiora se termine dans 3 jours', 'Votre essai de Cahiora se termine demain', 'Dernier jour de votre essai de Cahiora']);
    expect(notes[0].body).toContain(`Votre essai gratuit se termine dans 3 jours, le ${frDay(J(14))} (dernier jour gratuit).`);
    expect(notes[1].body).toContain(`se termine demain, le ${frDay(J(14))}`);
    expect(notes[2].body).toContain(`se termine aujourd’hui, le ${frDay(J(14))}`);
    expect(notes[0].body).toContain('pendant 15 jours de grâce');
    expect(await schoolJournal(S.A.id, 'billing.trial_reminder')).toHaveLength(3);
    expect(await admin.platformAuditLog.count({ where: { action: 'billing.trial_reminder', tenantId: S.A.id } })).toBe(3);
    expect(await admin.groupAuditLog.count({ where: { action: 'billing.trial_reminder', groupId: S.A.groupId } })).toBe(3);
    // Aucun SMS.
    expect(await inTenant(S.A.id, (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM sms_messages`)).toEqual([{ n: 0 }]);
  });

  it('fin de l’essai : 15 jours de grâce en accès complet, du lendemain du dernier jour gratuit (jours 15 à 29) ; la direction le lit', async () => {
    const done = await run(J(15));
    expect(mine(done, S.A)).toEqual([`trial-end:${S.A.name}`]);
    expect(mine(done, S.B)).toEqual([`trial-end:${S.B.name}`]);
    const s = await subscriptionOf(S.A.id);
    expect(s).toMatchObject({ status: 'AWAITING_ACCEPTANCE', extendedUntil: null, limitedSince: null });
    expect([iso(s.graceStart), iso(s.graceEnd)]).toEqual([J(15), J(29)]);
    const ended = (await eventsOf(S.A.id)).find((e) => e.kind === 'TRIAL_ENDED')!;
    expect(ended.data).toEqual({ lastFreeDay: J(14), graceDays: 15, graceStart: J(15), graceEnd: J(29) });
    const alert = await admin.platformAlert.findFirstOrThrow({ where: { tenantId: S.A.id, kind: 'TRIAL_ENDED' } });
    expect(alert.message).toContain(`Délai de grâce en accès complet jusqu'au ${frDay(J(29))} ; sans paiement validé ni demande de régularisation en attente, accès limité à partir du ${frDay(J(30))}.`);
    const note = (await notificationsOf(S.A.id)).find((n) => n.kind === 'billing.trial_ended')!;
    expect(note.body).toContain(`Vous gardez l’accès complet jusqu’au ${frDay(J(29))} inclus (délai de grâce de 15 jours)`);

    // Accès complet : une saisie ordinaire passe le contrôle (seule la validation répond).
    expect((await school(S.A.direction).post('/students', {})).status).toBe(400);
    // Ce que lit l'écran (bandeau, alerte, compteur), au jour réel de l'établissement.
    const me = (await school(S.A.direction).get('/auth/me')).body;
    expect(me.access).toEqual({
      status: 'AWAITING_ACCEPTANCE', statusLabel: 'En attente d’acceptation des conditions', phase: 'GRACE', until: J(29), daysLeft: 29, limitedFrom: J(30),
      limitedAt: null, limitedAtLabel: null, hoursLeft: null, pendingRequest: false, termsAccepted: false, direction: true, canRegularize: true,
    });
    expect((await school(S.A.comptable).get('/auth/me')).body.access).toMatchObject({ phase: 'GRACE', direction: false, canRegularize: false });
    // Une famille n'a jamais affaire à l'abonnement de l'établissement.
    expect((await school(S.A.parent).get('/auth/me')).body.access).toBeNull();
    const v = (await school(S.A.direction).get('/settings/subscription')).body;
    expect(v.access).toMatchObject({ phase: 'GRACE', graceStart: J(15), graceEnd: J(29), paymentMeansActive: false });
    expect(v.regularization).toEqual({
      currency: 'XOF', groupPending: null, documents: 0, requested: null, dueDate: null, dueDatePending: false, dueDateNote: null, lines: [],
      mention: 'Document provisoire, sans valeur fiscale : ce n’est pas une facture.',
      payment: 'Aucun paiement validé par Cahiora pour le moment.', paymentMeans: [],
      paymentMeansNote: 'Aucun moyen de paiement n’est encore activé par Cahiora : envoyez une demande de régularisation, Cahiora vous répondra.',
      // Lot G5d-2, verrou 1 fermé : ni moyen de paiement, ni remboursement ; reçus et crédit vides.
      paid: 0, balance: null, paymentsOpen: false, receiptMention: 'Reçu provisoire, sans valeur fiscale.', receipts: [],
      credit: { balance: 0, reserved: 0, available: 0, entries: [] }, refunds: [], refundOpen: false,
      refundNote: 'Les remboursements ne sont pas encore ouverts par Cahiora : votre crédit disponible est déduit de votre prochain document.',
    });
  });

  it('demande de régularisation (D-G5-42 A) : direction de tout l’établissement, horodatée et journalisée, une seule à la fois', async () => {
    const none = await school(S.D.direction).post(REQ, {});
    expect([none.status, none.body.message]).toEqual([409, 'Aucun abonnement n’est encore ouvert pour votre établissement']);
    const pilot = await school(S.C.direction).post(REQ, {});
    expect([pilot.status, pilot.body.message]).toEqual([409, 'Votre abonnement n’attend pas de régularisation (état : École pilote partenaire CAHIORA)']);
    expect((await school(S.B.comptable).post(REQ, {})).status).toBe(403);
    expect((await school(S.B.direction).post(REQ, { message: 'x'.repeat(1001) })).status).toBe(400);

    const before = Date.now();
    const r = await school(S.B.direction).post(REQ, { message: '  Nous réglerons par virement fictif (test).  ' });
    expect(r.status).toBe(201);
    expect(r.body.requests).toEqual([{
      id: r.body.id, status: 'PENDING', message: 'Nous réglerons par virement fictif (test).', requestedByName: 'Fictif DIRECTION B', requestedAt: expect.any(String),
      answeredAt: null, answer: null,
    }]);
    expect(new Date(r.body.requests[0].requestedAt).getTime()).toBeGreaterThanOrEqual(before - 2000);
    expect(r.body.access).toMatchObject({ phase: 'GRACE', pendingRequest: true });
    const again = await school(S.B.direction).post(REQ, {});
    expect([again.status, again.body.message]).toEqual([409, 'Une demande de régularisation attend déjà la réponse de Cahiora']);

    const row = await admin.regularizationRequest.findFirstOrThrow({ where: { tenantId: S.B.id } });
    expect(row).toMatchObject({ id: r.body.id, status: 'PENDING', subscriptionStatus: 'AWAITING_ACCEPTANCE', requestedById: S.B.directionId, requestedByName: 'Fictif DIRECTION B' });
    expect((await eventsOf(S.B.id)).at(-1)).toMatchObject({
      kind: 'REGULARIZATION_REQUESTED', fromStatus: 'AWAITING_ACCEPTANCE', toStatus: 'AWAITING_ACCEPTANCE', actorKind: 'school', actorId: S.B.directionId, data: { requestId: row.id },
    });
    const alert = await admin.platformAlert.findFirstOrThrow({ where: { tenantId: S.B.id, kind: 'REGULARIZATION_REQUEST' } });
    expect(alert.message).toBe(`${S.B.name} demande à régulariser son abonnement (demande de Fictif DIRECTION B). Répondez dans Commercial et facturation › Accès des clients.`);
    expect(await admin.platformAuditLog.count({ where: { tenantId: S.B.id, action: 'billing.regularization_requested' } })).toBe(1);
    expect(await admin.groupAuditLog.count({ where: { groupId: S.B.groupId, action: 'billing.regularization_requested' } })).toBe(1);
    expect(await schoolJournal(S.B.id, 'billing.regularization_requested')).toHaveLength(1);
    // Le Super Admin voit la demande dans l'accès des clients.
    const o = (await pf.get('/billing/access')).body;
    expect(o.paymentMeansActive).toBe(false);
    expect(o.clients.find((c: { tenantId: string }) => c.tenantId === S.B.id)).toMatchObject({
      status: 'AWAITING_ACCEPTANCE', phase: 'GRACE', pendingRequest: { id: row.id, requestedByName: 'Fictif DIRECTION B', message: 'Nous réglerons par virement fictif (test).' },
    });
    expect(o.requests.find((x: { id: string }) => x.id === row.id)).toMatchObject({ status: 'PENDING', tenantName: S.B.name, subscriptionStatusLabel: 'En attente d’acceptation des conditions' });
  });

  it('rappels pendant la grâce : 3 jours avant sa fin, la veille et le dernier jour ; la demande en attente y est rappelée', async () => {
    expect(mine(await run(J(25)), S.A)).toEqual([]);
    const j26 = await run(J(26));
    expect(mine(j26, S.A)).toEqual([`grace-reminder-3:${S.A.name}`]);
    expect(mine(j26, S.B)).toEqual([`grace-reminder-3:${S.B.name}`]);
    expect(mine(await run(J(27)), S.A)).toEqual([]);
    expect(mine(await run(J(28)), S.A)).toEqual([`grace-reminder-1:${S.A.name}`]);
    expect(mine(await run(J(29)), S.A)).toEqual([`grace-reminder-0:${S.A.name}`]);
    expect((await subscriptionOf(S.A.id)).status).toBe('AWAITING_ACCEPTANCE');
    const a = (await notificationsOf(S.A.id)).filter((n) => n.kind === 'billing.grace_reminder');
    expect(a.map((n) => n.title)).toEqual(['Régularisez votre abonnement Cahiora', 'Régularisez votre abonnement Cahiora', 'Dernier jour d’accès complet à Cahiora']);
    expect(a[0].body).toBe(
      `Le délai de grâce prend fin dans 3 jours, le ${frDay(J(29))} : c’est le dernier jour d’accès complet. Ensuite, sans paiement validé, l’accès sera limité : `
      + 'consultation, impression, export, caisse et régularisation restent possibles, et aucune donnée n’est supprimée. Ouvrez Paramètres › Abonnement Cahiora et choisissez « Régulariser mon abonnement ».',
    );
    const b = (await notificationsOf(S.B.id)).filter((n) => n.kind === 'billing.grace_reminder');
    expect(b[0].body).toContain('Votre demande de régularisation attend la réponse de Cahiora : tant qu’elle attend, l’accès ne sera pas limité.');
  });

  it('jour 30 sans paiement validé : accès limité une seule fois, sans rien supprimer ; la demande en attente retient la limitation (D-G5-42 A)', async () => {
    const users = await inTenant(S.A.id, (tx) => tx.user.count());
    const j30 = await run(J(30));
    expect(mine(j30, S.A)).toEqual([`access-limited:${S.A.name}`]);
    expect(mine(j30, S.B)).toEqual([]);
    expect(mine(await run(J(31)), S.A)).toEqual([]);
    const s = await subscriptionOf(S.A.id);
    expect(s.status).toBe('LIMITED');
    expect(s.limitedSince).not.toBeNull();
    expect((await subscriptionOf(S.B.id)).status).toBe('AWAITING_ACCEPTANCE');
    expect((await eventsOf(S.A.id)).at(-1)).toMatchObject({
      kind: 'ACCESS_LIMITED', fromStatus: 'AWAITING_ACCEPTANCE', toStatus: 'LIMITED', actorKind: 'system', data: { lastFullAccessDay: J(29), graceEnd: J(29), extendedUntil: null },
    });
    const alert = await admin.platformAlert.findFirstOrThrow({ where: { tenantId: S.A.id, kind: 'ACCESS_LIMITED' } });
    expect(alert.message).toContain(`accès complet jusqu'au ${frDay(J(29))}, sans paiement validé ni demande de régularisation en attente`);
    expect(await schoolJournal(S.A.id, 'billing.access_limited')).toHaveLength(1);
    expect(await admin.groupAuditLog.count({ where: { groupId: S.A.groupId, action: 'billing.access_limited' } })).toBe(1);
    expect((await notificationsOf(S.A.id)).at(-1)).toMatchObject({ kind: 'billing.access_limited', title: 'Accès limité à Cahiora' });
    expect(await inTenant(S.A.id, (tx) => tx.user.count())).toBe(users);
    // Tout le personnel lit l'accès limité (bandeau) ; la direction garde son bouton.
    expect((await school(S.A.comptable).get('/auth/me')).body.access).toMatchObject({ status: 'LIMITED', phase: 'LIMITED', statusLabel: 'Accès limité' });
    expect((await school(S.A.direction).get('/auth/me')).body.access).toMatchObject({ phase: 'LIMITED', canRegularize: true });
  });

  it('accès limité : lectures, caisse, impression, sécurité des comptes et régularisation restent ouvertes ; toute autre saisie est refusée avec son motif', async () => {
    const A = S.A;
    expect((await school(A.direction).get('/settings/subscription')).status).toBe(200);
    // Consultation et export : les élèves, la caisse et son export, les notifications.
    expect((await school(A.comptable).get('/students')).status).toBe(200);
    expect((await school(A.comptable).get('/finance/payments')).status).toBe(200);
    expect((await school(A.comptable).get('/finance/payments/export.csv')).status).toBe(200);
    expect((await school(A.comptable).get('/notifications')).status).toBe(200);
    // Le contrôle passe avant la validation : refus avec le motif pour le personnel.
    const refused = await school(A.direction).post('/students', {});
    expect([refused.status, refused.body.message]).toEqual([403, LIMITED_REFUSAL.staff]);
    expect((await school(A.comptable).post('/finance/invoices', {})).status).toBe(403);
    // Une famille lit seulement de contacter l'établissement, sans un mot de l'abonnement.
    const fam = await school(A.parent).post(`/attendance/records/${UUID}/justify`, {});
    expect([fam.status, fam.body.message]).toEqual([403, LIMITED_REFUSAL.family]);
    expect(JSON.stringify(fam.body)).not.toMatch(/abonnement|Cahiora/);
    // Routes encore ouvertes : c'est la validation ou la recherche qui répond, jamais le contrôle de l'accès.
    const open: [string, 'post' | 'patch', string, object][] = [
      [A.comptable, 'post', '/finance/payments/desk', {}],
      [A.comptable, 'post', '/finance/cash-closings', {}],
      [A.comptable, 'post', '/finance/reminders', {}],
      [A.direction, 'post', '/documents', {}],
      [A.direction, 'post', REQ, { message: 'x'.repeat(1001) }],
      [A.direction, 'post', `/users/${UUID}/reset-password`, {}],
      [A.direction, 'patch', `/staff/${UUID}`, { active: false }],
      [A.direction, 'post', '/auth/2fa/setup', {}],
      [A.comptable, 'post', `/notifications/${UUID}/read`, {}],
    ];
    for (const [token, method, url, body] of open) {
      const r = await school(token)[method](url, body);
      expect([url, r.status === 403 && JSON.stringify(r.body).includes('Accès limité')]).toEqual([url, false]);
    }
    // Fiche du personnel : seule la désactivation passe.
    expect((await school(A.direction).patch(`/staff/${UUID}`, { firstName: 'Autre' })).status).toBe(403);
    expect((await school(A.direction).patch(`/staff/${UUID}`, { active: false, firstName: 'Autre' })).status).toBe(403);
    // Chaque refus est tracé dans le journal de l'école.
    const log = await inTenant(A.id, (tx) => tx.auditLog.findFirst({ where: { action: 'access.denied', userId: A.directionId }, orderBy: { createdAt: 'desc' } }));
    expect(JSON.stringify(log?.data)).toContain('accès limité : abonnement non régularisé (D-G5-30 A)');
    // Une autre école n'est pas touchée.
    expect((await school(S.B.direction).post('/students', {})).status).toBe(400);
  });

  it('conditions acceptées pendant l’accès limité : tarif figé, l’accès reste limité (seul un paiement validé ou une prolongation le rend complet)', async () => {
    const body = 'Texte fictif publié par les tests automatiques du lot G5d-1. Ce ne sont pas les conditions commerciales de Cahiora.';
    const t = await pf.post('/billing/terms', { title: `Conditions fictives G5d-1 ${stamp}`, body, effectiveFrom: today, definitive: true, code: await code() });
    expect(t.status).toBe(201);
    termsId = t.body.id;
    const since = (await subscriptionOf(S.A.id)).statusSince;
    expect((await school(S.A.direction).get('/settings/subscription')).body.terms).toMatchObject({ id: termsId });
    const ok = await school(S.A.direction).post('/settings/subscription/accept', { termsId, accepted: true });
    expect([ok.status, ok.body]).toEqual([201, { status: 'LIMITED', statusLabel: 'Accès limité' }]);
    expect((await school(S.A.direction).post('/settings/subscription/accept', { termsId, accepted: true })).status).toBe(409);
    const s = await subscriptionOf(S.A.id);
    expect(s).toMatchObject({ status: 'LIMITED', acceptedTermsId: termsId, acceptedByName: 'Fictif DIRECTION A', statusSince: since });
    expect(s.acceptedTariff).toEqual({ currency: 'XOF', pricePerPupil: 500, minimum: 40000, day: today });
    expect((await eventsOf(S.A.id)).at(-1)).toMatchObject({ kind: 'TERMS_ACCEPTED', fromStatus: 'LIMITED', toStatus: 'LIMITED', actorKind: 'school' });
    expect((await school(S.A.direction).post('/students', {})).status).toBe(403);
    expect((await school(S.A.direction).get('/auth/me')).body.access).toMatchObject({ phase: 'LIMITED', termsAccepted: true });
  });

  it('réponse de Cahiora à la demande, code exigé, une seule fois, signée « Cahiora » : la demande ne retient plus la limitation', async () => {
    const id = (await admin.regularizationRequest.findFirstOrThrow({ where: { tenantId: S.B.id } })).id;
    const ANSWER = 'Cahiora a bien reçu votre demande fictive : paiement à confirmer (test).';
    const url = `/billing/regularization-requests/${id}/answer`;
    expect((await pf.post(url, { answer: ANSWER })).status).toBe(400);
    expect((await pf.post(url, { answer: ANSWER, code: '000000' })).status).toBe(403);
    await admin.platformAdmin.update({ where: { id: sa.id }, data: { failedLogins: 0 } });
    expect((await pf.post(url, { answer: '        ', code: await code() })).status).toBe(400);
    expect((await pf.post(`/billing/regularization-requests/${UUID}/answer`, { answer: ANSWER, code: await code() })).status).toBe(404);
    // Avant d'envoyer, le Super Admin lit la date de la limitation : la grâce finit dans plus de 48 heures, pas de préavis.
    const limitedAt = new Date(`${addDays(J(29), 1)}T00:00:00+01:00`).toISOString();
    const label = `${frDay(J(30))} à 0 h 00`;
    const after = { kind: 'scheduled', limitedAt, limitedAtLabel: label, noticeHours: null, noticeGiven: false };
    expect((await pf.get('/billing/access')).body.clients.find((c: { tenantId: string }) => c.tenantId === S.B.id).afterAnswer).toEqual(after);
    const ok = await pf.post(url, { answer: ANSWER, code: await code() });
    expect([ok.status, ok.body]).toEqual([201, { ok: true, outcome: after }]);
    expect((await pf.post(url, { answer: ANSWER, code: await code() })).status).toBe(409);

    expect(await admin.regularizationRequest.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'ANSWERED', answer: ANSWER, answeredById: sa.id, answeredByName: sa.name });
    expect((await eventsOf(S.B.id)).at(-1)).toMatchObject({ kind: 'REGULARIZATION_ANSWERED', actorKind: 'platform', data: { requestId: id, answer: ANSWER } });
    expect(await schoolJournal(S.B.id, 'billing.regularization_answered')).toHaveLength(1);
    const note = (await notificationsOf(S.B.id)).at(-1)!;
    expect(note).toMatchObject({ kind: 'billing.regularization_answered', title: 'Réponse de Cahiora à votre demande de régularisation' });
    expect(note.body.startsWith(ANSWER)).toBe(true);
    expect(note.body).toContain(`Sans paiement validé, l’accès sera limité à partir du ${label}.`);
    expect((await admin.subscription.findUniqueOrThrow({ where: { tenantId: S.B.id } })).noticeUntil).toBeNull();
    // L'école lit la réponse ; jamais le nom du Super Admin.
    const v = (await school(S.B.direction).get('/settings/subscription')).body;
    expect(v.requests[0]).toMatchObject({ id, status: 'ANSWERED', answer: ANSWER });
    expect(JSON.stringify(v)).not.toContain(sa.name);
    // Le délai étant passé, la tâche pose la limitation à son passage suivant.
    expect(mine(await run(J(31)), S.B)).toEqual([`access-limited:${S.B.name}`]);
    expect((await subscriptionOf(S.B.id)).status).toBe('LIMITED');
    // Une nouvelle demande reste possible pendant l'accès limité ; elle ne lève pas la limitation.
    expect((await school(S.B.direction).post(REQ, { message: 'Seconde demande fictive (test)' })).status).toBe(201);
    expect((await subscriptionOf(S.B.id)).status).toBe('LIMITED');
    expect((await school(S.B.direction).post('/students', {})).status).toBe(403);
  });

  it('prolongation exceptionnelle (D-G5-43 A) : date de fin et motif obligatoires, code exigé ; elle lève l’accès limité, puis la limitation revient', async () => {
    const EXT = `/billing/access/${S.A.id}/extension`;
    const reason = 'Paiement partiel fictif, solde promis (test G5d-1)';
    expect((await pf.post(EXT, { until: J(40), code: await code() })).status).toBe(400);
    expect((await pf.post(EXT, { until: J(40), reason })).status).toBe(400);
    expect((await pf.post(EXT, { until: `${J(40).slice(8, 10)}/${J(40).slice(5, 7)}/${J(40).slice(0, 4)}`, reason, code: await code() })).status).toBe(400);
    const msg = async (until: string) => (await pf.post(EXT, { until, reason, code: await code() })).body.message;
    expect(await msg(addDays(today, -1))).toBe('La date de fin ne peut pas être passée');
    expect(await msg(J(29))).toBe(`Le délai de grâce court déjà jusqu’au ${frDay(J(29))} : choisissez une date de fin plus tardive`);
    expect(await msg(addDays(today, 400))).toBe('Date de fin : au plus un an après aujourd’hui');
    const pilot = await pf.post(`/billing/access/${S.C.id}/extension`, { until: J(40), reason, code: await code() });
    expect([pilot.status, pilot.body.message]).toEqual([400, 'Une prolongation se donne à un abonnement en attente ou en accès limité (état actuel : École pilote partenaire CAHIORA)']);
    expect((await pf.post(`/billing/access/${S.D.id}/extension`, { until: J(40), reason, code: await code() })).status).toBe(409);
    expect((await pf.post(EXT, { until: J(40), reason, code: '000000' })).status).toBe(403);
    await admin.platformAdmin.update({ where: { id: sa.id }, data: { failedLogins: 0 } });
    expect((await subscriptionOf(S.A.id)).status).toBe('LIMITED');

    const ok = await pf.post(EXT, { until: J(40), reason: `  ${reason}  `, code: await code() });
    expect([ok.status, ok.body]).toEqual([201, { tenantId: S.A.id, status: 'AWAITING_PAYMENT', statusLabel: 'En attente de paiement', extendedUntil: J(40), limitationLifted: true, kind: 'first' }]);
    const s = await subscriptionOf(S.A.id);
    expect(s).toMatchObject({ status: 'AWAITING_PAYMENT', limitedSince: null });
    expect(iso(s.extendedUntil)).toBe(J(40));
    expect((await eventsOf(S.A.id)).at(-1)).toMatchObject({
      kind: 'ACCESS_EXTENDED', fromStatus: 'LIMITED', toStatus: 'AWAITING_PAYMENT', reason, actorKind: 'platform', actorId: sa.id,
      data: { until: J(40), previousUntil: null, graceEnd: J(29), limitationLifted: true, kind: 'first', maxDays: 30 },
    });
    // Le motif reste dans le journal de la plateforme : ni le groupe, ni l'école, ni l'écran de la direction ne le voient.
    expect((await admin.platformAuditLog.findFirstOrThrow({ where: { tenantId: S.A.id, action: 'billing.access_extended' } })).data).toMatchObject({ until: J(40), reason });
    expect(JSON.stringify(await admin.groupAuditLog.findMany({ where: { groupId: S.A.groupId, action: 'billing.access_extended' } }))).not.toContain(reason);
    expect(JSON.stringify(await schoolJournal(S.A.id, 'billing.access_extended'))).not.toContain(reason);
    const v = (await school(S.A.direction).get('/settings/subscription')).body;
    expect(JSON.stringify(v)).not.toContain(reason);
    expect(JSON.stringify(v)).not.toContain(sa.name);
    expect(v.history[0]).toMatchObject({ kind: 'ACCESS_EXTENDED', label: 'Accès complet prolongé par Cahiora', actorName: 'Cahiora' });
    expect(v.access).toMatchObject({ status: 'AWAITING_PAYMENT', phase: 'EXTENDED', until: J(40), limitedFrom: J(41), extendedUntil: J(40) });
    expect((await notificationsOf(S.A.id)).at(-1)).toMatchObject({ kind: 'billing.access_extended', title: 'Accès complet prolongé par Cahiora' });
    expect((await notificationsOf(S.A.id)).at(-1)!.body).toContain(`jusqu’au ${frDay(J(40))} inclus : l’accès limité est levé dès maintenant`);
    // L'accès complet revient tout de suite.
    expect((await school(S.A.direction).post('/students', {})).status).toBe(400);
    // La même date ne se redonne pas.
    expect(await msg(J(40))).toBe('Cette date est déjà la fin de la prolongation');

    // Rappels avant la fin de la prolongation, puis accès limité le lendemain.
    expect(mine(await run(J(36)), S.A)).toEqual([]);
    expect(mine(await run(J(37)), S.A)).toEqual([`extension-reminder-3:${S.A.name}`]);
    expect(mine(await run(J(39)), S.A)).toEqual([`extension-reminder-1:${S.A.name}`]);
    expect(mine(await run(J(40)), S.A)).toEqual([`extension-reminder-0:${S.A.name}`]);
    const rem = (await notificationsOf(S.A.id)).filter((n) => n.kind === 'billing.extension_reminder');
    expect(rem[0].body).toContain(`La prolongation accordée par Cahiora prend fin dans 3 jours, le ${frDay(J(40))} : c’est le dernier jour d’accès complet.`);
    expect(mine(await run(J(41)), S.A)).toEqual([`access-limited:${S.A.name}`]);
    expect(mine(await run(J(42)), S.A)).toEqual([]);
    expect((await subscriptionOf(S.A.id)).status).toBe('LIMITED');
    expect((await eventsOf(S.A.id)).at(-1)).toMatchObject({ kind: 'ACCESS_LIMITED', fromStatus: 'AWAITING_PAYMENT', data: { lastFullAccessDay: J(40), extendedUntil: J(40) } });
    expect((await school(S.A.direction).post('/students', {})).status).toBe(403);
    // Une prolongation donnée pendant la grâce ou l'attente garde l'état : B (limité) revient en attente d'acceptation, faute d'acceptation.
    const b = await pf.post(`/billing/access/${S.B.id}/extension`, { until: J(45), reason, code: await code() });
    expect([b.status, b.body.status]).toEqual([201, 'AWAITING_ACCEPTANCE']);
    // La demande en attente de B reste en attente : la prolongation n'y répond pas.
    expect(await admin.regularizationRequest.count({ where: { tenantId: S.B.id, status: 'PENDING' } })).toBe(1);
  });

  it('lecture 9 A : 30 jours au plus par prolongation ; renouvellement exceptionnel avec son propre motif, marqué ; fin avancée possible', async () => {
    const EXT = `/billing/access/${S.A.id}/extension`;
    const client = async () => (await pf.get('/billing/access')).body.clients.find((c: { tenantId: string }) => c.tenantId === S.A.id);
    // A est de nouveau limité après sa prolongation jusqu'au jour 40 : 30 jours au plus depuis la fin de celle-ci.
    expect((await subscriptionOf(S.A.id)).status).toBe('LIMITED');
    expect((await client()).extension).toEqual({ current: J(40), maxDays: 30, maxUntil: J(70), renewals: 0 });
    const msg = async (until: string, reason: string) => (await pf.post(EXT, { until, reason, code: await code() })).body.message;
    expect(await msg(J(71), 'Renouvellement fictif trop long (test)'))
      .toBe(`Une prolongation dure 30 jours au plus, renouvellement compris, depuis la fin de l’accès complet en cours : choisissez au plus tard le ${frDay(J(70))}`);
    // Son propre motif : celui de la prolongation précédente est refusé, même écrit autrement.
    expect(await msg(J(70), '  paiement partiel fictif,   solde promis (TEST G5d-1) '))
      .toBe('Renouvellement exceptionnel : donnez son propre motif, différent de celui de la prolongation précédente');
    const reason = 'Second versement fictif annoncé pour la fin du mois (test)';
    const ok = await pf.post(EXT, { until: J(70), reason, code: await code() });
    expect([ok.status, ok.body]).toEqual([201, { tenantId: S.A.id, status: 'AWAITING_PAYMENT', statusLabel: 'En attente de paiement', extendedUntil: J(70), limitationLifted: true, kind: 'renewal' }]);
    expect((await eventsOf(S.A.id)).at(-1)).toMatchObject({
      kind: 'ACCESS_EXTENSION_RENEWED', fromStatus: 'LIMITED', toStatus: 'AWAITING_PAYMENT', reason,
      data: { until: J(70), previousUntil: J(40), graceEnd: J(29), kind: 'renewal', label: 'Renouvellement exceptionnel', maxDays: 30, limitationLifted: true },
    });
    // Marqué au journal (le motif reste à la plateforme) et dans la liste des clients ; la direction lit « à nouveau ».
    expect((await admin.platformAuditLog.findFirstOrThrow({ where: { tenantId: S.A.id, action: 'billing.access_extension_renewed' } })).data).toMatchObject({ label: 'Renouvellement exceptionnel', reason });
    expect(await admin.groupAuditLog.count({ where: { groupId: S.A.groupId, action: 'billing.access_extension_renewed' } })).toBe(1);
    expect(JSON.stringify(await schoolJournal(S.A.id, 'billing.access_extension_renewed'))).not.toContain(reason);
    expect(await client()).toMatchObject({ phase: 'EXTENDED', until: J(70), extension: { current: J(70), maxDays: 30, maxUntil: J(100), renewals: 1 } });
    const note = (await notificationsOf(S.A.id)).at(-1)!;
    expect(note).toMatchObject({ kind: 'billing.access_extension_renewed', title: 'Accès complet prolongé à nouveau par Cahiora' });
    expect(note.body).toContain(`Cahiora prolonge à nouveau l’accès complet de votre établissement, à titre exceptionnel, jusqu’au ${frDay(J(70))} inclus : l’accès limité est levé dès maintenant.`);
    const v = (await school(S.A.direction).get('/settings/subscription')).body;
    expect(v.history[0]).toMatchObject({ kind: 'ACCESS_EXTENSION_RENEWED', label: 'Renouvellement exceptionnel : accès complet prolongé à nouveau par Cahiora', actorName: 'Cahiora' });
    expect(JSON.stringify(v)).not.toContain(reason);
    // Avancer la fin n'est pas un renouvellement.
    const short = await pf.post(EXT, { until: J(60), reason: 'Fin avancée fictive (test)', code: await code() });
    expect([short.status, short.body.kind, short.body.limitationLifted]).toEqual([201, 'shortened', false]);
    expect((await eventsOf(S.A.id)).at(-1)).toMatchObject({ kind: 'ACCESS_EXTENSION_SHORTENED', data: { until: J(60), previousUntil: J(70), kind: 'shortened' } });
    expect((await notificationsOf(S.A.id)).at(-1)).toMatchObject({ kind: 'billing.access_extension_shortened', title: 'Fin de la prolongation avancée par Cahiora' });
    expect((await client()).extension).toMatchObject({ current: J(60), renewals: 1 });
    // Le garde-fou d'un an reste.
    expect(await msg(addDays(today, 400), 'Autre motif fictif (test)')).toBe('Date de fin : au plus un an après aujourd’hui');
    // Sans paiement validé, la limitation revient après la nouvelle date de fin.
    expect(mine(await run(J(61)), S.A)).toEqual([`access-limited:${S.A.name}`]);
    expect((await subscriptionOf(S.A.id)).status).toBe('LIMITED');
  });

  it('lecture 7 A : réponse moins de 48 heures avant la limitation, préavis de 48 heures une seule fois par échéance ; rappel, puis accès limité', async () => {
    const E = S.E;
    const H = 3_600_000;
    const answerUrl = (id: string) => `/billing/regularization-requests/${id}/answer`;
    const client = async () => (await pf.get('/billing/access')).body.clients.find((c: { tenantId: string }) => c.tenantId === E.id);
    // Abonnement fictif posé directement : essai fini il y a 15 jours, délai de grâce qui finit aujourd'hui.
    const day = (d: string) => new Date(`${d}T00:00:00.000Z`);
    await admin.subscription.create({
      data: {
        tenantId: E.id, status: 'AWAITING_ACCEPTANCE', trialStart: day(addDays(today, -28)), trialEnd: day(addDays(today, -15)), trialDays: 14,
        graceStart: day(addDays(today, -14)), graceEnd: day(today),
      },
    });
    const r1 = await school(E.direction).post(REQ, { message: 'Demande fictive de dernière minute (test lecture 7 A)' });
    expect(r1.status).toBe(201);
    expect(r1.body.access).toMatchObject({ phase: 'GRACE', until: today, pendingRequest: true, limitedAt: null });
    // Avant d'envoyer, le Super Admin lit le préavis que sa réponse ouvrira.
    const t0 = Date.now();
    const preview = (await client()).afterAnswer;
    expect(preview).toMatchObject({ kind: 'notice', noticeHours: 48, noticeGiven: false });
    expect(new Date(preview.limitedAt).getTime()).toBeGreaterThanOrEqual(t0 - 5000 + 48 * H);
    const ANSWER = 'Cahiora a bien reçu votre demande fictive (test lecture 7 A).';
    const c1 = await code();
    const t1 = Date.now();
    const ok = await pf.post(answerUrl(r1.body.id), { answer: ANSWER, code: c1 });
    const t2 = Date.now();
    expect(ok.status).toBe(201);
    const o = ok.body.outcome;
    expect(o).toMatchObject({ kind: 'notice', noticeHours: 48, noticeGiven: false });
    const until = new Date(o.limitedAt);
    expect(until.getTime()).toBeGreaterThanOrEqual(t1 + 48 * H);
    expect(until.getTime()).toBeLessThanOrEqual(t2 + 48 * H);
    expect(o.limitedAtLabel).toBe(frDateTime(until, TZ));
    const s = await subscriptionOf(E.id);
    expect([s.noticeUntil?.toISOString(), iso(s.noticeGraceEnd), s.status]).toEqual([o.limitedAt, today, 'AWAITING_ACCEPTANCE']);
    // La direction lit le jour et l'heure de la limitation, dans la réponse, le bandeau et l'alerte (/auth/me).
    const note = (await notificationsOf(E.id)).at(-1)!;
    expect(note.body).toContain(`Sans paiement validé, l’accès sera limité à partir du ${o.limitedAtLabel} : Cahiora vous laisse un préavis de 48 heures après cette réponse.`);
    expect((await eventsOf(E.id)).at(-1)).toMatchObject({ kind: 'REGULARIZATION_ANSWERED', data: { limitation: { kind: 'notice', limitedAt: o.limitedAt, noticeHours: 48, graceEnd: today } } });
    expect((await school(E.direction).get('/auth/me')).body.access).toMatchObject({ phase: 'NOTICE', limitedAt: o.limitedAt, limitedAtLabel: o.limitedAtLabel, hoursLeft: 48 });
    expect(await client()).toMatchObject({ phase: 'NOTICE', limitedAtLabel: o.limitedAtLabel, noticeUntil: o.limitedAt, afterAnswer: null });

    // Une nouvelle demande pendant le préavis, puis sa réponse : le préavis n'est pas renouvelé.
    const r2 = await school(E.direction).post(REQ, { message: 'Seconde demande fictive (test lecture 7 A)' });
    expect(r2.status).toBe(201);
    expect((await client()).afterAnswer).toMatchObject({ kind: 'notice-running', limitedAt: o.limitedAt, noticeGiven: true });
    const ok2 = await pf.post(answerUrl(r2.body.id), { answer: ANSWER, code: await code() });
    expect(ok2.body.outcome).toMatchObject({ kind: 'notice-running', limitedAt: o.limitedAt, noticeGiven: true });
    expect((await subscriptionOf(E.id)).noticeUntil?.toISOString()).toBe(o.limitedAt);
    expect((await notificationsOf(E.id)).at(-1)!.body).toContain(`Sans paiement validé, l’accès sera limité à partir du ${o.limitedAtLabel}, à la fin du préavis déjà donné pour cette échéance.`);
    // La base refuse de déplacer ou d'effacer le préavis de l'échéance, pour le propriétaire comme pour la plateforme.
    await expect(admin.$executeRawUnsafe(`UPDATE subscriptions SET "noticeUntil" = "noticeUntil" + interval '1 day' WHERE tenant_id = '${E.id}'`))
      .rejects.toThrow(/préavis de cette échéance est déjà donné/);
    await expect(platformDb.$executeRawUnsafe(`UPDATE subscriptions SET "noticeUntil" = NULL, "noticeGraceEnd" = NULL WHERE tenant_id = '${E.id}'`))
      .rejects.toThrow(/préavis de cette échéance est déjà donné/);

    // Tâche planifiée : rien pendant le préavis, sauf le rappel de ses dernières 24 heures ; la limitation à sa fin.
    const jobs = app.get(BillingJobsService);
    const runAt = async (t: number) => mine((await jobs.runDue(new Date(t))).done, E);
    expect(await runAt(until.getTime() - 25 * H)).toEqual([]);
    expect(await runAt(until.getTime() - 23 * H)).toEqual([`notice-reminder:${E.name}`]);
    expect(await runAt(until.getTime() - 22 * H)).toEqual([]);
    expect(await runAt(until.getTime() - 60_000)).toEqual([]);
    expect((await subscriptionOf(E.id)).status).toBe('AWAITING_ACCEPTANCE');
    const rem = (await notificationsOf(E.id)).filter((n) => n.kind === 'billing.notice_reminder');
    expect(rem).toHaveLength(1);
    expect(rem[0].title).toBe('Dernier jour du préavis : régularisez votre abonnement Cahiora');
    expect(rem[0].body).toContain(`Le préavis donné par Cahiora après sa réponse à votre demande de régularisation prend fin le ${o.limitedAtLabel} : jusque-là, l’accès reste complet.`);
    expect(await schoolJournal(E.id, 'billing.notice_reminder')).toHaveLength(1);
    expect(await runAt(until.getTime() + 60_000)).toEqual([`access-limited:${E.name}`]);
    expect((await subscriptionOf(E.id)).status).toBe('LIMITED');
    expect((await eventsOf(E.id)).at(-1)).toMatchObject({
      kind: 'ACCESS_LIMITED', fromStatus: 'AWAITING_ACCEPTANCE', toStatus: 'LIMITED', data: { lastFullAccessDay: today, graceEnd: today, extendedUntil: null, noticeUntil: o.limitedAt },
    });
    expect((await notificationsOf(E.id)).at(-1)!.body).toContain(`Le préavis donné par Cahiora a pris fin le ${o.limitedAtLabel} sans paiement validé : l’accès à Cahiora est désormais limité.`);
    expect((await admin.platformAlert.findFirstOrThrow({ where: { tenantId: E.id, kind: 'ACCESS_LIMITED' } })).message)
      .toContain(`accès complet jusqu'au ${frDay(today)}, puis préavis après la réponse de Cahiora jusqu'au ${o.limitedAtLabel}`);
    // Une demande envoyée pendant l'accès limité, puis sa réponse : rien à annoncer, l'accès reste limité.
    const r3 = await school(E.direction).post(REQ, {});
    expect(r3.status).toBe(201);
    const ok3 = await pf.post(answerUrl(r3.body.id), { answer: ANSWER, code: await code() });
    expect(ok3.body.outcome).toMatchObject({ kind: 'none', limitedAt: null });
    expect((await subscriptionOf(E.id)).status).toBe('LIMITED');
  });

  it('pilote : sa date est respectée ; le délai de grâce commence le lendemain du dernier jour gratuit', async () => {
    const end = iso((await subscriptionOf(S.C.id)).pilotEnd)!;
    expect(mine(await run(addDays(end, -3)), S.C)).toEqual([`pilot-alert-30:${S.C.name}`, `pilot-alert-7:${S.C.name}`]);
    expect(mine(await run(end), S.C)).toEqual([]);
    expect(mine(await run(addDays(end, 1)), S.C)).toEqual([`pilot-end:${S.C.name}`]);
    const s = await subscriptionOf(S.C.id);
    expect(s.status).toBe('AWAITING_ACCEPTANCE');
    expect([iso(s.graceStart), iso(s.graceEnd)]).toEqual([addDays(end, 1), addDays(end, 15)]);
    expect((await eventsOf(S.C.id)).at(-1)).toMatchObject({ kind: 'PILOT_ENDED', data: { lastFreeDay: end, graceDays: 15, graceStart: addDays(end, 1), graceEnd: addDays(end, 15) } });
    expect((await notificationsOf(S.C.id)).at(-1)!.body).toContain(`Vous gardez l’accès complet jusqu’au ${frDay(addDays(end, 15))} inclus`);
    // Ni rappel de l'essai ni rappel de la grâce avant leurs dates.
    expect((await notificationsOf(S.C.id)).map((n) => n.kind)).toEqual(['billing.pilot_ending', 'billing.pilot_ending', 'billing.pilot_ended']);
  });

  it('base de données : demandes dans la zone de la plateforme, en ajout seul ; délai de grâce figé ; documents réservés aux conditions acceptées', async () => {
    for (const db of [appDb, groupDb, statsDb]) await expect(db.$queryRawUnsafe('SELECT count(*) FROM regularization_requests')).rejects.toThrow(/permission denied/);
    // Les fonctions de l'école ne rendent que son propre abonnement, sans le motif d'une prolongation.
    const own = await inTenant(S.A.id, (tx) => tx.$queryRaw<Record<string, unknown>[]>`SELECT * FROM current_tenant_subscription_access()`, appDb);
    expect(own).toHaveLength(1);
    expect(Object.keys(own[0]).sort()).toEqual(['extended_until', 'grace_end', 'grace_start', 'limited_since', 'notice_until', 'pending_request', 'status', 'terms_accepted']);
    expect(await inTenant(S.D.id, (tx) => tx.$queryRaw`SELECT * FROM current_tenant_subscription_access()`, appDb)).toEqual([]);
    expect(await inTenant(S.D.id, (tx) => tx.$queryRaw`SELECT * FROM current_tenant_regularization_requests()`, appDb)).toEqual([]);
    expect(await inTenant(S.B.id, (tx) => tx.$queryRaw<unknown[]>`SELECT * FROM current_tenant_regularization_requests()`, appDb)).toHaveLength(2);
    await expect(groupDb.$queryRaw`SELECT * FROM current_tenant_subscription_access()`).rejects.toThrow(/permission denied/);
    // Une direction ne demande pas pour une autre école, même par requête directe.
    await expect(inTenant(S.D.id, (tx) => tx.$queryRaw`SELECT request_regularization(${S.B.directionId}::uuid, 'Intrus', NULL, NULL)`, appDb))
      .rejects.toThrow(/seule la direction de tout l'établissement/);
    // Ajout seul, même pour le propriétaire de la base ; la plateforme n'écrit que la réponse.
    const refused = (sql: string, db: PrismaClient = admin) => expect(db.$executeRawUnsafe(sql)).rejects.toThrow();
    await refused(`DELETE FROM regularization_requests WHERE tenant_id = '${S.B.id}'`);
    await refused(`UPDATE regularization_requests SET message = 'X' WHERE tenant_id = '${S.B.id}'`);
    await refused(`UPDATE regularization_requests SET answer = 'Autre réponse' WHERE tenant_id = '${S.B.id}' AND status = 'ANSWERED'`);
    await refused('TRUNCATE regularization_requests');
    await expect(platformDb.$executeRawUnsafe(`UPDATE regularization_requests SET message = 'X' WHERE tenant_id = '${S.B.id}'`)).rejects.toThrow(/permission denied/);
    await expect(platformDb.$executeRawUnsafe(`INSERT INTO regularization_requests (id, tenant_id, "subscriptionId", "subscriptionStatus", "requestedByName")
      SELECT gen_random_uuid(), tenant_id, id, status, 'Intrus' FROM subscriptions WHERE tenant_id = '${S.D.id}'`)).rejects.toThrow(/permission denied/);
    // Le délai de grâce ne se déplace pas à la main ; l'accès limité porte toujours sa date.
    await refused(`UPDATE subscriptions SET "graceEnd" = "graceEnd" + 30 WHERE tenant_id = '${S.A.id}'`);
    await refused(`UPDATE subscriptions SET "graceEnd" = "graceEnd" + 30 WHERE tenant_id = '${S.B.id}'`, platformDb);
    await refused(`UPDATE subscriptions SET "limitedSince" = NULL WHERE tenant_id = '${S.A.id}'`);
    expect(iso((await subscriptionOf(S.A.id)).graceEnd)).toBe(J(29));
    // Une ligne d'un document de l'abonnement est refusée par la base pour un établissement qui n'a pas accepté les conditions.
    await expect(admin.$executeRaw`INSERT INTO billing_document_lines (id, "documentId", tenant_id, position, label, amount, "countId")
      VALUES (gen_random_uuid(), gen_random_uuid(), ${S.B.id}::uuid, 1, 'Ligne fictive', 0, gen_random_uuid())`).rejects.toThrow(/ligne 1 : les conditions commerciales ne sont pas acceptées/);
  });
});
