import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { User } from '@prisma/client';
import * as argon2 from 'argon2';
import { createHash, randomBytes, randomInt } from 'crypto';
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';
import { config } from '../../config';
import { AccessTokenPayload, Actor } from '../../common/auth';
import { AuditService } from '../../common/audit.service';
import { PrismaService, Tx } from '../../common/prisma.service';
import { decrypt, encrypt, normalizePhone } from '../../common/util';
import { createSmsProvider } from '../notifications/sms.provider';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Une exception levée dans une transaction l'annule. Pour qu'un échec soit quand même
 * enregistré (compteur d'échecs, révocation), la transaction renvoie l'erreur, levée après validation.
 */
class Deferred {
  constructor(readonly error: Error) {}
}
async function settle<T>(p: Promise<T | Deferred>): Promise<T> {
  const r = await p;
  if (r instanceof Deferred) throw r.error;
  return r;
}

export interface SessionMeta {
  ip?: string;
  userAgent?: string;
}

export interface IssuedTokens {
  accessToken: string;
  refreshCookie: string;
  expiresIn: number;
}

/** Politique de mot de passe (CDC §6.1) : 8 caractères minimum, lettres et chiffres. */
export function assertPasswordPolicy(pw: string) {
  if (pw.length < 8 || !/[a-zA-Z]/.test(pw) || !/\d/.test(pw)) {
    throw new BadRequestException('Le mot de passe doit contenir au moins 8 caractères, dont des lettres et des chiffres');
  }
}

export const hashPassword = (pw: string) => argon2.hash(pw, { type: argon2.argon2id });

@Injectable()
export class AuthService {
  private sms = createSmsProvider(config.smsProvider);

  constructor(
    private db: PrismaService,
    private jwt: JwtService,
    private audit: AuditService,
  ) {}

  async tenantBySlug(slug: string) {
    const t = await this.db.tenant.findUnique({ where: { slug } });
    if (!t) throw new UnauthorizedException('Établissement inconnu');
    return t;
  }

  private identifierWhere(identifier: string) {
    const id = identifier.trim();
    return id.includes('@') ? { email: id.toLowerCase() } : { phone: normalizePhone(id) };
  }

  /** Téléphone, e-mail, ou matricule pour les comptes élèves. */
  private async findByIdentifier(tx: Tx, identifier: string) {
    const id = identifier.trim();
    if (!id.includes('@') && /[a-z]/i.test(id)) {
      const student = await tx.student.findFirst({ where: { matricule: id.toUpperCase() }, select: { userId: true } });
      if (!student?.userId) return null;
      return tx.user.findUnique({ where: { id: student.userId }, include: { roles: true } });
    }
    return tx.user.findFirst({ where: this.identifierWhere(id), include: { roles: true } });
  }

  async login(tenantSlug: string, identifier: string, password: string, meta: SessionMeta) {
    const tenant = await this.tenantBySlug(tenantSlug);
    return settle(this.db.forTenant(tenant.id, async (tx) => {
      const user = await this.findByIdentifier(tx, identifier);
      const fail = new UnauthorizedException('Identifiant ou mot de passe incorrect');
      if (!user || user.status !== 'ACTIVE') {
        await argon2.hash(password); // temps constant : ne révèle pas l'existence du compte
        throw fail;
      }
      if (user.lockedUntil && user.lockedUntil > new Date()) {
        const min = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
        throw new ForbiddenException(`Compte bloqué après plusieurs échecs. Réessayez dans ${min} min.`);
      }
      if (!(await argon2.verify(user.passwordHash, password))) {
        const failed = user.failedLogins + 1;
        const lock = failed >= config.security.maxFailedLogins;
        await tx.user.update({
          where: { id: user.id },
          data: {
            failedLogins: lock ? 0 : failed,
            // Blocage progressif : 15 min, doublé à chaque nouveau blocage le même jour serait une évolution.
            lockedUntil: lock ? new Date(Date.now() + config.security.lockMinutes * 60000) : null,
          },
        });
        await this.audit.log(tx, null, lock ? 'auth.locked' : 'auth.failed', 'User', user.id, { tenantId: tenant.id, ip: meta.ip });
        return new Deferred(fail);
      }
      await tx.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } });

      if (user.totpEnabled) {
        const challenge = this.jwt.sign({ sub: user.id, tid: tenant.id, purpose: '2fa' }, { secret: config.jwt.accessSecret, expiresIn: 300 });
        return { twoFactorRequired: true as const, challenge };
      }
      const needs2fa = config.security.enforceTwoFactor && user.roles.some((r) => config.security.twoFactorRoles.includes(r.role));
      const tokens = await this.openSession(tx, user, meta);
      return { twoFactorRequired: false as const, ...tokens, mustSetupTwoFactor: needs2fa, mustChangePassword: user.mustChangePassword };
    }));
  }

  async verifyTwoFactor(challenge: string, code: string, meta: SessionMeta) {
    let p: { sub: string; tid: string; purpose: string };
    try {
      p = this.jwt.verify(challenge, { secret: config.jwt.accessSecret });
    } catch {
      throw new UnauthorizedException('Délai dépassé, reconnectez-vous');
    }
    if (p.purpose !== '2fa') throw new UnauthorizedException();
    return this.db.forTenant(p.tid, async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: p.sub }, include: { roles: true } });
      if (!user.totpSecret || !authenticator.check(code.replace(/\s/g, ''), decrypt(user.totpSecret))) {
        throw new UnauthorizedException('Code incorrect');
      }
      const tokens = await this.openSession(tx, user, meta);
      return { twoFactorRequired: false as const, ...tokens, mustChangePassword: user.mustChangePassword };
    });
  }

  private async openSession(tx: Tx, user: User & { roles: { role: any; siteId: string | null }[] }, meta: SessionMeta) {
    const token = randomBytes(48).toString('base64url');
    const session = await tx.session.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        refreshTokenHash: sha256(token),
        ip: meta.ip,
        userAgent: meta.userAgent?.slice(0, 300),
        expiresAt: new Date(Date.now() + config.jwt.refreshTtlDays * 86400000),
      },
    });
    await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.audit.log(tx, null, 'auth.login', 'User', user.id, { tenantId: user.tenantId, ip: meta.ip, userAgent: meta.userAgent });
    return this.issue(user, session.id, token);
  }

  private issue(user: User & { roles: { role: any; siteId: string | null }[] }, sessionId: string, refreshToken: string): IssuedTokens {
    const payload: AccessTokenPayload = {
      sub: user.id,
      tid: user.tenantId,
      sid: sessionId,
      name: `${user.firstName} ${user.lastName}`,
      roles: user.roles.map((r) => ({ role: r.role, siteId: r.siteId })),
    };
    return {
      accessToken: this.jwt.sign(payload, { secret: config.jwt.accessSecret, expiresIn: config.jwt.accessTtlSeconds }),
      refreshCookie: `${user.tenantId}.${sessionId}.${refreshToken}`,
      expiresIn: config.jwt.accessTtlSeconds,
    };
  }

  /** Rotation du jeton de renouvellement ; une réutilisation d'ancien jeton révoque la session (vol présumé). */
  async refresh(cookie: string | undefined, meta: SessionMeta) {
    const [tenantId, sessionId, token] = (cookie ?? '').split('.');
    if (!tenantId || !sessionId || !token) throw new UnauthorizedException('Session expirée');
    return settle(this.db.forTenant(tenantId, async (tx) => {
      const s = await tx.session.findUnique({ where: { id: sessionId }, include: { user: { include: { roles: true } } } });
      if (!s || s.revokedAt || s.expiresAt < new Date() || s.user.status !== 'ACTIVE') throw new UnauthorizedException('Session expirée');
      if (s.refreshTokenHash !== sha256(token)) {
        await tx.session.update({ where: { id: s.id }, data: { revokedAt: new Date() } });
        await this.audit.log(tx, null, 'auth.refresh_reuse', 'Session', s.id, { tenantId, ip: meta.ip });
        return new Deferred(new UnauthorizedException('Session expirée'));
      }
      const next = randomBytes(48).toString('base64url');
      await tx.session.update({ where: { id: s.id }, data: { refreshTokenHash: sha256(next), lastUsedAt: new Date(), ip: meta.ip } });
      return { ...this.issue(s.user, s.id, next), mustChangePassword: s.user.mustChangePassword };
    }));
  }

  async logout(cookie: string | undefined) {
    const [tenantId, sessionId] = (cookie ?? '').split('.');
    if (!tenantId || !sessionId) return;
    await this.db.forTenant(tenantId, (tx) => tx.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } }));
  }

  /** Déconnexion à distance de tous les appareils (CDC §6.1). */
  logoutAll(actor: Actor) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const r = await tx.session.updateMany({ where: { userId: actor.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.log(tx, actor, 'auth.logout_all', 'User', actor.userId);
      return { revoked: r.count };
    });
  }

  sessions(actor: Actor) {
    return this.db.forTenant(actor.tenantId, (tx) =>
      tx.session.findMany({
        where: { userId: actor.userId, revokedAt: null, expiresAt: { gt: new Date() } },
        select: { id: true, ip: true, userAgent: true, createdAt: true, lastUsedAt: true },
        orderBy: { lastUsedAt: 'desc' },
      }).then((rows) => rows.map((r) => ({ ...r, current: r.id === actor.sessionId }))),
    );
  }

  revokeSession(actor: Actor, id: string) {
    return this.db.forTenant(actor.tenantId, (tx) =>
      tx.session.updateMany({ where: { id, userId: actor.userId }, data: { revokedAt: new Date() } }),
    );
  }

  me(actor: Actor) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const user = await tx.user.findUniqueOrThrow({
        where: { id: actor.userId },
        select: { id: true, firstName: true, lastName: true, phone: true, email: true, totpEnabled: true, mustChangePassword: true, roles: { select: { role: true, siteId: true } } },
      });
      const tenant = await this.db.tenant.findUniqueOrThrow({ where: { id: actor.tenantId }, select: { id: true, slug: true, name: true, shortName: true, country: true, currency: true } });
      const sites = await tx.site.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
      const year = await tx.academicYear.findFirst({ where: { isCurrent: true }, select: { id: true, label: true } });
      let children: { id: string; firstName: string; lastName: string; className: string | null }[] = [];
      if (user.roles.some((r) => r.role === 'PARENT')) {
        const links = await tx.studentGuardian.findMany({
          where: { guardian: { userId: actor.userId } },
          select: { student: { select: { id: true, firstName: true, lastName: true, enrollments: { where: { academicYearId: year?.id }, select: { class: { select: { name: true } } } } } } },
        });
        children = links.map((l) => ({ id: l.student.id, firstName: l.student.firstName, lastName: l.student.lastName, className: l.student.enrollments[0]?.class.name ?? null }));
      }
      // Pour l'élève, sa propre fiche sert d'« enfant » unique : l'interface reste la même que pour le parent.
      let self: { id: string; firstName: string; lastName: string; className: string | null } | null = null;
      if (user.roles.some((r) => r.role === 'ELEVE')) {
        const st = await tx.student.findUnique({
          where: { userId: actor.userId },
          select: { id: true, firstName: true, lastName: true, enrollments: { where: { academicYearId: year?.id }, select: { class: { select: { name: true } } } } },
        });
        if (st) self = { id: st.id, firstName: st.firstName, lastName: st.lastName, className: st.enrollments[0]?.class.name ?? null };
      }
      return { user, tenant, sites, year, children, self };
    });
  }

  changePassword(actor: Actor, current: string, next: string) {
    assertPasswordPolicy(next);
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: actor.userId } });
      if (!(await argon2.verify(user.passwordHash, current))) throw new BadRequestException('Mot de passe actuel incorrect');
      if (current === next) throw new BadRequestException("Choisissez un mot de passe différent de l'actuel");
      await tx.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(next), mustChangePassword: false } });
      await tx.session.updateMany({ where: { userId: user.id, revokedAt: null, id: { not: actor.sessionId } }, data: { revokedAt: new Date() } });
      await this.audit.log(tx, actor, 'auth.password_changed', 'User', user.id);
      return { ok: true };
    });
  }

  /** Récupération de compte par code OTP envoyé par SMS. Réponse identique que le compte existe ou non. */
  async forgot(tenantSlug: string, identifier: string) {
    const tenant = await this.tenantBySlug(tenantSlug);
    await this.db.forTenant(tenant.id, async (tx) => {
      const user = await this.findByIdentifier(tx, identifier);
      if (!user?.phone || user.status !== 'ACTIVE') return;
      const code = String(randomInt(100000, 1000000));
      await tx.otpCode.updateMany({ where: { userId: user.id, purpose: 'PASSWORD_RESET', consumedAt: null }, data: { consumedAt: new Date() } });
      await tx.otpCode.create({
        data: { tenantId: tenant.id, userId: user.id, purpose: 'PASSWORD_RESET', codeHash: sha256(code), expiresAt: new Date(Date.now() + config.security.otpTtlMinutes * 60000) },
      });
      await this.sms.send(user.phone, `${tenant.shortName ?? tenant.name} : votre code de réinitialisation est ${code}. Il expire dans ${config.security.otpTtlMinutes} minutes. Ne le communiquez à personne.`);
    });
    return { ok: true };
  }

  async reset(tenantSlug: string, identifier: string, code: string, password: string) {
    assertPasswordPolicy(password);
    const tenant = await this.tenantBySlug(tenantSlug);
    return settle(this.db.forTenant(tenant.id, async (tx) => {
      const invalid = new BadRequestException('Code invalide ou expiré');
      const user = await this.findByIdentifier(tx, identifier);
      if (!user) throw invalid;
      const otp = await tx.otpCode.findFirst({
        where: { userId: user.id, purpose: 'PASSWORD_RESET', consumedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      });
      if (!otp || otp.attempts >= 5) throw invalid;
      if (otp.codeHash !== sha256(code.trim())) {
        await tx.otpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
        return new Deferred(invalid);
      }
      await tx.otpCode.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });
      await tx.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(password), mustChangePassword: false, failedLogins: 0, lockedUntil: null } });
      await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.log(tx, null, 'auth.password_reset', 'User', user.id, { tenantId: tenant.id });
      return { ok: true };
    }));
  }

  setupTwoFactor(actor: Actor) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: actor.userId } });
      const secret = authenticator.generateSecret();
      await tx.user.update({ where: { id: user.id }, data: { totpSecret: encrypt(secret), totpEnabled: false } });
      const label = user.email ?? user.phone ?? user.id;
      const otpauth = authenticator.keyuri(label, 'ERP Saint Kisito-GESA', secret);
      return { otpauth, qr: await QRCode.toDataURL(otpauth), secret };
    });
  }

  enableTwoFactor(actor: Actor, code: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: actor.userId } });
      if (!user.totpSecret || !authenticator.check(code.replace(/\s/g, ''), decrypt(user.totpSecret))) {
        throw new BadRequestException('Code incorrect');
      }
      await tx.user.update({ where: { id: user.id }, data: { totpEnabled: true } });
      await this.audit.log(tx, actor, 'auth.2fa_enabled', 'User', user.id);
      return { ok: true };
    });
  }
}
