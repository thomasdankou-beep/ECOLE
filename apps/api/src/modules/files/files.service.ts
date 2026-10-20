import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { promises as fs } from 'fs';
import { join, normalize } from 'path';
import { config } from '../../config';

const ALLOWED: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Stockage des pièces jointes (justificatifs, pièces du dossier).
 * Pilote : disque local, rangé par établissement, téléchargement par URL signée et temporaire (CDC §6.1).
 * Production : remplacer par un stockage compatible S3 (hébergement à décider, INFORMATION MANQUANTE).
 */
@Injectable()
export class FilesService {
  private root = process.env.STORAGE_DIR ?? join(process.cwd(), 'storage');

  async save(tenantId: string, folder: string, file: { buffer: Buffer; mimetype: string; size: number }) {
    const ext = ALLOWED[file.mimetype];
    if (!ext) throw new BadRequestException('Formats acceptés : photo (JPEG, PNG, WebP) ou PDF');
    if (file.size > MAX_UPLOAD_BYTES) throw new BadRequestException('Fichier trop lourd (5 Mo maximum)');
    // Contrôle de la signature binaire : un fichier renommé n'est pas accepté.
    const head = file.buffer.subarray(0, 4).toString('hex');
    const okMagic = { jpg: head.startsWith('ffd8'), png: head === '89504e47', webp: file.buffer.subarray(8, 12).toString() === 'WEBP', pdf: head === '25504446' }[ext];
    if (!okMagic) throw new BadRequestException('Le contenu du fichier ne correspond pas à son type');
    const key = `${tenantId}/${folder}/${randomUUID()}.${ext}`;
    const path = join(this.root, key);
    await fs.mkdir(join(this.root, tenantId, folder), { recursive: true });
    await fs.writeFile(path, file.buffer);
    return key;
  }

  private sign(key: string, exp: number) {
    return createHmac('sha256', config.jwt.refreshSecret).update(`${key}:${exp}`).digest('base64url');
  }

  /** URL de téléchargement valable 15 minutes. */
  signedUrl(key: string, ttlSeconds = 900) {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    return `/api/v1/files?key=${encodeURIComponent(key)}&exp=${exp}&sig=${this.sign(key, exp)}`;
  }

  /** Lecture directe d'un fichier déjà autorisé par l'appelant (logo public d'une école). */
  async readKey(key: string) {
    const path = normalize(join(this.root, key));
    if (!path.startsWith(normalize(this.root))) throw new NotFoundException();
    const ext = key.split('.').pop()!;
    const mime = Object.entries(ALLOWED).find(([, v]) => v === ext)?.[0] ?? 'application/octet-stream';
    return { buffer: await fs.readFile(path).catch(() => { throw new NotFoundException(); }), mime };
  }

  async read(key: string, exp: string, sig: string) {
    const e = Number(exp);
    const expected = this.sign(key, e);
    if (!e || e < Date.now() / 1000 || sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      throw new NotFoundException('Lien expiré');
    }
    const path = normalize(join(this.root, key));
    if (!path.startsWith(normalize(this.root))) throw new NotFoundException();
    const ext = key.split('.').pop()!;
    const mime = Object.entries(ALLOWED).find(([, v]) => v === ext)?.[0] ?? 'application/octet-stream';
    return { buffer: await fs.readFile(path), mime };
  }
}
