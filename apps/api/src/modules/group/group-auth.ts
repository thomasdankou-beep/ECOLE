import {
  BadRequestException, Body, CanActivate, Controller, ExecutionContext, ForbiddenException, Get, Header, Injectable, Logger, NotFoundException,
  Param, ParseUUIDPipe, Post, Req, Res, SetMetadata, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { GroupAccount, GroupRole, Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { IsNotEmpty, IsOptional, IsString, Length, MaxLength, MinLength } from 'class-validator';
import type { Request, Response } from 'express';
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';
import { Public, schoolFromHost } from '../../common/auth';
import { maskIdentifier } from '../../common/audit.service';
import { COUNTRIES } from '../../common/country';
import { decrypt, encrypt, normalizePhone } from '../../common/util';
import { config, derivedKey } from '../../config';
import { hashPassword, totpStep } from '../auth/auth.service';
import { generateRecoveryCodes, hashCode, looksLikeRecoveryCode } from '../auth/recovery-codes';
import { ACCOUNT_VIEW, accountView, revokeSessions } from './group-accounts';
import { GroupDb } from './group-db';

/**
 * Connexion à la console du groupe (lot G2, décisions D-G4 et D-G5).
 *
 * - Espace séparé : jetons signés avec leur propre clé et leur propre audience, dans un cookie protégé réservé à
 *   /api/v1/group ; un jeton d'école ou du Super Admin y est refusé, et un jeton de groupe est refusé par les deux
 *   autres espaces (T-01). La console ne répond que sur l'adresse de la plateforme, jamais sur celle d'une école.
 * - Double authentification obligatoire (T-08) : aucune session n'est ouverte avant un code valide de
 *   l'application d'authentification. À la première connexion, le compte choisit son mot de passe, configure son
 *   application et reçoit ses codes de récupération, puis seulement la console s'ouvre.
 * - Blocage 15 minutes après 5 erreurs (mot de passe, code ou code de récupération), le compteur n'étant remis à
 *   zéro qu'après une connexion complète ; au plus 10 essais par minute et par adresse.
 * - Sessions en base, vérifiées à chaque appel sans mémoire intermédiaire (T-09) : 8 heures au plus, 30 minutes
 *   sans activité, fermées tout de suite par une déconnexion, un changement de mot de passe, la désactivation du
 *   compte ou la suspension du groupe.
 * - Le groupe de la session vient uniquement du jeton signé, jamais d'une adresse ou d'un formulaire.
 */

export const GROUP_COOKIE = 'erp_gt';
const COOKIE_PATH = '/api/v1/group';
const SESSION_HOURS = 8;
export const IDLE_MINUTES = 30;
const AUD = {
  session: 'group',
  challenge: 'group-2fa',
  firstLogin: 'group-first-login',
  setup: 'group-2fa-setup',
  recovered: 'group-2fa-recovered',
} as const;
const LOGIN_FAILED = 'Identifiant ou mot de passe incorrect. Après 5 erreurs, le compte est bloqué 15 minutes.';
const CODE_FAILED = 'Code incorrect. Après 5 erreurs, le compte est bloqué 15 minutes.';
const SUSPENDED = 'L’accès de votre groupe à la console est suspendu. Contactez Cahiora.';
const EXPIRED = 'Délai dépassé : reconnectez-vous';
const groupKey = () => derivedKey('group-tokens');

/** Compte de groupe authentifié par GroupGuard. */
export type GroupActor = { accountId: string; groupId: string; sessionId: string; name: string; role: GroupRole; ip?: string | null };
type Meta = { ip?: string | null; userAgent?: string | null };
type Row = Pick<GroupAccount, 'id' | 'groupId' | 'firstName' | 'lastName'>;

export const GROUP_ROLES = 'groupRoles';
/** Rôles du groupe autorisés sur une route de la console (sinon : tous les comptes du groupe). */
export const GroupRoles = (...roles: GroupRole[]) => SetMetadata(GROUP_ROLES, roles);

/** Politique des mots de passe des comptes de groupe : au moins 12 caractères, avec des lettres et des chiffres. */
export function assertGroupPassword(pw: string) {
  if (pw.length < 12 || pw.length > 200 || !/[a-zA-Z]/.test(pw) || !/\d/.test(pw)) {
    throw new BadRequestException('Le mot de passe doit contenir au moins 12 caractères, dont des lettres et des chiffres');
  }
}

/** Journal du groupe : action d'un compte du groupe, sous son nom, avec son adresse IP. */
export function accountLog(tx: Prisma.TransactionClient, a: { id: string; groupId: string; firstName: string; lastName: string }, action: string, ip?: string | null, data?: Record<string, unknown>) {
  return tx.groupAuditLog.createMany({
    data: [{ groupId: a.groupId, actorKind: 'group', actorId: a.id, actorName: `${a.firstName} ${a.lastName}`, action, ip: ip ?? null, data: (data ?? undefined) as Prisma.InputJsonValue | undefined }],
  });
}

/**
 * Erreur comptée (mot de passe, code ou code de récupération) : à la cinquième, le compte est bloqué 15 minutes et
 * toutes ses sessions sont fermées (cinq codes faux depuis une session ouverte font penser à une session volée).
 * Incrément fait par la base : deux erreurs simultanées comptent bien pour deux.
 */
export async function countFailure(tx: Prisma.TransactionClient, a: Row, action: string, ip?: string | null) {
  const { failedLogins } = await tx.groupAccount.update({ where: { id: a.id }, data: { failedLogins: { increment: 1 } }, select: { failedLogins: true } });
  await accountLog(tx, a, action, ip);
  if (failedLogins < config.security.maxFailedLogins) return;
  await tx.groupAccount.update({ where: { id: a.id }, data: { failedLogins: 0, lockedUntil: new Date(Date.now() + config.security.lockMinutes * 60_000) } });
  const closed = await revokeSessions(tx, a.id, 'compte bloqué après 5 erreurs');
  await accountLog(tx, a, 'group.auth.locked', ip, { minutes: config.security.lockMinutes, sessionsClosed: closed });
}

/** Un code n'est accepté qu'une fois, même envoyé deux fois en même temps : le pas de temps enregistré ne fait qu'avancer. */
async function consumeStep(tx: Prisma.TransactionClient, accountId: string, step: number) {
  const r = await tx.groupAccount.updateMany({ where: { id: accountId, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] }, data: { totpLastStep: step } });
  return r.count === 1;
}

/** Vérifie un code de l'application d'authentification du compte ; une erreur est comptée. */
export async function confirmTotp(tx: Prisma.TransactionClient, a: GroupAccount, code: string | undefined, ip?: string | null) {
  const step = a.totpEnabled && a.totpSecret && code ? totpStep(decrypt(a.totpSecret), code, a.totpLastStep) : null;
  if (step !== null && (await consumeStep(tx, a.id, step))) return true;
  await countFailure(tx, a, 'group.auth.2fa_failed', ip);
  return false;
}

/**
 * Identifiants possibles : une adresse e-mail, ou un téléphone. Un numéro local est essayé avec l'indicatif de
 * chaque pays pris en charge (le pays du compte n'est pas connu avant la connexion) ; le mot de passe départage.
 */
export function loginCandidates(identifier: string): { email: string | null; phones: string[] } {
  const id = (identifier ?? '').trim();
  if (id.includes('@')) return { email: id.toLowerCase(), phones: [] };
  const digits = id.replace(/[^\d+]/g, '');
  if (digits.replace('+', '').length < 8) return { email: null, phones: [] };
  if (digits.startsWith('+') || digits.startsWith('00')) return { email: null, phones: [normalizePhone(digits)] };
  return { email: null, phones: [...new Set(COUNTRIES.map((c) => normalizePhone(digits, c.dial)))] };
}

export class GroupLoginDto {
  @IsString() @IsNotEmpty() @MaxLength(160) identifier: string;
  @IsString() @IsNotEmpty() @MaxLength(200) password: string;
}

export class GroupCodeDto {
  @IsString() @IsNotEmpty() @MaxLength(2000) challenge: string;
  @IsString() @Length(6, 8) code: string;
}

export class GroupRecoveryLoginDto {
  @IsString() @IsNotEmpty() @MaxLength(2000) challenge: string;
  @IsString() @Length(8, 24) code: string;
}

export class GroupFirstPasswordDto {
  @IsString() @IsNotEmpty() @MaxLength(2000) token: string;
  @IsString() @MinLength(1) @MaxLength(200) password: string;
}

export class GroupFirstSetupDto {
  @IsString() @IsNotEmpty() @MaxLength(2000) token: string;
}

export class GroupFirstEnableDto {
  @IsString() @IsNotEmpty() @MaxLength(2000) token: string;
  @IsString() @IsNotEmpty() @MaxLength(2000) setupToken: string;
  @IsString() @Length(6, 8) code: string;
}

export class GroupPasswordDto {
  @IsString() @IsNotEmpty() @MaxLength(200) current: string;
  @IsString() @MinLength(1) @MaxLength(200) password: string;
}

export class GroupReconfigureDto {
  /** Code actuel de l'application, ou jeton remis après une connexion par code de récupération. */
  @IsOptional() @IsString() @MaxLength(8) code?: string;
  @IsOptional() @IsString() @MaxLength(2000) reconfigureToken?: string;
}

export class GroupEnableDto {
  @IsString() @IsNotEmpty() @MaxLength(2000) setupToken: string;
  @IsString() @Length(6, 8) code: string;
}

export class GroupCodeOnlyDto {
  @IsString() @Length(6, 8) code: string;
}

/** La console ne répond que sur l'adresse de la plateforme : sur l'adresse d'une école, ses routes n'existent pas. */
@Injectable()
export class GroupHostGuard implements CanActivate {
  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    if (schoolFromHost(req.headers.host, config.platformDomain)) throw new NotFoundException('La console du groupe s’ouvre sur l’adresse de Cahiora, pas sur celle d’une école');
    return true;
  }
}

