/**
 * Lot G5d-2 de la facturation de Cahiora (paiements de l'abonnement enregistrés par le Super Admin), de bout en bout sur
 * la base de test (erp_test), avec des établissements, des comptes, des documents provisoires et un moyen de paiement
 * entièrement fictifs créés pour ce fichier, en francs guinéens (GNF) pour ne croiser aucun autre essai. Plan validé par
 * Dankou le 20 novembre 2026 (« Tout valider ») : D-G5-17 A, choix 1 A et 2 A, D-G5-15 A, D-G5-43 A, D-G5-34 lue A.
 * Essais du cahier des charges G5 : 11 (paiement partiel), 12 (paiement excédentaire), 13 (utilisation d'un avoir),
 * 14 (demande de remboursement), 23 (isolation des établissements), 24 (aucune modification rétroactive), 25 (aucune
 * facture fiscale définitive) ; et : verrou du serveur fermé (toute écriture du lot refusée, rien d'écrit), référence
 * en double, crédit jamais utilisé deux fois, crédit consommé jamais remboursé, transfert autorisé et tracé, accès
 * rendu ou laissé limité, annulation par contre-écriture. Le verrou n'est ouvert que dans ce processus d'essai.
 * Aucun prestataire appelé, aucun SMS, aucune facture.
 */
import { INestApplication, RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomUUID } from 'crypto';
import { authenticator } from 'otplib';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { localDay } from '../src/common/country';
import { LIMITED_REFUSAL } from '../src/modules/billing/access-rules';
import { BillingPaymentsController, PaymentsOpenGuard, SchoolBillingPaymentsController } from '../src/modules/billing/billing-payments';
import { addDays } from '../src/modules/billing/billing-rules';
import { PROVISIONAL_MENTION } from '../src/modules/billing/documents';
import { imputeCreditNote, useCredit } from '../src/modules/billing/payments-access';
import {
  GROUP_PAYMENT_PENDING, meansCode, PAYMENTS_LOCK_ENV, PAYMENTS_LOCKED, paymentsUnlocked, RECEIPT_MENTION, REFUNDS_CLOSED,
} from '../src/modules/billing/payments-rules';
import { PlatformActor } from '../src/modules/platform/group-journal';
import { PlatformDb } from '../src/modules/platform/platform';

const TZ = 'Africa/Porto-Novo';
const CUR = 'GNF';
const PASSWORD = 'Paiements-G5d2-2026';
const SA_PASSWORD = 'Plateforme-G5d2-2026';
const stamp = Date.now().toString(36);
const UUID = '00000000-0000-4000-8000-000000000000';
const today = localDay(TZ);
const day = (n: number) => addDays(today, n);
const at = (d: string) => new Date(`${d}T09:00:00.000Z`);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const MEANS_NAME = `Virement fictif GNF ${stamp}`;
const INSTRUCTIONS = 'Coordonnées fictives pour les essais du lot G5d-2 : aucun compte réel.';
const NOTE = 'Commentaire interne fictif (essai G5d-2)';
const CANCEL_REASON = 'Erreur de saisie fictive (essai G5d-2)';

let app: INestApplication;
let http: ReturnType<typeof request>;
const admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_ADMIN_URL } } });
const appDb = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
const groupDb = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_GROUP_URL } } });

type School = { id: string; slug: string; name: string; groupId: string; direction: string; comptable: string; directionId: string };
type Doc = { id: string; reference: string; total: number };
const S = {} as Record<'P' | 'Q' | 'U' | 'R1' | 'R2' | 'X', School>;
const D = {} as Record<string, Doc>;
const sa = { id: '', name: 'Super Admin paiements (fictif)', email: `g5d2-${stamp}@test.local`, cookie: '', secret: '' };
let actor: PlatformActor;
let code_ = '';
/** Reçus des paiements enregistrés dans ce fichier. */
const pay: Record<string, { id: string; receiptNumber: string }> = {};
let docsBefore: unknown[] = [];

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

/** Message d'une réponse refusée : un texte, ou la liste des messages de la validation, jointe comme le fait la console. */
const msg = (r: request.Response) => ([] as string[]).concat(r.body?.message ?? []).join(' · ');
const cookieOf = (r: request.Response) => (r.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('erp_pt='))!.split(';')[0];
const pf = {
  get: (url: string) => http.get(`/api/v1/platform${url}`).set('Cookie', sa.cookie),
  post: (url: string, body: object = {}) => http.post(`/api/v1/platform${url}`).set('Cookie', sa.cookie).send(body),
  /** Formulaire avec justificatif (multipart), comme la console. */
  form: (url: string, fields: Record<string, string | number>, file: Buffer | null = PNG) => {
    let r = http.post(`/api/v1/platform${url}`).set('Cookie', sa.cookie);
    for (const [k, v] of Object.entries(fields)) r = r.field(k, String(v));
    return file ? r.attach('file', file, { filename: 'preuve-fictive.png', contentType: 'image/png' }) : r;
  },
};
const school = (token: string) => ({
  get: (url: string) => http.get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
  post: (url: string, body: object = {}) => http.post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body),
});
const view = async (s: School) => (await school(s.direction).get('/settings/subscription').expect(200)).body;

async function login(slug: string, phone: string) {
  const r = await http.post('/api/v1/auth/login').send({ tenant: slug, identifier: phone, password: PASSWORD });
  expect(r.status).toBe(200);
  return r.body.accessToken as string;
}

/** Établissement fictif : direction de tout l'établissement et comptable ; un groupe à lui, ou celui donné. */
async function newSchool(k: string, o: { currency?: string; groupId?: string } = {}): Promise<School> {
  const groupId = o.groupId ?? (await admin.schoolGroup.create({ data: { name: `Groupe fictif G5d-2 ${k} ${stamp}` } })).id;
  const t = await admin.tenant.create({
    data: { slug: `g5d2-${k.toLowerCase()}-${stamp}`, name: `École fictive G5d-2 ${k} ${stamp}`, country: o.currency === 'XOF' ? 'BJ' : 'GN', currency: o.currency ?? CUR, timezone: TZ, groupId },
  });
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const directionId = await inTenant(t.id, async (tx) => {
    const add = async (phone: string, role: 'DIRECTION' | 'COMPTABLE', last: string) => {
      const u = await tx.user.create({ data: { tenantId: t.id, phone, firstName: 'Fictif', lastName: last, passwordHash: hash, mustChangePassword: false } });
      await tx.userRole.create({ data: { tenantId: t.id, userId: u.id, role } });
      return u.id;
    };
    const id = await add('+2290190008001', 'DIRECTION', `DIRECTION ${k}`);
    await add('+2290190008002', 'COMPTABLE', `COMPTABLE ${k}`);
    return id;
  });
  return { id: t.id, slug: t.slug, name: t.name, groupId, directionId, direction: await login(t.slug, '+2290190008001'), comptable: await login(t.slug, '+2290190008002') };
}

/** Abonnement fictif : essai terminé, conditions acceptées ; délai de grâce en cours, ou accès limité. */
async function subscribe(s: School, o: { limited?: boolean; status?: 'AWAITING_PAYMENT' | 'LIMITED' } = {}) {
  const end = o.limited ? day(-40) : day(-10);
  await admin.subscription.create({
    data: {
      tenantId: s.id, status: o.limited ? 'LIMITED' : 'AWAITING_PAYMENT', statusSince: at(o.limited ? day(-24) : addDays(end, 1)), trialStart: new Date(addDays(end, -13)),
      trialEnd: new Date(end), trialDays: 14, acceptedAt: at(addDays(end, 1)), acceptedByName: `Fictif DIRECTION`,
      acceptedTariff: { currency: CUR, pricePerPupil: 500, minimum: 40000, day: addDays(end, 1) }, graceStart: new Date(addDays(end, 1)), graceEnd: new Date(addDays(end, 15)),
      limitedSince: o.limited ? at(day(-24)) : null,
    },
  });
}

/** Document provisoire du lot G5c, tel que l'écrit issue_billing_document (une ligne par établissement). */
async function doc(key: string, groupId: string, kind: 'SUBSCRIPTION' | 'CREDIT_NOTE', issue: string, lines: [string, number, string | null][], o: { due?: string | null; related?: string } = {}) {
  const id = randomUUID();
  const reference = `PROV-G5D2-${stamp}-${key}`.toUpperCase();
  const total = lines.reduce((n, l) => n + l[1], 0);
  await admin.$executeRaw`INSERT INTO billing_documents (id, group_id, kind, reference, currency, "issueDate", "dueDate", total, "yearLabel", "relatedDocumentId", data,
      "createdByKind", "createdByName", "createdAt")
    VALUES (${id}::uuid, ${groupId}::uuid, ${kind}::"BillingDocumentKind", ${reference}, ${CUR}, ${issue}::date, ${o.due ?? null}::date, ${total}, '2026-2027',
            ${o.related ?? null}::uuid, ${JSON.stringify({ title: 'Document fictif (essai G5d-2)' })}::jsonb, 'system', 'Cahiora (tâche planifiée)', ${`${issue}T00:10:00`}::timestamp)`;
  for (const [i, [tenantId, amount, countKind]] of lines.entries()) {
    await admin.$executeRaw`INSERT INTO billing_document_lines (id, "documentId", tenant_id, position, label, amount, "countKind", "referenceDate")
      VALUES (gen_random_uuid(), ${id}::uuid, ${tenantId}::uuid, ${i + 1}, 'Ligne fictive (essai G5d-2)', ${amount}, ${countKind}::"BillingCountKind", ${countKind ? issue : null}::date)`;
  }
  D[key] = { id, reference, total };
  return D[key];
}

