import {
  BadRequestException, Body, CanActivate, ConflictException, ForbiddenException, Controller, ExecutionContext, Get, Injectable, NotFoundException,
  OnModuleDestroy, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';
import { Prisma, PrismaClient, TenantStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { Type } from 'class-transformer';
import { IsEmail, IsEnum, IsNotEmpty, IsOptional, IsString, Length, Matches, MaxLength, MinLength, ValidateNested } from 'class-validator';
import type { Request, Response } from 'express';
import { ALLOW_PENDING_PASSWORD, AllowPendingPassword, forgetSessions, Public, RESERVED_SUBDOMAINS as RESERVED } from '../../common/auth';
import { decrypt, encrypt } from '../../common/util';
import { normalizePhone } from '../../common/util';
import { config, tenantOrigin } from '../../config';
import { hashPassword, totpStep, TOTP_SETUP_AUDIENCE } from '../auth/auth.service';
import { createSmsProvider } from '../notifications/sms.provider';
import { temporaryPassword } from '../settings/settings.service';

const COOKIE = 'erp_pt';
const SESSION_HOURS = 8;
const PLATFORM_2FA_AUDIENCE = 'platform-2fa';
const LOGIN_FAILED = 'Adresse e-mail ou mot de passe incorrect. Après 5 erreurs, le compte est bloqué 15 minutes.';
/** Sous-domaines réservés à la plateforme. */

export class DirectorInput {
  @IsString() @MaxLength(80) firstName: string;
  @IsString() @MaxLength(80) lastName: string;
  @IsString() @MaxLength(30) phone: string;
  @IsOptional() @IsEmail() email?: string;
}

export class CreateTenantDto {
  /** Identifiant de l'école, utilisé comme sous-domaine : lettres minuscules, chiffres et tirets. */
  @Matches(/^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/, { message: 'Identifiant : 3 à 30 caractères, lettres minuscules, chiffres ou tirets' })
  slug: string;
  @IsString() @MinLength(3) @MaxLength(160) name: string;
  @IsOptional() @IsString() @MaxLength(60) shortName?: string;
  @IsOptional() @Matches(/^[A-Z]{2}$/) country?: string;
  @Matches(/^[A-Z]{2,5}$/, { message: 'Préfixe des matricules : 2 à 5 lettres majuscules' }) matriculePrefix: string;
  @IsOptional() @Matches(/^[a-z0-9.-]+\.[a-z]{2,}$/, { message: 'Nom de domaine invalide' }) domain?: string;
  @IsString() @MaxLength(120) siteName: string;
  @ValidateNested() @Type(() => DirectorInput) director: DirectorInput;
}

export class UpdateTenantDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(160) name?: string;
  @IsOptional() @IsString() @MaxLength(60) shortName?: string | null;
  @IsOptional() @Matches(/^[a-z0-9.-]+\.[a-z]{2,}$/, { message: 'Nom de domaine invalide' }) domain?: string | null;
  @IsOptional() @IsEnum(TenantStatus) status?: TenantStatus;
  @IsOptional() @IsString() @MaxLength(4000) platformNotes?: string | null;
}

export class PlatformLoginDto {
  @IsEmail() email: string;
  @IsString() password: string;
}

export class PlatformTwoFactorDto {
  @IsString() @IsNotEmpty() @MaxLength(2000) challenge: string;
  @IsString() @Length(6, 8) code: string;
}

export class PlatformSetupDto {
  @IsOptional() @IsString() @Length(6, 8) code?: string;
}

export class PlatformEnableDto {
  @IsString() @Length(6, 8) code: string;
  @IsString() @IsNotEmpty() @MaxLength(2000) setupToken: string;
}

export class PlatformPasswordDto {
  @IsString() current: string;
  @IsString() @MinLength(12, { message: 'Au moins 12 caractères' }) @MaxLength(200) password: string;
}

type PlatformActor = { id: string; name: string };

/**
 * Accès à la base pour la plateforme : création des écoles et comptage de leur activité.
 * Rôle dédié erp_platform (SEC-009) : ni propriétaire des tables ni exempté de la Row Level Security,
 * avec seulement les droits utiles à la plateforme (migration securite_lot3). Le rôle applicatif des
 * écoles (erp_app) ne peut ni créer d'école ni lire les tables de la plateforme.
 * Sans DATABASE_PLATFORM_URL (poste de développement), l'accès propriétaire est utilisé comme avant.
 */
@Injectable()
export class PlatformDb extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super({ datasources: { db: { url: process.env.DATABASE_PLATFORM_URL || process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL } } });
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
  inTenant<T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    }, { timeout: 30000 });
  }
}

