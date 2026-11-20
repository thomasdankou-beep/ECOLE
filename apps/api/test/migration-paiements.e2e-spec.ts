/**
 * Lot G5d-2 : la migration des paiements de l'abonnement jouée sur une base qui a déjà les lots G0 à G5d-1, avec des
 * groupes, des écoles, des comptes, des journaux, des abonnements, des documents provisoires et des avoirs (dont l'avoir
 * d'un document de plusieurs établissements), comme le serait la production, avec des données entièrement fictives.
 * Base jetable erp_migration_test, vidée à chaque lancement ; le test refuse toute autre base.
 */
import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const URL = process.env.DATABASE_MIGRATION_URL ?? '';
const G5D2 = '20261122090000_paiements_g5d2';
const PRISMA = join(__dirname, '..', 'prisma');
const SCHOOLS = [
  { id: 'a1a1a1a1-a1a1-4a1a-a1a1-a1a1a1a1a1a1', slug: 'ecole-tau', name: 'École Tau (fictive)' },
  { id: 'a2a2a2a2-a2a2-4a2a-a2a2-a2a2a2a2a2a2', slug: 'ecole-upsilon', name: 'Lycée Upsilon (fictif)' },
  { id: 'a3a3a3a3-a3a3-4a3a-a3a3-a3a3a3a3a3a3', slug: 'ecole-phi', name: 'Collège Phi (fictif)' },
  { id: 'a4a4a4a4-a4a4-4a4a-a4a4-a4a4a4a4a4a4', slug: 'ecole-chi', name: 'Collège Chi (fictif)' },
];
const DOCS = {
  d1: 'b1b1b1b1-b1b1-4b1b-b1b1-b1b1b1b1b1b1', c1: 'b2b2b2b2-b2b2-4b2b-b2b2-b2b2b2b2b2b2',
  d2: 'b3b3b3b3-b3b3-4b3b-b3b3-b3b3b3b3b3b3', c2: 'b4b4b4b4-b4b4-4b4b-b4b4-b4b4b4b4b4b4', c3: 'b5b5b5b5-b5b5-4b5b-b5b5-b5b5b5b5b5b5',
  d3: 'b6b6b6b6-b6b6-4b6b-b6b6-b6b6b6b6b6b6', c4: 'b7b7b7b7-b7b7-4b7b-b7b7-b7b7b7b7b7b7',
};
const PLATFORM = [
  'billing_calendars', 'billing_jobs', 'billing_parameters', 'billing_counts', 'billing_documents', 'billing_document_lines', 'commercial_terms', 'platform_alerts',
  'subscription_events', 'subscriptions', 'regularization_requests', 'services', 'service_versions', 'service_rates', 'service_rate_ends', 'tenants', 'school_groups',
  'group_audit_logs', 'platform_audit_logs',
];
const SCHOOL_TABLES = ['users', 'user_roles', 'audit_logs', 'notifications'];
const TABLES = ['billing_allocations', 'billing_credit_entries', 'billing_credit_transfers', 'billing_payment_means', 'billing_payments', 'billing_refunds'];
const FUNCTIONS = [
  'add_billing_payment_means', 'apply_billing_credit', 'billing_credit_balance', 'billing_credit_reserved', 'billing_grace_document', 'billing_payable_documents',
  'billing_plan_allocations', 'billing_write_allocations', 'cancel_billing_payment', 'current_tenant_billing_balances', 'current_tenant_billing_credit_entries',
  'current_tenant_billing_payments', 'current_tenant_billing_refunds', 'current_tenant_payment_means', 'decide_billing_refund', 'impute_billing_credit_note',
  'record_billing_payment', 'request_billing_refund', 'transfer_billing_credit',
];
/** Journaux et historiques en ajout seul : ils gardent leurs lignes, même après un retour arrière forcé. */
const APPEND_ONLY = ['subscription_events', 'platform_alerts', 'platform_audit_logs', 'group_audit_logs'];

