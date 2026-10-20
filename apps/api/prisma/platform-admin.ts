/**
 * Crée un compte Super Admin de la plateforme, ou lui remet un mot de passe provisoire.
 * Usage : npm run platform:admin -- <e-mail> "<Nom complet>"
 * Le mot de passe provisoire est affiché une seule fois ; il doit être changé à la première connexion.
 */
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';

async function main() {
  const [email, ...nameParts] = process.argv.slice(2);
  const name = nameParts.join(' ').trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error('Usage : npm run platform:admin -- <e-mail> "<Nom complet>"');
    process.exit(1);
  }
  const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL } } });
  const password = randomBytes(12).toString('base64url');
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const key = email.trim().toLowerCase();
  const existing = await db.platformAdmin.findUnique({ where: { email: key } });
  if (!existing && !name) {
    console.error('Indiquez le nom complet pour un nouveau compte.');
    process.exit(1);
  }
  const admin = existing
    ? await db.platformAdmin.update({ where: { id: existing.id }, data: { passwordHash, active: true, failedLogins: 0, lockedUntil: null, mustChangePassword: true, passwordChangedAt: new Date(), ...(name ? { name } : {}) } })
    : await db.platformAdmin.create({ data: { email: key, name, passwordHash } });
  await db.platformAuditLog.create({ data: { adminId: admin.id, action: existing ? 'platform.admin.reset_cli' : 'platform.admin.created_cli' } });
  await db.$disconnect();
  console.log(`${existing ? 'Mot de passe remis' : 'Compte créé'} pour ${admin.name} <${admin.email}>`);
  console.log(`Mot de passe provisoire (affiché une seule fois) : ${password}`);
  console.log('Connexion : /plateforme/connexion');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
