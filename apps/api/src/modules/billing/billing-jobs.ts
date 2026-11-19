import { Controller, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Prisma, Subscription } from '@prisma/client';
import { Public } from '../../common/auth';
import { localDay } from '../../common/country';
import { PlatformDb, PlatformGuard } from '../platform/platform';
import { PLATFORM_TZ } from './billing';
import { addDays, daysLeft, dueAlerts, frDay, versionOn } from './billing-rules';
import { AlreadyDone, jobOnce, notifyDirection, SYSTEM, systemJournals } from './billing-tasks';
import { CountsService } from './counts';
import { BillingDocumentsService } from './documents';

/**
 * Tâches planifiées de la facturation (lot G5a) : fin d'un essai, alertes avant la fin d'un pilote, fin d'un pilote.
 * Elles passent toutes les heures, avec la date du jour de chaque établissement (son fuseau). Chaque tâche est
 * inscrite dans billing_jobs, sous une clé unique, dans la même transaction que son effet : relancée, interrompue ou
 * lancée deux fois en même temps, elle ne produit jamais de doublon. Rien n'est facturé ici, aucun SMS n'est envoyé :
 * une alerte pour le Super Admin et une notification dans l'application pour la direction. Les comptages des élèves
 * facturables (lot G5b, CountsService) passent juste après, au même rythme, puis les documents provisoires de
 * l'abonnement (lot G5c, BillingDocumentsService), qui partent des comptages figés.
 */

const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

type Sub = Subscription & { tenant: { id: string; name: string; timezone: string; groupId: string } };

@Injectable()
export class BillingJobsService implements OnModuleInit, OnModuleDestroy {
  private log = new Logger('Facturation');
  private timers: NodeJS.Timeout[] = [];
  private running = false;

  constructor(private db: PlatformDb, @Optional() private counts?: CountsService, @Optional() private documents?: BillingDocumentsService) {}