/** Enregistre un paiement reçu, avec son justificatif et le code, comme la console. */
async function record(s: School, d: Doc, amount: number | string, ref: string, o: { paidOn?: string; meansCode?: string; note?: string; file?: Buffer | null; code?: string } = {}) {
  return pf.form('/billing/payments', {
    tenantId: s.id, documentId: d.id, amount, paidOn: o.paidOn ?? today, meansCode: o.meansCode ?? code_, transactionRef: ref, ...(o.note ? { note: o.note } : {}),
    code: o.code ?? (await code()),
  }, o.file === undefined ? PNG : o.file);
}

const subscriptionOf = (s: School) => admin.subscription.findUniqueOrThrow({ where: { tenantId: s.id } });
const lastEvent = async (s: School) => (await admin.subscriptionEvent.findMany({ where: { tenantId: s.id }, orderBy: { createdAt: 'desc' }, take: 1 }))[0];
const notes = (s: School, kind: string) => inTenant(s.id, (tx) => tx.notification.findMany({ where: { kind }, orderBy: { createdAt: 'asc' } }));
const schoolJournal = (s: School, action: string) => inTenant(s.id, (tx) => tx.auditLog.findMany({ where: { action }, orderBy: { createdAt: 'asc' } }));
const platformJournal = (s: School, action: string) => admin.platformAuditLog.findMany({ where: { tenantId: s.id, action }, orderBy: { createdAt: 'asc' } });
const groupJournal = (s: School, action: string) => admin.groupAuditLog.findMany({ where: { groupId: s.groupId, action }, orderBy: { createdAt: 'asc' } });
const credit = async (s: School) => {
  const [c] = await admin.$queryRaw<{ balance: number; reserved: number }[]>`SELECT billing_credit_balance(${s.id}::uuid) AS balance, billing_credit_reserved(${s.id}::uuid) AS reserved`;
  return c;
};
const balances = async (s: School) =>
  Object.fromEntries((await admin.$queryRaw<{ reference: string; balance: number }[]>`SELECT reference, balance FROM billing_payable_documents(${s.id}::uuid)`).map((r) => [r.reference, r.balance]));
/** Lignes des tables du lot pour les établissements de ce fichier. */
async function counts() {
  const ids = Object.values(S).map((s) => s.id);
  const [c] = await admin.$queryRaw<Record<string, number>[]>`SELECT
    (SELECT count(*) FROM billing_payments WHERE tenant_id = ANY(${ids}::uuid[]))::int AS payments,
    (SELECT count(*) FROM billing_allocations WHERE tenant_id = ANY(${ids}::uuid[]))::int AS allocations,
    (SELECT count(*) FROM billing_credit_entries WHERE tenant_id = ANY(${ids}::uuid[]))::int AS entries,
    (SELECT count(*) FROM billing_refunds WHERE tenant_id = ANY(${ids}::uuid[]))::int AS refunds,
    (SELECT count(*) FROM billing_credit_transfers WHERE "fromTenantId" = ANY(${ids}::uuid[]))::int AS transfers,
    (SELECT count(*) FROM billing_payment_means WHERE name = ${MEANS_NAME})::int AS means`;
  return c;
}
const fixtureDocs = () => admin.$queryRaw<unknown[]>`
  SELECT to_jsonb(d) AS doc, (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.position) FROM billing_document_lines l WHERE l."documentId" = d.id) AS lines
  FROM billing_documents d WHERE d.reference LIKE ${`PROV-G5D2-${stamp}-%`.toUpperCase()} ORDER BY d.reference`;