@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(private jwt: JwtService, private db: PlatformDb, private reflector: Reflector) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const token = req.cookies?.[COOKIE];
    if (!token) throw new UnauthorizedException('Connexion requise');
    let p: { sub: string; name: string; iat: number; at?: number };
    try {
      p = this.jwt.verify(token, { secret: config.jwt.accessSecret, audience: 'platform' });
    } catch {
      throw new UnauthorizedException('Session expirée');
    }
    // Un compte désactivé ou dont le mot de passe a changé depuis perd sa session immédiatement.
    // Une déconnexion refuse tout jeton émis avant elle (SEC-021) ; « at » est l'heure d'émission en millisecondes.
    const admin = await this.db.platformAdmin.findUnique({ where: { id: p.sub }, select: { active: true, passwordChangedAt: true, sessionsRevokedAt: true, mustChangePassword: true, totpEnabled: true } });
    const issuedAt = p.at ?? p.iat * 1000;
    if (!admin?.active || (admin.passwordChangedAt && admin.passwordChangedAt.getTime() > p.iat * 1000 + 999)
      || (admin.sessionsRevokedAt && admin.sessionsRevokedAt.getTime() >= issuedAt)) throw new UnauthorizedException('Session expirée');
    req.platformAdmin = { id: p.sub, name: p.name } satisfies PlatformActor;
    // Mot de passe provisoire : seuls le compte, le changement de mot de passe et la double authentification répondent (SEC-023).
    // Double authentification obligatoire pour le Super Admin quand l'obligation est active (SEC-020).
    const pending2fa = config.security.enforceTwoFactor && !admin.totpEnabled;
    if ((admin.mustChangePassword || pending2fa) && !this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_PASSWORD, [ctx.getHandler(), ctx.getClass()])) {
      throw new ForbiddenException(admin.mustChangePassword ? 'Choisissez d’abord un nouveau mot de passe' : 'Activez d’abord la double authentification');
    }
    return true;
  }
}

@Injectable()
export class PlatformService {
  private sms = createSmsProvider(config.smsProvider);
  constructor(private db: PlatformDb, private jwt: JwtService) {}

  private log(admin: PlatformActor | null, action: string, tenantId: string | null, data?: unknown) {
    return this.db.platformAuditLog.create({ data: { adminId: admin?.id ?? null, action, tenantId, data: (data ?? undefined) as any } });
  }

  /** Trace aussi dans le journal de l'école ce que la plateforme fait sur ses comptes (SEC-010). Jamais les notes internes. */
  private schoolLog(tx: Prisma.TransactionClient, admin: PlatformActor, tenantId: string, action: string, entity: string, entityId: string, data?: Record<string, unknown>) {
    return tx.auditLog.createMany({
      data: [{ tenantId, userId: null, userName: `Super Admin de la plateforme (${admin.name})`, action, entity, entityId, data: (data ?? undefined) as any }],
    });
  }

  private sign(admin: { id: string; name: string }) {
    return this.jwt.sign({ sub: admin.id, name: admin.name, at: Date.now() }, { secret: config.jwt.accessSecret, audience: 'platform', expiresIn: SESSION_HOURS * 3600 });
  }

  private async countFailure(admin: { id: string; failedLogins: number }, what: string) {
    const failed = admin.failedLogins + 1;
    const lock = failed >= config.security.maxFailedLogins;
    await this.db.platformAdmin.update({ where: { id: admin.id }, data: { failedLogins: lock ? 0 : failed, lockedUntil: lock ? new Date(Date.now() + config.security.lockMinutes * 60000) : null } });
    await this.log(null, lock ? 'platform.auth.locked' : what, null, { adminId: admin.id });
  }

