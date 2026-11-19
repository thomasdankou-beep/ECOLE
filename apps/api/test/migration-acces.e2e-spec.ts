/**
 * Lot G5d-1 : la migration de l'accès selon le paiement jouée sur une base qui a déjà les lots G0 à G5c, avec des
 * groupes, des écoles, des comptes, des journaux et des abonnements (essai en cours, conditions acceptées après une
 * gratuité finie avant ce lot), comme le serait la production, avec des données entièrement fictives. Base jetable
 * erp_migration_test, vidée à chaque lancement ; le test refuse toute autre base.
 */
import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const URL = process.env.DATABASE_MIGRATION_URL ?? '';
const G5D1 = '20261121090000_acces_g5d1';
const PRISMA = join(__dirname, '..', 'prisma');
const SCHOOLS = [
  { id: '9c9c9c9c-9c9c-4c9c-9c9c-9c9c9c9c9c9c', slug: 'ecole-pi', name: 'École Pi (fictive)' },
  { id: '9d9d9d9d-9d9d-4d9d-9d9d-9d9d9d9d9d9d', slug: 'ecole-rho', name: 'Lycée Rho (fictif)' },
  { id: '9e9e9e9e-9e9e-4e9e-9e9e-9e9e9e9e9e9e', slug: 'ecole-sigma', name: 'Collège Sigma (fictif)' },
];
const PLATFORM = [
  'billing_calendars', 'billing_jobs', 'billing_parameters', 'billing_counts', 'billing_documents', 'billing_document_lines', 'commercial_terms', 'platform_alerts',
  'subscription_events', 'subscriptions', 'services', 'service_versions', 'service_rates', 'service_rate_ends', 'tenants', 'school_groups', 'group_audit_logs',
  'platform_audit_logs',
];
const SCHOOL_TABLES = ['users', 'user_roles', 'audit_logs', 'notifications'];
/** Colonnes ajoutées aux abonnements par le lot : vides pour les abonnements existants. */
const NEW_COLUMNS = ['graceStart', 'graceEnd', 'extendedUntil', 'limitedSince'];
/** Journaux et historiques en ajout seul : une demande y laisse ses lignes, même après un retour arrière forcé. */
const APPEND_ONLY = ['subscription_events', 'platform_alerts', 'platform_audit_logs', 'group_audit_logs'];

