/**
 * Lot G1 : la migration des groupes jouée sur une base qui a déjà des écoles, comme le serait la production,
 * avec des données entièrement fictives. Base jetable erp_migration_test, vidée à chaque lancement ;
 * le test refuse toute autre base. Les migrations suivantes (lot G2 : comptes de la console) sont jouées
 * ensuite, et ne doivent rien changer aux écoles ni aux groupes déjà en place.
 */
import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const URL = process.env.DATABASE_MIGRATION_URL ?? '';
const G1 = '20261112220000_groupes_g1';
const PRISMA = join(__dirname, '..', 'prisma');
/** Migrations datées (dossiers AAAAMMJJHHMMSS_nom), dans l'ordre où Prisma les joue. */
const MIGRATIONS = readdirSync(join(PRISMA, 'migrations')).filter((m) => /^\d{14}_/.test(m)).sort();
const SCHOOLS = [
  { id: '11111111-1111-4111-8111-111111111111', slug: 'ecole-alpha', name: 'École Alpha (fictive)', country: 'BJ', notes: 'Note interne fictive', phone: '+2290190009901' },
  { id: '22222222-2222-4222-8222-222222222222', slug: 'ecole-beta', name: 'Collège Bêta (fictif)', country: 'CI', notes: null, phone: '+2250700009902' },
  { id: '33333333-3333-4333-8333-333333333333', slug: 'ecole-gamma', name: 'Lycée Gamma (fictif)', country: 'BJ', notes: null, phone: '+2290190009903' },
];

