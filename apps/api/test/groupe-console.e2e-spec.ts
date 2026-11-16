/**
 * Lot G2 : console du promoteur. Connexion des comptes de groupe avec double authentification obligatoire,
 * sessions, rôles du groupe, cloisonnement entre groupes et absence de toute donnée d'élève.
 * Données entièrement fictives (groupes, écoles et comptes créés par le test), sur la base de test erp_test.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { authenticator } from 'otplib';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { config, derivedKey } from '../src/config';

const admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_ADMIN_URL } } });
const app_ = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
const platformDb = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_PLATFORM_URL } } });
const groupDb = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_GROUP_URL } } });

const stamp = Date.now().toString(36);
const EMAIL = 'groupes-g2@test.local';
const NAME_A = `Groupe Alpha (test G2 ${stamp})`;
const NAME_B = `Groupe Bêta (test G2 ${stamp})`;
const STUDENT = `CONFIDENTIEL${stamp.toUpperCase()}`;
const PASSWORD = 'Console-Groupe-2026';
/** Numéro béninois fictif, différent à chaque lancement (l'identifiant est unique sur toute la plateforme). */
const phone = () => `01${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

let app: INestApplication;
let http: ReturnType<typeof request>;
let platformCookie = '';
const ids = { groupA: '', groupB: '', a1: '', a2: '', b1: '' };

type Account = { id: string; identifier: string; password: string; secret: string; cookie: string; codes: string[] };
const accounts: Record<'general' | 'general2' | 'financier' | 'pedago' | 'generalB', Account> = {} as any;

const cookieOf = (r: request.Response) => {
  const c = (r.headers['set-cookie'] as unknown as string[] | undefined)?.find((x) => x.startsWith('erp_gt='));
  return c ? c.split(';')[0] : '';
};
const pf = (method: 'get' | 'post' | 'patch' | 'delete', url: string, body?: object) =>
  (http as any)[method](`/api/v1/platform${url}`).set('Cookie', platformCookie).send(body ?? {});
const gp = (method: 'get' | 'post' | 'patch', url: string, cookie?: string, body?: object) => {
  const r = (http as any)[method](`/api/v1/group${url}`);
  if (cookie) r.set('Cookie', cookie);
  return r.send(body ?? {});
};
const code = (secret: string) => authenticator.generate(secret);
/** Numéro de la session portée par un cookie de la console. */
const sidOf = (cookie: string) => (new JwtService().decode(cookie.split('=')[1]) as { sid: string }).sid;
/** Comme si 30 secondes étaient passées : le code suivant de l'application est accepté (un code ne sert qu'une fois). */
const nextWindow = (accountId: string) => admin.groupAccount.update({ where: { id: accountId }, data: { totpLastStep: null } });
const unlock = (accountId: string) => admin.groupAccount.update({ where: { id: accountId }, data: { totpLastStep: null, failedLogins: 0, lockedUntil: null } });
const journal = (groupId: string, action?: string) =>
  admin.groupAuditLog.findMany({ where: { groupId, ...(action ? { action } : {}) }, orderBy: { createdAt: 'asc' } });
/** Lecture avec le rôle de la console et un groupe de session donné, comme le fait l'API. */
const asGroup = <T>(groupId: string | null, fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
  groupDb.$transaction(async (tx) => {
    if (groupId) await tx.$executeRaw`SELECT set_config('app.group_id', ${groupId}, true)`;
    return fn(tx);
  });

/** Première connexion complète : mot de passe provisoire, nouveau mot de passe, application d'authentification, codes. */
async function firstLogin(identifier: string, temporaryPassword: string): Promise<Omit<Account, 'id'>> {
  const l = await gp('post', '/auth/login', undefined, { identifier, password: temporaryPassword });
  expect(l.status).toBe(201);
  expect(l.body).toMatchObject({ step: 'first-login', needsPassword: true, needsTwoFactor: true });
  expect(cookieOf(l)).toBe('');
  const p = await gp('post', '/auth/first-login/password', undefined, { token: l.body.token, password: PASSWORD });
  expect(p.status).toBe(201);
  expect(p.body).toMatchObject({ step: 'first-login', needsPassword: false, needsTwoFactor: true });
  expect(cookieOf(p)).toBe('');
  const s = await gp('post', '/auth/first-login/2fa/setup', undefined, { token: p.body.token });
  expect(s.status).toBe(201);
  const e = await gp('post', '/auth/first-login/2fa/enable', undefined, { token: p.body.token, setupToken: s.body.setupToken, code: code(s.body.secret) });
  expect(e.status).toBe(201);
  return { identifier, password: PASSWORD, secret: s.body.secret, cookie: cookieOf(e), codes: e.body.recoveryCodes };
}

/** Connexion ordinaire : mot de passe puis code de l'application. */
async function signIn(a: Account) {
  await nextWindow(a.id);
  const l = await gp('post', '/auth/login', undefined, { identifier: a.identifier, password: a.password });
  expect(l.status).toBe(201);
  expect(l.body.step).toBe('code');
  const c = await gp('post', '/auth/code', undefined, { challenge: l.body.challenge, code: code(a.secret) });
  expect(c.status).toBe(201);
  a.cookie = cookieOf(c);
  return a.cookie;
}

/** Compte créé par le Super Admin, puis première connexion faite. */
async function platformAccount(key: keyof typeof accounts, groupId: string, role: 'GENERAL' | 'FINANCIER' | 'PEDAGOGIQUE', firstName: string) {
  const tel = phone();
  const r = await pf('post', `/groups/${groupId}/accounts`, { firstName, lastName: 'Fictif', phone: tel, role });
  expect(r.status).toBe(201);
  const done = await firstLogin(tel, r.body.temporaryPassword);
  accounts[key] = { id: r.body.account.id, ...done };
  return r;
}

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  configureApp(app);
  await app.init();
  http = request(app.getHttpServer());
  execSync(`npx ts-node --transpile-only prisma/platform-admin.ts ${EMAIL} "Super Admin Console" --operateur "Tests automatiques" --motif "Remise à zéro du compte de test"`, { env: process.env, cwd: `${__dirname}/..` });
  const argon2 = await import('argon2');
  await admin.platformAdmin.update({ where: { email: EMAIL }, data: { passwordHash: await argon2.hash('Plateforme-Test-2026'), mustChangePassword: false, mustSetupTwoFactor: false } });
  const r = await http.post('/api/v1/platform/auth/login').send({ email: EMAIL, password: 'Plateforme-Test-2026' });
  expect(r.status).toBe(201);
  platformCookie = (r.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('erp_pt='))!.split(';')[0];

  // Deux groupes fictifs : Alpha (deux écoles) et Bêta (une école).
  ids.groupA = (await pf('post', '/groups', { name: NAME_A, promoter: 'Promoteur fictif', country: 'BJ', notes: 'Note interne fictive G2' })).body.id;
  ids.groupB = (await pf('post', '/groups', { name: NAME_B, country: 'BJ' })).body.id;
  const school = async (k: string, groupId: string) => {
    const s = await pf('post', '/tenants', {
      slug: `g2-${k}-${stamp}`, name: `École ${k.toUpperCase()} (test G2 ${stamp})`, matriculePrefix: 'GDE', siteName: 'Centre',
      director: { firstName: 'Direction', lastName: 'Fictive', phone: phone() }, groupId,
    });
    expect([k, s.status]).toEqual([k, 201]);
    return s.body.tenant.id as string;
  };
  ids.a1 = await school('a1', ids.groupA);
  ids.a2 = await school('a2', ids.groupA);
  ids.b1 = await school('b1', ids.groupB);
  // Un élève fictif dans une école du groupe Alpha : la console ne doit jamais le montrer.
  await admin.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${ids.a1}, true)`;
    await tx.student.create({ data: { tenantId: ids.a1, matricule: `GDE-26-${stamp.slice(-4).toUpperCase()}`, firstName: 'Élève', lastName: STUDENT } });
  });
}, 120000);

