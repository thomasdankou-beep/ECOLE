/**
 * Lot G5c : la migration des documents provisoires jouée sur une base qui a déjà les lots G0 à G5b, avec des groupes,
 * des écoles, des comptes, des élèves, des journaux, un abonnement aux conditions acceptées, un calendrier et un
 * comptage figé, comme le serait la production après le lot G5b, avec des données entièrement fictives. Base jetable
 * erp_migration_test, vidée à chaque lancement ; le test refuse toute autre base.
 */
import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const URL = process.env.DATABASE_MIGRATION_URL ?? '';
const G5C = '20261120090000_documents_g5c';
const PRISMA = join(__dirname, '..', 'prisma');
const SCHOOLS = [
  { id: '9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a', slug: 'ecole-xi', name: 'École Xi (fictive)' },
  { id: '9b9b9b9b-9b9b-4b9b-9b9b-9b9b9b9b9b9b', slug: 'ecole-omicron', name: 'Lycée Omicron (fictif)' },
];
const DOCUMENTS = ['billing_document_lines', 'billing_documents'];
const PLATFORM = [
  'billing_calendars', 'billing_jobs', 'billing_parameters', 'billing_counts', 'commercial_terms', 'platform_alerts', 'subscription_events', 'subscriptions',
  'services', 'service_versions', 'service_rates', 'service_rate_ends', 'tenants', 'school_groups', 'group_audit_logs', 'platform_audit_logs',
];
const SCHOOL_TABLES = [
  'users', 'user_roles', 'audit_logs', 'notifications', 'sites', 'levels', 'academic_years', 'classes', 'students', 'enrollments', 'enrollment_events',
  'billing_count_items', 'count_corrections',
];
/** Fin du 14 octobre 2026 à Porto-Novo (UTC+1) : dernier jour de l'essai fictif. */
const LAST_FREE_DAY = '2026-10-14';
const END_OF_DAY = '2026-10-14T22:59:59.999Z';
const TARIFF = { currency: 'XOF', pricePerPupil: 500, minimum: 40000, day: '2026-10-20' };

