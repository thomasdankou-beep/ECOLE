import { Prisma } from '@prisma/client';
import { PlatformDb } from '../platform/platform';

/**
 * Outils des tâches planifiées de la facturation (lots G5a et G5b) : clé unique de chaque tâche, journaux et
 * notifications de la direction au nom de la tâche. Partagés par BillingJobsService et CountsService.
 */

export const SYSTEM = 'Cahiora (tâche planifiée)';

/** Tâche déjà faite (par un autre passage ou un autre serveur) : la transaction est annulée sans effet. */
export class AlreadyDone extends Error {}

/**
 * Effet et clé de la tâche dans une seule transaction ; false si la tâche était déjà faite. La clé unique de
 * billing_jobs garantit qu'une tâche relancée, interrompue ou lancée deux fois en même temps ne produit aucun doublon.
 */
export async function jobOnce(db: PlatformDb, key: string, kind: string, tenantId: string, dueDate: string, effect: (tx: Prisma.TransactionClient) => Promise<void>) {
  if (await db.billingJob.findUnique({ where: { key }, select: { id: true } })) return false;
  try {
    await db.$transaction(async (tx) => {
      await effect(tx);
      const rows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO billing_jobs (id, key, kind, tenant_id, "dueDate", "createdAt")
        VALUES (gen_random_uuid(), ${key}, ${kind}, ${tenantId}::uuid, ${dueDate}::date, timezone('UTC', now()))
        ON CONFLICT (key) DO NOTHING RETURNING id`;
      if (!rows.length) throw new AlreadyDone();
    }, { timeout: 60000 });
    return true;
  } catch (e) {
    if (e instanceof AlreadyDone) return false;
    throw e;
  }
}

/** Journaux de la plateforme, du groupe et de l'établissement, au nom de la tâche planifiée. */
export async function systemJournals(
  tx: Prisma.TransactionClient, t: { id: string; name: string; groupId: string }, entity: string, entityId: string | null, action: string, data: Record<string, unknown>,
) {
  await tx.platformAuditLog.create({ data: { adminId: null, action, tenantId: t.id, data: data as Prisma.InputJsonValue } });
  await tx.groupAuditLog.create({ data: { groupId: t.groupId, actorKind: 'system', actorName: SYSTEM, action, data: { tenantName: t.name, ...data } as Prisma.InputJsonValue } });
  await tx.$executeRaw`SELECT set_config('app.tenant_id', ${t.id}, true)`;
  await tx.auditLog.createMany({ data: [{ tenantId: t.id, userId: null, userName: SYSTEM, action, entity, entityId, data: data as Prisma.InputJsonValue }] });
}

/** Notification dans l'application pour chaque compte Direction actif de l'établissement (aucun SMS). */
export async function notifyDirection(tx: Prisma.TransactionClient, tenantId: string, kind: string, title: string, body: string) {
  await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
  const roles = await tx.userRole.findMany({ where: { role: 'DIRECTION', user: { status: 'ACTIVE' } }, select: { userId: true } });
  const ids = [...new Set(roles.map((r) => r.userId))];
  if (ids.length) {
    await tx.notification.createMany({ data: ids.map((userId) => ({ tenantId, userId, channel: 'IN_APP' as const, kind, title, body, status: 'SENT' as const, sentAt: new Date() })) });
  }
}
