import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Prisma, TwoFactorRecoveryRequest } from '@prisma/client';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { config } from '../../config';
import { Actor, Can, CurrentActor, forgetSessions } from '../../common/auth';
import { PrismaService } from '../../common/prisma.service';
import { generateActivationCode } from './recovery-codes';

type Db = Prisma.TransactionClient;

/** Vérifications d'identité acceptées, notées dans la demande. */
export const IDENTITY_CHECKS = ['PIECE_IDENTITE', 'RAPPEL_NUMERO_CONNU', 'CONNAISSANCE_PERSONNELLE', 'AUTRE'] as const;

export class RecoveryRequestDto {
  @IsUUID() userId: string;
  @IsString() @MinLength(5, { message: 'Motif : au moins 5 caractères' }) @MaxLength(500) reason: string;
  @IsIn(IDENTITY_CHECKS, { message: "Indiquez la vérification d'identité réalisée" }) identityCheck: (typeof IDENTITY_CHECKS)[number];
  @IsOptional() @IsString() @MaxLength(500) identityNote?: string;
}

export class RecoveryDecisionDto {
  @IsString() @MinLength(3, { message: 'Justification : au moins 3 caractères' }) @MaxLength(500) note: string;
}

/** Qui décide : une personne de l'école ou le Super Admin de la plateforme. */
export interface Decider {
  id: string;
  name: string;
  platform: boolean;
  ip?: string | null;
}

/** Statut affiché : une demande en attente ou un code non utilisé au-delà de son délai est « expiré ». */
export function displayStatus(r: Pick<TwoFactorRecoveryRequest, 'status' | 'expiresAt' | 'activationExpiresAt'>, now = new Date()) {
  if (r.status === 'PENDING' && r.expiresAt <= now) return 'EXPIRED';
  if (r.status === 'APPROVED' && r.activationExpiresAt && r.activationExpiresAt <= now) return 'EXPIRED';
  return r.status;
}

/** Notification dans le site, écrite dans la transaction en cours (aussi utilisée par la plateforme). */
export async function notifyInApp(tx: Db, tenantId: string, userIds: string[], title: string, body: string) {
  // createMany : pas de relecture de la ligne, le rôle de la plateforme n'a que le droit d'écrire.
  const ids = [...new Set(userIds)].filter(Boolean);
  if (!ids.length) return;
  await tx.notification.createMany({ data: ids.map((userId) => ({ tenantId, userId, channel: 'IN_APP' as const, kind: 'securite', title, body, status: 'SENT' as const, sentAt: new Date() })) });
}

/** Comptes Direction actifs de l'école (destinataires des alertes, validateurs possibles). */
export async function directionIds(tx: Db) {
  const rows = await tx.user.findMany({ where: { status: 'ACTIVE', roles: { some: { role: 'DIRECTION' } } }, select: { id: true } });
  return rows.map((r) => r.id);
}

/** Lignes du journal de l'école, sans aucun secret (ni code de réactivation, ni secret, ni code de secours). */
async function schoolAudit(tx: Db, tenantId: string, who: Decider, action: string, entityId: string, data: Record<string, unknown>) {
  await tx.auditLog.createMany({
    data: {
      tenantId, userId: who.platform ? null : who.id, userName: who.platform ? `Super Admin de la plateforme (${who.name})` : who.name,
      action, entity: 'TwoFactorRecoveryRequest', entityId, data: data as Prisma.InputJsonValue, ip: who.ip ?? null,
    },
  });
}

/**
 * Crée une demande de récupération. Jamais pour son propre compte. Un compte Direction, ou une école où personne
 * d'autre que le demandeur ne peut valider, part au Super Admin. Une seule demande ouverte à la fois par compte.
 */
