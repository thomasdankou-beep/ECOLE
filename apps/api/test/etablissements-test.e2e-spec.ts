/**
 * Établissements de test (demande de Dankou du 20 novembre 2026 : « Tous les établissements actuellement présents sur
 * CAHIORA sont utilisés pour les tests. […] Vérifie que les établissements de test ne peuvent être ni facturés réellement
 * ni automatiquement limités. »), de bout en bout sur la base de test (erp_test), avec des établissements et des comptes
 * entièrement fictifs créés pour ce fichier. Un établissement de test n'a ni essai, ni pilote, ni abonnement, ni
 * comptage, ni document, ni paiement, ni crédit, ni accès limité : l'API le refuse, la base aussi (quel que soit le
 * chemin), et les tâches planifiées l'ignorent. Un abonnement d'avant ce lot y reste figé et ne limite jamais l'accès.
 * Aucun prestataire appelé, aucun SMS, aucune facture.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { forgetAccess } from '../src/common/auth';
import { localDay } from '../src/common/country';
import { LIMITED_REFUSAL } from '../src/modules/billing/access-rules';
import { CLIENT_ATTESTATION, COMMERCIAL_STATUS_FROZEN, TEST_ESTABLISHMENT_NOTE } from '../src/modules/billing/billing';
import { BillingJobsService } from '../src/modules/billing/billing-jobs';
import { addDays } from '../src/modules/billing/billing-rules';
import { SCHOOL_TEST_NOTICE } from '../src/modules/billing/subscription-school';

const TZ = 'Africa/Porto-Novo';
const PASSWORD = 'Etablissements-test-2026';
const SA_PASSWORD = 'Plateforme-test-2026';
const stamp = Date.now().toString(36);
const today = localDay(TZ);
const day = (n: number) => addDays(today, n);
const at = (d: string) => new Date(`${d}T09:00:00.000Z`);
const REASON = 'Établissement fictif de l’essai des statuts commerciaux';

let app: INestApplication;
let http: ReturnType<typeof request>;
const admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_ADMIN_URL } } });

type School = { id: string; slug: string; name: string; groupId: string; direction: string };
const S = {} as Record<'N' | 'C' | 'LA' | 'LL', School>;
const sa = { id: '', name: 'Super Admin établissements de test (fictif)', email: `test-etab-${stamp}@test.local`, cookie: '', secret: '' };

function inTenant<T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  return admin.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}

/** Code du moment de l'application d'authentification, jamais à moins de 3 secondes de la fin de sa période. */
async function code() {
  const left = 30_000 - (Date.now() % 30_000);
  if (left < 3000) await new Promise((r) => setTimeout(r, left + 200));
  return authenticator.generate(sa.secret);
}

const msg = (r: request.Response) => ([] as string[]).concat(r.body?.message ?? []).join(' · ');
const cookieOf = (r: request.Response) => (r.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('erp_pt='))!.split(';')[0];
const pf = {
  get: (url: string) => http.get(`/api/v1/platform${url}`).set('Cookie', sa.cookie),
  post: (url: string, body: object = {}) => http.post(`/api/v1/platform${url}`).set('Cookie', sa.cookie).send(body),
};
const school = (token: string) => ({
  get: (url: string) => http.get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
  post: (url: string, body: object = {}) => http.post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body),
});

/** Établissement fictif avec sa direction de tout l'établissement ; statut commercial donné, ou celui par défaut. */
async function newSchool(k: string, status?: 'TEST' | 'CLIENT'): Promise<School> {
  const t = await admin.tenant.create({
    data: {
      ...(status ? { commercialStatus: status } : {}), slug: `test-etab-${k.toLowerCase()}-${stamp}`, name: `École fictive statut ${k} ${stamp}`, timezone: TZ,
      group: { create: { name: `Groupe fictif statut ${k} ${stamp}` } },
    },
  });
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  await inTenant(t.id, async (tx) => {
    const u = await tx.user.create({ data: { tenantId: t.id, phone: '+2290190006001', firstName: 'Fictif', lastName: `DIRECTION ${k}`, passwordHash: hash, mustChangePassword: false } });
    await tx.userRole.create({ data: { tenantId: t.id, userId: u.id, role: 'DIRECTION' } });
  });
  const r = await http.post('/api/v1/auth/login').send({ tenant: t.slug, identifier: '+2290190006001', password: PASSWORD });
  expect(r.status).toBe(200);
  return { id: t.id, slug: t.slug, name: t.name, groupId: t.groupId, direction: r.body.accessToken };
}

