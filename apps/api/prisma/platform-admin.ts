/**
 * Crée un compte Super Admin de la plateforme, ou le récupère (téléphone et codes de secours perdus).
 *
 * Création :      npm run platform:admin -- <e-mail> "<Nom complet>"
 * Récupération :  npm run platform:admin -- <e-mail> --operateur "<qui lance la commande>" --motif "<pourquoi>"
 *
 * La récupération est la procédure exceptionnelle du Super Admin : elle n'existe que sur le serveur (accès hPanel),
 * jamais sur le site. Elle remet un mot de passe provisoire, retire l'ancienne double authentification et les anciens
 * codes de secours, coupe les sessions, et impose une nouvelle double authentification avant tout autre écran.
 * Le nom de l'opérateur et le motif sont obligatoires et inscrits au journal de la plateforme.
 * Le mot de passe provisoire est affiché une seule fois ; il doit être changé à la première connexion.
 */
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';
import { hostname } from 'os';

function parse(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      flags[a.slice(2)] = (argv[i + 1] ?? '').trim();
      i++;
    } else positional.push(a);
  }
  return { positional, flags };
}

async function main() {
  const { positional, flags } = parse(process.argv.slice(2));
  const [email, ...nameParts] = positional;
  const name = nameParts.join(' ').trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error('Création :     npm run platform:admin -- <e-mail> "<Nom complet>"');
    console.error('Récupération : npm run platform:admin -- <e-mail> --operateur "<votre nom>" --motif "<pourquoi>"');
    process.exit(1);
  }
  const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL } } });
  const key = email.trim().toLowerCase();
  const existing = await db.platformAdmin.findUnique({ where: { email: key } });
  if (!existing && !name) {
    console.error('Indiquez le nom complet pour un nouveau compte.');
    process.exit(1);
  }
  const operator = flags.operateur ?? '';
  const reason = flags.motif ?? '';
  if (existing && (operator.length < 3 || reason.length < 5)) {
    console.error('Ce compte existe : récupération exceptionnelle.');
    console.error('Indiquez qui lance la commande et pourquoi, par exemple :');
    console.error(`  npm run platform:admin -- ${key} --operateur "Prénom Nom" --motif "Téléphone volé le 12/11, codes de secours perdus"`);
    process.exit(1);
  }
  const password = randomBytes(12).toString('base64url');
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const admin = existing
    ? await db.$transaction(async (tx) => {
      await tx.platformRecoveryCode.deleteMany({ where: { adminId: existing.id } });
      return tx.platformAdmin.update({
        where: { id: existing.id },
        data: {
          passwordHash, active: true, failedLogins: 0, lockedUntil: null, mustChangePassword: true, passwordChangedAt: new Date(),
          totpEnabled: false, totpSecret: null, totpLastStep: null, mustSetupTwoFactor: true, sessionsRevokedAt: new Date(), ...(name ? { name } : {}),
        },
      });
    })
    : await db.platformAdmin.create({ data: { email: key, name, passwordHash } });
  await db.platformAuditLog.create({
    data: {
      adminId: admin.id, action: existing ? 'platform.admin.reset_cli' : 'platform.admin.created_cli',
      data: existing ? { operator, reason, host: hostname() } : undefined,
    },
  });
  const others = await db.platformAdmin.count({ where: { active: true, id: { not: admin.id } } });
  await db.$disconnect();
  if (existing) {
    console.log(`Récupération exceptionnelle de ${admin.name} <${admin.email}> enregistrée au journal (opérateur : ${operator}).`);
    console.log('Anciennes sessions coupées, ancienne double authentification et anciens codes de secours retirés.');
    console.log(`Mot de passe provisoire (affiché une seule fois) : ${password}`);
    console.log('À la connexion : nouveau mot de passe, puis nouvelle double authentification et nouveaux codes de secours, obligatoires.');
    if (others === 0) console.log("Attention : c'est le seul compte Super Admin actif. Créez-en un second, confié à une personne de confiance.");
  } else {
    console.log(`Compte créé pour ${admin.name} <${admin.email}>`);
    console.log(`Mot de passe provisoire (affiché une seule fois) : ${password}`);
  }
  console.log('Connexion : /plateforme/connexion');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
