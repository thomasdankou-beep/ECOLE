import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { RoleCode } from '@prisma/client';
import { config } from '../config';
import { can, Permission } from './permissions';
import { PrismaService } from './prisma.service';
import { AuditService } from './audit.service';

/**
 * Validité des sessions, vérifiée à chaque appel (SEC-004) : école active, session non révoquée,
 * compte actif. Le résultat est gardé 30 secondes pour ne pas lire la base à chaque requête ;
 * une déconnexion, un changement de mot de passe ou une suspension l'efface tout de suite.
 */
const SESSION_CACHE_MS = 30_000;
const DENIED_WINDOW_MS = 10 * 60_000;
const deniedSeen = new Map<string, number>();
const sessionCache = new Map<string, { ok: boolean; until: number; userId: string; tenantId: string; slug?: string; domain?: string | null; pendingPassword?: boolean }>();

/** Audience des jetons d'accès d'école (SEC-012) : un jeton Super Admin ou de double authentification n'est jamais accepté ici. */
export const SCHOOL_AUDIENCE = 'school';

/** Sous-domaines de la plateforme qui ne désignent pas une école. */
export const RESERVED_SUBDOMAINS = ['www', 'admin', 'api', 'plateforme', 'app', 'mail', 'static'];

/**
 * École désignée par l'adresse appelée (SEC-011), en mode plateforme seulement :
 * « slug » pour <slug>.<domaine de la plateforme>, « domain » pour une autre adresse (domaine propre possible),
 * null quand l'adresse ne désigne aucune école (adresse interne, accueil de la plateforme).
 */
export function schoolFromHost(rawHost: string | undefined, platformDomain: string): { slug?: string; domain?: string } | null {
  if (!platformDomain) return null;
  const host = (rawHost ?? '').toLowerCase().split(':')[0].trim();
  if (!host || host === platformDomain || host === `www.${platformDomain}`) return null;
  if (host.endsWith(`.${platformDomain}`)) {
    const sub = host.slice(0, -(platformDomain.length + 1));
    return sub.includes('.') || RESERVED_SUBDOMAINS.includes(sub) ? null : { slug: sub };
  }
  // Adresse sans point (api, localhost) ou adresse IP : appel interne, pas une adresse d'école.
  if (!host.includes('.') || /^[\d.]+$/.test(host)) return null;
  return { domain: host };
}

/** Oublie les sessions gardées en mémoire : d'un utilisateur, de toute une école, ou une seule. */
export function forgetSessions(filter: { userId?: string; tenantId?: string; sessionId?: string }, again = true) {
  // Appelé dans la transaction qui révoque : on efface aussi 2 s plus tard, au cas où un appel simultané
  // aurait relu l'ancienne valeur avant la validation de la transaction.
  if (again) setTimeout(() => forgetSessions(filter, false), 2000).unref?.();
  for (const [sid, v] of sessionCache) {
    if ((filter.sessionId && sid === filter.sessionId) || (filter.userId && v.userId === filter.userId) || (filter.tenantId && v.tenantId === filter.tenantId)) {
      sessionCache.delete(sid);
    }
  }
}

/** Utilisateur authentifié, avec le rôle actif choisi dans l'interface (en-tête X-Active-Role). */
export interface Actor {
  userId: string;
  tenantId: string;
  sessionId: string;
  name: string;
  roles: { role: RoleCode; siteId: string | null }[];
  role: RoleCode;
  /// Sites auxquels le rôle actif est limité ; vide = tous les sites.
  siteIds: string[];
  ip?: string;
}

export interface AccessTokenPayload {
  sub: string;
  tid: string;
  sid: string;
  name: string;
  roles: { role: RoleCode; siteId: string | null }[];
}

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Routes encore ouvertes tant que le mot de passe provisoire n'a pas été changé (SEC-023) :
 * son compte, le changement de mot de passe, la double authentification, les appareils connectés.
 */
export const ALLOW_PENDING_PASSWORD = 'allowPendingPassword';
export const AllowPendingPassword = () => SetMetadata(ALLOW_PENDING_PASSWORD, true);

export const REQUIRED_PERMISSIONS = 'permissions';
/** Exige au moins une des permissions listées pour le rôle actif. */
export const Can = (...perms: Permission[]) => SetMetadata(REQUIRED_PERMISSIONS, perms);

export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext): Actor => {
  return ctx.switchToHttp().getRequest().actor;
});

