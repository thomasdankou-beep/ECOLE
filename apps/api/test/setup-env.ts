// Les tests de bout en bout tournent sur une base dédiée (erp_test), jamais sur la base de démonstration.
import { readFileSync } from 'fs';
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
process.env.STORAGE_DIR = '/tmp/erp-test-storage';
process.env.DEFAULT_TENANT = 'saint-kisito';
