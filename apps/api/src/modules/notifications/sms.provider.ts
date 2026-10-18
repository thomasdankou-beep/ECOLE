import { Logger } from '@nestjs/common';

/** Passerelle SMS. Le fournisseur réel n'est pas encore choisi (INFORMATION MANQUANTE, question Q de l'analyse). */
export interface SmsProvider {
  send(to: string, text: string): Promise<void>;
}

/** Écrit les SMS dans les journaux : développement et pilote sans contrat SMS. */
export class ConsoleSmsProvider implements SmsProvider {
  private log = new Logger('SMS');
  readonly sent: { to: string; text: string }[] = [];
  async send(to: string, text: string) {
    this.sent.push({ to, text });
    this.log.log(`→ ${to} : ${text}`);
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