describe('Lot G5d-1 · migration de l’accès selon le paiement sur une base qui a déjà les lots G0 à G5c (données fictives)', () => {
  const db = new PrismaClient({ datasources: { db: { url: URL } } });
  const dir = mkdtempSync(join(tmpdir(), 'erp-migration-g5d1-'));
  const deploy = () =>
    execSync(`npx prisma migrate deploy --schema ${join(dir, 'schema.prisma')}`, { cwd: join(__dirname, '..'), env: { ...process.env, DATABASE_URL: URL, DATABASE_ADMIN_URL: URL }, stdio: 'pipe' });
  const inSchool = <T>(tenant: string, fn: (tx: any) => Promise<T>) =>
    db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant}, true)`;
      return fn(tx);
    });
  /** Toutes les lignes des tables existantes qui comptent pour le client, sans les colonnes ajoutées par le lot. */
  const snapshot = async () => {
    const rows = async (sql: string) => (await db.$queryRawUnsafe<{ r: Record<string, unknown> }[]>(sql)).map((x) => x.r);
    const out: Record<string, Record<string, unknown>[]> = {};
    const strip = NEW_COLUMNS.map((c) => ` - '${c}'`).join('');
    for (const t of PLATFORM) out[t] = await rows(`SELECT to_jsonb(x)${t === 'subscriptions' ? strip : ''} AS r FROM ${t} x ORDER BY id`);
    for (const s of SCHOOLS) {
      for (const t of SCHOOL_TABLES) {
        out[`${s.slug}:${t}`] = await inSchool(s.id, async (tx) => (await tx.$queryRawUnsafe(`SELECT to_jsonb(x) AS r FROM ${t} x ORDER BY id`)).map((x: { r: unknown }) => x.r));
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
  const acceptFn = () => db.$queryRaw<{ def: string }[]>`SELECT pg_get_functiondef('accept_commercial_terms(uuid, uuid, text, text, date)'::regprocedure) AS def`;
  let before: Record<string, Record<string, unknown>[]> = {};
  let acceptBefore = '';
  const direction: Record<string, string> = {};

  beforeAll(async () => {
    if (!/\/erp_migration_test(\?|$)/.test(URL)) throw new Error('Base refusée pour le test de migration : seule erp_migration_test peut être vidée');
    await db.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await db.$executeRawUnsafe('CREATE SCHEMA public');
    // Toutes les migrations d'avant l'accès (lots G0 à G5c), comme sur le serveur au moment de la mise à jour.
    mkdirSync(join(dir, 'migrations'));
    cpSync(join(PRISMA, 'schema.prisma'), join(dir, 'schema.prisma'));
    for (const m of readdirSync(join(PRISMA, 'migrations'))) {
      if (m < G5D1 || m === 'migration_lock.toml') cpSync(join(PRISMA, 'migrations', m), join(dir, 'migrations', m), { recursive: true });
    }
    deploy();
    for (const s of SCHOOLS) {
      const [g] = await db.$queryRaw<{ id: string }[]>`INSERT INTO school_groups (id, name, "updatedAt") VALUES (gen_random_uuid(), ${s.name}, now()) RETURNING id`;
      await db.$executeRaw`INSERT INTO tenants (id, slug, name, country, currency, timezone, settings, group_id, "updatedAt", "createdAt")
        VALUES (${s.id}::uuid, ${s.slug}, ${s.name}, 'BJ', 'XOF', 'Africa/Porto-Novo', '{}'::jsonb, ${g.id}::uuid, '2026-09-01T08:00:00Z', '2026-09-01T08:00:00Z')`;
      await db.$executeRaw`INSERT INTO group_audit_logs (id, group_id, "actorKind", "actorName", action) VALUES (gen_random_uuid(), ${g.id}::uuid, 'platform', 'Super Admin fictif', 'group.created_for_school')`;
      await db.$executeRaw`INSERT INTO platform_audit_logs (id, action, "tenantId") VALUES (gen_random_uuid(), 'platform.tenant.created', ${s.id}::uuid)`;
      direction[s.slug] = await inSchool(s.id, async (tx) => {
        const [u] = await tx.$queryRaw`INSERT INTO users (id, tenant_id, phone, "passwordHash", "firstName", "lastName", "updatedAt")
          VALUES (gen_random_uuid(), ${s.id}::uuid, '+2290190009101', 'empreinte-fictive', 'Direction', 'FICTIVE', now()) RETURNING id`;
        await tx.$executeRaw`INSERT INTO user_roles (id, tenant_id, "userId", role) VALUES (gen_random_uuid(), ${s.id}::uuid, ${u.id}::uuid, 'DIRECTION')`;
        await tx.$executeRaw`INSERT INTO audit_logs (id, tenant_id, "userName", action, entity) VALUES (gen_random_uuid(), ${s.id}::uuid, 'Direction FICTIVE', 'auth.login', 'User')`;
        await tx.$executeRaw`INSERT INTO notifications (id, tenant_id, "userId", channel, kind, title, body, status)
          VALUES (gen_random_uuid(), ${s.id}::uuid, ${u.id}::uuid, 'IN_APP', 'billing.trial_ended', 'Essai fictif terminé', 'Texte fictif', 'SENT')`;
        return u.id as string;
      });
    }
    // Pi : gratuité finie avant le lot, conditions acceptées, en attente de paiement. Rho : essai en cours. Sigma : rien.
    const [pi, rho] = SCHOOLS;
    const [sub] = await db.$queryRaw<{ id: string }[]>`INSERT INTO subscriptions (id, tenant_id, status, "trialStart", "trialEnd", "trialDays", "acceptedAt", "acceptedByName",
        "acceptedTariff", "updatedAt")
      VALUES (gen_random_uuid(), ${pi.id}::uuid, 'AWAITING_PAYMENT', DATE '2026-10-01', DATE '2026-10-14', 14, '2026-10-20T09:00:00Z', 'Direction FICTIVE',
              ${JSON.stringify({ currency: 'XOF', pricePerPupil: 500, minimum: 40000, day: '2026-10-20' })}::jsonb, now()) RETURNING id`;
    await db.$executeRaw`INSERT INTO subscription_events (id, "subscriptionId", tenant_id, kind, "fromStatus", "toStatus", data, "actorKind", "actorName", "createdAt")
      VALUES (gen_random_uuid(), ${sub.id}::uuid, ${pi.id}::uuid, 'TRIAL_ENDED', 'TRIAL', 'AWAITING_ACCEPTANCE', ${JSON.stringify({ lastFreeDay: '2026-10-14' })}::jsonb,
              'system', 'Cahiora (tâche planifiée)', '2026-10-15T00:05:00Z')`;
    await db.$executeRaw`INSERT INTO platform_alerts (id, tenant_id, kind, message, "dueDate") VALUES (gen_random_uuid(), ${pi.id}::uuid, 'TRIAL_ENDED', 'Essai fictif terminé', DATE '2026-10-14')`;
    await db.$executeRaw`INSERT INTO subscriptions (id, tenant_id, status, "trialStart", "trialEnd", "trialDays", "updatedAt")
      VALUES (gen_random_uuid(), ${rho.id}::uuid, 'TRIAL', DATE '2026-11-15', DATE '2026-11-28', 14, now())`;
    before = await snapshot();
    acceptBefore = (await acceptFn())[0].def;
    // Puis la migration de l'accès, seule.
    cpSync(join(PRISMA, 'migrations', G5D1), join(dir, 'migrations', G5D1), { recursive: true });
    deploy();
  }, 240000);

  afterAll(async () => {
    await db.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it('aucune donnée existante n’est modifiée ; colonnes nouvelles vides ; un seul paramètre ajouté, le délai de grâce de 15 jours', async () => {
    unchanged(before, await snapshot(), { billing_parameters: 1, platform_audit_logs: 1 });
    expect(await db.$queryRaw`SELECT count(*)::int AS n FROM subscriptions WHERE "graceStart" IS NOT NULL OR "graceEnd" IS NOT NULL OR "extendedUntil" IS NOT NULL OR "limitedSince" IS NOT NULL`)
      .toEqual([{ n: 0 }]);
    expect(await db.$queryRaw`SELECT key, currency, value, "effectiveFrom"::text AS "from", "createdByName" AS by FROM billing_parameters WHERE key = 'GRACE_DAYS'`).toEqual([
      { key: 'GRACE_DAYS', currency: null, value: 15, from: '2026-11-19', by: 'Mise à jour de Cahiora (lot G5d-1)' },
    ]);
    expect(await db.$queryRaw`SELECT action, data FROM platform_audit_logs WHERE data->>'source' = 'migration acces_g5d1'`).toEqual([
      { action: 'billing.parameters.initial', data: { source: 'migration acces_g5d1', count: 1, key: 'GRACE_DAYS' } },
    ]);
    expect(await db.$queryRaw`SELECT count(*)::int AS n FROM regularization_requests`).toEqual([{ n: 0 }]);
    expect(await db.$queryRaw`SELECT count(*)::int AS n FROM _prisma_migrations WHERE migration_name = ${G5D1} AND finished_at IS NOT NULL`).toEqual([{ n: 1 }]);
    // Gratuité finie avant le lot : pas de délai connu, donc jamais limitée seule (lu par la fonction de l'école).
    expect(await inSchool(SCHOOLS[0].id, (tx) => tx.$queryRaw`SELECT * FROM current_tenant_subscription_access()`)).toEqual([{
      status: 'AWAITING_PAYMENT', grace_start: null, grace_end: null, extended_until: null, limited_since: null, terms_accepted: true, pending_request: false,
    }]);
    expect(await inSchool(SCHOOLS[2].id, (tx) => tx.$queryRaw`SELECT * FROM current_tenant_subscription_access()`)).toEqual([]);
  });

  it('Row Level Security forcée ; plateforme en lecture et réponse seulement ; écoles par leurs fonctions ; groupes et statistiques sans droit', async () => {
    expect(await db.$queryRaw`
      SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             (SELECT string_agg(p.policyname, ',' ORDER BY p.policyname) FROM pg_policies p WHERE p.tablename = c.relname) AS policies
      FROM pg_class c WHERE c.relname = 'regularization_requests' AND c.relkind = 'r'`).toEqual([
      { rls: true, forced: true, policies: 'regularization_requests_owner_all,regularization_requests_platform_all' },
    ]);
    const rights = await db.$queryRaw<{ role: string; sel: boolean; ins: boolean; upd: boolean; del: boolean; trunc: boolean; answer: boolean; message: boolean }[]>`
      SELECT r AS role, has_table_privilege(r, 'regularization_requests', 'SELECT') AS sel, has_table_privilege(r, 'regularization_requests', 'INSERT') AS ins,
             has_table_privilege(r, 'regularization_requests', 'UPDATE') AS upd, has_table_privilege(r, 'regularization_requests', 'DELETE') AS del,
             has_table_privilege(r, 'regularization_requests', 'TRUNCATE') AS trunc, has_column_privilege(r, 'regularization_requests', 'answer', 'UPDATE') AS answer,
             has_column_privilege(r, 'regularization_requests', 'message', 'UPDATE') AS message
      FROM unnest(ARRAY['erp_app', 'erp_group', 'erp_stats', 'erp_platform']) AS r ORDER BY 1`;
    expect(rights).toEqual([
      { role: 'erp_app', sel: false, ins: false, upd: false, del: false, trunc: false, answer: false, message: false },
      { role: 'erp_group', sel: false, ins: false, upd: false, del: false, trunc: false, answer: false, message: false },
      { role: 'erp_platform', sel: true, ins: false, upd: false, del: false, trunc: false, answer: true, message: false },
      { role: 'erp_stats', sel: false, ins: false, upd: false, del: false, trunc: false, answer: false, message: false },
    ]);
    const fns = await db.$queryRaw<{ role: string; fn: string; ok: boolean }[]>`
      SELECT r AS role, p.proname AS fn, has_function_privilege(r, p.oid, 'EXECUTE') AS ok
      FROM unnest(ARRAY['erp_app', 'erp_group', 'erp_stats', 'erp_platform']) AS r,
           pg_proc p WHERE p.proname IN ('current_tenant_subscription_access', 'current_tenant_regularization_requests', 'request_regularization', 'accept_commercial_terms')
      ORDER BY 1, 2`;
    expect(fns.filter((f) => f.ok).map((f) => `${f.role}:${f.fn}`)).toEqual([
      'erp_app:accept_commercial_terms', 'erp_app:current_tenant_regularization_requests', 'erp_app:current_tenant_subscription_access', 'erp_app:request_regularization',
    ]);
    // L'acceptation des conditions est reprise (possible en accès limité), avec ses droits.
    expect((await acceptFn())[0].def).not.toBe(acceptBefore);
    const triggers = await db.$queryRaw<{ t: string; name: string }[]>`
      SELECT tgrelid::regclass::text AS t, tgname AS name FROM pg_trigger
      WHERE NOT tgisinternal AND (tgrelid = 'regularization_requests'::regclass OR tgname IN ('subscriptions_access_guard', 'billing_document_lines_terms_check')) ORDER BY 1, 2`;
    expect(triggers.map((x) => `${x.t}:${x.name}`)).toEqual([
      'billing_document_lines:billing_document_lines_terms_check', 'regularization_requests:regularization_requests_guard', 'regularization_requests:regularization_requests_no_delete',
      'regularization_requests:regularization_requests_no_truncate', 'regularization_requests:same_tenant_refs', 'subscriptions:subscriptions_access_guard',
    ]);
  });

  it('retour arrière : refusé dès qu’une demande existe, sauf forçage ; il retire le lot sans toucher au reste, puis la migration se rejoue', async () => {
    const script = join(PRISMA, 'retour-arriere', `${G5D1}.sql`);
    const rollback = (force = false) =>
      execSync(`psql "${URL}" -v ON_ERROR_STOP=1 -q -f ${script}`, { env: { ...process.env, PGOPTIONS: force ? '-c cahiora.forcer_retour=oui' : '' }, stdio: 'pipe' });
    const exists = async () => (await db.$queryRaw<{ t: string | null }[]>`SELECT to_regclass('public.regularization_requests')::text AS t`)[0].t;
    // Une demande de la direction de Pi, par la fonction de l'école.
    const [pi] = SCHOOLS;
    await inSchool(pi.id, (tx) => tx.$queryRaw`SELECT request_regularization(${direction[pi.slug]}::uuid, 'Direction FICTIVE', 'Demande fictive', NULL)`);
    let refused = '';
    try {
      rollback();
    } catch (e) {
      refused = String((e as { stderr?: Buffer }).stderr ?? e);
    }
    expect(refused).toMatch(/Retour arrière arrêté, rien n'a été changé : 1 demande\(s\) de régularisation, 0 abonnement\(s\)/);
    expect(await exists()).toBe('regularization_requests');
    // Forcé en connaissance de cause : tout le lot part ; le reste de la base ne bouge pas (les journaux gardent la demande).
    rollback(true);
    expect(await exists()).toBeNull();
    expect(await db.$queryRaw`SELECT proname FROM pg_proc WHERE proname IN ('current_tenant_subscription_access', 'current_tenant_regularization_requests', 'request_regularization',
      'grant_platform_access_role', 'subscriptions_access_guard', 'regularization_requests_guard', 'billing_document_lines_terms_check')`).toEqual([]);
    expect(await db.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_name = 'subscriptions' AND column_name = ANY(${NEW_COLUMNS})`).toEqual([]);
    expect(await db.$queryRaw`SELECT typname FROM pg_type WHERE typname = 'RegularizationRequestStatus'`).toEqual([]);
    expect(await db.$queryRaw`SELECT count(*)::int AS n FROM billing_parameters WHERE key = 'GRACE_DAYS'`).toEqual([{ n: 0 }]);
    expect(await db.$queryRaw`SELECT 1 FROM _prisma_migrations WHERE migration_name = ${G5D1}`).toEqual([]);
    // L'acceptation du lot G5a est revenue telle qu'elle était, avec ses droits.
    expect((await acceptFn())[0].def).toBe(acceptBefore);
    expect(await db.$queryRaw`SELECT has_function_privilege('erp_app', 'accept_commercial_terms(uuid, uuid, text, text, date)', 'EXECUTE') AS ok`).toEqual([{ ok: true }]);
    // La demande a laissé une ligne dans l'historique, une alerte et deux journaux ; le journal de la plateforme garde aussi le paramètre initial.
    unchanged(before, await snapshot(), { subscription_events: 1, platform_alerts: 1, group_audit_logs: 1, platform_audit_logs: 2 });
    for (const t of APPEND_ONLY) expect(await db.$queryRawUnsafe(`SELECT count(*)::int AS n FROM ${t}`)).not.toEqual([{ n: 0 }]);
    // Une nouvelle mise à jour rejoue la migration ; sans demande ni délai, le retour arrière passe sans forçage.
    deploy();
    expect(await exists()).toBe('regularization_requests');
    rollback();
    expect(await exists()).toBeNull();
    deploy();
    expect(await exists()).toBe('regularization_requests');
    expect(await db.$queryRaw`SELECT has_table_privilege('erp_platform', 'regularization_requests', 'SELECT') AS ok`).toEqual([{ ok: true }]);
    expect(await db.$queryRaw`SELECT count(*)::int AS n FROM billing_parameters WHERE key = 'GRACE_DAYS'`).toEqual([{ n: 1 }]);
  });
});