afterAll(async () => {
  await app?.close();
  for (const db of [admin, app_, platformDb, groupDb]) await db.$disconnect();
});

describe('Lot G2 · comptes de la console créés par le Super Admin', () => {
  it('le premier compte du groupe : mot de passe provisoire montré une fois, aucun secret dans les réponses, trois journaux', async () => {
    expect((await pf('post', `/groups/${ids.groupA}/accounts`, { firstName: 'Sans', lastName: 'Identifiant', role: 'GENERAL' })).status).toBe(400);
    expect((await pf('post', `/groups/${ids.groupA}/accounts`, { firstName: 'Rôle', lastName: 'Inconnu', phone: phone(), role: 'DIRECTION' })).status).toBe(400);
    const tel = phone();
    const r = await pf('post', `/groups/${ids.groupA}/accounts`, { firstName: 'Awa', lastName: 'Promotrice', phone: tel, email: `Promoteur-${stamp}@Test.local`, role: 'GENERAL' });
    expect(r.status).toBe(201);
    expect(r.headers['cache-control']).toContain('no-store');
    expect(r.body.account).toMatchObject({ phone: `+229${tel}`, email: `promoteur-${stamp}@test.local`, role: 'GENERAL', active: true, pendingFirstLogin: true, totpEnabled: false });
    expect(r.body.temporaryPassword).toMatch(/^.{10,}$/);
    expect(JSON.stringify(r.body)).not.toMatch(/passwordHash|totpSecret|argon2/);
    // Même identifiant ailleurs sur la plateforme : refusé (unique), même dans un autre groupe.
    expect((await pf('post', `/groups/${ids.groupB}/accounts`, { firstName: 'Double', lastName: 'Emploi', phone: `+229${tel}`, role: 'GENERAL' })).status).toBe(409);
    expect((await pf('post', `/groups/${ids.groupB}/accounts`, { firstName: 'Double', lastName: 'Emploi', email: `PROMOTEUR-${stamp}@test.local`, role: 'GENERAL' })).status).toBe(409);
    // Journal du groupe (sans motif ni note) et journal de la plateforme (avec le nom du groupe).
    expect((await journal(ids.groupA, 'group.account_created'))[0].data).toMatchObject({ name: 'Awa PROMOTRICE', role: 'Responsable général du groupe' });
    const pl = await admin.platformAuditLog.findFirst({ where: { action: 'platform.group.account_created' }, orderBy: { createdAt: 'desc' } });
    expect(pl?.data).toMatchObject({ groupId: ids.groupA, groupName: NAME_A, name: 'Awa PROMOTRICE' });
    const list = await pf('get', `/groups/${ids.groupA}/accounts`);
    expect(list.body).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toMatch(/passwordHash|totpSecret|argon2/);
    expect((await pf('get', '/groups')).body.find((g: any) => g.id === ids.groupA)).toMatchObject({ activeAccounts: 1 });
    // Un groupe qui a des comptes ne se supprime pas.
    expect((await pf('delete', `/groups/${ids.groupA}`)).status).toBe(409);
    // Première connexion : par l'e-mail, sans la casse.
    const done = await firstLogin(`promoteur-${stamp}@TEST.local`, r.body.temporaryPassword);
    expect(done.codes).toHaveLength(10);
    expect(done.cookie).toMatch(/^erp_gt=/);
    accounts.general = { id: r.body.account.id, ...done };
  });
});