describe('Lot G1 · migration des groupes sur une base qui a déjà des écoles (données fictives)', () => {
  const db = new PrismaClient({ datasources: { db: { url: URL } } });
  const dir = mkdtempSync(join(tmpdir(), 'erp-migration-g1-'));
  const deploy = () =>
    execSync(`npx prisma migrate deploy --schema ${join(dir, 'schema.prisma')}`, { cwd: join(__dirname, '..'), env: { ...process.env, DATABASE_URL: URL, DATABASE_ADMIN_URL: URL }, stdio: 'pipe' });
  /** Tout ce qui existait avant : chaque école (toutes ses colonnes) et ses lignes, lues dans sa propre zone. */
  const snapshot = () =>
    db.$transaction(async (tx) => {
      const out: Record<string, unknown> = {};
      for (const s of SCHOOLS) {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${s.id}, true)`;
        const [row] = await tx.$queryRaw<{ t: Record<string, unknown> }[]>`SELECT to_jsonb(t) - 'group_id' - 'groupJoinedAt' AS t FROM tenants t WHERE id = ${s.id}::uuid`;
        const counts: Record<string, number> = {};
        for (const table of ['sites', 'users', 'user_roles', 'students', 'audit_logs']) {
          counts[table] = (await tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table}`))[0].n;
        }
        out[s.slug] = { tenant: row.t, counts };
      }
      return out;
    });
  /** Groupes et journaux des groupes, tels que les laisse la migration du lot G1. */
  const groupsSnapshot = () =>
    db.$queryRaw<Record<string, unknown>[]>`SELECT to_jsonb(g) AS g, (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM group_audit_logs l WHERE l.group_id = g.id) AS logs FROM school_groups g ORDER BY g.id`;
  let before: Record<string, any> = {};
  let afterG1: { schools: Record<string, any>; groups: Record<string, unknown>[] } | null = null;

  beforeAll(async () => {
    if (!/\/erp_migration_test(\?|$)/.test(URL)) throw new Error('Base refusée pour le test de migration : seule erp_migration_test peut être vidée');
    await db.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await db.$executeRawUnsafe('CREATE SCHEMA public');
    // Toutes les migrations d'avant le lot G1, comme sur le serveur aujourd'hui.
    mkdirSync(join(dir, 'migrations'));
    cpSync(join(PRISMA, 'schema.prisma'), join(dir, 'schema.prisma'));
    for (const m of readdirSync(join(PRISMA, 'migrations'))) {
      if (!MIGRATIONS.includes(m) || m < G1) cpSync(join(PRISMA, 'migrations', m), join(dir, 'migrations', m), { recursive: true });
    }
    deploy();
    // Trois écoles fictives avec un site, une direction, un élève et une ligne de journal chacune.
    for (const s of SCHOOLS) {
      await db.$executeRaw`INSERT INTO tenants (id, slug, name, country, currency, timezone, settings, "platformNotes", "updatedAt")
        VALUES (${s.id}::uuid, ${s.slug}, ${s.name}, ${s.country}, 'XOF', 'Africa/Porto-Novo', '{"matriculePrefix":"FIC"}'::jsonb, ${s.notes}, '2026-10-01T08:00:00Z')`;
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${s.id}, true)`;
        await tx.$executeRaw`INSERT INTO sites (id, tenant_id, name, "updatedAt") VALUES (gen_random_uuid(), ${s.id}::uuid, 'Site fictif', now())`;
        const [u] = await tx.$queryRaw<{ id: string }[]>`INSERT INTO users (id, tenant_id, "firstName", "lastName", phone, "passwordHash", "updatedAt")
          VALUES (gen_random_uuid(), ${s.id}::uuid, 'Direction', 'FICTIVE', ${s.phone}, 'empreinte-fictive', now()) RETURNING id`;
        await tx.$executeRaw`INSERT INTO user_roles (id, tenant_id, "userId", role) VALUES (gen_random_uuid(), ${s.id}::uuid, ${u.id}::uuid, 'DIRECTION')`;
        await tx.$executeRaw`INSERT INTO students (id, tenant_id, matricule, "firstName", "lastName", "updatedAt") VALUES (gen_random_uuid(), ${s.id}::uuid, 'FIC-26-0001', 'Élève', 'FICTIF', now())`;
        await tx.$executeRaw`INSERT INTO audit_logs (id, tenant_id, action, entity) VALUES (gen_random_uuid(), ${s.id}::uuid, 'site.created', 'Site')`;
      });
    }
    before = await snapshot();
    // Puis la migration du lot G1, seule.
    cpSync(join(PRISMA, 'migrations', G1), join(dir, 'migrations', G1), { recursive: true });
    deploy();
    afterG1 = { schools: await snapshot(), groups: await groupsSnapshot() };
    // Enfin les migrations des lots suivants.
    for (const m of MIGRATIONS.filter((x) => x > G1)) cpSync(join(PRISMA, 'migrations', m), join(dir, 'migrations', m), { recursive: true });
    deploy();
  }, 300000);

  afterAll(async () => {
    await db.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it("chaque école existante devient un groupe d'un seul établissement, à son nom", async () => {
    const rows = await db.$queryRaw<{ slug: string; group: string; country: string; members: number; joined: boolean }[]>`
      SELECT t.slug, g.name AS group, g.country, (SELECT count(*)::int FROM tenants o WHERE o.group_id = g.id) AS members, t."groupJoinedAt" IS NOT NULL AS joined
      FROM tenants t JOIN school_groups g ON g.id = t.group_id ORDER BY t.slug`;
    expect(rows).toEqual(SCHOOLS.map((s) => ({ slug: s.slug, group: s.name, country: s.country, members: 1, joined: true })));
    expect((await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM school_groups`)[0].n).toBe(3);
    // Les groupes créés par la migration n'ont ni notes, ni coordonnées inventées.
    const extra = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM school_groups WHERE COALESCE("legalName", promoter, phone, email, address, "taxId", notes) IS NOT NULL OR status <> 'ACTIVE'`;
    expect(extra[0].n).toBe(0);
  });

  it("aucune donnée existante n'est modifiée : fiche des écoles (dates et notes internes comprises), sites, comptes, élèves", async () => {
    const after = await snapshot();
    for (const s of SCHOOLS) {
      expect(after[s.slug]).toEqual({ ...before[s.slug], counts: { ...before[s.slug].counts, audit_logs: before[s.slug].counts.audit_logs + 1 } });
    }
    expect((before['ecole-alpha'] as any).tenant.platformNotes).toBe('Note interne fictive');
  });

  it('le rattachement est tracé dans les trois journaux : plateforme, groupe et école', async () => {
    const platform = await db.$queryRaw<{ tenant: string; data: any }[]>`SELECT "tenantId"::text AS tenant, data FROM platform_audit_logs WHERE action = 'platform.group.created_for_school' ORDER BY 1`;
    expect(platform.map((p) => [p.tenant, p.data.groupName, p.data.source])).toEqual(SCHOOLS.map((s) => [s.id, s.name, 'migration groupes_g1']));
    const group = await db.$queryRaw<{ kind: string; action: string; tenant: string }[]>`
      SELECT l."actorKind" AS kind, l.action, l.data->>'tenantId' AS tenant FROM group_audit_logs l JOIN tenants t ON t.group_id = l.group_id ORDER BY 3`;
    expect(group).toEqual(SCHOOLS.map((s) => ({ kind: 'system', action: 'group.created_for_school', tenant: s.id })));
    for (const s of SCHOOLS) {
      const lines = await db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${s.id}, true)`;
        return tx.$queryRaw<{ action: string; data: any }[]>`SELECT action, data FROM audit_logs WHERE action = 'platform.group.initial'`;
      });
      expect(lines).toEqual([{ action: 'platform.group.initial', data: { group: s.name } }]);
    }
  });

  it('après la migration : colonne obligatoire, clé étrangère, cloisonnement des nouvelles tables', async () => {
    const cols = await db.$queryRaw<{ column: string; nullable: string }[]>`
      SELECT column_name AS column, is_nullable AS nullable FROM information_schema.columns WHERE table_name = 'tenants' AND column_name IN ('group_id', 'groupJoinedAt') ORDER BY 1`;
    expect(cols).toEqual([{ column: 'groupJoinedAt', nullable: 'NO' }, { column: 'group_id', nullable: 'NO' }]);
    await expect(db.$executeRaw`DELETE FROM school_groups`).rejects.toThrow();
    const rls = await db.$queryRaw<{ table: string; rls: boolean; forced: boolean }[]>`
      SELECT relname AS table, relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class WHERE relname IN ('school_groups', 'group_audit_logs') ORDER BY 1`;
    expect(rls).toEqual([{ table: 'group_audit_logs', rls: true, forced: true }, { table: 'school_groups', rls: true, forced: true }]);
    // Aucune école fixée ne reste dans la session après la migration.
    expect((await db.$queryRaw<{ v: string | null }[]>`SELECT NULLIF(current_setting('app.tenant_id', true), '') AS v`)[0].v).toBeNull();
  });

  it('lot G2 : les comptes de la console arrivent vides, cloisonnés, sans rien changer aux écoles ni aux groupes', async () => {
    expect(MIGRATIONS.filter((m) => m > G1)).toContain('20261113100000_groupes_g2_comptes');
    expect(await snapshot()).toEqual(afterG1!.schools);
    expect(await groupsSnapshot()).toEqual(afterG1!.groups);
    const tables = ['group_accounts', 'group_recovery_codes', 'group_sessions'];
    for (const t of tables) expect([t, (await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${t}`))[0].n]).toEqual([t, 0]);
    const rls = await db.$queryRaw<{ table: string; rls: boolean; forced: boolean }[]>`
      SELECT relname AS table, relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class WHERE relname IN ('group_accounts', 'group_recovery_codes', 'group_sessions') ORDER BY 1`;
    expect(rls).toEqual(tables.map((table) => ({ table, rls: true, forced: true })));
    // Le rôle des écoles n'a aucun droit sur ces tables, malgré les droits par défaut donnés aux nouvelles tables.
    const app = await db.$queryRaw<{ table: string; any: boolean }[]>`
      SELECT c.relname AS table, has_table_privilege('erp_app', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS any
      FROM pg_class c WHERE c.relname IN ('group_accounts', 'group_recovery_codes', 'group_sessions') ORDER BY 1`;
    expect(app.every((r) => !r.any)).toBe(true);
    const [fn] = await db.$queryRaw<{ app: boolean; group: boolean }[]>`
      SELECT has_function_privilege('erp_app', 'group_login_lookup(text, text[])', 'EXECUTE') AS app, has_function_privilege('erp_group', 'group_login_lookup(text, text[])', 'EXECUTE') AS group`;
    expect(fn).toEqual({ app: false, group: true });
  });
});
