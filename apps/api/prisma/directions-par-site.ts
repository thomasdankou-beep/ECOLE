/**
 * GRP-001 : une direction couvre toujours tout l'établissement. Ce script repère, puis régularise un par un,
 * les anciens comptes Direction limités à un site, que la correction bloque tant qu'ils ne sont pas corrigés.
 *
 * Contrôle, en lecture seule (ne modifie rien) :
 *   npm run directions:sites
 *
 * Régularisation d'un compte, sur décision de l'école (opérateur et motif obligatoires, inscrits au journal de l'école) :
 *   npm run directions:sites -- --ecole <identifiant> --compte <id du compte> --tous-les-sites --operateur "Prénom Nom" --motif "..."
 *   npm run directions:sites -- --ecole <identifiant> --compte <id du compte> --retirer-direction --operateur "Prénom Nom" --motif "..."
 *
 * --tous-les-sites     : le rôle Direction couvre désormais tout l'établissement.
 * --retirer-direction  : le rôle Direction est retiré ; les autres rôles du compte restent (refusé s'il n'en a pas d'autre).
 * Dans les deux cas, les sessions du compte sont coupées : il se reconnecte avec ses nouveaux droits.
 * Quand l'école a une autre direction de tout l'établissement, elle peut faire la même chose elle-même dans Personnel.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { hostname } from 'os';

type Tx = Prisma.TransactionClient;

function parse(argv: string[]) {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[a.slice(2)] = 'oui';
    else {
      flags[a.slice(2)] = next.trim();
      i++;
    }
  }
  return flags;
}

/** Téléphone en partie masqué : assez pour reconnaître le compte, pas pour le recopier. */
const masked = (phone: string | null) => (phone ? `${phone.slice(0, -6)}••••${phone.slice(-2)}` : 'sans téléphone');

async function inTenant<T>(db: PrismaClient, tenantId: string, fn: (tx: Tx) => Promise<T>) {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}

async function check(db: PrismaClient) {
  const tenants = await db.tenant.findMany({ select: { id: true, slug: true, name: true, status: true }, orderBy: { slug: 'asc' } });
  let total = 0;
  for (const t of tenants) {
    const rows = await inTenant(db, t.id, async (tx) => {
      const limited = await tx.userRole.findMany({
        where: { role: 'DIRECTION', siteId: { not: null } },
        select: { siteId: true, user: { select: { id: true, firstName: true, lastName: true, phone: true, status: true, lastLoginAt: true, roles: { select: { role: true, siteId: true } } } } },
      });
      const sites = new Map((await tx.site.findMany({ select: { id: true, name: true } })).map((s) => [s.id, s.name]));
      const whole = await tx.user.count({ where: { status: 'ACTIVE', roles: { some: { role: 'DIRECTION', siteId: null } } } });
      return { limited, sites, whole };
    });
    // Un compte qui a aussi un rôle Direction de tout l'établissement n'est pas bloqué : on le signale sans l'exiger.
    const blocked = rows.limited.filter((r) => !r.user.roles.some((x) => x.role === 'DIRECTION' && !x.siteId));
    total += blocked.length;
    console.log(`${t.slug} (${t.name}${t.status === 'ACTIVE' ? '' : ', suspendue'}) : ${blocked.length ? `${blocked.length} compte(s) Direction limité(s) à un site` : 'aucun compte Direction limité à un site'}`);
    for (const r of rows.limited) {
      const u = r.user;
      const others = u.roles.filter((x) => x.role !== 'DIRECTION').map((x) => x.role);
      const state = blocked.includes(r) ? 'BLOQUÉ par la correction' : 'non bloqué (a aussi un rôle Direction de tout l’établissement)';
      console.log(`  - ${u.firstName} ${u.lastName} · ${masked(u.phone)} · site ${rows.sites.get(r.siteId as string) ?? 'inconnu'} · compte ${u.status === 'ACTIVE' ? 'actif' : 'désactivé'} · autres rôles : ${others.join(', ') || 'aucun'} · ${state}`);
      console.log(`    id du compte : ${u.id}`);
    }
    if (blocked.length) {
      console.log(rows.whole
        ? `  ${rows.whole} autre(s) direction(s) de tout l'établissement peuvent corriger ces comptes dans Personnel.`
        : "  Aucune autre direction de tout l'établissement : seule une régularisation par ce script débloque ces comptes.");
    }
  }
  console.log(total ? `Total : ${total} compte(s) à régulariser avant ou juste après la mise en ligne.` : 'Total : aucun compte à régulariser.');
}

