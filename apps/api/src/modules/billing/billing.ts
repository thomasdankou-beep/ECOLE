import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Prisma, Subscription } from '@prisma/client';
import { Equals, IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import type { Request } from 'express';
import { authenticator } from 'otplib';
import { Public } from '../../common/auth';
import { CURRENCIES, localDay } from '../../common/country';
import { decrypt, RawValue } from '../../common/util';
import { config } from '../../config';
import { groupLog, PlatformActor, platformLog, schoolLogInTx } from '../platform/group-journal';
import { PlatformDb, PlatformGuard } from '../platform/platform';
import {
  calendarErrors, CalendarDates, calendarProposal, calendarProposals, daysBetween, daysLeft, frDay, isAdjusted, isDay, isYearLabel, PARAMETER_KEYS, parameterError,
  ParameterKey, PARAMETERS, pilotEndDay, retroactiveChanges, STATUS_LABELS, subscriptionKindLabel, trialEndDay, versionOn, yearDatesError,
} from './billing-rules';
import { CountRecord, countView, sortCounts } from './counts-rules';
import { financialTotals } from './payments-totals';

/**
 * Facturation de Cahiora, lot G5a : paramètres tarifaires datés, conditions commerciales, calendriers des
 * établissements, abonnements (essai, pilote) et leur historique, vus et réglés par le Super Admin.
 * Chaque opération financière exige un code actuel de l'application d'authentification du Super Admin. Chaque
 * écriture est inscrite dans les journaux de la plateforme, du groupe et de l'établissement, dans la même transaction.
 * Rien n'est facturé ici : montants, documents et paiements arrivent avec les lots G5b à G5d.
 */

/** Fuseau de l'éditeur : « aujourd'hui » pour les dates d'effet des paramètres et des conditions. */
export const PLATFORM_TZ = 'Africa/Porto-Novo';

const DAY = { message: 'Date attendue au format AAAA-MM-JJ' };
const MOTIF = { message: 'Motif : 5 à 300 caractères' };
const CODE = { message: 'Code de votre application d’authentification : 6 chiffres' };

class CodeDto {
  @IsString(CODE) @Length(6, 8, CODE) code: string;
}

export class ParameterDto extends CodeDto {
  @IsIn(PARAMETER_KEYS, { message: 'Paramètre inconnu' }) key: ParameterKey;
  @IsOptional() @IsIn(CURRENCIES, { message: 'Monnaie non prise en charge' }) currency?: string | null;
  @IsInt({ message: 'Valeur : nombre entier' }) value: number;
  @Matches(/^\d{4}-\d{2}-\d{2}$/, DAY) effectiveFrom: string;
  @IsString(MOTIF) @MinLength(5, MOTIF) @MaxLength(300, MOTIF) reason: string;
}

/**
 * Réserve de Dankou du 20 novembre 2026 : aucune condition fictive ou de test ne doit être présentée comme un contrat réel.
 * Une version publiée est montrée aux directions, qui l'acceptent au nom de l'établissement (même en accès limité) :
 * le Super Admin atteste à chaque publication qu'il s'agit du texte définitif et validé. L'attestation est inscrite au journal.
 */
export const TERMS_ATTESTATION =
  'Je confirme que ce texte est la version définitive des conditions commerciales de Cahiora, validée pour être proposée aux établissements. Ce n’est ni un texte d’essai ni un exemple.';
const ATTEST = { message: 'Cochez la confirmation : seule la version définitive et validée des conditions commerciales de Cahiora peut être publiée, jamais un texte d’essai.' };

export class TermsDto extends CodeDto {
  @IsString() @MinLength(3, { message: 'Titre : au moins 3 caractères' }) @MaxLength(160) title: string;
  @IsString() @MinLength(20, { message: 'Texte des conditions : au moins 20 caractères' }) @MaxLength(30000) body: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/, DAY) effectiveFrom: string;
  @RawValue() @IsBoolean(ATTEST) @Equals(true, ATTEST) definitive: boolean;
}

export class TrialDto extends CodeDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, DAY) startDate: string;
  @IsOptional() @IsString() @MaxLength(300, MOTIF) reason?: string;
}

export class PilotDto extends CodeDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, DAY) startDate: string;
  @IsOptional() @IsInt({ message: 'Durée : nombre entier de mois' }) @Min(1) @Max(24) months?: number;
  @IsString(MOTIF) @MinLength(5, MOTIF) @MaxLength(300, MOTIF) reason: string;
}

export class PilotEndDto extends CodeDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, DAY) pilotEnd: string;
  @IsString(MOTIF) @MinLength(5, MOTIF) @MaxLength(300, MOTIF) reason: string;
}

/**
 * Statut commercial d'un établissement (demande de Dankou du 20 novembre 2026) : tous les établissements présents avant
 * ce lot servent aux tests ; un établissement de test n'est jamais facturé ni limité. Le statut se change seulement tant
 * qu'aucun abonnement ni aucun document n'existe, avec un motif, le code et, vers « client réel », une confirmation.
 */
export const CLIENT_ATTESTATION =
  'Je confirme que cet établissement est un client commercial réel de Cahiora : il pourra recevoir un essai, un pilote, des documents provisoires et des demandes de paiement.';
