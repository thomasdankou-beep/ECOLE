import type { Prisma } from '@prisma/client';

/** Super Admin qui agit (adresse IP pour le journal de la plateforme seulement). */
export type PlatformActor = { id: string; name: string; ip?: string | null };

/**
 * Journal d'un groupe scolaire (lot G1), en ajout seul. Le promoteur y lira plus tard ce que Cahiora a fait sur
 * son groupe : jamais l'adresse IP du Super Admin (elle reste dans le journal de la plateforme), jamais les notes
 * internes ni le motif, ni le nom d'un autre groupe client.
 */
export function groupLog(tx: Prisma.TransactionClient, actor: PlatformActor, entries: { groupId: string; action: string; data?: Record<string, unknown> }[]) {
  return tx.groupAuditLog.createMany({
    data: entries.map((e) => ({ groupId: e.groupId, actorKind: 'platform', actorId: actor.id, actorName: `Super Admin Cahiora (${actor.name})`, action: e.action, data: (e.data ?? undefined) as Prisma.InputJsonValue | undefined })),
  });
}

/** Journal de la plateforme, dans la même transaction que l'action. */
export function platformLog(tx: Prisma.TransactionClient, actor: PlatformActor, action: string, tenantId: string | null, data?: Record<string, unknown>) {
  return tx.platformAuditLog.create({ data: { adminId: actor.id, action, tenantId, data: (data ?? undefined) as Prisma.InputJsonValue | undefined, ip: actor.ip ?? null } });
}

/**
 * Journal de l'école, dans la même transaction (SEC-010) : l'école courante est fixée pour la Row Level Security.
 * createMany : la plateforme peut écrire dans ce journal mais pas le relire.
 */
export async function schoolLogInTx(tx: Prisma.TransactionClient, actor: PlatformActor, tenantId: string, action: string, data?: Record<string, unknown>) {
  await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
  await tx.auditLog.createMany({
    data: [{ tenantId, userId: null, userName: `Super Admin de la plateforme (${actor.name})`, action, entity: 'Tenant', entityId: tenantId, data: (data ?? undefined) as Prisma.InputJsonValue | undefined }],
  });
}
