/**
 * Ajustements des lectures G5b, G5c et G5d-2 (Dankou, 20 novembre 2026) : la migration jouée sur une base qui a déjà les
 * lots G0 à G5d-2, avec des groupes, des écoles, des comptes, des élèves, un abonnement, un comptage figé, un document
 * provisoire, une exclusion validée par le Super Admin, un moyen de paiement et un paiement, comme le serait la
 * production, avec des données entièrement fictives. Base jetable erp_migration_test, vidée à chaque lancement ; le test
 * refuse toute autre base.
 */
import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const URL = process.env.DATABASE_MIGRATION_URL ?? '';
const AJ = '20261123090000_ajustements_g5';
const PRISMA = join(__dirname, '..', 'prisma');
const SCHOOLS = [
  { id: 'c1c1c1c1-c1c1-4c1c-81c1-c1c1c1c1c1c1', slug: 'ecole-psi', name: 'École Psi (fictive)' },
  { id: 'c2c2c2c2-c2c2-4c2c-82c2-c2c2c2c2c2c2', slug: 'ecole-omega', name: 'Lycée Oméga (fictif)' },
];
const DOC = 'd1d1d1d1-d1d1-4d1d-81d1-d1d1d1d1d1d1';
const PLATFORM = [
  'billing_calendars', 'billing_jobs', 'billing_parameters', 'billing_counts', 'billing_documents', 'billing_document_lines', 'commercial_terms', 'platform_alerts',
  'subscription_events', 'subscriptions', 'regularization_requests', 'services', 'service_versions', 'service_rates', 'service_rate_ends', 'tenants', 'school_groups',
  'group_audit_logs', 'platform_audit_logs', 'billing_payment_means', 'billing_payments', 'billing_allocations', 'billing_credit_entries',
];
const SCHOOL_TABLES = [
  'users', 'user_roles', 'audit_logs', 'notifications', 'sites', 'levels', 'academic_years', 'classes', 'students', 'enrollments', 'enrollment_events',
  'billing_count_items', 'count_corrections',
];
/** Colonnes ajoutées par la migration : vérifiées à part (le reste de chaque ligne ne change pas). */
const NEW_COLUMNS = ['commercialStatus', 'commercialStatusAt', 'replacesPaymentId', 'proofSha256', 'similarReason'];
const GUARDS = [
  'billing_counts:billing_counts_test_guard', 'billing_credit_entries:billing_credit_entries_test_guard', 'billing_credit_transfers:billing_credit_transfers_test_guard',
  'billing_document_lines:billing_document_lines_test_guard', 'billing_payments:billing_payments_test_guard', 'billing_refunds:billing_refunds_test_guard',
  'regularization_requests:regularization_requests_test_guard', 'subscriptions:subscriptions_test_frozen', 'subscriptions:subscriptions_test_guard',
  'tenants:tenants_commercial_status_guard',
];
const LAST_FREE_DAY = '2026-10-14';
const END_OF_DAY = '2026-10-14T22:59:59.999Z';
const TARIFF = { currency: 'XOF', pricePerPupil: 500, minimum: 40000, day: '2026-10-20' };