describe('Lot G2 · connexion : double authentification obligatoire (T-08)', () => {
  it('le cookie de session est protégé et réservé à la console', async () => {
    await nextWindow(accounts.general.id);
    const l = await gp('post', '/auth/login', undefined, { identifier: accounts.general.identifier, password: PASSWORD });
    const c = await gp('post', '/auth/code', undefined, { challenge: l.body.challenge, code: code(accounts.general.secret) });
    const raw = (c.headers['set-cookie'] as unknown as string[]).find((x) => x.startsWith('erp_gt='))!;
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Strict/i);
    expect(raw).toMatch(/Path=\/api\/v1\/group(;|$)/);
    expect(raw).toMatch(/Max-Age=28800/);
    accounts.general.cookie = cookieOf(c);
  });

  it('jamais de session avant un code valide : mot de passe juste seul, code faux, code rejoué', async () => {
    const a = accounts.general;
    // Mot de passe juste : un défi, pas de cookie.
    await unlock(a.id);
    const l = await gp('post', '/auth/login', undefined, { identifier: a.identifier, password: a.password });
    expect(l.status).toBe(201);
    expect(Object.keys(l.body).sort()).toEqual(['challenge', 'step']);
    expect(cookieOf(l)).toBe('');
    // Le défi n'ouvre pas la console.
    expect((await gp('get', '/auth/me', `erp_gt=${l.body.challenge}`)).status).toBe(401);
    // Code faux : refusé et compté.
    const wrong = await gp('post', '/auth/code', undefined, { challenge: l.body.challenge, code: '000000' });
    expect(wrong.status).toBe(401);
    expect(cookieOf(wrong)).toBe('');
    expect((await admin.groupAccount.findUniqueOrThrow({ where: { id: a.id } })).failedLogins).toBe(1);
    // Bon code : session ; le même code rejoué aussitôt est refusé.
    const ok = await gp('post', '/auth/code', undefined, { challenge: l.body.challenge, code: code(a.secret) });
    expect(ok.status).toBe(201);
    const again = await gp('post', '/auth/code', undefined, { challenge: l.body.challenge, code: code(a.secret) });
    expect(again.status).toBe(401);
    // Deux envois simultanés du même code : une seule session.
    await unlock(a.id);
    const l2 = await gp('post', '/auth/login', undefined, { identifier: a.identifier, password: a.password });
    const twice = await Promise.all([1, 2].map(() => gp('post', '/auth/code', undefined, { challenge: l2.body.challenge, code: code(a.secret) })));
    expect(twice.map((r) => r.status).sort()).toEqual([201, 401]);
    a.cookie = cookieOf(twice.find((r) => r.status === 201)!);
    await unlock(a.id);
  });

  it('5 erreurs (mot de passe ou code) bloquent le compte 15 minutes, même avec ensuite le bon mot de passe', async () => {
    await platformAccount('financier', ids.groupA, 'FINANCIER', 'Fanta');
    const f = accounts.financier;
    for (let i = 0; i < 3; i++) expect((await gp('post', '/auth/login', undefined, { identifier: f.identifier, password: 'Mauvais-mot-2026' })).status).toBe(401);
    // Bon mot de passe, puis deux codes faux : cinq erreurs en tout.
    const l = await gp('post', '/auth/login', undefined, { identifier: f.identifier, password: f.password });
    expect(l.body.step).toBe('code');
    for (let i = 0; i < 2; i++) expect((await gp('post', '/auth/code', undefined, { challenge: l.body.challenge, code: '123456' })).status).toBe(401);
    const row = await admin.groupAccount.findUniqueOrThrow({ where: { id: f.id } });
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    // Bloqué : le bon mot de passe et le bon code ne passent plus ; sa session ouverte est fermée.
    await nextWindow(f.id);
    expect((await gp('post', '/auth/code', undefined, { challenge: l.body.challenge, code: code(f.secret) })).status).toBe(401);
    expect((await gp('post', '/auth/login', undefined, { identifier: f.identifier, password: f.password })).status).toBe(401);
    expect((await gp('get', '/auth/me', f.cookie)).status).toBe(401);
    const actions = (await journal(ids.groupA)).filter((x) => x.actorId === f.id).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['group.auth.failed', 'group.auth.2fa_failed', 'group.auth.locked', 'group.auth.refused']));
    expect(actions.filter((x) => x === 'group.auth.failed')).toHaveLength(3);
    await unlock(f.id);
    await signIn(f);
  });

  it('identifiant inconnu ou mot de passe faux : la même réponse, sans indice', async () => {
    const unknown = await gp('post', '/auth/login', undefined, { identifier: '0199999999', password: 'Quelconque-2026' });
    const wrong = await gp('post', '/auth/login', undefined, { identifier: accounts.pedago?.identifier ?? accounts.financier.identifier, password: 'Quelconque-2026' });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body.message).toBe(wrong.body.message);
    await unlock(accounts.financier.id);
  });

  it('code de récupération : une seule fois, les autres sessions fermées, puis nouveau téléphone sans l’ancien', async () => {
    const f = accounts.financier;
    const before = f.cookie;
    const l = await gp('post', '/auth/login', undefined, { identifier: f.identifier, password: f.password });
    const r = await gp('post', '/auth/recovery', undefined, { challenge: l.body.challenge, code: f.codes[0].toLowerCase() });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ ok: true, recoveryCodesRemaining: 9 });
    f.cookie = cookieOf(r);
    // L'ancienne session (peut-être sur le téléphone perdu) est fermée.
    expect((await gp('get', '/auth/me', before)).status).toBe(401);
    // Le même code ne sert pas deux fois.
    const l2 = await gp('post', '/auth/login', undefined, { identifier: f.identifier, password: f.password });
    expect((await gp('post', '/auth/recovery', undefined, { challenge: l2.body.challenge, code: f.codes[0] })).status).toBe(401);
    // Nouveau téléphone grâce au jeton remis après la récupération, sans code de l'ancienne application.
    const s = await gp('post', '/auth/2fa/setup', f.cookie, { reconfigureToken: r.body.reconfigureToken });
    expect(s.status).toBe(201);
    // Le jeton d'un autre compte ne sert à rien.
    expect((await gp('post', '/auth/2fa/setup', accounts.general.cookie, { reconfigureToken: r.body.reconfigureToken })).status).toBe(403);
    const e = await gp('post', '/auth/2fa/enable', f.cookie, { setupToken: s.body.setupToken, code: code(s.body.secret) });
    expect(e.status).toBe(201);
    expect(e.body.recoveryCodes).toHaveLength(10);
    // L'ancienne application et les anciens codes ne servent plus.
    const [oldSecret, oldCodes] = [f.secret, f.codes];
    f.secret = s.body.secret;
    f.codes = e.body.recoveryCodes;
    await unlock(f.id);
    const l3 = await gp('post', '/auth/login', undefined, { identifier: f.identifier, password: f.password });
    expect((await gp('post', '/auth/code', undefined, { challenge: l3.body.challenge, code: code(oldSecret) })).status).toBe(401);
    expect((await gp('post', '/auth/recovery', undefined, { challenge: l3.body.challenge, code: oldCodes[1] })).status).toBe(401);
    expect((await gp('post', '/auth/recovery', undefined, { challenge: l3.body.challenge, code: f.codes[0] })).status).toBe(201);
    await unlock(f.id);
    expect((await admin.groupRecoveryCode.count({ where: { accountId: f.id, usedAt: null } }))).toBe(9);
    await signIn(f);
    const me = await gp('get', '/auth/me', f.cookie);
    expect(me.body.account.recoveryCodesRemaining).toBe(9);
    // Nouveaux codes avec le code actuel de l'application : les anciens ne servent plus.
    await nextWindow(f.id);
    expect((await gp('post', '/auth/recovery-codes', f.cookie, { code: '000000' })).status).toBe(403);
    await unlock(f.id);
    const regen = await gp('post', '/auth/recovery-codes', f.cookie, { code: code(f.secret) });
    expect(regen.status).toBe(201);
    expect(await admin.groupRecoveryCode.count({ where: { accountId: f.id, usedAt: null } })).toBe(10);
    expect(await admin.groupRecoveryCode.count({ where: { accountId: f.id } })).toBe(10);
    f.codes = regen.body.recoveryCodes;
    const log = (await journal(ids.groupA)).filter((x) => x.actorId === f.id).map((x) => x.action);
    expect(log).toEqual(expect.arrayContaining(['group.auth.recovery_code_used', 'group.auth.recovery_code_failed', 'group.auth.2fa_reset', 'group.auth.recovery_codes_generated']));
  });

  it("un jeton d'étape ne sert plus après un changement de mot de passe", async () => {
    // Accès remis par le Super Admin : le jeton de première connexion émis avant le nouveau mot de passe est périmé.
    await platformAccount('pedago', ids.groupA, 'PEDAGOGIQUE', 'Paul');
    const p = accounts.pedago;
    const reset = await pf('post', `/groups/${ids.groupA}/accounts/${p.id}/reset`, { motif: 'Téléphone perdu, identité vérifiée par appel' });
    expect(reset.status).toBe(201);
    const l = await gp('post', '/auth/login', undefined, { identifier: p.identifier, password: reset.body.temporaryPassword });
    const pw = await gp('post', '/auth/first-login/password', undefined, { token: l.body.token, password: 'Autre-Mot-De-Passe-2026' });
    expect(pw.status).toBe(201);
    expect((await gp('post', '/auth/first-login/2fa/setup', undefined, { token: l.body.token })).status).toBe(401);
    // Le jeton suivant fonctionne ; la double authentification est de nouveau obligatoire.
    const s = await gp('post', '/auth/first-login/2fa/setup', undefined, { token: pw.body.token });
    expect(s.status).toBe(201);
    const e = await gp('post', '/auth/first-login/2fa/enable', undefined, { token: pw.body.token, setupToken: s.body.setupToken, code: code(s.body.secret) });
    expect(e.status).toBe(201);
    accounts.pedago = { ...p, password: 'Autre-Mot-De-Passe-2026', secret: s.body.secret, cookie: cookieOf(e), codes: e.body.recoveryCodes };
    // Mots de passe trop faibles refusés à la première connexion.
    for (const weak of ['court1', 'sanschiffresdutout', '123456789012']) {
      const r2 = await gp('post', '/auth/first-login/password', undefined, { token: pw.body.token, password: weak });
      expect([weak, r2.status]).toEqual([weak, 400]);
    }
  });
});