  private async open(admin: { id: string; name: string; email: string; mustChangePassword: boolean }) {
    await this.db.platformAdmin.update({ where: { id: admin.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });
    await this.log({ id: admin.id, name: admin.name }, 'platform.auth.login', null);
    return { token: this.sign(admin), admin: { id: admin.id, name: admin.name, email: admin.email, mustChangePassword: admin.mustChangePassword } };
  }

  /** Mot de passe, puis code de l'application d'authentification si la double authentification est active (SEC-021). */
  async login(dto: PlatformLoginDto) {
    const admin = await this.db.platformAdmin.findUnique({ where: { email: dto.email.trim().toLowerCase() } });
    const fail = new UnauthorizedException(LOGIN_FAILED);
    // Compte inconnu, désactivé ou bloqué : même calcul et même réponse (SEC-024).
    if (!admin || !admin.active || (admin.lockedUntil && admin.lockedUntil > new Date())) {
      await argon2.hash(dto.password);
      throw fail;
    }
    if (!(await argon2.verify(admin.passwordHash, dto.password))) {
      await this.countFailure(admin, 'platform.auth.failed');
      throw fail;
    }
    if (admin.totpEnabled && admin.totpSecret) {
      await this.db.platformAdmin.update({ where: { id: admin.id }, data: { failedLogins: 0 } });
      const challenge = this.jwt.sign({ sub: admin.id }, { secret: config.jwt.accessSecret, audience: PLATFORM_2FA_AUDIENCE, expiresIn: 300 });
      return { twoFactorRequired: true as const, challenge };
    }
    return { twoFactorRequired: false as const, ...(await this.open(admin)) };
  }

  async verifyTwoFactor(dto: PlatformTwoFactorDto) {
    let p: { sub: string };
    try {
      p = this.jwt.verify(dto.challenge, { secret: config.jwt.accessSecret, audience: PLATFORM_2FA_AUDIENCE });
    } catch {
      throw new UnauthorizedException('Délai dépassé, reconnectez-vous');
    }
    const admin = await this.db.platformAdmin.findUnique({ where: { id: p.sub } });
    const wrong = new UnauthorizedException('Code incorrect. Après 5 erreurs, le compte est bloqué 15 minutes.');
    if (!admin?.active || !admin.totpEnabled || !admin.totpSecret || (admin.lockedUntil && admin.lockedUntil > new Date())) throw wrong;
    const step = totpStep(decrypt(admin.totpSecret), dto.code, admin.totpLastStep);
    if (step === null) {
      await this.countFailure(admin, 'platform.auth.2fa_failed');
      throw wrong;
    }
    await this.db.platformAdmin.update({ where: { id: admin.id }, data: { totpLastStep: step } });
    return this.open(admin);
  }

  /** Déconnexion : tous les jetons Super Admin déjà émis pour ce compte sont refusés (SEC-021). */
  async logout(token: string | undefined) {
    if (!token) return;
    let p: { sub: string };
    try {
      p = this.jwt.verify(token, { secret: config.jwt.accessSecret, audience: 'platform', ignoreExpiration: true });
    } catch {
      return;
    }
    await this.db.platformAdmin.updateMany({ where: { id: p.sub }, data: { sessionsRevokedAt: new Date() } });
    await this.log({ id: p.sub, name: '' }, 'platform.auth.logout', null);
  }

  /** Prépare la double authentification sans toucher au compte (même principe que les écoles, SEC-019). */
  async setupTwoFactor(actor: PlatformActor, currentCode?: string) {
    const a = await this.db.platformAdmin.findUniqueOrThrow({ where: { id: actor.id } });
    if (a.totpEnabled && a.totpSecret) {
      if (!currentCode) throw new ForbiddenException("La double authentification est déjà active : saisissez le code actuel pour la reconfigurer");
      const step = totpStep(decrypt(a.totpSecret), currentCode, a.totpLastStep);
      if (step === null) {
        await this.countFailure(a, 'platform.auth.2fa_failed');
        throw new ForbiddenException('Code actuel incorrect');
      }
      await this.db.platformAdmin.update({ where: { id: a.id }, data: { totpLastStep: step } });
    }
    const secret = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(a.email, 'Plateforme Cahiora', secret);
    const setupToken = this.jwt.sign({ sub: a.id, sec: encrypt(secret) }, { secret: config.jwt.accessSecret, audience: `platform-${TOTP_SETUP_AUDIENCE}`, expiresIn: 600 });
    return { otpauth, qr: await QRCode.toDataURL(otpauth), secret, setupToken };
  }

  async enableTwoFactor(actor: PlatformActor, dto: PlatformEnableDto) {
    let p: { sub: string; sec: string };
    try {
      p = this.jwt.verify(dto.setupToken, { secret: config.jwt.accessSecret, audience: `platform-${TOTP_SETUP_AUDIENCE}` });
    } catch {
      throw new BadRequestException('Configuration expirée : recommencez');
    }
    if (p.sub !== actor.id) throw new ForbiddenException();
    const secret = decrypt(p.sec);
    const step = totpStep(secret, dto.code, null);
    if (step === null) throw new BadRequestException('Code incorrect');
    const a = await this.db.platformAdmin.findUniqueOrThrow({ where: { id: actor.id } });
    await this.db.platformAdmin.update({ where: { id: a.id }, data: { totpSecret: encrypt(secret), totpEnabled: true, totpLastStep: step } });
    await this.log(actor, a.totpEnabled ? 'platform.auth.2fa_reset' : 'platform.auth.2fa_enabled', null);
    return { ok: true };
  }

  async me(actor: PlatformActor) {
    const a = await this.db.platformAdmin.findUnique({ where: { id: actor.id } });
    if (!a?.active) throw new UnauthorizedException('Session expirée');
    return { id: a.id, name: a.name, email: a.email, mustChangePassword: a.mustChangePassword, totpEnabled: a.totpEnabled, mustSetupTwoFactor: config.security.enforceTwoFactor && !a.totpEnabled, platformDomain: config.platformDomain || null };
  }

  async changePassword(actor: PlatformActor, dto: PlatformPasswordDto) {
    const a = await this.db.platformAdmin.findUniqueOrThrow({ where: { id: actor.id } });
    if (!(await argon2.verify(a.passwordHash, dto.current))) throw new BadRequestException('Mot de passe actuel incorrect');
    await this.db.platformAdmin.update({ where: { id: a.id }, data: { passwordHash: await hashPassword(dto.password), mustChangePassword: false, passwordChangedAt: new Date() } });
    await this.log(actor, 'platform.auth.password_changed', null);
    return { token: this.sign(a) };
  }

  /** Écoles clientes avec leur activité (effectifs, comptes, sites). */
  async tenants() {
    const tenants = await this.db.tenant.findMany({ orderBy: { createdAt: 'asc' } });
    return Promise.all(tenants.map(async (t) => {
      const stats = await this.db.inTenant(t.id, async (tx) => {
        const [students, staff, sites, lastSession] = await Promise.all([
          tx.student.count({ where: { status: 'ACTIVE' } }),
          tx.user.count({ where: { status: 'ACTIVE', roles: { some: { role: { notIn: ['PARENT', 'ELEVE'] } } } } }),
          tx.site.count({ where: { active: true } }),
          tx.session.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
        ]);
        return { students, staff, sites, lastActivityAt: lastSession?.createdAt ?? null };
      });
      return {
        id: t.id, slug: t.slug, name: t.name, shortName: t.shortName, country: t.country, status: t.status, domain: t.domain,
        platformNotes: t.platformNotes, createdAt: t.createdAt, demo: !!(t.settings as any)?.demo, ...stats,
      };
    }));
  }

  async createTenant(actor: PlatformActor, dto: CreateTenantDto) {
    if (RESERVED.includes(dto.slug)) throw new BadRequestException('Cet identifiant est réservé à la plateforme');
    const exists = await this.db.tenant.findFirst({ where: { OR: [{ slug: dto.slug }, ...(dto.domain ? [{ domain: dto.domain }] : [])] } });
    if (exists) throw new ConflictException(exists.slug === dto.slug ? 'Cet identifiant est déjà utilisé' : 'Ce nom de domaine est déjà utilisé');
    const password = temporaryPassword();
    const phone = normalizePhone(dto.director.phone);
    const tenant = await this.db.tenant.create({
      data: {
        slug: dto.slug, name: dto.name.trim(), shortName: dto.shortName?.trim() || null, country: dto.country ?? 'BJ', domain: dto.domain ?? null,
        settings: { matriculePrefix: dto.matriculePrefix },
      },
    });
    const director = await this.db.inTenant(tenant.id, async (tx) => {
      await tx.site.create({ data: { tenantId: tenant.id, name: dto.siteName.trim() } });
      const u = await tx.user.create({
        data: {
          tenantId: tenant.id, firstName: dto.director.firstName.trim(), lastName: dto.director.lastName.trim().toUpperCase(), phone,
          email: dto.director.email?.toLowerCase() ?? null, passwordHash: await hashPassword(password), mustChangePassword: true,
          roles: { create: [{ tenantId: tenant.id, role: 'DIRECTION' }] },
        },
      });
      await this.schoolLog(tx, actor, tenant.id, 'platform.tenant.created', 'User', u.id, { slug: dto.slug });
      return u;
    });
    await this.log(actor, 'platform.tenant.created', tenant.id, { slug: dto.slug, name: dto.name, directorId: director.id });
    await this.sms.send(phone, `Votre espace ${tenant.shortName ?? tenant.name} est prêt : ${tenantOrigin(tenant)}/connexion. Identifiant : ${phone}. Mot de passe provisoire : ${password}. Changez-le à la première connexion.`);
    return { tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name }, director: { identifier: phone, temporaryPassword: password } };
  }