@Injectable()
export class GroupGuard implements CanActivate {
  constructor(private jwt: JwtService, private db: GroupDb, private reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const token = req.cookies?.[GROUP_COOKIE];
    if (!token) throw new UnauthorizedException('Connexion requise');
    let p: { sub?: string; gid?: string; sid?: string };
    try {
      p = this.jwt.verify(token, { secret: groupKey(), audience: AUD.session });
    } catch {
      throw new UnauthorizedException('Session expirée');
    }
    if (!p.sub || !p.gid || !p.sid) throw new UnauthorizedException('Session expirée');
    const { sub, gid, sid } = p as { sub: string; gid: string; sid: string };
    const now = new Date();
    // Aucune mémoire intermédiaire : chaque appel relit la session, le compte et le groupe (T-09).
    const r = await this.db.inGroup(gid, async (tx) => {
      const s = await tx.groupSession.findUnique({
        where: { id: sid },
        select: {
          id: true, accountId: true, groupId: true, revokedAt: true, expiresAt: true, lastUsedAt: true,
          account: { select: { firstName: true, lastName: true, role: true, active: true, totpEnabled: true, mustChangePassword: true } },
        },
      });
      if (!s || s.accountId !== sub || s.groupId !== gid || s.revokedAt || s.expiresAt <= now) return 'expired' as const;
      if (now.getTime() - s.lastUsedAt.getTime() > IDLE_MINUTES * 60_000) {
        await tx.groupSession.update({ where: { id: s.id }, data: { revokedAt: now, revokedReason: 'inactivité' } });
        return 'expired' as const;
      }
      if (!s.account.active || !s.account.totpEnabled || s.account.mustChangePassword) return 'expired' as const;
      const g = await tx.schoolGroup.findUnique({ where: { id: gid }, select: { status: true } });
      if (g?.status !== 'ACTIVE') return 'suspended' as const;
      if (now.getTime() - s.lastUsedAt.getTime() > 60_000) await tx.groupSession.update({ where: { id: s.id }, data: { lastUsedAt: now } });
      return s.account;
    });
    if (r === 'expired') throw new UnauthorizedException('Session expirée');
    if (r === 'suspended') throw new ForbiddenException(SUSPENDED);
    req.groupActor = { accountId: sub, groupId: gid, sessionId: sid, name: `${r.firstName} ${r.lastName}`, role: r.role, ip: req.ip } satisfies GroupActor;
    const roles = this.reflector.getAllAndOverride<GroupRole[]>(GROUP_ROLES, [ctx.getHandler(), ctx.getClass()]);
    if (roles?.length && !roles.includes(r.role)) throw new ForbiddenException('Votre rôle dans le groupe ne permet pas cette action');
    return true;
  }
}

