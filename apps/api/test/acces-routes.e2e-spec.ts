/**
 * Lot G5d-1 · vérification demandée par Dankou le 20 novembre 2026 : « vérifier que toutes les restrictions d'accès
 * sont effectivement appliquées côté serveur ». Chaque route de l'API est relevée au démarrage avec ses marques
 * (publique, ouverte pendant l'accès limité, droits exigés). Pour un établissement fictif en accès limité :
 * - chaque écriture qui n'est pas ouverte pendant l'accès limité est refusée par le serveur, avec son motif, pour un
 *   rôle qui a pourtant le droit de la faire, avant même la lecture du corps de la demande ;
 * - chaque lecture reste ouverte ;
 * - les écritures ouvertes forment un registre fermé : en ouvrir une nouvelle fait échouer cet essai tant que le
 *   registre n'est pas mis à jour, donc tant que la décision n'est pas prise ;
 * - les routes publiques de l'établissement (sans sa connexion, donc sans ce contrôle) forment elles aussi un registre
 *   fermé.
 * Base de test seulement, établissement et comptes fictifs ; aucun paiement, aucun SMS.
 * Avec ACCES_ROUTES_RAPPORT=<fichier>, le relevé complet est écrit dans ce fichier (rapport de vérification).
 */
import { INestApplication, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { MetadataScanner, ModulesContainer, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PrismaClient, RoleCode } from '@prisma/client';
import * as argon2 from 'argon2';
import { writeFileSync } from 'fs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { forgetAccess, IS_PUBLIC, LIMITED_OK, REQUIRED_PERMISSIONS } from '../src/common/auth';
import { can, Permission } from '../src/common/permissions';
import { LIMITED_REFUSAL } from '../src/modules/billing/access-rules';

const PASSWORD = 'Acces-Routes-2026';
const stamp = Date.now().toString(36);
const UUID = '00000000-0000-4000-8000-000000000000';
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Ordre de choix du rôle qui a le droit d'appeler une route : la direction d'abord, les familles en dernier. */
const ROLES: RoleCode[] = ['DIRECTION', 'COMPTABLE', 'SECRETARIAT', 'VIE_SCOLAIRE', 'ENSEIGNANT', 'PARENT', 'ELEVE'];
const FAMILY: RoleCode[] = ['PARENT', 'ELEVE'];

/**
 * Registre des écritures ouvertes pendant l'accès limité (D-G5-30 A et lectures 1, 2, 8, 11 du rapport G5d-1) :
 * sécurité des comptes, caisse scolaire, impression des documents officiels, régularisation de l'abonnement.
 */
const OPEN_WRITES = [
  // Sécurité des comptes : mot de passe, double authentification, appareils connectés, récupération d'un compte.
  'POST /api/v1/auth/2fa/enable', 'POST /api/v1/auth/2fa/recovery-codes', 'POST /api/v1/auth/2fa/setup', 'POST /api/v1/auth/change-password',
  'POST /api/v1/auth/logout-all', 'DELETE /api/v1/auth/sessions/:id',
  'POST /api/v1/recovery-requests', 'POST /api/v1/recovery-requests/:id/approve', 'POST /api/v1/recovery-requests/:id/reject',
  // Comptes du personnel : seulement désactiver un compte (condition vérifiée plus bas) et donner un mot de passe provisoire.
  'PATCH /api/v1/staff/:id', 'POST /api/v1/users/:id/reset-password',
  // Notifications lues.
  'POST /api/v1/notifications/:id/read', 'POST /api/v1/notifications/read-all',
  // Caisse scolaire (lecture 1) : encaissement au guichet, annulation d'un reçu (demande puis décision), relances, clôture.
  'POST /api/v1/finance/cash-closings', 'POST /api/v1/finance/payments/desk', 'POST /api/v1/finance/receipts/:id/cancel',
  'POST /api/v1/finance/receipts/:id/cancel/decision', 'POST /api/v1/finance/reminders',
  // Paiement en ligne des frais de scolarité par les familles (caisse).
  'POST /api/v1/payments/mobile-money', 'POST /api/v1/payments/sandbox/:transactionId/decision',
  // Documents officiels : certificats, attestations, cartes (lecture 2).
  'POST /api/v1/documents', 'POST /api/v1/documents/batch',
  // Régularisation de l'abonnement (lectures 8 et 11) et corrections des comptages des élèves facturables (lot G5b).
  'POST /api/v1/settings/billing-counts/:id/corrections', 'POST /api/v1/settings/billing-counts/corrections/:id/decision',
  'POST /api/v1/settings/subscription/accept', 'POST /api/v1/settings/subscription/regularization-requests',
].sort();

/**
 * Registre des routes publiques de l'établissement, hors Super Admin et console des groupes (qui ont leurs propres
 * gardes) : connexion et récupération d'un compte, pages publiques, vérification d'un document par son code, fichiers,
 * retour des paiements Mobile Money (caisse) et préinscription en ligne des familles, laissée ouverte pendant l'accès
 * limité (décision de Dankou du 20 novembre 2026). Elles ne passent pas par la connexion de l'établissement, donc pas
 * par le contrôle de l'accès limité.
 */
const PUBLIC_ROUTES = [
  'GET /api/v1/files', 'GET /api/v1/health',
  'GET /api/v1/public/:tenant', 'GET /api/v1/public/:tenant/honors/:id/photo', 'GET /api/v1/public/:tenant/logo',
  'GET /api/v1/public/:tenant/sites/:id/photo', 'GET /api/v1/public/verify/:code',
  'POST /api/v1/auth/2fa/recovery', 'POST /api/v1/auth/2fa/reenroll/finish', 'POST /api/v1/auth/2fa/reenroll/start',
  'POST /api/v1/auth/2fa/verify', 'POST /api/v1/auth/forgot', 'POST /api/v1/auth/login', 'POST /api/v1/auth/logout',
  'POST /api/v1/auth/refresh', 'POST /api/v1/auth/reset',
  'POST /api/v1/payments/webhook/:provider', 'POST /api/v1/public/:tenant/applications',
].sort();

type Route = { method: string; path: string; isPublic: boolean; rule: 'ouverte' | 'condition' | null; perms: Permission[]; where: string };

/** Toutes les routes déclarées par les contrôleurs, avec les marques que lit le contrôle d'accès. */
function allRoutes(app: INestApplication): Route[] {
  const reflector = app.get(Reflector);
  const scanner = new MetadataScanner();
  const seen = new Map<string, Route>();
  for (const mod of app.get(ModulesContainer).values()) {
    for (const wrapper of mod.controllers.values()) {
      const cls = wrapper.metatype as unknown as { name: string; prototype: Record<string, unknown> } | null;
      if (!cls?.prototype) continue;
      const bases = ([] as string[]).concat(Reflect.getMetadata(PATH_METADATA, cls) ?? '/');
      for (const name of scanner.getAllMethodNames(cls.prototype)) {
        const handler = cls.prototype[name] as object;
        const sub = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
        const verb = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (sub === undefined || verb === undefined) continue;
        const targets = [handler, cls] as unknown as Parameters<Reflector['getAllAndOverride']>[1];
        const rule = reflector.getAllAndOverride<unknown>(LIMITED_OK, targets);
        for (const base of bases) {
          for (const s of ([] as string[]).concat(sub)) {
            const path = `/api/v1/${base}/${s}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
            const method = RequestMethod[verb];
            seen.set(`${method} ${path}`, {
              method, path, where: `${cls.name}.${name}`,
              isPublic: !!reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets),
              rule: rule === true ? 'ouverte' : typeof rule === 'function' ? 'condition' : null,
              perms: reflector.getAllAndOverride<Permission[]>(REQUIRED_PERMISSIONS, targets) ?? [],
            });
          }
        }
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

const key = (r: Route) => `${r.method} ${r.path}`;
/** Rôle qui a le droit d'appeler la route (le contrôle des droits passe avant celui de l'accès limité). */
const roleFor = (r: Route) => (r.perms.length ? ROLES.find((role) => r.perms.some((p) => can(role, p))) : 'DIRECTION');
/** Adresse appelable : chaque paramètre reçoit un identifiant fictif (le contrôle d'accès passe avant leur lecture). */
const concrete = (path: string) => path.replace(/:[A-Za-z0-9_]+/g, UUID).replace(/\*/g, 'x');

let app: INestApplication;
let http: ReturnType<typeof request>;
const admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_ADMIN_URL } } });
const tokens = {} as Record<RoleCode, string>;
const userIds = {} as Record<RoleCode, string>;
let invoiceId = '';
let tenantId = '';
let routes: Route[] = [];

function call(r: Route, role: RoleCode, body: object = {}) {
  const verb = r.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options';
  const req = http[verb](concrete(r.path)).set('Authorization', `Bearer ${tokens[role]}`).set('X-Active-Role', role);
  return READS.has(r.method) ? req : req.send(body);
}

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  configureApp(app);
  await app.init();
  http = request(app.getHttpServer());
  routes = allRoutes(app);

  // Établissement fictif, seul dans son groupe, un compte par rôle, puis en accès limité depuis 5 jours.
  const t = await admin.tenant.create({
    data: { slug: `g5d1-routes-${stamp}`, name: `École fictive routes G5d-1 ${stamp}`, group: { create: { name: `Groupe fictif routes G5d-1 ${stamp}` } } },
  });
  tenantId = t.id;
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  await admin.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${t.id}, true)`;
    for (const [i, role] of ROLES.entries()) {
      const u = await tx.user.create({ data: { tenantId: t.id, phone: `+229019000${70 + i}01`, firstName: 'Fictif', lastName: `${role} routes`, passwordHash: hash, mustChangePassword: false } });
      await tx.userRole.create({ data: { tenantId: t.id, userId: u.id, role } });
      userIds[role] = u.id;
    }
    await tx.academicYear.create({ data: { tenantId: t.id, label: '2026-2027', startDate: new Date('2026-09-14'), endDate: new Date('2027-07-31'), isCurrent: true } });
    // Frais de scolarité d'un élève fictif, facturés avant l'accès limité (la caisse les encaisse ensuite).
    const st = await tx.student.create({ data: { tenantId: t.id, matricule: `RTE-${stamp}`, firstName: 'Élève', lastName: 'FICTIF' } });
    const inv = await tx.invoice.create({
      data: { tenantId: t.id, number: `FAC-RTE-${stamp}`, studentId: st.id, label: 'Scolarité fictive', total: 50_000, dueDate: new Date('2026-12-05'), createdById: userIds.COMPTABLE },
    });
    invoiceId = inv.id;
  });
  const day = (n: number) => new Date(Date.now() + n * 86_400_000);
  await admin.subscription.create({
    data: {
      tenantId: t.id, status: 'LIMITED', statusSince: day(-5), limitedSince: day(-5), trialStart: day(-34), trialEnd: day(-21), trialDays: 14,
      graceStart: day(-20), graceEnd: day(-6),
    },
  });
  forgetAccess(t.id);
  for (const [i, role] of ROLES.entries()) {
    const r = await http.post('/api/v1/auth/login').send({ tenant: t.slug, identifier: `+229019000${70 + i}01`, password: PASSWORD });
    expect(r.status).toBe(200);
    tokens[role] = r.body.accessToken;
  }
}, 60000);

afterAll(async () => {
  const out = process.env.ACCES_ROUTES_RAPPORT;
  if (out && routes.length) {
    writeFileSync(out, JSON.stringify(routes.map((r) => ({ ...r, role: r.isPublic ? null : roleFor(r) })), null, 2));
  }
  await app?.close();
  await admin.$disconnect();
});

describe('Lot G5d-1 · accès limité appliqué par le serveur, route par route (vérification du 20 novembre 2026)', () => {
  it('relevé des routes : chaque route d’établissement a un rôle qui peut l’appeler', () => {
    expect(routes.length).toBeGreaterThan(250);
    const school = routes.filter((r) => !r.isPublic);
    expect(school.filter((r) => !roleFor(r)).map(key)).toEqual([]);
  });

  it('chaque écriture qui n’est pas ouverte est refusée avec le motif de l’accès limité (message neutre pour les familles)', async () => {
    const writes = routes.filter((r) => !r.isPublic && !READS.has(r.method) && !r.rule);
    expect(writes.length).toBeGreaterThan(70);
    const wrong: string[] = [];
    for (const r of writes) {
      const role = roleFor(r)!;
      const res = await call(r, role);
      const message = FAMILY.includes(role) ? LIMITED_REFUSAL.family : LIMITED_REFUSAL.staff;
      if (res.status !== 403 || res.body?.message !== message) wrong.push(`${key(r)} (${role}) → ${res.status} ${JSON.stringify(res.body?.message ?? '')}`);
    }
    expect(wrong).toEqual([]);
    // Chaque refus est inscrit dans le journal de l'établissement (au plus une fois par personne et par route en 10 minutes).
    const logged = await admin.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return tx.auditLog.count({ where: { action: 'access.denied' } });
    });
    expect(logged).toBe(writes.length);
  }, 120000);

  it('les écritures ouvertes pendant l’accès limité forment un registre fermé (présenté à Dankou le 20 novembre 2026)', () => {
    const open = routes.filter((r) => !r.isPublic && !READS.has(r.method) && r.rule).map(key).sort();
    expect(open).toEqual(OPEN_WRITES);
  });

  it('les routes publiques de l’établissement forment elles aussi un registre fermé', () => {
    const open = routes.filter((r) => r.isPublic && !/^\/api\/v1\/(platform|group)(\/|$)/.test(r.path)).map(key).sort();
    expect(open).toEqual(PUBLIC_ROUTES);
  });

  it('désactiver un compte du personnel reste possible ; toute autre modification d’un compte est refusée', async () => {
    const staff = routes.find((r) => key(r) === 'PATCH /api/v1/staff/:id')!;
    expect(staff.rule).toBe('condition');
    const off = await call(staff, 'DIRECTION', { active: false });
    expect(off.body?.message).not.toBe(LIMITED_REFUSAL.staff);
    expect(off.status).toBe(404); // le contrôle d'accès est passé ; le compte fictif n'existe pas.
    for (const body of [{ firstName: 'Autre' }, { active: true }, { active: false, firstName: 'Autre' }, {}]) {
      const res = await call(staff, 'DIRECTION', body);
      expect([res.status, res.body?.message]).toEqual([403, LIMITED_REFUSAL.staff]);
    }
  });

  it('chaque lecture reste ouverte pendant l’accès limité', async () => {
    const reads = routes.filter((r) => !r.isPublic && READS.has(r.method));
    expect(reads.length).toBeGreaterThan(50);
    const refused: string[] = [];
    for (const r of reads) {
      const role = roleFor(r)!;
      const res = await call(r, role);
      if ([LIMITED_REFUSAL.staff, LIMITED_REFUSAL.family].includes(res.body?.message)) refused.push(`${key(r)} (${role})`);
    }
    expect(refused).toEqual([]);
  }, 120000);
});

describe('Réserve 1 de Dankou (20 novembre 2026) : la caisse reste ouverte, les annulations de reçus gardent leurs droits et leur journal', () => {
  const journal = (action: string) =>
    admin.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return tx.auditLog.findMany({ where: { action }, orderBy: { createdAt: 'asc' } });
    });
  const as = (role: RoleCode) => ({
    post: (url: string, body: object = {}) => http.post(`/api/v1${url}`).set('Authorization', `Bearer ${tokens[role]}`).set('X-Active-Role', role).send(body),
  });
  const NOT_ALLOWED = 'Votre rôle ne permet pas cette action';
  let receiptId = '';
  let receiptNumber = '';

  it('encaissement au guichet par le comptable, jamais par un rôle sans le droit d’encaisser', async () => {
    const pay = { invoiceId, amount: 20_000, method: 'CASH' };
    const teacher = await as('ENSEIGNANT').post('/finance/payments/desk', pay);
    expect([teacher.status, teacher.body.message]).toEqual([403, NOT_ALLOWED]);
    expect((await as('SECRETARIAT').post('/finance/payments/desk', pay)).body.message).toBe(NOT_ALLOWED);
    const r = await as('COMPTABLE').post('/finance/payments/desk', pay);
    expect(r.status).toBe(201);
    receiptId = r.body.receipt.id;
    receiptNumber = r.body.receipt.number;
    expect(receiptNumber).toBeTruthy();
    expect((await journal('payment.confirmed')).map((l) => l.userId)).toEqual([userIds.COMPTABLE]);
  });

  it('annulation d’un reçu : demandée par le comptable avec un motif, décidée par la direction, chaque étape journalisée', async () => {
    const reason = 'Erreur de montant au guichet (essai fictif)';
    // Sans le droit de la caisse : refus, tracé dans le journal comme avant le lot G5d-1.
    for (const role of ['SECRETARIAT', 'ENSEIGNANT', 'PARENT'] as RoleCode[]) {
      const r = await as(role).post(`/finance/receipts/${receiptId}/cancel`, { reason });
      expect([r.status, r.body.message]).toEqual([403, NOT_ALLOWED]);
    }
    const ask = await as('COMPTABLE').post(`/finance/receipts/${receiptId}/cancel`, { reason });
    expect(ask.status).toBe(201);
    const asked = await journal('receipt.cancel_requested');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ userId: userIds.COMPTABLE, entity: 'Receipt', entityId: receiptId });
    expect(asked[0].data).toMatchObject({ number: receiptNumber, amount: 20_000, reason });
    // Le comptable ne valide pas sa propre demande : la décision demande le droit de validation de la direction.
    const self = await as('COMPTABLE').post(`/finance/receipts/${receiptId}/cancel/decision`, { approve: true });
    expect([self.status, self.body.message]).toEqual([403, NOT_ALLOWED]);
    const ok = await as('DIRECTION').post(`/finance/receipts/${receiptId}/cancel/decision`, { approve: true, comment: 'Validé (essai fictif)' });
    expect(ok.status).toBe(201);
    const done = await journal('receipt.cancelled');
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ userId: userIds.DIRECTION, entity: 'Receipt', entityId: receiptId });
    expect(done[0].data).toMatchObject({ number: receiptNumber, amount: 20_000, reason, requestedById: userIds.COMPTABLE, comment: 'Validé (essai fictif)' });
    const receipt = await admin.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return tx.receipt.findUniqueOrThrow({ where: { id: receiptId } });
    });
    expect(receipt).toMatchObject({ cancelReason: reason, cancelledById: userIds.DIRECTION });
    expect(receipt.cancelledAt).not.toBeNull();
    // Chaque refus de droit est tracé (SEC-034), avec le motif « droit manquant ».
    const denied = (await journal('access.denied')).filter((l) => JSON.stringify(l.data).includes('droit manquant'));
    expect(denied.map((l) => (l.data as { route: string }).route).sort()).toEqual([
      'POST /api/v1/finance/payments/desk', 'POST /api/v1/finance/payments/desk',
      'POST /api/v1/finance/receipts/:id/cancel', 'POST /api/v1/finance/receipts/:id/cancel', 'POST /api/v1/finance/receipts/:id/cancel',
      'POST /api/v1/finance/receipts/:id/cancel/decision',
    ]);
  });
});
