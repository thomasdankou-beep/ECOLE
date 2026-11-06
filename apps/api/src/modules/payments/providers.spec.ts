import { createHmac } from 'crypto';
import { config } from '../../config';
import { CinetPayProvider, createPaymentProvider, DisabledProvider, SandboxProvider } from './providers';

/** SEC-040 : on ne croit jamais un webhook sur parole. Tests sans réseau (fetch simulé). */
describe('Fournisseurs de paiement (SEC-040)', () => {
  const saved = { ...config.payments.cinetpay };
  const fields = ['cpm_site_id', 'cpm_trans_id', 'cpm_trans_date', 'cpm_amount', 'cpm_currency', 'signature', 'payment_method', 'cel_phone_num', 'cpm_phone_prefixe', 'cpm_language', 'cpm_version', 'cpm_payment_config', 'cpm_page_action', 'cpm_custom', 'cpm_designation', 'cpm_error_message'];
  const body = { cpm_site_id: '123', cpm_trans_id: 'TX-1', cpm_trans_date: '2026-11-06 10:00:00', cpm_amount: '15000', cpm_currency: 'XOF', payment_method: 'OMCIV2', cel_phone_num: '0190000000' };
  const sign = (b: Record<string, string>, key: string) => createHmac('sha256', key).update(fields.map((f) => b[f] ?? '').join('')).digest('hex');
  const realFetch = global.fetch;

  afterEach(() => {
    Object.assign(config.payments.cinetpay, saved);
    global.fetch = realFetch;
  });

  it('CinetPay : signature x-token valide acceptée, fausse, absente ou calculée sur un autre montant refusée', async () => {
    Object.assign(config.payments.cinetpay, { apiKey: 'k', siteId: '123', secretKey: 'secret-test' });
    const p = new CinetPayProvider();
    await expect(p.parseWebhook({ 'x-token': sign(body, 'secret-test') }, body)).resolves.toEqual({ transactionId: 'TX-1' });
    await expect(p.parseWebhook({ 'x-token': sign(body, 'autre-cle') }, body)).rejects.toThrow('Signature CinetPay invalide');
    await expect(p.parseWebhook({}, body)).rejects.toThrow('Signature CinetPay invalide');
    await expect(p.parseWebhook({ 'x-token': 'abc' }, body)).rejects.toThrow('Signature CinetPay invalide');
    await expect(p.parseWebhook({ 'x-token': sign(body, 'secret-test') }, { ...body, cpm_amount: '1' })).rejects.toThrow('Signature CinetPay invalide');
    await expect(p.parseWebhook({ 'x-token': sign({ ...body, cpm_trans_id: '' }, 'secret-test') }, { ...body, cpm_trans_id: '' })).rejects.toThrow('sans transaction');
  });

  it("CinetPay sans clé secrète : le webhook n'est qu'un signal, l'état est toujours redemandé à CinetPay", async () => {
    Object.assign(config.payments.cinetpay, { apiKey: 'k', siteId: '123', secretKey: '' });
    const p = new CinetPayProvider();
    await expect(p.parseWebhook({}, body)).resolves.toEqual({ transactionId: 'TX-1' });
    const calls: any[] = [];
    const reply = (status: string, amount = '15000') => {
      global.fetch = (async (url: string, init: any) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return { json: async () => ({ data: { status, amount, operator_id: 'OP-1' } }) } as any;
      }) as any;
    };
    reply('ACCEPTED');
    await expect(p.check('TX-1')).resolves.toEqual({ transactionId: 'TX-1', status: 'SUCCESS', amount: 15000, providerRef: 'OP-1' });
    expect(calls[0]).toMatchObject({ url: 'https://api-checkout.cinetpay.com/v2/payment/check', body: { apikey: 'k', site_id: '123', transaction_id: 'TX-1' } });
    reply('REFUSED');
    expect((await p.check('TX-1')).status).toBe('FAILED');
    reply('CANCELED');
    expect((await p.check('TX-1')).status).toBe('FAILED');
    reply('WAITING_FOR_CUSTOMER');
    expect((await p.check('TX-1')).status).toBe('PENDING');
  });

  it("CinetPay non configuré : refus clair, aucun appel réseau", async () => {
    Object.assign(config.payments.cinetpay, { apiKey: '', siteId: '', secretKey: '' });
    let called = false;
    global.fetch = (async () => { called = true; }) as any;
    const p = new CinetPayProvider();
    await expect(p.check('TX-1')).rejects.toThrow('CinetPay non configuré');
    await expect(p.parseWebhook({}, body)).rejects.toThrow('CinetPay non configuré');
    expect(called).toBe(false);
  });

  it('bac à sable : signature exigée, état inconnu tant que le parent n’a pas validé', async () => {
    const p = new SandboxProvider();
    const b = { transactionId: 'SBX-TEST-1' };
    await expect(p.parseWebhook({ 'x-sandbox-signature': SandboxProvider.sign(JSON.stringify(b)) }, b)).resolves.toEqual({ transactionId: 'SBX-TEST-1' });
    await expect(p.parseWebhook({ 'x-sandbox-signature': 'faux' }, b)).rejects.toThrow('Signature invalide');
    expect((await p.check('SBX-TEST-1')).status).toBe('PENDING');
    expect(SandboxProvider.decide('SBX-INCONNU', true)).toBe(false);
    await p.initiate({ transactionId: 'SBX-TEST-1', amount: 5000, currency: 'XOF', description: 'x', customerName: 'x', notifyUrl: 'x', returnUrl: 'x' });
    expect(SandboxProvider.decide('SBX-TEST-1', true)).toBe(true);
    expect(await p.check('SBX-TEST-1')).toMatchObject({ status: 'SUCCESS', amount: 5000 });
  });

  it('paiement en ligne fermé et fournisseur inconnu', async () => {
    await expect(new DisabledProvider().initiate()).rejects.toThrow('pas encore ouvert');
    await expect(new DisabledProvider().parseWebhook()).rejects.toThrow('fermé');
    expect(createPaymentProvider('disabled').name).toBe('disabled');
    await expect(createPaymentProvider('paydunya').check('x')).rejects.toThrow("pas encore branché");
    expect(() => createPaymentProvider('autre')).toThrow('Fournisseur de paiement inconnu');
  });
});