const CLIENT_ATTEST = { message: 'Cochez la confirmation : seul un client commercial réel de Cahiora passe en « client réel ».' };
export const COMMERCIAL_STATUS_LABELS = { TEST: 'Établissement de test', CLIENT: 'Client réel' } as const;
/** Refus du changement de statut, par l'API comme par la base (tenants_commercial_status_guard). */
export const COMMERCIAL_STATUS_FROZEN =
  'Le statut commercial se change seulement tant qu’aucun abonnement ni aucun document de Cahiora n’existe pour l’établissement';
/** Ce que l'établissement de test ne peut pas recevoir, dit au Super Admin et à la direction. */
export const TEST_ESTABLISHMENT_NOTE =
  'Établissement de test : aucun essai, pilote, abonnement, comptage, document, paiement ni accès limité. Seul le Super Admin le passe en client réel.';

export class CommercialStatusDto extends CodeDto {
  @IsIn(['TEST', 'CLIENT'], { message: 'Statut commercial inconnu' }) status: 'TEST' | 'CLIENT';
  @IsString(MOTIF) @MinLength(5, MOTIF) @MaxLength(300, MOTIF) reason: string;
  @IsOptional() @RawValue() @IsBoolean(CLIENT_ATTEST) confirmed?: boolean;
}

export class CalendarDto extends CodeDto {
  @Matches(/^\d{4}(-\d{4})?$/, { message: 'Année scolaire : 2026-2027, ou 2027 pour une année civile' }) yearLabel: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/, DAY) startDate: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/, DAY) endDate: string;
  @IsOptional() @Matches(/^(\d{4}-\d{2}-\d{2})?$/, DAY) preparationFrom?: string | null;
  @Matches(/^\d{4}-\d{2}-\d{2}$/, DAY) initialCountDate: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/, DAY) firstRegularizationDate: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/, DAY) finalRegularizationDate: string;
  @IsOptional() @Matches(/^(\d{4}-\d{2}-\d{2})?$/, DAY) renewalDate?: string | null;
  @IsIn(['A', 'B', 'MANUEL'], { message: 'Formule : A, B ou saisie manuelle' }) formula: 'A' | 'B' | 'MANUEL';
  @IsString(MOTIF) @MinLength(5, MOTIF) @MaxLength(300, MOTIF) reason: string;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

type CalendarRow = Prisma.BillingCalendarGetPayload<object>;

/** Une version de calendrier, dates en AAAA-MM-JJ ; `adjusted` : formule A ou B dont une date a été changée à la main. */
function calendarView(c: CalendarRow) {
  const dates = {
    startDate: iso(c.startDate)!, endDate: iso(c.endDate)!, preparationFrom: iso(c.preparationFrom), initialCountDate: iso(c.initialCountDate)!,
    firstRegularizationDate: iso(c.firstRegularizationDate)!, finalRegularizationDate: iso(c.finalRegularizationDate)!, renewalDate: iso(c.renewalDate),
  };
  return {
    id: c.id, yearLabel: c.yearLabel, version: c.version, ...dates, formula: c.formula, adjusted: isAdjusted(dates, c.formula), reason: c.reason,
    createdByName: c.createdByName, createdAt: c.createdAt,
  };
}

/** Dernière version de chaque année scolaire, la plus récente d'abord. */
function latestCalendars(rows: CalendarRow[]) {
  const seen = new Map<string, CalendarRow>();
  for (const c of rows) if (!seen.has(c.yearLabel) || seen.get(c.yearLabel)!.version < c.version) seen.set(c.yearLabel, c);
  return [...seen.values()].sort((a, b) => b.yearLabel.localeCompare(a.yearLabel)).map(calendarView);
}

/** Abonnement tel que l'affiche le Super Admin ; `today` est le jour de l'établissement. */
export function subscriptionView(s: Subscription, today: string) {
  const last = s.status === 'TRIAL' ? iso(s.trialEnd) : s.status === 'PILOT' ? iso(s.pilotEnd) : null;
  return {
    id: s.id, status: s.status, statusLabel: STATUS_LABELS[s.status], statusSince: s.statusSince,
    trialStart: iso(s.trialStart), trialEnd: iso(s.trialEnd), trialDays: s.trialDays, pilotStart: iso(s.pilotStart), pilotEnd: iso(s.pilotEnd), pilotMonths: s.pilotMonths,
    freeDaysLeft: last ? daysLeft(today, last) : null, acceptedAt: s.acceptedAt, acceptedByName: s.acceptedByName, acceptedTariff: s.acceptedTariff,
  };
}

/** Un comptage des élèves (lot G5b) vu par le Super Admin : nombres, dates et empreinte de la liste, jamais un nom. */
function countRecord(c: Prisma.BillingCountGetPayload<object>): CountRecord {
  return {
    id: c.id, yearLabel: c.yearLabel, kind: c.kind, referenceDate: iso(c.referenceDate)!, stage: c.stage, calendarVersion: c.calendarVersion, pupils: c.pupils,
    cumulative: c.cumulative, toCheck: c.toCheck, excluded: c.excluded, listHash: c.listHash, at: c.at, knownAt: c.knownAt, reviewUntil: iso(c.reviewUntil),
    timeZone: c.timeZone, createdAt: c.createdAt,
  };
}

