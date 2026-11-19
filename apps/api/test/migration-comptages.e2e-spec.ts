/**
 * Lot G5b : la migration des comptages des élèves jouée sur une base qui a déjà les lots G0 à G5g, avec des groupes,
 * des écoles, des comptes, des élèves, des inscriptions (dont un départ enregistré avant l'historique), des journaux, un
 * abonnement dont l'essai est terminé et un calendrier, comme le serait la production après le lot G5g, avec des données
 * entièrement fictives. Base jetable erp_migration_test, vidée à chaque lancement ; le test refuse toute autre base.
 */
import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const URL = process.env.DATABASE_MIGRATION_URL ?? '';
const G5B = '20261119120000_comptages_g5b';
const PRISMA = join(__dirname, '..', 'prisma');
const SCHOOLS = [
  { id: '8a8a8a8a-8a8a-4a8a-8a8a-8a8a8a8a8a8a', slug: 'ecole-mu', name: 'École Mu (fictive)' },
  { id: '8b8b8b8b-8b8b-4b8b-8b8b-8b8b8b8b8b8b', slug: 'ecole-nu', name: 'Lycée Nu (fictif)' },
];
const COUNTS = ['billing_count_items', 'billing_counts', 'count_corrections'];
const PLATFORM = [
  'billing_calendars', 'billing_jobs', 'billing_parameters', 'commercial_terms', 'platform_alerts', 'subscription_events', 'subscriptions',
  'services', 'service_versions', 'service_rates', 'service_rate_ends', 'tenants', 'school_groups', 'group_audit_logs', 'platform_audit_logs',
];
const SCHOOL_TABLES = ['users', 'user_roles', 'audit_logs', 'notifications', 'sites', 'levels', 'academic_years', 'classes', 'students', 'enrollments', 'enrollment_events'];
/** Fin du 14 octobre 2026 à Porto-Novo (UTC+1) : dernier jour de l'essai fictif. */
const LAST_FREE_DAY = '2026-10-14';
const END_OF_DAY = '2026-10-14T22:59:59.999Z';