/** Écritures du lot et verrou du serveur qu'elles passent, relevés sur les contrôleurs du lot. */
function lotRoutes() {
  const out: { key: string; guarded: boolean }[] = [];
  for (const cls of [BillingPaymentsController, SchoolBillingPaymentsController]) {
    const proto = cls.prototype as unknown as Record<string, object>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const handler = proto[name];
      const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      const verb = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (path === undefined || verb === undefined || RequestMethod[verb] === 'GET') continue;
      const guards = [...(Reflect.getMetadata(GUARDS_METADATA, handler) ?? []), ...(Reflect.getMetadata(GUARDS_METADATA, cls) ?? [])] as unknown[];
      out.push({ key: `${RequestMethod[verb]} /api/v1/${path}`, guarded: guards.includes(PaymentsOpenGuard) });
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

beforeAll(async () => {
  delete process.env[PAYMENTS_LOCK_ENV];
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  configureApp(app);
  await app.init();
  http = request(app.getHttpServer());

  // P, Q, U : écoles seules dans leur groupe ; R1 et R2 : un groupe de deux (D-G5-19 encore ouverte) ; X : en francs CFA.
  S.P = await newSchool('P');
  S.Q = await newSchool('Q');
  S.U = await newSchool('U');
  S.R1 = await newSchool('R1');
  S.R2 = await newSchool('R2', { groupId: S.R1.groupId });
  S.X = await newSchool('X', { currency: 'XOF' });
  await subscribe(S.P);
  await subscribe(S.Q, { limited: true });
  await subscribe(S.U);
  // Proformas de l'abonnement : fin de l'essai (le document du délai de grâce), puis un complément.
  await doc('P1', S.P.groupId, 'SUBSCRIPTION', day(-9), [[S.P.id, 100_000, 'TRIAL_END']], { due: day(5) });
  await doc('P2', S.P.groupId, 'SUBSCRIPTION', day(-3), [[S.P.id, 15_000, 'FIRST_REGULARIZATION']]);
  await doc('Q1', S.Q.groupId, 'SUBSCRIPTION', day(-39), [[S.Q.id, 40_000, 'TRIAL_END']], { due: day(-25) });
  await doc('U1', S.U.groupId, 'SUBSCRIPTION', day(-9), [[S.U.id, 60_000, 'TRIAL_END']], { due: day(5) });
  await doc('R', S.R1.groupId, 'SUBSCRIPTION', day(-9), [[S.R1.id, 40_000, 'TRIAL_END'], [S.R2.id, 40_000, 'TRIAL_END']], { due: day(5) });
  await doc('R1A', S.R1.groupId, 'SUBSCRIPTION', day(-3), [[S.R1.id, 5_000, 'FIRST_REGULARIZATION']]);

  // Super Admin fictif avec double authentification.
  await admin.platformAdmin.create({ data: { email: sa.email, name: sa.name, passwordHash: await argon2.hash(SA_PASSWORD), mustChangePassword: false, mustSetupTwoFactor: false } });
  sa.id = (await admin.platformAdmin.findUniqueOrThrow({ where: { email: sa.email } })).id;
  actor = { id: sa.id, name: sa.name, ip: '127.0.0.1' };
  sa.cookie = cookieOf(await http.post('/api/v1/platform/auth/login').send({ email: sa.email, password: SA_PASSWORD }).expect(201));
  const setup = await pf.post('/auth/2fa/setup').expect(201);
  sa.secret = setup.body.secret;
  await pf.post('/auth/2fa/enable', { code: await code(), setupToken: setup.body.setupToken }).expect(201);
}, 90000);

afterAll(async () => {
  delete process.env[PAYMENTS_LOCK_ENV];
  await app?.close();
  await admin.platformAdmin.deleteMany({ where: { email: sa.email } }).catch(() => undefined);
  await Promise.all([admin.$disconnect(), appDb.$disconnect(), groupDb.$disconnect()]);
});

describe('Lot G5d-2 · verrou du serveur fermé (par défaut, donc en production) : aucune écriture du lot', () => {
  it('le registre des écritures du lot est fermé, et chacune passe par le verrou du serveur', () => {
    expect(paymentsUnlocked()).toBe(false);
    expect(lotRoutes()).toEqual([
      { key: 'POST /api/v1/platform/billing/credit-transfers', guarded: true },
      { key: 'POST /api/v1/platform/billing/payment-means', guarded: true },
      { key: 'POST /api/v1/platform/billing/payments', guarded: true },
      { key: 'POST /api/v1/platform/billing/payments/:id/cancel', guarded: true },
      { key: 'POST /api/v1/platform/billing/refunds/:id/decision', guarded: true },
      { key: 'POST /api/v1/settings/subscription/refund-requests', guarded: true },
    ]);
    // Seule la valeur exacte « true » ouvre le verrou.
    for (const v of [undefined, '', 'false', '1', 'TRUE', 'oui', ' true']) expect(paymentsUnlocked({ [PAYMENTS_LOCK_ENV]: v })).toBe(false);
    expect(paymentsUnlocked({ [PAYMENTS_LOCK_ENV]: 'true' })).toBe(true);
  });

  it('chaque écriture est refusée avant la lecture de la demande, même complète, et rien n’est écrit', async () => {
    const before = await counts();
    const full = { tenantId: S.P.id, documentId: D.P1.id, amount: '1000', paidOn: today, meansCode: 'VIREMENT', transactionRef: `VERROU-${stamp}`, code: await code() };
    const calls = [
      pf.post('/billing/payment-means', { name: MEANS_NAME, instructions: INSTRUCTIONS, currency: CUR, active: true, effectiveFrom: today, reason: 'Essai du verrou', code: full.code }),
      pf.form('/billing/payments', full),
      pf.post('/billing/payments', {}),
      pf.post(`/billing/payments/${UUID}/cancel`, { reason: 'Essai du verrou', code: full.code }),
      pf.form(`/billing/refunds/${UUID}/decision`, { decision: 'REFUNDED', code: full.code }),
      pf.form('/billing/credit-transfers', { fromTenantId: S.R1.id, toTenantId: S.R2.id, amount: '1', authorizedBy: 'Essai du verrou', reason: 'Essai du verrou', code: full.code }),
      school(S.P.direction).post('/settings/subscription/refund-requests', { amount: 1 }),
    ];
    for (const r of await Promise.all(calls)) expect([r.status, msg(r)]).toEqual([403, PAYMENTS_LOCKED]);
    for (const v of ['1', 'TRUE', 'oui']) {
      process.env[PAYMENTS_LOCK_ENV] = v;
      const r = await pf.form('/billing/payments', full);
      expect([v, r.status, msg(r)]).toEqual([v, 403, PAYMENTS_LOCKED]);
    }
    delete process.env[PAYMENTS_LOCK_ENV];
    expect(await counts()).toEqual(before);
    // Sans connexion, la garde de la plateforme répond d'abord : rien ne dit l'état du verrou.
    expect((await http.post('/api/v1/platform/billing/payments').send({})).status).toBe(401);
  });

  it('les lectures restent ouvertes : la console le dit, aucun moyen de paiement n’est montré aux établissements', async () => {
    const o = (await pf.get('/billing/payments').expect(200)).body;
    expect(o).toMatchObject({ unlocked: false, lockMessage: PAYMENTS_LOCKED, mention: RECEIPT_MENTION });
    const p = o.establishments.find((e: { tenantId: string }) => e.tenantId === S.P.id);
    expect(p).toMatchObject({
      alone: true, groupPending: null, currency: CUR, means: [], credit: { balance: 0, reserved: 0, available: 0 },
      graceDocument: { id: D.P1.id, reference: D.P1.reference, balance: 100_000 }, subscription: { status: 'AWAITING_PAYMENT' },
    });
    expect(p.documents.map((d: { reference: string; status: string; balance: number }) => [d.reference, d.status, d.balance])).toEqual([
      [D.P1.reference, 'PENDING', 100_000], [D.P2.reference, 'PENDING', 15_000],
    ]);
    expect(o.establishments.find((e: { tenantId: string }) => e.tenantId === S.R1.id)).toMatchObject({ alone: false, groupPending: GROUP_PAYMENT_PENDING, documents: [], means: [] });
    expect((await pf.get('/billing/credits').expect(200)).body).toMatchObject({ unlocked: false, lockMessage: PAYMENTS_LOCKED });
    const v = await view(S.P);
    expect(v.access.paymentMeansActive).toBe(false);
    expect(v.regularization).toMatchObject({
      paymentMeans: [], paymentsOpen: false, refundOpen: false, refundNote: REFUNDS_CLOSED, receipts: [], paid: 0, balance: 115_000, receiptMention: RECEIPT_MENTION,
      credit: { balance: 0, reserved: 0, available: 0, entries: [] },
    });
    expect(v.regularization.lines.map((l: { reference: string; payment: { status: string } }) => [l.reference, l.payment.status])).toEqual([
      [D.P1.reference, 'PENDING'], [D.P2.reference, 'PENDING'],
    ]);
  });
});

describe('Lot G5d-2 · essai 13 du cahier : utilisation d’un avoir (verrou fermé : aucun argent ne circule)', () => {
  const impute = (s: School, id: string) => app.get(PlatformDb).$transaction((tx) => imputeCreditNote(tx, id, { id: s.id, name: s.name, groupId: s.groupId }, actor));
  const deduct = (s: School) => app.get(PlatformDb).$transaction((tx) => useCredit(tx, { id: s.id, name: s.name, groupId: s.groupId }, null));

  it('un avoir va au document qu’il corrige, puis aux autres documents, puis au crédit ; l’accès suit (choix 1 A et 2 A)', async () => {
    await doc('UAV1', S.U.groupId, 'CREDIT_NOTE', today, [[S.U.id, 10_000, null]], { related: D.U1.id });
    const a1 = await impute(S.U, D.UAV1.id);
    expect(a1).toEqual({
      creditNoteId: D.UAV1.id, allocated: 10_000, credit: 0, allocations: [{ reference: D.U1.reference, amount: 10_000 }],
      access: { kind: null, wasLimited: false, graceDocument: { reference: D.U1.reference, balance: 50_000 }, status: 'AWAITING_PAYMENT' },
    });
    // Un avoir au-delà de ce qui reste à payer : le document est couvert, le reste devient un crédit de l'établissement.
    await doc('UAV2', S.U.groupId, 'CREDIT_NOTE', today, [[S.U.id, 55_000, null]], { related: D.U1.id });
    const a2 = await impute(S.U, D.UAV2.id);
    expect(a2).toMatchObject({ allocated: 50_000, credit: 5_000, allocations: [{ reference: D.U1.reference, amount: 50_000 }], access: { kind: 'RESTORED', status: 'ACTIVE' } });
    expect(await subscriptionOf(S.U)).toMatchObject({ status: 'ACTIVE', limitedSince: null });
    expect(await lastEvent(S.U)).toMatchObject({
      kind: 'SUBSCRIPTION_PAID', fromStatus: 'AWAITING_PAYMENT', toStatus: 'ACTIVE', actorKind: 'platform', actorId: sa.id,
      data: { cause: 'CREDIT_NOTE', creditNoteId: D.UAV2.id, graceDocument: D.U1.reference, graceDocumentBalance: 0, limitationLifted: false },
    });
    expect(await credit(S.U)).toEqual({ balance: 5_000, reserved: 0 });
    expect((await platformJournal(S.U, 'billing.credit_note_imputed')).map((l) => (l.data as { allocated: number }).allocated)).toEqual([10_000, 50_000]);
    // Un avoir ne s'impute qu'une fois.
    await expect(impute(S.U, D.UAV2.id)).rejects.toThrow('CAHIORA: cet avoir est déjà imputé');
  });

  it('le crédit se déduit du document suivant, une seule fois (D-G5-15 A) ; la direction le lit', async () => {
    await doc('U2', S.U.groupId, 'SUBSCRIPTION', today, [[S.U.id, 8_000, 'FIRST_REGULARIZATION']]);
    const used = await deduct(S.U);
    expect(used).toMatchObject({ used: 5_000, documents: [{ documentId: D.U2.id, reference: D.U2.reference, amount: 5_000 }], access: { kind: null, status: 'ACTIVE' } });
    // Jamais deux fois : plus rien à déduire.
    expect(await deduct(S.U)).toBeNull();
    expect(await credit(S.U)).toEqual({ balance: 0, reserved: 0 });
    expect(await balances(S.U)).toEqual({ [D.U1.reference]: 0, [D.U2.reference]: 3_000 });
    const v = await view(S.U);
    const line = (ref: string) => v.regularization.lines.find((l: { reference: string }) => l.reference === ref);
    expect(line(D.U1.reference).payment).toMatchObject({ status: 'CANCELLED', label: 'Annulé par avoir', due: 0, paid: 0, balance: 0 });
    expect(line(D.U2.reference).payment).toMatchObject({ status: 'PARTIAL', label: 'Partiellement payé', due: 8_000, paid: 5_000, balance: 3_000 });
    expect(v.regularization.credit).toMatchObject({ balance: 0, reserved: 0, available: 0 });
    expect(v.regularization.credit.entries.map((e: { kind: string; amount: number }) => [e.kind, e.amount]).sort()).toEqual([['CREDIT_NOTE_SURPLUS', 5_000], ['USE', -5_000]]);
  });

  it('l’avoir d’un document de plusieurs établissements attend D-G5-19 et D-G5-32 : rien n’est imputé ; un document d’un seul établissement du groupe l’est', async () => {
    const before = await counts();
    await doc('RAV', S.R1.groupId, 'CREDIT_NOTE', today, [[S.R1.id, 2_500, null]], { related: D.R.id });
    expect(await impute(S.R1, D.RAV.id)).toBeNull();
    expect(await counts()).toEqual(before);
    // R1 seul sur ce complément : l'avoir s'impute, son surplus devient le crédit de R1 (transféré plus loin).
    await doc('R1AV', S.R1.groupId, 'CREDIT_NOTE', today, [[S.R1.id, 7_000, null]], { related: D.R1A.id });
    expect(await impute(S.R1, D.R1AV.id)).toMatchObject({ allocated: 5_000, credit: 2_000 });
    expect(await credit(S.R1)).toEqual({ balance: 2_000, reserved: 0 });
    docsBefore = await fixtureDocs();
  });
});

describe('Lot G5d-2 · verrou du serveur ouvert (processus d’essai seulement) : moyens de paiement (verrou 2)', () => {
  beforeAll(() => {
    process.env[PAYMENTS_LOCK_ENV] = 'true';
  });

  it('un moyen se crée daté, motivé, avec le code ; il n’est montré qu’aux établissements de sa monnaie, seuls dans leur groupe', async () => {
    const body = { name: MEANS_NAME, instructions: INSTRUCTIONS, currency: CUR, active: true, effectiveFrom: today, reason: 'Moyen fictif pour les essais du lot G5d-2' };
    const before = await counts();
    const bad = await pf.post('/billing/payment-means', { ...body, code: authenticator.generate(sa.secret) === '000000' ? '111111' : '000000' });
    expect([bad.status, msg(bad)]).toEqual([403, 'Code de votre application incorrect ou expiré']);
    const past = await pf.post('/billing/payment-means', { ...body, effectiveFrom: day(-1), code: await code() });
    expect([past.status, msg(past)]).toEqual([400, 'La date d’effet ne peut pas être passée']);
    const money = await pf.post('/billing/payment-means', { ...body, currency: 'EUR', code: await code() });
    expect([money.status, msg(money)]).toEqual([400, 'Monnaie non prise en charge']);
    expect(await counts()).toEqual(before);
    const ok = await pf.post('/billing/payment-means', { ...body, code: await code() });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ code: meansCode(MEANS_NAME), version: 1 });
    code_ = ok.body.code;
    const twin = await pf.post('/billing/payment-means', { ...body, code: await code() });
    expect([twin.status, msg(twin)]).toEqual([400, 'Un moyen de paiement porte déjà ce nom : modifiez-le plutôt']);
    const log = await admin.platformAuditLog.findFirstOrThrow({ where: { action: 'billing.payment_means_added', data: { path: ['code'], equals: code_ } } });
    expect(log).toMatchObject({ adminId: sa.id, data: { code: code_, version: 1, name: MEANS_NAME, currency: CUR, active: true, effectiveFrom: today, reason: body.reason } });

    const p = await view(S.P);
    expect(p.access.paymentMeansActive).toBe(true);
    expect(p.regularization.paymentsOpen).toBe(true);
    expect(p.regularization.paymentMeans).toContainEqual({ code: code_, name: MEANS_NAME, instructions: INSTRUCTIONS });
    expect((await view(S.X)).regularization).toBeNull(); // X n'a pas d'abonnement : rien à régulariser.
    const r1 = await view(S.R1);
    expect(r1.access).toBeNull();
    const o = (await pf.get('/billing/payments')).body;
    expect(o.unlocked).toBe(true);
    expect(o.establishments.find((e: { tenantId: string }) => e.tenantId === S.P.id).means).toContainEqual({ code: code_, name: MEANS_NAME });
    expect(o.establishments.find((e: { tenantId: string }) => e.tenantId === S.R1.id).means).toEqual([]);
    expect(o.means.current.find((m: { code: string }) => m.code === code_)).toMatchObject({ version: 1, active: true, currency: CUR, createdByName: sa.name });
  });
});