/** Abonnement fictif dont l'essai et le délai de grâce sont finis : accès limité aujourd'hui, ou déjà limité. */
async function overdue(s: School, o: { limited?: boolean } = {}) {
  await admin.subscription.create({
    data: {
      tenantId: s.id, status: o.limited ? 'LIMITED' : 'AWAITING_ACCEPTANCE', statusSince: at(day(o.limited ? -5 : -20)), trialStart: new Date(day(-34)), trialEnd: new Date(day(-21)),
      trialDays: 14, graceStart: new Date(day(-20)), graceEnd: new Date(day(-6)), limitedSince: o.limited ? at(day(-5)) : null,
    },
  });
}

/**
 * État hérité d'avant ce lot : la mise à jour de la base classe « test » tous les établissements existants, même avec un
 * abonnement. Simulé ici en écartant, le temps d'une transaction, le contrôle qui l'interdit ensuite.
 */
async function legacyTest(s: School) {
  await admin.$transaction([
    admin.$executeRawUnsafe('ALTER TABLE tenants DISABLE TRIGGER tenants_commercial_status_guard'),
    admin.$executeRaw`UPDATE tenants SET "commercialStatus" = 'TEST' WHERE id = ${s.id}::uuid`,
    admin.$executeRawUnsafe('ALTER TABLE tenants ENABLE TRIGGER tenants_commercial_status_guard'),
  ]);
  forgetAccess(s.id);
}

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  configureApp(app);
  await app.init();
  http = request(app.getHttpServer());

  // N : nouvel établissement (statut par défaut) ; C : client réel témoin ; LA et LL : établissements de test hérités,
  // l'un au bout de son délai de grâce, l'autre déjà limité avant ce lot.
  S.N = await newSchool('N');
  S.C = await newSchool('C', 'CLIENT');
  S.LA = await newSchool('LA', 'CLIENT');
  S.LL = await newSchool('LL', 'CLIENT');
  await overdue(S.C);
  await overdue(S.LA);
  await overdue(S.LL, { limited: true });
  await legacyTest(S.LA);
  await legacyTest(S.LL);

  // Super Admin fictif avec double authentification.
  await admin.platformAdmin.create({ data: { email: sa.email, name: sa.name, passwordHash: await argon2.hash(SA_PASSWORD), mustChangePassword: false, mustSetupTwoFactor: false } });
  sa.id = (await admin.platformAdmin.findUniqueOrThrow({ where: { email: sa.email } })).id;
  sa.cookie = cookieOf(await http.post('/api/v1/platform/auth/login').send({ email: sa.email, password: SA_PASSWORD }).expect(201));
  const setup = await pf.post('/auth/2fa/setup').expect(201);
  sa.secret = setup.body.secret;
  await pf.post('/auth/2fa/enable', { code: await code(), setupToken: setup.body.setupToken }).expect(201);
}, 90000);

afterAll(async () => {
  await app?.close();
  await admin.platformAdmin.deleteMany({ where: { email: sa.email } }).catch(() => undefined);
  await admin.$disconnect();
});

