import { Logger } from '@nestjs/common';
import { ConsoleSmsProvider } from './sms.provider';

describe('SMS « console » : aucun secret dans les journaux de production (SEC-044)', () => {
  const text = 'Saint Kisito : votre mot de passe provisoire est Xy7-secret-42. Changez-le à la connexion.';
  let lines: string[];
  beforeEach(() => {
    lines = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((m: any) => { lines.push(String(m)); });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((m: any) => { lines.push(String(m)); });
  });
  afterEach(() => jest.restoreAllMocks());

  it('en production, ni le mot de passe ni le numéro complet ne sont écrits, et rien n’est gardé en mémoire', async () => {
    const p = new ConsoleSmsProvider({ NODE_ENV: 'production' });
    await p.send('+2290190000010', text);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('Xy7-secret-42');
    expect(lines[0]).not.toContain('+2290190000010');
    expect(lines[0]).toContain('+229019•••10');
    expect(lines[0]).toContain('non envoyé');
    expect(p.sent).toHaveLength(0);
  });

  it('serveur de démonstration : texte visible seulement avec SMS_CONSOLE_SHOW_TEXT=true', async () => {
    await new ConsoleSmsProvider({ NODE_ENV: 'production', SMS_CONSOLE_SHOW_TEXT: 'true' }).send('+2290190000010', text);
    expect(lines[0]).toContain('Xy7-secret-42');
  });

  it('en développement le texte reste lisible ; en test les SMS sont gardés, 500 au plus', async () => {
    await new ConsoleSmsProvider({ NODE_ENV: 'development' }).send('+2290190000010', text);
    expect(lines[0]).toContain('Xy7-secret-42');
    const t = new ConsoleSmsProvider({ NODE_ENV: 'test' });
    for (let i = 0; i < 510; i++) await t.send('+2290190000010', `n°${i}`);
    expect(t.sent).toHaveLength(500);
    expect(t.sent[0].text).toBe('n°10');
  });
});