describe('Lot G5c · migration des documents provisoires sur une base qui a déjà les lots G0 à G5b (données fictives)', () => {
  const db = new PrismaClient({ datasources: { db: { url: URL } } });
  const dir = mkdtempSync(join(tmpdir(), 'erp-migration-g5c-'));
  const deploy = () =>
    execSync(`npx prisma migrate deploy --schema ${join(dir, 'schema.prisma')}`, { cwd: join(__dirname, '..'), env: { ...process.env, DATABASE_URL: URL, DATABASE_ADMIN_URL: URL }, stdio: 'pipe' });
  const inSchool = <T>(tenant: string, fn: (tx: any) => Promise<T>) =>
    db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant}, true)`;
      return fn(tx);
    });
  /** Toutes les lignes des tables existantes qui comptent pour le client : plateforme, facturation, comptages, écoles. */
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
  /** Fonctions de demande et de décision des corrections du lot G5b, telles qu'avant la migration (le retour arrière les remet). */
  const g5bFunctions = () => db.$queryRaw<{ name: string; def: string }[]>`
    SELECT p.proname AS name, pg_get_functiondef(p.oid) AS def FROM pg_proc p WHERE p.proname IN ('request_count_correction', 'decide_count_correction') ORDER BY 1`;
  let g5bBefore: { name: string; def: string }[] = [];
  const xi = { group: '', count: '' };

  beforeAll(async () => {
    if (!/\/erp_migration_test(\?|$)/.test(URL)) throw new Error('Base refusée pour le test de migration : seule erp_migration_test peut être vidée');
    await db.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await db.$executeRawUnsafe('CREATE SCHEMA public');
    // Toutes les migrations d'avant les documents (lots G0 à G5b), comme sur le serveur au moment de la mise à jour.
    mkdirSync(join(dir, 'migrations'));
    cpSync(join(PRISMA, 'schema.prisma'), join(dir, 'schema.prisma'));
    for (const m of readdirSync(join(PRISMA, 'migrations'))) {
      if (m < G5C || m === 'migration_lock.toml') cpSync(join(PRISMA, 'migrations', m), join(dir, 'migrations', m), { recursive: true });
    }
    deploy();
    let year = '';
    let klass = '';
    let site = '';
    let enrollment = '';
    for (const s of SCHOOLS) {
      const [g] = await db.$queryRaw<{ id: string }[]>`INSERT INTO school_groups (id, name, "updatedAt") VALUES (gen_random_uuid(), ${s.name}, now()) RETURNING id`;
      await db.$executeRaw`INSERT INTO tenants (id, slug, name, country, currency, timezone, settings, group_id, "updatedAt", "createdAt")
        VALUES (${s.id}::uuid, ${s.slug}, ${s.name}, 'BJ', 'XOF', 'Africa/Porto-Novo', '{}'::jsonb, ${g.id}::uuid, '2026-09-01T08:00:00Z', '2026-09-01T08:00:00Z')`;
      await db.$executeRaw`INSERT INTO group_audit_logs (id, group_id, "actorKind", "actorName", action) VALUES (gen_random_uuid(), ${g.id}::uuid, 'platform', 'Super Admin fictif', 'group.created_for_school')`;
      await db.$executeRaw`INSERT INTO platform_audit_logs (id, action, "tenantId") VALUES (gen_random_uuid(), 'platform.tenant.created', ${s.id}::uuid)`;
      await inSchool(s.id, async (tx) => {
        const [u] = await tx.$queryRaw`INSERT INTO users (id, tenant_id, phone, "passwordHash", "firstName", "lastName", "updatedAt")
          VALUES (gen_random_uuid(), ${s.id}::uuid, '+2290190009001', 'empreinte-fictive', 'Direction', 'FICTIVE', now()) RETURNING id`;
        await tx.$executeRaw`INSERT INTO user_roles (id, tenant_id, "userId", role) VALUES (gen_random_uuid(), ${s.id}::uuid, ${u.id}::uuid, 'DIRECTION')`;
        await tx.$executeRaw`INSERT INTO audit_logs (id, tenant_id, "userName", action, entity) VALUES (gen_random_uuid(), ${s.id}::uuid, 'Direction FICTIVE', 'auth.login', 'User')`;
        const [y] = await tx.$queryRaw`INSERT INTO academic_years (id, tenant_id, label, "startDate", "endDate", "isCurrent")
          VALUES (gen_random_uuid(), ${s.id}::uuid, '2026-2027', DATE '2026-09-14', DATE '2027-07-31', true) RETURNING id`;
        const [st] = await tx.$queryRaw`INSERT INTO sites (id, tenant_id, name, "updatedAt") VALUES (gen_random_uuid(), ${s.id}::uuid, 'Site fictif', now()) RETURNING id`;
        const [level] = await tx.$queryRaw`INSERT INTO levels (id, tenant_id, name, cycle, position) VALUES (gen_random_uuid(), ${s.id}::uuid, '6e', 'COLLEGE', 1) RETURNING id`;
        const [c] = await tx.$queryRaw`INSERT INTO classes (id, tenant_id, "siteId", "academicYearId", "levelId", name, "updatedAt")
          VALUES (gen_random_uuid(), ${s.id}::uuid, ${st.id}::uuid, ${y.id}::uuid, ${level.id}::uuid, '6e A', now()) RETURNING id`;
        const [pupil] = await tx.$queryRaw`INSERT INTO students (id, tenant_id, matricule, "firstName", "lastName", status, "updatedAt")
          VALUES (gen_random_uuid(), ${s.id}::uuid, ${`${s.slug}-001`}, 'Élève', 'FICTIF', 'ACTIVE', now()) RETURNING id`;
        const [e] = await tx.$queryRaw`INSERT INTO enrollments (id, tenant_id, "studentId", "classId", "academicYearId", status, "enrolledAt", type)
          VALUES (gen_random_uuid(), ${s.id}::uuid, ${pupil.id}::uuid, ${c.id}::uuid, ${y.id}::uuid, 'ACTIVE', '2026-09-14T08:00:00Z', 'NEW') RETURNING id`;
        await tx.$executeRaw`INSERT INTO enrollment_events (id, tenant_id, "enrollmentId", kind, data, "createdAt")
          VALUES (gen_random_uuid(), ${s.id}::uuid, ${e.id}::uuid, 'ENROLLED', ${JSON.stringify({ classId: c.id, className: '6e A', type: 'NEW' })}::jsonb, '2026-09-14T08:00:00Z')`;
        if (s === SCHOOLS[0]) {
          xi.group = g.id;
          year = y.id;
          klass = c.id;
          site = st.id;
          enrollment = e.id;
        }
      });
    }
    // Facturation des lots G5a et G5b déjà en place pour la première école : essai terminé, conditions acceptées (tarif figé),
    // calendrier, et le comptage figé de la fin de l'essai.
    const [first] = SCHOOLS;
    const [sub] = await db.$queryRaw<{ id: string }[]>`INSERT INTO subscriptions (id, tenant_id, status, "trialStart", "trialEnd", "trialDays", "acceptedAt", "acceptedByName",
        "acceptedTariff", "updatedAt")
      VALUES (gen_random_uuid(), ${first.id}::uuid, 'AWAITING_PAYMENT', DATE '2026-10-01', ${LAST_FREE_DAY}::date, 14, '2026-10-20T09:00:00Z', 'Direction FICTIVE',
              ${JSON.stringify(TARIFF)}::jsonb, now()) RETURNING id`;
    await db.$executeRaw`INSERT INTO subscription_events (id, "subscriptionId", tenant_id, kind, "fromStatus", "toStatus", data, "actorKind", "actorName", "createdAt")
      VALUES (gen_random_uuid(), ${sub.id}::uuid, ${first.id}::uuid, 'TRIAL_ENDED', 'TRIAL', 'AWAITING_ACCEPTANCE', ${JSON.stringify({ lastFreeDay: LAST_FREE_DAY })}::jsonb,
              'system', 'Cahiora (tâche planifiée)', '2026-10-15T00:05:00Z')`;
    await db.$executeRaw`INSERT INTO billing_calendars (id, tenant_id, "yearLabel", version, "startDate", "endDate", "initialCountDate", "firstRegularizationDate",
        "finalRegularizationDate", formula, reason, "createdByName")
      VALUES (gen_random_uuid(), ${first.id}::uuid, '2026-2027', 1, DATE '2026-09-14', DATE '2027-07-31', DATE '2026-11-30', DATE '2027-03-31', DATE '2027-06-30',
              'B', 'Calendrier fictif', 'Super Admin fictif')`;
    const items = [{ enrollmentId: enrollment, classId: klass, siteId: site, counted: true, basis: 'ACTIVE', departureDate: null }];
    const [count] = await db.$queryRaw<{ count_id: string }[]>`
      SELECT * FROM record_billing_count(${first.id}::uuid, ${year}::uuid, 'TRIAL_END', ${LAST_FREE_DAY}::date, 'FROZEN', NULL, ${JSON.stringify(items)}::jsonb,
        ${END_OF_DAY}::timestamptz, ${END_OF_DAY}::timestamptz, DATE '2026-11-19')`;
    xi.count = count.count_id;
    before = await snapshot();
    g5bBefore = await g5bFunctions();
    // Puis la migration des documents, seule.
    cpSync(join(PRISMA, 'migrations', G5C), join(dir, 'migrations', G5C), { recursive: true });
    deploy();
  }, 240000);

  afterAll(async () => {
    await db.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it("aucune donnée existante n'est modifiée ni ajoutée, journaux et comptages compris ; aucun document n'est créé par la migration", async () => {
    const after = await snapshot();
    for (const [k, rows] of Object.entries(before)) expect([k, after[k]]).toEqual([k, rows]);
    expect(await db.$queryRaw`SELECT (SELECT count(*) FROM billing_documents)::int AS docs, (SELECT count(*) FROM billing_document_lines)::int AS lines`).toEqual([{ docs: 0, lines: 0 }]);
    expect(await db.$queryRaw`SELECT count(*)::int AS n FROM _prisma_migrations WHERE migration_name = ${G5C} AND finished_at IS NOT NULL`).toEqual([{ n: 1 }]);
  });

  it('Row Level Security forcée ; plateforme en lecture seule et émission par la fonction ; écoles par leurs fonctions ; groupes et statistiques sans droit', async () => {
    const rls = await db.$queryRaw<{ table: string; rls: boolean; forced: boolean; policies: string }[]>`
      SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             (SELECT string_agg(p.policyname, ',' ORDER BY p.policyname) FROM pg_policies p WHERE p.tablename = c.relname) AS policies
      FROM pg_class c WHERE c.relname = ANY(${DOCUMENTS}) AND c.relkind = 'r' ORDER BY 1`;
    expect(rls).toEqual([
      { table: 'billing_document_lines', rls: true, forced: true, policies: 'billing_document_lines_owner_all,billing_document_lines_platform_all' },
      { table: 'billing_documents', rls: true, forced: true, policies: 'billing_documents_owner_all,billing_documents_platform_all' },
    ]);
    const rights = await db.$queryRaw<{ role: string; table: string; sel: boolean; ins: boolean; upd: boolean; del: boolean; trunc: boolean }[]>`
      SELECT r AS role, t AS table, has_table_privilege(r, t, 'SELECT') AS sel, has_table_privilege(r, t, 'INSERT') AS ins, has_table_privilege(r, t, 'UPDATE') AS upd,
             has_table_privilege(r, t, 'DELETE') AS del, has_table_privilege(r, t, 'TRUNCATE') AS trunc
      FROM unnest(ARRAY['erp_app', 'erp_group', 'erp_stats', 'erp_platform']) AS r, unnest(${DOCUMENTS}::text[]) AS t ORDER BY 1, 2`;
    expect(rights).toHaveLength(8);
    for (const x of rights) expect(x).toEqual({ role: x.role, table: x.table, sel: x.role === 'erp_platform', ins: false, upd: false, del: false, trunc: false });
    const fns = await db.$queryRaw<{ role: string; fn: string; ok: boolean }[]>`
      SELECT r AS role, p.proname AS fn, has_function_privilege(r, p.oid, 'EXECUTE') AS ok
      FROM unnest(ARRAY['erp_app', 'erp_group', 'erp_stats', 'erp_platform']) AS r,
           pg_proc p WHERE p.proname IN ('issue_billing_document', 'billing_already_billed', 'billing_year_amount', 'current_tenant_billing_documents',
                                         'current_tenant_sees_billing_documents', 'billing_counts_billable', 'billing_count_billable', 'billing_enrollment_document',
                                         'decide_count_exclusion_platform', 'platform_count_exclusions', 'current_tenant_count_documents',
                                         'request_count_correction', 'decide_count_correction', 'service_live_rates', 'service_unit_price')
      ORDER BY 1, 2`;
    expect(fns.filter((f) => f.ok).map((f) => `${f.role}:${f.fn}`)).toEqual([
      'erp_app:current_tenant_billing_documents', 'erp_app:current_tenant_count_documents', 'erp_app:current_tenant_sees_billing_documents',
      'erp_app:decide_count_correction', 'erp_app:request_count_correction',
      'erp_platform:billing_already_billed', 'erp_platform:billing_counts_billable', 'erp_platform:decide_count_exclusion_platform', 'erp_platform:issue_billing_document',
      'erp_platform:platform_count_exclusions',
    ]);
    // Les fonctions de demande et de décision du lot G5b sont remplacées (délai de 30 jours, décision du Super Admin).
    expect((await g5bFunctions()).map((f) => f.def)).not.toEqual(g5bBefore.map((f) => f.def));
    const triggers = await db.$queryRaw<{ t: string; name: string }[]>`
      SELECT tgrelid::regclass::text AS t, tgname AS name FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text = ANY(${DOCUMENTS}) ORDER BY 1, 2`;
    expect(triggers.map((x) => `${x.t}:${x.name}`)).toEqual([
      'billing_document_lines:billing_document_lines_append_only', 'billing_document_lines:billing_document_lines_no_truncate',
      'billing_document_lines:same_tenant_refs', 'billing_documents:billing_documents_append_only', 'billing_documents:billing_documents_no_truncate',
    ]);
  });

  it('sur la base migrée, le document de la fin de l’essai s’émet une fois, calculé par la base ; il ne se modifie plus', async () => {
    // Un élève, au minimum : 40 000 F × 10/11 (octobre à juillet sur septembre à juillet), au franc inférieur.
    const line = {
      tenantId: SCHOOLS[0].id, label: 'École Xi (fictive) · Fin de l’essai gratuit du 14 octobre 2026', amount: 36363, countId: xi.count, pupils: 1, pupilsChange: 1,
      pricePerPupil: 500, minimum: 40000, minimumApplied: true, fullYear: 40000, shareMonths: 10, shareOf: 11, yearAmount: 36363, alreadyBilled: 0,
    };
    const issue = (lines: object[], group = xi.group) => db.$queryRaw<{ document_reference: string; document_total: number }[]>`
      SELECT * FROM issue_billing_document(${group}::uuid, 'SUBSCRIPTION', 'XOF', DATE '2026-11-19', DATE '2026-11-19', '2026-2027', NULL, ${JSON.stringify({ test: 'G5c' })}::jsonb,
        ${JSON.stringify(lines)}::jsonb, 'system', NULL, 'Cahiora (tâche planifiée)')`;
    await expect(issue([{ ...line, amount: 36364, yearAmount: 36364 }])).rejects.toThrow(/montant de l'année faux/);
    const other = (await db.$queryRaw<{ id: string }[]>`SELECT group_id AS id FROM tenants WHERE id = ${SCHOOLS[1].id}::uuid`)[0].id;
    await expect(issue([line], other)).rejects.toThrow(/hors de ce client/);
    const [r] = await issue([line]);
    expect(r.document_reference).toMatch(/^PROV-[0-9A-F]{10}$/);
    expect(r.document_total).toBe(36363);
    await expect(issue([{ ...line, alreadyBilled: 36363, amount: 0 }])).rejects.toThrow(/ce comptage a déjà son document/);
    await expect(db.$executeRawUnsafe('UPDATE billing_documents SET total = 0')).rejects.toThrow();
    await expect(db.$executeRawUnsafe('DELETE FROM billing_document_lines')).rejects.toThrow();
    expect(await inSchool(SCHOOLS[0].id, (tx) => tx.$queryRaw`SELECT count(*)::int AS n FROM current_tenant_billing_documents()`)).toEqual([{ n: 1 }]);
    expect(await inSchool(SCHOOLS[1].id, (tx) => tx.$queryRaw`SELECT count(*)::int AS n FROM current_tenant_billing_documents()`)).toEqual([{ n: 0 }]);
  });

  it('retour arrière : refusé dès qu’un document existe, sauf forçage ; il retire le lot G5c sans toucher au reste, puis la migration se rejoue', async () => {
    const script = join(PRISMA, 'retour-arriere', `${G5C}.sql`);
    const rollback = (force = false) =>
      execSync(`psql "${URL}" -v ON_ERROR_STOP=1 -q -f ${script}`, { env: { ...process.env, PGOPTIONS: force ? '-c cahiora.forcer_retour=oui' : '' }, stdio: 'pipe' });
    const exists = async () => (await db.$queryRaw<{ t: string | null }[]>`SELECT to_regclass('public.billing_documents')::text AS t`)[0].t;
    let refused = '';
    try {
      rollback();
    } catch (e) {
      refused = String((e as { stderr?: Buffer }).stderr ?? e);
    }
    expect(refused).toMatch(/Retour arrière arrêté, rien n'a été changé : 1 document\(s\) provisoire\(s\) déjà émis/);
    expect(await exists()).toBe('billing_documents');
    // Forcé en connaissance de cause : tout le lot part ; le reste de la base, comptages compris, ne bouge pas.
    rollback(true);
    expect(await exists()).toBeNull();
    for (const t of DOCUMENTS) expect(await db.$queryRaw`SELECT to_regclass(${'public.' + t})::text AS t`).toEqual([{ t: null }]);
    expect(await db.$queryRaw`SELECT proname FROM pg_proc WHERE proname IN ('issue_billing_document', 'billing_already_billed', 'billing_year_amount',
      'current_tenant_billing_documents', 'current_tenant_sees_billing_documents', 'grant_platform_documents_role', 'billing_counts_billable', 'billing_count_billable',
      'billing_enrollment_document', 'decide_count_exclusion_platform', 'platform_count_exclusions', 'current_tenant_count_documents', 'service_live_rates',
      'service_unit_price')`).toEqual([]);
    // Les fonctions du lot G5b sont revenues telles qu'elles étaient, avec leurs droits.
    expect(await g5bFunctions()).toEqual(g5bBefore);
    expect(await db.$queryRaw`SELECT has_function_privilege('erp_app', 'request_count_correction(uuid, text, uuid, date, text, text, text, integer, uuid, text, text, date)', 'EXECUTE') AS ok`)
      .toEqual([{ ok: true }]);
    expect(await db.$queryRaw`SELECT typname FROM pg_type WHERE typname = 'BillingDocumentKind'`).toEqual([]);
    expect(await db.$queryRaw`SELECT 1 FROM _prisma_migrations WHERE migration_name = ${G5C}`).toEqual([]);
    const after = await snapshot();
    for (const [k, rows] of Object.entries(before)) expect([k, after[k]]).toEqual([k, rows]);
    // Une nouvelle mise à jour rejoue la migration ; sans document, le retour arrière passe sans forçage.
    deploy();
    expect(await exists()).toBe('billing_documents');
    rollback();
    expect(await exists()).toBeNull();
    deploy();
    expect(await exists()).toBe('billing_documents');
    expect(await db.$queryRaw`SELECT has_table_privilege('erp_platform', 'billing_documents', 'SELECT') AS ok`).toEqual([{ ok: true }]);
  });
});
