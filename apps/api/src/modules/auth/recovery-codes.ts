import { createHash, createHmac, randomInt } from 'crypto';
import { config } from '../../config';

/**
 * Codes de récupération de la double authentification.
 * 10 caractères tirés d'un alphabet de 31 signes sans les caractères faciles à confondre (0, O, 1, I, L),
 * affichés en deux blocs (K7MQ4-T9XWR). Le code n'est jamais enregistré : seule son empreinte HMAC-SHA256,
 * avec une clé tirée de APP_ENCRYPTION_KEY, est gardée. Une copie de la base ne permet pas de les retrouver.
 */
export const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 10;

/** Code de réactivation remis en main propre après une récupération validée : 8 caractères, même alphabet. */
const ACTIVATION_LENGTH = 8;

function randomCode(length: number) {
  let out = '';
  for (let i = 0; i < length; i++) out += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
  return out;
}

/** Forme affichée : deux blocs séparés par un tiret. */
export function formatCode(raw: string) {
  const half = Math.ceil(raw.length / 2);
  return `${raw.slice(0, half)}-${raw.slice(half)}`;
}

/** Saisie tolérante : minuscules, espaces et tirets acceptés. */
export function normalizeCode(input: string) {
  return input.toUpperCase().replace(/[\s-]/g, '');
}

let hmacKey: Buffer | null = null;
function key() {
  if (!hmacKey) hmacKey = createHash('sha256').update('cahiora:recovery-codes:').update(Buffer.from(config.encryptionKey, 'base64')).digest();
  return hmacKey;
}

/** Empreinte d'un code (saisi ou généré) ; « purpose » sépare les codes de secours des codes de réactivation. */
export function hashCode(input: string, purpose: 'recovery' | 'activation' = 'recovery') {
  return createHmac('sha256', key()).update(`${purpose}:${normalizeCode(input)}`).digest('hex');
}

/** Génère n codes distincts : renvoie leur forme affichée (une seule fois) et leurs empreintes. */
export function generateRecoveryCodes(n = config.security.recoveryCodesCount) {
  const raw = new Set<string>();
  while (raw.size < n) raw.add(randomCode(CODE_LENGTH));
  const codes = [...raw].map(formatCode);
  return { codes, hashes: codes.map((c) => hashCode(c)) };
}

export function generateActivationCode() {
  const code = formatCode(randomCode(ACTIVATION_LENGTH));
  return { code, hash: hashCode(code, 'activation') };
}

/** Format plausible d'un code de secours (évite tout calcul sur une saisie fantaisiste). */
export function looksLikeRecoveryCode(input: string) {
  const c = normalizeCode(input);
  return c.length === CODE_LENGTH && [...c].every((ch) => RECOVERY_ALPHABET.includes(ch));
}

export function looksLikeActivationCode(input: string) {
  const c = normalizeCode(input);
  return c.length === ACTIVATION_LENGTH && [...c].every((ch) => RECOVERY_ALPHABET.includes(ch));
}
