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

/**
 * Validité des sessions, vérifiée à chaque appel (SEC-004) : école active, session non révoquée,
 * compte actif. Le résultat est gardé 30 secondes pour ne pas lire la base à chaque requête ;
 * une déconnexion, un changement de mot de passe ou une suspension l'efface tout de suite.
 */
const SESSION_CACHE_MS = 30_000;
const sessionCache = new Map<string, { ok: boolean; until: number; userId: string; tenantId: string }>();

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

export const REQUIRED_PERMISSIONS = 'permissions';
/** Exige au moins une des permissions listées pour le rôle actif. */
export const Can = (...perms: Permission[]) => SetMetadata(REQUIRED_PERMISSIONS, perms);

export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext): Actor => {
  return ctx.switchToHttp().getRequest().actor;
});

/** Authentification (jeton d'accès) puis autorisation (permission du rôle actif). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private jwt: JwtService, private db: PrismaService) {}

  private async sessionValid(p: AccessTokenPayload): Promise<boolean> {
    const hit = sessionCache.get(p.sid);
    if (hit && hit.until > Date.now() && hit.tenantId === p.tid && hit.userId === p.sub) return hit.ok;
    const tenant = await this.db.tenant.findUnique({ where: { id: p.tid }, select: { status: true } });
    let ok = tenant?.status === 'ACTIVE';
    if (ok) {
      const s = await this.db.forTenant(p.tid, (tx) =>
        tx.session.findUnique({ where: { id: p.sid }, select: { userId: true, revokedAt: true, expiresAt: true, user: { select: { status: true } } } }),
      );
      ok = !!s && s.userId === p.sub && !s.revokedAt && s.expiresAt > new Date() && s.user.status === 'ACTIVE';
    }
    if (sessionCache.size > 10_000) sessionCache.clear();
    sessionCache.set(p.sid, { ok, until: Date.now() + SESSION_CACHE_MS, userId: p.sub, tenantId: p.tid });
    return ok;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const handlers = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, handlers)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Connexion requise');
    let payload: AccessTokenPayload;
    try {
      payload = this.jwt.verify<AccessTokenPayload>(header.slice(7), { secret: config.jwt.accessSecret });
    } catch {
      throw new UnauthorizedException('Session expirée');
    }
    if (!payload.roles?.length) throw new ForbiddenException('Aucun rôle attribué');
    if (!payload.tid || !payload.sid || !(await this.sessionValid(payload))) throw new UnauthorizedException('Session expirée');

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

    const perms = this.reflector.getAllAndOverride<Permission[]>(REQUIRED_PERMISSIONS, handlers);
    if (perms?.length && !perms.some((p) => can(actor.role, p))) {
      throw new ForbiddenException("Votre rôle ne permet pas cette action");
    }
    return true;
  }
}
