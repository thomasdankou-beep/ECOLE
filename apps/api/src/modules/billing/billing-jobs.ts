import { Controller, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Prisma, Subscription } from '@prisma/client';
import { forgetAccess, Public } from '../../common/auth';
import { localDay } from '../../common/country';
import { PlatformDb, PlatformGuard } from '../platform/platform';
import { accessStateOf, currentNotice } from './access';
import { accessPhase, dueReminder, frDateTime, graceWindow, LIMITED_KEEPS, noticeReminderDue, whenText } from './access-rules';
import { PLATFORM_TZ } from './billing';
import { addDays, daysLeft, dueAlerts, frDay, versionOn } from './billing-rules';
import { AlreadyDone, jobOnce, notifyDirection, SYSTEM, systemJournals } from './billing-tasks';
import { CountsService } from './counts';
import { BillingDocumentsService } from './documents';
import { meansVersions, paymentMeansActiveFor } from './payments-access';

/**
 * Tâches planifiées de la facturation (lot G5a) : fin d'un essai, alertes avant la fin d'un pilote, fin d'un pilote.
 * Lot G5d-1 (D-G5-30 A, D-G5-41 A, D-G5-42 A) : rappels de l'essai 3 jours avant sa fin, la veille et le dernier jour
 * (11e, 13e et 14e jours d'un essai de 14 jours) ; à la fin de la gratuité, délai de grâce en accès complet (paramètre
 * daté, 15 jours) ; rappels avant la fin du délai de grâce ou d'une prolongation ; puis, sans paiement validé ni
 * demande de régularisation en attente, accès limité, sans rien supprimer.
 * Lecture 7 A (20 novembre 2026) : un préavis ouvert par la réponse de Cahiora à une demande retient la limitation
 * jusqu'à son heure de fin ; un rappel part dans ses dernières 24 heures.
 * Elles passent toutes les heures, avec la date du jour de chaque établissement (son fuseau). Chaque tâche est
 * inscrite dans billing_jobs, sous une clé unique, dans la même transaction que son effet : relancée, interrompue ou
 * lancée deux fois en même temps, elle ne produit jamais de doublon. Rien n'est facturé ici, aucun SMS n'est envoyé :
 * une alerte pour le Super Admin et une notification dans l'application pour la direction. Les comptages des élèves
 * facturables (lot G5b, CountsService) passent juste après, au même rythme, puis les documents provisoires de
 * l'abonnement (lot G5c, BillingDocumentsService), qui partent des comptages figés.
 */

const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