function uniqueViolation(e: unknown) {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

@Injectable()
export class BillingService {
  constructor(private db: PlatformDb) {}

  /**
   * Code actuel de l'application d'authentification, exigé pour chaque opération financière du Super Admin.
   * Le même code peut confirmer plusieurs opérations dans sa période de 30 secondes, jamais un code plus ancien
   * qu'une connexion ou une opération déjà confirmée. Cinq codes faux bloquent le compte 15 minutes.
   */
  async confirm(actor: PlatformActor, code: string) {
    const a = await this.db.platformAdmin.findUnique({ where: { id: actor.id } });
    if (!a?.active) throw new ForbiddenException('Session expirée');
    if (!a.totpEnabled || !a.totpSecret) throw new ForbiddenException('La facturation exige la double authentification : activez-la d’abord sur votre compte');
    if (a.lockedUntil && a.lockedUntil > new Date()) throw new ForbiddenException('Compte bloqué 15 minutes après 5 codes incorrects');
    const token = (code ?? '').replace(/\s/g, '');
    const delta = /^\d{6}$/.test(token) ? authenticator.checkDelta(token, decrypt(a.totpSecret)) : null;
    const step = delta === null ? null : Math.floor(Date.now() / 30000) + delta;
    if (step === null || (a.totpLastStep != null && step < a.totpLastStep)) {
      const failed = a.failedLogins + 1;
      const lock = failed >= config.security.maxFailedLogins;
      await this.db.platformAdmin.update({ where: { id: a.id }, data: { failedLogins: lock ? 0 : failed, ...(lock ? { lockedUntil: new Date(Date.now() + config.security.lockMinutes * 60000) } : {}) } });
      await this.db.$transaction((tx) => platformLog(tx, actor, lock ? 'platform.auth.locked' : 'billing.2fa_failed', null));
      throw new ForbiddenException('Code de votre application incorrect ou expiré');
    }
    await this.db.platformAdmin.update({ where: { id: a.id }, data: { totpLastStep: Math.max(step, a.totpLastStep ?? step), failedLogins: 0 } });
  }

  private async tenant(id: string) {
    const t = await this.db.tenant.findUnique({
      where: { id }, select: { id: true, name: true, groupId: true, timezone: true, currency: true, createdAt: true, commercialStatus: true },
    });
    if (!t) throw new NotFoundException('Établissement introuvable');
    return t;
  }

  /** Un établissement de test ne reçoit ni essai ni pilote (la base le refuse aussi, quel que soit le chemin). */
  private clientOnly(t: { commercialStatus: string }, what: string) {
    if (t.commercialStatus !== 'CLIENT') {
      throw new ConflictException(`Établissement de test : ${what}. Passez-le d’abord en client réel (statut commercial), s’il est un client commercial réel de Cahiora.`);
    }
  }

  private async value(key: ParameterKey, currency: string | null, onDay: string) {
    const versions = await this.db.billingParameter.findMany({ where: { key, currency } });
    const v = versionOn(versions.map((x) => ({ ...x, effectiveFrom: iso(x.effectiveFrom)! })), key, currency, onDay);
    if (!v) throw new BadRequestException(`INFORMATION MANQUANTE : « ${PARAMETERS[key].label} » n’a pas de valeur en vigueur`);
    return v.value;
  }

  /** Journaux de la plateforme, du groupe et de l'établissement, dans la transaction de l'opération. */
  private async journals(tx: Prisma.TransactionClient, actor: PlatformActor, t: { id: string; name: string; groupId: string }, action: string, data: Record<string, unknown>) {
    await platformLog(tx, actor, action, t.id, data);
    await groupLog(tx, actor, [{ groupId: t.groupId, action, data: { tenantName: t.name, ...data } }]);
    await schoolLogInTx(tx, actor, t.id, action, data);
  }

  // ---------------------------------------------------------------- Paramètres tarifaires (§15)

  async parameters() {
    const today = localDay(PLATFORM_TZ);
    const rows = await this.db.billingParameter.findMany({ orderBy: [{ key: 'asc' }, { effectiveFrom: 'desc' }, { createdAt: 'desc' }] });
    const versions = rows.map((r) => ({ ...r, effectiveFrom: iso(r.effectiveFrom)! }));
    const pairs = new Map<string, { key: ParameterKey; currency: string | null }>();
    for (const v of versions) pairs.set(`${v.key}|${v.currency ?? ''}`, { key: v.key as ParameterKey, currency: v.currency });
    const current = [...pairs.values()].map(({ key, currency }) => {
      const now = versionOn(versions, key, currency, today);
      const next = versions.filter((v) => v.key === key && v.currency === currency && v.effectiveFrom > today).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0] ?? null;
      return { key, currency, ...PARAMETERS[key], value: now?.value ?? null, since: now?.effectiveFrom ?? null, next: next ? { value: next.value, effectiveFrom: next.effectiveFrom } : null };
    }).sort((a, b) => PARAMETER_KEYS.indexOf(a.key) - PARAMETER_KEYS.indexOf(b.key) || (a.currency ?? '').localeCompare(b.currency ?? ''));
    return {
      today, currencies: CURRENCIES,
      definitions: PARAMETER_KEYS.map((key) => ({ key, ...PARAMETERS[key] })),
      current,
      // G5c-1 : délais proposés par Cahiora, sans aucun effet tant qu'aucune version n'est saisie (conditions commerciales à valider).
      proposals: PARAMETER_KEYS.filter((key) => (PARAMETERS[key] as { proposed?: number }).proposed !== undefined && !pairs.has(`${key}|`))
        .map((key) => ({ key, ...PARAMETERS[key] })),
      history: versions.map((v) => ({ id: v.id, key: v.key, label: (PARAMETERS as Record<string, { label: string }>)[v.key]?.label ?? v.key, currency: v.currency, value: v.value, effectiveFrom: v.effectiveFrom, reason: v.reason, createdByName: v.createdByName, createdAt: v.createdAt })),
    };
  }

  /** Nouvelle version d'un paramètre, jamais dans le passé : les documents et engagements déjà validés ne changent pas (§2). */
  async addParameter(actor: PlatformActor, dto: ParameterDto) {
    const today = localDay(PLATFORM_TZ);
    const currency = dto.currency || null;
    const error = parameterError(dto.key, currency, dto.value, dto.effectiveFrom, today, CURRENCIES);
    if (error) throw new BadRequestException(error);
    await this.confirm(actor, dto.code);
    return this.db.$transaction(async (tx) => {
      const v = await tx.billingParameter.create({
        data: { key: dto.key, currency, value: dto.value, effectiveFrom: day(dto.effectiveFrom), reason: dto.reason.trim(), createdById: actor.id, createdByName: actor.name },
      });
      await platformLog(tx, actor, 'billing.parameter_added', null, { key: dto.key, currency, value: dto.value, effectiveFrom: dto.effectiveFrom, reason: dto.reason.trim() });
      return { id: v.id, key: v.key, currency, value: v.value, effectiveFrom: dto.effectiveFrom };
    });
  }

  // ---------------------------------------------------------------- Conditions commerciales

  async terms() {
    const today = localDay(PLATFORM_TZ);
    const rows = await this.db.commercialTerms.findMany({ orderBy: { version: 'desc' } });
    const list = rows.map((r) => ({ id: r.id, version: r.version, title: r.title, body: r.body, effectiveFrom: iso(r.effectiveFrom)!, createdByName: r.createdByName, createdAt: r.createdAt }));
    const inForce = list.filter((t) => t.effectiveFrom <= today).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.version - a.version)[0] ?? null;
    return { today, current: inForce, versions: list };
  }

  /** Nouvelle version du texte que la direction accepte (texte fourni par Dankou ; jamais rédigé par Cahiora à sa place). */
  async addTerms(actor: PlatformActor, dto: TermsDto) {
    const today = localDay(PLATFORM_TZ);
    if (!isDay(dto.effectiveFrom) || dto.effectiveFrom < today) throw new BadRequestException('La date d’effet ne peut pas être passée');
    await this.confirm(actor, dto.code);
    try {
      return await this.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('commercial_terms'))`;
        const last = await tx.commercialTerms.findFirst({ orderBy: { version: 'desc' }, select: { version: true } });
        const t = await tx.commercialTerms.create({
          data: { version: (last?.version ?? 0) + 1, title: dto.title.trim(), body: dto.body.trim(), effectiveFrom: day(dto.effectiveFrom), createdById: actor.id, createdByName: actor.name },
        });
        await platformLog(tx, actor, 'billing.terms_published', null, { version: t.version, title: t.title, effectiveFrom: dto.effectiveFrom, attestation: TERMS_ATTESTATION });
        return { id: t.id, version: t.version };
      });
    } catch (e) {
      if (uniqueViolation(e)) throw new ConflictException('Une autre version vient d’être publiée : rechargez la page');
      throw e;
    }
  }

  // ---------------------------------------------------------------- Établissements et abonnements

  /** Établissements clients avec leur groupe, leur abonnement et leurs calendriers (vue consolidée, §6). */
  async establishments() {
    const tenants = await this.db.tenant.findMany({
      orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true, slug: true, name: true, status: true, country: true, currency: true, timezone: true, settings: true, createdAt: true,
        commercialStatus: true, commercialStatusAt: true, _count: { select: { billingDocumentLines: true } },
        group: { select: { id: true, name: true } }, subscription: true, billingCalendars: true, billingCounts: true,
      },
    });
    return tenants.map((t) => {
      const today = localDay(t.timezone);
      const counts = sortCounts(t.billingCounts.map(countRecord));
      return {
        id: t.id, slug: t.slug, name: t.name, status: t.status, country: t.country, currency: t.currency, timezone: t.timezone, today,
        createdOn: localDay(t.timezone, t.createdAt), demo: !!(t.settings as Record<string, unknown> | null)?.demo, group: t.group,
        // Statut commercial : un établissement de test n'est jamais facturé ni limité ; il change seulement sans abonnement.
        commercialStatus: t.commercialStatus, commercialStatusLabel: COMMERCIAL_STATUS_LABELS[t.commercialStatus], commercialStatusAt: t.commercialStatusAt,
        commercialStatusNote: t.commercialStatus === 'TEST' ? TEST_ESTABLISHMENT_NOTE : null,
        canChangeCommercialStatus: !t.subscription && t._count.billingDocumentLines === 0,
        subscription: t.subscription ? subscriptionView(t.subscription, today) : null, calendars: latestCalendars(t.billingCalendars),
        // Comptages des élèves (lot G5b) : des nombres seulement ; la liste nominative reste dans l'espace de l'école.
        counts: counts.map((c) => countView(c, today, counts)),
      };
    });
  }

  /**
   * Change le statut commercial d'un établissement (« test » ou « client réel »), tant qu'aucun abonnement ni aucun
   * document de Cahiora n'existe pour lui : jamais de facturation ni de limitation rétroactive d'un ancien essai de test,
   * jamais un client réel qui redevient « test » avec un abonnement ou un document (la base le refuse aussi). Motif, code
   * et, pour un client réel, confirmation.
   */
  async setCommercialStatus(actor: PlatformActor, tenantId: string, dto: CommercialStatusDto) {
    const t = await this.tenant(tenantId);
    if (t.commercialStatus === dto.status) throw new BadRequestException(`Cet établissement est déjà : ${COMMERCIAL_STATUS_LABELS[dto.status].toLowerCase()}`);
    if (dto.status === 'CLIENT' && dto.confirmed !== true) throw new BadRequestException(CLIENT_ATTEST.message);
    if (await this.db.subscription.findUnique({ where: { tenantId }, select: { id: true } }) || await this.db.billingDocumentLine.findFirst({ where: { tenantId }, select: { id: true } })) {
      throw new ConflictException(COMMERCIAL_STATUS_FROZEN);
    }
    await this.confirm(actor, dto.code);
    try {
      return await this.db.$transaction(async (tx) => {
        const n = await tx.tenant.updateMany({ where: { id: tenantId, commercialStatus: t.commercialStatus }, data: { commercialStatus: dto.status } });
        if (n.count !== 1) throw new ConflictException('Le statut vient de changer : rechargez la page');
        const data = {
          from: t.commercialStatus, to: dto.status, reason: dto.reason.trim(),
          ...(dto.status === 'CLIENT' ? { attestation: CLIENT_ATTESTATION } : {}),
        };
        await this.journals(tx, actor, t, 'billing.commercial_status_changed', data);
        const after = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { commercialStatus: true, commercialStatusAt: true } });
        return { ...after, commercialStatusLabel: COMMERCIAL_STATUS_LABELS[after.commercialStatus] };
      });
    } catch (e) {
      const m = (e instanceof Error ? e.message : String(e)).match(/CAHIORA: ([^\n"`]+)/);
      if (m) throw new ConflictException(m[1].trim());
      throw e;
    }
  }

  async events(tenantId: string) {
    await this.tenant(tenantId);
    const rows = await this.db.subscriptionEvent.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 200 });
    return rows.map((e) => ({ ...e, label: subscriptionKindLabel(e.kind) }));
  }

  /** Ouvre l'essai gratuit d'un établissement qui n'a pas encore d'abonnement (§4). La durée est le paramètre du jour. */
  async openTrial(actor: PlatformActor, tenantId: string, dto: TrialDto) {
    const t = await this.tenant(tenantId);
    const today = localDay(t.timezone);
    const createdOn = localDay(t.timezone, t.createdAt);
    if (!isDay(dto.startDate)) throw new BadRequestException('Début de l’essai : date invalide');
    if (dto.startDate < createdOn) throw new BadRequestException(`L’essai ne commence pas avant la création de l’établissement (${frDay(createdOn)})`);
    if (Math.abs(daysBetween(today, dto.startDate)) > 30) throw new BadRequestException('Début de l’essai : au plus 30 jours avant ou après aujourd’hui');
    this.clientOnly(t, 'aucun essai gratuit ne s’ouvre');
    const days = await this.value('TRIAL_DAYS', null, today);
    await this.confirm(actor, dto.code);
    const trialEnd = trialEndDay(dto.startDate, days);
    try {
      return await this.db.$transaction(async (tx) => {
        if (await tx.subscription.findUnique({ where: { tenantId }, select: { id: true } })) throw new ConflictException('Cet établissement a déjà un abonnement');
        const s = await tx.subscription.create({ data: { tenantId, status: 'TRIAL', trialStart: day(dto.startDate), trialEnd: day(trialEnd), trialDays: days } });
        const data = { trialStart: dto.startDate, trialEnd, trialDays: days };
        await tx.subscriptionEvent.create({
          data: { subscriptionId: s.id, tenantId, kind: 'TRIAL_OPENED', toStatus: 'TRIAL', data, reason: dto.reason?.trim() || null, actorKind: 'platform', actorId: actor.id, actorName: actor.name, ip: actor.ip ?? null },
        });
        await this.journals(tx, actor, t, 'billing.trial_opened', data);
        return subscriptionView(s, today);
      });
    } catch (e) {
      if (uniqueViolation(e)) throw new ConflictException('Cet établissement a déjà un abonnement');
      throw e;
    }
  }

  /**
   * Statut « École pilote partenaire CAHIORA » (§13) : gratuité de N mois à partir de l'activation effective, que le
   * Super Admin saisit (décision D-G5-38 pour Saint Kisito-GESA). Possible pour un établissement sans abonnement ou en
   * essai ; rien n'est facturé pour la période pilote, ni rétroactivement après elle.
   */
  async openPilot(actor: PlatformActor, tenantId: string, dto: PilotDto) {
    const t = await this.tenant(tenantId);
    const today = localDay(t.timezone);
    const createdOn = localDay(t.timezone, t.createdAt);
    if (!isDay(dto.startDate)) throw new BadRequestException('Activation du pilote : date invalide');
    if (dto.startDate < createdOn) throw new BadRequestException(`Le pilote ne commence pas avant la création de l’établissement (${frDay(createdOn)})`);
    if (daysBetween(today, dto.startDate) > 60) throw new BadRequestException('Activation du pilote : au plus 60 jours après aujourd’hui');
    this.clientOnly(t, 'aucune période pilote ne s’ouvre');
    const months = dto.months ?? (await this.value('PILOT_FREE_MONTHS', null, today));
    const pilotEnd = pilotEndDay(dto.startDate, months);
    if (pilotEnd < today) throw new BadRequestException(`Cette période pilote serait déjà terminée (le ${frDay(pilotEnd)})`);
    await this.confirm(actor, dto.code);
    const data = { pilotStart: dto.startDate, pilotEnd, pilotMonths: months };
    try {
      return await this.db.$transaction(async (tx) => {
        const existing = await tx.subscription.findUnique({ where: { tenantId } });
        let s: Subscription;
        if (!existing) {
          s = await tx.subscription.create({ data: { tenantId, status: 'PILOT', pilotStart: day(dto.startDate), pilotEnd: day(pilotEnd), pilotMonths: months } });
        } else {
          if (existing.status !== 'TRIAL') throw new ConflictException(`Un pilote s’active sur un établissement sans abonnement ou en essai (état actuel : ${STATUS_LABELS[existing.status]})`);
          const n = await tx.subscription.updateMany({
            where: { id: existing.id, status: 'TRIAL' },
            data: { status: 'PILOT', statusSince: new Date(), pilotStart: day(dto.startDate), pilotEnd: day(pilotEnd), pilotMonths: months },
          });
          if (n.count !== 1) throw new ConflictException('L’abonnement vient de changer : rechargez la page');
          s = await tx.subscription.findUniqueOrThrow({ where: { id: existing.id } });
        }
        await tx.subscriptionEvent.create({
          data: { subscriptionId: s.id, tenantId, kind: 'PILOT_OPENED', fromStatus: existing?.status ?? null, toStatus: 'PILOT', data, reason: dto.reason.trim(), actorKind: 'platform', actorId: actor.id, actorName: actor.name, ip: actor.ip ?? null },
        });
        await this.journals(tx, actor, t, 'billing.pilot_opened', data);
        return subscriptionView(s, today);
      });
    } catch (e) {
      if (uniqueViolation(e)) throw new ConflictException('Cet établissement a déjà un abonnement');
      throw e;
    }
  }

  /** Nouvelle fin de gratuité d'un pilote en cours, jamais dans le passé, avec un motif. Les alertes suivent la nouvelle date. */
  async changePilotEnd(actor: PlatformActor, tenantId: string, dto: PilotEndDto) {
    const t = await this.tenant(tenantId);
    const today = localDay(t.timezone);
    if (!isDay(dto.pilotEnd)) throw new BadRequestException('Fin du pilote : date invalide');
    if (dto.pilotEnd < today) throw new BadRequestException('La fin du pilote ne peut pas être déplacée dans le passé');
    const s = await this.db.subscription.findUnique({ where: { tenantId } });
    if (!s || s.status !== 'PILOT') throw new ConflictException('Cet établissement n’est pas en période pilote');
    this.clientOnly(t, 'sa période pilote ne change pas');
    if (dto.pilotEnd <= iso(s.pilotStart)!) throw new BadRequestException('La fin du pilote suit son activation');
    if (dto.pilotEnd === iso(s.pilotEnd)) throw new BadRequestException('Cette date est déjà la fin du pilote');
    await this.confirm(actor, dto.code);
    return this.db.$transaction(async (tx) => {
      const n = await tx.subscription.updateMany({ where: { id: s.id, status: 'PILOT', pilotEnd: s.pilotEnd }, data: { pilotEnd: day(dto.pilotEnd) } });
      if (n.count !== 1) throw new ConflictException('L’abonnement vient de changer : rechargez la page');
      const data = { previousPilotEnd: iso(s.pilotEnd), pilotEnd: dto.pilotEnd };
      await tx.subscriptionEvent.create({
        data: { subscriptionId: s.id, tenantId, kind: 'PILOT_END_CHANGED', fromStatus: 'PILOT', toStatus: 'PILOT', data, reason: dto.reason.trim(), actorKind: 'platform', actorId: actor.id, actorName: actor.name, ip: actor.ip ?? null },
      });
      await this.journals(tx, actor, t, 'billing.pilot_end_changed', data);
      return subscriptionView(await tx.subscription.findUniqueOrThrow({ where: { id: s.id } }), today);
    });
  }

  // ---------------------------------------------------------------- Calendriers (§3)

  /**
   * Dates proposées par les formules A et B pour n'importe quelle année (correction C0), que l'écran recalcule quand la
   * rentrée ou la fin change. Une année de 6 mois ou moins n'a pas de proposition (décision CAL-1).
   */
  proposals(startDate: unknown, endDate: unknown) {
    const error = yearDatesError(startDate, endDate);
    if (error) throw new BadRequestException(error);
    return { startDate, endDate, proposals: calendarProposals(startDate as string, endDate as string)! };
  }

  /** Versions des calendriers d'un établissement et ses années scolaires (dates seulement), pour proposer les dates. */
  async calendars(tenantId: string) {
    const t = await this.tenant(tenantId);
    const rows = await this.db.billingCalendar.findMany({ where: { tenantId }, orderBy: [{ yearLabel: 'desc' }, { version: 'desc' }] });
    const years = await this.db.inTenant(tenantId, (tx) =>
      tx.academicYear.findMany({ select: { id: true, label: true, startDate: true, endDate: true, isCurrent: true }, orderBy: { startDate: 'desc' } }));
    return {
      tenant: { id: t.id, name: t.name, today: localDay(t.timezone) },
      versions: rows.map(calendarView),
      schoolYears: years.map((y) => {
        const start = iso(y.startDate)!;
        const end = iso(y.endDate)!;
        return { label: y.label, startDate: start, endDate: end, isCurrent: y.isCurrent, proposals: calendarProposals(start, end) };
      }),
    };
  }

  /**
   * Nouvelle version du calendrier d'une année : dates contrôlées, jamais de changement d'une date passée. Une formule
   * qui ne s'applique pas à l'année (6 mois ou moins, décision CAL-1) est refusée : dates saisies à la main, avec un motif.
   * Une version A ou B dont une date a été changée à la main est enregistrée telle quelle et marquée « ajustée ».
   */
  async addCalendar(actor: PlatformActor, tenantId: string, dto: CalendarDto) {
    const t = await this.tenant(tenantId);
    const today = localDay(t.timezone);
    if (!isYearLabel(dto.yearLabel)) throw new BadRequestException('Année scolaire : 2026-2027, ou 2027 pour une année civile');
    const next: CalendarDates = {
      startDate: dto.startDate, endDate: dto.endDate, preparationFrom: dto.preparationFrom || null, initialCountDate: dto.initialCountDate,
      firstRegularizationDate: dto.firstRegularizationDate, finalRegularizationDate: dto.finalRegularizationDate, renewalDate: dto.renewalDate || null,
    };
    const errors = calendarErrors(next);
    if (errors.length) throw new BadRequestException(errors);
    if (dto.formula !== 'MANUEL') {
      const proposal = calendarProposal(next.startDate, next.endDate, dto.formula);
      if (!proposal.applies) throw new BadRequestException(proposal.message);
    }
    await this.confirm(actor, dto.code);
    try {
      return await this.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing_calendar:${tenantId}:${dto.yearLabel}`}))`;
        const prev = await tx.billingCalendar.findFirst({ where: { tenantId, yearLabel: dto.yearLabel }, orderBy: { version: 'desc' } });
        if (prev) {
          const before: CalendarDates = calendarView(prev);
          const retro = retroactiveChanges(before, next, today);
          if (retro.length) throw new BadRequestException(retro);
          const same = (['startDate', 'endDate', 'preparationFrom', 'initialCountDate', 'firstRegularizationDate', 'finalRegularizationDate', 'renewalDate'] as const)
            .every((k) => (before[k] || null) === (next[k] || null));
          if (same) throw new BadRequestException('Aucune date ne change par rapport à la version en cours');
        }
        const c = await tx.billingCalendar.create({
          data: {
            tenantId, yearLabel: dto.yearLabel, version: (prev?.version ?? 0) + 1, startDate: day(next.startDate), endDate: day(next.endDate),
            preparationFrom: next.preparationFrom ? day(next.preparationFrom) : null, initialCountDate: day(next.initialCountDate),
            firstRegularizationDate: day(next.firstRegularizationDate), finalRegularizationDate: day(next.finalRegularizationDate),
            renewalDate: next.renewalDate ? day(next.renewalDate) : null, formula: dto.formula, reason: dto.reason.trim(), createdById: actor.id, createdByName: actor.name,
          },
        });
        const view = calendarView(c);
        await this.journals(tx, actor, t, 'billing.calendar_saved', {
          yearLabel: view.yearLabel, version: view.version, formula: view.formula, adjusted: view.adjusted, startDate: view.startDate, endDate: view.endDate, initialCountDate: view.initialCountDate,
          firstRegularizationDate: view.firstRegularizationDate, finalRegularizationDate: view.finalRegularizationDate, renewalDate: view.renewalDate, reason: view.reason,
        });
        return view;
      });
    } catch (e) {
      if (uniqueViolation(e)) throw new ConflictException('Une autre version de ce calendrier vient d’être enregistrée : rechargez la page');
      throw e;
    }
  }

  // ---------------------------------------------------------------- Vue d'ensemble et alertes (§14)

  async overview() {
    const tenants = await this.db.tenant.findMany({
      select: { id: true, name: true, timezone: true, settings: true, commercialStatus: true, group: { select: { id: true, name: true } }, subscription: true },
    });
    const counts = {
      establishments: tenants.length, none: 0, TRIAL: 0, PILOT: 0, AWAITING_ACCEPTANCE: 0, AWAITING_PAYMENT: 0, ACTIVE: 0, LIMITED: 0,
      testEstablishments: tenants.filter((t) => t.commercialStatus === 'TEST').length, clientEstablishments: tenants.filter((t) => t.commercialStatus === 'CLIENT').length,
    };
    const soon: { tenantId: string; tenantName: string; group: string; kind: 'TRIAL' | 'PILOT'; lastDay: string; daysLeft: number }[] = [];
    for (const t of tenants) {
      const s = t.subscription;
      // Établissement de test : compté à part, hors des abonnements et des échéances (un abonnement d'avant ce lot y est figé).
      if (t.commercialStatus === 'TEST') continue;
      if (!s) { counts.none++; continue; }
      counts[s.status]++;
      const today = localDay(t.timezone);
      const last = s.status === 'TRIAL' ? iso(s.trialEnd) : s.status === 'PILOT' ? iso(s.pilotEnd) : null;
      if (last && daysLeft(today, last) <= (s.status === 'TRIAL' ? 7 : 30)) {
        soon.push({ tenantId: t.id, tenantName: t.name, group: t.group.name, kind: s.status as 'TRIAL' | 'PILOT', lastDay: last, daysLeft: daysLeft(today, last) });
      }
    }
    const unreadAlerts = await this.db.platformAlert.count({ where: { readAt: null } });
    const totals = await financialTotals(this.db);
    return {
      counts, soon: soon.sort((a, b) => a.daysLeft - b.daysLeft), unreadAlerts,
      // Facturé et encaissé ne se confondent jamais (§14), comptés par monnaie (lot G5d-2) ; prestations et commissions
      // arrivent avec leurs lots.
      amounts: {
        billed: totals.billed, credited: totals.credited, collected: totals.collected, refunded: totals.refunded, unpaid: totals.unpaid, groupPending: totals.groupPending,
        clientCredits: totals.credits, servicesRevenue: null, commissionsDue: null, commissionsPaid: null,
      },
      amountsFrom: { servicesRevenue: 'G5g', commissionsDue: 'G5h', commissionsPaid: 'G5h' },
    };
  }

  async alerts() {
    const rows = await this.db.platformAlert.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
    const ids = [...new Set(rows.map((r) => r.tenantId).filter((x): x is string => !!x))];
    const names = new Map((await this.db.tenant.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((t) => [t.id, t.name]));
    return rows.map((r) => ({ ...r, dueDate: iso(r.dueDate), tenantName: r.tenantId ? names.get(r.tenantId) ?? null : null }));
  }

  async readAlert(actor: PlatformActor, id: string) {
    const n = await this.db.platformAlert.updateMany({ where: { id, readAt: null }, data: { readAt: new Date(), readById: actor.id } });
    return { ok: n.count === 1 };
  }
}

