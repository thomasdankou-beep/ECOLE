import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Actor } from './auth';
import { Tx } from './prisma.service';

/** Journal d'audit des actions sensibles (CDC §6.1), en ajout seul. */
@Injectable()
export class AuditService {
  log(tx: Tx, actor: Actor | null, action: string, entity: string, entityId?: string | null, data?: unknown) {
    return tx.auditLog.create({
      data: {
        tenantId: actor?.tenantId ?? (data as any)?.tenantId,
        userId: actor?.userId ?? null,
        userName: actor?.name ?? 'Système',
        action,
        entity,
        entityId: entityId ?? null,
        data: (data ?? undefined) as Prisma.InputJsonValue | undefined,
        ip: actor?.ip ?? null,
      },
    });
  }
}
