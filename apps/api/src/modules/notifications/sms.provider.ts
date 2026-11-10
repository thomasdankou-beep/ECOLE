import { Logger } from '@nestjs/common';
import { maskIdentifier } from '../../common/audit.service';
import { toGsm } from './sms-text';

/** Passerelle SMS : « console » (rien n'est envoyé) ou « bulkgate » (Côte d'Ivoire, Bénin et autres pays). */
export interface SmsProvider {
  /** sender : nom d'expéditeur de l'école (11 caractères, enregistré auprès du fournisseur) ; sinon celui de la plateforme. */
  send(to: string, text: string, opts?: { sender?: string | null }): Promise<void>;
}

/**
 * Fournisseur « console », tant qu'aucun fournisseur SMS n'est choisi : rien n'est envoyé.
 * SEC-044 : en production, le journal ne garde que le destinataire masqué, jamais le texte, qui peut
 * contenir un mot de passe provisoire ou un code. Le texte n'est écrit qu'en développement, ou si
 * SMS_CONSOLE_SHOW_TEXT=true (serveur de démonstration seulement). La liste `sent` n'existe que pour les tests.
 */
export class ConsoleSmsProvider implements SmsProvider {
  private log = new Logger('SMS');
  static readonly MAX_KEPT = 500;
  readonly sent: { to: string; text: string }[] = [];
  constructor(private env: Record<string, string | undefined> = process.env) {}

  async send(to: string, text: string, _opts?: { sender?: string | null }) {
    const env = this.env;
    if (env.NODE_ENV === 'test') {
      this.sent.push({ to, text });
      if (this.sent.length > ConsoleSmsProvider.MAX_KEPT) this.sent.shift();
    }
    const showText = env.SMS_CONSOLE_SHOW_TEXT === 'true' || (env.NODE_ENV !== 'production' && env.SMS_CONSOLE_SHOW_TEXT !== 'false');
    if (showText) this.log.log(`→ ${to} : ${text}`);
    else this.log.warn(`SMS non envoyé (aucun fournisseur SMS configuré) → ${maskIdentifier(to)} (${text.length} caractères)`);
  }
}

/** Instance partagée : les tests lisent les SMS envoyés (codes OTP, identifiants). */
export const consoleSms = new ConsoleSmsProvider();

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; json(): Promise<any> }>;

/** Nom d'expéditeur accepté par les opérateurs : 3 à 11 lettres, chiffres, espaces, points ou tirets. */
export const validSender = (s: string | null | undefined): s is string => !!s && /^[A-Za-z0-9 .-]{3,11}$/.test(s) && /[A-Za-z]/.test(s);

/**
 * BulkGate, API « Simple » des SMS transactionnels (notifications seulement, pas de publicité) :
 * https://www.bulkgate.com/en/docs/simple-api/simple-transactional/
 * Le numéro part au format international sans « + » (2290197000001). Avec un nom d'expéditeur enregistré,
 * l'envoi se fait en « gText » ; sinon BulkGate envoie depuis un numéro système (« gSystem »), plus cher au Bénin
 * et en Côte d'Ivoire. Une requête qui n'aboutit pas est reprise une fois sur le serveur de secours de BulkGate.
 */
export class BulkGateSmsProvider implements SmsProvider {
  static readonly HOSTS = ['https://portal.bulkgate.com', 'https://backup1.bulkgate.com'];
  constructor(
    private applicationId: string,
    private token: string,
    private defaultSender: string | null = null,
    private http: Fetch = fetch as unknown as Fetch,
  ) {
    if (!applicationId || !token) throw new Error('SMS_PROVIDER=bulkgate : BULKGATE_APPLICATION_ID et BULKGATE_APPLICATION_TOKEN sont obligatoires');
  }

  async send(to: string, text: string, opts: { sender?: string | null } = {}) {
    const number = to.replace(/\D/g, '');
    if (number.length < 8) throw new Error('Numéro de téléphone invalide');
    const sender = validSender(opts.sender) ? opts.sender : validSender(this.defaultSender) ? this.defaultSender : null;
    const body = JSON.stringify({
      application_id: this.applicationId, application_token: this.token, number, text,
      unicode: toGsm(text) !== text,
      ...(sender ? { sender_id: 'gText', sender_id_value: sender } : { sender_id: 'gSystem' }),
    });
    let lastError: Error | null = null;
    for (const host of BulkGateSmsProvider.HOSTS) {
      let res;
      try {
        res = await this.http(`${host}/api/1.0/simple/transactional`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body, signal: AbortSignal.timeout(15000),
        });
      } catch (e: any) {
        lastError = new Error(`BulkGate injoignable : ${e?.message ?? e}`);
        continue; // panne réseau : serveur de secours
      }
      const json = await res.json().catch(() => null);
      if (res.status >= 200 && res.status < 300 && json?.data?.status && json.data.status !== 'error') return;
      // Refus de BulkGate (numéro invalide, identifiants, crédit...) : pas de nouvel essai, le message est conservé.
      throw new Error(`BulkGate ${json?.code ?? res.status} : ${json?.error ?? json?.data?.status ?? 'réponse inattendue'}${json?.type ? ` (${json.type})` : ''}`);
    }
    throw lastError ?? new Error('BulkGate injoignable');
  }
}

let bulkgate: BulkGateSmsProvider | null = null;

export function createSmsProvider(name: string, env: Record<string, string | undefined> = process.env): SmsProvider {
  switch (name) {
    case 'console':
      return consoleSms;
    case 'bulkgate':
      return (bulkgate ??= new BulkGateSmsProvider(env.BULKGATE_APPLICATION_ID ?? '', env.BULKGATE_APPLICATION_TOKEN ?? '', env.SMS_SENDER ?? null));
    default:
      throw new Error(`Fournisseur SMS inconnu : ${name}. Valeurs possibles : "console", "bulkgate".`);
  }
}

/** Nom d'expéditeur de l'école, saisi par le Super Admin une fois enregistré chez le fournisseur. */
export const schoolSender = (settings: unknown): string | null => {
  const s = (settings as { smsSender?: unknown } | null)?.smsSender;
  return typeof s === 'string' && validSender(s) ? s : null;
};

const quietLog = new Logger('SMS');

/**
 * Envoi qui ne fait jamais échouer l'action en cours (création de compte, pré-inscription...) : un refus du
 * fournisseur est écrit dans le journal, sans le texte ni le numéro complet (SEC-044).
 */
export async function sendQuietly(sms: SmsProvider, to: string, text: string, settings?: unknown) {
  try {
    await sms.send(to, text, { sender: schoolSender(settings) });
    return true;
  } catch (e: any) {
    quietLog.error(`SMS non envoyé → ${maskIdentifier(to)} : ${String(e?.message ?? e).slice(0, 200)}`);
    return false;
  }
}