type Sub = Subscription & { tenant: { id: string; name: string; timezone: string; groupId: string; currency: string; group: { _count: { tenants: number } } } };

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
      // Établissements clients réels seulement : un établissement de test n'a ni essai, ni pilote, ni rappel, ni délai de
      // grâce, et n'est jamais limité (la base refuse aussi tout abonnement pour lui et fige un abonnement ancien).
      const subs: Sub[] = await this.db.subscription.findMany({
        where: { status: { in: ['TRIAL', 'PILOT', 'AWAITING_ACCEPTANCE', 'AWAITING_PAYMENT'] }, tenant: { commercialStatus: 'CLIENT' } },
        include: { tenant: { select: { id: true, name: true, timezone: true, groupId: true, currency: true, group: { select: { _count: { select: { tenants: true } } } } } } },
      });
      // Moyens de paiement (lot G5d-2) : un établissement qui peut payer n'est plus retenu par sa demande (D-G5-42 A).
      const means = await meansVersions(this.db);
      // Délais des alertes du pilote (30 et 7 jours, provisoire : D-G5-38), en vigueur ce jour ; délai de grâce
      // (D-G5-30 A), celui en vigueur le premier jour de grâce.
      const params = await this.db.billingParameter.findMany({ where: { key: { in: ['PILOT_ALERT_FIRST_DAYS', 'PILOT_ALERT_LAST_DAYS', 'GRACE_DAYS'] } } });
      const versions = params.map((p) => ({ ...p, effectiveFrom: iso(p.effectiveFrom)! }));
      const platformToday = localDay(PLATFORM_TZ, now);
      const delays = ['PILOT_ALERT_FIRST_DAYS', 'PILOT_ALERT_LAST_DAYS'].map((k) => versionOn(versions, k, null, platformToday)?.value).filter((v): v is number => !!v);
      const graceDays = (lastFreeDay: string) => versionOn(versions, 'GRACE_DAYS', null, addDays(lastFreeDay, 1))?.value ?? null;
      // Demandes de régularisation qui attendent Cahiora : elles retiennent la limitation (D-G5-42 A).
      const pending = new Set((await this.db.regularizationRequest.findMany({ where: { status: 'PENDING' }, select: { tenantId: true } })).map((r) => r.tenantId));
      for (const s of subs) {
        const today = localDay(s.tenant.timezone, now);
        try {
          if (s.status === 'TRIAL' && s.trialEnd) {
            const end = iso(s.trialEnd)!;
            if (end < today) {
              if (await this.endFree(s, 'TRIAL', graceDays(end))) done.push(`trial-end:${s.tenant.name}`);
            } else {
              const n = dueReminder(today, end);
              if (n !== null && (await this.trialReminder(s, end, n, today, graceDays(end)))) done.push(`trial-reminder-${n}:${s.tenant.name}`);
            }
          }
          if (s.status === 'PILOT' && s.pilotEnd) {
            const end = iso(s.pilotEnd)!;
            if (end < today) {
              if (await this.endFree(s, 'PILOT', graceDays(end))) done.push(`pilot-end:${s.tenant.name}`);
            } else {
              for (const n of dueAlerts(today, end, delays)) if (await this.pilotAlert(s, end, n, today)) done.push(`pilot-alert-${n}:${s.tenant.name}`);
            }
          }
          if (s.status === 'AWAITING_ACCEPTANCE' || s.status === 'AWAITING_PAYMENT') {
            const notice = currentNotice(s);
            const meansActive = paymentMeansActiveFor(means, { currency: s.tenant.currency, alone: s.tenant.group._count.tenants === 1 }, today);
            const view = accessPhase(accessStateOf(s, pending.has(s.tenantId), notice, s.tenant.timezone, meansActive), today, now);
            if ((view.phase === 'GRACE' || view.phase === 'EXTENDED') && view.until) {
              const n = dueReminder(today, view.until);
              if (n !== null && (await this.accessReminder(s, view.phase, view.until, n, today, pending.has(s.tenantId)))) {
                done.push(`${view.phase === 'GRACE' ? 'grace' : 'extension'}-reminder-${n}:${s.tenant.name}`);
              }
            } else if (view.phase === 'NOTICE' && notice) {
              if (noticeReminderDue(notice, now) && (await this.noticeReminder(s, notice, pending.has(s.tenantId)))) done.push(`notice-reminder:${s.tenant.name}`);
            } else if (view.phase === 'DUE') {
              if (await this.limit(s, notice, meansActive)) done.push(`access-limited:${s.tenant.name}`);
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

  /**
   * Fin de l'essai ou du pilote : l'abonnement attend l'acceptation des conditions commerciales (§4, §13). Lot G5d-1
   * (D-G5-30 A) : le délai de grâce en accès complet commence le lendemain du dernier jour gratuit, pour la durée en
   * vigueur ce jour-là ; sans durée en vigueur, pas de délai (jamais limité automatiquement).
   */
  private endFree(s: Sub, from: 'TRIAL' | 'PILOT', graceDays: number | null) {
    const lastDay = iso(from === 'TRIAL' ? s.trialEnd : s.pilotEnd)!;
    const trial = from === 'TRIAL';
    const grace = graceDays ? graceWindow(lastDay, graceDays) : null;
    return this.once(`${trial ? 'trial-end' : 'pilot-end'}:${s.id}:${lastDay}`, trial ? 'TRIAL_END' : 'PILOT_END', s.tenantId, addDays(lastDay, 1), async (tx) => {
      const n = await tx.subscription.updateMany({
        where: { id: s.id, status: from, ...(trial ? { trialEnd: s.trialEnd } : { pilotEnd: s.pilotEnd }) },
        data: { status: 'AWAITING_ACCEPTANCE', statusSince: new Date(), ...(grace ? { graceStart: day(grace.graceStart), graceEnd: day(grace.graceEnd) } : {}) },
      });
      if (n.count !== 1) throw new AlreadyDone();
      const kind = trial ? 'TRIAL_ENDED' : 'PILOT_ENDED';
      const data = { lastFreeDay: lastDay, graceDays, graceStart: grace?.graceStart ?? null, graceEnd: grace?.graceEnd ?? null };
      const graceText = grace
        ? ` Délai de grâce en accès complet jusqu'au ${frDay(grace.graceEnd)} ; sans paiement validé ni demande de régularisation en attente, accès limité à partir du ${frDay(addDays(grace.graceEnd, 1))}.`
        : '';
      await tx.subscriptionEvent.create({ data: { subscriptionId: s.id, tenantId: s.tenantId, kind, fromStatus: from, toStatus: 'AWAITING_ACCEPTANCE', data, actorKind: 'system', actorName: SYSTEM } });
      await tx.platformAlert.create({
        data: {
          tenantId: s.tenantId, kind, dueDate: day(lastDay),
          message: (trial
            ? `Essai terminé pour ${s.tenant.name} (dernier jour gratuit : ${frDay(lastDay)}). La direction doit accepter les conditions commerciales.`
            : `Période pilote terminée pour ${s.tenant.name} (dernier jour gratuit : ${frDay(lastDay)}). La direction doit accepter les conditions commerciales ; rien n'est facturé pour la période pilote.`) + graceText,
        },
      });
      await this.journals(tx, s, trial ? 'billing.trial_ended' : 'billing.pilot_ended', data);
      await this.notifyDirection(tx, s.tenantId, trial ? 'billing.trial_ended' : 'billing.pilot_ended',
        trial ? 'Votre essai de Cahiora est terminé' : 'Votre période pilote Cahiora est terminée',
        `Votre ${trial ? 'essai gratuit' : 'période d’école pilote partenaire'} s’est terminé${trial ? '' : 'e'} le ${frDay(lastDay)}. Pour continuer, lisez et acceptez les conditions commerciales dans Paramètres › Abonnement Cahiora. Vos données sont conservées.`
        + (grace ? ` Vous gardez l’accès complet jusqu’au ${frDay(grace.graceEnd)} inclus (délai de grâce de ${graceDays} jours) ; ensuite, sans paiement validé, l’accès sera limité : ${LIMITED_KEEPS}.` : ''));
    });
  }

  /** Rappel avant la fin de l'essai (D-G5-30 A) : 3 jours avant, la veille et le dernier jour ; pour la direction seulement. */
  private trialReminder(s: Sub, end: string, n: number, today: string, graceDays: number | null) {
    return this.once(`trial-reminder:${s.id}:${end}:${n}`, 'TRIAL_REMINDER', s.tenantId, addDays(end, -n), async (tx) => {
      await this.journals(tx, s, 'billing.trial_reminder', { trialEnd: end, daysBefore: n });
      await this.notifyDirection(tx, s.tenantId, 'billing.trial_reminder',
        n === 0 ? 'Dernier jour de votre essai de Cahiora' : `Votre essai de Cahiora se termine ${n === 1 ? 'demain' : `dans ${n} jours`}`,
        `Votre essai gratuit se termine ${whenText(today, end)} (dernier jour gratuit). Ensuite, acceptez les conditions commerciales et régularisez votre abonnement dans Paramètres › Abonnement Cahiora.`
        + (graceDays ? ` Vous gardez l’accès complet pendant ${graceDays} jours de grâce après l’essai.` : '') + ' Vos données sont conservées.');
    });
  }

  /**
   * Rappel avant la fin du délai de grâce ou d'une prolongation de Cahiora (D-G5-30 A, D-G5-41 A) : 3 jours avant, la
   * veille et le dernier jour d'accès complet ; pour la direction seulement.
   */
  private accessReminder(s: Sub, phase: 'GRACE' | 'EXTENDED', until: string, n: number, today: string, pendingRequest: boolean) {
    const grace = phase === 'GRACE';
    const key = `${grace ? 'grace' : 'extension'}-reminder:${s.id}:${until}:${n}`;
    return this.once(key, grace ? 'GRACE_REMINDER' : 'EXTENSION_REMINDER', s.tenantId, addDays(until, -n), async (tx) => {
      const action = grace ? 'billing.grace_reminder' : 'billing.extension_reminder';
      await this.journals(tx, s, action, { until, daysBefore: n, pendingRequest });
      await this.notifyDirection(tx, s.tenantId, action,
        n === 0 ? 'Dernier jour d’accès complet à Cahiora' : 'Régularisez votre abonnement Cahiora',
        `${grace ? 'Le délai de grâce' : 'La prolongation accordée par Cahiora'} prend fin ${whenText(today, until)} : c’est le dernier jour d’accès complet. `
        + (pendingRequest
          ? 'Votre demande de régularisation attend la réponse de Cahiora : tant qu’elle attend, l’accès ne sera pas limité.'
          : `Ensuite, sans paiement validé, l’accès sera limité : ${LIMITED_KEEPS}. Ouvrez Paramètres › Abonnement Cahiora et choisissez « Régulariser mon abonnement ».`));
    });
  }

  /**
   * Rappel du préavis (lecture 7 A) : dans ses dernières 24 heures, le jour et l'heure de la limitation ; pour la
   * direction seulement, une fois par préavis.
   */
  private noticeReminder(s: Sub, until: Date, pendingRequest: boolean) {
    const at = frDateTime(until, s.tenant.timezone);
    return this.once(`notice-reminder:${s.id}:${until.toISOString()}`, 'NOTICE_REMINDER', s.tenantId, localDay(s.tenant.timezone, until), async (tx) => {
      await this.journals(tx, s, 'billing.notice_reminder', { noticeUntil: until.toISOString(), graceEnd: iso(s.graceEnd), extendedUntil: iso(s.extendedUntil), pendingRequest });
      await this.notifyDirection(tx, s.tenantId, 'billing.notice_reminder', 'Dernier jour du préavis : régularisez votre abonnement Cahiora',
        `Le préavis donné par Cahiora après sa réponse à votre demande de régularisation prend fin le ${at} : jusque-là, l’accès reste complet. `
        + (pendingRequest
          ? 'Votre nouvelle demande de régularisation attend la réponse de Cahiora : tant qu’elle attend, l’accès ne sera pas limité.'
          : `Ensuite, sans paiement validé, l’accès sera limité : ${LIMITED_KEEPS}. Ouvrez Paramètres › Abonnement Cahiora et choisissez « Régulariser mon abonnement ».`));
    });
  }

  /**
   * Accès limité (D-G5-30 A) : délai de grâce, prolongation et préavis passés (lecture 7 A), sans paiement validé ni
   * demande de régularisation en attente (D-G5-42 A). L'abonnement est verrouillé le temps de la vérification : une
   * demande envoyée ou une réponse donnée au même instant (avec son préavis) retient encore la limitation. Rien n'est
   * supprimé.
   */
  private async limit(s: Sub, notice: Date | null, meansActive: boolean) {
    const graceEnd = iso(s.graceEnd);
    const until = iso(s.extendedUntil);
    const lastDay = [graceEnd, until].filter((x): x is string => !!x).sort().pop()!;
    const tz = s.tenant.timezone;
    const noticeAt = notice ? frDateTime(notice, tz) : null;
    const firstLimitedDay = notice ? localDay(tz, notice) : addDays(lastDay, 1);
    const done = await this.once(`access-limited:${s.id}:${graceEnd ?? '-'}:${until ?? '-'}`, 'ACCESS_LIMITED', s.tenantId, firstLimitedDay, async (tx) => {
      await tx.$queryRaw`SELECT id FROM subscriptions WHERE id = ${s.id}::uuid FOR UPDATE`;
      if (!meansActive && (await tx.regularizationRequest.count({ where: { tenantId: s.tenantId, status: 'PENDING' } }))) throw new AlreadyDone();
      const now = new Date();
      const n = await tx.subscription.updateMany({
        where: { id: s.id, status: s.status, graceEnd: s.graceEnd, extendedUntil: s.extendedUntil, noticeUntil: s.noticeUntil },
        data: { status: 'LIMITED', statusSince: now, limitedSince: now },
      });
      if (n.count !== 1) throw new AlreadyDone();
      const data = { lastFullAccessDay: lastDay, graceEnd, extendedUntil: until, noticeUntil: notice?.toISOString() ?? null };
      await tx.subscriptionEvent.create({ data: { subscriptionId: s.id, tenantId: s.tenantId, kind: 'ACCESS_LIMITED', fromStatus: s.status, toStatus: 'LIMITED', data, actorKind: 'system', actorName: SYSTEM } });
      await tx.platformAlert.create({
        data: {
          tenantId: s.tenantId, kind: 'ACCESS_LIMITED', dueDate: day(firstLimitedDay),
          message: `Accès limité pour ${s.tenant.name} : accès complet jusqu'au ${frDay(lastDay)}${noticeAt ? `, puis préavis après la réponse de Cahiora jusqu'au ${noticeAt}` : ''}, `
            + 'sans paiement validé ni demande de régularisation en attente. Rien n\'est supprimé ; une prolongation se donne dans Commercial et facturation › Accès des clients.',
        },
      });
      await this.journals(tx, s, 'billing.access_limited', data);
      await this.notifyDirection(tx, s.tenantId, 'billing.access_limited', 'Accès limité à Cahiora',
        (noticeAt
          ? `Le préavis donné par Cahiora a pris fin le ${noticeAt} sans paiement validé : l’accès à Cahiora est désormais limité. `
          : `L’accès complet de votre établissement a pris fin le ${frDay(lastDay)} sans paiement validé : l’accès à Cahiora est désormais limité. `)
        + `${LIMITED_KEEPS.charAt(0).toUpperCase()}${LIMITED_KEEPS.slice(1)}. Pour retrouver l’accès complet, ouvrez Paramètres › Abonnement Cahiora et choisissez « Régulariser mon abonnement ».`);
    });
    if (done) forgetAccess(s.tenantId);
    return done;
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