describe('Lot G5d-2 · essais 11 et 12 du cahier : paiement partiel, puis excédentaire (choix 1 A et 2 A)', () => {
  it('essai 11 : un paiement partiel va au document concerné, avec son reçu provisoire ; l’accès ne change pas (D-G5-43 A)', async () => {
    const r = await record(S.P, D.P1, 30_000, `REF-P1-${stamp}`, { note: NOTE });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      receiptNumber: expect.stringMatching(/^PROV-REC-\d{6,}$/), tenantId: S.P.id, documentId: D.P1.id, documentReference: D.P1.reference, currency: CUR, expectedAmount: 100_000,
      amount: 30_000, paidOn: today, meansName: MEANS_NAME, transactionRef: `REF-P1-${stamp}`, creditAmount: 0, note: NOTE, recordedByName: sa.name, status: 'VALIDATED',
      allocations: [{ reference: D.P1.reference, amount: 30_000 }], expected: 100_000, allocated: 30_000, credit: 0, access: { kind: null, status: 'AWAITING_PAYMENT' },
    });
    pay.P1 = r.body;
    expect((await subscriptionOf(S.P)).status).toBe('AWAITING_PAYMENT');
    // Ce que lit la direction : état de chaque document, reçu provisoire, sans le nom de l'agent ni le commentaire interne.
    const v = await view(S.P);
    expect(v.regularization.lines[0].payment).toEqual({ status: 'PARTIAL', label: 'Partiellement payé', overdue: false, due: 100_000, paid: 30_000, balance: 70_000 });
    expect(v.regularization).toMatchObject({ paid: 30_000, balance: 85_000, payment: 'Payé : 30 000 GNF ; reste à payer : 85 000 GNF.', dueDate: day(5) });
    expect(v.regularization.receipts).toEqual([{
      id: pay.P1.id, receiptNumber: pay.P1.receiptNumber, documentReference: D.P1.reference, currency: CUR, amount: 30_000, paidOn: today, meansName: MEANS_NAME,
      transactionRef: `REF-P1-${stamp}`, creditAmount: 0, recordedAt: expect.any(String), cancelled: false, allocations: [{ reference: D.P1.reference, amount: 30_000 }],
      statusLabel: 'Paiement validé par Cahiora',
    }]);
    const receipt = (await school(S.P.direction).get(`/settings/subscription/receipts/${pay.P1.id}`).expect(200)).body;
    expect(receipt).toMatchObject({ receiptNumber: pay.P1.receiptNumber, title: `Reçu provisoire ${pay.P1.receiptNumber}`, issuer: 'Cahiora', mention: RECEIPT_MENTION, cancelled: null });
    expect(receipt.lines).toContainEqual(['Montant reçu', '30 000 GNF']);
    expect(receipt.lines).toContainEqual(['Enregistré par', 'Cahiora']);
    expect(JSON.stringify([v, receipt])).not.toContain(sa.name);
    expect(JSON.stringify([v, receipt])).not.toContain(NOTE);
    // Notification de la direction, journaux : le commentaire interne reste au journal de la plateforme.
    const [n] = await notes(S.P, 'billing.payment_recorded');
    expect(n.title).toBe(`Paiement reçu par Cahiora : reçu provisoire ${pay.P1.receiptNumber}`);
    expect(n.body).toContain(`Cahiora a enregistré votre paiement de 30 000 GNF`);
    expect(n.body).toContain(`Il reste 70 000 GNF à payer sur le document ${D.P1.reference}.`);
    expect(n.body).toContain(RECEIPT_MENTION);
    expect(n.body).not.toContain(NOTE);
    expect((await platformJournal(S.P, 'billing.payment_recorded'))[0].data).toMatchObject({ receiptNumber: pay.P1.receiptNumber, amount: 30_000, note: NOTE });
    expect(JSON.stringify(await groupJournal(S.P, 'billing.payment_recorded'))).not.toContain(NOTE);
    const [sj] = await schoolJournal(S.P, 'billing.payment_recorded');
    expect(sj.data).toMatchObject({ receiptNumber: pay.P1.receiptNumber, amount: 30_000 });
    expect(JSON.stringify(sj.data)).not.toContain(NOTE);
    // Le justificatif reste à Cahiora, par un lien signé et temporaire.
    const detail = (await pf.get(`/billing/payments/${pay.P1.id}`).expect(200)).body;
    expect(detail).toMatchObject({ proofMime: 'image/png', receipt: { receiptNumber: pay.P1.receiptNumber, mention: RECEIPT_MENTION } });
    const proof = await http.get(detail.proofUrl);
    expect([proof.status, proof.headers['content-type']]).toEqual([200, 'image/png']);
  });

  it('accès limité : un paiement partiel le laisse limité (D-G5-43 A), la demande de remboursement y reste fermée', async () => {
    const r = await record(S.Q, D.Q1, 10_000, `REF-Q1-${stamp}`);
    expect(r.body).toMatchObject({ allocations: [{ reference: D.Q1.reference, amount: 10_000 }], credit: 0, access: { kind: null, status: 'LIMITED' } });
    pay.Q1 = r.body;
    const v = await view(S.Q);
    expect(v.access).toMatchObject({ status: 'LIMITED', phase: 'LIMITED' });
    expect(v.regularization.lines[0].payment).toMatchObject({ status: 'PARTIAL', label: 'Partiellement payé, en retard', overdue: true, balance: 30_000 });
    const refund = await school(S.Q.direction).post('/settings/subscription/refund-requests', { amount: 1 });
    expect([refund.status, msg(refund)]).toEqual([403, LIMITED_REFUSAL.staff]);
  });

  it('une même référence ne s’enregistre qu’une fois (espaces et casse ignorés) ; toute saisie invalide est refusée sans rien écrire', async () => {
    const before = await counts();
    const twin = await record(S.P, D.P1, 1_000, `ref-p1 -${stamp}`);
    expect([twin.status, msg(twin)]).toEqual([409, `Cette référence de transaction est déjà enregistrée (reçu ${pay.P1.receiptNumber}) : un même paiement ne s’enregistre qu’une fois`]);
    const refused = async (r: request.Response, status: number, message: string | RegExp) => {
      expect(r.status).toBe(status);
      expect(msg(r)).toMatch(message);
      expect(msg(r)).not.toMatch(/[`"]/); // rien de l'emballage de Prisma n'atteint l'écran
    };
    await refused(await record(S.P, D.P1, 1_000, `SANS-PREUVE-${stamp}`, { file: null }), 400, 'Justificatif du paiement : joignez la preuve (photo ou PDF)');
    await refused(await record(S.P, D.P1, 1_000, `FUTUR-${stamp}`, { paidOn: day(1) }), 400, 'La date du paiement ne peut pas être dans le futur');
    await refused(await record(S.P, D.P1, 1_000, `AVANT-${stamp}`, { paidOn: day(-10) }), 400, /^Un paiement ne précède pas le document qu’il règle/);
    await refused(await record(S.P, D.P1, 0, `ZERO-${stamp}`), 400, 'Montant reçu : nombre entier de 1 à 1 000 000 000');
    await refused(await record(S.P, D.P1, '12,5', `DECIMAL-${stamp}`), 400, 'Montant : nombre entier, sans espace ni décimale');
    await refused(await record(S.P, D.P1, 1_000, `MOYEN-${stamp}`, { meansCode: 'MOYEN_INCONNU' }), 400, /n.était pas activé par Cahiora le jour du paiement/);
    await refused(await record(S.P, D.U1, 1_000, `AUTRE-${stamp}`), 400, /n.est pas adressé à cet établissement/);
    await refused(await record(S.P, D.UAV1, 1_000, `AVOIR-${stamp}`), 400, /proforma de l.abonnement à payer est attendue/);
    await refused(await record(S.R1, D.R, 1_000, `GROUPE-${stamp}`), 400, GROUP_PAYMENT_PENDING);
    await refused(await record(S.R1, D.R1A, 1_000, `GROUPE-SEUL-${stamp}`), 400, GROUP_PAYMENT_PENDING);
    await refused(await record(S.P, D.P1, 1_000, `CODE-${stamp}`, { code: authenticator.generate(sa.secret) === '000000' ? '111111' : '000000' }), 403, 'Code de votre application incorrect ou expiré');
    expect(await counts()).toEqual(before);
  });

  it('essai 12 : un paiement excédentaire paie le document concerné, puis le plus ancien des autres, puis devient un crédit ; l’accès complet revient (choix 2 A)', async () => {
    const r = await record(S.P, D.P1, 90_000, `REF-P2-${stamp}`);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      expected: 70_000, allocated: 85_000, credit: 5_000, creditAmount: 5_000, access: { kind: 'RESTORED', status: 'ACTIVE' },
      allocations: [{ reference: D.P1.reference, amount: 70_000 }, { reference: D.P2.reference, amount: 15_000 }],
    });
    pay.P2 = r.body;
    expect(await subscriptionOf(S.P)).toMatchObject({ status: 'ACTIVE', limitedSince: null });
    expect(await lastEvent(S.P)).toMatchObject({
      kind: 'SUBSCRIPTION_PAID', fromStatus: 'AWAITING_PAYMENT', toStatus: 'ACTIVE', actorKind: 'platform', actorId: sa.id, actorName: sa.name,
      data: { cause: 'PAYMENT', receiptNumber: pay.P2.receiptNumber, graceDocument: D.P1.reference, graceDocumentBalance: 0, limitationLifted: false },
    });
    for (const journal of [platformJournal, groupJournal, schoolJournal]) expect(await journal(S.P, 'billing.subscription_paid')).toHaveLength(1);
    expect(await credit(S.P)).toEqual({ balance: 5_000, reserved: 0 });
    const n = (await notes(S.P, 'billing.payment_recorded'))[1];
    expect(n.body).toContain(`Imputé sur ${D.P1.reference} (70 000 GNF), ${D.P2.reference} (15 000 GNF).`);
    expect(n.body).toContain('5 000 GNF deviennent un crédit de votre établissement, déduit du prochain document.');
    expect(n.body).toContain(`Le document ${D.P1.reference} est entièrement payé : l’accès complet à Cahiora est rétabli.`);
    const v = await view(S.P);
    expect(v.access).toMatchObject({ status: 'ACTIVE', phase: 'ACTIVE' });
    expect(v.regularization.lines.map((l: { payment: { status: string } }) => l.payment.status)).toEqual(['PAID', 'PAID']);
    expect(v.regularization).toMatchObject({ paid: 115_000, balance: 0, payment: 'Payé : 115 000 GNF ; rien ne reste à payer.', credit: { balance: 5_000, available: 5_000 }, refundOpen: true });
  });

  it('accès limité : le document du délai de grâce entièrement payé lève la limitation, le surplus devient un crédit', async () => {
    const r = await record(S.Q, D.Q1, 35_000, `REF-Q2-${stamp}`);
    expect(r.body).toMatchObject({ allocations: [{ reference: D.Q1.reference, amount: 30_000 }], credit: 5_000, access: { kind: 'RESTORED', status: 'ACTIVE' } });
    pay.Q2 = r.body;
    expect(await lastEvent(S.Q)).toMatchObject({ kind: 'SUBSCRIPTION_PAID', fromStatus: 'LIMITED', toStatus: 'ACTIVE', data: { limitationLifted: true } });
    expect((await notes(S.Q, 'billing.payment_recorded'))[1].body).toContain('l’accès complet à Cahiora est rétabli, l’accès limité est levé.');
    // L'accès complet est rendu aussitôt (cache de l'accès vidé) : une saisie n'est plus refusée pour l'accès limité.
    const write = await school(S.Q.direction).post('/settings/subscription/regularization-requests', {});
    expect(msg(write)).not.toBe(LIMITED_REFUSAL.staff);
    expect((await view(S.Q)).access).toMatchObject({ status: 'ACTIVE', phase: 'ACTIVE' });
  });
});

describe('Lot G5d-2 · une saisie erronée s’annule par une contre-écriture motivée', () => {
  it('une seule fois : imputations et crédit repris, rien n’est supprimé, l’abonnement revient en attente de paiement', async () => {
    const before = await admin.billingPayment.findUniqueOrThrow({ where: { id: pay.P2.id } });
    const c = await pf.post(`/billing/payments/${pay.P2.id}/cancel`, { reason: CANCEL_REASON, code: await code() });
    expect(c.status).toBe(201);
    expect(c.body).toEqual({
      paymentId: pay.P2.id, receiptNumber: pay.P2.receiptNumber, amount: 90_000, reversed: 85_000, creditReversed: 5_000, usesReversed: 0,
      access: { kind: 'REVERSED', status: 'AWAITING_PAYMENT' },
    });
    const again = await pf.post(`/billing/payments/${pay.P2.id}/cancel`, { reason: CANCEL_REASON, code: await code() });
    expect([again.status, msg(again)]).toEqual([409, 'Ce paiement est déjà annulé']);
    // Le paiement reste tel quel, marqué annulé ; ses imputations sont reprises par des lignes négatives.
    const after = await admin.billingPayment.findUniqueOrThrow({ where: { id: pay.P2.id } });
    expect({ ...after, cancelledAt: null, cancelledById: null, cancelledByName: null, cancelReason: null, cancelIp: null }).toEqual(before);
    expect(after).toMatchObject({ cancelledById: sa.id, cancelledByName: sa.name, cancelReason: CANCEL_REASON });
    expect((await admin.billingAllocation.findMany({ where: { paymentId: pay.P2.id } })).map((a) => a.amount).sort((a, b) => a - b)).toEqual([-70_000, -15_000, 15_000, 70_000]);
    expect(await credit(S.P)).toEqual({ balance: 0, reserved: 0 });
    expect(await balances(S.P)).toEqual({ [D.P1.reference]: 70_000, [D.P2.reference]: 15_000 });
    expect(await subscriptionOf(S.P)).toMatchObject({ status: 'AWAITING_PAYMENT' });
    expect(await lastEvent(S.P)).toMatchObject({
      kind: 'SUBSCRIPTION_PAYMENT_REVERSED', fromStatus: 'ACTIVE', toStatus: 'AWAITING_PAYMENT',
      data: { cause: 'PAYMENT_CANCELLED', receiptNumber: pay.P2.receiptNumber, graceDocument: D.P1.reference, graceDocumentBalance: 70_000 },
    });
    // Le motif reste à Cahiora : ni la direction, ni le journal de l'école, ni celui du groupe ne le lisent.
    expect((await platformJournal(S.P, 'billing.payment_cancelled'))[0].data).toMatchObject({ receiptNumber: pay.P2.receiptNumber, reason: CANCEL_REASON });
    expect(JSON.stringify(await groupJournal(S.P, 'billing.payment_cancelled'))).not.toContain(CANCEL_REASON);
    expect(JSON.stringify(await schoolJournal(S.P, 'billing.payment_cancelled'))).not.toContain(CANCEL_REASON);
    const [n] = await notes(S.P, 'billing.payment_cancelled');
    expect(n.body).toContain(`Le document ${D.P1.reference} attend à nouveau son paiement : l’abonnement revient en attente de paiement.`);
    expect(n.body).not.toContain(CANCEL_REASON);
    const v = await view(S.P);
    const cancelled = v.regularization.receipts.find((x: { id: string }) => x.id === pay.P2.id);
    expect(cancelled).toMatchObject({ cancelled: true, statusLabel: 'Saisie annulée par Cahiora' });
    expect(JSON.stringify(v)).not.toContain(CANCEL_REASON);
    const receipt = (await school(S.P.direction).get(`/settings/subscription/receipts/${pay.P2.id}`).expect(200)).body;
    expect(receipt.cancelled).toMatch(/^Saisie annulée par Cahiora le .+ : ce reçu ne vaut plus\.$/);
  });

  it('la référence d’une saisie annulée peut servir au paiement corrigé ; l’accès complet revient', async () => {
    const r = await record(S.P, D.P1, 85_000, `REF-P2-${stamp}`);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ allocated: 85_000, credit: 0, access: { kind: 'RESTORED', status: 'ACTIVE' } });
    pay.P3 = r.body;
    expect(await balances(S.P)).toEqual({ [D.P1.reference]: 0, [D.P2.reference]: 0 });
  });

  it('l’annulation reprend les déductions de crédit faites grâce au paiement ; un trop-perçu réservé par une demande de remboursement ne se reprend pas', async () => {
    await doc('P3', S.P.groupId, 'SUBSCRIPTION', today, [[S.P.id, 12_000, 'FINAL_REGULARIZATION']]);
    const r = await record(S.P, D.P3, 20_000, `REF-P3-${stamp}`);
    expect(r.body).toMatchObject({ allocations: [{ reference: D.P3.reference, amount: 12_000 }], credit: 8_000 });
    pay.P4 = r.body;
    // Un nouveau document : le crédit s'en déduit aussitôt, comme à l'émission.
    await doc('P4', S.P.groupId, 'SUBSCRIPTION', today, [[S.P.id, 6_000, 'FINAL_REGULARIZATION']]);
    const used = await app.get(PlatformDb).$transaction((tx) => useCredit(tx, { id: S.P.id, name: S.P.name, groupId: S.P.groupId }, null));
    expect(used).toMatchObject({ used: 6_000, documents: [{ reference: D.P4.reference, amount: 6_000 }] });
    const c = await pf.post(`/billing/payments/${pay.P4.id}/cancel`, { reason: CANCEL_REASON, code: await code() });
    expect(c.body).toMatchObject({ reversed: 12_000, creditReversed: 8_000, usesReversed: 6_000, access: { kind: null, status: 'ACTIVE' } });
    expect(await credit(S.P)).toEqual({ balance: 0, reserved: 0 });
    expect(await balances(S.P)).toMatchObject({ [D.P3.reference]: 12_000, [D.P4.reference]: 6_000 });
    expect((await notes(S.P, 'billing.payment_cancelled'))[1].body).toContain('6 000 GNF de crédit déduits grâce à ce paiement sont repris : les documents concernés attendent à nouveau leur paiement.');
    // Nouveau paiement : 7 000 de crédit, aussitôt demandés en remboursement (réservés) ; son annulation est refusée.
    const p = await record(S.P, D.P3, 25_000, `REF-P4-${stamp}`);
    expect(p.body).toMatchObject({ allocations: [{ reference: D.P3.reference, amount: 12_000 }, { reference: D.P4.reference, amount: 6_000 }], credit: 7_000 });
    pay.P5 = p.body;
    expect((await school(S.P.direction).post('/settings/subscription/refund-requests', { amount: 7_000 })).status).toBe(201);
    const before = await counts();
    const refused = await pf.post(`/billing/payments/${pay.P5.id}/cancel`, { reason: CANCEL_REASON, code: await code() });
    expect(refused.status).toBe(400);
    expect(msg(refused)).toMatch(/ne peut plus être repris[^`]*$/);
    expect(await counts()).toEqual(before);
  });
});

