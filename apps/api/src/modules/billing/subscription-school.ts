import { BadRequestException, Body, ConflictException, Controller, Get, Header, Injectable, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import { Equals, IsBoolean, IsUUID } from 'class-validator';
import { AuditService } from '../../common/audit.service';
import { Actor, Can, CurrentActor, WholeSchool } from '../../common/auth';
import { localDay } from '../../common/country';
import { PrismaService, Tx } from '../../common/prisma.service';
import { daysLeft, STATUS_LABELS, subscriptionKindLabel, SubscriptionStatus } from './billing-rules';

/**
 * Abonnement Cahiora vu par la direction (lot G5a) : état, dates de gratuité, calendrier de facturation, tarif en
 * vigueur, historique, et acceptation des conditions commerciales à la fin de l'essai ou du pilote. Le rôle des écoles
 * n'a aucun droit sur les tables de la facturation : il passe par des fonctions de la base limitées à l'école courante
 * (migration facturation_g5a). La direction d'un établissement ne voit jamais l'abonnement d'un autre.
 */

export class AcceptTermsDto {
  @IsUUID('all', { message: 'Version des conditions invalide' }) termsId: string;
  /** Case « J'ai lu et j'accepte » cochée. */
  @IsBoolean() @Equals(true, { message: 'Cochez la case pour accepter les conditions' }) accepted: boolean;
}

type SubscriptionRow = {
  status: SubscriptionStatus; status_since: Date; trial_start: Date | null; trial_end: Date | null; trial_days: number | null; pilot_start: Date | null; pilot_end: Date | null;
  pilot_months: number | null; accepted_at: Date | null; accepted_by_name: string | null; accepted_terms_version: number | null; accepted_tariff: Prisma.JsonValue | null;
};
const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

/** Erreur de la fonction d'acceptation (préfixe « CAHIORA: ») rendue à l'écran ; toute autre erreur reste une erreur. */
function acceptanceMessage(e: unknown) {
  const text = e instanceof Error ? e.message : String(e);
  const m = text.match(/CAHIORA: ([^\n"]+)/);
  return m ? m[1].trim() : null;
}

@Injectable()
export class SchoolSubscriptionService {
  constructor(private db: PrismaService, private audit: AuditService) {}

  private async read(tx: Tx, tenantId: string) {
    const t = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { currency: true, timezone: true } });
    const today = localDay(t.timezone);
    const [s] = await tx.$queryRaw<SubscriptionRow[]>`SELECT * FROM current_tenant_subscription()`;
    return { t, today, s: s ?? null };
  }

  async view(actor: Actor) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const { t, today, s } = await this.read(tx, actor.tenantId);
      const [price] = await tx.$queryRaw<{ v: number | null }[]>`SELECT billing_parameter_value('PRICE_PER_PUPIL', ${t.currency}, ${today}::date) AS v`;
      const [minimum] = await tx.$queryRaw<{ v: number | null }[]>`SELECT billing_parameter_value('MINIMUM_PER_ESTABLISHMENT', ${t.currency}, ${today}::date) AS v`;
      const calendars = await tx.$queryRaw<Record<string, Date | string | number | null>[]>`SELECT * FROM current_tenant_billing_calendars()`;
      const events = await tx.$queryRaw<{ kind: string; from_status: string | null; to_status: string | null; data: Prisma.JsonValue; actor_kind: string; actor_name: string; created_at: Date }[]>`
        SELECT * FROM current_tenant_subscription_events()`;
      const [terms] = s?.status === 'AWAITING_ACCEPTANCE'
        ? await tx.$queryRaw<{ id: string; version: number; title: string; body: string; effective_from: Date }[]>`SELECT * FROM current_commercial_terms(${today}::date)`
        : [];
      const last = s?.status === 'TRIAL' ? iso(s.trial_end) : s?.status === 'PILOT' ? iso(s.pilot_end) : null;
      return {
        today, currency: t.currency,
        // Tarif public de Cahiora en vigueur ce jour ; un tarif accepté est figé dans l'abonnement.
        tariff: { pricePerPupil: price?.v ?? null, minimum: minimum?.v ?? null },
        subscription: s && {
          status: s.status, statusLabel: STATUS_LABELS[s.status], statusSince: s.status_since,
          trialStart: iso(s.trial_start), trialEnd: iso(s.trial_end), trialDays: s.trial_days, pilotStart: iso(s.pilot_start), pilotEnd: iso(s.pilot_end), pilotMonths: s.pilot_months,
          freeDaysLeft: last ? daysLeft(today, last) : null,
          acceptedAt: s.accepted_at, acceptedByName: s.accepted_by_name, acceptedTermsVersion: s.accepted_terms_version, acceptedTariff: s.accepted_tariff,
        },
        terms: terms ? { id: terms.id, version: terms.version, title: terms.title, body: terms.body, effectiveFrom: iso(terms.effective_from) } : null,
        calendars: calendars.map((c) => ({
          yearLabel: c.year_label, version: c.version, startDate: iso(c.start_date as Date), endDate: iso(c.end_date as Date), preparationFrom: iso(c.preparation_from as Date | null),
          initialCountDate: iso(c.initial_count_date as Date), firstRegularizationDate: iso(c.first_regularization_date as Date), finalRegularizationDate: iso(c.final_regularization_date as Date),
          renewalDate: iso(c.renewal_date as Date | null), formula: c.formula,
        })),
        history: events.map((e) => ({ kind: e.kind, label: subscriptionKindLabel(e.kind), fromStatus: e.from_status, toStatus: e.to_status, data: e.data, actorName: e.actor_name, createdAt: e.created_at })),
      };
    });
  }

  /**
   * Acceptation des conditions commerciales en vigueur (§4, étape 2) par la direction de tout l'établissement. La base
   * refait chaque contrôle, fige le tarif du jour et inscrit l'acceptation dans l'historique, dans la même transaction.
   */
  async accept(actor: Actor, dto: AcceptTermsDto) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const { today, s } = await this.read(tx, actor.tenantId);
      if (!s) throw new ConflictException('Aucun abonnement n’est encore ouvert pour votre établissement');
      if (s.status !== 'AWAITING_ACCEPTANCE') throw new ConflictException(`L’abonnement n’attend pas d’acceptation (état : ${STATUS_LABELS[s.status]})`);
      try {
        const [r] = await tx.$queryRaw<{ status: string }[]>`
          SELECT accept_commercial_terms(${dto.termsId}::uuid, ${actor.userId}::uuid, ${actor.name}, ${actor.ip ?? null}, ${today}::date) AS status`;
        await this.audit.log(tx, actor, 'billing.terms_accepted', 'Subscription', null, { termsId: dto.termsId, status: r.status });
        return { status: r.status, statusLabel: STATUS_LABELS[r.status as SubscriptionStatus] };
      } catch (e) {
        const message = acceptanceMessage(e);
        if (message) throw new BadRequestException(message);
        throw e;
      }
    });
  }
}

@ApiTags('Paramètres')
@Controller()
export class SchoolSubscriptionController {
  constructor(private s: SchoolSubscriptionService) {}

  /** Abonnement Cahiora de l'établissement : direction seulement. */
  @Get('settings/subscription') @Can('settings.manage') @Header('Cache-Control', 'no-store')
  view(@CurrentActor() a: Actor) { return this.s.view(a); }

  @Post('settings/subscription/accept') @Can('settings.manage') @WholeSchool() @Throttle({ default: { limit: 10, ttl: 60000 } })
  accept(@CurrentActor() a: Actor, @Body() dto: AcceptTermsDto) { return this.s.accept(a, dto); }
}