describe('Établissements de test (20 novembre 2026) · jamais facturés réellement', () => {
  it('un nouvel établissement est un établissement de test ; la direction lit que rien ne lui est facturé', async () => {
    expect((await admin.tenant.findUniqueOrThrow({ where: { id: S.N.id } })).commercialStatus).toBe('TEST');
    const v = (await school(S.N.direction).get('/settings/subscription').expect(200)).body;
    expect(v).toMatchObject({ commercialStatus: 'TEST', testNotice: SCHOOL_TEST_NOTICE, subscription: null, access: null, regularization: null });
    // La console les compte à part et ne propose aucun changement de statut à un établissement qui a un abonnement.
    const list = (await pf.get('/billing/establishments').expect(200)).body as { id: string; commercialStatus: string; commercialStatusLabel: string; canChangeCommercialStatus: boolean }[];
    expect(list.find((e) => e.id === S.N.id)).toMatchObject({ commercialStatus: 'TEST', commercialStatusLabel: 'Établissement de test', commercialStatusNote: TEST_ESTABLISHMENT_NOTE, canChangeCommercialStatus: true });
    expect(list.find((e) => e.id === S.LA.id)).toMatchObject({ commercialStatus: 'TEST', canChangeCommercialStatus: false });
    expect(list.find((e) => e.id === S.C.id)).toMatchObject({ commercialStatus: 'CLIENT', commercialStatusLabel: 'Client réel', commercialStatusNote: null, canChangeCommercialStatus: false });
    const o = (await pf.get('/billing/overview').expect(200)).body;
    expect(o.counts.testEstablishments).toBeGreaterThanOrEqual(3);
    expect(o.counts.testEstablishments + o.counts.clientEstablishments).toBe(o.counts.establishments);
  });

  it('le Super Admin ne lui ouvre ni essai ni pilote (refus de l’API, rien d’écrit)', async () => {
    const trial = await pf.post(`/billing/establishments/${S.N.id}/trial`, { startDate: today, code: await code() });
    expect([trial.status, msg(trial)]).toEqual([409,
      'Établissement de test : aucun essai gratuit ne s’ouvre. Passez-le d’abord en client réel (statut commercial), s’il est un client commercial réel de Cahiora.']);
    const pilot = await pf.post(`/billing/establishments/${S.N.id}/pilot`, { startDate: today, months: 3, reason: 'Pilote fictif refusé (essai)', code: await code() });
    expect([pilot.status, msg(pilot)]).toEqual([409,
      'Établissement de test : aucune période pilote ne s’ouvre. Passez-le d’abord en client réel (statut commercial), s’il est un client commercial réel de Cahiora.']);
    expect(await admin.subscription.count({ where: { tenantId: S.N.id } })).toBe(0);
  });

  it('la base refuse pour lui toute écriture de la facturation, quel que soit le chemin (même le propriétaire de la base)', async () => {
    const id = S.N.id;
    const refused = async (sql: Prisma.Sql, motif: string) => {
      await expect(admin.$executeRaw(sql)).rejects.toThrow(`CAHIORA: établissement de test : ${motif}`);
    };
    await refused(Prisma.sql`INSERT INTO subscriptions (id, tenant_id) VALUES (gen_random_uuid(), ${id}::uuid)`, 'aucun essai, pilote ni abonnement ne s\'ouvre');
    await refused(Prisma.sql`INSERT INTO billing_counts (id, tenant_id) VALUES (gen_random_uuid(), ${id}::uuid)`, 'aucun comptage des élèves facturables');
    await refused(Prisma.sql`INSERT INTO billing_document_lines (id, tenant_id) VALUES (gen_random_uuid(), ${id}::uuid)`, 'aucun document de Cahiora');
    await refused(Prisma.sql`INSERT INTO billing_payments (id, tenant_id) VALUES (gen_random_uuid(), ${id}::uuid)`, 'aucun paiement ne s\'enregistre');
    await refused(Prisma.sql`INSERT INTO billing_credit_entries (id, tenant_id) VALUES (gen_random_uuid(), ${id}::uuid)`, 'aucun crédit');
    await refused(Prisma.sql`INSERT INTO billing_refunds (id, tenant_id) VALUES (gen_random_uuid(), ${id}::uuid)`, 'aucun remboursement');
    await refused(Prisma.sql`INSERT INTO billing_credit_transfers (id, "fromTenantId") VALUES (gen_random_uuid(), ${id}::uuid)`, 'aucun transfert de crédit');
    await refused(Prisma.sql`INSERT INTO billing_credit_transfers (id, "toTenantId") VALUES (gen_random_uuid(), ${id}::uuid)`, 'aucun transfert de crédit');
    await refused(Prisma.sql`INSERT INTO regularization_requests (id, tenant_id) VALUES (gen_random_uuid(), ${id}::uuid)`, 'aucune demande de régularisation');
  });
});

