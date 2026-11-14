/**
 * Lot G5g : la migration des prestations complémentaires jouée sur une base qui a déjà les lots G0 à G5a, avec des
 * groupes, des écoles, des comptes, des journaux et un abonnement, comme le serait la production après le lot G5a,
 * avec des données entièrement fictives. Base jetable erp_migration_test, vidée à chaque lancement ; le test refuse
 * toute autre base.
 */
import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const URL = process.env.DATABASE_MIGRATION_URL ?? '';
const G5G = '20261114180000_prestations_g5g';
const PRISMA = join(__dirname, '..', 'prisma');
const SCHOOLS = [
  { id: '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a', slug: 'ecole-kappa', name: 'École Kappa (fictive)' },
  { id: '7b7b7b7b-7b7b-4b7b-8b7b-7b7b7b7b7b7b', slug: 'ecole-lambda', name: 'Lycée Lambda (fictif)' },
];
const SERVICES = ['service_rate_ends', 'service_rates', 'service_versions', 'services'];
const BILLING = ['billing_calendars', 'billing_jobs', 'billing_parameters', 'commercial_terms', 'platform_alerts', 'subscription_events', 'subscriptions'];

describe('Lot G5g · migration des prestations sur une base qui a déjà les lots G0 à G5a (données fictives)', () => {
  const db = new PrismaClient({ datasources: { db: { url: URL } } });
  const dir = mkdtempSync(join(tmpdir(), 'erp-migration-g5g-'));
  const deploy = () =>
    execSync(`npx prisma migrate deploy --schema ${join(dir, 'schema.prisma')}`, { cwd: join(__dirname, '..'), env: { ...process.env, DATABASE_URL: URL, DATABASE_ADMIN_URL: URL }, stdio: 'pipe' });
  const inSchool = <T>(tenant: string, fn: (tx: any) => Promise<T>) =>
    db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant}, true)`;
      return fn(tx);
    });
  /** Toutes les lignes des tables existantes qui comptent pour le client, facturation du lot G5a comprise. */
  const snapshot = async () => {
    const rows = async (sql: string) => (await db.$queryRawUnsafe<{ r: unknown }[]>(sql)).map((x) => x.r);
    const out: Record<string, unknown[]> = {};
    for (const t of ['tenants', 'school_groups', 'group_audit_logs', 'platform_audit_logs', ...BILLING]) out[t] = await rows(`SELECT to_jsonb(x) AS r FROM ${t} x ORDER BY id`);
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
    // Toutes les migrations d'avant les prestations (lots G0 à G5a), comme sur le serveur au moment de la mise à jour.
    mkdirSync(join(dir, 'migrations'));
    cpSync(join(PRISMA, 'schema.prisma'), join(dir, 'schema.prisma'));
    for (const m of readdirSync(join(PRISMA, 'migrations'))) {
      if (m < G5G || m === 'migration_lock.toml') cpSync(join(PRISMA, 'migrations', m), join(dir, 'migrations', m), { recursive: true });
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
    // Un abonnement à l'essai et son événement, pour la première école : la facturation du lot G5a a déjà des données.
    const [kappa] = SCHOOLS;
    const [sub] = await db.$queryRaw<{ id: string }[]>`INSERT INTO subscriptions (id, tenant_id, status, "updatedAt") VALUES (gen_random_uuid(), ${kappa.id}::uuid, 'TRIAL', now()) RETURNING id`;
    await db.$executeRaw`INSERT INTO subscription_events (id, "subscriptionId", tenant_id, kind, "toStatus", "actorKind", "actorName")
      VALUES (gen_random_uuid(), ${sub.id}::uuid, ${kappa.id}::uuid, 'trial.started', 'TRIAL', 'platform', 'Super Admin fictif')`;
    before = await snapshot();
    // Puis la migration des prestations, seule.
    cpSync(join(PRISMA, 'migrations', G5G), join(dir, 'migrations', G5G), { recursive: true });
    deploy();
  }, 240000);

  afterAll(async () => {
    await db.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it("aucune donnée existante n'est modifiée, facturation du lot G5a comprise ; aucune prestation n'est rattachée d'office à un établissement", async () => {
    const after = await snapshot();
    for (const [k, rows] of Object.entries(before)) {
      if (k === 'platform_audit_logs') continue;
      expect([k, after[k]]).toEqual([k, rows]);
    }
    // Le journal de la plateforme garde ses lignes et en reçoit une seule : le catalogue initial.
    const added = (after.platform_audit_logs as { id: string; action: string; tenantId: string | null; data: unknown }[]).filter(
      (r) => !(before.platform_audit_logs as { id: string }[]).some((b) => b.id === r.id),
    );
    expect(added.map((r) => [r.action, r.tenantId, r.data])).toEqual([['billing.services.initial', null, { source: 'migration prestations_g5g', count: 4 }]]);
    for (const r of before.platform_audit_logs) expect(after.platform_audit_logs).toContainEqual(r);
    expect(await db.$queryRaw`SELECT count(*)::int AS n FROM service_rates WHERE tenant_id IS NOT NULL OR kind <> 'PRICE'`).toEqual([{ n: 0 }]);
    expect(await db.$queryRaw`SELECT count(*)::int AS n FROM service_rate_ends`).toEqual([{ n: 0 }]);
    // Aucune ligne n'est ajoutée aux journaux des groupes et des écoles (comparés plus haut) : rien n'est imposé à un client.
  });

  it('catalogue initial du cahier des charges (§7), en version 1 datée du 14 novembre 2026 ; descriptions à rédiger ; prix en XOF seulement', async () => {
    const rows = await db.$queryRaw<{ code: string; name: string; description: string | null; pricing: string; active: boolean; from: string; by: string; byId: string | null }[]>`
      SELECT s.code, v.name, v.description, v.pricing::text AS pricing, v.active, to_char(v."effectiveFrom", 'YYYY-MM-DD') AS from, v."createdByName" AS by, v."createdById" AS "byId"
      FROM services s JOIN service_versions v ON v."serviceId" = s.id ORDER BY s.code, v.version`;
    expect(rows.map((r) => [r.code, r.name, r.description, r.pricing, r.active, r.from])).toEqual([
      ['CONFIGURATION_AUTONOME', 'Configuration autonome', null, 'FREE', true, '2026-11-14'],
      ['FORMATION_ET_PRISE_EN_MAIN', 'Formation et prise en main', null, 'FIXED', true, '2026-11-14'],
      ['INTERVENTION_SUR_SITE', 'Intervention sur site', null, 'QUOTE', true, '2026-11-14'],
      ['PARAMETRAGE_COMPLET', 'Paramétrage complet', null, 'FIXED', true, '2026-11-14'],
    ]);
    expect(new Set(rows.map((r) => r.by))).toEqual(new Set(['Mise à jour de Cahiora (lot G5g)']));
    expect(rows.every((r) => r.byId === null)).toBe(true);
    const prices = await db.$queryRaw<{ code: string; kind: string; tenant: string | null; currency: string; value: number; from: string; to: string | null }[]>`
      SELECT s.code, r.kind::text AS kind, r.tenant_id AS tenant, r.currency, r.value, to_char(r."effectiveFrom", 'YYYY-MM-DD') AS from, r."effectiveTo"::text AS to
      FROM service_rates r JOIN services s ON s.id = r."serviceId" ORDER BY s.code`;
    expect(prices).toEqual([
      { code: 'FORMATION_ET_PRISE_EN_MAIN', kind: 'PRICE', tenant: null, currency: 'XOF', value: 15000, from: '2026-11-14', to: null },
      { code: 'PARAMETRAGE_COMPLET', kind: 'PRICE', tenant: null, currency: 'XOF', value: 50000, from: '2026-11-14', to: null },
    ]);
  });

  it('Row Level Security forcée, aucun droit pour les écoles, les groupes et les statistiques ; la plateforme lit et ajoute, sans modifier ni effacer', async () => {
    const rls = await db.$queryRaw<{ table: string; rls: boolean; forced: boolean; policies: number }[]>`
      SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced, (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = c.relname) AS policies
      FROM pg_class c WHERE c.relname = ANY(${SERVICES}) AND c.relkind = 'r' ORDER BY 1`;
    expect(rls).toEqual(SERVICES.map((table) => ({ table, rls: true, forced: true, policies: 2 })));
    const rights = await db.$queryRaw<{ role: string; table: string; sel: boolean; ins: boolean; upd: boolean; del: boolean; trunc: boolean }[]>`
      SELECT r AS role, t AS table, has_table_privilege(r, t, 'SELECT') AS sel, has_table_privilege(r, t, 'INSERT') AS ins, has_table_privilege(r, t, 'UPDATE') AS upd,
             has_table_privilege(r, t, 'DELETE') AS del, has_table_privilege(r, t, 'TRUNCATE') AS trunc
      FROM unnest(ARRAY['erp_app', 'erp_group', 'erp_stats', 'erp_platform']) AS r, unnest(${SERVICES}::text[]) AS t ORDER BY 1, 2`;
    expect(rights).toHaveLength(16);
    for (const x of rights) {
      if (x.role !== 'erp_platform') expect(x).toEqual({ role: x.role, table: x.table, sel: false, ins: false, upd: false, del: false, trunc: false });
      else expect(x).toEqual({ role: 'erp_platform', table: x.table, sel: true, ins: true, upd: false, del: false, trunc: false });
    }
    // Ajout seul, même pour le propriétaire de la base : modifier, effacer ou vider est refusé.
    const triggers = await db.$queryRaw<{ name: string }[]>`
      SELECT tgname AS name FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text = ANY(${SERVICES}) ORDER BY 1`;
    expect(triggers.map((t) => t.name)).toEqual([
      'service_rate_ends_append_only', 'service_rate_ends_check', 'service_rate_ends_no_truncate', 'service_rates_append_only', 'service_rates_no_truncate',
      'service_versions_append_only', 'service_versions_no_truncate', 'services_append_only', 'services_no_truncate',
    ]);
    await expect(db.$executeRaw`UPDATE service_rates SET value = 1 WHERE currency = 'XOF'`).rejects.toThrow();
    await expect(db.$executeRaw`DELETE FROM services`).rejects.toThrow();
    await expect(db.$executeRawUnsafe('TRUNCATE service_versions CASCADE')).rejects.toThrow();
    expect(await db.$queryRaw`SELECT count(*)::int AS n FROM service_versions`).toEqual([{ n: 4 }]);
  });

  it('retour arrière : refusé dès qu’une prestation a été saisie, sauf forçage ; il retire le lot G5g sans toucher à la facturation du lot G5a, puis la migration se rejoue', async () => {
    const script = join(PRISMA, 'retour-arriere', `${G5G}.sql`);
    const rollback = (force = false) =>
      execSync(`psql "${URL}" -v ON_ERROR_STOP=1 -q -f ${script}`, { env: { ...process.env, PGOPTIONS: force ? '-c cahiora.forcer_retour=oui' : '' }, stdio: 'pipe' });
    const exists = async () => (await db.$queryRaw<{ t: string | null }[]>`SELECT to_regclass('public.services')::text AS t`)[0].t;
    const refusedBy = () => {
      try {
        rollback();
        return '';
      } catch (e) {
        return String((e as { stderr?: Buffer }).stderr ?? e);
      }
    };
    // Avec le seul catalogue initial, le retour arrière passe sans forçage ; puis une nouvelle mise à jour rejoue la migration.
    rollback();
    expect(await exists()).toBeNull();
    deploy();
    expect(await exists()).toBe('services');
    // Une prestation saisie par le Super Admin : le script s'arrête et ne change rien.
    const [s] = await db.$queryRaw<{ id: string }[]>`INSERT INTO services (id, code, "createdByName") VALUES (gen_random_uuid(), 'ATELIER_FICTIF', 'Super Admin fictif') RETURNING id`;
    await db.$executeRaw`INSERT INTO service_versions (id, "serviceId", version, name, pricing, active, "effectiveFrom", reason, "createdByName")
      VALUES (gen_random_uuid(), ${s.id}::uuid, 1, 'Atelier fictif', 'FREE', true, DATE '2026-11-20', 'Prestation fictive du test', 'Super Admin fictif')`;
    expect(refusedBy()).toMatch(/Retour arrière arrêté, rien n'a été changé : les prestations contiennent des données saisies \(prestations 5, versions 5, règles de prix 2, arrêts 0\)/);
    expect(await exists()).toBe('services');
    // Forcé en connaissance de cause : tout le lot part ; la facturation du lot G5a et le reste de la base ne bougent pas.
    rollback(true);
    expect(await exists()).toBeNull();
    for (const t of ['service_versions', 'service_rates', 'service_rate_ends']) expect(await db.$queryRaw`SELECT to_regclass(${'public.' + t})::text AS t`).toEqual([{ t: null }]);
    expect(await db.$queryRaw`SELECT 1 FROM pg_proc WHERE proname IN ('grant_platform_services_role', 'service_rate_ends_check')`).toEqual([]);
    expect(await db.$queryRaw`SELECT 1 FROM pg_type WHERE typname IN ('ServicePricing', 'ServiceRateKind')`).toEqual([]);
    expect(await db.$queryRaw`SELECT 1 FROM _prisma_migrations WHERE migration_name = ${G5G}`).toEqual([]);
    expect(await db.$queryRaw`SELECT count(*)::int AS n FROM _prisma_migrations WHERE migration_name = '20261114120000_facturation_g5a'`).toEqual([{ n: 1 }]);
    expect(await db.$queryRaw`SELECT 1 FROM pg_proc WHERE proname = 'grant_platform_billing_role'`).toEqual([{ '?column?': 1 }]);
    const after = await snapshot();
    for (const [k, rows] of Object.entries(before)) {
      if (k === 'platform_audit_logs') for (const r of rows) expect(after[k]).toContainEqual(r);
      else expect([k, after[k]]).toEqual([k, rows]);
    }
    // Une nouvelle mise à jour rejoue la migration : le catalogue initial revient, seul.
    deploy();
    expect(await exists()).toBe('services');
    expect(await db.$queryRaw`SELECT count(*)::int AS n FROM services`).toEqual([{ n: 4 }]);
    expect(await db.$queryRaw`SELECT count(*)::int AS n FROM service_rates`).toEqual([{ n: 2 }]);
  });
});
