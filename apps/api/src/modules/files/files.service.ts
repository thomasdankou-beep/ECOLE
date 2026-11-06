import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { promises as fs } from 'fs';
import { join, relative, resolve } from 'path';
import sharp from 'sharp';
import { derivedKey } from '../../config';
import { AntivirusService } from './antivirus.service';

const ALLOWED: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
/** Limite des routes d'envoi de fichier (SEC-029) : 20 envois par minute. */
export const UPLOAD_THROTTLE = { default: { limit: 20, ttl: 60000 } };
/** Les photos sont ramenées à 2 000 pixels au plus de côté (SEC-027). */
const MAX_IMAGE_SIDE = 2000;
/**
 * Contenu actif refusé dans un PDF (SEC-026) : JavaScript, lancement de programme, fichier joint, formulaire
 * envoyé ailleurs, multimédia. Les noms PDF écrits en hexadécimal (/J#61vaScript) sont décodés avant la recherche.
 */
const PDF_ACTIVE = /\/(JavaScript|JS|Launch|EmbeddedFiles?|RichMedia|XFA|SubmitForm|ImportData|GoToE)\b/;

/**
 * Stockage des pièces jointes (justificatifs, pièces du dossier, photos).
 * Disque local du serveur (volume « uploads »), rangé par établissement, téléchargement par URL signée et temporaire.
 * Chaque fichier est analysé par l'antivirus (SEC-026), les images sont ré-encodées sans métadonnées (SEC-027),
 * et un fichier remplacé ou supprimé est effacé du disque (SEC-028).
 */
@Injectable()
export class FilesService {
  private root = resolve(process.env.STORAGE_DIR ?? join(process.cwd(), 'storage'));
  private log = new Logger('Fichiers');

  constructor(private antivirus: AntivirusService) {}

  async save(tenantId: string, folder: string, file: { buffer: Buffer; mimetype: string; size: number }) {
    const ext = ALLOWED[file.mimetype];
    if (!ext) throw new BadRequestException('Formats acceptés : photo (JPEG, PNG, WebP) ou PDF');
    if (file.size > MAX_UPLOAD_BYTES || file.buffer.length > MAX_UPLOAD_BYTES) throw new BadRequestException('Fichier trop lourd (5 Mo maximum)');
    const buf = file.buffer;
    // Contrôle de la signature binaire : un fichier renommé n'est pas accepté.
    const okMagic = {
      jpg: buf.subarray(0, 3).toString('hex') === 'ffd8ff',
      png: buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a',
      webp: buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP',
      pdf: buf.subarray(0, 5).toString() === '%PDF-',
    }[ext];
    if (!okMagic) throw new BadRequestException('Le contenu du fichier ne correspond pas à son type');
    await this.antivirus.assertClean(buf, `${tenantId}/${folder}`);
    const content = ext === 'pdf' ? this.checkPdf(buf) : await this.reencode(buf, ext);
    const key = `${tenantId}/${folder}/${randomUUID()}.${ext}`;
    await fs.mkdir(join(this.root, tenantId, folder), { recursive: true });
    await fs.writeFile(join(this.root, key), content);
    return key;
  }

  /** Ré-encode l'image : métadonnées (GPS, appareil) retirées, orientation appliquée, taille limitée (SEC-027, SEC-030). */
  private async reencode(buf: Buffer, ext: string) {
    try {
      const img = sharp(buf, { failOn: 'error', limitInputPixels: 50_000_000 }).rotate()
        .resize({ width: MAX_IMAGE_SIDE, height: MAX_IMAGE_SIDE, fit: 'inside', withoutEnlargement: true });
      if (ext === 'jpg') return await img.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
      if (ext === 'png') return await img.png({ compressionLevel: 9 }).toBuffer();
      return await img.webp({ quality: 85 }).toBuffer();
    } catch {
      throw new BadRequestException('Image illisible : envoyez une photo JPEG, PNG ou WebP');
    }
  }

  private checkPdf(buf: Buffer) {
    // Les données des flux (images, texte compressé) sont ignorées : seuls les dictionnaires du PDF sont lus.
    // Un dictionnaire caché dans un flux compressé échappe à cette règle : c'est le rôle de l'antivirus.
    const text = buf.toString('latin1')
      .replace(/stream\r?\n[\s\S]*?endstream/g, ' ')
      .replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    if (PDF_ACTIVE.test(text)) {
      throw new BadRequestException('Ce PDF contient du contenu actif (script, pièce jointe ou formulaire) : imprimez-le en PDF ou envoyez une photo du document');
    }
    return buf;
  }

  /** Chemin d'une clé, toujours à l'intérieur du dossier de stockage. */
  private pathOf(key: string) {
    const path = resolve(this.root, key);
    const rel = relative(this.root, path);
    if (!key || rel.startsWith('..') || rel.includes('\0') || resolve(this.root, rel) !== path) throw new NotFoundException();
    return path;
  }

  /** Efface un fichier qui n'est plus utilisé (SEC-028). Un fichier déjà absent n'est pas une erreur. */
  async remove(key: string | null | undefined) {
    if (!key) return;
    try {
      await fs.unlink(this.pathOf(key));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.log.warn(`Fichier non effacé (${key}) : ${(e as Error).message}`);
    }
  }

  /**
   * Enregistre en base la référence au nouveau fichier, puis efface les anciens ; si l'enregistrement échoue,
   * c'est le nouveau fichier qui est effacé (SEC-028). Les fichiers ne sont effacés qu'après la validation.
   */
  async commit<T>(newKey: string | null, work: () => Promise<{ result: T; old?: (string | null | undefined)[] }>): Promise<T> {
    let r: { result: T; old?: (string | null | undefined)[] };
    try {
      r = await work();
    } catch (e) {
      await this.remove(newKey);
      throw e;
    }
    for (const k of r.old ?? []) if (k && k !== newKey) await this.remove(k);
    return r.result;
  }

  private sign(key: string, exp: number) {
    return createHmac('sha256', derivedKey('files')).update(`${key}:${exp}`).digest('base64url');
  }

  /** URL de téléchargement valable 15 minutes. */
  signedUrl(key: string, ttlSeconds = 900) {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    return `/api/v1/files?key=${encodeURIComponent(key)}&exp=${exp}&sig=${this.sign(key, exp)}`;
  }

  private async load(key: string) {
    const ext = key.split('.').pop()!;
    const mime = Object.entries(ALLOWED).find(([, v]) => v === ext)?.[0] ?? 'application/octet-stream';
    const buffer = await fs.readFile(this.pathOf(key)).catch(() => { throw new NotFoundException('Fichier introuvable'); });
    return { buffer, mime, ext };
  }

  /** Lecture directe d'un fichier déjà autorisé par l'appelant (logo public d'une école). */
  readKey(key: string) {
    return this.load(key);
  }

  async read(key: string, exp: string, sig: string) {
    const e = Number(exp);
    const expected = this.sign(key, e);
    if (!e || e < Date.now() / 1000 || sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      throw new NotFoundException('Lien expiré');
    }
    return this.load(key);
  }
}
