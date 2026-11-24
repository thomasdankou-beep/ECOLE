import {
  BadRequestException, Body, ConflictException, Controller, Get, Header, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Req, UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Prisma, SubscriptionStatus as DbStatus } from '@prisma/client';
import { IsOptional, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import { AuditService } from '../../common/audit.service';
import { Actor, AllowedWhenLimited, Can, CurrentActor, forgetAccess, Public, WholeSchool } from '../../common/auth';
import { localDay } from '../../common/country';
import { PrismaService, Tx } from '../../common/prisma.service';
import { groupLog, PlatformActor, platformLog, schoolLogInTx } from '../platform/group-journal';
import { PlatformDb, PlatformGuard } from '../platform/platform';
import {
  accessPhase, AccessPhase, AccessState, AccessView, AnswerOutcome, answerOutcome, answerOutcomeText, currentExtension, dayStart, extensionError, extensionKind,
  extensionMaxUntil, frDateTime, requestError, restoredStatus,
} from './access-rules';
import { BillingService, PLATFORM_TZ } from './billing';
import { frDay, ParameterKey, STATUS_LABELS, SubscriptionStatus, versionOn } from './billing-rules';
import { notifyDirection } from './billing-tasks';
import { meansVersions, paymentMeansActiveFor } from './payments-access';
import { meansOn, paymentsUnlocked } from './payments-rules';

/**
 * Accès selon le paiement de l'abonnement (lot G5d-1), décisions de Dankou du 19 novembre 2026 (D-G5-30 A, D-G5-41 A,
 * D-G5-42 A, D-G5-43 A) :
 * - la direction de tout l'établissement envoie une demande de régularisation tant qu'aucun moyen de paiement n'est
 *   activé ; horodatée et journalisée, elle retient la limitation automatique tant qu'elle attend la réponse de Cahiora ;
 * - le Super Admin répond à la demande et peut prolonger l'accès complet (date de fin obligatoire, motif interne,
 *   code de son application d'authentification) ; une prolongation lève une limitation en cours ;
 * - la tâche planifiée (BillingJobsService) envoie les rappels et pose la limitation quand le délai est passé.
 * Lectures 7 A et 9 A, validées par Dankou le 20 novembre 2026 : la réponse de Cahiora laisse au moins 48 heures avant
 * la limitation (préavis, une seule fois par échéance) et dit à la direction le jour et l'heure de la limitation ; le
 * Super Admin les lit avant d'envoyer sa réponse. Chaque prolongation dure 30 jours au plus ; une nouvelle prolongation
 * pour la même échéance est un renouvellement exceptionnel, avec son propre motif, marqué au journal et dans la liste.
 * Aucun paiement ni encaissement ici : le paiement validé, seul retour à l'accès complet hors prolongation, vient du
 * lot G5d-2 (billing-payments, choix 2 A), fermé tant que D-G5-33 et la validation juridique et fiscale manquent ; un
 * moyen de paiement activé pour l'établissement (verrou 1 ouvert, verrou 2 activé) lève la règle D-G5-42 A.
 */

const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

const DAY = { message: 'Date attendue au format AAAA-MM-JJ' };
const MOTIF = { message: 'Motif : 5 à 300 caractères' };
const CODE = { message: 'Code de votre application d’authentification : 6 chiffres' };
const ANSWER = { message: 'Réponse : 5 à 2 000 caractères' };

export class RegularizationRequestDto {
  @IsOptional() @IsString() @MaxLength(1000, { message: 'Message : 1 000 caractères au plus' }) message?: string;
}

export class ExtensionDto {
  @IsString(CODE) @Length(6, 8, CODE) code: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/, DAY) until: string;
  @IsString(MOTIF) @MinLength(5, MOTIF) @MaxLength(300, MOTIF) reason: string;
}

export class AnswerDto {
  @IsString(CODE) @Length(6, 8, CODE) code: string;
  @IsString(ANSWER) @MinLength(5, ANSWER) @MaxLength(2000, ANSWER) answer: string;
}

