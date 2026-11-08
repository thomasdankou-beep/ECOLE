import { formatCode, generateActivationCode, generateRecoveryCodes, hashCode, looksLikeActivationCode, looksLikeRecoveryCode, normalizeCode, RECOVERY_ALPHABET } from './recovery-codes';

describe('Codes de récupération de la double authentification', () => {
  it('10 codes distincts par défaut, en deux blocs, sans caractères ambigus', () => {
    const { codes, hashes } = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) {
      expect(c).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
      expect(c).not.toMatch(/[01OIL]/);
      expect(looksLikeRecoveryCode(c)).toBe(true);
    }
    expect(hashes).toEqual(codes.map((c) => hashCode(c)));
    expect(RECOVERY_ALPHABET).toHaveLength(31);
  });

  it("l'empreinte ne contient pas le code et ne dépend pas de la façon de le taper", () => {
    const [c] = generateRecoveryCodes(5).codes;
    const h = hashCode(c);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(normalizeCode(c).toLowerCase());
    expect(hashCode(c.toLowerCase().replace('-', ' '))).toBe(h);
  });

  it('un code de secours et un code de réactivation identiques ont des empreintes différentes', () => {
    expect(hashCode('ABCD-EFGH', 'recovery')).not.toBe(hashCode('ABCD-EFGH', 'activation'));
  });

  it('code de réactivation : 8 caractères, format vérifié avant tout calcul', () => {
    const { code, hash } = generateActivationCode();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(hash).toBe(hashCode(code, 'activation'));
    expect(looksLikeActivationCode(code)).toBe(true);
    expect(looksLikeRecoveryCode(code)).toBe(false);
    expect(looksLikeRecoveryCode('AAAAA-0OOOO')).toBe(false);
    expect(formatCode('ABCDEFGHJK')).toBe('ABCDE-FGHJK');
  });
});