describe('Lot G2 · sessions (T-09)', () => {
  it('8 heures au plus, 30 minutes sans activité, déconnexion : la session ne sert plus', async () => {
    const f = accounts.financier;
    expect((await gp('get', '/auth/me', f.cookie)).status).toBe(200);
    // Inactivité : 31 minutes sans appel.
    await admin.groupSession.update({ where: { id: sidOf(f.cookie) }, data: { lastUsedAt: new Date(Date.now() - 31 * 60_000) } });
    expect((await gp('get', '/auth/me', f.cookie)).status).toBe(401);
    expect((await admin.groupSession.findUniqueOrThrow({ where: { id: sidOf(f.cookie) } })).revokedReason).toBe('inactivité');
    // Durée maximale dépassée.
    await signIn(f);
    await admin.groupSession.update({ where: { id: sidOf(f.cookie) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await gp('get', '/auth/me', f.cookie)).status).toBe(401);
    // Déconnexion : le cookie est effacé et la session fermée en base.
    await signIn(f);
    const out = await gp('post', '/auth/logout', f.cookie);
    expect(out.status).toBe(201);
    expect((out.headers['set-cookie'] as unknown as string[]).find((x) => x.startsWith('erp_gt='))).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect((await gp('get', '/auth/me', f.cookie)).status).toBe(401);
    expect((await admin.groupSession.findUniqueOrThrow({ where: { id: sidOf(f.cookie) } })).revokedReason).toBe('déconnexion');
    await signIn(f);
  });

  it('changer son mot de passe ferme ses autres sessions ; liste et fermeture des appareils', async () => {
    const f = accounts.financier;
    const first = f.cookie;
    const second = await signIn(f);
    const list = await gp('get', '/auth/sessions', second);
    expect(list.status).toBe(200);
    expect(list.body.filter((s: any) => s.current)).toHaveLength(1);
    expect(list.body.length).toBeGreaterThanOrEqual(2);
    // Mot de passe actuel faux : refusé et compté (une session volée ne permet pas d'essayer sans fin).
    expect((await gp('post', '/auth/password', second, { current: 'Mauvais-2026-x', password: 'Nouveau-Mot-2026' })).status).toBe(400);
    expect((await admin.groupAccount.findUniqueOrThrow({ where: { id: f.id } })).failedLogins).toBe(1);
    expect((await gp('post', '/auth/password', second, { current: f.password, password: 'faible' })).status).toBe(400);
    const ch = await gp('post', '/auth/password', second, { current: f.password, password: 'Nouveau-Mot-2026' });
    expect(ch.status).toBe(201);
    expect(ch.body.otherSessionsClosed).toBeGreaterThanOrEqual(1);
    f.password = 'Nouveau-Mot-2026';
    expect((await gp('get', '/auth/me', first)).status).toBe(401);
    expect((await gp('get', '/auth/me', second)).status).toBe(200);
    // Fermer une autre session, puis toutes les autres.
    const third = await signIn(f);
    const sessions = (await gp('get', '/auth/sessions', third)).body as { id: string; current: boolean }[];
    const other = sessions.find((s) => !s.current)!;
    expect((await gp('post', `/auth/sessions/${other.id}/revoke`, third)).status).toBe(201);
    expect((await gp('post', `/auth/sessions/${other.id}/revoke`, third)).status).toBe(404);
    // La session d'un autre compte ne peut pas être fermée par celui-ci.
    const generalSession = await admin.groupSession.findFirst({ where: { accountId: accounts.general.id, revokedAt: null } });
    expect((await gp('post', `/auth/sessions/${generalSession!.id}/revoke`, third)).status).toBe(404);
    await signIn(f);
    const kept = f.cookie;
    expect((await gp('post', '/auth/sessions/revoke-others', kept)).body.closed).toBeGreaterThanOrEqual(1);
    expect((await gp('get', '/auth/me', third)).status).toBe(401);
    expect((await gp('get', '/auth/me', kept)).status).toBe(200);
    await unlock(f.id);
  });

  it("5 codes faux depuis une session ouverte : compte bloqué et sessions fermées", async () => {
    const p = accounts.pedago;
    expect((await gp('get', '/auth/me', p.cookie)).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await gp('post', '/auth/2fa/setup', p.cookie, { code: '000000' })).status).toBe(403);
    expect((await gp('get', '/auth/me', p.cookie)).status).toBe(401);
    const row = await admin.groupAccount.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(row.totpSecret).not.toBeNull();
    const locked = (await journal(ids.groupA, 'group.auth.locked')).filter((x) => x.actorId === p.id).pop();
    expect(locked?.data).toMatchObject({ sessionsClosed: 1 });
    await unlock(p.id);
    await signIn(p);
  });
});

