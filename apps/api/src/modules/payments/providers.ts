import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '../../config';

/**
 * Couche d'abstraction des paiements en ligne (master prompt §5) : la logique métier
 * ne connaît que cette interface ; changer d'agrégateur ne touche que ce fichier.
 */
export interface InitiateInput {
  transactionId: string;
  amount: number;
  currency: string;
  description: string;
  payerPhone?: string;
  operator?: string;
  customerName: string;
  notifyUrl: string;
  returnUrl: string;
}

export interface InitiateResult {
  /// Page de paiement de l'agrégateur, ou instructions à afficher (validation sur le téléphone).
  checkoutUrl?: string;
  instructions?: string;
  providerRef?: string;
}

export interface ProviderEvent {
  transactionId: string;
  status: 'SUCCESS' | 'FAILED' | 'PENDING';
  amount?: number;
  providerRef?: string;
}

export interface PaymentProvider {
  readonly name: string;
  initiate(input: InitiateInput): Promise<InitiateResult>;
  /** Vérifie l'authenticité d'un webhook et en extrait l'identifiant de transaction. */
  parseWebhook(headers: Record<string, any>, body: any): Promise<{ transactionId: string }>;
  /** Interroge l'agrégateur : on ne croit jamais le contenu du webhook ou du navigateur sur parole. */
  check(transactionId: string): Promise<ProviderEvent>;
}

// ---------------------------------------------------------------- Bac à sable

/**
 * Simule un agrégateur Mobile Money pour la démonstration et les tests :
 * la page /paiement/simulation reproduit la validation sur le téléphone du parent,
 * puis l'agrégateur fictif envoie un webhook signé, traité comme un vrai.
 */
export class SandboxProvider implements PaymentProvider {
  readonly name = 'sandbox';
  private static outcomes = new Map<string, { status: 'SUCCESS' | 'FAILED'; amount: number }>();
  private static amounts = new Map<string, number>();

  static sign(body: string) {
    return createHmac('sha256', config.jwt.refreshSecret).update(`sandbox:${body}`).digest('hex');
  }

  static decide(transactionId: string, success: boolean) {
    const amount = SandboxProvider.amounts.get(transactionId);
    if (amount === undefined) return false;
    SandboxProvider.outcomes.set(transactionId, { status: success ? 'SUCCESS' : 'FAILED', amount });
    return true;
  }

  async initiate(input: InitiateInput): Promise<InitiateResult> {
    SandboxProvider.amounts.set(input.transactionId, input.amount);
    return {
      checkoutUrl: `/paiement/simulation/${encodeURIComponent(input.transactionId)}`,
      instructions: `Validez le paiement de ${input.amount} FCFA sur votre téléphone (${input.operator ?? 'Mobile Money'}).`,
      providerRef: `SBX-${input.transactionId.slice(-8)}`,
    };
  }

  async parseWebhook(headers: Record<string, any>, body: any) {
    const raw = JSON.stringify(body ?? {});
    const sig = String(headers['x-sandbox-signature'] ?? '');
    const expected = SandboxProvider.sign(raw);
    if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      throw new Error('Signature invalide');
    }
    return { transactionId: String(body.transactionId) };
  }

  async check(transactionId: string): Promise<ProviderEvent> {
    const o = SandboxProvider.outcomes.get(transactionId);
    if (!o) return { transactionId, status: 'PENDING' };
    return { transactionId, status: o.status, amount: o.amount, providerRef: `SBX-${transactionId.slice(-8)}` };
  }
}

// ---------------------------------------------------------------- CinetPay

/**
 * Adaptateur CinetPay (API Checkout v2). À valider en environnement de test CinetPay :
 * les identifiants de l'école ne sont pas encore connus (INFORMATION MANQUANTE).
 */
export class CinetPayProvider implements PaymentProvider {
  readonly name = 'cinetpay';
  private base = 'https://api-checkout.cinetpay.com/v2';

  private get creds() {
    const c = config.payments.cinetpay;
    if (!c.apiKey || !c.siteId) throw new Error('CinetPay non configuré : CINETPAY_API_KEY et CINETPAY_SITE_ID manquants');
    return c;
  }

  async initiate(input: InitiateInput): Promise<InitiateResult> {
    const c = this.creds;
    const res = await fetch(`${this.base}/payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apikey: c.apiKey, site_id: c.siteId, transaction_id: input.transactionId, amount: input.amount, currency: input.currency,
        description: input.description.replace(/[^\w\s.-]/g, ' ').slice(0, 100), notify_url: input.notifyUrl, return_url: input.returnUrl,
        channels: 'MOBILE_MONEY', customer_name: input.customerName, customer_phone_number: input.payerPhone,
      }),
    });
    const json: any = await res.json();
    if (json.code !== '201') throw new Error(`CinetPay : ${json.message ?? res.status}`);
    return { checkoutUrl: json.data?.payment_url, providerRef: json.data?.payment_token };
  }

  async parseWebhook(headers: Record<string, any>, body: any) {
    const c = this.creds;
    // Signature HMAC « x-token » calculée par CinetPay sur les champs du webhook.
    if (c.secretKey) {
      const fields = ['cpm_site_id', 'cpm_trans_id', 'cpm_trans_date', 'cpm_amount', 'cpm_currency', 'signature', 'payment_method', 'cel_phone_num', 'cpm_phone_prefixe', 'cpm_language', 'cpm_version', 'cpm_payment_config', 'cpm_page_action', 'cpm_custom', 'cpm_designation', 'cpm_error_message'];
      const data = fields.map((f) => body?.[f] ?? '').join('');
      const expected = createHmac('sha256', c.secretKey).update(data).digest('hex');
      const got = String(headers['x-token'] ?? '');
      if (got.length !== expected.length || !timingSafeEqual(Buffer.from(got), Buffer.from(expected))) throw new Error('Signature CinetPay invalide');
    }
    if (!body?.cpm_trans_id) throw new Error('Webhook CinetPay sans transaction');
    return { transactionId: String(body.cpm_trans_id) };
  }

  async check(transactionId: string): Promise<ProviderEvent> {
    const c = this.creds;
    const res = await fetch(`${this.base}/payment/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apikey: c.apiKey, site_id: c.siteId, transaction_id: transactionId }),
    });
    const json: any = await res.json();
    const st = json.data?.status;
    return {
      transactionId,
      status: st === 'ACCEPTED' ? 'SUCCESS' : st === 'REFUSED' || st === 'CANCELED' ? 'FAILED' : 'PENDING',
      amount: json.data?.amount !== undefined ? Number(json.data.amount) : undefined,
      providerRef: json.data?.operator_id,
    };
  }
}

// ---------------------------------------------------------------- PayDunya

/** Emplacement prévu pour PayDunya : non implémenté tant que l'agrégateur n'est pas choisi (INFORMATION MANQUANTE). */
export class PayDunyaProvider implements PaymentProvider {
  readonly name = 'paydunya';
  private fail(): never {
    throw new Error("PayDunya n'est pas encore branché : agrégateur et identifiants à confirmer par l'école");
  }
  async initiate(): Promise<InitiateResult> { this.fail(); }
  async parseWebhook(): Promise<{ transactionId: string }> { this.fail(); }
  async check(): Promise<ProviderEvent> { this.fail(); }
}

export function createPaymentProvider(name: string): PaymentProvider {
  switch (name) {
    case 'sandbox': return new SandboxProvider();
    case 'cinetpay': return new CinetPayProvider();
    case 'paydunya': return new PayDunyaProvider();
    default: throw new Error(`Fournisseur de paiement inconnu : ${name}`);
  }
}