/** Erreur d'une fonction de la base (préfixe « CAHIORA: ») rendue à l'écran ; toute autre erreur reste une erreur. */
export function cahioraMessage(e: unknown) {
  const text = e instanceof Error ? e.message : String(e);
  const m = text.match(/CAHIORA: ([^\n"`]+)/);
  if (!m) return null;
  const s = m[1].trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Préavis inscrit pour l'échéance en cours (même fin du délai de grâce), ou null (lecture 7 A). */
export const currentNotice = (s: { graceEnd: Date | null; noticeUntil: Date | null; noticeGraceEnd: Date | null }) =>
  (s.noticeUntil && iso(s.noticeGraceEnd) === iso(s.graceEnd) ? s.noticeUntil : null);

/**
 * État d'accès d'un abonnement pour les règles du lot (sans base). `noticeUntil` : fin du préavis de l'échéance en
 * cours seulement (currentNotice, ou la fonction de l'école qui le filtre déjà). `paymentMeansActive` : l'établissement
 * peut payer Cahiora ce jour-là (lot G5d-2 ; faux tant que les verrous sont fermés).
 */
export const accessStateOf = (
  s: { status: SubscriptionStatus | DbStatus; graceEnd: Date | null; extendedUntil: Date | null }, pendingRequest: boolean, noticeUntil: Date | null, timezone: string,
  paymentMeansActive = false,
): AccessState => ({
  status: s.status as SubscriptionStatus, graceEnd: iso(s.graceEnd), extendedUntil: iso(s.extendedUntil), pendingRequest, paymentMeansActive,
  notice: noticeUntil ? { until: noticeUntil, lastDay: localDay(timezone, noticeUntil) } : null,
});

/** Jour et heure de la fin d'un préavis en cours, à l'heure de l'établissement (« 3 décembre 2026 à 14 h 05 »). */
export const limitedAtLabel = (view: AccessView, timezone: string) => (view.limitedAt ? frDateTime(new Date(view.limitedAt), timezone) : null);

/** Valeur d'un paramètre daté sans monnaie, en vigueur le jour donné ; null sans version en vigueur. */
export async function parameterOn(db: Pick<Prisma.TransactionClient, 'billingParameter'>, key: ParameterKey, day: string) {
  const versions = (await db.billingParameter.findMany({ where: { key, currency: null } })).map((p) => ({ ...p, effectiveFrom: iso(p.effectiveFrom)! }));
  return versionOn(versions, key, null, day)?.value ?? null;
}

/** Issue d'une réponse telle que l'écran la lit : nature, instant de la limitation et son libellé, durée du préavis. */
export function outcomeView(o: AnswerOutcome, timezone: string) {
  return {
    kind: o.kind, limitedAt: o.limitedAt?.toISOString() ?? null, limitedAtLabel: o.limitedAt ? frDateTime(o.limitedAt, timezone) : null, noticeHours: o.hours,
    noticeGiven: o.noticeGiven,
  };
}

type AccessRow = {
  status: SubscriptionStatus; grace_start: Date | null; grace_end: Date | null; extended_until: Date | null; limited_since: Date | null; terms_accepted: boolean; pending_request: boolean;
  notice_until: Date | null;
};

/**
 * Accès de l'école courante (transaction ouverte sur elle), lu par sa fonction de la base : jamais le motif d'une
 * prolongation ni l'abonnement d'une autre école. null sans abonnement.
 */
export async function schoolAccess(tx: Tx, timezone: string, now = new Date()) {
  const [r] = await tx.$queryRaw<AccessRow[]>`SELECT * FROM current_tenant_subscription_access()`;
  if (!r) return null;
  const today = localDay(timezone, now);
  // Moyens de paiement activés pour l'école ce jour-là (lot G5d-2) : aucun tant que le verrou 1 est fermé, ni pour l'école d'un groupe.
  const means = paymentsUnlocked() ? await tx.$queryRaw<{ code: string }[]>`SELECT code FROM current_tenant_payment_means(${today}::date)` : [];
  const paymentMeansActive = means.length > 0;
  const view = accessPhase(
    accessStateOf({ status: r.status, graceEnd: r.grace_end, extendedUntil: r.extended_until }, r.pending_request, r.notice_until, timezone, paymentMeansActive), today, now,
  );
  return {
    today, status: r.status, statusLabel: STATUS_LABELS[r.status], ...view, limitedAtLabel: limitedAtLabel(view, timezone),
    graceStart: iso(r.grace_start), graceEnd: iso(r.grace_end), extendedUntil: iso(r.extended_until), limitedSince: r.limited_since,
    termsAccepted: r.terms_accepted, pendingRequest: r.pending_request, paymentMeansActive,
  };
}

export type SchoolAccess = NonNullable<Awaited<ReturnType<typeof schoolAccess>>>;

type RequestRow = { id: string; status: string; message: string | null; requested_by_name: string; requested_at: Date; answered_at: Date | null; answer: string | null };

/** Demandes de régularisation de l'école courante, les plus récentes d'abord ; la réponse est signée « Cahiora ». */
export async function schoolRequests(tx: Tx) {
  const rows = await tx.$queryRaw<RequestRow[]>`SELECT * FROM current_tenant_regularization_requests()`;
  return rows.map((r) => ({
    id: r.id, status: r.status as 'PENDING' | 'ANSWERED', message: r.message, requestedByName: r.requested_by_name, requestedAt: r.requested_at, answeredAt: r.answered_at,
    answer: r.answer,
  }));
}

// ---------------------------------------------------------------- Direction de l'établissement

@Injectable()
export class SchoolAccessService {
  constructor(private db: PrismaService, private audit: AuditService) {}

  /**
   * Demande de régularisation de la direction de tout l'établissement (D-G5-42 A) : abonnement en attente ou en accès
   * limité, une seule à la fois. La base refait chaque contrôle, horodate la demande et l'inscrit dans l'historique et
   * les journaux de la plateforme et du groupe, avec une alerte pour le Super Admin ; l'API trace le journal de l'école.
   */
  request(actor: Actor, dto: RegularizationRequestDto) {
    const message = dto.message?.trim() || null;
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const t = await tx.tenant.findUniqueOrThrow({ where: { id: actor.tenantId }, select: { timezone: true } });
      const a = await schoolAccess(tx, t.timezone);
      const error = requestError(a?.status ?? null, !!a?.pendingRequest);
      if (error) throw new ConflictException(error);
      try {
        const [r] = await tx.$queryRaw<{ id: string }[]>`SELECT request_regularization(${actor.userId}::uuid, ${actor.name}, ${message}, ${actor.ip ?? null}) AS id`;
        await this.audit.log(tx, actor, 'billing.regularization_requested', 'RegularizationRequest', r.id, { status: a!.status, phase: a!.phase, message });
        return { id: r.id, requests: await schoolRequests(tx), access: await schoolAccess(tx, t.timezone) };
      } catch (e) {
        const m = cahioraMessage(e);
        if (m) throw new BadRequestException(m);
        throw e;
      }
    });
  }
}

@ApiTags('Paramètres')
@Controller()
export class SchoolAccessController {
  constructor(private s: SchoolAccessService) {}

  /** Toujours ouverte, même pendant l'accès limité : c'est la voie de la régularisation (D-G5-30 A). */
  @Post('settings/subscription/regularization-requests') @AllowedWhenLimited() @Can('settings.manage')
  @WholeSchool('Seule la direction de tout l’établissement demande une régularisation')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  request(@CurrentActor() a: Actor, @Body() dto: RegularizationRequestDto) { return this.s.request(a, dto); }
}

// ---------------------------------------------------------------- Super Admin

/** Ordre de la liste du Super Admin : ce qui demande une action d'abord. */
const PHASE_ORDER: Record<AccessPhase, number> = { HELD: 0, DUE: 1, NOTICE: 2, LIMITED: 3, GRACE: 4, EXTENDED: 5, WAITING: 6, ACTIVE: 7, FREE: 8 };

/** Prolongations (lecture 9 A) : une première, un renouvellement exceptionnel, ou une fin avancée. */
const EXTENSION_EVENT = { first: 'ACCESS_EXTENDED', renewal: 'ACCESS_EXTENSION_RENEWED', shortened: 'ACCESS_EXTENSION_SHORTENED' } as const;
const EXTENSION_ACTION = { first: 'billing.access_extended', renewal: 'billing.access_extension_renewed', shortened: 'billing.access_extension_shortened' } as const;
const sameReason = (a: string, b: string) => a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase();

@Injectable()
export class PlatformAccessService {
  constructor(private db: PlatformDb, private billing: BillingService) {}

  /**
   * Clients en attente ou en accès limité, demandes de régularisation et réponses. Pour chaque demande en attente, ce
   * que la réponse changerait (lecture 7 A : jour et heure de la limitation, préavis) ; pour chaque client, la date de
   * fin la plus tardive d'une prolongation et ses renouvellements exceptionnels pour l'échéance en cours (lecture 9 A).
   */
  async overview() {
    const now = new Date();
    // Établissements clients réels seulement : un établissement de test n'est jamais en attente ni limité.
    const subs = await this.db.subscription.findMany({
      where: { status: { in: ['AWAITING_ACCEPTANCE', 'AWAITING_PAYMENT', 'LIMITED'] }, tenant: { commercialStatus: 'CLIENT' } },
      include: { tenant: { select: { id: true, name: true, timezone: true, currency: true, group: { select: { id: true, name: true, _count: { select: { tenants: true } } } } } } },
    });
    // Moyens de paiement (lot G5d-2) : aucun tant que le verrou 1 est fermé.
    const versions = await meansVersions(this.db);
    const pending = new Map((await this.db.regularizationRequest.findMany({ where: { status: 'PENDING' } })).map((r) => [r.tenantId, r]));
    const requests = await this.db.regularizationRequest.findMany({ orderBy: { requestedAt: 'desc' }, take: 100, include: { tenant: { select: { name: true } } } });
    const params = (await this.db.billingParameter.findMany({ where: { key: { in: ['NOTICE_HOURS', 'EXTENSION_MAX_DAYS'] }, currency: null } }))
      .map((p) => ({ ...p, effectiveFrom: iso(p.effectiveFrom)! }));
    const renewals = await this.db.subscriptionEvent.findMany({ where: { kind: EXTENSION_EVENT.renewal, tenantId: { in: subs.map((s) => s.tenantId) } }, select: { tenantId: true, data: true } });
    const clients = subs.map((s) => {
      const tz = s.tenant.timezone;
      const today = localDay(tz, now);
      const p = pending.get(s.tenantId) ?? null;
      const notice = currentNotice(s);
      const meansActive = paymentMeansActiveFor(versions, { currency: s.tenant.currency, alone: s.tenant.group._count.tenants === 1 }, today);
      const view = accessPhase(accessStateOf(s, !!p, notice, tz, meansActive), today, now);
      const graceEnd = iso(s.graceEnd);
      const maxDays = versionOn(params, 'EXTENSION_MAX_DAYS', null, today)?.value ?? null;
      const afterAnswer = p
        ? outcomeView(answerOutcome(accessPhase(accessStateOf(s, false, notice, tz), today, now), now, versionOn(params, 'NOTICE_HOURS', null, today)?.value ?? null, !!notice,
          (d) => dayStart(d, tz)), tz)
        : null;
      return {
        tenantId: s.tenantId, tenantName: s.tenant.name, group: s.tenant.group.name, today, status: s.status, statusLabel: STATUS_LABELS[s.status], statusSince: s.statusSince,
        paymentMeansActive: meansActive,
        ...view, limitedAtLabel: limitedAtLabel(view, tz),
        graceStart: iso(s.graceStart), graceEnd, extendedUntil: iso(s.extendedUntil), limitedSince: s.limitedSince, termsAccepted: !!s.acceptedAt,
        noticeUntil: notice, noticeUntilLabel: notice ? frDateTime(notice, tz) : null,
        pendingRequest: p && { id: p.id, message: p.message, requestedByName: p.requestedByName, requestedAt: p.requestedAt },
        afterAnswer,
        extension: {
          current: currentExtension(graceEnd, iso(s.extendedUntil)), maxDays, maxUntil: extensionMaxUntil(today, graceEnd, iso(s.extendedUntil), maxDays),
          renewals: renewals.filter((e) => e.tenantId === s.tenantId && (e.data as { graceEnd?: string | null } | null)?.graceEnd === graceEnd).length,
        },
      };
    }).sort((a, b) => PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase] || (a.daysLeft ?? 0) - (b.daysLeft ?? 0) || a.tenantName.localeCompare(b.tenantName));
    return {
      // Au moins un moyen de paiement activé aujourd'hui (verrou 1 ouvert) ; chaque client dit s'il peut payer.
      paymentMeansActive: paymentsUnlocked() && meansOn(versions, localDay(PLATFORM_TZ, now)).some((m) => m.active),
      clients,
      requests: requests.map((r) => ({
        id: r.id, tenantId: r.tenantId, tenantName: r.tenant.name, status: r.status, subscriptionStatus: r.subscriptionStatus, subscriptionStatusLabel: STATUS_LABELS[r.subscriptionStatus],
        message: r.message, requestedByName: r.requestedByName, requestedAt: r.requestedAt, answeredByName: r.answeredByName, answeredAt: r.answeredAt, answer: r.answer,
      })),
    };
  }

  /** Journaux de la plateforme (avec le motif), du groupe et de l'établissement (sans lui), dans la transaction. */
  private async journals(tx: Prisma.TransactionClient, actor: PlatformActor, t: { id: string; name: string; groupId: string }, action: string, data: Record<string, unknown>, reason?: string) {
    await platformLog(tx, actor, action, t.id, reason ? { ...data, reason } : data);
    await groupLog(tx, actor, [{ groupId: t.groupId, action, data: { tenantName: t.name, ...data } }]);
    await schoolLogInTx(tx, actor, t.id, action, data);
  }

  /**
   * Prolongation exceptionnelle de l'accès complet (D-G5-43 A, lecture 9 A) : abonnement en attente ou en accès limité,
   * date de fin à partir d'aujourd'hui, après le délai de grâce, 30 jours au plus (paramètre daté) depuis la fin de
   * l'accès complet en cours ou depuis aujourd'hui si elle est passée, et jamais plus d'un an plus tard ; motif
   * obligatoire (jamais montré à l'école). Une nouvelle date plus tardive pour la même échéance est un renouvellement
   * exceptionnel : son propre motif, différent du précédent, et une marque au journal et dans la liste des clients ;
   * une date plus proche avance la fin, sans être un renouvellement. En accès limité, la limitation est levée tout de
   * suite : l'abonnement revient en attente d'acceptation ou de paiement. Rien n'est payé ni encaissé.
   */
  async extend(actor: PlatformActor, tenantId: string, dto: ExtensionDto) {
    const t = await this.db.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, groupId: true, timezone: true } });
    if (!t) throw new NotFoundException('Établissement introuvable');
    const s = await this.db.subscription.findUnique({ where: { tenantId } });
    if (!s) throw new ConflictException('Cet établissement n’a pas encore d’abonnement');
    const today = localDay(t.timezone);
    const graceEnd = iso(s.graceEnd);
    const previous = iso(s.extendedUntil);
    const maxDays = await parameterOn(this.db, 'EXTENSION_MAX_DAYS', today);
    const error = extensionError(s.status, dto.until, today, graceEnd, previous, maxDays);
    if (error) throw new BadRequestException(error);
    if (dto.until === previous) throw new BadRequestException('Cette date est déjà la fin de la prolongation');
    const kind = extensionKind(dto.until, graceEnd, previous);
    const reason = dto.reason.trim();
    if (kind === 'renewal') {
      const last = await this.db.subscriptionEvent.findFirst({
        where: { subscriptionId: s.id, kind: { in: Object.values(EXTENSION_EVENT) } }, orderBy: { createdAt: 'desc' }, select: { reason: true },
      });
      if (last?.reason && sameReason(last.reason, reason)) {
        throw new BadRequestException('Renouvellement exceptionnel : donnez son propre motif, différent de celui de la prolongation précédente');
      }
    }
    await this.billing.confirm(actor, dto.code);
    const lifted = s.status === 'LIMITED';
    const to = lifted ? restoredStatus(s.acceptedAt) : s.status;
    const result = await this.db.$transaction(async (tx) => {
      const now = new Date();
      const n = await tx.subscription.updateMany({
        where: { id: s.id, status: s.status, extendedUntil: s.extendedUntil },
        data: { extendedUntil: day(dto.until), ...(lifted ? { status: to, statusSince: now, limitedSince: null } : {}) },
      });
      if (n.count !== 1) throw new ConflictException('L’abonnement vient de changer : rechargez la page');
      const data = {
        until: dto.until, previousUntil: previous, graceEnd, limitationLifted: lifted, kind, maxDays,
        ...(kind === 'renewal' ? { label: 'Renouvellement exceptionnel' } : {}),
      };
      await tx.subscriptionEvent.create({
        data: { subscriptionId: s.id, tenantId, kind: EXTENSION_EVENT[kind], fromStatus: s.status, toStatus: to, data, reason, actorKind: 'platform', actorId: actor.id, actorName: actor.name, ip: actor.ip ?? null },
      });
      await this.journals(tx, actor, t, EXTENSION_ACTION[kind], data, reason);
      const lift = lifted ? ' : l’accès limité est levé dès maintenant' : '';
      const end = ' Pensez à régulariser votre abonnement avant cette date dans Paramètres › Abonnement Cahiora. Vos données sont conservées.';
      if (kind === 'renewal') {
        await notifyDirection(tx, tenantId, EXTENSION_ACTION.renewal, 'Accès complet prolongé à nouveau par Cahiora',
          `Cahiora prolonge à nouveau l’accès complet de votre établissement, à titre exceptionnel, jusqu’au ${frDay(dto.until)} inclus${lift}.${end}`);
      } else if (kind === 'shortened') {
        await notifyDirection(tx, tenantId, EXTENSION_ACTION.shortened, 'Fin de la prolongation avancée par Cahiora',
          `Cahiora avance la fin de la prolongation de l’accès complet de votre établissement au ${frDay(dto.until)} inclus.${end}`);
      } else {
        await notifyDirection(tx, tenantId, EXTENSION_ACTION.first, 'Accès complet prolongé par Cahiora',
          `Cahiora prolonge l’accès complet de votre établissement jusqu’au ${frDay(dto.until)} inclus${lift}.${end}`);
      }
      return { tenantId, status: to, statusLabel: STATUS_LABELS[to], extendedUntil: dto.until, limitationLifted: lifted, kind };
    });
    forgetAccess(tenantId);
    return result;
  }

  /**
   * Réponse de Cahiora à une demande de régularisation, une seule fois, signée « Cahiora » pour l'école. Une demande
   * qui a sa réponse ne retient plus la limitation. Lecture 7 A : jamais moins de 48 heures (paramètre daté) entre la
   * réponse et la limitation ; quand la limitation tomberait plus tôt, un préavis s'ouvre, une seule fois par échéance,
   * et l'accès reste complet jusqu'à sa fin. La réponse dit à la direction le jour et l'heure de la limitation. Sans
   * préavis possible et le délai passé, la tâche planifiée pose la limitation à son prochain passage, sauf prolongation.
   */
  async answer(actor: PlatformActor, id: string, dto: AnswerDto) {
    const r = await this.db.regularizationRequest.findUnique({ where: { id }, include: { tenant: { select: { id: true, name: true, groupId: true, timezone: true } } } });
    if (!r) throw new NotFoundException('Demande introuvable');
    if (r.status !== 'PENDING') throw new ConflictException('Cette demande a déjà sa réponse');
    const answer = dto.answer.trim();
    if (answer.length < 5) throw new BadRequestException(ANSWER.message);
    await this.billing.confirm(actor, dto.code);
    const tz = r.tenant.timezone;
    const outcome = await this.db.$transaction(async (tx) => {
      const now = new Date();
      const n = await tx.regularizationRequest.updateMany({
        where: { id, status: 'PENDING' }, data: { status: 'ANSWERED', answeredById: actor.id, answeredByName: actor.name, answeredAt: now, answer },
      });
      if (n.count !== 1) throw new ConflictException('Cette demande vient de recevoir sa réponse : rechargez la page');
      // Abonnement verrouillé : la tâche planifiée qui limiterait au même instant attend cette réponse et son préavis.
      await tx.$queryRaw`SELECT id FROM subscriptions WHERE id = ${r.subscriptionId}::uuid FOR UPDATE`;
      const s = await tx.subscription.findUniqueOrThrow({ where: { id: r.subscriptionId } });
      const today = localDay(tz, now);
      const notice = currentNotice(s);
      const o = answerOutcome(accessPhase(accessStateOf(s, false, notice, tz), today, now), now, await parameterOn(tx, 'NOTICE_HOURS', today), !!notice, (d) => dayStart(d, tz));
      if (o.kind === 'notice') await tx.subscription.update({ where: { id: s.id }, data: { noticeUntil: o.limitedAt, noticeGraceEnd: s.graceEnd } });
      const view = outcomeView(o, tz);
      const data = {
        requestId: id, requestedAt: r.requestedAt.toISOString(), answer,
        limitation: { kind: view.kind, limitedAt: view.limitedAt, noticeHours: view.noticeHours, graceEnd: iso(s.graceEnd), extendedUntil: iso(s.extendedUntil) },
      };
      await tx.subscriptionEvent.create({
        data: { subscriptionId: r.subscriptionId, tenantId: r.tenantId, kind: 'REGULARIZATION_ANSWERED', fromStatus: s.status, toStatus: s.status, data, actorKind: 'platform', actorId: actor.id, actorName: actor.name, ip: actor.ip ?? null },
      });
      await this.journals(tx, actor, r.tenant, 'billing.regularization_answered', data);
      const limitation = answerOutcomeText(o, tz);
      await notifyDirection(tx, r.tenantId, 'billing.regularization_answered', 'Réponse de Cahiora à votre demande de régularisation',
        `${answer}\n\n${limitation ? `${limitation}\n\n` : ''}Votre demande du ${r.requestedAt.toLocaleDateString('fr-FR', { timeZone: tz })} et cette réponse restent dans Paramètres › Abonnement Cahiora.`);
      return view;
    });
    forgetAccess(r.tenantId);
    return { ok: true, outcome };
  }
}

@ApiTags('Plateforme : facturation')
@Public()
@UseGuards(PlatformGuard)
@Controller()
export class PlatformAccessController {
  constructor(private s: PlatformAccessService) {}

  private actor(req: Request) {
    return (req as any).platformAdmin as PlatformActor;
  }

  @Get('platform/billing/access') @Header('Cache-Control', 'no-store')
  overview() { return this.s.overview(); }

  @Post('platform/billing/access/:tenantId/extension') @Throttle({ default: { limit: 20, ttl: 60000 } })
  extend(@Req() req: Request, @Param('tenantId', ParseUUIDPipe) tenantId: string, @Body() dto: ExtensionDto) { return this.s.extend(this.actor(req), tenantId, dto); }

  @Post('platform/billing/regularization-requests/:id/answer') @Throttle({ default: { limit: 20, ttl: 60000 } })
  answer(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AnswerDto) { return this.s.answer(this.actor(req), id, dto); }
}