describe('Établissements de test (20 novembre 2026) · jamais limités automatiquement', () => {
  it('la tâche planifiée limite le client réel au bout de son délai de grâce, jamais l’établissement de test', async () => {
    const done = (await app.get(BillingJobsService).runDue(at(today))).done;
    expect(done).toContain(`access-limited:${S.C.name}`);
    for (const s of [S.N, S.LA, S.LL]) expect(done.filter((k) => k.includes(s.name))).toEqual([]);
    expect((await admin.subscription.findUniqueOrThrow({ where: { tenantId: S.C.id } })).status).toBe('LIMITED');
    // L'abonnement d'avant ce lot reste tel quel : ni limité, ni relancé, ni compté, ni facturé.
    expect(await admin.subscription.findUniqueOrThrow({ where: { tenantId: S.LA.id } })).toMatchObject({ status: 'AWAITING_ACCEPTANCE', limitedSince: null });
    for (const s of [S.LA, S.LL]) {
      expect(await admin.subscriptionEvent.count({ where: { tenantId: s.id } })).toBe(0);
      expect(await admin.platformAlert.count({ where: { tenantId: s.id } })).toBe(0);
      expect(await admin.billingCount.count({ where: { tenantId: s.id } })).toBe(0);
      expect(await admin.billingDocumentLine.count({ where: { tenantId: s.id } })).toBe(0);
      expect(await inTenant(s.id, (tx) => tx.notification.count())).toBe(0);
    }
  });

  it('un abonnement d’avant ce lot ne limite jamais l’accès : ni bandeau, ni alerte, ni refus d’une saisie', async () => {
    for (const s of [S.LA, S.LL]) {
      const me = (await school(s.direction).get('/auth/me').expect(200)).body;
      expect(me.access ?? null).toBeNull();
      const v = (await school(s.direction).get('/settings/subscription').expect(200)).body;
      expect(v).toMatchObject({ commercialStatus: 'TEST', testNotice: SCHOOL_TEST_NOTICE, subscription: null, access: null, regularization: null });
      // Une saisie ordinaire (ici incomplète) passe le contrôle de l'accès : refusée pour son contenu, jamais pour l'accès.
      const write = await school(s.direction).post('/classes', {});
      expect(write.status).toBe(400);
      expect(msg(write)).not.toContain(LIMITED_REFUSAL.staff);
    }
    // Le client réel témoin, lui, est limité.
    const c = await school(S.C.direction).post('/classes', {});
    expect([c.status, msg(c)]).toEqual([403, LIMITED_REFUSAL.staff]);
    // La console de l'accès ne montre que les clients réels.
    const access = JSON.stringify((await pf.get('/billing/access').expect(200)).body);
    expect(access).toContain(S.C.name);
    for (const s of [S.LA, S.LL, S.N]) expect(access).not.toContain(s.name);
  });

  it('l’abonnement figé ne change plus, même par le propriétaire de la base ; son statut commercial non plus', async () => {
    await expect(admin.subscription.update({ where: { tenantId: S.LA.id }, data: { status: 'LIMITED', limitedSince: new Date() } }))
      .rejects.toThrow('CAHIORA: établissement de test : son abonnement reste figé');
    await expect(admin.tenant.update({ where: { id: S.LA.id }, data: { commercialStatus: 'CLIENT' } })).rejects.toThrow('aucun abonnement ni aucun document de Cahiora');
    const r = await pf.post(`/billing/establishments/${S.LA.id}/commercial-status`, { status: 'CLIENT', reason: REASON, confirmed: true, code: await code() });
    expect([r.status, msg(r)]).toEqual([409, COMMERCIAL_STATUS_FROZEN]);
    expect((await admin.tenant.findUniqueOrThrow({ where: { id: S.LA.id } })).commercialStatus).toBe('TEST');
  });
});

