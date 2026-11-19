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
import { accessPhase, AccessPhase, AccessState, extensionError, PAYMENT_MEANS_ACTIVE, requestError, restoredStatus } from './access-rules';
import { BillingService } from './billing';
import { frDay, STATUS_LABELS, SubscriptionStatus } from './billing-rules';
import { notifyDirection } from './billing-tasks';

/**
 * Accès selon le paiement de l'abonnement (lot G5d-1), décisions de Dankou du 19 novembre 2026 (D-G5-30 A, D-G5-41 A,
 * D-G5-42 A, D-G5-43 A) :
 * - la direction de tout l'établissement envoie une demande de régularisation tant qu'aucun moyen de paiement n'est
 *   activé ; horodatée et journalisée, elle retient la limitation automatique tant qu'elle attend la réponse de Cahiora ;
 * - le Super Admin répond à la demande et peut prolonger l'accès complet (date de fin obligatoire, motif interne,
 *   code de son application d'authentification) ; une prolongation lève une limitation en cours ;
 * - la tâche planifiée (BillingJobsService) envoie les rappels et pose la limitation quand le délai est passé.
 * Aucun paiement ni encaissement ici : le paiement validé, seul retour à l'accès complet hors prolongation, arrive avec
 * le lot G5d-2 (D-G5-33 et validation juridique et fiscale).
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
  const m = text.match(/CAHIORA: ([^\n"]+)/);
  if (!m) return null;
  const s = m[1].trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** État d'accès d'un abonnement pour les règles du lot (sans base). */
export const accessStateOf = (s: { status: SubscriptionStatus | DbStatus; graceEnd: Date | null; extendedUntil: Date | null }, pendingRequest: boolean): AccessState => ({
  status: s.status as SubscriptionStatus, graceEnd: iso(s.graceEnd), extendedUntil: iso(s.extendedUntil), pendingRequest, paymentMeansActive: PAYMENT_MEANS_ACTIVE,
});

type AccessRow = {
  status: SubscriptionStatus; grace_start: Date | null; grace_end: Date | null; extended_until: Date | null; limited_since: Date | null; terms_accepted: boolean; pending_request: boolean;
};

/**
 * Accès de l'école courante (transaction ouverte sur elle), lu par sa fonction de la base : jamais le motif d'une
 * prolongation ni l'abonnement d'une autre école. null sans abonnement.
 */
