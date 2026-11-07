import { country, currencyLabel, localDay, money, schoolOperators } from './country';
import { normalizePhone } from './util';

describe('Réglages par pays', () => {
  it("ajoute l'indicatif du pays de l'école aux numéros locaux", () => {
    expect(normalizePhone('01 97 00 00 01')).toBe('+2290197000001');
    expect(normalizePhone('07 07 00 00 01', '225')).toBe('+2250707000001');
    expect(normalizePhone('2250707000001', '225')).toBe('+2250707000001');
    expect(normalizePhone('+229 01 97 00 00 01', '225')).toBe('+2290197000001');
    expect(normalizePhone('00221771234567', '225')).toBe('+221771234567');
    expect(normalizePhone('77 123 45 67', '221')).toBe('+221771234567');
  });

  it("calcule la date du jour à l'heure de l'école", () => {
    // 23 h 30 à Londres = 0 h 30 le lendemain à Porto-Novo (UTC+1), toujours la veille à Abidjan (UTC+0).
    const at = new Date('2026-11-07T23:30:00Z');
    expect(localDay('Africa/Porto-Novo', at)).toBe('2026-11-08');
    expect(localDay('Africa/Abidjan', at)).toBe('2026-11-07');
    expect(localDay('Pas/UnFuseau', at)).toBe('2026-11-07');
  });

  it('affiche FCFA pour le franc CFA, sinon le code de la monnaie', () => {
    expect(currencyLabel('XOF')).toBe('FCFA');
    expect(currencyLabel('XAF')).toBe('FCFA');
    expect(money(150000, 'GNF')).toBe('150 000 GNF');
    expect(money(150000, 'XOF')).toBe('150 000 FCFA');
  });

  it("propose les opérateurs saisis par l'école, sinon seulement ceux connus pour le pays", () => {
    expect(schoolOperators({ country: 'BJ', settings: {} })).toEqual(['MTN MoMo', 'Moov Money']);
    expect(schoolOperators({ country: 'CI', settings: null })).toEqual([]);
    expect(schoolOperators({ country: 'BJ', settings: { payments: { operators: ['Celtiis Cash'] } } })).toEqual(['Celtiis Cash']);
    expect(country('ZZ').code).toBe('BJ');
  });
});
