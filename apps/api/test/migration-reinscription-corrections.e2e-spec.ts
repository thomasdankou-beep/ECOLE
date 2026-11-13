/**
 * Corrections du lot G4 : la migration complémentaire jouée sur une base qui a déjà le lot G4, avec des écoles, des
 * niveaux, des élèves et des inscriptions (dont un départ et une inscription d'avant l'historique), comme le serait la
 * production, avec des données entièrement fictives. Base jetable erp_migration_test, vidée à chaque lancement ; le
 * test refuse toute autre base.
 */
import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const URL = process.env.DATABASE_MIGRATION_URL ?? '';
const CORRECTIONS = '20261113190000_reinscription_g4_corrections';
const PRISMA = join(__dirname, '..', 'prisma');
const SCHOOLS = [
  { id: '66666666-6666-4666-8666-666666666666', slug: 'ecole-zeta', name: 'École Zêta (fictive)', prefix: 'ZET' },
  { id: '77777777-7777-4777-8777-777777777777', slug: 'ecole-eta', name: 'Collège Êta (fictif)', prefix: 'ETA' },
];
const TABLES = ['levels', 'students', 'enrollments', 'enrollment_events'] as const;

describe('Corrections G4 · migration complémentaire sur une base qui a déjà le lot G4 (données fictives)', () => {
  const db = new PrismaClient({ datasources: { db: { url: URL } } });
  const dir = mkdtempSync(join(tmpdir(), 'erp-migration-g4c-'));
  const deploy = () =>
    execSync(`npx prisma migrate deploy --schema ${join(dir, 'schema.prisma')}`, { cwd: join(__dirname, '..'), env: { ...process.env, DATABASE_URL: URL, DATABASE_ADMIN_URL: URL }, stdio: 'pipe' });
  const inSchool = <T>(tenant: string, fn: (tx: any) => Promise<T>) =>
    db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant}, true)`;
      return fn(tx);
    });
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
  const enrollment: Record<string, string> = {};
  const level: Record<string, string> = {};

  beforeAll(async () => {
    if (!/\/erp_migration_test(\?|$)/.test(URL)) throw new Error('Base refusée pour le test de migration : seule erp_migration_test peut être vidée');
    await db.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await db.$executeRawUnsafe('CREATE SCHEMA public');
    // Toutes les migrations d'avant ces corrections (lot G4 compris), comme sur le serveur au moment de la mise à jour.
    mkdirSync(join(dir, 'migrations'));
    cpSync(join(PRISMA, 'schema.prisma'), join(dir, 'schema.prisma'));
    for (const m of readdirSync(join(PRISMA, 'migrations'))) {
      if (m < CORRECTIONS || m === 'migration_lock.toml') cpSync(join(PRISMA, 'migrations', m), join(dir, 'migrations', m), { recursive: true });
    }
    deploy();
    for (const s of SCHOOLS) {
      const [g] = await db.$queryRaw<{ id: string }[]>`INSERT INTO school_groups (id, name, "updatedAt") VALUES (gen_random_uuid(), ${s.name}, now()) RETURNING id`;
      await db.$executeRaw`INSERT INTO tenants (id, slug, name, country, currency, timezone, settings, group_id, "updatedAt")
        VALUES (${s.id}::uuid, ${s.slug}, ${s.name}, 'BJ', 'XOF', 'Africa/Porto-Novo', '{}'::jsonb, ${g.id}::uuid, '2026-10-01T08:00:00Z')`;
      await inSchool(s.id, async (tx) => {
        const [site] = await tx.$queryRaw`INSERT INTO sites (id, tenant_id, name, "updatedAt") VALUES (gen_random_uuid(), ${s.id}::uuid, 'Site fictif', now()) RETURNING id`;
        const [year] = await tx.$queryRaw`INSERT INTO academic_years (id, tenant_id, label, "startDate", "endDate", "isCurrent")
          VALUES (gen_random_uuid(), ${s.id}::uuid, '2026-2027', '2026-09-14', '2027-07-09', true) RETURNING id`;
        for (const [name, position] of [['6e', 1], ['5e', 2]] as const) {
          const [l] = await tx.$queryRaw`INSERT INTO levels (id, tenant_id, name, cycle, position) VALUES (gen_random_uuid(), ${s.id}::uuid, ${name}, 'COLLEGE', ${position}) RETURNING id`;
          level[`${s.slug}:${name}`] = l.id;
        }
        const [klass] = await tx.$queryRaw`INSERT INTO classes (id, tenant_id, "siteId", "academicYearId", "levelId", name, "updatedAt")
          VALUES (gen_random_uuid(), ${s.id}::uuid, ${site.id}::uuid, ${year.id}::uuid, ${level[`${s.slug}:6e`]}::uuid, '6e A', now()) RETURNING id`;
        // Un élève inscrit (avec son historique), un parti (historique du lot G4), un parti avant l'historique (aucune ligne).
        for (const [n, status, journal] of [[1, 'ACTIVE', true], [2, 'WITHDRAWN', true], [3, 'WITHDRAWN', false]] as const) {
          const [st] = await tx.$queryRaw`INSERT INTO students (id, tenant_id, matricule, "firstName", "lastName", status, "updatedAt")
            VALUES (gen_random_uuid(), ${s.id}::uuid, ${`${s.prefix}-26-000${n}`}, 'Élève', ${`FICTIF ${n}`}, ${status}::"StudentStatus", '2026-09-20T10:00:00Z') RETURNING id`;
          const [e] = await tx.$queryRaw`INSERT INTO enrollments (id, tenant_id, "studentId", "classId", "academicYearId", status, "enrolledAt", type, "exitDate", "exitReason")
            VALUES (gen_random_uuid(), ${s.id}::uuid, ${st.id}::uuid, ${klass.id}::uuid, ${year.id}::uuid, ${status}::"EnrollmentStatus", '2026-09-20T10:00:00Z',
              ${journal ? 'NEW' : null}::"EnrollmentType", ${n === 2 ? '2026-10-15' : null}::date, ${n === 2 ? 'Départ fictif' : null}) RETURNING id`;
          enrollment[`${s.slug}:${n}`] = e.id;
          if (journal) {
            await tx.$executeRaw`INSERT INTO enrollment_events (id, tenant_id, "enrollmentId", kind, data, "createdAt")
              VALUES (gen_random_uuid(), ${s.id}::uuid, ${e.id}::uuid, 'ENROLLED', ${JSON.stringify({ classId: klass.id, className: '6e A', type: 'NEW' })}::jsonb, '2026-09-20T10:00:00Z')`;
          }
          if (n === 2) {
            await tx.$executeRaw`INSERT INTO enrollment_events (id, tenant_id, "enrollmentId", kind, data, "createdAt")
              VALUES (gen_random_uuid(), ${s.id}::uuid, ${e.id}::uuid, 'WITHDRAWN', ${JSON.stringify({ exitDate: '2026-10-15', reason: 'Départ fictif', className: '6e A' })}::jsonb, '2026-10-15T09:00:00Z')`;
          }
        }
      });
    }
    before = await snapshot();
    // Puis la migration complémentaire, seule.
    cpSync(join(PRISMA, 'migrations', CORRECTIONS), join(dir, 'migrations', CORRECTIONS), { recursive: true });
    deploy();
  }, 240000);

  afterAll(async () => {
    await db.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it("aucune donnée existante n'est modifiée ; le niveau suivant reste vide (aucune proposition tant que la direction ne l'a pas défini)", async () => {
    const after = await snapshot();
    for (const s of SCHOOLS) {
      for (const t of TABLES) {
        expect(after[s.slug][t]).toHaveLength(before[s.slug][t].length);
        after[s.slug][t].forEach((row, i) => {
          const { nextLevelId, ...kept } = row;
          expect(kept).toEqual(before[s.slug][t][i]);
          if (t === 'levels') expect(nextLevelId).toBeNull();
          else expect(nextLevelId).toBeUndefined();
        });
      }
    }
  });

  it('déclencheurs et contrôles en place ; le rôle de l’application garde exactement ses droits', async () => {
    const triggers = await db.$queryRaw<{ name: string; table: string; deferred: boolean }[]>`
      SELECT t.tgname AS name, c.relname AS table, t.tginitdeferred AS deferred FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE t.tgname IN ('enrollments_keep_facts', 'enrollments_journaled', 'enrollment_events_mark') ORDER BY 1`;
    expect(triggers).toEqual([
      { name: 'enrollment_events_mark', table: 'enrollment_events', deferred: false },
      { name: 'enrollments_journaled', table: 'enrollments', deferred: true },
      { name: 'enrollments_keep_facts', table: 'enrollments', deferred: false },
    ]);
    const rights = await db.$queryRaw<{ t: string; upd: boolean; del: boolean }[]>`
      SELECT t, has_table_privilege('erp_app', t, 'UPDATE') AS upd, has_table_privilege('erp_app', t, 'DELETE') AS del
      FROM unnest(ARRAY['enrollment_events', 'enrollments', 'levels']) AS t ORDER BY t`;
    expect(rights).toEqual([
      { t: 'enrollment_events', upd: false, del: false },
      { t: 'enrollments', upd: true, del: false },
      { t: 'levels', upd: true, del: true },
    ]);
  });

  it("une inscription existante ne change plus sans ligne d'historique ; avec sa ligne, oui", async () => {
    const [zeta] = SCHOOLS;
    const id = enrollment[`${zeta.slug}:1`];
    await expect(inSchool(zeta.id, (tx) => tx.$executeRaw`UPDATE enrollments SET status = 'WITHDRAWN', "exitDate" = '2026-11-02' WHERE id = ${id}::uuid`)).rejects.toThrow(/sans ligne dans son historique/);
    await expect(inSchool(zeta.id, (tx) => tx.$executeRaw`UPDATE enrollments SET "enrolledAt" = '2026-09-01' WHERE id = ${id}::uuid`)).rejects.toThrow(/ne se modifient pas/);
    await inSchool(zeta.id, async (tx) => {
      await tx.$executeRaw`UPDATE enrollments SET status = 'WITHDRAWN', "exitDate" = '2026-11-02', "exitReason" = 'Départ fictif' WHERE id = ${id}::uuid`;
      await tx.$executeRaw`INSERT INTO enrollment_events (id, tenant_id, "enrollmentId", kind, data) VALUES (gen_random_uuid(), ${zeta.id}::uuid, ${id}::uuid, 'WITHDRAWN', '{"exitDate":"2026-11-02"}'::jsonb)`;
    });
    const rows = await inSchool(zeta.id, (tx) => tx.$queryRaw`SELECT status::text AS status FROM enrollments WHERE id = ${id}::uuid`);
    expect(rows).toEqual([{ status: 'WITHDRAWN' }]);
  });

  it("le niveau suivant : un niveau de la même école, jamais lui-même ; une école ne voit pas les niveaux d'une autre", async () => {
    const [zeta, eta] = SCHOOLS;
    const sixth = level[`${zeta.slug}:6e`];
    await inSchool(zeta.id, (tx) => tx.$executeRaw`UPDATE levels SET "nextLevelId" = ${level[`${zeta.slug}:5e`]}::uuid WHERE id = ${sixth}::uuid`);
    await expect(inSchool(zeta.id, (tx) => tx.$executeRaw`UPDATE levels SET "nextLevelId" = id WHERE id = ${sixth}::uuid`)).rejects.toThrow(/levels_next_level_check/);
    await expect(inSchool(zeta.id, (tx) => tx.$executeRaw`UPDATE levels SET "nextLevelId" = ${level[`${eta.slug}:5e`]}::uuid WHERE id = ${sixth}::uuid`)).rejects.toThrow();
    expect(await inSchool(eta.id, (tx) => tx.$queryRaw`SELECT count(*)::int AS n FROM levels WHERE id = ${sixth}::uuid`)).toEqual([{ n: 0 }]);
    // Un niveau supprimé ne laisse pas de lien cassé : le niveau qui le précédait perd simplement son niveau suivant.
    await inSchool(zeta.id, async (tx) => {
      await tx.$executeRaw`DELETE FROM levels WHERE id = ${level[`${zeta.slug}:5e`]}::uuid`;
      const [l] = await tx.$queryRaw`SELECT "nextLevelId" FROM levels WHERE id = ${sixth}::uuid`;
      expect(l.nextLevelId).toBeNull();
      throw new Error('annuler');
    }).catch((e: Error) => expect(e.message).toBe('annuler'));
  });
});
