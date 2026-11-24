/**
 * Lot G5g, prestations complémentaires de Cahiora, de bout en bout sur la base de test (erp_test), avec des
 * établissements, des comptes et des prestations entièrement fictifs créés pour ce fichier. Le catalogue initial est
 * seulement lu, jamais modifié, pour que le fichier se rejoue sur la même base. Aucun devis, aucune facture, aucun
 * paiement, aucun SMS. Tests obligatoires du cahier des charges (§19) : 15 (changement de tarif jamais rétroactif),
 * 16 (prix de la formation ; son ajout à une facture viendra avec le lot G5c) et 23 (cloisonnement).
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
import { addDays } from '../src/modules/billing/billing-rules';
import { serviceCode } from '../src/modules/billing/services-rules';

const TZ = 'Africa/Porto-Novo';
const PASSWORD = 'Prestations-G5g-2026';
const SA_PASSWORD = 'Plateforme-G5g-2026';
const stamp = Date.now().toString(36);
const TABLES = ['services', 'service_versions', 'service_rates', 'service_rate_ends'];

let app: INestApplication;
let http: ReturnType<typeof request>;
const admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_ADMIN_URL } } });
const appDb = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
const platformDb = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_PLATFORM_URL } } });
const groupDb = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_GROUP_URL } } });
const statsDb = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_STATS_URL } } });

type School = { id: string; slug: string; name: string; groupId: string; direction: string };
const S: Record<'A' | 'B' | 'C', School> = {} as never;
const sa = { name: 'Super Admin prestations (fictif)', email: `g5g-${stamp}@test.local`, cookie: '', secret: '' };
const noTwoFactor = { email: `g5g-sans-2fa-${stamp}@test.local`, cookie: '' };
const today = localDay(TZ);
const day = (n: number) => addDays(today, n);
const svc = { id: '', code: '', name: `Atelier fictif G5g ${stamp}` };
const rules: Record<string, string> = {};

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
const reason = 'Règle fictive créée par les tests G5g';

/** Prix d'une prestation (par son code) pour un établissement, un jour donné. */
async function priceOf(tenantId: string, onDay: string, serviceCodeOrId = svc.code) {
  const r = await pf.get(`/billing/services/prices?tenantId=${tenantId}&day=${onDay}`).expect(200);
  return (r.body.items as { id: string; code: string; amount: number | null; catalogAmount: number | null; basis: string; label: string }[]).find((i) => i.code === serviceCodeOrId || i.id === serviceCodeOrId)!;
}

async function addRate(body: object, expected = 201) {
  return pf.post(`/billing/services/${svc.id}/rates`, { reason, ...body, code: await code() }).expect(expected);
}

async function newSchool(k: 'A' | 'B' | 'C'): Promise<School> {
  const t = await admin.tenant.create({
    data: { commercialStatus: 'CLIENT', slug: `g5g-${k.toLowerCase()}-${stamp}`, name: `École fictive G5g ${k} ${stamp}`, group: { create: { name: `Groupe fictif G5g ${k} ${stamp}` } } },
  });
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  await inTenant(t.id, async (tx) => {
    const u = await tx.user.create({ data: { tenantId: t.id, phone: '+2290190007001', firstName: 'Fictif', lastName: `DIRECTION ${k}`, passwordHash: hash, mustChangePassword: false } });
    await tx.userRole.create({ data: { tenantId: t.id, userId: u.id, role: 'DIRECTION' } });
  });
  const r = await http.post('/api/v1/auth/login').send({ tenant: t.slug, identifier: '+2290190007001', password: PASSWORD }).expect(200);
  return { id: t.id, slug: t.slug, name: t.name, groupId: t.groupId, direction: r.body.accessToken as string };
}