describe('Lot G2 · ce que voit la console (T-02, aucune donnée d’élève)', () => {
  it('la fiche du groupe et ses établissements seulement, jamais ceux d’un autre groupe', async () => {
    const a = accounts.general;
    const me = await gp('get', '/auth/me', a.cookie);
    expect(me.status).toBe(200);
    expect(me.headers['cache-control']).toContain('no-store');
    expect(me.body.group).toMatchObject({ id: ids.groupA, name: NAME_A, promoter: 'Promoteur fictif', status: 'ACTIVE' });
    expect(me.body.group).not.toHaveProperty('notes');
    expect(me.body).toMatchObject({ idleMinutes: 30, sessionHours: 8 });
    const list = await gp('get', '/establishments', a.cookie);
    expect(list.status).toBe(200);
    expect(list.body.map((t: any) => t.id).sort()).toEqual([ids.a1, ids.a2].sort());
    for (const t of list.body) {
      expect(Object.keys(t).sort()).toEqual(['address', 'country', 'currency', 'domain', 'groupJoinedAt', 'id', 'name', 'shortName', 'slug', 'status']);
    }
    expect((await gp('get', `/establishments/${ids.a1}`, a.cookie)).status).toBe(200);
    // Une école d'un autre groupe : introuvable, même avec son identifiant exact.
    expect((await gp('get', `/establishments/${ids.b1}`, a.cookie)).status).toBe(404);
    expect((await gp('get', '/establishments/pas-un-identifiant', a.cookie)).status).toBe(400);
  });

  it("aucune route de la console ne montre d'élève, de note, de paiement ni de compte d'école", async () => {
    const a = accounts.general;
    const seen: string[] = [];
    for (const url of ['/auth/me', '/auth/sessions', '/establishments', `/establishments/${ids.a1}`, '/accounts', '/journal']) {
      const r = await gp('get', url, a.cookie);
      expect([url, r.status]).toEqual([url, 200]);
      seen.push(JSON.stringify(r.body));
    }
    const all = seen.join('\n');
    expect(all).not.toContain(STUDENT);
    expect(all).not.toMatch(/matricule|passwordHash|totpSecret|codeHash|platformNotes|Note interne fictive|"settings"/);
    // Les routes des écoles n'existent pas dans la console.
    for (const url of ['/students', '/grades', '/payments', `/establishments/${ids.a1}/students`]) {
      expect([url, (await gp('get', url, a.cookie)).status]).toEqual([url, 404]);
    }
  });

  it('rôles du groupe : comptes et journal au responsable général seulement', async () => {
    for (const k of ['financier', 'pedago'] as const) {
      const c = accounts[k].cookie;
      expect([k, (await gp('get', '/establishments', c)).status]).toEqual([k, 200]);
      expect([k, (await gp('get', '/accounts', c)).status]).toEqual([k, 403]);
      expect([k, (await gp('get', '/journal', c)).status]).toEqual([k, 403]);
      expect([k, (await gp('post', '/accounts', c, { firstName: 'X', lastName: 'Y', phone: phone(), role: 'GENERAL', code: '000000' })).status]).toEqual([k, 403]);
      expect([k, (await gp('patch', `/accounts/${accounts.general.id}`, c, { active: false })).status]).toEqual([k, 403]);
    }
    const j = await gp('get', '/journal', accounts.general.cookie);
    expect(j.status).toBe(200);
    expect(j.body.every((l: any) => l.groupId === ids.groupA)).toBe(true);
    expect(j.body.find((l: any) => l.action === 'group.auth.login')).toMatchObject({ actorKind: 'group', ip: expect.any(String) });
  });
});

