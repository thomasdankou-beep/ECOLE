import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Socket } from 'net';

/**
 * Analyse antivirus des fichiers envoyés (SEC-026, lot 11) par le service ClamAV du serveur (conteneur « clamav »),
 * avant tout enregistrement. Le fichier est transmis en mémoire (commande INSTREAM) : il ne quitte jamais le serveur.
 * - CLAMAV_HOST défini (production, docker-compose) : un fichier infecté est refusé, et si l'antivirus ne répond pas,
 *   l'envoi est refusé lui aussi (jamais de fichier non analysé).
 * - CLAMAV_HOST vide (tests, poste de développement sans ClamAV) : pas d'analyse.
 */
@Injectable()
export class AntivirusService {
  private log = new Logger('Antivirus');
  private host = process.env.CLAMAV_HOST ?? '';
  private port = Number(process.env.CLAMAV_PORT ?? 3310);
  private timeoutMs = Number(process.env.CLAMAV_TIMEOUT_MS ?? 30000);

  get enabled() {
    return !!this.host;
  }

  async assertClean(buffer: Buffer, context: string) {
    if (!this.enabled) return;
    let reply: string;
    try {
      reply = await this.instream(buffer);
    } catch (e) {
      this.log.error(`ClamAV injoignable (${this.host}:${this.port}) : ${(e as Error).message}`);
      throw new ServiceUnavailableException('Analyse antivirus indisponible : réessayez dans quelques minutes');
    }
    if (/FOUND$/.test(reply)) {
      this.log.warn(`Fichier refusé (${context}) : ${reply}`);
      throw new BadRequestException("Fichier refusé : l'antivirus y a détecté un contenu dangereux");
    }
    if (!/OK$/.test(reply)) {
      this.log.error(`Réponse ClamAV inattendue (${context}) : ${reply}`);
      throw new ServiceUnavailableException('Analyse antivirus indisponible : réessayez dans quelques minutes');
    }
  }

  /** Protocole clamd INSTREAM : blocs « longueur sur 4 octets + données », puis un bloc vide. */
  private instream(buffer: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      const chunks: Buffer[] = [];
      const done = (err?: Error) => {
        socket.destroy();
        if (err) reject(err);
        else resolve(Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim());
      };
      socket.setTimeout(this.timeoutMs, () => done(new Error("délai dépassé")));
      socket.on('error', done);
      socket.on('data', (d) => chunks.push(d));
      socket.on('end', () => done());
      socket.connect(this.port, this.host, () => {
        socket.write('zINSTREAM\0');
        for (let i = 0; i < buffer.length; i += 64 * 1024) {
          const part = buffer.subarray(i, i + 64 * 1024);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(part.length);
          socket.write(len);
          socket.write(part);
        }
        socket.write(Buffer.alloc(4));
      });
    });
  }
}