  /** Passage toutes les heures (le premier une minute après le démarrage) ; jamais pendant les tests automatiques, ni avec BILLING_JOBS=off. */
  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.BILLING_JOBS === 'off') return;
    const tick = () => {
      this.runDue()
        .catch((e) => this.log.error(`Tâches de facturation : ${e instanceof Error ? e.message : e}`))
        .then(() => this.counts?.runDue())
        .catch((e) => this.log.error(`Comptages des élèves : ${e instanceof Error ? e.message : e}`))
        .then(() => this.documents?.runDue())
        .catch((e) => this.log.error(`Documents de l’abonnement : ${e instanceof Error ? e.message : e}`));
    };
    this.timers.push(setTimeout(tick, 60_000), setInterval(tick, 3_600_000));
    for (const t of this.timers) t.unref?.();
  }

  onModuleDestroy() {
    for (const t of this.timers) clearTimeout(t);
  }

  /** Exécute les tâches dues à `now`. Sans effet la seconde fois. */
  async runDue(now = new Date()): Promise<{ done: string[]; busy?: boolean }> {
    if (this.running) return { done: [], busy: true };
    this.running = true;
    try {
      const done: string[] = [];
      const subs: Sub[] = await this.db.subscription.findMany({
        where: { status: { in: ['TRIAL', 'PILOT'] } },
        include: { tenant: { select: { id: true, name: true, timezone: true, groupId: true } } },
      });
      // Délais des alertes du pilote (30 et 7 jours, provisoire : D-G5-38), en vigueur ce jour.
      const params = await this.db.billingParameter.findMany({ where: { key: { in: ['PILOT_ALERT_FIRST_DAYS', 'PILOT_ALERT_LAST_DAYS'] } } });
      const versions = params.map((p) => ({ ...p, effectiveFrom: iso(p.effectiveFrom)! }));
      const platformToday = localDay(PLATFORM_TZ, now);
      const delays = ['PILOT_ALERT_FIRST_DAYS', 'PILOT_ALERT_LAST_DAYS'].map((k) => versionOn(versions, k, null, platformToday)?.value).filter((v): v is number => !!v);
      for (const s of subs) {
        const today = localDay(s.tenant.timezone, now);
        try {
          if (s.status === 'TRIAL' && s.trialEnd && iso(s.trialEnd)! < today) {
            if (await this.endFree(s, 'TRIAL')) done.push(`trial-end:${s.tenant.name}`);
          }
          if (s.status === 'PILOT' && s.pilotEnd) {
            const end = iso(s.pilotEnd)!;
            if (end < today) {
              if (await this.endFree(s, 'PILOT')) done.push(`pilot-end:${s.tenant.name}`);
            } else {
              for (const n of dueAlerts(today, end, delays)) if (await this.pilotAlert(s, end, n, today)) done.push(`pilot-alert-${n}:${s.tenant.name}`);
            }
          }
        } catch (e) {
          // Une école en erreur n'empêche pas les autres ; la tâche sera reprise au passage suivant.
          this.log.error(`Tâche de facturation pour ${s.tenant.name} : ${e instanceof Error ? e.message : e}`);
        }
      }
      return { done };
    } finally {
      this.running = false;
    }
  }

  private once(key: string, kind: string, tenantId: string, dueDate: string, effect: (tx: Prisma.TransactionClient) => Promise<void>) {
    return jobOnce(this.db, key, kind, tenantId, dueDate, effect);
  }

  private journals(tx: Prisma.TransactionClient, s: Sub, action: string, data: Record<string, unknown>) {
    return systemJournals(tx, s.tenant, 'Subscription', s.id, action, data);
  }

  private notifyDirection(tx: Prisma.TransactionClient, tenantId: string, kind: string, title: string, body: string) {
    return notifyDirection(tx, tenantId, kind, title, body);
  }

  /** Fin de l'essai ou du pilote : l'abonnement attend l'acceptation des conditions commerciales (§4, §13). */
  private endFree(s: Sub, from: 'TRIAL' | 'PILOT') {
    const lastDay = iso(from === 'TRIAL' ? s.trialEnd : s.pilotEnd)!;
    const trial = from === 'TRIAL';
    return this.once(`${trial ? 'trial-end' : 'pilot-end'}:${s.id}:${lastDay}`, trial ? 'TRIAL_END' : 'PILOT_END', s.tenantId, addDays(lastDay, 1), async (tx) => {
      const n = await tx.subscription.updateMany({
        where: { id: s.id, status: from, ...(trial ? { trialEnd: s.trialEnd } : { pilotEnd: s.pilotEnd }) },
        data: { status: 'AWAITING_ACCEPTANCE', statusSince: new Date() },
      });
      if (n.count !== 1) throw new AlreadyDone();
      const kind = trial ? 'TRIAL_ENDED' : 'PILOT_ENDED';
      const data = { lastFreeDay: lastDay };
      await tx.subscriptionEvent.create({ data: { subscriptionId: s.id, tenantId: s.tenantId, kind, fromStatus: from, toStatus: 'AWAITING_ACCEPTANCE', data, actorKind: 'system', actorName: SYSTEM } });
      await tx.platformAlert.create({
        data: {
          tenantId: s.tenantId, kind, dueDate: day(lastDay),
          message: trial
            ? `Essai terminé pour ${s.tenant.name} (dernier jour gratuit : ${frDay(lastDay)}). La direction doit accepter les conditions commerciales.`
            : `Période pilote terminée pour ${s.tenant.name} (dernier jour gratuit : ${frDay(lastDay)}). La direction doit accepter les conditions commerciales ; rien n'est facturé pour la période pilote.`,
        },
      });
      await this.journals(tx, s, trial ? 'billing.trial_ended' : 'billing.pilot_ended', data);
      await this.notifyDirection(tx, s.tenantId, trial ? 'billing.trial_ended' : 'billing.pilot_ended',
        trial ? 'Votre essai de Cahiora est terminé' : 'Votre période pilote Cahiora est terminée',
        `Votre ${trial ? 'essai gratuit' : 'période d’école pilote partenaire'} s’est terminé${trial ? '' : 'e'} le ${frDay(lastDay)}. Pour continuer, lisez et acceptez les conditions commerciales dans Paramètres › Abonnement Cahiora. Vos données sont conservées.`);
    });
  }

  /** Alerte avant la fin de la gratuité d'un pilote, pour le Super Admin et pour la direction (§13). */
  private pilotAlert(s: Sub, end: string, delay: number, today: string) {
    return this.once(`pilot-alert:${s.id}:${end}:${delay}`, 'PILOT_ALERT', s.tenantId, addDays(end, -delay), async (tx) => {
      const left = daysLeft(today, end);
      const data = { pilotEnd: end, daysBefore: delay, daysLeft: left };
      await tx.platformAlert.create({
        data: { tenantId: s.tenantId, kind: 'PILOT_ENDING', dueDate: day(end), message: `La période pilote de ${s.tenant.name} se termine le ${frDay(end)} : encore ${left} jour${left > 1 ? 's' : ''} gratuit${left > 1 ? 's' : ''}.` },
      });
      await this.journals(tx, s, 'billing.pilot_alert', data);
      await this.notifyDirection(tx, s.tenantId, 'billing.pilot_ending', 'Votre période pilote Cahiora se termine bientôt',
        `La gratuité de votre période d’école pilote partenaire se termine le ${frDay(end)}. Ensuite, Cahiora vous demandera d’accepter les conditions commerciales, puis un paiement. Rien n’est facturé pour la période pilote.`);
    });
  }
}

@ApiTags('Plateforme : facturation')
@Public()
@UseGuards(PlatformGuard)
@Controller()
export class BillingJobsController {
  constructor(private jobs: BillingJobsService, private counts: CountsService, private documents: BillingDocumentsService) {}

  /** Passe les tâches tout de suite (sans attendre l'heure suivante), comptages et documents compris ; sans effet sur ce qui est déjà fait. */
  @Post('platform/billing/jobs/run') @Throttle({ default: { limit: 6, ttl: 60000 } })
  async run() {
    const billing = await this.jobs.runDue();
    const counts = await this.counts.runDue();
    const documents = await this.documents.runDue();
    return { done: [...billing.done, ...counts.done, ...documents.done], busy: billing.busy || counts.busy || documents.busy };
  }
}
