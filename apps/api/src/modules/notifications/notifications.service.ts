import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../../config';
import { PrismaService, Tx } from '../../common/prisma.service';
import { SmsProvider, createSmsProvider } from './sms.provider';

export interface NotifyInput {
  kind: string;
  title: string;
  body: string;
  /// Texte court du SMS (prénom + information utile seulement, CDC §4.9).
  sms?: string;
  data?: Record<string, unknown>;
  /// 'fallback' : SMS seulement si la notification n'est pas lue après 10 minutes (CDC §4.3) ;
  /// 'immediate' : SMS tout de suite (urgences) ; 'none' : pas de SMS.
  smsMode?: 'fallback' | 'immediate' | 'none';
}

interface SmsJob {
  tenantId: string;
  inAppId: string;
  userId: string;
  text: string;
  mode: 'fallback' | 'immediate';
}

const QUEUE = 'notifications';

/**
 * Notifications multicanal : notification dans l'application d'abord (gratuite),
 * puis SMS en repli via une file BullMQ. Sans Redis (tests, poste de développement),
 * la file bascule sur un minuteur en mémoire.
 */
@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private log = new Logger('Notifications');
  private queue?: Queue;
  private worker?: Worker;
  private conn?: IORedis;
  private timers = new Set<NodeJS.Timeout>();
  private closed = false;
  private sms: SmsProvider = createSmsProvider(config.smsProvider);
  fallbackDelayMs = 10 * 60 * 1000;

  constructor(private db: PrismaService) {}

  onModuleInit() {
    if (!config.redisUrl || process.env.NODE_ENV === 'test') return;
    this.conn = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue(QUEUE, { connection: this.conn });
    this.worker = new Worker<SmsJob>(QUEUE, (job) => this.processSms(job.data), { connection: this.conn, concurrency: 5 });
    this.worker.on('failed', (job, err) => this.log.error(`Envoi ${job?.id} échoué : ${err.message}`));
  }

  async onModuleDestroy() {
    this.closed = true;
    this.timers.forEach(clearTimeout);
    await this.worker?.close();
    await this.queue?.close();
    this.conn?.disconnect();
  }

  /** Crée les notifications dans la transaction en cours et programme les SMS de repli. */
  async notify(tx: Tx, tenantId: string, userIds: string[], input: NotifyInput) {
    const unique = [...new Set(userIds)].filter(Boolean);
    const jobs: SmsJob[] = [];
    for (const userId of unique) {
      const n = await tx.notification.create({
        data: {
          tenantId, userId, channel: 'IN_APP', kind: input.kind, title: input.title, body: input.body,
          data: (input.data ?? undefined) as Prisma.InputJsonValue | undefined, status: 'SENT', sentAt: new Date(),
        },
      });
      const mode = input.smsMode ?? 'none';
      if (mode !== 'none') jobs.push({ tenantId, inAppId: n.id, userId, text: input.sms ?? input.body, mode });
    }
    // Les jobs partent après la validation de la transaction : un job dont la notification
    // n'existe pas (transaction annulée) est ignoré par le worker.
    setImmediate(() => jobs.forEach((j) => this.enqueue(j)));
    return unique.length;
  }

  private async enqueue(job: SmsJob) {
    if (this.closed) return;
    const delay = job.mode === 'immediate' ? 500 : this.fallbackDelayMs;
    if (this.queue) {
      await this.queue.add('sms', job, { delay, attempts: 3, backoff: { type: 'exponential', delay: 30000 }, removeOnComplete: 1000 });
      return;
    }
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.processSms(job).catch((e) => this.log.error(e.message));
    }, delay);
    this.timers.add(t);
  }

  async processSms(job: SmsJob) {
    await this.db.forTenant(job.tenantId, async (tx) => {
      const inApp = await tx.notification.findUnique({ where: { id: job.inAppId } });
      if (!inApp) return;
      if (job.mode === 'fallback' && inApp.readAt) return; // lue dans l'application : pas de SMS payant
      const user = await tx.user.findUnique({ where: { id: job.userId }, select: { phone: true } });
      const sms = await tx.notification.create({
        data: { tenantId: job.tenantId, userId: job.userId, channel: 'SMS', kind: inApp.kind, title: inApp.title, body: job.text, readAt: new Date() },
      });
      if (!user?.phone) {
        await tx.notification.update({ where: { id: sms.id }, data: { status: 'FAILED', error: 'Aucun numéro de téléphone' } });
        return;
      }
      try {
        await this.sms.send(user.phone, job.text);
        await tx.notification.update({ where: { id: sms.id }, data: { status: 'SENT', sentAt: new Date() } });
      } catch (e: any) {
        await tx.notification.update({ where: { id: sms.id }, data: { status: 'FAILED', error: String(e.message).slice(0, 500) } });
      }
    });
  }

  /** Comptes utilisateurs des responsables légaux d'un élève. */
  async guardianUserIds(tx: Tx, studentId: string): Promise<string[]> {
    const links = await tx.studentGuardian.findMany({ where: { studentId }, select: { guardian: { select: { userId: true } } } });
    return links.map((l) => l.guardian.userId).filter((x): x is string => !!x);
  }

  /** Destinataires d'un élève : responsables + compte élève. */
  async studentAudience(tx: Tx, studentId: string): Promise<string[]> {
    const s = await tx.student.findUnique({ where: { id: studentId }, select: { userId: true } });
    return [...(await this.guardianUserIds(tx, studentId)), ...(s?.userId ? [s.userId] : [])];
  }
}