  async updateTenant(actor: PlatformActor, id: string, dto: UpdateTenantDto) {
    const t = await this.db.tenant.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('École introuvable');
    if (dto.domain) {
      const other = await this.db.tenant.findFirst({ where: { domain: dto.domain, NOT: { id } } });
      if (other) throw new ConflictException('Ce nom de domaine est déjà utilisé');
    }
    const updated = await this.db.tenant.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.shortName !== undefined ? { shortName: dto.shortName?.trim() || null } : {}),
        ...(dto.domain !== undefined ? { domain: dto.domain || null } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.platformNotes !== undefined ? { platformNotes: dto.platformNotes || null } : {}),
      },
    });
    if (dto.status) forgetSessions({ tenantId: id });
    const visible = Object.fromEntries((['name', 'shortName', 'domain', 'status'] as const).filter((k) => dto[k] !== undefined && dto[k] !== (t as any)[k]).map((k) => [k, dto[k]]));
    if (Object.keys(visible).length) {
      const action = visible.status ? `platform.tenant.${visible.status === 'SUSPENDED' ? 'suspended' : 'reactivated'}` : 'platform.tenant.updated';
      await this.db.inTenant(id, (tx) => this.schoolLog(tx, actor, id, action, 'Tenant', id, visible));
    }
    await this.log(actor, dto.status && dto.status !== t.status ? `platform.tenant.${dto.status === 'SUSPENDED' ? 'suspended' : 'reactivated'}` : 'platform.tenant.updated', id, dto);
    return updated;
  }

  /** Nouveau mot de passe provisoire pour le premier compte Direction actif de l'école. */
  async resetDirector(actor: PlatformActor, id: string) {
    const t = await this.db.tenant.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('École introuvable');
    const password = temporaryPassword();
    const user = await this.db.inTenant(id, async (tx) => {
      const u = await tx.user.findFirst({ where: { status: 'ACTIVE', roles: { some: { role: 'DIRECTION' } } }, orderBy: { createdAt: 'asc' } });
      if (!u) throw new NotFoundException("Cette école n'a aucun compte Direction actif");
      // La 2FA est aussi retirée (téléphone perdu de la direction) : à réactiver à la prochaine connexion.
      await tx.user.update({ where: { id: u.id }, data: { passwordHash: await hashPassword(password), mustChangePassword: true, failedLogins: 0, lockedUntil: null, totpEnabled: false, totpSecret: null, totpLastStep: null } });
      await tx.session.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
      forgetSessions({ userId: u.id });
      await this.schoolLog(tx, actor, id, 'platform.director_reset', 'User', u.id, { name: `${u.firstName} ${u.lastName}` });
      return u;
    });
    await this.log(actor, 'platform.tenant.director_reset', id, { userId: user.id });
    if (user.phone) await this.sms.send(user.phone, `${t.shortName ?? t.name} : votre mot de passe provisoire est ${password}. Changez-le à la connexion.`);
    return { identifier: user.phone ?? user.email, name: `${user.firstName} ${user.lastName}`, temporaryPassword: password };
  }

  audit() {
    return this.db.platformAuditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
  }

  /** Caddy ne délivre un certificat HTTPS que pour une adresse qui sert réellement une école (ou la plateforme). */
  async tlsAllowed(rawDomain: string) {
    const host = (rawDomain ?? '').toLowerCase().trim();
    if (!host) return false;
    // Installation à une seule école : l'adresse du site (SITE_ADDRESS) limite déjà le certificat à son domaine.
    if (!config.platformDomain) return true;
    if (host === config.platformDomain || host === `www.${config.platformDomain}`) return true;
    if (await this.db.tenant.findUnique({ where: { domain: host } })) return true;
    if (!host.endsWith(`.${config.platformDomain}`)) return false;
    const sub = host.slice(0, -(config.platformDomain.length + 1));
    return !sub.includes('.') && !!(await this.db.tenant.findUnique({ where: { slug: sub } }));
  }

  /** Quelle école sert cette adresse ? Domaine propre, puis sous-domaine de la plateforme, puis école par défaut. */
  async resolve(rawHost: string) {
    const host = (rawHost ?? '').toLowerCase().split(':')[0].trim();
    let slug: string | null = null;
    const byDomain = host ? await this.db.tenant.findUnique({ where: { domain: host } }) : null;
    if (byDomain) slug = byDomain.slug;
    else if (config.platformDomain && host.endsWith(`.${config.platformDomain}`)) {
      const sub = host.slice(0, -(config.platformDomain.length + 1));
      if (!sub.includes('.') && !RESERVED.includes(sub)) slug = sub;
    } else if (host !== config.platformDomain && config.defaultTenant) slug = config.defaultTenant;
    // Aucune école à cette adresse (accueil de la plateforme) : réponse normale, le site affiche l'accueil.
    const t = byDomain ?? (slug ? await this.db.tenant.findUnique({ where: { slug } }) : null);
    if (!t) return { slug: null, suspended: false };
    return { slug: t.slug, suspended: t.status === 'SUSPENDED' };
  }
}