@ApiTags('Plateforme : facturation')
@Public()
@UseGuards(PlatformGuard)
@Controller()
export class BillingController {
  constructor(private s: BillingService) {}

  private actor(req: Request) {
    return (req as any).platformAdmin as PlatformActor;
  }

  @Get('platform/billing/overview')
  overview() { return this.s.overview(); }

  @Get('platform/billing/parameters')
  parameters() { return this.s.parameters(); }

  @Post('platform/billing/parameters') @Throttle({ default: { limit: 20, ttl: 60000 } })
  addParameter(@Req() req: Request, @Body() dto: ParameterDto) { return this.s.addParameter(this.actor(req), dto); }

  @Get('platform/billing/terms')
  terms() { return this.s.terms(); }

  @Post('platform/billing/terms') @Throttle({ default: { limit: 20, ttl: 60000 } })
  addTerms(@Req() req: Request, @Body() dto: TermsDto) { return this.s.addTerms(this.actor(req), dto); }

  @Get('platform/billing/establishments') @Header('Cache-Control', 'no-store')
  establishments() { return this.s.establishments(); }

  @Post('platform/billing/establishments/:id/commercial-status') @Throttle({ default: { limit: 20, ttl: 60000 } })
  commercialStatus(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CommercialStatusDto) {
    return this.s.setCommercialStatus(this.actor(req), id, dto);
  }