const schoolJournal = (tenantId: string) => inTenant(tenantId, (tx) => tx.auditLog.findMany({ where: { action: { startsWith: 'billing.service' } }, orderBy: { createdAt: 'asc' } }));

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  configureApp(app);
  await app.init();
  http = request(app.getHttpServer());

  S.A = await newSchool('A');
  S.B = await newSchool('B');
  S.C = await newSchool('C');

  for (const email of [sa.email, noTwoFactor.email]) {
    await admin.platformAdmin.create({ data: { email, name: email === sa.email ? sa.name : 'Super Admin sans 2FA (fictif)', passwordHash: await argon2.hash(SA_PASSWORD), mustChangePassword: false, mustSetupTwoFactor: false } });
  }
  sa.cookie = cookieOf(await http.post('/api/v1/platform/auth/login').send({ email: sa.email, password: SA_PASSWORD }).expect(201));
  noTwoFactor.cookie = cookieOf(await http.post('/api/v1/platform/auth/login').send({ email: noTwoFactor.email, password: SA_PASSWORD }).expect(201));
  const setup = await pf.post('/auth/2fa/setup').expect(201);
  sa.secret = setup.body.secret;
  await pf.post('/auth/2fa/enable', { code: await code(), setupToken: setup.body.setupToken }).expect(201);
});

afterAll(async () => {
  await app?.close();
  await admin.platformAdmin.deleteMany({ where: { email: { in: [sa.email, noTwoFactor.email] } } });
  await Promise.all([admin.$disconnect(), appDb.$disconnect(), platformDb.$disconnect(), groupDb.$disconnect(), statsDb.$disconnect()]);
});

