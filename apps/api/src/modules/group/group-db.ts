import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Accès à la base de la console des groupes (lot G2), avec le rôle dédié erp_group créé au lot G1 :
 * ni propriétaire des tables, ni exempté de la Row Level Security, sans aucun droit sur les tables d'école.
 * Chaque lecture ou écriture passe par `inGroup`, qui fixe app.group_id pour la transaction : la base ne
 * montre alors que la fiche, les écoles, le journal et les comptes de ce groupe, même si le code oublie un filtre.
 *
 * DATABASE_GROUP_URL est obligatoire en production. Sur un poste de développement sans ce réglage, l'accès
 * propriétaire sert de repli (comme pour le Super Admin) : le cloisonnement en base n'y est alors pas vérifié.
 */
@Injectable()
export class GroupDb extends PrismaClient implements OnModuleDestroy {
  constructor() {
    const url = process.env.DATABASE_GROUP_URL;
    if (!url && process.env.NODE_ENV === 'production') throw new Error("Variable d'environnement manquante : DATABASE_GROUP_URL");
    // Colonnes que le rôle du groupe ne peut pas lire : jamais demandées par ce client.
    super({
      datasources: { db: { url: url || process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL } },
      omit: {
        schoolGroup: { notes: true },
        tenant: { settings: true, platformNotes: true, timezone: true, createdAt: true, updatedAt: true },
      },
    });
    if (!url) new Logger('GroupDb').warn('DATABASE_GROUP_URL absent : accès propriétaire utilisé (développement seulement)');
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /** Transaction dans la zone d'un seul groupe : celui de la session, jamais celui d'une adresse ou d'un formulaire. */
  inGroup<T>(groupId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    if (!groupId) throw new Error('groupId manquant');
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.group_id', ${groupId}, true)`;
      return fn(tx);
    }, { timeout: 15000, maxWait: 10000 });
  }

  /** Comptes qui portent cet identifiant (connexion) : seulement le numéro du compte et celui de son groupe. */
  lookup(email: string | null, phones: string[]) {
    return this.$queryRaw<{ account_id: string; group_id: string }[]>`SELECT account_id, group_id FROM group_login_lookup(${email}, ${phones}::text[])`;
  }
}
