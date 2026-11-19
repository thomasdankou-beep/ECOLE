import { BadRequestException, Body, ConflictException, Controller, Get, Header, Injectable, Optional, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import { Equals, IsBoolean, IsUUID } from 'class-validator';
import { AuditService } from '../../common/audit.service';
import { Actor, AllowedWhenLimited, Can, CurrentActor, WholeSchool } from '../../common/auth';
import { localDay } from '../../common/country';
import { PrismaService, Tx } from '../../common/prisma.service';
import { schoolAccess, schoolRequests } from './access';
import { daysLeft, STATUS_LABELS, subscriptionKindLabel, SubscriptionStatus } from './billing-rules';
import { BillingDocumentsService, GROUP_SCHOOL_PENDING, PROVISIONAL_MENTION } from './documents';

/**
 * Abonnement Cahiora vu par la direction (lot G5a) : état, dates de gratuité, calendrier de facturation, tarif en
 * vigueur, historique, et acceptation des conditions commerciales à la fin de l'essai ou du pilote. Le rôle des écoles
 * n'a aucun droit sur les tables de la facturation : il passe par des fonctions de la base limitées à l'école courante
 * (migration facturation_g5a). La direction d'un établissement ne voit jamais l'abonnement d'un autre.
 * Lot G5d-1 (D-G5-30 A) : la page sert aussi à la régularisation (bouton « Régulariser mon abonnement ») : accès
 * (délai de grâce, prolongation, accès limité, compteur), montant demandé par les documents provisoires, échéance,
 * état du paiement, moyens de paiement activés (aucun avant le lot G5d-2) et demandes de régularisation.
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

/** Les conditions s'acceptent en attente d'acceptation, ou en accès limité avant toute acceptation (lot G5d-1). */
const awaitsAcceptance = (s: SubscriptionRow | null) => !!s && (s.status === 'AWAITING_ACCEPTANCE' || (s.status === 'LIMITED' && !s.accepted_at));

type DocumentRow = { document_id: string; kind: string; currency: string; total: number; due_date: Date | null; issue_date: Date; created_at: Date };

/** Erreur de la fonction d'acceptation (préfixe « CAHIORA: ») rendue à l'écran ; toute autre erreur reste une erreur. */
function acceptanceMessage(e: unknown) {
  const text = e instanceof Error ? e.message : String(e);
  const m = text.match(/CAHIORA: ([^\n"]+)/);
  return m ? m[1].trim() : null;
}

@Injectable()
export class SchoolSubscriptionService {
  constructor(private db: PrismaService, private audit: AuditService, @Optional() private documents?: BillingDocumentsService) {}

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
      const [terms] = awaitsAcceptance(s)
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
        access: await schoolAccess(tx, today),
        requests: s ? await schoolRequests(tx) : [],
        regularization: s ? await this.regularization(tx, t.currency) : null,
      };
    });
  }

  /**
   * Ce que la direction doit régulariser (D-G5-30 A) : montant demandé par les documents provisoires de l'abonnement
   * (lot G5c, avoirs déduits), échéance du plus récent, état du paiement et moyens de paiement activés. Aucun paiement
   * n'est encore validé par Cahiora (lot G5d-2) et aucun moyen de paiement n'est activé : la demande de régularisation
   * est la seule voie. L'école d'un groupe de plusieurs établissements ne voit pas les documents du groupe (D-G5-19).
   */
  private async regularization(tx: Tx, currency: string) {
    const [v] = await tx.$queryRaw<{ visible: boolean | null }[]>`SELECT current_tenant_sees_billing_documents() AS visible`;
    const visible = v?.visible !== false;
    const docs = visible
      ? await tx.$queryRaw<DocumentRow[]>`
          SELECT DISTINCT document_id, kind::text AS kind, currency, total, due_date, issue_date, created_at FROM current_tenant_billing_documents()`
      : [];
    const subscription = docs.filter((d) => d.kind === 'SUBSCRIPTION');
    const credits = docs.filter((d) => d.kind === 'CREDIT_NOTE');
    const last = [...subscription].sort((a, b) => b.issue_date.getTime() - a.issue_date.getTime() || b.created_at.getTime() - a.created_at.getTime())[0];
    return {
      currency,
      groupPending: visible ? null : GROUP_SCHOOL_PENDING,
      documents: subscription.length,
      requested: visible && subscription.length ? subscription.reduce((n, d) => n + d.total, 0) - credits.reduce((n, d) => n + d.total, 0) : null,
      dueDate: iso(last?.due_date),
      mention: PROVISIONAL_MENTION,
      payment: 'Aucun paiement validé par Cahiora pour le moment.',
      paymentMeans: [] as { kind: string; label: string }[],
      paymentMeansNote: 'Aucun moyen de paiement n’est encore activé par Cahiora : envoyez une demande de régularisation, Cahiora vous répondra.',
    };
  }

  /**
   * Acceptation des conditions commerciales en vigueur (§4, étape 2) par la direction de tout l'établissement. La base
   * refait chaque contrôle, fige le tarif du jour et inscrit l'acceptation dans l'historique, dans la même transaction.
   * Ensuite, le document provisoire de la fin de la gratuité part aussitôt s'il est calculable (lot G5c, D-G5-1) ; sinon
   * la tâche planifiée le reprendra. L'acceptation ne dépend jamais de lui.
   */
  async accept(actor: Actor, dto: AcceptTermsDto) {
    const r = await this.acceptTerms(actor, dto);
    await this.documents?.forTenant(actor.tenantId);
    return r;
  }

  private acceptTerms(actor: Actor, dto: AcceptTermsDto) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const { today, s } = await this.read(tx, actor.tenantId);
      if (!s) throw new ConflictException('Aucun abonnement n’est encore ouvert pour votre établissement');
      if (!awaitsAcceptance(s)) throw new ConflictException(`L’abonnement n’attend pas d’acceptation (état : ${STATUS_LABELS[s.status]})`);
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

  @Post('settings/subscription/accept') @AllowedWhenLimited() @Can('settings.manage') @WholeSchool() @Throttle({ default: { limit: 10, ttl: 60000 } })
  accept(@CurrentActor() a: Actor, @Body() dto: AcceptTermsDto) { return this.s.accept(a, dto); }
}