describe('Lot G5g · prestations complémentaires : catalogue, prix datés, remises, tarifs particuliers, gratuités (données fictives)', () => {
  it('Catalogue initial du cahier des charges (§7) : quatre prestations datées du 14 novembre 2026, prix jamais codés en dur, descriptions à rédiger', async () => {
    const c = (await pf.get('/billing/services').expect(200)).body as { services: { code: string; name: string; pricing: string; active: boolean; description: string | null; prices: { currency: string; value: number; since: string }[] }[] };
    const byCode = new Map(c.services.map((s) => [s.code, s]));
    expect(byCode.get('CONFIGURATION_AUTONOME')).toMatchObject({ name: 'Configuration autonome', pricing: 'FREE', active: true, description: null, prices: [] });
    expect(byCode.get('FORMATION_ET_PRISE_EN_MAIN')).toMatchObject({ name: 'Formation et prise en main', pricing: 'FIXED', active: true, description: null, prices: [{ currency: 'XOF', value: 15000, since: '2026-11-14' }] });
    expect(byCode.get('PARAMETRAGE_COMPLET')).toMatchObject({ name: 'Paramétrage complet', pricing: 'FIXED', prices: [{ currency: 'XOF', value: 50000, since: '2026-11-14' }] });
    expect(byCode.get('INTERVENTION_SUR_SITE')).toMatchObject({ name: 'Intervention sur site', pricing: 'QUOTE', prices: [] });
    // Les prix sont des lignes datées de la base, avec leur motif, pas des valeurs du code.
    const rows = await admin.serviceRate.findMany({ where: { service: { code: { in: ['FORMATION_ET_PRISE_EN_MAIN', 'PARAMETRAGE_COMPLET'] } }, createdById: null } });
    expect(rows.map((r) => [r.kind, r.currency, r.value, r.effectiveFrom.toISOString().slice(0, 10)]).sort()).toEqual([['PRICE', 'XOF', 15000, '2026-11-14'], ['PRICE', 'XOF', 50000, '2026-11-14']]);
  });

  it('Test 16 (prix) : pour un établissement neuf, formation 15 000 FCFA, paramétrage 50 000 FCFA, configuration autonome gratuite, intervention sur devis ; rien ne lui est imposé', async () => {
    expect(await priceOf(S.A.id, today, 'FORMATION_ET_PRISE_EN_MAIN')).toMatchObject({ amount: 15000, basis: 'CATALOG', label: 'Prix du catalogue' });
    expect(await priceOf(S.A.id, today, 'PARAMETRAGE_COMPLET')).toMatchObject({ amount: 50000, basis: 'CATALOG' });
    expect(await priceOf(S.A.id, today, 'CONFIGURATION_AUTONOME')).toMatchObject({ amount: 0, basis: 'FREE_SERVICE' });
    expect(await priceOf(S.A.id, today, 'INTERVENTION_SUR_SITE')).toMatchObject({ amount: null, basis: 'QUOTE' });
    // Aucune prestation n'est rattachée d'office à un établissement : ni règle, ni ligne, ni journal.
    expect(await admin.serviceRate.count({ where: { tenantId: S.A.id } })).toBe(0);
    expect(await schoolJournal(S.A.id)).toEqual([]);
  });

  it('Double authentification : sans elle, ou avec un code faux, toute modification du catalogue est refusée et tracée', async () => {
    const body = { name: `Refusée ${stamp}`, pricing: 'FREE', effectiveFrom: today, reason };
    const without = await pf.post('/billing/services', { ...body, code: '123456' }, noTwoFactor.cookie).expect(403);
    expect(without.body.message).toMatch(/exige la double authentification/);
    // La lecture du catalogue reste ouverte au Super Admin sans double authentification.
    await pf.get('/billing/services', noTwoFactor.cookie).expect(200);
    const failedBefore = await admin.platformAuditLog.count({ where: { action: 'billing.2fa_failed' } });
    const bad = await pf.post('/billing/services', { ...body, code: authenticator.generate(sa.secret) === '000000' ? '111111' : '000000' }).expect(403);
    expect(bad.body.message).toMatch(/incorrect ou expiré/);
    expect(await admin.platformAuditLog.count({ where: { action: 'billing.2fa_failed' } })).toBe(failedBefore + 1);
    expect(await admin.service.count({ where: { code: serviceCode(body.name) } })).toBe(0);
  });

  it('Créer une prestation : version 1 datée, prix de départ, code stable, nom unique, jamais rétroactive', async () => {
    const yesterday = day(-1);
    const retro = await pf.post('/billing/services', { name: svc.name, pricing: 'FIXED', price: 20000, currency: 'XOF', effectiveFrom: yesterday, reason, code: await code() }).expect(400);
    expect(retro.body.message).toContain('La date d’effet ne peut pas être passée : un changement ne s’applique jamais avant sa saisie');
    const quote = await pf.post('/billing/services', { name: svc.name, pricing: 'QUOTE', price: 20000, currency: 'XOF', effectiveFrom: today, reason, code: await code() }).expect(400);
    expect(quote.body.message).toContain('Un prix de départ va seulement avec un prix fixe');
    const r = await pf.post('/billing/services', { name: svc.name, description: 'Atelier fictif créé par les tests', pricing: 'FIXED', price: 20000, currency: 'XOF', effectiveFrom: today, reason, code: await code() }).expect(201);
    svc.id = r.body.id;
    svc.code = r.body.code;
    expect(svc.code).toBe(serviceCode(svc.name));
    // Même nom, majuscules et accents mis à part : refusé.
    const dup = await pf.post('/billing/services', { name: svc.name.toUpperCase(), pricing: 'FREE', effectiveFrom: today, reason, code: await code() }).expect(409);
    expect(dup.body.message).toBe('Une prestation porte déjà ce nom');
    expect(await priceOf(S.A.id, today)).toMatchObject({ amount: 20000, basis: 'CATALOG' });
    const log = await admin.platformAuditLog.findFirstOrThrow({ where: { action: 'billing.service_created', data: { path: ['code'], equals: svc.code } } });
    expect(log.data).toMatchObject({ name: svc.name, pricing: 'FIXED', effectiveFrom: today, price: 'Prix du catalogue : 20 000 FCFA', reason });
  });

  it('Test 15 : un nouveau prix a une date d’effet jamais passée et ne change pas le prix des jours d’avant', async () => {
    await addRate({ kind: 'PRICE', currency: 'XOF', value: 22000, effectiveFrom: day(10) });
    expect(await priceOf(S.A.id, today)).toMatchObject({ amount: 20000 });
    expect(await priceOf(S.A.id, day(9))).toMatchObject({ amount: 20000 });
    expect(await priceOf(S.A.id, day(10))).toMatchObject({ amount: 22000 });
    expect((await addRate({ kind: 'PRICE', currency: 'XOF', value: 1, effectiveFrom: day(-1) }, 400)).body.message).toContain('La date d’effet ne peut pas être passée : un changement ne s’applique jamais avant sa saisie');
    expect((await addRate({ kind: 'PRICE', tenantId: S.A.id, currency: 'XOF', value: 1, effectiveFrom: today }, 400)).body.message).toContain('Le prix du catalogue vaut pour tous les établissements : pour un seul, choisissez un tarif particulier');
    expect((await addRate({ kind: 'PRICE', currency: 'XOF', value: 1, effectiveFrom: today, effectiveTo: day(5) }, 400)).body.message).toContain('Un prix du catalogue n’a pas de dernier jour : un nouveau prix le remplace');
    const s = ((await pf.get('/billing/services')).body.services as { id: string; prices: unknown[] }[]).find((x) => x.id === svc.id)!;
    expect(s.prices).toEqual([{ currency: 'XOF', value: 20000, since: today, next: { value: 22000, effectiveFrom: day(10) } }]);
  });

  it('Remises, tarifs particuliers et gratuités : une seule règle s’applique, jamais de cumul ; journaux de l’établissement et du groupe sans le motif', async () => {
    rules.all10 = (await addRate({ kind: 'DISCOUNT_PERCENT', value: 1000, effectiveFrom: today })).body.id;
    rules.a5000 = (await addRate({ kind: 'DISCOUNT_AMOUNT', tenantId: S.A.id, value: 5000, effectiveFrom: today })).body.id;
    rules.b12000 = (await addRate({ kind: 'SPECIAL_PRICE', tenantId: S.B.id, value: 12000, effectiveFrom: today })).body.id;
    rules.cFree = (await addRate({ kind: 'FREE', tenantId: S.C.id, effectiveFrom: day(5), effectiveTo: day(6) })).body.id;
    expect(await priceOf(S.C.id, today)).toMatchObject({ amount: 18000, catalogAmount: 20000, basis: 'DISCOUNT', label: 'Remise pour tous les établissements' });
    expect(await priceOf(S.A.id, today)).toMatchObject({ amount: 15000, basis: 'DISCOUNT', label: 'Remise pour cet établissement' });
    expect(await priceOf(S.B.id, today)).toMatchObject({ amount: 12000, basis: 'SPECIAL_PRICE' });
    expect(await priceOf(S.C.id, day(5))).toMatchObject({ amount: 0, basis: 'FREE', label: 'Gratuité pour cet établissement' });
    expect(await priceOf(S.C.id, day(7))).toMatchObject({ amount: 18000 });
    expect(await priceOf(S.C.id, day(10))).toMatchObject({ amount: 19800, catalogAmount: 22000 });
    // Le catalogue initial ne change pas pour ces établissements.
    expect(await priceOf(S.A.id, today, 'FORMATION_ET_PRISE_EN_MAIN')).toMatchObject({ amount: 15000 });
    // Contrôles du serveur.
    expect((await addRate({ kind: 'SPECIAL_PRICE', value: 12000, effectiveFrom: today }, 400)).body.message).toContain('Un tarif particulier vise un établissement');
    expect((await addRate({ kind: 'DISCOUNT_AMOUNT', tenantId: S.A.id, currency: 'XAF', value: 100, effectiveFrom: today }, 400)).body.message).toContain('Monnaie : celle de l’établissement');
    expect((await addRate({ kind: 'DISCOUNT_PERCENT', value: 0, effectiveFrom: today }, 400)).body.message).toContain('Remise : entre 0,01 % et 100 %');
    await addRate({ kind: 'FREE', tenantId: '00000000-0000-4000-8000-000000000000', effectiveFrom: today }, 404);
    // Journaux : l'établissement visé et son groupe le voient, sans le motif ; la plateforme garde le motif.
    const a = await schoolJournal(S.A.id);
    expect(a.map((l) => [l.action, (l.data as { rule: string }).rule])).toEqual([['billing.service_rule_added', 'Remise en montant de 5 000 FCFA']]);
    expect(a[0].data).not.toHaveProperty('reason');
    expect((await schoolJournal(S.B.id)).map((l) => (l.data as { rule: string }).rule)).toEqual(['Tarif particulier : 12 000 FCFA']);
    const g = await admin.groupAuditLog.findMany({ where: { groupId: S.A.groupId, action: 'billing.service_rule_added' } });
    expect(g).toHaveLength(1);
    expect(g[0].data).toMatchObject({ tenantName: S.A.name, service: svc.name, rule: 'Remise en montant de 5 000 FCFA' });
    expect(g[0].data).not.toHaveProperty('reason');
    const p = await admin.platformAuditLog.findFirstOrThrow({ where: { action: 'billing.service_rule_added', tenantId: S.A.id } });
    expect(p.data).toMatchObject({ reason, code: svc.code });
  });

  it('Arrêter une règle : jamais dans le passé, une seule fois ; une règle à venir s’annule ; un prix du catalogue ne s’arrête pas', async () => {
    const end = async (id: string, body: object, expected = 201) => pf.post(`/billing/services/rates/${id}/end`, { reason: 'Arrêt fictif (tests G5g)', ...body, code: await code() }).expect(expected);
    expect((await end(rules.a5000, { lastDay: day(-1) }, 400)).body.message).toContain('Le dernier jour est au plus tôt aujourd’hui : une règle ne s’arrête jamais dans le passé');
    expect((await end(rules.a5000, { lastDay: today })).body).toMatchObject({ lastDay: today, cancelled: false });
    expect(await priceOf(S.A.id, today)).toMatchObject({ amount: 15000 }); // s'applique encore aujourd'hui
    expect(await priceOf(S.A.id, day(1))).toMatchObject({ amount: 18000, label: 'Remise pour tous les établissements' });
    expect((await end(rules.a5000, { lastDay: day(3) }, 400)).body.message).toContain('Cette règle est déjà arrêtée');
    // Une gratuité qui n'a pas commencé s'annule : dernier jour = veille de son début.
    expect((await end(rules.cFree, { lastDay: day(4) })).body).toMatchObject({ cancelled: true });
    expect(await priceOf(S.C.id, day(5))).toMatchObject({ amount: 18000 });
    // Une règle se raccourcit seulement.
    const short = (await addRate({ kind: 'DISCOUNT_PERCENT', tenantId: S.C.id, value: 5000, effectiveFrom: day(20), effectiveTo: day(25) })).body.id;
    expect((await end(short, { lastDay: day(30) }, 400)).body.message).toContain('Une règle se raccourcit seulement : pour la prolonger, créez-en une nouvelle');
    // Un prix du catalogue ne s'arrête pas, ni par l'API ni par la base.
    const price = await admin.serviceRate.findFirstOrThrow({ where: { serviceId: svc.id, kind: 'PRICE', value: 20000 } });
    expect((await end(price.id, { lastDay: day(30) }, 400)).body.message).toContain('Un prix du catalogue ne s’arrête pas : un nouveau prix le remplace');
    await expect(admin.$executeRaw`INSERT INTO service_rate_ends (id, "rateId", "lastDay", reason, "createdByName") VALUES (gen_random_uuid(), ${price.id}::uuid, ${day(30)}::date, 'x', 'x')`)
      .rejects.toThrow(/Un prix du catalogue ne s'arrête pas/);
    const p = await admin.platformAuditLog.findMany({ where: { action: { in: ['billing.service_rule_ended', 'billing.service_rule_cancelled'] }, data: { path: ['code'], equals: svc.code } }, orderBy: { createdAt: 'asc' } });
    expect(p.map((l) => l.action)).toEqual(['billing.service_rule_ended', 'billing.service_rule_cancelled']);
    expect((await schoolJournal(S.C.id)).map((l) => l.action)).toEqual(['billing.service_rule_added', 'billing.service_rule_cancelled', 'billing.service_rule_added']);
  });

  it('Versions datées : description, mode de prix et désactivation ; une version identique ou un nom déjà pris sont refusés', async () => {
    const version = async (body: object, expected = 201) => pf.post(`/billing/services/${svc.id}/versions`, { name: svc.name, description: 'Atelier fictif créé par les tests', pricing: 'FIXED', active: true, effectiveFrom: today, reason, ...body, code: await code() }).expect(expected);
    expect((await version({}, 400)).body.message).toContain('Rien n’a changé par rapport à la dernière version');
    expect((await version({ description: 'Deux demi-journées fictives' })).body).toMatchObject({ version: 2 });
    expect((await version({ description: 'Deux demi-journées fictives', active: false, effectiveFrom: day(20) })).body).toMatchObject({ version: 3 });
    expect((await version({ name: 'Formation et prise en main', description: 'x' }, 409)).body.message).toBe('Une prestation porte déjà ce nom');
    expect((await version({ description: 'x', effectiveFrom: day(-1) }, 400)).body.message).toContain('La date d’effet ne peut pas être passée : un changement ne s’applique jamais avant sa saisie');
    expect(await priceOf(S.C.id, day(19))).toMatchObject({ amount: 19800 });
    expect(await priceOf(S.C.id, day(20))).toMatchObject({ amount: null, basis: 'INACTIVE' });
    const s = ((await pf.get('/billing/services')).body.services as { id: string; description: string; active: boolean; upcoming: { version: number; active: boolean; effectiveFrom: string }[] }[]).find((x) => x.id === svc.id)!;
    expect(s).toMatchObject({ description: 'Deux demi-journées fictives', active: true, upcoming: [{ version: 3, active: false, effectiveFrom: day(20) }] });
  });

  it('Changements simultanés : deux créations du même nom, une seule passe ; deux versions de la même prestation ne portent jamais le même numéro', async () => {
    const name = `Atelier simultané G5g ${stamp}`;
    const c = await code();
    const created = await Promise.all([1, 2].map(() => pf.post('/billing/services', { name, pricing: 'FREE', effectiveFrom: today, reason, code: c })));
    expect(created.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(created.find((r) => r.status === 409)!.body.message).toBe('Une prestation porte déjà ce nom');
    expect(await admin.service.count({ where: { code: { startsWith: serviceCode(name) } } })).toBe(1);
    const id = created.find((r) => r.status === 201)!.body.id as string;
    // Deux versions envoyées ensemble : la seconde attend la première ; si elle partait de la même version, elle est refusée.
    const sent = await Promise.all(['A', 'B'].map((x) => pf.post(`/billing/services/${id}/versions`, { name, description: `Version fictive ${x}`, pricing: 'FREE', active: true, effectiveFrom: today, reason, code: c })));
    const ok = sent.filter((r) => r.status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of sent.filter((x) => x.status !== 201)) expect([r.status, r.body.message]).toEqual([409, 'Cette prestation vient de changer : rechargez la page']);
    const versions = await admin.serviceVersion.findMany({ where: { serviceId: id }, orderBy: { version: 'asc' }, select: { version: true } });
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3].slice(0, 1 + ok.length));
  });

  it('Historique : création, versions, prix, règles et arrêts, avec l’auteur et le motif', async () => {
    const h = (await pf.get(`/billing/services/${svc.id}/history`).expect(200)).body as { entries: { title: string; detail: string; by: string; reason: string }[] };
    const titles = h.entries.map((e) => e.title);
    for (const t of ['Prestation créée', 'Version 2', 'Version 3', 'Prix du catalogue · tous les établissements', `Remise en montant · ${S.A.name}`, `Règle arrêtée · ${S.A.name}`, `Règle annulée · ${S.C.name}`]) {
      expect(titles).toContain(t);
    }
    expect(new Set(h.entries.map((e) => e.by))).toEqual(new Set([sa.name]));
    expect(h.entries.every((e) => e.reason.length >= 5)).toBe(true);
    expect(h.entries.find((e) => e.title === 'Version 3')!.detail).toBe(`Désactivée · à partir du ${new Date(`${day(20)}T00:00:00Z`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}`);
  });

  it('Test 23 : les écoles, les groupes et les statistiques n’ont aucun droit sur les prestations ; une direction n’appelle pas l’API de la plateforme', async () => {
    for (const t of TABLES) {
      for (const db of [appDb, groupDb, statsDb]) await expect(db.$queryRawUnsafe(`SELECT count(*) FROM ${t}`)).rejects.toThrow(/permission denied/);
    }
    for (const url of ['/billing/services', `/billing/services/prices?tenantId=${S.A.id}`, `/billing/services/${svc.id}/history`]) {
      const r = await http.get(`/api/v1/platform${url}`).set('Authorization', `Bearer ${S.A.direction}`);
      expect([401, 403]).toContain(r.status);
    }
    const w = await http.post(`/api/v1/platform/billing/services/${svc.id}/rates`).set('Authorization', `Bearer ${S.A.direction}`).send({ kind: 'FREE', tenantId: S.A.id, effectiveFrom: today, reason, code: '000000' });
    expect([401, 403]).toContain(w.status);
    // Le journal de B ne parle que de B.
    expect((await schoolJournal(S.B.id)).map((l) => l.action)).toEqual(['billing.service_rule_added']);
  });

  it('Ajout seul : ni le propriétaire de la base ni la plateforme ne modifient ou n’effacent une prestation, une version, une règle ou un arrêt ; la base refuse une règle incohérente', async () => {
    const refused = (sql: string, db: PrismaClient = admin) => expect(db.$executeRawUnsafe(sql)).rejects.toThrow();
    for (const db of [admin, platformDb]) {
      await refused(`UPDATE services SET code = 'X' WHERE id = '${svc.id}'`, db);
      await refused(`DELETE FROM services WHERE id = '${svc.id}'`, db);
      await refused(`UPDATE service_versions SET name = 'Autre nom' WHERE "serviceId" = '${svc.id}'`, db);
      await refused(`DELETE FROM service_versions WHERE "serviceId" = '${svc.id}'`, db);
      await refused(`UPDATE service_rates SET value = 1 WHERE "serviceId" = '${svc.id}'`, db);
      await refused(`DELETE FROM service_rates WHERE "serviceId" = '${svc.id}'`, db);
      await refused(`UPDATE service_rate_ends SET "lastDay" = "lastDay" + 30 WHERE "rateId" = '${rules.a5000}'`, db);
      await refused(`DELETE FROM service_rate_ends WHERE "rateId" = '${rules.a5000}'`, db);
    }
    for (const t of TABLES) await refused(`TRUNCATE ${t} CASCADE`);
    await expect(platformDb.$executeRawUnsafe(`UPDATE service_rates SET value = 1 WHERE id = '${rules.all10}'`)).rejects.toThrow(/permission denied/);
    expect((await admin.serviceRate.findUniqueOrThrow({ where: { id: rules.all10 } })).value).toBe(1000);
    // Contrôles de la base, en plus de ceux de l'API.
    const insert = (kind: string, tenant: string | null, currency: string | null, value: number | null, to: string | null = null) =>
      admin.$executeRaw`INSERT INTO service_rates (id, "serviceId", tenant_id, kind, currency, value, "effectiveFrom", "effectiveTo", reason, "createdByName")
        VALUES (gen_random_uuid(), ${svc.id}::uuid, ${tenant}::uuid, ${kind}::"ServiceRateKind", ${currency}, ${value}, ${day(40)}::date, ${to}::date, 'x', 'x')`;
    await expect(insert('SPECIAL_PRICE', null, 'XOF', 1000)).rejects.toThrow(/service_rates_scope_check/);
    await expect(insert('PRICE', S.A.id, 'XOF', 1000)).rejects.toThrow(/service_rates_scope_check/);
    await expect(insert('DISCOUNT_PERCENT', null, null, 0)).rejects.toThrow(/service_rates_value_check/);
    await expect(insert('FREE', null, null, 10)).rejects.toThrow(/service_rates_value_check/);
    await expect(insert('DISCOUNT_AMOUNT', null, 'XOF', -5)).rejects.toThrow(/service_rates_value_check/);
    await expect(insert('FREE', null, null, null, day(39))).rejects.toThrow(/service_rates_dates_check/);
  });
});
