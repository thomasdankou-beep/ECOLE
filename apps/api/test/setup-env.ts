// Les tests de bout en bout tournent sur une base dédiée (erp_test), jamais sur la base de démonstration.
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.NODE_ENV = 'test';
try {
  for (const line of readFileSync(join(__dirname, '..', '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://erp_app:erp_app_dev@localhost:5432/erp_test';
process.env.DATABASE_ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgresql://erp_owner:erp_owner_dev@localhost:5432/erp_test';
process.env.DATABASE_PLATFORM_URL = process.env.TEST_DATABASE_PLATFORM_URL ?? 'postgresql://erp_platform:erp_platform_dev@localhost:5432/erp_test';
// Rôles des groupes scolaires : erp_group sert la console des groupes (lot G2) ; erp_stats n'a encore aucun droit.
process.env.DATABASE_GROUP_URL = process.env.TEST_DATABASE_GROUP_URL ?? 'postgresql://erp_group:erp_group_dev@localhost:5432/erp_test';
process.env.DATABASE_STATS_URL = process.env.TEST_DATABASE_STATS_URL ?? 'postgresql://erp_stats:erp_stats_dev@localhost:5432/erp_test';
// Base jetable, vidée à chaque lancement, pour jouer la migration des groupes sur des écoles fictives déjà en place.
process.env.DATABASE_MIGRATION_URL = process.env.TEST_DATABASE_MIGRATION_URL ?? 'postgresql://erp_owner:erp_owner_dev@localhost:5432/erp_migration_test';
// SEC-042 : dossier neuf à chaque lancement, pour qu'aucun test ne dépende des fichiers d'un lancement précédent.
process.env.STORAGE_DIR = process.env.TEST_STORAGE_DIR ?? join(tmpdir(), `erp-test-storage-${randomUUID()}`); // créé au premier fichier, effacé à la fin (app.e2e-spec.ts)
process.env.DEFAULT_TENANT = 'saint-kisito';
