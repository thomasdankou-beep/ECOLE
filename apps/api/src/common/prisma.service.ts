import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

export type Tx = Prisma.TransactionClient;

/**
 * Accès base de données.
 * Toute lecture ou écriture métier passe par `forTenant`, qui ouvre une transaction
 * et fixe `app.tenant_id` : la Row Level Security de PostgreSQL filtre alors chaque
 * requête sur l'établissement courant, même si le code oublie un filtre.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  forTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>, opts?: { timeout?: number }): Promise<T> {
    if (!tenantId) throw new Error('tenantId manquant');
    return this.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        return fn(tx);
      },
      { timeout: opts?.timeout ?? 15000, maxWait: 10000 },
    );
  }
}