@ApiTags('Plateforme')
@Public()
@Controller()
export class PlatformController {
  constructor(private s: PlatformService) {}

  private cookie(res: Response, value: string | null) {
    const opts = { httpOnly: true, secure: config.cookieSecure, sameSite: 'strict' as const, path: '/api/v1/platform' };
    if (value) res.cookie(COOKIE, value, { ...opts, maxAge: SESSION_HOURS * 3600000 });
    else res.clearCookie(COOKIE, opts);
  }

  @Get('platform/resolve')
  resolve(@Query('host') host: string) { return this.s.resolve(host); }

  @Get('platform/tls-check')
  async tls(@Query('domain') domain: string) {
    if (!(await this.s.tlsAllowed(domain))) throw new NotFoundException();
    return { ok: true };
  }

  @Post('platform/auth/login') @Throttle({ default: { limit: 10, ttl: 60000 } })
  async login(@Body() dto: PlatformLoginDto, @Res({ passthrough: true }) res: Response) {
    const r = await this.s.login(dto);
    if (r.twoFactorRequired) return { twoFactorRequired: true, challenge: r.challenge };
    this.cookie(res, r.token);
    return r.admin;
  }

  @Post('platform/auth/2fa/verify') @Throttle({ default: { limit: 10, ttl: 60000 } })
  async verify(@Body() dto: PlatformTwoFactorDto, @Res({ passthrough: true }) res: Response) {
    const r = await this.s.verifyTwoFactor(dto);
    this.cookie(res, r.token);
    return r.admin;
  }