export async function schoolAccess(tx: Tx, today: string) {
  const [r] = await tx.$queryRaw<AccessRow[]>`SELECT * FROM current_tenant_subscription_access()`;
  if (!r) return null;
  const view = accessPhase(accessStateOf({ status: r.status, graceEnd: r.grace_end, extendedUntil: r.extended_until }, r.pending_request), today);
  return {
    today, status: r.status, statusLabel: STATUS_LABELS[r.status], ...view,
    graceStart: iso(r.grace_start), graceEnd: iso(r.grace_end), extendedUntil: iso(r.extended_until), limitedSince: r.limited_since,
    termsAccepted: r.terms_accepted, pendingRequest: r.pending_request, paymentMeansActive: PAYMENT_MEANS_ACTIVE,
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
      const a = await schoolAccess(tx, localDay(t.timezone));
      const error = requestError(a?.status ?? null, !!a?.pendingRequest);
      if (error) throw new ConflictException(error);
      try {
        const [r] = await tx.$queryRaw<{ id: string }[]>`SELECT request_regularization(${actor.userId}::uuid, ${actor.name}, ${message}, ${actor.ip ?? null}) AS id`;
        await this.audit.log(tx, actor, 'billing.regularization_requested', 'RegularizationRequest', r.id, { status: a!.status, phase: a!.phase, message });
        return { id: r.id, requests: await schoolRequests(tx), access: await schoolAccess(tx, a!.today) };
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
const PHASE_ORDER: Record<AccessPhase, number> = { HELD: 0, DUE: 1, LIMITED: 2, GRACE: 3, EXTENDED: 4, WAITING: 5, ACTIVE: 6, FREE: 7 };

@Injectable()
export class PlatformAccessService {
  constructor(private db: PlatformDb, private billing: BillingService) {}

  /** Clients en attente ou en accès limité, demandes de régularisation et réponses. */
  async overview() {
    const subs = await this.db.subscription.findMany({
      where: { status: { in: ['AWAITING_ACCEPTANCE', 'AWAITING_PAYMENT', 'LIMITED'] } },
      include: { tenant: { select: { id: true, name: true, timezone: true, group: { select: { id: true, name: true } } } } },
    });
    const pending = new Map((await this.db.regularizationRequest.findMany({ where: { status: 'PENDING' } })).map((r) => [r.tenantId, r]));
    const requests = await this.db.regularizationRequest.findMany({ orderBy: { requestedAt: 'desc' }, take: 100, include: { tenant: { select: { name: true } } } });
    const clients = subs.map((s) => {
      const today = localDay(s.tenant.timezone);
      const p = pending.get(s.tenantId) ?? null;
      return {
        tenantId: s.tenantId, tenantName: s.tenant.name, group: s.tenant.group.name, today, status: s.status, statusLabel: STATUS_LABELS[s.status], statusSince: s.statusSince,
        ...accessPhase(accessStateOf(s, !!p), today),
        graceStart: iso(s.graceStart), graceEnd: iso(s.graceEnd), extendedUntil: iso(s.extendedUntil), limitedSince: s.limitedSince, termsAccepted: !!s.acceptedAt,
        pendingRequest: p && { id: p.id, message: p.message, requestedByName: p.requestedByName, requestedAt: p.requestedAt },
      };
    }).sort((a, b) => PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase] || (a.daysLeft ?? 0) - (b.daysLeft ?? 0) || a.tenantName.localeCompare(b.tenantName));
    return {
      paymentMeansActive: PAYMENT_MEANS_ACTIVE,
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
   * Prolongation exceptionnelle de l'accès complet (D-G5-43 A) : abonnement en attente ou en accès limité, date de fin
   * à partir d'aujourd'hui, après le délai de grâce et au plus un an plus tard, motif obligatoire (jamais montré à
   * l'école). Une nouvelle date remplace la précédente. En accès limité, la limitation est levée tout de suite :
   * l'abonnement revient en attente d'acceptation ou de paiement. Rien n'est payé ni encaissé.
   */
  async extend(actor: PlatformActor, tenantId: string, dto: ExtensionDto) {
    const t = await this.db.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, groupId: true, timezone: true } });
    if (!t) throw new NotFoundException('Établissement introuvable');
    const s = await this.db.subscription.findUnique({ where: { tenantId } });
    if (!s) throw new ConflictException('Cet établissement n’a pas encore d’abonnement');
    const today = localDay(t.timezone);
    const error = extensionError(s.status, dto.until, today, iso(s.graceEnd));
    if (error) throw new BadRequestException(error);
    if (dto.until === iso(s.extendedUntil)) throw new BadRequestException('Cette date est déjà la fin de la prolongation');
    await this.billing.confirm(actor, dto.code);
    const reason = dto.reason.trim();
    const lifted = s.status === 'LIMITED';
    const to = lifted ? restoredStatus(s.acceptedAt) : s.status;
    const result = await this.db.$transaction(async (tx) => {
      const now = new Date();
      const n = await tx.subscription.updateMany({
        where: { id: s.id, status: s.status, extendedUntil: s.extendedUntil },
        data: { extendedUntil: day(dto.until), ...(lifted ? { status: to, statusSince: now, limitedSince: null } : {}) },
      });
      if (n.count !== 1) throw new ConflictException('L’abonnement vient de changer : rechargez la page');
      const data = { until: dto.until, previousUntil: iso(s.extendedUntil), graceEnd: iso(s.graceEnd), limitationLifted: lifted };
      await tx.subscriptionEvent.create({
        data: { subscriptionId: s.id, tenantId, kind: 'ACCESS_EXTENDED', fromStatus: s.status, toStatus: to, data, reason, actorKind: 'platform', actorId: actor.id, actorName: actor.name, ip: actor.ip ?? null },
      });
      await this.journals(tx, actor, t, 'billing.access_extended', data, reason);
      await notifyDirection(tx, tenantId, 'billing.access_extended', 'Accès complet prolongé par Cahiora',
        `Cahiora prolonge l’accès complet de votre établissement jusqu’au ${frDay(dto.until)} inclus${lifted ? ' : l’accès limité est levé dès maintenant' : ''}. `
        + 'Pensez à régulariser votre abonnement avant cette date dans Paramètres › Abonnement Cahiora. Vos données sont conservées.');
      return { tenantId, status: to, statusLabel: STATUS_LABELS[to], extendedUntil: dto.until, limitationLifted: lifted };
    });
    forgetAccess(tenantId);
    return result;
  }

  /**
   * Réponse de Cahiora à une demande de régularisation, une seule fois, signée « Cahiora » pour l'école. Une demande
   * qui a sa réponse ne retient plus la limitation : si le délai est passé, la tâche planifiée la pose à son prochain
   * passage, sauf prolongation.
   */
  async answer(actor: PlatformActor, id: string, dto: AnswerDto) {
    const r = await this.db.regularizationRequest.findUnique({ where: { id }, include: { tenant: { select: { id: true, name: true, groupId: true, timezone: true } } } });
    if (!r) throw new NotFoundException('Demande introuvable');
    if (r.status !== 'PENDING') throw new ConflictException('Cette demande a déjà sa réponse');
    const answer = dto.answer.trim();
    if (answer.length < 5) throw new BadRequestException(ANSWER.message);
    await this.billing.confirm(actor, dto.code);
    await this.db.$transaction(async (tx) => {
      const n = await tx.regularizationRequest.updateMany({
        where: { id, status: 'PENDING' }, data: { status: 'ANSWERED', answeredById: actor.id, answeredByName: actor.name, answeredAt: new Date(), answer },
      });
      if (n.count !== 1) throw new ConflictException('Cette demande vient de recevoir sa réponse : rechargez la page');
      const s = await tx.subscription.findUniqueOrThrow({ where: { id: r.subscriptionId }, select: { status: true } });
      const data = { requestId: id, requestedAt: r.requestedAt.toISOString(), answer };
      await tx.subscriptionEvent.create({
        data: { subscriptionId: r.subscriptionId, tenantId: r.tenantId, kind: 'REGULARIZATION_ANSWERED', fromStatus: s.status, toStatus: s.status, data, actorKind: 'platform', actorId: actor.id, actorName: actor.name, ip: actor.ip ?? null },
      });
      await this.journals(tx, actor, r.tenant, 'billing.regularization_answered', data);
      await notifyDirection(tx, r.tenantId, 'billing.regularization_answered', 'Réponse de Cahiora à votre demande de régularisation',
        `${answer}\n\nVotre demande du ${r.requestedAt.toLocaleDateString('fr-FR', { timeZone: r.tenant.timezone })} et cette réponse restent dans Paramètres › Abonnement Cahiora.`);
    });
    forgetAccess(r.tenantId);
    return { ok: true };
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
