/**
 * Lot G5a : la migration de la facturation jouée sur une base qui a déjà les lots G0 à G4, avec des groupes, des
 * écoles, des comptes et des journaux, comme le serait la production, avec des données entièrement fictives. Base
 * jetable erp_migration_test, vidée à chaque lancement ; le test refuse toute autre base.
 */
import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const URL = process.env.DATABASE_MIGRATION_URL ?? '';
const G5A = '20261114120000_facturation_g5a';
const PRISMA = join(__dirname, '..', 'prisma');
const SCHOOLS = [
  { id: '88888888-8888-4888-8888-888888888888', slug: 'ecole-theta', name: 'École Thêta (fictive)' },
  { id: '99999999-9999-4999-8999-999999999999', slug: 'ecole-iota', name: 'Collège Iota (fictif)' },
];
const BILLING = ['billing_calendars', 'billing_jobs', 'billing_parameters', 'commercial_terms', 'platform_alerts', 'subscription_events', 'subscriptions'];

describe('Lot G5a · migration de la facturation sur une base qui a déjà les lots G0 à G4 (données fictives)', () => {
  const db = new PrismaClient({ datasources: { db: { url: URL } } });
  const dir = mkdtempSync(join(tmpdir(), 'erp-migration-g5a-'));
  const deploy = () =>
    execSync(`npx prisma migrate deploy --schema ${join(dir, 'schema.prisma')}`, { cwd: join(__dirname, '..'), env: { ...process.env, DATABASE_URL: URL, DATABASE_ADMIN_URL: URL }, stdio: 'pipe' });
  const inSchool = <T>(tenant: string, fn: (tx: any) => Promise<T>) =>
    db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant}, true)`;
      return fn(tx);
    });
  /** Toutes les lignes des tables existantes qui comptent pour le client, avant et après la migration. */
  const snapshot = async () => {
    const rows = async (sql: string) => (await db.$queryRawUnsafe<{ r: unknown }[]>(sql)).map((x) => x.r);
    const out: Record<string, unknown[]> = {
      tenants: await rows('SELECT to_jsonb(x) AS r FROM tenants x ORDER BY id'),
      school_groups: await rows('SELECT to_jsonb(x) AS r FROM school_groups x ORDER BY id'),
      group_audit_logs: await rows('SELECT to_jsonb(x) AS r FROM group_audit_logs x ORDER BY id'),
      platform_audit_logs: await rows('SELECT to_jsonb(x) AS r FROM platform_audit_logs x ORDER BY id'),
    };
    for (const s of SCHOOLS) {
      for (const t of ['users', 'user_roles', 'audit_logs', 'notifications']) {
        out[`${s.slug}:${t}`] = await inSchool(s.id, async (tx) => (await tx.$queryRawUnsafe(`SELECT to_jsonb(x) AS r FROM ${t} x ORDER BY id`)).map((x: { r: unknown }) => x.r));
      }
    }
    return out;
  };
  let before: Record<string, unknown[]> = {};

  beforeAll(async () => {
    if (!/\/erp_migration_test(\?|$)/.test(URL)) throw new Error('Base refusée pour le test de migration : seule erp_migration_test peut être vidée');
    await db.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await db.$executeRawUnsafe('CREATE SCHEMA public');
    // Toutes les migrations d'avant la facturation (lots G0 à G4), comme sur le serveur au moment de la mise à jour.
    mkdirSync(join(dir, 'migrations'));
    cpSync(join(PRISMA, 'schema.prisma'), join(dir, 'schema.prisma'));
    for (const m of readdirSync(join(PRISMA, 'migrations'))) {
      if (m < G5A || m === 'migration_lock.toml') cpSync(join(PRISMA, 'migrations', m), join(dir, 'migrations', m), { recursive: true });
    }
    deploy();
    for (const s of SCHOOLS) {
      const [g] = await db.$queryRaw<{ id: string }[]>`INSERT INTO school_groups (id, name, "updatedAt") VALUES (gen_random_uuid(), ${s.name}, now()) RETURNING id`;
      await db.$executeRaw`INSERT INTO tenants (id, slug, name, country, currency, timezone, settings, group_id, "updatedAt", "createdAt")
        VALUES (${s.id}::uuid, ${s.slug}, ${s.name}, 'BJ', 'XOF', 'Africa/Porto-Novo', '{}'::jsonb, ${g.id}::uuid, '2026-10-01T08:00:00Z', '2026-10-01T08:00:00Z')`;
      await db.$executeRaw`INSERT INTO group_audit_logs (id, group_id, "actorKind", "actorName", action) VALUES (gen_random_uuid(), ${g.id}::uuid, 'platform', 'Super Admin fictif', 'group.created_for_school')`;
      await db.$executeRaw`INSERT INTO platform_audit_logs (id, action, "tenantId") VALUES (gen_random_uuid(), 'platform.tenant.created', ${s.id}::uuid)`;
      await inSchool(s.id, async (tx) => {
        const [u] = await tx.$queryRaw`INSERT INTO users (id, tenant_id, phone, "passwordHash", "firstName", "lastName", "updatedAt")
          VALUES (gen_random_uuid(), ${s.id}::uuid, '+2290190007001', 'empreinte-fictive', 'Direction', 'FICTIVE', now()) RETURNING id`;
        await tx.$executeRaw`INSERT INTO user_roles (id, tenant_id, "userId", role) VALUES (gen_random_uuid(), ${s.id}::uuid, ${u.id}::uuid, 'DIRECTION')`;
        await tx.$executeRaw`INSERT INTO audit_logs (id, tenant_id, "userName", action, entity) VALUES (gen_random_uuid(), ${s.id}::uuid, 'Direction FICTIVE', 'auth.login', 'User')`;
      });
    }
    before = await snapshot();
    // Puis la migration de la facturation, seule.
    cpSync(join(PRISMA, 'migrations', G5A), join(dir, 'migrations', G5A), { recursive: true });
    deploy();
  }, 240000);

  afterAll(async () => {
    await db.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it("aucune donnée existante n'est modifiée ; aucun abonnement, calendrier ou texte de conditions n'est créé d'office", async () => {
    const after = await snapshot();
    for (const [k, rows] of Object.entries(before)) {
      if (k === 'platform_audit_logs') continue;
      expect([k, after[k]]).toEqual([k, rows]);
    }
    // Le journal de la plateforme garde ses lignes et en reçoit une seule : les valeurs initiales des paramètres.
    const added = (after.platform_audit_logs as { id: string; action: string }[]).filter((r) => !(before.platform_audit_logs as { id: string }[]).some((b) => b.id === r.id));
    expect(added.map((r) => r.action)).toEqual(['billing.parameters.initial']);
    for (const r of before.platform_audit_logs) expect(after.platform_audit_logs).toContainEqual(r);
    for (const t of ['subscriptions', 'subscription_events', 'billing_calendars', 'commercial_terms', 'billing_jobs', 'platform_alerts']) {
      expect([t, await db.$queryRawUnsafe(`SELECT count(*)::int AS n FROM ${t}`)]).toEqual([t, [{ n: 0 }]]);
    }
  });

  it('paramètres initiaux du cahier des charges, en version 1 datée du 14 novembre 2026 ; les alertes du pilote restent provisoires', async () => {
    const rows = await db.$queryRaw<{ key: string; currency: string | null; value: number; from: string; by: string; reason: string }[]>`
      SELECT key, currency, value, to_char("effectiveFrom", 'YYYY-MM-DD') AS from, "createdByName" AS by, reason FROM billing_parameters ORDER BY key, currency`;
    expect(rows.map((r) => [r.key, r.currency, r.value, r.from])).toEqual([
      ['COMMISSION_APPORTEUR', null, 1500, '2026-11-14'],
      ['COMMISSION_PREMIUM', null, 2000, '2026-11-14'],
      ['COUNT_REVIEW_DAYS', null, 15, '2026-11-14'],
      ['MINIMUM_PER_ESTABLISHMENT', 'XOF', 40000, '2026-11-14'],
      ['PILOT_ALERT_FIRST_DAYS', null, 30, '2026-11-14'],
      ['PILOT_ALERT_LAST_DAYS', null, 7, '2026-11-14'],
      ['PILOT_FREE_MONTHS', null, 3, '2026-11-14'],
      ['PRICE_PER_PUPIL', 'XOF', 500, '2026-11-14'],
      ['REFERRAL_REWARD', 'XOF', 5000, '2026-11-14'],
      ['TRIAL_DAYS', null, 14, '2026-11-14'],
    ]);
    expect(new Set(rows.map((r) => r.by))).toEqual(new Set(['Mise à jour de Cahiora (lot G5a)']));
    expect(rows.filter((r) => r.reason.includes('D-G5-38')).map((r) => r.key)).toEqual(['PILOT_ALERT_FIRST_DAYS', 'PILOT_ALERT_LAST_DAYS']);
  });

  it('Row Level Security forcée, aucun droit pour les écoles, les groupes et les statistiques ; la plateforme ajoute sans jamais effacer', async () => {
    const rls = await db.$queryRaw<{ table: string; rls: boolean; forced: boolean; policies: number }[]>`
      SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced, (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = c.relname) AS policies
      FROM pg_class c WHERE c.relname = ANY(${BILLING}) ORDER BY 1`;
    expect(rls).toEqual(BILLING.map((table) => ({ table, rls: true, forced: true, policies: 2 })));
    const rights = await db.$queryRaw<{ role: string; table: string; sel: boolean; ins: boolean; upd: boolean; del: boolean; trunc: boolean }[]>`
      SELECT r AS role, t AS table, has_table_privilege(r, t, 'SELECT') AS sel, has_table_privilege(r, t, 'INSERT') AS ins, has_table_privilege(r, t, 'UPDATE') AS upd,
             has_table_privilege(r, t, 'DELETE') AS del, has_table_privilege(r, t, 'TRUNCATE') AS trunc
      FROM unnest(ARRAY['erp_app', 'erp_group', 'erp_stats', 'erp_platform']) AS r, unnest(${BILLING}::text[]) AS t ORDER BY 1, 2`;
    for (const x of rights) {
      if (x.role !== 'erp_platform') expect(x).toEqual({ role: x.role, table: x.table, sel: false, ins: false, upd: false, del: false, trunc: false });
      else expect(x).toEqual({ role: 'erp_platform', table: x.table, sel: true, ins: true, upd: ['subscriptions', 'platform_alerts'].includes(x.table), del: false, trunc: false });
    }
    // Années scolaires : la plateforme lit seulement les dates, pour proposer les calendriers.
    const cols = await db.$queryRaw<{ column: string }[]>`
      SELECT column_name AS column FROM information_schema.column_privileges WHERE grantee = 'erp_platform' AND table_name = 'academic_years' ORDER BY 1`;
    expect(cols.map((c) => c.column)).toEqual(['endDate', 'id', 'isCurrent', 'label', 'startDate', 'tenant_id']);
  });

  it('les écoles passent seulement par des fonctions limitées à l’école courante ; ni le public ni les groupes ne les appellent', async () => {
    const fns = await db.$queryRaw<{ name: string; definer: boolean; app: boolean; group: boolean; stats: boolean; public: boolean }[]>`
      SELECT p.proname AS name, p.prosecdef AS definer, has_function_privilege('erp_app', p.oid, 'EXECUTE') AS app,
             has_function_privilege('erp_group', p.oid, 'EXECUTE') AS group, has_function_privilege('erp_stats', p.oid, 'EXECUTE') AS stats,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public
      FROM pg_proc p WHERE p.proname IN ('billing_parameter_value', 'current_commercial_terms', 'current_tenant_subscription', 'current_tenant_subscription_events',
        'current_tenant_billing_calendars', 'accept_commercial_terms') ORDER BY 1`;
    expect(fns).toHaveLength(6);
    for (const f of fns) expect(f).toEqual({ name: f.name, definer: true, app: true, group: false, stats: false, public: false });
    // Hors d'une école, rien ; dans une école sans abonnement, rien.
    const [theta] = SCHOOLS;
    expect(await db.$queryRaw`SELECT * FROM current_tenant_subscription()`).toEqual([]);
    expect(await inSchool(theta.id, (tx) => tx.$queryRaw`SELECT * FROM current_tenant_subscription()`)).toEqual([]);
    // Aucune acceptation possible sans abonnement, ni sans conditions publiées.
    const [director] = await inSchool<{ id: string }[]>(theta.id, (tx) => tx.$queryRaw`SELECT id FROM users LIMIT 1`);
    await expect(inSchool(theta.id, (tx) => tx.$queryRaw`SELECT accept_commercial_terms(gen_random_uuid(), ${director.id}::uuid, 'Direction FICTIVE', NULL, DATE '2026-11-20')`))
      .rejects.toThrow(/aucun abonnement/);
  });

  it('retour arrière : refusé dès que la facturation a des données, sauf forçage ; il retire le lot sans toucher au reste, puis la migration se rejoue', async () => {
    const script = join(PRISMA, 'retour-arriere', `${G5A}.sql`);
    const rollback = (force = false) =>
      execSync(`psql "${URL}" -v ON_ERROR_STOP=1 -q -f ${script}`, { env: { ...process.env, PGOPTIONS: force ? '-c cahiora.forcer_retour=oui' : '' }, stdio: 'pipe' });
    const exists = async () => (await db.$queryRaw<{ t: string | null }[]>`SELECT to_regclass('public.subscriptions')::text AS t`)[0].t;
    const [theta] = SCHOOLS;
    // Une donnée saisie : le script s'arrête et ne change rien.
    await db.$executeRaw`INSERT INTO subscriptions (id, tenant_id, status, "updatedAt") VALUES (gen_random_uuid(), ${theta.id}::uuid, 'TRIAL', now())`;
    let refused = '';
    try {
      rollback();
    } catch (e) {
      refused = String((e as { stderr?: Buffer }).stderr ?? e);
    }
    expect(refused).toMatch(/Retour arrière arrêté, rien n'a été changé : la facturation contient déjà des données \(abonnements 1/);
    expect(await exists()).toBe('subscriptions');
    // Forcé en connaissance de cause : tout le lot part, le reste de la base ne bouge pas.
    rollback(true);
    expect(await exists()).toBeNull();
    const left = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('billing_parameter_value', 'current_commercial_terms', 'current_tenant_subscription',
        'current_tenant_subscription_events', 'current_tenant_billing_calendars', 'accept_commercial_terms', 'grant_platform_billing_role', 'subscriptions_guard', 'platform_alerts_guard')`;
    expect(left).toEqual([{ n: 0 }]);
    expect(await db.$queryRaw`SELECT 1 FROM pg_type WHERE typname = 'SubscriptionStatus'`).toEqual([]);
    expect(await db.$queryRaw`SELECT 1 FROM information_schema.column_privileges WHERE grantee = 'erp_platform' AND table_name = 'academic_years'`).toEqual([]);
    expect(await db.$queryRaw`SELECT 1 FROM _prisma_migrations WHERE migration_name = ${G5A}`).toEqual([]);
    const after = await snapshot();
    for (const [k, rows] of Object.entries(before)) {
      if (k === 'platform_audit_logs') for (const r of rows) expect(after[k]).toContainEqual(r);
      else expect([k, after[k]]).toEqual([k, rows]);
    }
    // Une nouvelle mise à jour rejoue la migration.
    deploy();
    expect(await exists()).toBe('subscriptions');
    expect(await db.$queryRaw`SELECT count(*)::int AS n FROM billing_parameters`).toEqual([{ n: 10 }]);
  });
});