@Injectable()
export class GroupAuthService {
  private logger = new Logger('GroupAuth');
  constructor(private db: GroupDb, private jwt: JwtService) {}

  private sign(payload: Record<string, unknown>, audience: string, seconds: number) {
    return this.jwt.sign(payload, { secret: groupKey(), audience, expiresIn: seconds });
  }

  private read<T extends object>(token: string, audience: string): T | null {
    try {
      return this.jwt.verify<T>(token, { secret: groupKey(), audience });
    } catch {
      return null;
    }
  }

  /** Ouvre la session, seulement après la double authentification. */
  private async open(tx: Prisma.TransactionClient, a: Row, meta: Meta, how: string) {
    const now = new Date();
    await tx.groupAccount.update({ where: { id: a.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: now } });
    const s = await tx.groupSession.create({
      data: { accountId: a.id, groupId: a.groupId, ip: meta.ip ?? null, userAgent: meta.userAgent?.slice(0, 200) ?? null, expiresAt: new Date(now.getTime() + SESSION_HOURS * 3600_000) },
      select: { id: true },
    });
    await accountLog(tx, a, 'group.auth.login', meta.ip, { how });
    const token = this.sign({ sub: a.id, gid: a.groupId, sid: s.id }, AUD.session, SESSION_HOURS * 3600);
    return { token, sessionId: s.id };
  }

  private async state(tx: Prisma.TransactionClient, accountId: string, groupId: string) {
    const a = await tx.groupAccount.findUnique({ where: { id: accountId } });
    const g = await tx.schoolGroup.findUnique({ where: { id: groupId }, select: { status: true } });
    const usable = !!a && a.groupId === groupId && a.active && !(a.lockedUntil && a.lockedUntil > new Date());
    return { a: usable ? a : null, suspended: g?.status !== 'ACTIVE' };
  }