describe('Lot G5d-2 · essai 14 du cahier : demande de remboursement', () => {
  let refundId = '';
  const decide = async (id: string, fields: Record<string, string>, file: Buffer | null = null) => pf.form(`/billing/refunds/${id}/decision`, { ...fields, code: await code() }, file);

  it('la direction de tout l’établissement demande, au plus son crédit disponible, une demande à la fois ; Cahiora est alerté', async () => {
    const comptable = await school(S.Q.comptable).post('/settings/subscription/refund-requests', { amount: 1 });
    expect([comptable.status, msg(comptable)]).toEqual([403, 'Votre rôle ne permet pas cette action']);
    const tooMuch = await school(S.Q.direction).post('/settings/subscription/refund-requests', { amount: 6_000 });
    expect([tooMuch.status, msg(tooMuch)]).toEqual([400, 'Montant : au plus le crédit disponible (5000)']);
    // Un crédit consommé (déduit d'un document) ne se rembourse pas.
    const consumed = await school(S.U.direction).post('/settings/subscription/refund-requests', { amount: 1 });
    expect([consumed.status, msg(consumed)]).toEqual([400, 'Aucun crédit disponible à rembourser']);
    const r = await school(S.Q.direction).post('/settings/subscription/refund-requests', { amount: 2_000, message: '  Remboursement fictif demandé (essai G5d-2)  ' });
    expect(r.status).toBe(201);
    refundId = r.body.id;
    const again = await school(S.Q.direction).post('/settings/subscription/refund-requests', { amount: 1 });
    expect([again.status, msg(again)]).toEqual([400, 'Une demande de remboursement attend déjà la décision de Cahiora']);
    const alert = await admin.platformAlert.findFirstOrThrow({ where: { tenantId: S.Q.id, kind: 'REFUND_REQUEST' } });
    expect(alert.message).toBe(`${S.Q.name} demande le remboursement de 2 000 GNF de son crédit (demande de Fictif DIRECTION Q). Décidez dans Commercial et facturation › Avoirs et crédits.`);
    expect(await platformJournal(S.Q, 'billing.refund_requested')).toHaveLength(1);
    expect(await groupJournal(S.Q, 'billing.refund_requested')).toHaveLength(1);
    expect((await schoolJournal(S.Q, 'billing.refund_requested'))[0].data).toEqual({ amount: 2_000, message: 'Remboursement fictif demandé (essai G5d-2)' });
    const v = await view(S.Q);
    expect(v.regularization).toMatchObject({
      credit: { balance: 5_000, reserved: 2_000, available: 3_000 }, refundOpen: false, refundNote: 'Une demande de remboursement attend la décision de Cahiora : son montant est réservé.',
      refunds: [{ id: refundId, amount: 2_000, status: 'PENDING', statusLabel: 'Demandé', message: 'Remboursement fictif demandé (essai G5d-2)', requestedByName: 'Fictif DIRECTION Q' }],
    });
  });

  it('Cahiora refuse avec un motif (le montant reste au crédit) ou rembourse avec sa preuve ; une décision ne se refait pas', async () => {
    const noReason = await decide(refundId, { decision: 'REFUSED' });
    expect([noReason.status, msg(noReason)]).toEqual([400, 'Un refus exige un motif (5 caractères au moins)']);
    const no = await decide(refundId, { decision: 'REFUSED', note: 'Refus fictif : crédit gardé pour la prochaine année (essai).' });
    expect(no.status).toBe(201);
    expect(no.body).toEqual({ id: refundId, status: 'REFUSED', statusLabel: 'Refusé', amount: 2_000, creditUsed: 0 });
    const twice = await decide(refundId, { decision: 'REFUNDED', refundedOn: today, means: 'Virement fictif', reference: `RMB-${stamp}` }, PNG);
    expect([twice.status, msg(twice)]).toEqual([409, 'Cette demande est déjà décidée']);
    expect(await credit(S.Q)).toEqual({ balance: 5_000, reserved: 0 });
    expect((await notes(S.Q, 'billing.refund_refused'))[0].body).toContain('Refus fictif : crédit gardé pour la prochaine année (essai). Le montant reste dans votre crédit.');

    const r = await school(S.Q.direction).post('/settings/subscription/refund-requests', { amount: 5_000 });
    expect(r.status).toBe(201);
    const fields = { decision: 'REFUNDED', refundedOn: today, means: 'Virement fictif', reference: `RMB-${stamp}` };
    const noProof = await decide(r.body.id, fields);
    expect([noProof.status, msg(noProof)]).toEqual([400, 'Preuve du remboursement : joignez le justificatif (photo ou PDF)']);
    const future = await decide(r.body.id, { ...fields, refundedOn: day(1) }, PNG);
    expect([future.status, msg(future)]).toEqual([400, 'La date du remboursement ne peut pas être dans le futur']);
    const ok = await decide(r.body.id, fields, PNG);
    expect(ok.status).toBe(201);
    expect(ok.body).toEqual({ id: r.body.id, status: 'REFUNDED', statusLabel: 'Remboursé', amount: 5_000, creditUsed: 0 });
    expect(await credit(S.Q)).toEqual({ balance: 0, reserved: 0 });
    expect((await notes(S.Q, 'billing.refund_refunded'))[0].title).toBe('Remboursement de Cahiora : 5 000 GNF');
    const c = (await pf.get('/billing/credits').expect(200)).body;
    expect(c.refunds.find((x: { id: string }) => x.id === r.body.id)).toMatchObject({
      status: 'REFUNDED', refundedOn: today, refundMeans: 'Virement fictif', refundRef: `RMB-${stamp}`, decidedByName: sa.name, proofUrl: expect.stringMatching(/^\/api\/v1\/files\?/),
    });
    const v = await view(S.Q);
    expect(v.regularization.refunds[0]).toMatchObject({ status: 'REFUNDED', refundMeans: 'Virement fictif', refundRef: `RMB-${stamp}` });
    expect(v.regularization.credit.entries[0]).toMatchObject({ kind: 'REFUND', amount: -5_000 });
    // Un crédit remboursé ne se rembourse pas deux fois.
    const more = await school(S.Q.direction).post('/settings/subscription/refund-requests', { amount: 1 });
    expect([more.status, msg(more)]).toEqual([400, 'Aucun crédit disponible à rembourser']);
  });

  it('un refus libère le montant réservé, aussitôt déduit des documents à payer s’il y en a', async () => {
    const p = (await pf.get('/billing/credits')).body.refunds.find((x: { tenantId: string; status: string }) => x.tenantId === S.P.id && x.status === 'PENDING');
    const r = await decide(p.id, { decision: 'REFUSED', note: 'Refus fictif (essai G5d-2) : rien à rembourser pour le moment.' });
    expect(r.body).toMatchObject({ status: 'REFUSED', creditUsed: 0 });
    expect(await credit(S.P)).toEqual({ balance: 7_000, reserved: 0 });
  });
});

