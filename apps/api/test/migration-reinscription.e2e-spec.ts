/**
 * Lot G4 : la migration de la réinscription jouée sur une base qui a déjà des écoles, des élèves, des inscriptions
 * (dont un départ), des factures et des pré-inscriptions, comme le serait la production, avec des données
 * entièrement fictives. Base jetable erp_migration_test, vidée à chaque lancement ; le test refuse toute autre base.
 */
import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const URL = process.env.DATABASE_MIGRATION_URL ?? '';
const G4 = '20261113140000_reinscription_g4';
const PRISMA = join(__dirname, '..', 'prisma');
const SCHOOLS = [
  { id: '44444444-4444-4444-8444-444444444444', slug: 'ecole-delta', name: 'École Delta (fictive)', prefix: 'DEL' },
  { id: '55555555-5555-4555-8555-555555555555', slug: 'ecole-epsilon', name: 'Collège Epsilon (fictif)', prefix: 'EPS' },
];
const TABLES = ['students', 'enrollments', 'invoices', 'applications'] as const;
/** Colonnes ajoutées par le lot G4 : vides pour toutes les lignes existantes. */
const ADDED: Record<(typeof TABLES)[number], string[]> = {
  students: [], invoices: [],
  enrollments: ['type', 'exitDate', 'exitReason', 'cancelledAt', 'cancelReason', 'cancelledById'],
  applications: ['siteId'],
};