describe('Lot G2 · comptes gérés par le responsable général', () => {
  it('créer un compte demande le code actuel de son application', async () => {
    const a = accounts.general;
    const body = { firstName: 'Gisèle', lastName: 'Adjointe', phone: phone(), role: 'GENERAL' };
    expect((await gp('post', '/accounts', a.cookie, body)).status).toBe(400);
    await unlock(a.id);
    expect((await gp('post', '/accounts', a.cookie, { ...body, code: '000000' })).status).toBe(403);
    expect((await admin.groupAccount.findUniqueOrThrow({ where: { id: a.id } })).failedLogins).toBe(1);
    await nextWindow(a.id);
    const r = await gp('post', '/accounts', a.cookie, { ...body, code: code(a.secret) });
    expect(r.status).toBe(201);
    expect(r.headers['cache-control']).toContain('no-store');
    expect(r.body.account).toMatchObject({ role: 'GENERAL', pendingFirstLogin: true, groupId: ids.groupA });
    const done = await firstLogin(body.phone, r.body.temporaryPassword);
    accounts.general2 = { id: r.body.account.id, ...done };
    const created = (await journal(ids.groupA, 'group.account_created')).pop();
    expect(created).toMatchObject({ actorKind: 'group', actorId: a.id, data: expect.objectContaining({ name: 'Gisèle ADJOINTE' }) });
    await unlock(a.id);
  });

  it('jamais son propre compte ; rôle changé, désactivation qui ferme aussitôt les sessions', async () => {
    const a = accounts.general;
    expect((await gp('patch', `/accounts/${a.id}`, a.cookie, { role: 'FINANCIER' })).status).toBe(400);
    expect((await gp('patch', `/accounts/${a.id}`, a.cookie, { active: false })).status).toBe(400);
    expect((await gp('patch', `/accounts/${accounts.pedago.id}`, a.cookie, {})).status).toBe(400);
    expect((await gp('patch', `/accounts/${accounts.pedago.id}`, a.cookie, { role: 'DIRECTION' })).status).toBe(400);
    const role = await gp('patch', `/accounts/${accounts.pedago.id}`, a.cookie, { role: 'FINANCIER' });
    expect(role.status).toBe(200);
    expect(role.body).toMatchObject({ role: 'FINANCIER', roleLabel: 'Responsable financier du groupe' });
    await gp('patch', `/accounts/${accounts.pedago.id}`, a.cookie, { role: 'PEDAGOGIQUE' });
    // Désactivé : la session ouverte ne sert plus, la connexion est refusée.
    expect((await gp('get', '/auth/me', accounts.pedago.cookie)).status).toBe(200);
    expect((await gp('patch', `/accounts/${accounts.pedago.id}`, a.cookie, { active: false })).status).toBe(200);
    expect((await gp('get', '/auth/me', accounts.pedago.cookie)).status).toBe(401);
    expect((await gp('post', '/auth/login', undefined, { identifier: accounts.pedago.identifier, password: accounts.pedago.password })).status).toBe(401);
    expect((await gp('patch', `/accounts/${accounts.pedago.id}`, a.cookie, { active: true })).status).toBe(200);
    await signIn(accounts.pedago);
    // Un compte d'un autre groupe : introuvable.
    await platformAccount('generalB', ids.groupB, 'GENERAL', 'Bernard');
    expect((await gp('patch', `/accounts/${accounts.generalB.id}`, a.cookie, { active: false })).status).toBe(404);
    await nextWindow(a.id);
    expect((await gp('post', `/accounts/${accounts.generalB.id}/reset`, a.cookie, { code: code(a.secret) })).status).toBe(404);
    expect((await gp('get', '/auth/me', accounts.generalB.cookie)).status).toBe(200);
    await unlock(a.id);
  });

  it('il reste toujours un responsable général actif, même si deux se retirent l’un l’autre en même temps', async () => {
    const [x, y] = [accounts.general, accounts.general2];
    const both = await Promise.all([
      gp('patch', `/accounts/${y.id}`, x.cookie, { active: false }),
      gp('patch', `/accounts/${x.id}`, y.cookie, { active: false }),
    ]);
    expect(both.filter((r) => r.status === 200)).toHaveLength(1);
    expect(both.filter((r) => r.status !== 200).every((r) => [400, 401].includes(r.status))).toBe(true);
    const generals = await admin.groupAccount.findMany({ where: { groupId: ids.groupA, role: 'GENERAL', active: true }, select: { id: true } });
    expect(generals).toHaveLength(1);
    // Remise en état : celui qui reste réactive l'autre.
    const keeper = generals[0].id === x.id ? x : y;
    const other = keeper === x ? y : x;
    expect((await gp('patch', `/accounts/${other.id}`, keeper.cookie, { active: true })).status).toBe(200);
    await signIn(other);
  });

  it("remettre l'accès d'un compte : code demandé, sessions fermées, double authentification à refaire", async () => {
    const a = accounts.general;
    const p = accounts.pedago;
    expect((await gp('post', `/accounts/${a.id}/reset`, a.cookie, { code: '123456' })).status).toBe(400);
    expect((await gp('post', `/accounts/${p.id}/reset`, a.cookie, {})).status).toBe(400);
    await unlock(a.id);
    expect((await gp('post', `/accounts/${p.id}/reset`, a.cookie, { code: '000000' })).status).toBe(403);
    await unlock(a.id);
    const r = await gp('post', `/accounts/${p.id}/reset`, a.cookie, { code: code(a.secret) });
    expect(r.status).toBe(201);
    expect(r.body.account).toMatchObject({ pendingFirstLogin: true, totpEnabled: false });
    expect((await gp('get', '/auth/me', p.cookie)).status).toBe(401);
    const row = await admin.groupAccount.findUniqueOrThrow({ where: { id: p.id } });
    expect(row).toMatchObject({ totpEnabled: false, totpSecret: null, mustChangePassword: true });
    expect(await admin.groupRecoveryCode.count({ where: { accountId: p.id } })).toBe(0);
    expect((await journal(ids.groupA, 'group.account_reset')).pop()).toMatchObject({ actorId: a.id, data: expect.objectContaining({ sessionsClosed: 1 }) });
    const done = await firstLogin(p.identifier, r.body.temporaryPassword);
    accounts.pedago = { ...p, ...done };
    await unlock(a.id);
  });
});