/** Authentification (jeton d'accès) puis autorisation (permission du rôle actif). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private jwt: JwtService, private db: PrismaService, private audit: AuditService) {}

  /**
   * SEC-034 : un accès refusé est tracé dans le journal de l'école, au plus une fois par personne et par route
   * toutes les 10 minutes (on ne peut pas remplir le journal). Une erreur d'écriture ne change pas le refus.
   */
  private async denied(req: any, who: { tenantId: string; userId: string; name: string }, reason: string, role?: string) {
    const route = `${req.method} ${req.route?.path ?? String(req.path ?? '').slice(0, 120)}`;
    const key = `${who.tenantId}:${who.userId}:${route}:${reason}`;
    const now = Date.now();
    if ((deniedSeen.get(key) ?? 0) > now) return;
    if (deniedSeen.size > 10_000) deniedSeen.clear();
    deniedSeen.set(key, now + DENIED_WINDOW_MS);
    await this.db
      .forTenant(who.tenantId, (tx) => this.audit.log(tx, { ...who, ip: req.ip }, 'access.denied', 'Route', null, { route, reason, role }))
      .catch(() => undefined);
  }

  private async sessionValid(p: AccessTokenPayload) {
    const hit = sessionCache.get(p.sid);
    if (hit && hit.until > Date.now() && hit.tenantId === p.tid && hit.userId === p.sub) return hit;
    const tenant = await this.db.tenant.findUnique({ where: { id: p.tid }, select: { status: true, slug: true, domain: true } });
    let ok = tenant?.status === 'ACTIVE';
    let pendingPassword = false;
    if (ok) {
      const s = await this.db.forTenant(p.tid, (tx) =>
        tx.session.findUnique({ where: { id: p.sid }, select: { userId: true, revokedAt: true, expiresAt: true, user: { select: { status: true, mustChangePassword: true } } } }),
      );
      ok = !!s && s.userId === p.sub && !s.revokedAt && s.expiresAt > new Date() && s.user.status === 'ACTIVE';
      pendingPassword = !!s?.user.mustChangePassword;
    }
    if (sessionCache.size > 10_000) sessionCache.clear();
    const entry = { ok, until: Date.now() + SESSION_CACHE_MS, userId: p.sub, tenantId: p.tid, slug: tenant?.slug, domain: tenant?.domain, pendingPassword };
    sessionCache.set(p.sid, entry);
    return entry;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const handlers = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, handlers)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Connexion requise');
    let payload: AccessTokenPayload;
    try {
      payload = this.jwt.verify<AccessTokenPayload>(header.slice(7), { secret: config.jwt.accessSecret, audience: SCHOOL_AUDIENCE });
    } catch {
      throw new UnauthorizedException('Session expirée');
    }
    if (!payload.roles?.length) throw new ForbiddenException('Aucun rôle attribué');
    const session = payload.tid && payload.sid ? await this.sessionValid(payload) : null;
    if (!session?.ok) throw new UnauthorizedException('Session expirée');
    // SEC-011 : le jeton d'une école n'est accepté que sur l'adresse de cette école.
    const called = schoolFromHost(req.headers.host, config.platformDomain);
    if (called && !(called.slug ? called.slug === session.slug : called.domain === session.domain)) {
      await this.denied(req, { tenantId: payload.tid, userId: payload.sub, name: payload.name }, `adresse d'une autre école (${String(req.headers.host ?? '').slice(0, 80)})`);
      throw new ForbiddenException("Ce compte appartient à une autre école : connectez-vous depuis l'adresse de votre école");
    }

    const wanted = req.headers['x-active-role'] as RoleCode | undefined;
    const active = wanted ? payload.roles.find((r) => r.role === wanted) : payload.roles[0];
    if (!active) throw new ForbiddenException("Ce rôle n'est pas attribué à votre compte");
    const sameRole = payload.roles.filter((r) => r.role === active.role);
    const actor: Actor = {
      userId: payload.sub,
      tenantId: payload.tid,
      sessionId: payload.sid,
      name: payload.name,
      roles: payload.roles,
      role: active.role,
      siteIds: sameRole.some((r) => !r.siteId) ? [] : sameRole.map((r) => r.siteId as string),
      ip: req.ip,
    };
    req.actor = actor;
    if (session.pendingPassword && !this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_PASSWORD, handlers)) {
      throw new ForbiddenException('Choisissez d’abord un nouveau mot de passe dans « Mon compte »');
    }

    const perms = this.reflector.getAllAndOverride<Permission[]>(REQUIRED_PERMISSIONS, handlers);
    if (perms?.length && !perms.some((p) => can(actor.role, p))) {
      await this.denied(req, actor, `droit manquant : ${perms.join(' ou ')}`, actor.role);
      throw new ForbiddenException("Votre rôle ne permet pas cette action");
    }
    return true;
  }
}