describe('Lot G5d-2 · transfert d’un crédit entre établissements d’un même groupe', () => {
  const transfer = async (fields: Record<string, string | number>, file: Buffer | null = null) =>
    pf.form('/billing/credit-transfers', { authorizedBy: 'Accord écrit fictif du promoteur du groupe (essai)', reason: 'Regroupement fictif des crédits (essai G5d-2)', ...fields, code: await code() }, file);

  it('avec l’autorisation, un motif et le code : deux écritures, la trace dans les journaux, rien hors du groupe', async () => {
    const before = await counts();
    const outside = await transfer({ fromTenantId: S.R1.id, toTenantId: S.P.id, amount: 100 });
    expect([outside.status, msg(outside)]).toEqual([400, 'Un crédit ne se transfère qu’entre établissements d’un même groupe']);
    const self = await transfer({ fromTenantId: S.R1.id, toTenantId: S.R1.id, amount: 100 });
    expect([self.status, msg(self)]).toEqual([400, 'Choisissez un autre établissement que celui qui cède le crédit']);
    const tooMuch = await transfer({ fromTenantId: S.R1.id, toTenantId: S.R2.id, amount: 2_500 });
    expect([tooMuch.status, msg(tooMuch)]).toEqual([400, 'Montant : au plus le crédit disponible (2000)']);
    const noAuth = await transfer({ fromTenantId: S.R1.id, toTenantId: S.R2.id, amount: 100, authorizedBy: 'non' });
    expect([noAuth.status, msg(noAuth)]).toEqual([400, 'Autorisation : qui l’a donnée et par quel écrit (5 à 300 caractères)']);
    expect(await counts()).toEqual(before);

    const ok = await transfer({ fromTenantId: S.R1.id, toTenantId: S.R2.id, amount: 1_500 }, PNG);
    expect(ok.status).toBe(201);
    expect(ok.body).toEqual({ id: expect.any(String), amount: 1_500, creditUsed: 0 });
    expect(await credit(S.R1)).toEqual({ balance: 500, reserved: 0 });
    expect(await credit(S.R2)).toEqual({ balance: 1_500, reserved: 0 });
    const entries = await admin.billingCreditEntry.findMany({ where: { tenantId: { in: [S.R1.id, S.R2.id] }, kind: { in: ['TRANSFER_OUT', 'TRANSFER_IN'] } } });
    expect(entries.map((e) => [e.tenantId, e.kind, e.amount]).sort()).toEqual([[S.R1.id, 'TRANSFER_OUT', -1_500], [S.R2.id, 'TRANSFER_IN', 1_500]].sort());
    expect((await platformJournal(S.R1, 'billing.credit_transferred_out'))[0].data).toMatchObject({ amount: 1_500, reason: 'Regroupement fictif des crédits (essai G5d-2)' });
    expect(await platformJournal(S.R2, 'billing.credit_transferred_in')).toHaveLength(1);
    const g = await admin.groupAuditLog.findMany({ where: { groupId: S.R1.groupId, action: { in: ['billing.credit_transferred_out', 'billing.credit_transferred_in'] } } });
    expect(g).toHaveLength(2);
    expect(JSON.stringify(g)).not.toContain('Regroupement fictif des crédits');
    const c = (await pf.get('/billing/credits')).body;
    expect(c.transfers.find((x: { id: string }) => x.id === ok.body.id)).toMatchObject({
      fromName: S.R1.name, toName: S.R2.name, amount: 1_500, authorizedBy: 'Accord écrit fictif du promoteur du groupe (essai)', createdByName: sa.name,
      proofUrl: expect.stringMatching(/^\/api\/v1\/files\?/),
    });
    expect(c.creditNotes.find((x: { id: string }) => x.id === D.RAV.id)).toMatchObject({ state: 'GROUP_PENDING', stateLabel: GROUP_PAYMENT_PENDING });
  });
});