describe('Lot G2 · suspension du groupe par le Super Admin', () => {
  it("toutes les sessions du groupe fermées, connexion refusée, motif au seul journal de la plateforme ; les écoles ne sont pas touchées", async () => {
    expect((await pf('post', `/groups/${ids.groupA}/status`, { status: 'SUSPENDED', motif: 'x' })).status).toBe(400);
    const s = await pf('post', `/groups/${ids.groupA}/status`, { status: 'SUSPENDED', motif: 'Impayé fictif de démonstration' });
    expect(s.status).toBe(201);
    expect(s.body.sessionsClosed).toBeGreaterThanOrEqual(4);
    expect((await pf('post', `/groups/${ids.groupA}/status`, { status: 'SUSPENDED', motif: 'Encore une fois' })).status).toBe(400);
    for (const k of ['general', 'general2', 'financier', 'pedago'] as const) expect([k, (await gp('get', '/auth/me', accounts[k].cookie)).status]).toEqual([k, 401]);
    // Bon mot de passe : refus explicite, aucune session ; le groupe B n'est pas touché.
    const l = await gp('post', '/auth/login', undefined, { identifier: accounts.general.identifier, password: PASSWORD });
    expect(l.status).toBe(403);
    expect(l.body.message).toMatch(/suspendu/);
    expect(cookieOf(l)).toBe('');
    expect((await gp('get', '/auth/me', accounts.generalB.cookie)).status).toBe(200);
    expect((await admin.tenant.findMany({ where: { groupId: ids.groupA }, select: { status: true } })).every((t) => t.status === 'ACTIVE')).toBe(true);
    const g = await journal(ids.groupA, 'group.suspended');
    expect(g).toHaveLength(1);
    expect(JSON.stringify(await journal(ids.groupA))).not.toContain('Impayé fictif');
    const pl = await admin.platformAuditLog.findFirst({ where: { action: 'platform.group.suspended' }, orderBy: { createdAt: 'desc' } });
    expect(pl?.data).toMatchObject({ groupId: ids.groupA, groupName: NAME_A, motif: 'Impayé fictif de démonstration' });
    // Rétabli : la connexion fonctionne de nouveau (avec la double authentification).
    expect((await pf('post', `/groups/${ids.groupA}/status`, { status: 'ACTIVE', motif: 'Régularisation fictive' })).status).toBe(201);
    for (const k of ['general', 'general2', 'financier', 'pedago'] as const) await signIn(accounts[k]);
    expect((await journal(ids.groupA, 'group.reactivated'))).toHaveLength(1);
  });

  it("une session ouverte pendant la suspension (au même instant) est refusée à l'appel suivant", async () => {
    await admin.schoolGroup.update({ where: { id: ids.groupA }, data: { status: 'SUSPENDED' } });
    const r = await gp('get', '/auth/me', accounts.general.cookie);
    expect(r.status).toBe(403);
    await admin.schoolGroup.update({ where: { id: ids.groupA }, data: { status: 'ACTIVE' } });
    expect((await gp('get', '/auth/me', accounts.general.cookie)).status).toBe(200);
  });

  it("remise d'accès par le Super Admin : motif obligatoire, inscrit seulement au journal de la plateforme", async () => {
    const f = accounts.financier;
    expect((await pf('post', `/groups/${ids.groupA}/accounts/${f.id}/reset`, {})).status).toBe(400);
    expect((await pf('post', `/groups/${ids.groupB}/accounts/${f.id}/reset`, { motif: 'Mauvais groupe fictif' })).status).toBe(404);
    const r = await pf('post', `/groups/${ids.groupA}/accounts/${f.id}/reset`, { motif: 'Codes perdus, identité vérifiée en rendez-vous' });
    expect(r.status).toBe(201);
    expect((await gp('get', '/auth/me', f.cookie)).status).toBe(401);
    expect(JSON.stringify(await journal(ids.groupA))).not.toContain('identité vérifiée');
    const pl = await admin.platformAuditLog.findFirst({ where: { action: 'platform.group.account_reset' }, orderBy: { createdAt: 'desc' } });
    expect(pl?.data).toMatchObject({ groupName: NAME_A, motif: 'Codes perdus, identité vérifiée en rendez-vous' });
    const done = await firstLogin(f.identifier, r.body.temporaryPassword);
    accounts.financier = { ...f, ...done };
  });
});

describe('Lot G2 · espaces séparés (T-01) et adresse de la console', () => {
  it("un jeton d'école, du Super Admin ou d'une autre étape n'ouvre pas la console, et inversement", async () => {
    const jwt = new JwtService();
    const now = await admin.groupSession.findFirstOrThrow({ where: { accountId: accounts.general.id, revokedAt: null }, orderBy: { createdAt: 'desc' } });
    // Jeton signé avec la clé des écoles, au bon format : refusé.
    const school = jwt.sign({ sub: accounts.general.id, gid: ids.groupA, sid: now.id }, { secret: config.jwt.accessSecret, audience: 'group', expiresIn: 600 });
    expect((await gp('get', '/auth/me', `erp_gt=${school}`)).status).toBe(401);
    // Bonne clé, mauvaise audience (jeton d'étape) : refusé.
    const step = jwt.sign({ sub: accounts.general.id, gid: ids.groupA, sid: now.id }, { secret: derivedKey('group-tokens'), audience: 'group-2fa', expiresIn: 600 });
    expect((await gp('get', '/auth/me', `erp_gt=${step}`)).status).toBe(401);
    // Même avec la clé : une session du groupe Alpha présentée comme du groupe Bêta n'existe pas pour la base.
    const forged = jwt.sign({ sub: accounts.general.id, gid: ids.groupB, sid: now.id }, { secret: derivedKey('group-tokens'), audience: 'group', expiresIn: 600 });
    expect((await gp('get', '/auth/me', `erp_gt=${forged}`)).status).toBe(401);
    // Le cookie de la console n'ouvre ni le Super Admin ni une école ; l'en-tête Authorization n'ouvre pas la console.
    const value = accounts.general.cookie.split('=')[1];
    expect((await http.get('/api/v1/platform/tenants').set('Cookie', `erp_pt=${value}`)).status).toBe(401);
    expect((await http.get('/api/v1/platform/tenants').set('Cookie', accounts.general.cookie)).status).toBe(401);
    expect((await http.get('/api/v1/students').set('Authorization', `Bearer ${value}`)).status).toBe(401);
    expect((await http.get('/api/v1/group/auth/me').set('Authorization', `Bearer ${value}`)).status).toBe(401);
    expect((await gp('get', '/auth/me', platformCookie.replace('erp_pt=', 'erp_gt='))).status).toBe(401);
  });

  it("la console ne répond que sur l'adresse de la plateforme, jamais sur celle d'une école", async () => {
    const before = config.platformDomain;
    (config as any).platformDomain = 'cahiora.test';
    try {
      const body = { identifier: accounts.general.identifier, password: 'Mauvais-2026-x' };
      expect((await http.post('/api/v1/group/auth/login').set('Host', `g2-a1-${stamp}.cahiora.test`).send(body)).status).toBe(404);
      expect((await http.post('/api/v1/group/auth/login').set('Host', 'ecole-perso.example.org').send(body)).status).toBe(404);
      expect((await http.get('/api/v1/group/establishments').set('Host', `g2-a1-${stamp}.cahiora.test`).set('Cookie', accounts.general.cookie)).status).toBe(404);
      expect((await http.get('/api/v1/group/establishments').set('Host', 'cahiora.test').set('Cookie', accounts.general.cookie)).status).toBe(200);
      expect((await http.post('/api/v1/group/auth/login').set('Host', 'cahiora.test').send(body)).status).toBe(401);
    } finally {
      (config as any).platformDomain = before;
      await unlock(accounts.general.id);
    }
  });
});

