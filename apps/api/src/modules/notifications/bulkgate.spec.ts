import { Logger } from '@nestjs/common';
import { BulkGateSmsProvider, createSmsProvider, schoolSender, sendQuietly } from './sms.provider';

type Call = { url: string; body: any };

function fakeHttp(responses: Array<{ status: number; json: unknown } | Error>) {
  const calls: Call[] = [];
  const http = async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const r = responses.shift()!;
    if (r instanceof Error) throw r;
    return { status: r.status, json: async () => r.json };
  };
  return { http, calls };
}

const ok = { status: 200, json: { data: { status: 'accepted', sms_id: 'tmp1', part_id: ['tmp1'], number: '2290197000001' } } };

describe('SMS BulkGate (Côte d’Ivoire, Bénin)', () => {
  it("envoie au format international sans « + », avec le nom d'expéditeur de l'école", async () => {
    const { http, calls } = fakeHttp([ok]);
    await new BulkGateSmsProvider('451', 'jeton', 'CAHIORA', http as any).send('+229 01 97 00 00 01', 'Le 28/09/2026 un paiement de 70 000 a été effectué', { sender: 'ST KISITO' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://portal.bulkgate.com/api/1.0/simple/transactional');
    expect(calls[0].body).toEqual({
      application_id: '451', application_token: 'jeton', number: '2290197000001', text: 'Le 28/09/2026 un paiement de 70 000 a été effectué',
      unicode: false, sender_id: 'gText', sender_id_value: 'ST KISITO',
    });
  });

  it("prend le nom de la plateforme, sinon un numéro système, et passe en Unicode seulement si besoin", async () => {
    const { http, calls } = fakeHttp([ok, ok]);
    await new BulkGateSmsProvider('451', 'jeton', 'CAHIORA', http as any).send('+2250707000000', 'Fête', { sender: null });
    await new BulkGateSmsProvider('451', 'jeton', null, http as any).send('+2250707000000', 'Bonjour', { sender: 'nom beaucoup trop long' });
    expect(calls[0].body).toMatchObject({ number: '2250707000000', unicode: true, sender_id: 'gText', sender_id_value: 'CAHIORA' });
    expect(calls[1].body).toMatchObject({ unicode: false, sender_id: 'gSystem' });
    expect(calls[1].body.sender_id_value).toBeUndefined();
  });

  it('reprend une fois sur le serveur de secours si BulkGate est injoignable', async () => {
    const { http, calls } = fakeHttp([new Error('ETIMEDOUT'), ok]);
    await new BulkGateSmsProvider('451', 'jeton', null, http as any).send('+2290197000001', 'Test');
    expect(calls.map((c) => c.url)).toEqual(['https://portal.bulkgate.com/api/1.0/simple/transactional', 'https://backup1.bulkgate.com/api/1.0/simple/transactional']);
  });

  it('remonte le refus de BulkGate sans réessayer', async () => {
    const { http, calls } = fakeHttp([{ status: 400, json: { type: 'invalid_phone_number', code: 400, error: 'Invalid phone number', detail: null } }]);
    await expect(new BulkGateSmsProvider('451', 'jeton', null, http as any).send('+2290197000001', 'Test')).rejects.toThrow('BulkGate 400 : Invalid phone number (invalid_phone_number)');
    expect(calls).toHaveLength(1);
  });

  it('refuse de démarrer sans identifiants', () => {
    expect(() => createSmsProvider('bulkgate', {})).toThrow(/BULKGATE_APPLICATION_ID/);
    expect(() => createSmsProvider('inconnu')).toThrow(/console.*bulkgate/);
  });

  it("un échec d'envoi ne fait pas échouer l'action, et le journal ne montre ni le texte ni le numéro complet", async () => {
    const lines: string[] = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation((m: any) => { lines.push(String(m)); });
    const { http } = fakeHttp([{ status: 401, json: { type: 'unknown_identity', code: 401, error: 'Unknown identity', detail: null } }]);
    const sent = await sendQuietly(new BulkGateSmsProvider('451', 'jeton', null, http as any), '+2290197000001', 'mot de passe Xy7-secret', { smsSender: 'ST KISITO' });
    expect(sent).toBe(false);
    expect(lines.join('\n')).not.toMatch(/Xy7-secret|2290197000001/);
    jest.restoreAllMocks();
  });

  it("lit le nom d'expéditeur de l'école seulement s'il est valable", () => {
    expect(schoolSender({ smsSender: 'ST KISITO' })).toBe('ST KISITO');
    expect(schoolSender({ smsSender: 'Saint-Kisito-GESA' })).toBeNull();
    expect(schoolSender(null)).toBeNull();
  });
});