describe('Lot G4 · migration de la réinscription sur une base qui a déjà des élèves (données fictives)', () => {
  const db = new PrismaClient({ datasources: { db: { url: URL } } });
  const dir = mkdtempSync(join(tmpdir(), 'erp-migration-g4-'));
  const deploy = () =>
    execSync(`npx prisma migrate deploy --schema ${join(dir, 'schema.prisma')}`, { cwd: join(__dirname, '..'), env: { ...process.env, DATABASE_URL: URL, DATABASE_ADMIN_URL: URL }, stdio: 'pipe' });
  const inSchool = <T>(tenant: string, fn: (tx: any) => Promise<T>) =>
    db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant}, true)`;
      return fn(tx);
    });
  /** Toutes les lignes (toutes les colonnes) des tables touchées, lues dans la zone de chaque école. */
  const snapshot = async () => {
    const out: Record<string, Record<string, any[]>> = {};
    for (const s of SCHOOLS) {
      out[s.slug] = await inSchool(s.id, async (tx) => {
        const rows: Record<string, any[]> = {};
        for (const t of TABLES) rows[t] = (await tx.$queryRawUnsafe(`SELECT to_jsonb(x) AS r FROM ${t} x ORDER BY id`)).map((x: { r: unknown }) => x.r);
        return rows;
      });
    }
    return out;
  };
  let before: Record<string, Record<string, any[]>> = {};

  beforeAll(async () => {
    if (!/\/erp_migration_test(\?|$)/.test(URL)) throw new Error('Base refusée pour le test de migration : seule erp_migration_test peut être vidée');
    await db.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await db.$executeRawUnsafe('CREATE SCHEMA public');
    // Toutes les migrations d'avant le lot G4 (groupes G1 compris), comme sur le serveur au moment de la mise à jour.
    mkdirSync(join(dir, 'migrations'));
    cpSync(join(PRISMA, 'schema.prisma'), join(dir, 'schema.prisma'));
    for (const m of readdirSync(join(PRISMA, 'migrations'))) {
      if (m < G4 || m === 'migration_lock.toml') cpSync(join(PRISMA, 'migrations', m), join(dir, 'migrations', m), { recursive: true });
    }
    deploy();
    // Deux écoles fictives : un site, une année, une classe, deux élèves (dont un parti), une facture, une pré-inscription.
    for (const s of SCHOOLS) {
      const [g] = await db.$queryRaw<{ id: string }[]>`INSERT INTO school_groups (id, name, "updatedAt") VALUES (gen_random_uuid(), ${s.name}, now()) RETURNING id`;
      await db.$executeRaw`INSERT INTO tenants (id, slug, name, country, currency, timezone, settings, group_id, "updatedAt")
        VALUES (${s.id}::uuid, ${s.slug}, ${s.name}, 'BJ', 'XOF', 'Africa/Porto-Novo', '{}'::jsonb, ${g.id}::uuid, '2026-10-01T08:00:00Z')`;
      await inSchool(s.id, async (tx) => {
        const [site] = await tx.$queryRaw`INSERT INTO sites (id, tenant_id, name, "updatedAt") VALUES (gen_random_uuid(), ${s.id}::uuid, 'Site fictif', now()) RETURNING id`;
        const [year] = await tx.$queryRaw`INSERT INTO academic_years (id, tenant_id, label, "startDate", "endDate", "isCurrent")
          VALUES (gen_random_uuid(), ${s.id}::uuid, '2026-2027', '2026-09-14', '2027-07-09', true) RETURNING id`;
        const [level] = await tx.$queryRaw`INSERT INTO levels (id, tenant_id, name, cycle, position) VALUES (gen_random_uuid(), ${s.id}::uuid, '6e', 'COLLEGE', 1) RETURNING id`;
        const [klass] = await tx.$queryRaw`INSERT INTO classes (id, tenant_id, "siteId", "academicYearId", "levelId", name, "updatedAt")
          VALUES (gen_random_uuid(), ${s.id}::uuid, ${site.id}::uuid, ${year.id}::uuid, ${level.id}::uuid, '6e A', now()) RETURNING id`;
        for (const [n, status] of [[1, 'ACTIVE'], [2, 'WITHDRAWN']] as const) {
          const [st] = await tx.$queryRaw`INSERT INTO students (id, tenant_id, matricule, "firstName", "lastName", "birthDate", status, "updatedAt")
            VALUES (gen_random_uuid(), ${s.id}::uuid, ${`${s.prefix}-26-000${n}`}, 'Élève', ${`FICTIF ${n}`}, '2014-05-02', ${status}::"StudentStatus", '2026-09-20T10:00:00Z') RETURNING id`;
          await tx.$executeRaw`INSERT INTO enrollments (id, tenant_id, "studentId", "classId", "academicYearId", status, "enrolledAt")
            VALUES (gen_random_uuid(), ${s.id}::uuid, ${st.id}::uuid, ${klass.id}::uuid, ${year.id}::uuid, ${status}::"EnrollmentStatus", '2026-09-20T10:00:00Z')`;
          await tx.$executeRaw`INSERT INTO invoices (id, tenant_id, number, "studentId", label, total, "dueDate", "createdById", "updatedAt")
            VALUES (gen_random_uuid(), ${s.id}::uuid, ${`FAC-${n}`}, ${st.id}::uuid, 'Scolarité', 45000, '2026-12-05', gen_random_uuid(), '2026-09-20T10:00:00Z')`;
        }
        await tx.$executeRaw`INSERT INTO applications (id, tenant_id, reference, "studentFirstName", "studentLastName", "wantedLevel", "wantedSite", "guardianName", "guardianPhone", "updatedAt")
          VALUES (gen_random_uuid(), ${s.id}::uuid, 'PRE-2026-0001', 'Afi', 'FICTIVE', '6e', 'Site fictif', 'Parent Fictif', '+2290196009901', '2026-10-02T09:00:00Z')`;
      });
    }
    before = await snapshot();
    // Puis la migration du lot G4, seule.
    cpSync(join(PRISMA, 'migrations', G4), join(dir, 'migrations', G4), { recursive: true });
    deploy();
  }, 240000);

  afterAll(async () => {
    await db.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it("aucune donnée existante n'est modifiée ; les nouvelles colonnes restent vides (pas de site deviné pour les anciennes demandes)", async () => {
    const after = await snapshot();
    for (const s of SCHOOLS) {
      for (const t of TABLES) {
        expect(after[s.slug][t]).toHaveLength(before[s.slug][t].length);
        after[s.slug][t].forEach((row, i) => {
          const kept = Object.fromEntries(Object.entries(row).filter(([k]) => !ADDED[t].includes(k)));
          expect(kept).toEqual(before[s.slug][t][i]);
          for (const k of ADDED[t]) expect(row[k]).toBeNull();
        });
      }
    }
    expect(before['ecole-delta'].enrollments.map((e) => e.status).sort()).toEqual(['ACTIVE', 'WITHDRAWN']);
  });

  it('nouvelles tables vides et cloisonnées par école ; droits réduits du rôle de l’application', async () => {
    for (const s of SCHOOLS) {
      expect(await inSchool(s.id, async (tx) => (await tx.$queryRawUnsafe('SELECT (SELECT count(*) FROM enrollment_events)::int + (SELECT count(*) FROM duplicate_reviews)::int AS n'))[0].n)).toBe(0);
    }
    const rls = await db.$queryRaw<{ table: string; rls: boolean; forced: boolean; policies: number }[]>`
      SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced, (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = c.relname) AS policies
      FROM pg_class c WHERE c.relname IN ('enrollment_events', 'duplicate_reviews') ORDER BY 1`;
    expect(rls).toEqual([{ table: 'duplicate_reviews', rls: true, forced: true, policies: 1 }, { table: 'enrollment_events', rls: true, forced: true, policies: 1 }]);
    const rights = await db.$queryRaw<{ t: string; sel: boolean; ins: boolean; upd: boolean; del: boolean }[]>`
      SELECT t, has_table_privilege('erp_app', t, 'SELECT') AS sel, has_table_privilege('erp_app', t, 'INSERT') AS ins,
        has_table_privilege('erp_app', t, 'UPDATE') AS upd, has_table_privilege('erp_app', t, 'DELETE') AS del
      FROM unnest(ARRAY['duplicate_reviews', 'enrollment_events', 'enrollments', 'invoices', 'students']) AS t ORDER BY t`;
    expect(rights).toEqual([
      { t: 'duplicate_reviews', sel: true, ins: true, upd: true, del: false },
      { t: 'enrollment_events', sel: true, ins: true, upd: false, del: false },
      { t: 'enrollments', sel: true, ins: true, upd: true, del: false },
      { t: 'invoices', sel: true, ins: true, upd: true, del: false },
      { t: 'students', sel: true, ins: true, upd: true, del: false },
    ]);
  });

  it("la base refuse de supprimer un élève, une inscription ou une facture, et de modifier l'historique", async () => {
    const [delta] = SCHOOLS;
    await expect(inSchool(delta.id, (tx) => tx.$executeRawUnsafe('DELETE FROM students'))).rejects.toThrow(/ajout seul/);
    await expect(inSchool(delta.id, (tx) => tx.$executeRawUnsafe('DELETE FROM enrollments'))).rejects.toThrow(/ajout seul/);
    await expect(inSchool(delta.id, (tx) => tx.$executeRawUnsafe('DELETE FROM invoices'))).rejects.toThrow(/ajout seul/);
    const event = await inSchool(delta.id, async (tx) => {
      const [e] = await tx.$queryRawUnsafe('SELECT id FROM enrollments ORDER BY id LIMIT 1');
      const [ev] = await tx.$queryRaw`INSERT INTO enrollment_events (id, tenant_id, "enrollmentId", kind) VALUES (gen_random_uuid(), ${delta.id}::uuid, ${e.id}::uuid, 'ENROLLED') RETURNING id`;
      return ev.id as string;
    });
    await expect(inSchool(delta.id, (tx) => tx.$executeRaw`UPDATE enrollment_events SET kind = 'CANCELLED' WHERE id = ${event}::uuid`)).rejects.toThrow(/ajout seul/);
    await expect(inSchool(delta.id, (tx) => tx.$executeRaw`DELETE FROM enrollment_events WHERE id = ${event}::uuid`)).rejects.toThrow(/ajout seul/);
  });

  it("annulation cohérente, et l'historique d'une école ne peut viser l'inscription d'une autre", async () => {
    const [delta, epsilon] = SCHOOLS;
    const values = await db.$queryRaw<{ v: string }[]>`SELECT unnest(enum_range(NULL::"EnrollmentStatus"))::text AS v`;
    expect(values.map((x) => x.v)).toEqual(['ACTIVE', 'TRANSFERRED', 'WITHDRAWN', 'CANCELLED']);
    await expect(inSchool(delta.id, (tx) => tx.$executeRawUnsafe(`UPDATE enrollments SET status = 'CANCELLED'`))).rejects.toThrow(/enrollments_cancel_check/);
    await expect(inSchool(delta.id, (tx) => tx.$executeRawUnsafe(`UPDATE enrollments SET status = 'CANCELLED', "cancelledAt" = now()`))).rejects.toThrow(/enrollments_cancel_check/);
    const foreign = await inSchool(delta.id, async (tx) => (await tx.$queryRawUnsafe('SELECT id FROM enrollments LIMIT 1'))[0].id as string);
    await expect(inSchool(epsilon.id, (tx) => tx.$executeRaw`INSERT INTO enrollment_events (id, tenant_id, "enrollmentId", kind) VALUES (gen_random_uuid(), ${epsilon.id}::uuid, ${foreign}::uuid, 'ENROLLED')`)).rejects.toThrow();
    // Aucune école fixée ne reste dans la session après la migration.
    expect((await db.$queryRaw<{ v: string | null }[]>`SELECT NULLIF(current_setting('app.tenant_id', true), '') AS v`)[0].v).toBeNull();
  });
});