describe('Lot G5b · migration des comptages sur une base qui a déjà les lots G0 à G5g (données fictives)', () => {
  const db = new PrismaClient({ datasources: { db: { url: URL } } });
  const dir = mkdtempSync(join(tmpdir(), 'erp-migration-g5b-'));
  const deploy = () =>
    execSync(`npx prisma migrate deploy --schema ${join(dir, 'schema.prisma')}`, { cwd: join(__dirname, '..'), env: { ...process.env, DATABASE_URL: URL, DATABASE_ADMIN_URL: URL }, stdio: 'pipe' });
  const inSchool = <T>(tenant: string, fn: (tx: any) => Promise<T>) =>
    db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant}, true)`;
      return fn(tx);
    });
  /** Toutes les lignes des tables existantes qui comptent pour le client : plateforme, facturation et prestations, écoles. */
  const snapshot = async () => {
    const rows = async (sql: string) => (await db.$queryRawUnsafe<{ r: unknown }[]>(sql)).map((x) => x.r);
    const out: Record<string, unknown[]> = {};
    for (const t of PLATFORM) out[t] = await rows(`SELECT to_jsonb(x) AS r FROM ${t} x ORDER BY id`);
    for (const s of SCHOOLS) {
      for (const t of SCHOOL_TABLES) {
        out[`${s.slug}:${t}`] = await inSchool(s.id, async (tx) => (await tx.$queryRawUnsafe(`SELECT to_jsonb(x) AS r FROM ${t} x ORDER BY id`)).map((x: { r: unknown }) => x.r));
      }
    }
    return out;
  };
  let before: Record<string, unknown[]> = {};
  const mu = { year: '', klass: '', site: '', active: '', legacy: '' };

  beforeAll(async () => {
    if (!/\/erp_migration_test(\?|$)/.test(URL)) throw new Error('Base refusée pour le test de migration : seule erp_migration_test peut être vidée');
    await db.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await db.$executeRawUnsafe('CREATE SCHEMA public');
    // Toutes les migrations d'avant les comptages (lots G0 à G5g), comme sur le serveur au moment de la mise à jour.
    mkdirSync(join(dir, 'migrations'));
    cpSync(join(PRISMA, 'schema.prisma'), join(dir, 'schema.prisma'));
    for (const m of readdirSync(join(PRISMA, 'migrations'))) {
      if (m < G5B || m === 'migration_lock.toml') cpSync(join(PRISMA, 'migrations', m), join(dir, 'migrations', m), { recursive: true });
    }
    deploy();
    for (const s of SCHOOLS) {
      const [g] = await db.$queryRaw<{ id: string }[]>`INSERT INTO school_groups (id, name, "updatedAt") VALUES (gen_random_uuid(), ${s.name}, now()) RETURNING id`;
      await db.$executeRaw`INSERT INTO tenants (id, slug, name, country, currency, timezone, settings, group_id, "updatedAt", "createdAt")
        VALUES (${s.id}::uuid, ${s.slug}, ${s.name}, 'BJ', 'XOF', 'Africa/Porto-Novo', '{}'::jsonb, ${g.id}::uuid, '2026-09-01T08:00:00Z', '2026-09-01T08:00:00Z')`;
      await db.$executeRaw`INSERT INTO group_audit_logs (id, group_id, "actorKind", "actorName", action) VALUES (gen_random_uuid(), ${g.id}::uuid, 'platform', 'Super Admin fictif', 'group.created_for_school')`;
      await db.$executeRaw`INSERT INTO platform_audit_logs (id, action, "tenantId") VALUES (gen_random_uuid(), 'platform.tenant.created', ${s.id}::uuid)`;
      await inSchool(s.id, async (tx) => {
        const [u] = await tx.$queryRaw`INSERT INTO users (id, tenant_id, phone, "passwordHash", "firstName", "lastName", "updatedAt")
          VALUES (gen_random_uuid(), ${s.id}::uuid, '+2290190008001', 'empreinte-fictive', 'Direction', 'FICTIVE', now()) RETURNING id`;
        await tx.$executeRaw`INSERT INTO user_roles (id, tenant_id, "userId", role) VALUES (gen_random_uuid(), ${s.id}::uuid, ${u.id}::uuid, 'DIRECTION')`;
        await tx.$executeRaw`INSERT INTO audit_logs (id, tenant_id, "userName", action, entity) VALUES (gen_random_uuid(), ${s.id}::uuid, 'Direction FICTIVE', 'auth.login', 'User')`;
        // Une année, une classe et deux élèves : l'un inscrit avec son historique, l'autre parti avant l'historique des inscriptions.
        const [y] = await tx.$queryRaw`INSERT INTO academic_years (id, tenant_id, label, "startDate", "endDate", "isCurrent")
          VALUES (gen_random_uuid(), ${s.id}::uuid, '2026-2027', DATE '2026-09-14', DATE '2027-07-31', true) RETURNING id`;
        const [site] = await tx.$queryRaw`INSERT INTO sites (id, tenant_id, name, "updatedAt") VALUES (gen_random_uuid(), ${s.id}::uuid, 'Site fictif', now()) RETURNING id`;
        const [level] = await tx.$queryRaw`INSERT INTO levels (id, tenant_id, name, cycle, position) VALUES (gen_random_uuid(), ${s.id}::uuid, '6e', 'COLLEGE', 1) RETURNING id`;
        const [c] = await tx.$queryRaw`INSERT INTO classes (id, tenant_id, "siteId", "academicYearId", "levelId", name, "updatedAt")
          VALUES (gen_random_uuid(), ${s.id}::uuid, ${site.id}::uuid, ${y.id}::uuid, ${level.id}::uuid, '6e A', now()) RETURNING id`;
        const enrol = async (matricule: string, status: string) => {
          const [st] = await tx.$queryRaw`INSERT INTO students (id, tenant_id, matricule, "firstName", "lastName", status, "updatedAt")
            VALUES (gen_random_uuid(), ${s.id}::uuid, ${matricule}, 'Élève', 'FICTIF', ${status}::"StudentStatus", now()) RETURNING id`;
          const [e] = await tx.$queryRaw`INSERT INTO enrollments (id, tenant_id, "studentId", "classId", "academicYearId", status, "enrolledAt", type)
            VALUES (gen_random_uuid(), ${s.id}::uuid, ${st.id}::uuid, ${c.id}::uuid, ${y.id}::uuid, ${status}::"EnrollmentStatus", '2026-09-14T08:00:00Z', 'NEW') RETURNING id`;
          return { student: st.id as string, enrollment: e.id as string };
        };
        const active = await enrol(`${s.slug}-001`, 'ACTIVE');
        await tx.$executeRaw`INSERT INTO enrollment_events (id, tenant_id, "enrollmentId", kind, data, "createdAt")
          VALUES (gen_random_uuid(), ${s.id}::uuid, ${active.enrollment}::uuid, 'ENROLLED', ${JSON.stringify({ classId: c.id, className: '6e A', type: 'NEW' })}::jsonb, '2026-09-14T08:00:00Z')`;
        const legacy = await enrol(`${s.slug}-002`, 'WITHDRAWN');
        if (s === SCHOOLS[0]) Object.assign(mu, { year: y.id, klass: c.id, site: site.id, active: active.enrollment, legacy: legacy.enrollment });
      });
    }
    // Facturation du lot G5a déjà en place pour la première école : essai terminé (en attente d'acceptation), calendrier.
    const [first] = SCHOOLS;
    const [sub] = await db.$queryRaw<{ id: string }[]>`INSERT INTO subscriptions (id, tenant_id, status, "trialStart", "trialEnd", "trialDays", "updatedAt")
      VALUES (gen_random_uuid(), ${first.id}::uuid, 'AWAITING_ACCEPTANCE', DATE '2026-10-01', ${LAST_FREE_DAY}::date, 14, now()) RETURNING id`;
    await db.$executeRaw`INSERT INTO subscription_events (id, "subscriptionId", tenant_id, kind, "toStatus", "actorKind", "actorName", "createdAt")
      VALUES (gen_random_uuid(), ${sub.id}::uuid, ${first.id}::uuid, 'TRIAL_OPENED', 'TRIAL', 'platform', 'Super Admin fictif', '2026-10-01T08:00:00Z')`;
    await db.$executeRaw`INSERT INTO subscription_events (id, "subscriptionId", tenant_id, kind, "fromStatus", "toStatus", data, "actorKind", "actorName", "createdAt")
      VALUES (gen_random_uuid(), ${sub.id}::uuid, ${first.id}::uuid, 'TRIAL_ENDED', 'TRIAL', 'AWAITING_ACCEPTANCE', ${JSON.stringify({ lastFreeDay: LAST_FREE_DAY })}::jsonb,
              'system', 'Cahiora (tâche planifiée)', '2026-10-15T00:05:00Z')`;
    await db.$executeRaw`INSERT INTO billing_calendars (id, tenant_id, "yearLabel", version, "startDate", "endDate", "initialCountDate", "firstRegularizationDate",
        "finalRegularizationDate", formula, reason, "createdByName")
      VALUES (gen_random_uuid(), ${first.id}::uuid, '2026-2027', 1, DATE '2026-09-14', DATE '2027-07-31', DATE '2026-11-30', DATE '2027-03-31', DATE '2027-06-30',
              'B', 'Calendrier fictif', 'Super Admin fictif')`;
    before = await snapshot();
    // Puis la migration des comptages, seule.
    cpSync(join(PRISMA, 'migrations', G5B), join(dir, 'migrations', G5B), { recursive: true });
    deploy();
  }, 240000);

  afterAll(async () => {
    await db.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it("aucune donnée existante n'est modifiée ni ajoutée, journaux compris ; aucun comptage n'est créé par la migration", async () => {
    const after = await snapshot();
    for (const [k, rows] of Object.entries(before)) expect([k, after[k]]).toEqual([k, rows]);
    expect(await db.$queryRaw`SELECT count(*)::int AS n FROM billing_counts`).toEqual([{ n: 0 }]);
    for (const s of SCHOOLS) {
      expect(await inSchool(s.id, (tx) => tx.$queryRaw`SELECT (SELECT count(*) FROM billing_count_items)::int AS items, (SELECT count(*) FROM count_corrections)::int AS corrections`))
        .toEqual([{ items: 0, corrections: 0 }]);
    }
    expect(await db.$queryRaw`SELECT count(*)::int AS n FROM _prisma_migrations WHERE migration_name = ${G5B} AND finished_at IS NOT NULL`).toEqual([{ n: 1 }]);
  });

  it('Row Level Security forcée ; écoles en lecture de leurs listes seulement ; plateforme en lecture des nombres ; groupes et statistiques sans droit', async () => {
    const rls = await db.$queryRaw<{ table: string; rls: boolean; forced: boolean; policies: string }[]>`
      SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             (SELECT string_agg(p.policyname, ',' ORDER BY p.policyname) FROM pg_policies p WHERE p.tablename = c.relname) AS policies
      FROM pg_class c WHERE c.relname = ANY(${COUNTS}) AND c.relkind = 'r' ORDER BY 1`;
    expect(rls).toEqual([
      { table: 'billing_count_items', rls: true, forced: true, policies: 'tenant_isolation' },
      { table: 'billing_counts', rls: true, forced: true, policies: 'billing_counts_owner_all,billing_counts_platform_all' },
      { table: 'count_corrections', rls: true, forced: true, policies: 'tenant_isolation' },
    ]);
    const rights = await db.$queryRaw<{ role: string; table: string; sel: boolean; ins: boolean; upd: boolean; del: boolean; trunc: boolean }[]>`
      SELECT r AS role, t AS table, has_table_privilege(r, t, 'SELECT') AS sel, has_table_privilege(r, t, 'INSERT') AS ins, has_table_privilege(r, t, 'UPDATE') AS upd,
             has_table_privilege(r, t, 'DELETE') AS del, has_table_privilege(r, t, 'TRUNCATE') AS trunc
      FROM unnest(ARRAY['erp_app', 'erp_group', 'erp_stats', 'erp_platform']) AS r, unnest(${COUNTS}::text[]) AS t ORDER BY 1, 2`;
    const can = (role: string, table: string) => {
      if (role === 'erp_app') return table !== 'billing_counts';
      if (role === 'erp_platform') return table === 'billing_counts';
      return false;
    };
    expect(rights).toHaveLength(12);
    for (const x of rights) expect(x).toEqual({ role: x.role, table: x.table, sel: can(x.role, x.table), ins: false, upd: false, del: false, trunc: false });
    // Fonctions : la plateforme enregistre, la direction de l'école lit et corrige ; personne d'autre.
    const fns = await db.$queryRaw<{ role: string; fn: string; ok: boolean }[]>`
      SELECT r AS role, p.proname AS fn, has_function_privilege(r, p.oid, 'EXECUTE') AS ok
      FROM unnest(ARRAY['erp_app', 'erp_group', 'erp_stats', 'erp_platform']) AS r,
           pg_proc p WHERE p.proname IN ('record_billing_count', 'current_tenant_billing_counts', 'request_count_correction', 'decide_count_correction')
      ORDER BY 1, 2`;
    expect(fns.filter((f) => f.ok).map((f) => `${f.role}:${f.fn}`)).toEqual([
      'erp_app:current_tenant_billing_counts', 'erp_app:decide_count_correction', 'erp_app:request_count_correction', 'erp_platform:record_billing_count',
    ]);
    // Ajout seul, même pour le propriétaire de la base ; contrôle « même école » sur chaque table.
    const triggers = await db.$queryRaw<{ t: string; name: string }[]>`
      SELECT tgrelid::regclass::text AS t, tgname AS name FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text = ANY(${COUNTS}) ORDER BY 1, 2`;
    expect(triggers.map((x) => `${x.t}:${x.name}`)).toEqual([
      'billing_count_items:billing_count_items_append_only', 'billing_count_items:billing_count_items_no_truncate', 'billing_count_items:same_tenant_refs',
      'billing_counts:billing_counts_append_only', 'billing_counts:billing_counts_no_truncate', 'billing_counts:same_tenant_refs',
      'count_corrections:count_corrections_guard', 'count_corrections:count_corrections_no_delete', 'count_corrections:count_corrections_no_truncate',
      'count_corrections:same_tenant_refs',
    ]);
  });

  it('sur la base migrée, le comptage de fin d’essai s’enregistre : départ d’avant l’historique compté et signalé, empreinte et cumul calculés par la base', async () => {
    const [first, second] = SCHOOLS;
    const item = (enrollmentId: string, basis: string) => ({ enrollmentId, classId: mu.klass, siteId: mu.site, counted: true, basis, departureDate: null });
    const items = [item(mu.active, 'ACTIVE'), item(mu.legacy, 'DEPARTURE_UNKNOWN')];
    const record = (list: object[], tenant = first.id) => db.$queryRaw<{ count_pupils: number; count_cumulative: number; count_to_check: number; count_hash: string }[]>`
      SELECT * FROM record_billing_count(${tenant}::uuid, ${mu.year}::uuid, 'TRIAL_END', ${LAST_FREE_DAY}::date, 'FROZEN', NULL, ${JSON.stringify(list)}::jsonb,
        ${END_OF_DAY}::timestamptz, ${END_OF_DAY}::timestamptz, DATE '2026-11-19')`;
    // L'année d'une autre école, ou une école sans abonnement : refusé.
    await expect(record(items, second.id)).rejects.toThrow(/année scolaire introuvable pour cet établissement/);
    // Une inscription comptée deux fois : refusé.
    await expect(record([...items, items[0]])).rejects.toThrow(/liste du comptage invalide/);
    const [r] = await record(items);
    const hash = createHash('sha256').update([`${mu.active}:ACTIVE:`, `${mu.legacy}:DEPARTURE_UNKNOWN:`].sort().join(',')).digest('hex');
    expect(r).toMatchObject({ count_pupils: 2, count_cumulative: 2, count_to_check: 1, count_hash: hash });
    // Une seconde fois : rien de plus.
    expect(await record(items)).toEqual([]);
    expect(await inSchool(first.id, (tx) => tx.$queryRaw`SELECT count(*)::int AS n FROM billing_count_items`)).toEqual([{ n: 2 }]);
    expect(await inSchool(second.id, (tx) => tx.$queryRaw`SELECT count(*)::int AS n FROM billing_count_items`)).toEqual([{ n: 0 }]);
  });

  it('retour arrière : refusé dès qu’un comptage existe, sauf forçage ; il retire le lot G5b sans toucher au reste, puis la migration se rejoue', async () => {
    const script = join(PRISMA, 'retour-arriere', `${G5B}.sql`);
    const rollback = (force = false) =>
      execSync(`psql "${URL}" -v ON_ERROR_STOP=1 -q -f ${script}`, { env: { ...process.env, PGOPTIONS: force ? '-c cahiora.forcer_retour=oui' : '' }, stdio: 'pipe' });
    const exists = async () => (await db.$queryRaw<{ t: string | null }[]>`SELECT to_regclass('public.billing_counts')::text AS t`)[0].t;
    let refused = '';
    try {
      rollback();
    } catch (e) {
      refused = String((e as { stderr?: Buffer }).stderr ?? e);
    }
    expect(refused).toMatch(/Retour arrière arrêté, rien n'a été changé : 1 comptage\(s\) des élèves facturables déjà enregistré\(s\)/);
    expect(await exists()).toBe('billing_counts');
    // Forcé en connaissance de cause : tout le lot part ; le reste de la base ne bouge pas.
    rollback(true);
    expect(await exists()).toBeNull();
    for (const t of COUNTS) expect(await db.$queryRaw`SELECT to_regclass(${'public.' + t})::text AS t`).toEqual([{ t: null }]);
    expect(await db.$queryRaw`SELECT proname FROM pg_proc WHERE proname IN ('record_billing_count', 'current_tenant_billing_counts', 'request_count_correction',
      'decide_count_correction', 'grant_platform_counts_role', 'count_corrections_guard')`).toEqual([]);
    expect(await db.$queryRaw`SELECT typname FROM pg_type WHERE typname IN ('BillingCountKind', 'BillingCountStage', 'CountCorrectionKind', 'CountCorrectionStatus')`).toEqual([]);
    expect(await db.$queryRaw`SELECT 1 FROM _prisma_migrations WHERE migration_name = ${G5B}`).toEqual([]);
    const after = await snapshot();
    for (const [k, rows] of Object.entries(before)) expect([k, after[k]]).toEqual([k, rows]);
    // Une nouvelle mise à jour rejoue la migration ; sans comptage, le retour arrière passe sans forçage.
    deploy();
    expect(await exists()).toBe('billing_counts');
    rollback();
    expect(await exists()).toBeNull();
    deploy();
    expect(await exists()).toBe('billing_counts');
    expect(await db.$queryRaw`SELECT has_table_privilege('erp_platform', 'billing_counts', 'SELECT') AS ok`).toEqual([{ ok: true }]);
  });
});
