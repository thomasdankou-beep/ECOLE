import { createCipheriv, createDecipheriv, randomBytes, randomInt } from 'crypto';
import { config } from '../config';
import { Tx } from './prisma.service';

/** Compteur séquentiel par établissement, sans trou ni doublon (verrou de ligne). */
export async function nextNumber(tx: Tx, tenantId: string, key: string): Promise<number> {
  const rows = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO counters (tenant_id, key, value) VALUES (${tenantId}::uuid, ${key}, 1)
    ON CONFLICT (tenant_id, key) DO UPDATE SET value = counters.value + 1
    RETURNING value`;
  return rows[0].value;
}

export const pad = (n: number, len = 5) => String(n).padStart(len, '0');

/** Code de vérification imprimé dans les QR codes : non devinable, sans caractère ambigu. */
export function verifyCode(len = 12): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[randomInt(alphabet.length)];
  return s;
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function toDate(s: string | Date): Date {
  if (s instanceof Date) return s;
  const d = new Date(s.length === 10 ? `${s}T00:00:00.000Z` : s);
  if (isNaN(d.getTime())) throw new Error(`Date invalide : ${s}`);
  return d;
}

export const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export const fcfa = (n: number) => new Intl.NumberFormat('fr-FR').format(n).replace(/ | /g, ' ') + ' FCFA';

/** Chiffrement applicatif AES-256-GCM des champs sensibles (secret 2FA). */
export function encrypt(plain: string): string {
  const key = Buffer.from(config.encryptionKey, 'base64').subarray(0, 32);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

export function decrypt(payload: string): string {
  const key = Buffer.from(config.encryptionKey, 'base64').subarray(0, 32);
  const [iv, tag, enc] = payload.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

/** Normalise un numéro béninois saisi librement en +229XXXXXXXXXX. */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('00')) return '+' + digits.slice(2);
  if (digits.startsWith('229')) return '+' + digits;
  return '+229' + digits;
}

export function fullName(p: { firstName: string; lastName: string }) {
  return `${p.firstName} ${p.lastName}`;
}