describe('Lot G5d-2 · migration des paiements sur une base qui a déjà les lots G0 à G5d-1 (données fictives)', () => {
  const db = new PrismaClient({ datasources: { db: { url: URL } } });
  const dir = mkdtempSync(join(tmpdir(), 'erp-migration-g5d2-'));
  const deploy = () =>
    execSync(`npx prisma migrate deploy --schema ${join(dir, 'schema.prisma')}`, { cwd: join(__dirname, '..'), env: { ...process.env, DATABASE_URL: URL, DATABASE_ADMIN_URL: URL }, stdio: 'pipe' });
  const inSchool = <T>(tenant: string, fn: (tx: any) => Promise<T>) =>
    db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant}, true)`;
      return fn(tx);
    });
  /** Toutes les lignes des tables existantes qui comptent pour le client. */
  const snapshot = async () => {
    const rows = async (sql: string) => (await db.$queryRawUnsafe<{ r: Record<string, unknown> }[]>(sql)).map((x) => x.r);
    const out: Record<string, Record<string, unknown>[]> = {};
    for (const t of PLATFORM) out[t] = await rows(`SELECT to_jsonb(x) AS r FROM ${t} x ORDER BY id`);
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
  /** Ce que la migration a imputé (sans identifiants ni dates). */
  const imputed = async () => ({
    allocations: await db.$queryRaw`SELECT "documentId" AS doc, source::text, "creditNoteId" AS note, amount FROM billing_allocations ORDER BY amount DESC, "documentId"`,
    entries: await db.$queryRaw`SELECT tenant_id AS tenant, kind::text, amount, "documentId" AS doc, data FROM billing_credit_entries ORDER BY tenant_id`,
  });
  let before: Record<string, Record<string, unknown>[]> = {};
  let first: Awaited<ReturnType<typeof imputed>>;
  const groups: Record<string, string> = {};

  beforeAll(async () => {
    if (!/\/erp_migration_test(\?|$)/.test(URL)) throw new Error('Base refusée pour le test de migration : seule erp_migration_test peut être vidée');
    await db.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await db.$executeRawUnsafe('CREATE SCHEMA public');
    // Toutes les migrations d'avant les paiements (lots G0 à G5d-1), comme sur le serveur au moment de la mise à jour.
    mkdirSync(join(dir, 'migrations'));
    cpSync(join(PRISMA, 'schema.prisma'), join(dir, 'schema.prisma'));
    for (const m of readdirSync(join(PRISMA, 'migrations'))) {
      if (m < G5D2 || m === 'migration_lock.toml') cpSync(join(PRISMA, 'migrations', m), join(dir, 'migrations', m), { recursive: true });
    }
    deploy();
    // Tau et Upsilon : écoles indépendantes ; Phi et Chi : un groupe de deux établissements (D-G5-19 encore ouverte).
    const [tau, upsilon, phi, chi] = SCHOOLS;
    for (const s of [tau, upsilon]) {
      const [g] = await db.$queryRaw<{ id: string }[]>`INSERT INTO school_groups (id, name, "updatedAt") VALUES (gen_random_uuid(), ${s.name}, now()) RETURNING id`;
      groups[s.slug] = g.id;
    }
    const [pc] = await db.$queryRaw<{ id: string }[]>`INSERT INTO school_groups (id, name, "updatedAt") VALUES (gen_random_uuid(), 'Groupe Phi-Chi (fictif)', now()) RETURNING id`;
    groups[phi.slug] = groups[chi.slug] = pc.id;
    for (const s of SCHOOLS) {
      await db.$executeRaw`INSERT INTO tenants (id, slug, name, country, currency, timezone, settings, group_id, "updatedAt", "createdAt")
        VALUES (${s.id}::uuid, ${s.slug}, ${s.name}, 'BJ', 'XOF', 'Africa/Porto-Novo', '{}'::jsonb, ${groups[s.slug]}::uuid, '2026-09-01T08:00:00Z', '2026-09-01T08:00:00Z')`;
      await db.$executeRaw`INSERT INTO platform_audit_logs (id, action, "tenantId") VALUES (gen_random_uuid(), 'platform.tenant.created', ${s.id}::uuid)`;
      await inSchool(s.id, async (tx) => {
        const [u] = await tx.$queryRaw`INSERT INTO users (id, tenant_id, phone, "passwordHash", "firstName", "lastName", "updatedAt")
          VALUES (gen_random_uuid(), ${s.id}::uuid, '+2290190009102', 'empreinte-fictive', 'Direction', 'FICTIVE', now()) RETURNING id`;
        await tx.$executeRaw`INSERT INTO user_roles (id, tenant_id, "userId", role) VALUES (gen_random_uuid(), ${s.id}::uuid, ${u.id}::uuid, 'DIRECTION')`;
        await tx.$executeRaw`INSERT INTO audit_logs (id, tenant_id, "userName", action, entity) VALUES (gen_random_uuid(), ${s.id}::uuid, 'Direction FICTIVE', 'auth.login', 'User')`;
        await tx.$executeRaw`INSERT INTO notifications (id, tenant_id, "userId", channel, kind, title, body, status)
          VALUES (gen_random_uuid(), ${s.id}::uuid, ${u.id}::uuid, 'IN_APP', 'billing.document_issued', 'Document fictif', 'Texte fictif', 'SENT')`;
      });
      await db.$executeRaw`INSERT INTO group_audit_logs (id, group_id, "actorKind", "actorName", action) VALUES (gen_random_uuid(), ${groups[s.slug]}::uuid, 'platform', 'Super Admin fictif', 'group.created_for_school')`;
    }
    const [sub] = await db.$queryRaw<{ id: string }[]>`INSERT INTO subscriptions (id, tenant_id, status, "trialStart", "trialEnd", "trialDays", "acceptedAt", "acceptedByName",
        "acceptedTariff", "graceStart", "graceEnd", "updatedAt")
      VALUES (gen_random_uuid(), ${tau.id}::uuid, 'AWAITING_PAYMENT', DATE '2026-10-01', DATE '2026-10-14', 14, '2026-10-15T09:00:00Z', 'Direction FICTIVE',
              ${JSON.stringify({ currency: 'XOF', pricePerPupil: 500, minimum: 40000, day: '2026-10-15' })}::jsonb, DATE '2026-10-15', DATE '2026-10-29', now()) RETURNING id`;
    await db.$executeRaw`INSERT INTO subscription_events (id, "subscriptionId", tenant_id, kind, "fromStatus", "toStatus", data, "actorKind", "actorName", "createdAt")
      VALUES (gen_random_uuid(), ${sub.id}::uuid, ${tau.id}::uuid, 'TRIAL_ENDED', 'TRIAL', 'AWAITING_ACCEPTANCE', ${JSON.stringify({ lastFreeDay: '2026-10-14' })}::jsonb,
              'system', 'Cahiora (tâche planifiée)', '2026-10-15T00:05:00Z')`;
    await db.$executeRaw`INSERT INTO platform_alerts (id, tenant_id, kind, message, "dueDate") VALUES (gen_random_uuid(), ${tau.id}::uuid, 'TRIAL_ENDED', 'Essai fictif terminé', DATE '2026-10-14')`;
    // Documents provisoires et avoirs du lot G5c, tels que les écrit issue_billing_document (une ligne par établissement).
    const doc = (id: string, group: string, kind: string, ref: string, issue: string, total: number, related: string | null, createdAt: string) =>
      db.$executeRaw`INSERT INTO billing_documents (id, group_id, kind, reference, currency, "issueDate", "dueDate", total, "yearLabel", "relatedDocumentId", data, "createdByKind",
          "createdByName", "createdAt")
        VALUES (${id}::uuid, ${group}::uuid, ${kind}::"BillingDocumentKind", ${ref}, 'XOF', ${issue}::date, NULL, ${total}, '2026-2027', ${related}::uuid,
                ${JSON.stringify({ title: 'Document fictif' })}::jsonb, 'system', 'Cahiora (tâche planifiée)', ${createdAt}::timestamp)`;
    const line = (document: string, tenant: string, position: number, amount: number, kind: string | null) =>
      db.$executeRaw`INSERT INTO billing_document_lines (id, "documentId", tenant_id, position, label, amount, "countKind", "referenceDate")
        VALUES (gen_random_uuid(), ${document}::uuid, ${tenant}::uuid, ${position}, 'Ligne fictive', ${amount}, ${kind}::"BillingCountKind", ${kind ? '2026-10-14' : null}::date)`;
    await doc(DOCS.d1, groups[tau.slug], 'SUBSCRIPTION', 'PROV-FICTIF-0001', '2026-10-15', 40000, null, '2026-10-15T00:10:00');
    await line(DOCS.d1, tau.id, 1, 40000, 'TRIAL_END');
    await doc(DOCS.d2, groups[upsilon.slug], 'SUBSCRIPTION', 'PROV-FICTIF-0002', '2026-10-16', 40000, null, '2026-10-16T00:10:00');
    await line(DOCS.d2, upsilon.id, 1, 40000, 'TRIAL_END');
    await doc(DOCS.d3, pc.id, 'SUBSCRIPTION', 'PROV-FICTIF-0003', '2026-10-17', 80000, null, '2026-10-17T00:10:00');
    await line(DOCS.d3, phi.id, 1, 40000, 'TRIAL_END');
    await line(DOCS.d3, chi.id, 2, 40000, 'TRIAL_END');
    // Avoirs : partiel (Tau), total puis au-delà (Upsilon), sur le document d'un groupe de deux établissements (Phi).
    await doc(DOCS.c1, groups[tau.slug], 'CREDIT_NOTE', 'PROV-AV-FICTIF-0001', '2026-10-20', 5000, DOCS.d1, '2026-10-20T10:00:00');
    await line(DOCS.c1, tau.id, 1, 5000, null);
    await doc(DOCS.c2, groups[upsilon.slug], 'CREDIT_NOTE', 'PROV-AV-FICTIF-0002', '2026-10-21', 40000, DOCS.d2, '2026-10-21T10:00:00');
    await line(DOCS.c2, upsilon.id, 1, 40000, null);
    await doc(DOCS.c3, groups[upsilon.slug], 'CREDIT_NOTE', 'PROV-AV-FICTIF-0003', '2026-10-22', 3000, DOCS.d2, '2026-10-22T10:00:00');
    await line(DOCS.c3, upsilon.id, 1, 3000, null);
    await doc(DOCS.c4, pc.id, 'CREDIT_NOTE', 'PROV-AV-FICTIF-0004', '2026-10-23', 2500, DOCS.d3, '2026-10-23T10:00:00');
    await line(DOCS.c4, phi.id, 1, 2500, null);
    before = await snapshot();
    // Puis la migration des paiements, seule.
    cpSync(join(PRISMA, 'migrations', G5D2), join(dir, 'migrations', G5D2), { recursive: true });
    deploy();
    first = await imputed();
  }, 240000);

  afterAll(async () => {
    await db.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it('aucune donnée existante n’est modifiée ; aucun paiement ni moyen de paiement ; les avoirs déjà émis sont seulement imputés (choix 1 A), celui d’un groupe attend', async () => {
    unchanged(before, await snapshot(), { platform_audit_logs: 1 });
    for (const t of ['billing_payment_means', 'billing_payments', 'billing_refunds', 'billing_credit_transfers']) {
      expect([t, await db.$queryRawUnsafe(`SELECT count(*)::int AS n FROM ${t}`)]).toEqual([t, [{ n: 0 }]]);
    }
    // Tau : avoir partiel imputé sur le document qu'il corrige ; Upsilon : avoir total, puis un avoir au-delà devenu crédit ;
    // l'avoir du document du groupe Phi-Chi n'est pas imputé (D-G5-19 et D-G5-32).
    expect(first).toEqual({
      allocations: [
        { doc: DOCS.d2, source: 'CREDIT_NOTE', note: DOCS.c2, amount: 40000 },
        { doc: DOCS.d1, source: 'CREDIT_NOTE', note: DOCS.c1, amount: 5000 },
      ],
      entries: [{ tenant: SCHOOLS[1].id, kind: 'CREDIT_NOTE_SURPLUS', amount: 3000, doc: DOCS.c3, data: { reference: 'PROV-AV-FICTIF-0003' } }],
    });
    expect(await db.$queryRaw`SELECT action, data FROM platform_audit_logs WHERE data->>'source' = 'migration paiements_g5d2'`).toEqual([
      { action: 'billing.credit_notes_imputed', data: { source: 'migration paiements_g5d2', creditNotes: 4, imputed: 3, awaitingGroupDecision: 1, creditLeft: 3000 } },
    ]);
    expect(await db.$queryRaw`SELECT count(*)::int AS n FROM _prisma_migrations WHERE migration_name = ${G5D2} AND finished_at IS NOT NULL`).toEqual([{ n: 1 }]);
    // Ce que lit chaque école par ses fonctions : son reste à payer et son crédit ; rien pour l'école d'un groupe ; aucun moyen de paiement.
    const [tau, upsilon, phi] = SCHOOLS;
    expect(await inSchool(tau.id, (tx) => tx.$queryRaw`SELECT * FROM current_tenant_billing_balances()`)).toEqual([
      { document_id: DOCS.d1, total: 40000, credited: 5000, paid: 0, balance: 35000 },
    ]);
    expect(await inSchool(upsilon.id, (tx) => tx.$queryRaw`SELECT * FROM current_tenant_billing_balances()`)).toEqual([
      { document_id: DOCS.d2, total: 40000, credited: 40000, paid: 0, balance: 0 },
    ]);
    expect(await inSchool(upsilon.id, (tx) => tx.$queryRaw`SELECT kind, amount, currency, receipt_number, document_reference FROM current_tenant_billing_credit_entries()`)).toEqual([
      { kind: 'CREDIT_NOTE_SURPLUS', amount: 3000, currency: 'XOF', receipt_number: null, document_reference: 'PROV-AV-FICTIF-0003' },
    ]);
    for (const s of SCHOOLS) {
      expect(await inSchool(s.id, (tx) => tx.$queryRaw`SELECT * FROM current_tenant_payment_means(DATE '2026-11-22')`)).toEqual([]);
      expect(await inSchool(s.id, (tx) => tx.$queryRaw`SELECT * FROM current_tenant_billing_payments()`)).toEqual([]);
      expect(await inSchool(s.id, (tx) => tx.$queryRaw`SELECT * FROM current_tenant_billing_refunds()`)).toEqual([]);
    }
    expect(await inSchool(phi.id, (tx) => tx.$queryRaw`SELECT * FROM current_tenant_billing_balances()`)).toEqual([]);
    // Le document qui a ouvert le délai de grâce de Tau (choix 2 A) : celui de la fin de son essai.
    expect(await db.$queryRaw`SELECT * FROM billing_grace_document(${tau.id}::uuid)`).toEqual([{ document_id: DOCS.d1, reference: 'PROV-FICTIF-0001', balance: 35000 }]);
    expect(await db.$queryRaw`SELECT billing_credit_balance(${upsilon.id}::uuid) AS credit, billing_credit_reserved(${upsilon.id}::uuid) AS reserved`).toEqual([{ credit: 3000, reserved: 0 }]);
  });

  it('Row Level Security forcée ; plateforme en lecture seule, écritures par ses fonctions ; écoles par leurs fonctions ; groupes et statistiques sans droit ; ajout seul', async () => {
    expect(await db.$queryRaw`
      SELECT c.relname AS t, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             (SELECT string_agg(p.policyname, ',' ORDER BY p.policyname) FROM pg_policies p WHERE p.tablename = c.relname) AS policies
      FROM pg_class c WHERE c.relname = ANY(${TABLES}) AND c.relkind = 'r' ORDER BY 1`).toEqual(
      TABLES.map((t) => ({ t, rls: true, forced: true, policies: `${t}_owner_all,${t}_platform_all` })),
    );
    const rights = await db.$queryRaw<{ role: string; t: string; sel: boolean; ins: boolean; upd: boolean; del: boolean; trunc: boolean }[]>`
      SELECT r AS role, t, has_table_privilege(r, t, 'SELECT') AS sel, has_table_privilege(r, t, 'INSERT') AS ins, has_table_privilege(r, t, 'UPDATE') AS upd,
             has_table_privilege(r, t, 'DELETE') AS del, has_table_privilege(r, t, 'TRUNCATE') AS trunc
      FROM unnest(ARRAY['erp_app', 'erp_group', 'erp_stats', 'erp_platform']) AS r, unnest(${TABLES}::text[]) AS t ORDER BY 1, 2`;
    expect(rights.filter((x) => x.sel || x.ins || x.upd || x.del || x.trunc).map((x) => `${x.role}:${x.t}:${[x.sel, x.ins, x.upd, x.del, x.trunc].map(Number).join('')}`)).toEqual(
      TABLES.map((t) => `erp_platform:${t}:10000`),
    );
    const fns = await db.$queryRaw<{ role: string; fn: string; ok: boolean }[]>`
      SELECT r AS role, p.proname AS fn, has_function_privilege(r, p.oid, 'EXECUTE') AS ok
      FROM unnest(ARRAY['erp_app', 'erp_group', 'erp_stats', 'erp_platform']) AS r, pg_proc p
      WHERE p.proname = ANY(${FUNCTIONS}) ORDER BY 1, 2`;
    expect(fns.filter((f) => f.ok).map((f) => `${f.role}:${f.fn}`)).toEqual([
      'erp_app:current_tenant_billing_balances', 'erp_app:current_tenant_billing_credit_entries', 'erp_app:current_tenant_billing_payments',
      'erp_app:current_tenant_billing_refunds', 'erp_app:current_tenant_payment_means', 'erp_app:request_billing_refund',
      'erp_platform:add_billing_payment_means', 'erp_platform:apply_billing_credit', 'erp_platform:billing_credit_balance', 'erp_platform:billing_credit_reserved',
      'erp_platform:billing_grace_document', 'erp_platform:billing_payable_documents', 'erp_platform:billing_plan_allocations', 'erp_platform:cancel_billing_payment',
      'erp_platform:decide_billing_refund', 'erp_platform:impute_billing_credit_note', 'erp_platform:record_billing_payment', 'erp_platform:transfer_billing_credit',
    ]);
    const triggers = await db.$queryRaw<{ t: string; name: string }[]>`
      SELECT tgrelid::regclass::text AS t, tgname AS name FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text = ANY(${TABLES}) ORDER BY 1, 2`;
    expect(triggers.map((x) => `${x.t}:${x.name}`)).toEqual([
      'billing_allocations:billing_allocations_append_only', 'billing_allocations:billing_allocations_no_truncate', 'billing_allocations:same_tenant_refs',
      'billing_credit_entries:billing_credit_entries_append_only', 'billing_credit_entries:billing_credit_entries_no_truncate', 'billing_credit_entries:same_tenant_refs',
      'billing_credit_transfers:billing_credit_transfers_append_only', 'billing_credit_transfers:billing_credit_transfers_no_truncate',
      'billing_payment_means:billing_payment_means_append_only', 'billing_payment_means:billing_payment_means_no_truncate',
      'billing_payments:billing_payments_guard', 'billing_payments:billing_payments_no_delete', 'billing_payments:billing_payments_no_truncate',
      'billing_refunds:billing_refunds_guard', 'billing_refunds:billing_refunds_no_delete', 'billing_refunds:billing_refunds_no_truncate',
    ]);
    // Même le propriétaire de la base ne modifie ni n'efface une imputation ou une écriture de crédit (test 24).
    await expect(db.$executeRawUnsafe(`UPDATE billing_allocations SET amount = amount + 1`)).rejects.toThrow();
    await expect(db.$executeRawUnsafe(`DELETE FROM billing_credit_entries`)).rejects.toThrow();
    await expect(db.$executeRawUnsafe(`TRUNCATE billing_allocations, billing_credit_entries`)).rejects.toThrow();
    // Un avoir ne s'impute qu'une fois.
    await expect(db.$queryRaw`SELECT * FROM impute_billing_credit_note(${DOCS.c1}::uuid)`).rejects.toThrow(/cet avoir est déjà imputé/);
  });

  it('retour arrière : refusé dès qu’un paiement existe, sauf forçage ; il retire le lot sans toucher au reste, puis la migration se rejoue à l’identique', async () => {
    const script = join(PRISMA, 'retour-arriere', `${G5D2}.sql`);
    const rollback = (force = false) =>
      execSync(`psql "${URL}" -v ON_ERROR_STOP=1 -q -f ${script}`, { env: { ...process.env, PGOPTIONS: force ? '-c cahiora.forcer_retour=oui' : '' }, stdio: 'pipe' });
    const exists = async () => (await db.$queryRaw<{ t: string | null }[]>`SELECT to_regclass('public.billing_payments')::text AS t`)[0].t;
    // Un moyen de paiement fictif et un paiement fictif de Tau, par les fonctions de la plateforme.
    const [tau] = SCHOOLS;
    await db.$queryRaw`SELECT * FROM add_billing_payment_means('VIREMENT_FICTIF', true, 'Virement fictif', 'Coordonnées fictives du test de la migration', 'XOF', true,
      DATE '2026-11-20', 'Essai fictif de la migration', NULL, 'Super Admin fictif', DATE '2026-11-20')`;
    expect(await db.$queryRaw`SELECT receipt_number, expected, allocated, credit FROM record_billing_payment(${tau.id}::uuid, ${DOCS.d1}::uuid, 10000, DATE '2026-11-21',
      'VIREMENT_FICTIF', 'REF FICTIVE 001', 'fictif/paiements/preuve.pdf', 'application/pdf', NULL, NULL, 'Super Admin fictif', NULL, DATE '2026-11-22')`).toEqual([
      { receipt_number: 'PROV-REC-000001', expected: 35000, allocated: 10000, credit: 0 },
    ]);
    let refused = '';
    try {
      rollback();
    } catch (e) {
      refused = String((e as { stderr?: Buffer }).stderr ?? e);
    }
    expect(refused).toMatch(/Retour arrière arrêté, rien n'a été changé : 1 version\(s\) de moyen de paiement, 1 paiement\(s\) enregistré\(s\), 0 demande\(s\) de remboursement, 0 transfert\(s\) de crédit, 0 écriture\(s\) de crédit/);
    expect(await exists()).toBe('billing_payments');
    // Forcé en connaissance de cause : tout le lot part ; le reste de la base ne bouge pas.
    rollback(true);
    expect(await exists()).toBeNull();
    expect(await db.$queryRaw`SELECT relname FROM pg_class WHERE relname = ANY(${TABLES})`).toEqual([]);
    expect(await db.$queryRaw`SELECT proname FROM pg_proc WHERE proname = ANY(${[...FUNCTIONS, 'grant_platform_payments_role', 'billing_payments_guard', 'billing_refunds_guard']})`).toEqual([]);
    expect(await db.$queryRaw`SELECT typname FROM pg_type WHERE typname IN ('BillingAllocationSource', 'BillingCreditEntryKind', 'BillingRefundStatus')`).toEqual([]);
    expect(await db.$queryRaw`SELECT 1 FROM _prisma_migrations WHERE migration_name = ${G5D2}`).toEqual([]);
    unchanged(before, await snapshot(), { platform_audit_logs: 1 });
    for (const t of APPEND_ONLY) expect(await db.$queryRawUnsafe(`SELECT count(*)::int AS n FROM ${t}`)).not.toEqual([{ n: 0 }]);
    // Une nouvelle mise à jour rejoue la migration : mêmes imputations ; sans donnée du lot, le retour arrière passe sans forçage.
    deploy();
    expect(await exists()).toBe('billing_payments');
    expect(await imputed()).toEqual(first);
    unchanged(before, await snapshot(), { platform_audit_logs: 2 });
    rollback();
    expect(await exists()).toBeNull();
    deploy();
    expect(await exists()).toBe('billing_payments');
    expect(await imputed()).toEqual(first);
    expect(await db.$queryRaw`SELECT has_table_privilege('erp_platform', 'billing_payments', 'SELECT') AS ok`).toEqual([{ ok: true }]);
  });
});