  @Post('platform/auth/logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.s.logout(req.cookies?.[COOKIE]);
    this.cookie(res, null);
    return { ok: true };
  }

  @Post('platform/auth/2fa/setup') @UseGuards(PlatformGuard) @AllowPendingPassword() @Throttle({ default: { limit: 10, ttl: 60000 } })
  setup2fa(@Req() req: Request, @Body() dto: PlatformSetupDto) { return this.s.setupTwoFactor((req as any).platformAdmin, dto.code); }

  @Post('platform/auth/2fa/enable') @UseGuards(PlatformGuard) @AllowPendingPassword() @Throttle({ default: { limit: 10, ttl: 60000 } })
  enable2fa(@Req() req: Request, @Body() dto: PlatformEnableDto) { return this.s.enableTwoFactor((req as any).platformAdmin, dto); }

  @Post('platform/auth/password') @UseGuards(PlatformGuard) @AllowPendingPassword()
  async password(@Req() req: Request, @Body() dto: PlatformPasswordDto, @Res({ passthrough: true }) res: Response) {
    const r = await this.s.changePassword((req as any).platformAdmin, dto);
    this.cookie(res, r.token);
    return { ok: true };
  }

  @Get('platform/me') @UseGuards(PlatformGuard) @AllowPendingPassword()
  me(@Req() req: Request) { return this.s.me((req as any).platformAdmin); }

  @Get('platform/tenants') @UseGuards(PlatformGuard)
  tenants() { return this.s.tenants(); }

  @Post('platform/tenants') @UseGuards(PlatformGuard)
  create(@Req() req: Request, @Body() dto: CreateTenantDto) { return this.s.createTenant((req as any).platformAdmin, dto); }

  @Patch('platform/tenants/:id') @UseGuards(PlatformGuard)
  update(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTenantDto) { return this.s.updateTenant((req as any).platformAdmin, id, dto); }

  @Post('platform/tenants/:id/reset-director') @UseGuards(PlatformGuard)
  resetDirector(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) { return this.s.resetDirector((req as any).platformAdmin, id); }

  @Get('platform/audit') @UseGuards(PlatformGuard)
  audit() { return this.s.audit(); }
}