export async function createRecoveryRequest(tx: Db, tenantId: string, who: Decider, dto: RecoveryRequestDto) {
  if (!who.platform && dto.userId === who.id) {
    throw new ForbiddenException('Vous ne pouvez pas demander la récupération de votre propre compte : contactez une autre personne de la direction ou le Super Admin');
  }
  const target = await tx.user.findUnique({ where: { id: dto.userId }, include: { roles: true } });
  if (!target) throw new NotFoundException('Compte introuvable');
  if (target.status !== 'ACTIVE') throw new BadRequestException('Ce compte est désactivé');
  if (!target.totpEnabled) throw new BadRequestException("Ce compte n'utilise pas la double authentification : rien à récupérer");
  const now = new Date();
  const open = await tx.twoFactorRecoveryRequest.findFirst({
    where: { userId: target.id, OR: [{ status: 'PENDING', expiresAt: { gt: now } }, { status: 'APPROVED', activationExpiresAt: { gt: now } }] },
  });
  if (open) throw new ConflictException('Une demande est déjà en cours pour ce compte');
  const isDirection = target.roles.some((r) => r.role === 'DIRECTION');
  const otherApprovers = (await directionIds(tx)).filter((id) => id !== target.id && id !== who.id);
  const requiresPlatform = who.platform || isDirection || otherApprovers.length === 0;
  const req = await tx.twoFactorRecoveryRequest.create({
    data: {
      tenantId, userId: target.id, requestedById: who.id, requestedByName: who.name, requestedByPlatform: who.platform,
      reason: dto.reason.trim(), identityCheck: dto.identityCheck, identityNote: dto.identityNote?.trim() || null,
      requiresPlatform, expiresAt: new Date(now.getTime() + config.security.recoveryRequestHours * 3600000),
    },
  });
  await schoolAudit(tx, tenantId, who, 'security.recovery_requested', req.id, { userId: target.id, identityCheck: dto.identityCheck, requiresPlatform });
  const name = `${target.firstName} ${target.lastName}`;
  await notifyInApp(tx, tenantId, otherApprovers, 'Demande de récupération de compte',
    `${who.platform ? 'Le Super Admin' : who.name} a demandé la récupération de la double authentification de ${name}. ${requiresPlatform ? 'Elle sera validée par le Super Admin.' : 'Une autre personne de la direction doit la valider.'}`);
  await notifyInApp(tx, tenantId, [target.id], 'Demande de récupération de votre compte',
    `Une demande de récupération de votre double authentification a été ouverte le ${now.toLocaleDateString('fr-FR')}. Si vous n'êtes pas à l'origine de cette demande, prévenez tout de suite la direction.`);
  return { id: req.id, requiresPlatform };
}

/**
 * Valide une demande : jamais par son demandeur ni par le compte visé. Sessions coupées, ancien secret et anciens
 * codes de secours supprimés, compte en « nouvelle configuration obligatoire ». Le code de réactivation, à usage
 * unique et valable 24 heures, n'est renvoyé qu'ici, une seule fois ; seule son empreinte est gardée.
 * La validation passe par une seule requête conditionnelle : deux validations simultanées, une seule réussit.
 */
export async function approveRecoveryRequest(tx: Db, tenantId: string, who: Decider, id: string, note: string, opts: { allowSameRequester?: boolean } = {}) {
  const req = await tx.twoFactorRecoveryRequest.findUnique({ where: { id }, include: { user: true } });
  if (!req) throw new NotFoundException('Demande introuvable');
  if (displayStatus(req) !== 'PENDING') throw new ConflictException('Cette demande n’est plus en attente');
  if (req.requiresPlatform && !who.platform) throw new ForbiddenException('Cette demande doit être validée par le Super Admin');
  if (!who.platform && req.userId === who.id) throw new ForbiddenException('Vous ne pouvez pas valider la récupération de votre propre compte');
  const sameRequester = req.requestedById === who.id && req.requestedByPlatform === who.platform;
  if (sameRequester && !opts.allowSameRequester) throw new ForbiddenException('Une autre personne que le demandeur doit valider cette demande');
  const { code, hash } = generateActivationCode();
  const now = new Date();
  const done = await tx.twoFactorRecoveryRequest.updateMany({
    where: { id, status: 'PENDING', expiresAt: { gt: now } },
    data: {
      status: 'APPROVED', decidedById: who.id, decidedByName: who.name, decidedByPlatform: who.platform, decisionNote: note.trim(), decidedAt: now,
      activationHash: hash, activationExpiresAt: new Date(now.getTime() + config.security.activationHours * 3600000), activationAttempts: 0,
    },
  });
  if (done.count !== 1) throw new ConflictException('Cette demande n’est plus en attente');
  await tx.user.update({ where: { id: req.userId }, data: { totpEnabled: false, totpSecret: null, totpLastStep: null, twoFactorReenroll: true } });
  await tx.recoveryCode.deleteMany({ where: { userId: req.userId } });
  await tx.session.updateMany({ where: { userId: req.userId, revokedAt: null }, data: { revokedAt: now } });
  forgetSessions({ userId: req.userId });
  await schoolAudit(tx, tenantId, who, 'security.recovery_approved', id, { userId: req.userId, sameRequester });
  const name = `${req.user.firstName} ${req.user.lastName}`;
  await notifyInApp(tx, tenantId, (await directionIds(tx)).filter((x) => x !== who.id && x !== req.userId), 'Récupération de compte validée',
    `${who.platform ? 'Le Super Admin' : who.name} a validé la récupération de la double authentification de ${name}.`);
  await notifyInApp(tx, tenantId, [req.userId], 'Récupération de votre compte validée',
    `La récupération de votre double authentification a été validée. À votre prochaine connexion, saisissez le code de réactivation qui vous a été remis en main propre, puis configurez votre nouveau téléphone.`);
  return { activationCode: code, expiresAt: new Date(now.getTime() + config.security.activationHours * 3600000), user: { id: req.userId, name } };
}