  /** Jeton d'étape (code, première connexion) encore valable : émis après le dernier changement de mot de passe. */
  private fresh(a: GroupAccount, at: number | undefined) {
    return !!at && !(a.passwordChangedAt && a.passwordChangedAt.getTime() > at);
  }

  /** Étape 1 : identifiant et mot de passe. Jamais de session à cette étape. */
  async login(dto: GroupLoginDto, meta: Meta) {
    const { email, phones } = loginCandidates(dto.identifier);
    const found = email || phones.length ? await this.db.lookup(email, phones) : [];
    if (!found.length) {
      await argon2.hash(dto.password); // même temps de réponse qu'avec un compte existant (SEC-024)
      this.logger.warn(`Console des groupes : identifiant inconnu (${maskIdentifier(dto.identifier)}) depuis ${meta.ip ?? '?'}`);
      throw new UnauthorizedException(LOGIN_FAILED);
    }
    for (const f of found) {
      const r = await this.db.inGroup(f.group_id, async (tx) => {
        const { a, suspended } = await this.state(tx, f.account_id, f.group_id);
        if (!a) {
          await argon2.hash(dto.password);
          const row = await tx.groupAccount.findUnique({ where: { id: f.account_id } });
          if (row) await accountLog(tx, row, 'group.auth.refused', meta.ip, { reason: row.active ? 'compte bloqué' : 'compte désactivé' });
          return null;
        }
        if (!(await argon2.verify(a.passwordHash, dto.password))) {
          await countFailure(tx, a, 'group.auth.failed', meta.ip);
          return null;
        }
        if (suspended) {
          await accountLog(tx, a, 'group.auth.refused', meta.ip, { reason: 'groupe suspendu' });
          return 'suspended' as const;
        }
        const at = Date.now();
        if (a.mustChangePassword || !a.totpEnabled || !a.totpSecret) {
          return { step: 'first-login' as const, token: this.sign({ sub: a.id, gid: a.groupId, at }, AUD.firstLogin, 900), needsPassword: a.mustChangePassword, needsTwoFactor: !a.totpEnabled };
        }
        return { step: 'code' as const, challenge: this.sign({ sub: a.id, gid: a.groupId, at }, AUD.challenge, 300) };
      });
      if (r === 'suspended') throw new ForbiddenException(SUSPENDED);
      if (r) return r;
    }
    throw new UnauthorizedException(LOGIN_FAILED);
  }

  /** Étape 2 : code de l'application d'authentification (à usage unique). */
  async verifyCode(dto: GroupCodeDto, meta: Meta) {
    const p = this.read<{ sub: string; gid: string; at: number }>(dto.challenge, AUD.challenge);
    if (!p?.sub || !p.gid) throw new UnauthorizedException(EXPIRED);
    const r = await this.db.inGroup(p.gid, async (tx) => {
      const { a, suspended } = await this.state(tx, p.sub, p.gid);
      if (!a || !a.totpEnabled || !a.totpSecret || a.mustChangePassword || !this.fresh(a, p.at)) return { error: new UnauthorizedException(CODE_FAILED) };
      if (suspended) return { error: new ForbiddenException(SUSPENDED) };
      if (!(await confirmTotp(tx, a, dto.code, meta.ip))) return { error: new UnauthorizedException(CODE_FAILED) };
      return { session: await this.open(tx, a, meta, 'code') };
    });
    if ('error' in r) throw r.error;
    return r.session;
  }

  /** Étape 2 bis : un code de récupération (téléphone perdu), consommé une seule fois. */
  async verifyRecoveryCode(dto: GroupRecoveryLoginDto, meta: Meta) {
    const p = this.read<{ sub: string; gid: string; at: number }>(dto.challenge, AUD.challenge);
    if (!p?.sub || !p.gid) throw new UnauthorizedException(EXPIRED);
    const wrong = new UnauthorizedException('Code de récupération incorrect ou déjà utilisé. Après 5 erreurs, le compte est bloqué 15 minutes.');
    const r = await this.db.inGroup(p.gid, async (tx) => {
      const { a, suspended } = await this.state(tx, p.sub, p.gid);
      if (!a || !a.totpEnabled || a.mustChangePassword || !this.fresh(a, p.at)) return { error: wrong };
      if (suspended) return { error: new ForbiddenException(SUSPENDED) };
      const used = looksLikeRecoveryCode(dto.code)
        ? await tx.groupRecoveryCode.updateMany({ where: { accountId: a.id, codeHash: hashCode(dto.code), usedAt: null }, data: { usedAt: new Date() } })
        : { count: 0 };
      if (used.count !== 1) {
        await countFailure(tx, a, 'group.auth.recovery_code_failed', meta.ip);
        return { error: wrong };
      }
      const remaining = await tx.groupRecoveryCode.count({ where: { accountId: a.id, usedAt: null } });
      await accountLog(tx, a, 'group.auth.recovery_code_used', meta.ip, { remaining });
      // Le téléphone est peut-être perdu avec une session ouverte : toutes les autres sessions sont fermées.
      await revokeSessions(tx, a.id, 'connexion par code de récupération');
      const session = await this.open(tx, a, meta, 'code de récupération');
      const reconfigureToken = this.sign({ sub: a.id, gid: a.groupId }, AUD.recovered, 600);
      return { session, remaining, reconfigureToken };
    });
    if ('error' in r) throw r.error;
    return r;
  }

