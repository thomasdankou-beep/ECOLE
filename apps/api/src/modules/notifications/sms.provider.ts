import { Logger } from '@nestjs/common';
import { maskIdentifier } from '../../common/audit.service';

/** Passerelle SMS. Le fournisseur réel n'est pas encore choisi (INFORMATION MANQUANTE, question Q de l'analyse). */
export interface SmsProvider {
  send(to: string, text: string): Promise<void>;
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

  async send(to: string, text: string) {
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

export function createSmsProvider(name: string): SmsProvider {
  switch (name) {
    case 'console':
      return consoleSms;
    default:
      throw new Error(`Fournisseur SMS inconnu : ${name}. Seul "console" est disponible tant que le fournisseur n'est pas choisi.`);
  }
}