describe('Lot G5d-2 · essai 23 du cahier : isolation des données entre établissements', () => {
  it('chaque direction ne lit que ses reçus, son crédit et ses demandes ; l’école d’un groupe ne lit rien (D-G5-19)', async () => {
    const x = await view(S.X);
    expect(x.regularization).toBeNull();
    expect((await school(S.X.direction).get(`/settings/subscription/receipts/${pay.P1.id}`)).status).toBe(404);
    expect((await school(S.Q.direction).get(`/settings/subscription/receipts/${pay.P1.id}`)).status).toBe(404);
    expect((await school(S.P.direction).get(`/settings/subscription/receipts/${pay.Q1.id}`)).status).toBe(404);
    expect((await school(S.R2.direction).get(`/settings/subscription/receipts/${pay.P1.id}`)).status).toBe(404);
    expect((await school(S.P.comptable).get(`/settings/subscription/receipts/${pay.P1.id}`)).status).toBe(403);
    const q = await view(S.Q);
    expect(q.regularization.receipts.map((r: { id: string }) => r.id).sort()).toEqual([pay.Q1.id, pay.Q2.id].sort());
    expect(JSON.stringify(q)).not.toContain(D.P1.reference);
    // Rôles de l'école, des groupes : aucune lecture directe des tables du lot.
    for (const db of [appDb, groupDb]) {
      for (const t of ['billing_payments', 'billing_allocations', 'billing_credit_entries', 'billing_refunds', 'billing_credit_transfers', 'billing_payment_means']) {
        await expect(db.$queryRawUnsafe(`SELECT count(*) FROM ${t}`)).rejects.toThrow(/permission denied/);
      }
    }
  });
});