  private firstLoginAccount(tx: Prisma.TransactionClient, token: string) {
    const p = this.read<{ sub: string; gid: string; at: number }>(token, AUD.firstLogin);
    if (!p?.sub || !p.gid) throw new UnauthorizedException(EXPIRED);
    return this.state(tx, p.sub, p.gid).then(({ a, suspended }) => {
      if (!a || !this.fresh(a, p.at)) throw new UnauthorizedException(EXPIRED);
      if (suspended) throw new ForbiddenException(SUSPENDED);
      return a;
    });
  }

  private gidOf(token: string, audience: string) {
    const p = this.read<{ gid: string }>(token, audience);
    if (!p?.gid) throw new UnauthorizedException(EXPIRED);
    return p.gid;
  }

  /** Première connexion, étape 1 : remplacer le mot de passe provisoire. */
  async firstPassword(dto: GroupFirstPasswordDto, meta: Meta) {
    assertGroupPassword(dto.password);
    return this.db.inGroup(this.gidOf(dto.token, AUD.firstLogin), async (tx) => {
      const a = await this.firstLoginAccount(tx, dto.token);
      if (!a.mustChangePassword) throw new BadRequestException('Le mot de passe a déjà été choisi : reconnectez-vous');
      if (await argon2.verify(a.passwordHash, dto.password)) throw new BadRequestException('Choisissez un mot de passe différent du mot de passe provisoire');
      const now = new Date();
      await tx.groupAccount.update({ where: { id: a.id }, data: { passwordHash: await hashPassword(dto.password), mustChangePassword: false, passwordChangedAt: now } });
      await accountLog(tx, a, 'group.auth.password_changed', meta.ip, { firstLogin: true });
      const at = Date.now();
      // Double authentification déjà configurée (cas d'un simple changement de mot de passe) : le code reste exigé.
      if (a.totpEnabled && a.totpSecret) return { step: 'code' as const, challenge: this.sign({ sub: a.id, gid: a.groupId, at }, AUD.challenge, 300) };
      return { step: 'first-login' as const, token: this.sign({ sub: a.id, gid: a.groupId, at }, AUD.firstLogin, 900), needsPassword: false, needsTwoFactor: true };
    });
  }

  /** Première connexion, étape 2 : préparer l'application d'authentification (rien n'est enregistré avant un code valide). */
  async firstSetup(dto: GroupFirstSetupDto) {
    return this.db.inGroup(this.gidOf(dto.token, AUD.firstLogin), async (tx) => {
      const a = await this.firstLoginAccount(tx, dto.token);
      if (a.mustChangePassword) throw new BadRequestException('Choisissez d’abord votre mot de passe');
      if (a.totpEnabled) throw new BadRequestException('La double authentification est déjà active : reconnectez-vous');
      return this.setupFor(a);
    });
  }

  private async setupFor(a: GroupAccount) {
    const secret = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(a.email ?? a.phone ?? a.id, 'Cahiora (groupe)', secret);
    const setupToken = this.sign({ sub: a.id, gid: a.groupId, sec: encrypt(secret) }, AUD.setup, 600);
    return { otpauth, qr: await QRCode.toDataURL(otpauth), secret, setupToken };
  }

  /** Lit le secret proposé et vérifie le code qu'il produit ; renvoie le secret et le pas de temps du code. */
  private checkSetup(a: GroupAccount, setupToken: string, code: string) {
    const p = this.read<{ sub: string; gid: string; sec: string }>(setupToken, AUD.setup);
    if (!p?.sec || p.sub !== a.id || p.gid !== a.groupId) throw new BadRequestException('Configuration expirée : recommencez');
    const secret = decrypt(p.sec);
    const step = totpStep(secret, code, null);
    if (step === null) throw new BadRequestException('Code incorrect : vérifiez l’heure de votre téléphone et saisissez le code affiché');
    return { secret, step };
  }

  private async replaceCodes(tx: Prisma.TransactionClient, a: Row) {
    const { codes, hashes } = generateRecoveryCodes();
    await tx.groupRecoveryCode.deleteMany({ where: { accountId: a.id } });
    await tx.groupRecoveryCode.createMany({ data: hashes.map((codeHash) => ({ accountId: a.id, groupId: a.groupId, codeHash })) });
    return codes;
  }