describe('Établissements de test (20 novembre 2026) · passage en client réel par le Super Admin', () => {
  it('avec le code, un motif et la confirmation explicite ; tracé dans les trois journaux', async () => {
    const path = `/billing/establishments/${S.N.id}/commercial-status`;
    const noConfirm = await pf.post(path, { status: 'CLIENT', reason: REASON, code: await code() });
    expect([noConfirm.status, msg(noConfirm)]).toEqual([400, 'Cochez la confirmation : seul un client commercial réel de Cahiora passe en « client réel ».']);
    const noReason = await pf.post(path, { status: 'CLIENT', reason: 'non', confirmed: true, code: await code() });
    expect([noReason.status, msg(noReason)]).toEqual([400, 'Motif : 5 à 300 caractères']);
    const same = await pf.post(path, { status: 'TEST', reason: REASON, code: await code() });
    expect([same.status, msg(same)]).toEqual([400, 'Cet établissement est déjà : établissement de test']);
    const wrong = await pf.post(path, { status: 'CLIENT', reason: REASON, confirmed: true, code: authenticator.generate(sa.secret) === '000000' ? '111111' : '000000' });
    expect([wrong.status, msg(wrong)]).toEqual([403, 'Code de votre application incorrect ou expiré']);
    expect((await admin.tenant.findUniqueOrThrow({ where: { id: S.N.id } })).commercialStatus).toBe('TEST');

    const ok = await pf.post(path, { status: 'CLIENT', reason: REASON, confirmed: true, code: await code() });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ commercialStatus: 'CLIENT', commercialStatusLabel: 'Client réel', commercialStatusAt: expect.any(String) });
    const data = { from: 'TEST', to: 'CLIENT', reason: REASON, attestation: CLIENT_ATTESTATION };
    expect((await admin.platformAuditLog.findFirstOrThrow({ where: { tenantId: S.N.id, action: 'billing.commercial_status_changed' } })).data).toMatchObject(data);
    expect((await admin.groupAuditLog.findFirstOrThrow({ where: { groupId: S.N.groupId, action: 'billing.commercial_status_changed' } })).data).toMatchObject({ tenantName: S.N.name, ...data });
    expect((await inTenant(S.N.id, (tx) => tx.auditLog.findFirstOrThrow({ where: { action: 'billing.commercial_status_changed' } }))).data).toMatchObject(data);
    // La direction ne lit plus l'avis de l'établissement de test.
    expect((await school(S.N.direction).get('/settings/subscription').expect(200)).body).toMatchObject({ commercialStatus: 'CLIENT', testNotice: null });
  });

  it('retour en établissement de test possible tant qu’aucun abonnement n’existe ; impossible ensuite', async () => {
    const path = `/billing/establishments/${S.N.id}/commercial-status`;
    expect((await pf.post(path, { status: 'TEST', reason: 'Passage en client réel fait par erreur (essai)', code: await code() })).status).toBe(201);
    expect((await pf.post(path, { status: 'CLIENT', reason: REASON, confirmed: true, code: await code() })).status).toBe(201);
    const trial = await pf.post(`/billing/establishments/${S.N.id}/trial`, { startDate: today, code: await code() });
    expect(trial.status).toBe(201);
    const back = await pf.post(path, { status: 'TEST', reason: 'Retour en test refusé (essai)', code: await code() });
    expect([back.status, msg(back)]).toEqual([409, COMMERCIAL_STATUS_FROZEN]);
    expect((await admin.tenant.findUniqueOrThrow({ where: { id: S.N.id } })).commercialStatus).toBe('CLIENT');
    expect(await admin.platformAuditLog.count({ where: { tenantId: S.N.id, action: 'billing.commercial_status_changed' } })).toBe(3);
  });
});
