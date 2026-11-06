/**
 * Prépare la base de test pour les tests de navigateur : un compte au mot de passe provisoire et un
 * Super Admin, avec des mots de passe connus. Refuse toute autre base que erp_test.
 */
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { PROVISOIRE, SUPER_ADMIN } from './comptes';

export default async function preparation() {
  const url = process.env.DATABASE_ADMIN_URL ?? 'postgresql://erp_owner:erp_owner_dev@localhost:5432/erp_test';
  if (!/\/erp_test(\?|$)/.test(url)) throw new Error(`Base refusée pour les tests de navigateur : ${url.replace(/\/\/[^@]*@/, '//***@')}`);
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: 'saint-kisito' } });
    if ((tenant.settings as any)?.demo !== true) throw new Error("L'école de test n'est pas l'école de démonstration");
    const hash = (p: string) => argon2.hash(p, { type: argon2.argon2id });
    const tmp = await hash(PROVISOIRE.motDePasse);
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;
      const existing = await tx.user.findFirst({ where: { phone: PROVISOIRE.identifiant } });
      const data = { passwordHash: tmp, mustChangePassword: true, failedLogins: 0, lockedUntil: null, status: 'ACTIVE' as const };
      const user = existing
        ? await tx.user.update({ where: { id: existing.id }, data })
        : await tx.user.create({ data: { tenantId: tenant.id, firstName: 'Compte', lastName: 'PROVISOIRE', phone: PROVISOIRE.identifiant, ...data } });
      await tx.userRole.deleteMany({ where: { userId: user.id } });
      await tx.userRole.create({ data: { tenantId: tenant.id, userId: user.id, role: 'SECRETARIAT' } });
    });
    const sa = { name: 'Super Admin E2E', passwordHash: await hash(SUPER_ADMIN.motDePasse), active: true, mustChangePassword: false, failedLogins: 0, lockedUntil: null, totpEnabled: false, totpSecret: null };
    await db.platformAdmin.upsert({ where: { email: SUPER_ADMIN.email }, update: sa, create: { email: SUPER_ADMIN.email, ...sa } });
  } finally {
    await db.$disconnect();
  }
}