  /** Première connexion, étape 3 : activer la double authentification, recevoir ses codes, ouvrir la console. */
  async firstEnable(dto: GroupFirstEnableDto, meta: Meta) {
    return this.db.inGroup(this.gidOf(dto.token, AUD.firstLogin), async (tx) => {
      const a = await this.firstLoginAccount(tx, dto.token);
      if (a.mustChangePassword) throw new BadRequestException('Choisissez d’abord votre mot de passe');
      if (a.totpEnabled) throw new BadRequestException('La double authentification est déjà active : reconnectez-vous');
      const { secret, step } = this.checkSetup(a, dto.setupToken, dto.code);
      // Deux validations simultanées : une seule active la double authentification.
      const done = await tx.groupAccount.updateMany({ where: { id: a.id, totpEnabled: false }, data: { totpSecret: encrypt(secret), totpEnabled: true, totpLastStep: step } });
      if (done.count !== 1) throw new BadRequestException('La double authentification est déjà active : reconnectez-vous');
      await accountLog(tx, a, 'group.auth.2fa_enabled', meta.ip);
      const recoveryCodes = await this.replaceCodes(tx, a);
      await accountLog(tx, a, 'group.auth.recovery_codes_generated', meta.ip, { count: recoveryCodes.length });
      const session = await this.open(tx, a, meta, 'première connexion');
      return { session, recoveryCodes };
    });
  }

  async logout(token: string | undefined, meta: Meta) {
    if (!token) return;
    let p: { sub?: string; gid?: string; sid?: string };
    try {
      p = this.jwt.verify(token, { secret: groupKey(), audience: AUD.session, ignoreExpiration: true });
    } catch {
      return;
    }
    if (!p.sub || !p.gid || !p.sid) return;
    const { sub, gid, sid } = p as { sub: string; gid: string; sid: string };
    await this.db.inGroup(gid, async (tx) => {
      const r = await tx.groupSession.updateMany({ where: { id: sid, accountId: sub, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'déconnexion' } });
      const a = await tx.groupAccount.findUnique({ where: { id: sub } });
      if (a && r.count) await accountLog(tx, a, 'group.auth.logout', meta.ip);
    });
  }

  /** Le compte connecté, avec son groupe : jamais les notes internes de la plateforme (colonne non lisible par ce rôle). */
  async me(actor: GroupActor) {
    return this.db.inGroup(actor.groupId, async (tx) => {
      const a = await tx.groupAccount.findUniqueOrThrow({ where: { id: actor.accountId }, select: ACCOUNT_VIEW });
      const codes = await tx.groupRecoveryCode.findMany({ where: { accountId: a.id }, select: { usedAt: true } });
      const group = await tx.schoolGroup.findUniqueOrThrow({
        where: { id: actor.groupId },
        select: { id: true, name: true, legalName: true, promoter: true, phone: true, email: true, address: true, country: true, taxId: true, status: true },
      });
      return { account: { ...accountView(a), recoveryCodesRemaining: codes.filter((c) => !c.usedAt).length }, group, idleMinutes: IDLE_MINUTES, sessionHours: SESSION_HOURS };
    });
  }

  /** Changer son mot de passe : toutes ses autres sessions sont fermées. */
  async changePassword(actor: GroupActor, dto: GroupPasswordDto) {
    assertGroupPassword(dto.password);
    const r = await this.db.inGroup(actor.groupId, async (tx) => {
      const a = await tx.groupAccount.findUniqueOrThrow({ where: { id: actor.accountId } });
      // Une erreur compte comme à la connexion : une session volée ne permet pas d'essayer des mots de passe sans fin.
      if (!(await argon2.verify(a.passwordHash, dto.current))) {
        await countFailure(tx, a, 'group.auth.failed', actor.ip);
        return { error: new BadRequestException('Mot de passe actuel incorrect. Après 5 erreurs, le compte est bloqué 15 minutes.') };
      }
      if (dto.current === dto.password) return { error: new BadRequestException('Choisissez un mot de passe différent de l’actuel') };
      await tx.groupAccount.update({ where: { id: a.id }, data: { passwordHash: await hashPassword(dto.password), passwordChangedAt: new Date() } });
      const closed = await revokeSessions(tx, a.id, 'mot de passe changé', actor.sessionId);
      await accountLog(tx, a, 'group.auth.password_changed', actor.ip, { otherSessionsClosed: closed });
      return { ok: true, otherSessionsClosed: closed };
    });
    if ('error' in r) throw r.error;
    return r;
  }

