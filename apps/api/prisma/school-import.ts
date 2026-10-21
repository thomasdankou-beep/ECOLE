/**
 * Charge le fichier de données d'une école (niveaux, filières, frais, coordonnées, textes publics) dans son espace.
 * Usage : npm run school:import -- <identifiant-ecole> <fichier.json>
 * N'efface rien ; tout reste modifiable ensuite dans l'application.
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { applySchoolData, SchoolData } from '../src/modules/settings/school-data';

async function main() {
  const [slug, file] = process.argv.slice(2);
  if (!slug || !file) {
    console.error('Usage : npm run school:import -- <identifiant-ecole> <fichier.json>');
    process.exit(1);
  }
  const data = JSON.parse(readFileSync(file, 'utf8')) as SchoolData;
  const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL } } });
  const tenant = await db.tenant.findUnique({ where: { slug } });
  if (!tenant) throw new Error(`Aucune école « ${slug} »`);
  const counts = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;
    const c = await applySchoolData(tx, tenant.id, data);
    await tx.auditLog.create({ data: { tenantId: tenant.id, action: 'school_data.imported', entity: 'Tenant', entityId: tenant.id, data: { file, ...c } } });
    return c;
  }, { timeout: 60000 });
  await db.$disconnect();
  console.log(`${tenant.name} : ${counts.levels} niveaux, ${counts.tracks} filières, ${counts.sites} sites, ${counts.fees} frais chargés.`);
  for (const u of data.unresolved ?? []) console.log(`À préciser : ${u}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