async function regularise(db: PrismaClient, flags: Record<string, string>) {
  const operator = flags.operateur ?? '';
  const reason = flags.motif ?? '';
  const mode = flags['tous-les-sites'] ? 'tous-les-sites' : flags['retirer-direction'] ? 'retirer-direction' : '';
  if (!flags.ecole || !flags.compte || !mode || (flags['tous-les-sites'] && flags['retirer-direction']) || operator.length < 3 || reason.length < 5) {
    console.error('Régularisation : indiquez l’école, le compte, UNE décision, qui lance la commande et pourquoi, par exemple :');
    console.error('  npm run directions:sites -- --ecole saint-kisito --compte <id> --tous-les-sites --operateur "Prénom Nom" --motif "Décision de l’école du 12/11"');
    process.exit(1);
  }
  const tenant = await db.tenant.findUnique({ where: { slug: flags.ecole }, select: { id: true, name: true } });
  if (!tenant) {
    console.error(`École inconnue : ${flags.ecole}`);
    process.exit(1);
  }
  const result = await inTenant(db, tenant.id, async (tx) => {
    const user = await tx.user.findUnique({ where: { id: flags.compte }, include: { roles: true } });
    if (!user) return { error: 'Compte introuvable dans cette école.' };
    const limited = user.roles.filter((r) => r.role === 'DIRECTION' && r.siteId);
    if (!limited.length) return { error: 'Ce compte n’a aucun rôle Direction limité à un site : rien à régulariser.' };
    const label = (r: { role: string; siteId: string | null }) => (r.siteId ? `${r.role}@${r.siteId}` : r.role);
    const before = user.roles.map(label).sort();
    const remaining = user.roles.filter((r) => !limited.includes(r));
    if (mode === 'retirer-direction' && remaining.length === 0) {
      return { error: 'Ce compte n’aurait plus aucun rôle : utilisez --tous-les-sites, ou donnez-lui d’abord un autre rôle dans Personnel.' };
    }
    await tx.userRole.deleteMany({ where: { id: { in: limited.map((r) => r.id) } } });
    if (mode === 'tous-les-sites' && !remaining.some((r) => r.role === 'DIRECTION' && !r.siteId)) {
      await tx.userRole.create({ data: { tenantId: tenant.id, userId: user.id, role: 'DIRECTION', siteId: null } });
    }
    const after = (await tx.userRole.findMany({ where: { userId: user.id } })).map(label).sort();
    const sessions = await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.auditLog.create({
      data: {
        tenantId: tenant.id, userId: null, userName: `Opérateur de la plateforme (${operator})`, action: 'user.roles_changed', entity: 'User', entityId: user.id,
        data: { roles: { avant: before, après: after }, decision: mode, operateur: operator, motif: reason, host: hostname(), source: 'directions-par-site (GRP-001)', sessionsCoupees: sessions.count },
      },
    });
    return { name: `${user.firstName} ${user.lastName}`, before, after, sessions: sessions.count };
  });
  if ('error' in result) {
    console.error(result.error);
    process.exit(1);
  }
  console.log(`${result.name} (${tenant.name}) : rôles ${result.before.join(', ')} → ${result.after.join(', ')}.`);
  console.log(`${result.sessions} session(s) coupée(s) ; le compte se reconnecte avec ses nouveaux droits (au plus 30 secondes pour une session déjà ouverte).`);
  console.log('Changement inscrit au journal de l’école, avec l’opérateur et le motif.');
}

async function main() {
  const flags = parse(process.argv.slice(2));
  const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL } } });
  try {
    if (flags.ecole || flags.compte || flags['tous-les-sites'] || flags['retirer-direction']) await regularise(db, flags);
    else await check(db);
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
