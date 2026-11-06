import { demoSeedRefusal, isDemoTenant } from './demo-seed-guard';

describe('Garde-fou du jeu de démonstration (SEC-038)', () => {
  const real = { slug: 'saint-kisito', settings: { email: 'ecole@exemple.bj' } };
  const demo = { slug: 'saint-kisito', settings: { demo: true } };

  it("ne reconnaît comme démonstration que l'école marquée demo = true", () => {
    expect(isDemoTenant(demo)).toBe(true);
    expect(isDemoTenant(real)).toBe(false);
    expect(isDemoTenant({ slug: 'x', settings: { demo: 'true' } })).toBe(false);
    expect(isDemoTenant({ slug: 'x', settings: null })).toBe(false);
    expect(isDemoTenant(null)).toBe(false);
  });

  it("refuse toujours d'effacer une vraie école, même avec ALLOW_DEMO_RESET=1", () => {
    expect(demoSeedRefusal(real, {})).toMatch(/vraies données/);
    expect(demoSeedRefusal(real, { ALLOW_DEMO_RESET: '1' })).toMatch(/vraies données/);
    expect(demoSeedRefusal(real, { PRODUCTION_SERVER: 'true', ALLOW_DEMO_RESET: '1' })).toMatch(/vraies données/);
  });

  it('refuse sur un serveur de production sauf autorisation explicite', () => {
    expect(demoSeedRefusal(null, { PRODUCTION_SERVER: 'true' })).toMatch(/production/);
    expect(demoSeedRefusal(demo, { PRODUCTION_SERVER: 'true' })).toMatch(/production/);
    expect(demoSeedRefusal(demo, { PRODUCTION_SERVER: 'true', ALLOW_DEMO_RESET: 'oui' })).toMatch(/production/);
    expect(demoSeedRefusal(demo, { PRODUCTION_SERVER: 'true', ALLOW_DEMO_RESET: '1' })).toBeNull();
  });

  it("laisse recharger la démonstration ailleurs (poste, Codespace, tests)", () => {
    expect(demoSeedRefusal(null, {})).toBeNull();
    expect(demoSeedRefusal(demo, {})).toBeNull();
    expect(demoSeedRefusal(demo, { PRODUCTION_SERVER: 'false' })).toBeNull();
  });
});
