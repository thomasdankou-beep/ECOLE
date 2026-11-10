import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../../config';
import { PrismaService, Tx } from '../../common/prisma.service';
import { SmsProvider, createSmsProvider, schoolSender } from './sms.provider';
import { smsSegments, toGsm } from './sms-text';

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
  /// SMS lié à une notification de l'application (compte Cahiora du destinataire).
  inAppId?: string;
  userId?: string;
  /// SMS direct vers un numéro (responsable avec ou sans compte), déjà écrit dans sms_messages.
  smsId?: string;
  text: string;
  mode: 'fallback' | 'immediate';
  /// Nouvelle tentative quand la ligne n'est pas encore visible (transaction pas encore validée).
  retry?: number;
}

export interface FamilyNotifyInput extends Omit<NotifyInput, 'smsMode'> {
  sms: string;
  /// true : SMS à chaque responsable tout de suite, même s'il a l'application ; false : SMS de repli seulement
  /// pour ceux qui ont un compte, SMS direct pour ceux qui n'en ont pas. Absent : pas de SMS.
  smsAlways?: boolean;
  sendSms: boolean;
  studentId: string;
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
    const smsText = (input.smsMode ?? 'none') !== 'none' ? await this.signed(tx, tenantId, input.sms ?? input.body) : '';
    for (const userId of unique) {
      const n = await tx.notification.create({
        data: {
          tenantId, userId, channel: 'IN_APP', kind: input.kind, title: input.title, body: input.body,
          data: (input.data ?? undefined) as Prisma.InputJsonValue | undefined, status: 'SENT', sentAt: new Date(),
        },
      });
      const mode = input.smsMode ?? 'none';
      if (mode !== 'none') jobs.push({ tenantId, inAppId: n.id, userId, text: smsText, mode });
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
      let sms;
      if (job.smsId) {
        sms = await tx.smsMessage.findUnique({ where: { id: job.smsId } });
        if (!sms) {
          // Transaction pas encore validée, ou annulée : on réessaie deux fois, puis on abandonne.
          if ((job.retry ?? 0) < 2) setImmediate(() => this.enqueue({ ...job, retry: (job.retry ?? 0) + 1 }));
          return;
        }
        if (sms.status !== 'QUEUED') return; // déjà traité (tâche rejouée)
      } else {
        const inApp = await tx.notification.findUnique({ where: { id: job.inAppId } });
        if (!inApp) return;
        if (job.mode === 'fallback' && inApp.readAt) return; // lue dans l'application : pas de SMS payant
        const user = await tx.user.findUnique({ where: { id: job.userId }, select: { phone: true } });
        const data = (inApp.data ?? {}) as { studentId?: unknown };
        sms = await tx.smsMessage.create({
          data: {
            tenantId: job.tenantId, userId: job.userId, kind: inApp.kind, phone: user?.phone ?? '', body: job.text, segments: smsSegments(job.text),
            studentId: typeof data.studentId === 'string' ? data.studentId : null,
          },
        });
      }
      if (!sms.phone) {
        await tx.smsMessage.update({ where: { id: sms.id }, data: { status: 'FAILED', error: 'Aucun numéro de téléphone' } });
        return;
      }
      const tenant = await tx.tenant.findUnique({ where: { id: job.tenantId }, select: { settings: true } });
      try {
        await this.sms.send(sms.phone, sms.body, { sender: schoolSender(tenant?.settings) });
        await tx.smsMessage.update({ where: { id: sms.id }, data: { status: 'SENT', sentAt: new Date() } });
      } catch (e: any) {
        await tx.smsMessage.update({ where: { id: sms.id }, data: { status: 'FAILED', error: String(e.message).slice(0, 500) } });
      }
    });
  }

  /**
   * Prévient les responsables d'un élève (paiement, absence...) : notification dans l'application pour ceux qui ont
   * un compte, SMS au numéro de la fiche pour tous ceux qui en ont besoin, même sans compte Cahiora.
   * Renvoie le nombre de responsables prévenus.
   */
  async notifyFamily(tx: Tx, tenantId: string, input: FamilyNotifyInput) {
    const links = await tx.studentGuardian.findMany({ where: { studentId: input.studentId }, select: { guardian: { select: { userId: true, phone: true } } } });
    const guardians = links.map((l) => l.guardian);
    const users = guardians.map((g) => g.userId).filter((x): x is string => !!x);
    const { sendSms, smsAlways, studentId, ...rest } = input;
    const data = { ...(input.data ?? {}), studentId };
    await this.notify(tx, tenantId, users, { ...rest, data, smsMode: sendSms && !smsAlways ? 'fallback' : 'none' });
    let direct: string[] = [];
    if (sendSms) {
      direct = guardians.filter((g) => smsAlways || !g.userId).map((g) => g.phone?.trim()).filter((x): x is string => !!x);
      direct = [...new Set(direct)];
      const jobs: SmsJob[] = [];
      const text = await this.signed(tx, tenantId, input.sms);
      for (const phone of direct) {
        const sms = await tx.smsMessage.create({ data: { tenantId, kind: input.kind, phone, body: text, segments: smsSegments(text), studentId } });
        jobs.push({ tenantId, smsId: sms.id, text, mode: 'immediate' });
      }
      setImmediate(() => jobs.forEach((j) => this.enqueue(j)));
    }
    return guardians.filter((g) => g.userId || (sendSms && g.phone)).length;
  }

  /** SMS envoyés aux familles sur un mois (AAAA-MM), pour la direction : liste et nombre de SMS facturés. */
  smsLog(tenantId: string, month: string) {
    const [y, m] = month.split('-').map(Number);
    const from = new Date(Date.UTC(y, m - 1, 1));
    const to = new Date(Date.UTC(y, m, 1));
    return this.db.forTenant(tenantId, async (tx) => {
      const where = { createdAt: { gte: from, lt: to } };
      const [items, totals] = await Promise.all([
        tx.smsMessage.findMany({ where, orderBy: { createdAt: 'desc' }, take: 500 }),
        tx.smsMessage.groupBy({ by: ['status'], where, _count: { _all: true }, _sum: { segments: true } }),
      ]);
      const ids = [...new Set(items.map((i) => i.studentId).filter((x): x is string => !!x))];
      const students = await tx.student.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true } });
      const names = new Map(students.map((s) => [s.id, `${s.lastName} ${s.firstName}`]));
      const count = (st: string) => totals.find((t) => t.status === st);
      return {
        month,
        sent: count('SENT')?._count._all ?? 0,
        failed: count('FAILED')?._count._all ?? 0,
        queued: count('QUEUED')?._count._all ?? 0,
        billed: count('SENT')?._sum.segments ?? 0,
        items: items.map((i) => ({
          id: i.id, kind: i.kind, phone: i.phone, body: i.body, segments: i.segments, status: i.status, error: i.error,
          student: i.studentId ? names.get(i.studentId) ?? null : null, createdAt: i.createdAt, sentAt: i.sentAt,
        })),
      };
    });
  }

  /**
   * Quand l'école n'a pas son propre nom d'expéditeur, le SMS part sous le nom commun de la plateforme :
   * le nom court de l'école est alors ajouté au début, pour que le parent sache d'où vient le message.
   */
  async signed(tx: Tx, tenantId: string, text: string) {
    const t = await tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true, shortName: true, settings: true } });
    if (!t || schoolSender(t.settings)) return text;
    const name = toGsm((t.shortName || t.name).trim()).slice(0, 30);
    return name && !text.startsWith(name) ? `${name} : ${text}` : text;
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