  @Get('platform/billing/establishments/:id/events')
  events(@Param('id', ParseUUIDPipe) id: string) { return this.s.events(id); }

  @Post('platform/billing/establishments/:id/trial') @Throttle({ default: { limit: 20, ttl: 60000 } })
  trial(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TrialDto) { return this.s.openTrial(this.actor(req), id, dto); }

  @Post('platform/billing/establishments/:id/pilot') @Throttle({ default: { limit: 20, ttl: 60000 } })
  pilot(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PilotDto) { return this.s.openPilot(this.actor(req), id, dto); }

  @Post('platform/billing/establishments/:id/pilot-end') @Throttle({ default: { limit: 20, ttl: 60000 } })
  pilotEnd(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PilotEndDto) { return this.s.changePilotEnd(this.actor(req), id, dto); }

  @Get('platform/billing/calendar-proposals')
  proposals(@Query('startDate') startDate: string, @Query('endDate') endDate: string) { return this.s.proposals(startDate, endDate); }

  @Get('platform/billing/establishments/:id/calendars')
  calendars(@Param('id', ParseUUIDPipe) id: string) { return this.s.calendars(id); }

  @Post('platform/billing/establishments/:id/calendars') @Throttle({ default: { limit: 20, ttl: 60000 } })
  addCalendar(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CalendarDto) { return this.s.addCalendar(this.actor(req), id, dto); }

  @Get('platform/billing/alerts')
  alerts() { return this.s.alerts(); }

  @Post('platform/billing/alerts/:id/read')
  readAlert(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) { return this.s.readAlert(this.actor(req), id); }
}