describe('Lot G5d-2 · essais 24 et 25 du cahier : rien de rétroactif, rien de fiscal', () => {
  it('essai 24 : aucun paiement, annulation, remboursement ni transfert ne modifie un document émis ; les écritures du lot ne se modifient ni ne s’effacent', async () => {
    // Chaque document émis avant les paiements est relu tel quel (les documents ajoutés depuis s'intercalent par référence).
    const byRef = (rows: unknown[]) => new Map((rows as { doc: { reference: string } }[]).map((r) => [r.doc.reference, r]));
    const now = byRef(await fixtureDocs());
    expect(docsBefore.length).toBeGreaterThanOrEqual(10);
    for (const [ref, row] of byRef(docsBefore)) expect([ref, now.get(ref)]).toEqual([ref, row]);
    const refused = (sql: string) => expect(admin.$executeRawUnsafe(sql)).rejects.toThrow();
    await refused(`UPDATE billing_payments SET amount = 1 WHERE id = '${pay.P1.id}'`);
    await refused(`UPDATE billing_payments SET "cancelReason" = 'Autre motif' WHERE id = '${pay.P2.id}'`);
    await refused(`DELETE FROM billing_payments WHERE id = '${pay.P1.id}'`);
    await refused(`UPDATE billing_allocations SET amount = 1 WHERE "paymentId" = '${pay.P1.id}'`);
    await refused(`DELETE FROM billing_allocations WHERE "paymentId" = '${pay.P1.id}'`);
    await refused(`DELETE FROM billing_credit_entries WHERE tenant_id = '${S.Q.id}'`);
    await refused(`UPDATE billing_refunds SET amount = 1 WHERE tenant_id = '${S.Q.id}'`);
    await refused(`DELETE FROM billing_credit_transfers WHERE "fromTenantId" = '${S.R1.id}'`);
    await refused(`UPDATE billing_payment_means SET active = false WHERE name = '${MEANS_NAME}'`);
  });

  it('essai 25 : reçus et documents restent provisoires, sans valeur fiscale ; aucune facture n’existe', async () => {
    const kinds = await admin.$queryRaw<{ k: string }[]>`SELECT unnest(enum_range(NULL::"BillingDocumentKind"))::text AS k`;
    expect(kinds.map((x) => x.k).sort()).toEqual(['CREDIT_NOTE', 'SERVICE_PROFORMA', 'SERVICE_QUOTE', 'SUBSCRIPTION']);
    const mine = await admin.billingPayment.findMany({ where: { tenantId: { in: [S.P.id, S.Q.id] } } });
    expect(mine.length).toBe(7);
    for (const p of mine) expect(p.receiptNumber).toMatch(/^PROV-REC-\d{6,}$/);
    for (const id of [pay.P1.id, pay.P2.id, pay.Q2.id]) {
      const r = (await pf.get(`/billing/payments/${id}`)).body.receipt;
      expect(r).toMatchObject({ title: expect.stringMatching(/^Reçu provisoire PROV-REC-/), issuer: 'Cahiora', mention: RECEIPT_MENTION });
      expect(JSON.stringify(r)).not.toMatch(/factur/i);
    }
    const v = await view(S.P);
    expect(v.regularization).toMatchObject({ mention: PROVISIONAL_MENTION, receiptMention: RECEIPT_MENTION });
  });
});

describe('Lot G5d-2 · rapports financiers : facturé et encaissé ne se confondent jamais, par monnaie', () => {
  it('totaux, documents et paiements d’un établissement, d’un groupe, d’une période et d’un état', async () => {
    const report = async (q: string) => (await pf.get(`/billing/reports${q}`).expect(200)).body;
    const p = await report(`?tenantId=${S.P.id}`);
    expect(p.totals).toEqual({
      billed: [{ currency: CUR, amount: 133_000 }], credited: [], collected: [{ currency: CUR, amount: 140_000 }], refunded: [], unpaid: [], groupPending: [],
      credits: [{ currency: CUR, amount: 7_000 }],
    });
    expect(p.documents.map((d: { reference: string; payment: { status: string } }) => [d.reference, d.payment.status]).sort()).toEqual(
      [D.P1, D.P2, D.P3, D.P4].map((d) => [d.reference, 'PAID']).sort(),
    );
    expect(p.payments).toHaveLength(5);
    expect(p.payments.filter((x: { status: string }) => x.status === 'CANCELLED')).toHaveLength(2);
    expect((await report(`?tenantId=${S.P.id}&status=PAID`)).documents).toHaveLength(4);
    expect((await report(`?tenantId=${S.P.id}&status=PENDING`)).documents).toHaveLength(0);
    expect((await report(`?tenantId=${S.P.id}&from=${day(1)}`)).totals).toMatchObject({ billed: [], collected: [] });
    const q = await report(`?tenantId=${S.Q.id}`);
    expect(q.totals).toMatchObject({ billed: [{ currency: CUR, amount: 40_000 }], collected: [{ currency: CUR, amount: 45_000 }], refunded: [{ currency: CUR, amount: 5_000 }], credits: [] });
    const u = await report(`?tenantId=${S.U.id}`);
    expect(u.totals).toMatchObject({ billed: [{ currency: CUR, amount: 68_000 }], credited: [{ currency: CUR, amount: 65_000 }], collected: [], unpaid: [{ currency: CUR, amount: 3_000 }] });
    const g = await report(`?groupId=${S.R1.groupId}`);
    expect(g.totals).toEqual({
      billed: [{ currency: CUR, amount: 85_000 }], credited: [{ currency: CUR, amount: 9_500 }], collected: [], refunded: [], unpaid: [],
      groupPending: [{ currency: CUR, amount: 77_500 }], credits: [{ currency: CUR, amount: 2_000 }],
    });
    expect(g.documents.find((d: { id: string }) => d.id === D.R.id).payment).toMatchObject({ status: 'GROUP_PENDING', label: GROUP_PAYMENT_PENDING });
    const wrong = await pf.get(`/billing/reports?from=${day(1)}&to=${day(-1)}`);
    expect([wrong.status, msg(wrong)]).toEqual([400, 'Période : la date de début vient après la date de fin']);
    // Vue d'ensemble : montants par monnaie, jamais additionnés d'une monnaie à l'autre.
    const o = (await pf.get('/billing/overview')).body;
    expect(o.amounts.collected.find((r: { currency: string }) => r.currency === CUR).amount).toBeGreaterThanOrEqual(185_000);
    expect(o.amounts.billed.every((r: { currency: string; amount: number }) => /^[A-Z]{3}$/.test(r.currency) && Number.isInteger(r.amount))).toBe(true);
  });
});

describe('Lot G5d-2 · verrou du serveur refermé : plus rien ne s’écrit, l’historique reste', () => {
  it('les moyens disparaissent pour les établissements, chaque écriture est refusée, reçus et crédits restent lisibles', async () => {
    process.env[PAYMENTS_LOCK_ENV] = 'false';
    const v = await view(S.P);
    expect(v.access.paymentMeansActive).toBe(false);
    expect(v.regularization).toMatchObject({ paymentMeans: [], paymentsOpen: false, refundOpen: false, refundNote: REFUNDS_CLOSED, credit: { available: 7_000 } });
    expect(v.regularization.receipts).toHaveLength(5);
    const r = await record(S.P, D.P1, 1_000, `FERME-${stamp}`);
    expect([r.status, msg(r)]).toEqual([403, PAYMENTS_LOCKED]);
    expect((await school(S.P.direction).get(`/settings/subscription/receipts/${pay.P1.id}`)).status).toBe(200);
    const o = (await pf.get('/billing/payments')).body;
    expect(o.unlocked).toBe(false);
    expect(o.establishments.find((e: { tenantId: string }) => e.tenantId === S.P.id).means).toEqual([]);
  });

  it('fin des essais : le moyen fictif est désactivé par une nouvelle version (jamais modifié ni effacé)', async () => {
    process.env[PAYMENTS_LOCK_ENV] = 'true';
    const r = await pf.post('/billing/payment-means', {
      meansCode: code_, name: MEANS_NAME, instructions: INSTRUCTIONS, currency: CUR, active: false, effectiveFrom: today, reason: 'Fin des essais fictifs du lot G5d-2', code: await code(),
    });
    expect(r.body).toMatchObject({ code: code_, version: 2 });
    expect((await view(S.P)).regularization.paymentMeans.some((m: { code: string }) => m.code === code_)).toBe(false);
    delete process.env[PAYMENTS_LOCK_ENV];
  });
});