describe('Lot G2 · cloisonnement dans la base (rôle erp_group)', () => {
  it("sans groupe de session : aucune ligne ; avec un groupe : seulement les siennes", async () => {
    const none = await asGroup(null, async (tx) => {
      const n: number[] = [];
      for (const t of ['group_accounts', 'group_sessions', 'group_recovery_codes']) n.push((await tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${t}`))[0].n);
      return n;
    });
    expect(none).toEqual([0, 0, 0]);
    const seen = await asGroup(ids.groupA, async (tx) => ({
      accounts: (await tx.$queryRaw<{ g: string }[]>`SELECT DISTINCT group_id::text AS g FROM group_accounts`).map((x) => x.g),
      sessions: (await tx.$queryRaw<{ g: string }[]>`SELECT DISTINCT group_id::text AS g FROM group_sessions`).map((x) => x.g),
      codes: (await tx.$queryRaw<{ g: string }[]>`SELECT DISTINCT group_id::text AS g FROM group_recovery_codes`).map((x) => x.g),
      other: await tx.$queryRaw`SELECT id FROM group_accounts WHERE id = ${accounts.generalB.id}::uuid`,
    }));
    expect(seen).toEqual({ accounts: [ids.groupA], sessions: [ids.groupA], codes: [ids.groupA], other: [] });
    // Écritures vers un autre groupe : sans effet ou refusées.
    const n = await asGroup(ids.groupA, (tx) => tx.$executeRaw`UPDATE group_accounts SET active = false WHERE id = ${accounts.generalB.id}::uuid`);
    expect(n).toBe(0);
    await expect(asGroup(ids.groupA, (tx) => tx.$executeRaw`
      INSERT INTO group_sessions (id, account_id, group_id, "expiresAt") VALUES (gen_random_uuid(), ${accounts.generalB.id}::uuid, ${ids.groupB}::uuid, now() + interval '1 hour')`)).rejects.toThrow(/row-level security/);
    // Une session ne peut pas relier un compte à un autre groupe que le sien (clé étrangère composée).
    await expect(admin.$executeRaw`
      INSERT INTO group_sessions (id, account_id, group_id, "expiresAt") VALUES (gen_random_uuid(), ${accounts.general.id}::uuid, ${ids.groupB}::uuid, now())`).rejects.toThrow(/foreign key/);
    // Journal du groupe : ajout seul, dans son propre groupe, sous l'étiquette « group » seulement.
    await expect(asGroup(ids.groupA, (tx) => tx.$executeRaw`
      INSERT INTO group_audit_logs (id, group_id, "actorKind", action) VALUES (gen_random_uuid(), ${ids.groupB}::uuid, 'group', 'x')`)).rejects.toThrow(/row-level security/);
    await expect(asGroup(ids.groupA, (tx) => tx.$executeRaw`
      INSERT INTO group_audit_logs (id, group_id, "actorKind", action) VALUES (gen_random_uuid(), ${ids.groupA}::uuid, 'platform', 'x')`)).rejects.toThrow(/row-level security/);
    for (const sql of ['UPDATE group_audit_logs SET action = \'x\'', 'DELETE FROM group_audit_logs', 'DELETE FROM group_accounts', 'DELETE FROM group_sessions']) {
      await expect(asGroup(ids.groupA, (tx) => tx.$executeRawUnsafe(sql))).rejects.toThrow(/permission denied/);
    }
  });

  it("la recherche d'un identifiant à la connexion ne renvoie que deux numéros, et n'est ouverte qu'à la console", async () => {
    const r = await groupDb.$queryRaw<Record<string, unknown>[]>`SELECT * FROM group_login_lookup(${null}, ${[`+229${accounts.general2.identifier}`]}::text[])`;
    expect(r).toEqual([{ account_id: accounts.general2.id, group_id: ids.groupA }]);
    for (const role of ['erp_app', 'erp_platform', 'erp_stats']) {
      const [p] = await admin.$queryRaw<{ ok: boolean }[]>`SELECT has_function_privilege(${role}, 'group_login_lookup(text, text[])', 'EXECUTE') AS ok`;
      expect([role, p.ok]).toEqual([role, false]);
    }
    await expect(app_.$queryRaw`SELECT * FROM group_login_lookup(${null}, ${['+2290100000000']}::text[])`).rejects.toThrow(/permission denied/);
  });

  it("le rôle des écoles n'a aucun droit sur les comptes de groupe ; le Super Admin ne peut pas en effacer", async () => {
    for (const t of ['group_accounts', 'group_sessions', 'group_recovery_codes']) {
      await expect(app_.$queryRawUnsafe(`SELECT count(*) FROM ${t}`)).rejects.toThrow(/permission denied/);
      const [p] = await admin.$queryRaw<{ any: boolean }[]>`
        SELECT has_table_privilege('erp_app', ${t}, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS any`;
      expect([t, p.any]).toEqual([t, false]);
    }
    await expect(platformDb.$executeRaw`DELETE FROM group_accounts WHERE id = ${accounts.generalB.id}::uuid`).rejects.toThrow(/permission denied/);
    await expect(platformDb.$executeRaw`DELETE FROM group_sessions`).rejects.toThrow(/permission denied/);
    // Un compte doit avoir un identifiant ; la double authentification active a toujours un secret.
    await expect(admin.$executeRaw`UPDATE group_accounts SET phone = NULL, email = NULL WHERE id = ${accounts.generalB.id}::uuid`).rejects.toThrow(/group_accounts_identifier_check/);
    await expect(admin.$executeRaw`UPDATE group_accounts SET "totpSecret" = NULL WHERE id = ${accounts.generalB.id}::uuid`).rejects.toThrow(/group_accounts_totp_check/);
  });
});