  /** Sessions ouvertes du compte (appareils connectés). */
  async sessions(actor: GroupActor) {
    return this.db.inGroup(actor.groupId, async (tx) => {
      const rows = await tx.groupSession.findMany({
        where: { accountId: actor.accountId, revokedAt: null, expiresAt: { gt: new Date() }, lastUsedAt: { gt: new Date(Date.now() - IDLE_MINUTES * 60_000) } },
        select: { id: true, ip: true, userAgent: true, createdAt: true, lastUsedAt: true, expiresAt: true },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map((s) => ({ ...s, current: s.id === actor.sessionId }));
    });
  }

  async revokeSession(actor: GroupActor, id: string) {
    return this.db.inGroup(actor.groupId, async (tx) => {
      const r = await tx.groupSession.updateMany({ where: { id, accountId: actor.accountId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'fermée par son titulaire' } });
      if (!r.count) throw new NotFoundException('Session introuvable');
      const a = await tx.groupAccount.findUniqueOrThrow({ where: { id: actor.accountId } });
      await accountLog(tx, a, 'group.auth.session_revoked', actor.ip, { current: id === actor.sessionId });
      return { ok: true };
    });
  }

  async revokeOtherSessions(actor: GroupActor) {
    return this.db.inGroup(actor.groupId, async (tx) => {
      const closed = await revokeSessions(tx, actor.accountId, 'fermée par son titulaire', actor.sessionId);
      const a = await tx.groupAccount.findUniqueOrThrow({ where: { id: actor.accountId } });
      await accountLog(tx, a, 'group.auth.sessions_revoked', actor.ip, { count: closed });
      return { closed };
    });
  }

  /** Nouveau téléphone : avec le code actuel de l'application, ou juste après une connexion par code de récupération. */
  async reconfigureSetup(actor: GroupActor, dto: GroupReconfigureDto) {
    // Une erreur de code est comptée dans la transaction, qui est validée ; le refus n'est levé qu'ensuite.
    const r = await this.db.inGroup(actor.groupId, async (tx) => {
      const a = await tx.groupAccount.findUniqueOrThrow({ where: { id: actor.accountId } });
      if (dto.reconfigureToken) {
        const p = this.read<{ sub: string; gid: string }>(dto.reconfigureToken, AUD.recovered);
        if (p?.sub !== a.id || p.gid !== a.groupId) return { error: new ForbiddenException('Délai dépassé : saisissez un code de votre application, ou reconnectez-vous avec un code de récupération') };
      } else if (!(await confirmTotp(tx, a, dto.code, actor.ip))) {
        return { error: new ForbiddenException('Code actuel incorrect. Après 5 erreurs, le compte est bloqué 15 minutes.') };
      }
      return { setup: await this.setupFor(a) };
    });
    if ('error' in r) throw r.error;
    return r.setup;
  }

  async reconfigureEnable(actor: GroupActor, dto: GroupEnableDto) {
    return this.db.inGroup(actor.groupId, async (tx) => {
      const a = await tx.groupAccount.findUniqueOrThrow({ where: { id: actor.accountId } });
      const { secret, step } = this.checkSetup(a, dto.setupToken, dto.code);
      await tx.groupAccount.update({ where: { id: a.id }, data: { totpSecret: encrypt(secret), totpEnabled: true, totpLastStep: step } });
      await accountLog(tx, a, 'group.auth.2fa_reset', actor.ip);
      const recoveryCodes = await this.replaceCodes(tx, a);
      await accountLog(tx, a, 'group.auth.recovery_codes_generated', actor.ip, { count: recoveryCodes.length });
      // L'ancien téléphone peut avoir une session ouverte : toutes les autres sont fermées.
      const closed = await revokeSessions(tx, a.id, 'double authentification reconfigurée', actor.sessionId);
      return { ok: true, recoveryCodes, otherSessionsClosed: closed };
    });
  }

  /** Nouveaux codes de récupération, avec le code actuel de l'application ; les anciens ne servent plus. */
  async regenerateCodes(actor: GroupActor, code: string) {
    const r = await this.db.inGroup(actor.groupId, async (tx) => {
      const a = await tx.groupAccount.findUniqueOrThrow({ where: { id: actor.accountId } });
      if (!(await confirmTotp(tx, a, code, actor.ip))) return { error: new ForbiddenException('Code de votre application incorrect. Après 5 erreurs, le compte est bloqué 15 minutes.') };
      const recoveryCodes = await this.replaceCodes(tx, a);
      await accountLog(tx, a, 'group.auth.recovery_codes_generated', actor.ip, { count: recoveryCodes.length });
      return { recoveryCodes };
    });
    if ('error' in r) throw r.error;
    return r;
  }
}

@ApiTags('Console du groupe')
@Public()
@UseGuards(GroupHostGuard)
@Controller('group/auth')
export class GroupAuthController {
  constructor(private s: GroupAuthService) {}

  private meta(req: Request): Meta {
    return { ip: req.ip ?? null, userAgent: String(req.headers['user-agent'] ?? '') || null };
  }

  private cookie(res: Response, value: string | null) {
    const opts = { httpOnly: true, secure: config.cookieSecure, sameSite: 'strict' as const, path: COOKIE_PATH };
    if (value) res.cookie(GROUP_COOKIE, value, { ...opts, maxAge: SESSION_HOURS * 3600_000 });
    else res.clearCookie(GROUP_COOKIE, opts);
  }

  private actor(req: Request) {
    return (req as any).groupActor as GroupActor;
  }

  @Post('login') @Throttle({ default: { limit: 10, ttl: 60000 } }) @Header('Cache-Control', 'no-store')
  login(@Req() req: Request, @Body() dto: GroupLoginDto) { return this.s.login(dto, this.meta(req)); }

  @Post('code') @Throttle({ default: { limit: 10, ttl: 60000 } }) @Header('Cache-Control', 'no-store')
  async code(@Req() req: Request, @Body() dto: GroupCodeDto, @Res({ passthrough: true }) res: Response) {
    const r = await this.s.verifyCode(dto, this.meta(req));
    this.cookie(res, r.token);
    return { ok: true };
  }

  @Post('recovery') @Throttle({ default: { limit: 5, ttl: 60000 } }) @Header('Cache-Control', 'no-store')
  async recovery(@Req() req: Request, @Body() dto: GroupRecoveryLoginDto, @Res({ passthrough: true }) res: Response) {
    const r = await this.s.verifyRecoveryCode(dto, this.meta(req));
    this.cookie(res, r.session.token);
    return { ok: true, recoveryCodesRemaining: r.remaining, reconfigureToken: r.reconfigureToken };
  }

  @Post('first-login/password') @Throttle({ default: { limit: 10, ttl: 60000 } }) @Header('Cache-Control', 'no-store')
  firstPassword(@Req() req: Request, @Body() dto: GroupFirstPasswordDto) { return this.s.firstPassword(dto, this.meta(req)); }

  @Post('first-login/2fa/setup') @Throttle({ default: { limit: 10, ttl: 60000 } }) @Header('Cache-Control', 'no-store')
  firstSetup(@Body() dto: GroupFirstSetupDto) { return this.s.firstSetup(dto); }

  @Post('first-login/2fa/enable') @Throttle({ default: { limit: 10, ttl: 60000 } }) @Header('Cache-Control', 'no-store')
  async firstEnable(@Req() req: Request, @Body() dto: GroupFirstEnableDto, @Res({ passthrough: true }) res: Response) {
    const r = await this.s.firstEnable(dto, this.meta(req));
    this.cookie(res, r.session.token);
    return { ok: true, recoveryCodes: r.recoveryCodes };
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.s.logout(req.cookies?.[GROUP_COOKIE], this.meta(req));
    this.cookie(res, null);
    return { ok: true };
  }

  @Get('me') @UseGuards(GroupGuard) @Header('Cache-Control', 'no-store')
  me(@Req() req: Request) { return this.s.me(this.actor(req)); }

  @Post('password') @UseGuards(GroupGuard) @Throttle({ default: { limit: 10, ttl: 60000 } })
  password(@Req() req: Request, @Body() dto: GroupPasswordDto) { return this.s.changePassword(this.actor(req), dto); }

  @Get('sessions') @UseGuards(GroupGuard) @Header('Cache-Control', 'no-store')
  sessions(@Req() req: Request) { return this.s.sessions(this.actor(req)); }

  @Post('sessions/:id/revoke') @UseGuards(GroupGuard)
  revoke(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) { return this.s.revokeSession(this.actor(req), id); }

  @Post('sessions/revoke-others') @UseGuards(GroupGuard)
  revokeOthers(@Req() req: Request) { return this.s.revokeOtherSessions(this.actor(req)); }

  @Post('2fa/setup') @UseGuards(GroupGuard) @Throttle({ default: { limit: 10, ttl: 60000 } }) @Header('Cache-Control', 'no-store')
  setup(@Req() req: Request, @Body() dto: GroupReconfigureDto) { return this.s.reconfigureSetup(this.actor(req), dto); }

  @Post('2fa/enable') @UseGuards(GroupGuard) @Throttle({ default: { limit: 10, ttl: 60000 } }) @Header('Cache-Control', 'no-store')
  enable(@Req() req: Request, @Body() dto: GroupEnableDto) { return this.s.reconfigureEnable(this.actor(req), dto); }

  @Post('recovery-codes') @UseGuards(GroupGuard) @Throttle({ default: { limit: 5, ttl: 60000 } }) @Header('Cache-Control', 'no-store')
  regenerate(@Req() req: Request, @Body() dto: GroupCodeOnlyDto) { return this.s.regenerateCodes(this.actor(req), dto.code); }
}