describe('Ajustements G5 · migration sur une base qui a déjà les lots G0 à G5d-2 (données fictives)', () => {
  const db = new PrismaClient({ datasources: { db: { url: URL } } });
  const dir = mkdtempSync(join(tmpdir(), 'erp-migration-ajustements-'));
  const deploy = () =>
    execSync(`npx prisma migrate deploy --schema ${join(dir, 'schema.prisma')}`, { cwd: join(__dirname, '..'), env: { ...process.env, DATABASE_URL: URL, DATABASE_ADMIN_URL: URL }, stdio: 'pipe' });
  const script = join(PRISMA, 'retour-arriere', `${AJ}.sql`);
  const rollback = (force = false) =>
    execSync(`psql "${URL}" -v ON_ERROR_STOP=1 -q -f ${script}`, { env: { ...process.env, PGOPTIONS: force ? '-c cahiora.forcer_retour=oui' : '' }, stdio: 'pipe' });
  const refusal = () => {
    try {
      rollback();
      return '';
    } catch (e) {
      return String((e as { stderr?: Buffer }).stderr ?? e);
    }
  };
  const inSchool = <T>(tenant: string, fn: (tx: any) => Promise<T>) =>
    db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant}, true)`;
      return fn(tx);
    });
  /** Toutes les lignes des tables existantes qui comptent pour le client, sans les colonnes ajoutées par la migration. */
  const snapshot = async () => {
    const strip = `- ARRAY[${NEW_COLUMNS.map((c) => `'${c}'`).join(', ')}]`;
    const rows = async (sql: string) => (await db.$queryRawUnsafe<{ r: Record<string, unknown> }[]>(sql)).map((x) => x.r);
    const out: Record<string, Record<string, unknown>[]> = {};
    for (const t of PLATFORM) out[t] = await rows(`SELECT to_jsonb(x) ${strip} AS r FROM ${t} x ORDER BY id`);
    for (const s of SCHOOLS) {
      for (const t of SCHOOL_TABLES) {
        out[`${s.slug}:${t}`] = await inSchool(s.id, async (tx) => (await tx.$queryRawUnsafe(`SELECT to_jsonb(x) ${strip} AS r FROM ${t} x ORDER BY id`)).map((x: { r: unknown }) => x.r));
      }
    }
    return out;
  };
  /** Chaque ligne d'avant est toujours là, inchangée ; seules les lignes attendues s'ajoutent. */
  const unchanged = (before: Record<string, Record<string, unknown>[]>, after: Record<string, Record<string, unknown>[]>, added: Record<string, number> = {}) => {
    for (const [k, rows] of Object.entries(before)) {
      const byId = new Map(after[k].map((r) => [r.id, r]));
      expect([k, rows.map((r) => byId.get(r.id))]).toEqual([k, rows]);
      expect([k, after[k].length - rows.length]).toEqual([k, added[k] ?? 0]);
    }
  };
  /**
   * Empreinte du schéma : fonctions (définition, propriétaire, droits), déclencheurs, colonnes, contraintes, index, types
   * énumérés, règles de cloisonnement, tables et droits. Le retour arrière doit remettre exactement celle d'avant.
   */
  const fingerprint = async () => (await db.$queryRawUnsafe<{ x: string }[]>(`
    SELECT x FROM (
      SELECT 'fn ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' || pg_get_userbyid(p.proowner) || ' ' || md5(pg_get_functiondef(p.oid)) || ' '
             || coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(p.proacl) a), '') AS x
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')
      UNION ALL
      SELECT 'trg ' || c.relname || ' ' || t.tgname || ' ' || t.tgenabled::text || ' ' || md5(pg_get_triggerdef(t.oid))
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace
      UNION ALL
      SELECT 'col ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || a.attnotnull || ' ' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') || ' '
             || coalesce((SELECT string_agg(z::text, ',' ORDER BY z::text) FROM unnest(a.attacl) z), '')
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
      UNION ALL
      SELECT 'con ' || c.relname || ' ' || k.conname || ' ' || pg_get_constraintdef(k.oid)
        FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid WHERE k.connamespace = 'public'::regnamespace
      UNION ALL
      SELECT 'idx ' || pg_get_indexdef(i.indexrelid) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE c.relnamespace = 'public'::regnamespace
      UNION ALL
      SELECT 'enum ' || t.typname || ' ' || pg_get_userbyid(t.typowner) || ' ' || (SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid)
        FROM pg_type t WHERE t.typnamespace = 'public'::regnamespace AND t.typtype = 'e'
      UNION ALL
      SELECT 'pol ' || tablename || ' ' || policyname || ' ' || cmd || ' ' || array_to_string(roles, ',') || ' ' || coalesce(qual, '') || ' ' || coalesce(with_check, '')
        FROM pg_policies WHERE schemaname = 'public'
      UNION ALL
      SELECT 'rel ' || c.relname || ' ' || c.relkind::text || ' ' || pg_get_userbyid(c.relowner) || ' ' || c.relrowsecurity || ' ' || c.relforcerowsecurity || ' '
             || coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(c.relacl) a), '')
        FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'v', 'S', 'm')
    ) s ORDER BY x`)).map((r) => r.x);
  const links = () => db.$queryRaw`SELECT "correctionId" AS correction, tenant_id AS tenant, "originDocumentId" AS origin FROM billing_exclusion_links ORDER BY 1`;
  const statuses = () => db.$queryRaw`SELECT slug, "commercialStatus"::text AS status, "commercialStatusAt" AS at FROM tenants ORDER BY slug`;
  let before: Record<string, Record<string, unknown>[]> = {};
  let schemaBefore: string[] = [];
  const fx = { exclusion: '', payment: '' };

  beforeAll(async () => {
    if (!/\/erp_migration_test(\?|$)/.test(URL)) throw new Error('Base refusée pour le test de migration : seule erp_migration_test peut être vidée');
    await db.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await db.$executeRawUnsafe('CREATE SCHEMA public');
    // Toutes les migrations d'avant les ajustements (lots G0 à G5d-2), comme sur le serveur au moment de la mise à jour.
    mkdirSync(join(dir, 'migrations'));
    cpSync(join(PRISMA, 'schema.prisma'), join(dir, 'schema.prisma'));
    for (const m of readdirSync(join(PRISMA, 'migrations'))) {
      if (m < AJ || m === 'migration_lock.toml') cpSync(join(PRISMA, 'migrations', m), join(dir, 'migrations', m), { recursive: true });
    }
    deploy();
    const ids: Record<string, { group: string; user: string; year: string; klass: string; site: string; enrollment: string }> = {};
    for (const s of SCHOOLS) {
      const [g] = await db.$queryRaw<{ id: string }[]>`INSERT INTO school_groups (id, name, "updatedAt") VALUES (gen_random_uuid(), ${s.name}, now()) RETURNING id`;
      await db.$executeRaw`INSERT INTO tenants (id, slug, name, country, currency, timezone, settings, group_id, "updatedAt", "createdAt")
        VALUES (${s.id}::uuid, ${s.slug}, ${s.name}, 'BJ', 'XOF', 'Africa/Porto-Novo', '{}'::jsonb, ${g.id}::uuid, '2026-09-01T08:00:00Z', '2026-09-01T08:00:00Z')`;
      await db.$executeRaw`INSERT INTO group_audit_logs (id, group_id, "actorKind", "actorName", action) VALUES (gen_random_uuid(), ${g.id}::uuid, 'platform', 'Super Admin fictif', 'group.created_for_school')`;
      await db.$executeRaw`INSERT INTO platform_audit_logs (id, action, "tenantId") VALUES (gen_random_uuid(), 'platform.tenant.created', ${s.id}::uuid)`;
      ids[s.slug] = await inSchool(s.id, async (tx) => {
        const [u] = await tx.$queryRaw`INSERT INTO users (id, tenant_id, phone, "passwordHash", "firstName", "lastName", "updatedAt")
          VALUES (gen_random_uuid(), ${s.id}::uuid, '+2290190009201', 'empreinte-fictive', 'Direction', 'FICTIVE', now()) RETURNING id`;
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
        return { group: g.id, user: u.id, year: y.id, klass: c.id, site: st.id, enrollment: e.id };
      });
    }
    // Psi : essai terminé, conditions acceptées, calendrier, comptage figé de la fin de l'essai, proforma, exclusion validée
    // par le Super Admin (inscription annulée pour erreur de saisie), moyen de paiement et paiement partiel. Oméga : rien.
    const [psi] = SCHOOLS;
    const p = ids[psi.slug];
    const [sub] = await db.$queryRaw<{ id: string }[]>`INSERT INTO subscriptions (id, tenant_id, status, "trialStart", "trialEnd", "trialDays", "acceptedAt", "acceptedByName",
        "acceptedTariff", "graceStart", "graceEnd", "updatedAt")
      VALUES (gen_random_uuid(), ${psi.id}::uuid, 'AWAITING_PAYMENT', DATE '2026-10-01', ${LAST_FREE_DAY}::date, 14, '2026-10-20T09:00:00Z', 'Direction FICTIVE',
              ${JSON.stringify(TARIFF)}::jsonb, DATE '2026-10-15', DATE '2026-10-29', now()) RETURNING id`;
    await db.$executeRaw`INSERT INTO subscription_events (id, "subscriptionId", tenant_id, kind, "fromStatus", "toStatus", data, "actorKind", "actorName", "createdAt")
      VALUES (gen_random_uuid(), ${sub.id}::uuid, ${psi.id}::uuid, 'TRIAL_ENDED', 'TRIAL', 'AWAITING_ACCEPTANCE', ${JSON.stringify({ lastFreeDay: LAST_FREE_DAY })}::jsonb,
              'system', 'Cahiora (tâche planifiée)', '2026-10-15T00:05:00Z')`;
    await db.$executeRaw`INSERT INTO billing_calendars (id, tenant_id, "yearLabel", version, "startDate", "endDate", "initialCountDate", "firstRegularizationDate",
        "finalRegularizationDate", formula, reason, "createdByName")
      VALUES (gen_random_uuid(), ${psi.id}::uuid, '2026-2027', 1, DATE '2026-09-14', DATE '2027-07-31', DATE '2026-11-30', DATE '2027-03-31', DATE '2027-06-30',
              'B', 'Calendrier fictif', 'Super Admin fictif')`;
    const items = [{ enrollmentId: p.enrollment, classId: p.klass, siteId: p.site, counted: true, basis: 'ACTIVE', departureDate: null }];
    const [count] = await db.$queryRaw<{ count_id: string }[]>`
      SELECT * FROM record_billing_count(${psi.id}::uuid, ${p.year}::uuid, 'TRIAL_END', ${LAST_FREE_DAY}::date, 'FROZEN', NULL, ${JSON.stringify(items)}::jsonb,
        ${END_OF_DAY}::timestamptz, ${END_OF_DAY}::timestamptz, DATE '2026-10-15')`;
    await db.$executeRaw`INSERT INTO billing_documents (id, group_id, kind, reference, currency, "issueDate", "dueDate", total, "yearLabel", data, "createdByKind", "createdByName", "createdAt")
      VALUES (${DOC}::uuid, ${p.group}::uuid, 'SUBSCRIPTION', 'PROV-FICTIF-AJ01', 'XOF', DATE '2026-10-20', DATE '2026-10-29', 36363, '2026-2027',
              ${JSON.stringify({ title: 'Document fictif' })}::jsonb, 'system', 'Cahiora (tâche planifiée)', '2026-10-20T00:10:00')`;
    await db.$executeRaw`INSERT INTO billing_document_lines (id, "documentId", tenant_id, position, label, amount, "countId", "countKind", "referenceDate", pupils)
      VALUES (gen_random_uuid(), ${DOC}::uuid, ${psi.id}::uuid, 1, 'Ligne fictive', 36363, ${count.count_id}::uuid, 'TRIAL_END', ${LAST_FREE_DAY}::date, 1)`;
    fx.exclusion = await inSchool(psi.id, async (tx) => {
      await tx.$executeRaw`INSERT INTO enrollment_events (id, tenant_id, "enrollmentId", kind, data, "createdAt")
        VALUES (gen_random_uuid(), ${psi.id}::uuid, ${p.enrollment}::uuid, 'CANCELLED', ${JSON.stringify({ reason: 'Erreur de saisie fictive' })}::jsonb, '2026-10-24T09:00:00Z')`;
      await tx.$executeRaw`UPDATE enrollments SET status = 'CANCELLED', "cancelledAt" = '2026-10-24T09:00:00Z', "cancelReason" = 'Erreur de saisie fictive'
        WHERE id = ${p.enrollment}::uuid`;
      const [r] = await tx.$queryRaw`SELECT request_count_correction(${count.count_id}::uuid, 'EXCLUSION', ${p.enrollment}::uuid, NULL, 'Inscription saisie deux fois (fictif)',
        NULL, NULL, NULL, ${p.user}::uuid, 'Direction FICTIVE', NULL, DATE '2026-10-25') AS id`;
      return r.id as string;
    });
    await db.$queryRaw`SELECT * FROM decide_count_exclusion_platform(${psi.id}::uuid, ${fx.exclusion}::uuid, 'VALIDATED', NULL, NULL, 'Super Admin fictif', NULL)`;
    await db.$queryRaw`SELECT * FROM add_billing_payment_means('VIREMENT_FICTIF', true, 'Virement fictif', 'Coordonnées fictives du test de la migration', 'XOF', true,
      DATE '2026-11-20', 'Essai fictif de la migration', NULL, 'Super Admin fictif', DATE '2026-11-20')`;
    const [pay] = await db.$queryRaw<{ payment_id: string }[]>`SELECT payment_id FROM record_billing_payment(${psi.id}::uuid, ${DOC}::uuid, 10000, DATE '2026-11-21',
      'VIREMENT_FICTIF', 'REF FICTIVE AJ01', 'fictif/paiements/preuve.pdf', 'application/pdf', NULL, NULL, 'Super Admin fictif', NULL, DATE '2026-11-22')`;
    fx.payment = pay.payment_id;
    before = await snapshot();
    schemaBefore = await fingerprint();
    // Puis la migration des ajustements, seule.
    cpSync(join(PRISMA, 'migrations', AJ), join(dir, 'migrations', AJ), { recursive: true });
    deploy();
  }, 240000);

  afterAll(async () => {
    await db.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it('aucune donnée existante n’est modifiée ; tous les établissements deviennent « de test », une seule trace ; l’exclusion déjà validée est reliée à son document d’origine', async () => {
    unchanged(before, await snapshot(), { platform_audit_logs: 1 });
    expect(await statuses()).toEqual(SCHOOLS.map((s) => ({ slug: s.slug, status: 'TEST', at: null })).sort((a, b) => a.slug.localeCompare(b.slug)));
    expect(await db.$queryRaw`SELECT action, "tenantId" AS tenant, data FROM platform_audit_logs WHERE action = 'billing.commercial_status_initialized'`).toEqual([{
      action: 'billing.commercial_status_initialized', tenant: null,
      data: { source: 'migration ajustements_g5', status: 'TEST', establishments: 2, reason: 'Tous les établissements actuellement présents sur Cahiora servent aux tests (Dankou, 20 novembre 2026)' },
    }]);
    expect(await links()).toEqual([{ correction: fx.exclusion, tenant: SCHOOLS[0].id, origin: DOC }]);
    expect(await db.$queryRaw`SELECT "replacesPaymentId" AS r, "proofSha256" AS h, "similarReason" AS m FROM billing_payments`).toEqual([{ r: null, h: null, m: null }]);
    expect(await db.$queryRaw`SELECT count(*)::int AS n FROM _prisma_migrations WHERE migration_name = ${AJ} AND finished_at IS NOT NULL`).toEqual([{ n: 1 }]);
    // L'abonnement de Psi, d'avant ce lot, est figé : l'école ne lit ni abonnement ni accès, donc jamais d'accès limité.
    const [psi] = SCHOOLS;
    expect(await inSchool(psi.id, (tx) => tx.$queryRaw`SELECT * FROM current_tenant_subscription()`)).toEqual([]);
    expect(await inSchool(psi.id, (tx) => tx.$queryRaw`SELECT * FROM current_tenant_subscription_access()`)).toEqual([]);
  });

  it('les contrôles sont en place : rien de la facturation pour un établissement de test, abonnement figé, statut qui ne change plus avec un abonnement ou un document', async () => {
    const triggers = await db.$queryRaw<{ x: string }[]>`
      SELECT tgrelid::regclass::text || ':' || tgname AS x FROM pg_trigger WHERE NOT tgisinternal AND (tgname LIKE '%test_guard' OR tgname LIKE '%test_frozen' OR tgname = 'tenants_commercial_status_guard') ORDER BY 1`;
    expect(triggers.map((t) => t.x)).toEqual(GUARDS);
    const [psi, omega] = SCHOOLS;
    await expect(db.$executeRaw`INSERT INTO subscriptions (id, tenant_id) VALUES (gen_random_uuid(), ${omega.id}::uuid)`).rejects.toThrow(/établissement de test : aucun essai/);
    await expect(db.$executeRaw`UPDATE subscriptions SET status = 'LIMITED' WHERE tenant_id = ${psi.id}::uuid`).rejects.toThrow(/son abonnement reste figé/);
    await expect(db.$executeRaw`UPDATE tenants SET "commercialStatus" = 'CLIENT' WHERE id = ${psi.id}::uuid`).rejects.toThrow(/aucun abonnement ni aucun document de Cahiora/);
    await expect(db.$executeRaw`UPDATE tenants SET "commercialStatusAt" = now() WHERE id = ${omega.id}::uuid`).rejects.toThrow(/la date du statut commercial suit le changement du statut/);
    // Un paiement ne se ressaisit qu'une fois (index unique) ; ressaisie, empreinte et motif ne changent jamais.
    await expect(db.$executeRaw`UPDATE billing_payments SET "similarReason" = 'Motif ajouté après coup' WHERE id = ${fx.payment}::uuid`).rejects.toThrow();
    expect(await db.$queryRaw`SELECT indexdef FROM pg_indexes WHERE indexname = 'billing_payments_replacesPaymentId_key'`).toEqual([
      { indexdef: 'CREATE UNIQUE INDEX "billing_payments_replacesPaymentId_key" ON public.billing_payments USING btree ("replacesPaymentId")' },
    ]);
    expect(await statuses()).toEqual([{ slug: 'ecole-omega', status: 'TEST', at: null }, { slug: 'ecole-psi', status: 'TEST', at: null }]);
  });

  it('retour arrière : sans donnée nouvelle, il passe et remet le schéma de G5d-2 à l’identique ; une donnée nouvelle l’arrête, sauf forçage ; la migration se rejoue', async () => {
    const exists = async () => (await db.$queryRaw<{ t: string | null }[]>`SELECT to_regclass('public.billing_exclusion_links')::text AS t`)[0].t;
    // Le lien inscrit par la migration pour l'exclusion d'avant se déduit des données gardées : il n'arrête pas le retour.
    rollback();
    expect(await exists()).toBeNull();
    expect(await fingerprint()).toEqual(schemaBefore);
    expect(await db.$queryRaw`SELECT 1 FROM _prisma_migrations WHERE migration_name = ${AJ}`).toEqual([]);
    unchanged(before, await snapshot(), { platform_audit_logs: 1 });
    // Une nouvelle mise à jour rejoue la migration : mêmes statuts, même lien.
    deploy();
    expect(await statuses()).toEqual([{ slug: 'ecole-omega', status: 'TEST', at: null }, { slug: 'ecole-psi', status: 'TEST', at: null }]);
    expect(await links()).toEqual([{ correction: fx.exclusion, tenant: SCHOOLS[0].id, origin: DOC }]);
    unchanged(before, await snapshot(), { platform_audit_logs: 2 });
    // Données nouvelles : Oméga passe en client réel (sans abonnement ni document), et sa direction confirme qu'une date de
    // départ est introuvable, hors de tout comptage (G5b-2). Le retour arrière s'arrête sans rien changer.
    const [, omega] = SCHOOLS;
    await db.$executeRaw`UPDATE tenants SET "commercialStatus" = 'CLIENT' WHERE id = ${omega.id}::uuid`;
    const confirmed = await inSchool(omega.id, async (tx) => {
      const [y] = await tx.$queryRaw`SELECT id FROM academic_years LIMIT 1`;
      const [c] = await tx.$queryRaw`SELECT id FROM classes LIMIT 1`;
      const [u] = await tx.$queryRaw`SELECT "userId" AS id FROM user_roles WHERE role = 'DIRECTION' LIMIT 1`;
      const [pupil] = await tx.$queryRaw`INSERT INTO students (id, tenant_id, matricule, "firstName", "lastName", status, "updatedAt")
        VALUES (gen_random_uuid(), ${omega.id}::uuid, 'ecole-omega-002', 'Élève', 'PARTI', 'ACTIVE', now()) RETURNING id`;
      const [e] = await tx.$queryRaw`INSERT INTO enrollments (id, tenant_id, "studentId", "classId", "academicYearId", status, "enrolledAt", type)
        VALUES (gen_random_uuid(), ${omega.id}::uuid, ${pupil.id}::uuid, ${c.id}::uuid, ${y.id}::uuid, 'WITHDRAWN', '2026-09-14T08:00:00Z', 'NEW') RETURNING id`;
      const [r] = await tx.$queryRaw`SELECT request_count_correction(NULL, 'DEPARTURE_CONFIRMED', ${e.id}::uuid, NULL, 'Date de départ introuvable (fictif)',
        NULL, NULL, NULL, ${u.id}::uuid, 'Direction FICTIVE', NULL, DATE '2026-11-24') AS id`;
      return r.id as string;
    });
    expect(confirmed).toEqual(expect.any(String));
    expect(refusal()).toMatch(/Retour arrière arrêté, rien n'a été changé : 1 établissement\(s\) en client réel, 0 lien\(s\) d'exclusion, 1 correction\(s\) de départ hors comptage ou date introuvable, 0 paiement\(s\) avec ressaisie, empreinte ou motif/);
    expect(await exists()).toBe('billing_exclusion_links');
    expect((await statuses() as { status: string }[]).map((s) => s.status)).toEqual(['CLIENT', 'TEST']);
    expect(await inSchool(omega.id, (tx) => tx.$queryRaw`SELECT kind::text AS kind, "countId" AS count FROM count_corrections`)).toEqual([{ kind: 'DEPARTURE_CONFIRMED', count: null }]);
    // Forcé en connaissance de cause : le lot part (la confirmation aussi), le reste de la base ne bouge pas ; le schéma est celui de G5d-2.
    rollback(true);
    expect(await exists()).toBeNull();
    expect(await fingerprint()).toEqual(schemaBefore);
    expect(await inSchool(omega.id, (tx) => tx.$queryRaw`SELECT count(*)::int AS n FROM count_corrections`)).toEqual([{ n: 0 }]);
    unchanged(before, await snapshot(), { platform_audit_logs: 3, group_audit_logs: 1, 'ecole-omega:students': 1, 'ecole-omega:enrollments': 1 });
    deploy();
    expect(await statuses()).toEqual([{ slug: 'ecole-omega', status: 'TEST', at: null }, { slug: 'ecole-psi', status: 'TEST', at: null }]);
    expect(await links()).toEqual([{ correction: fx.exclusion, tenant: SCHOOLS[0].id, origin: DOC }]);
  });
});