export async function rejectRecoveryRequest(tx: Db, tenantId: string, who: Decider, id: string, note: string) {
  const req = await tx.twoFactorRecoveryRequest.findUnique({ where: { id } });
  if (!req) throw new NotFoundException('Demande introuvable');
  if (!who.platform && req.userId === who.id) throw new ForbiddenException('Vous ne pouvez pas décider de la récupération de votre propre compte');
  if (req.requiresPlatform && !who.platform && req.requestedById !== who.id) throw new ForbiddenException('Cette demande doit être traitée par le Super Admin');
  const done = await tx.twoFactorRecoveryRequest.updateMany({
    where: { id, status: 'PENDING' },
    data: { status: req.requestedById === who.id && req.requestedByPlatform === who.platform ? 'CANCELLED' : 'REJECTED', decidedById: who.id, decidedByName: who.name, decidedByPlatform: who.platform, decisionNote: note.trim(), decidedAt: new Date() },
  });
  if (done.count !== 1) throw new ConflictException('Cette demande n’est plus en attente');
  await schoolAudit(tx, tenantId, who, 'security.recovery_rejected', id, { userId: req.userId });
  return { ok: true };
}

/** Liste des demandes, sans jamais l'empreinte du code de réactivation. */
export async function listRecoveryRequests(tx: Db, where: Prisma.TwoFactorRecoveryRequestWhereInput = {}) {
  const rows = await tx.twoFactorRecoveryRequest.findMany({
    where, orderBy: { createdAt: 'desc' }, take: 100,
    include: { user: { select: { firstName: true, lastName: true, roles: { select: { role: true } } } } },
  });
  return rows.map(({ activationHash, user, ...r }) => ({
    ...r, status: displayStatus(r), userName: `${user.firstName} ${user.lastName}`, userRoles: [...new Set(user.roles.map((x) => x.role))],
  }));
}

@Injectable()
export class RecoveryService {
  constructor(private db: PrismaService) {}

  private who(a: Actor): Decider {
    return { id: a.userId, name: a.name, platform: false, ip: a.ip };
  }

  list(a: Actor) {
    return this.db.forTenant(a.tenantId, async (tx) => {
      const rows = await listRecoveryRequests(tx);
      return rows.map((r) => ({
        ...r,
        canDecide: r.status === 'PENDING' && !r.requiresPlatform && r.userId !== a.userId && !(r.requestedById === a.userId && !r.requestedByPlatform),
      }));
    });
  }

  create(a: Actor, dto: RecoveryRequestDto) {
    return this.db.forTenant(a.tenantId, (tx) => createRecoveryRequest(tx, a.tenantId, this.who(a), dto));
  }

  approve(a: Actor, id: string, dto: RecoveryDecisionDto) {
    return this.db.forTenant(a.tenantId, (tx) => approveRecoveryRequest(tx, a.tenantId, this.who(a), id, dto.note));
  }

  reject(a: Actor, id: string, dto: RecoveryDecisionDto) {
    return this.db.forTenant(a.tenantId, (tx) => rejectRecoveryRequest(tx, a.tenantId, this.who(a), id, dto.note));
  }
}

@ApiTags('Récupération des comptes')
@ApiBearerAuth()
@Controller('recovery-requests')
export class RecoveryController {
  constructor(private s: RecoveryService) {}

  @Get() @Can('security.recovery')
  list(@CurrentActor() a: Actor) { return this.s.list(a); }

  @Post() @Can('security.recovery') @Throttle({ default: { limit: 10, ttl: 60000 } })
  create(@CurrentActor() a: Actor, @Body() dto: RecoveryRequestDto) { return this.s.create(a, dto); }

  @Post(':id/approve') @HttpCode(200) @Can('security.recovery') @Header('Cache-Control', 'no-store') @Throttle({ default: { limit: 10, ttl: 60000 } })
  approve(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RecoveryDecisionDto) { return this.s.approve(a, id, dto); }

  @Post(':id/reject') @HttpCode(200) @Can('security.recovery')
  reject(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RecoveryDecisionDto) { return this.s.reject(a, id, dto); }
}
