import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Actor } from './auth';
import { Tx } from './prisma.service';

/** Auteur d'une ligne du journal : la personne connectée, ou le compte concerné quand personne ne l'est encore (connexion). */
export type AuditWho = Pick<Actor, 'tenantId' | 'userId' | 'name'> & { ip?: string | null };

/** Le compte concerné par une connexion, un échec ou une déconnexion (SEC-031). */
export function auditSubject(user: { id: string; tenantId: string; firstName: string; lastName: string }, ip?: string | null): AuditWho {
  return { tenantId: user.tenantId, userId: user.id, name: `${user.firstName} ${user.lastName}`, ip: ip ?? null };
}

/** Téléphone ou e-mail masqué pour le journal (SEC-031, SEC-037) : +229019•••99, ab•••@exemple.bj. */
export function maskIdentifier(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  const at = v.indexOf('@');
  if (at > 0) return `${v.slice(0, Math.min(2, at))}•••${v.slice(at)}`;
  if (v.length <= 4) return '•••';
  return `${v.slice(0, Math.min(7, v.length - 4))}•••${v.slice(-2)}`;
}

/** Champs dont la valeur n'est jamais recopiée dans le journal, qui ne s'efface pas (SEC-037). */
const HIDDEN = new Set(['allergies']);
const MASKED = new Set(['phone', 'email', 'guardianPhone', 'payerPhone']);

const plain = (v: unknown): unknown => {
  if (v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === 'object' && typeof (v as any).toNumber === 'function') return (v as any).toNumber(); // Decimal
  return v;
};

/**
 * Ancienne et nouvelle valeur des seuls champs modifiés (SEC-033) : { champ: { avant, après } }.
 * `keys` limite la comparaison aux champs envoyés. Les données de santé ne sont pas recopiées et les
 * téléphones ou e-mails sont masqués (SEC-037).
 */
export function auditChanges(before: Record<string, any> | null | undefined, after: Record<string, any>, keys: string[] = Object.keys(after)) {
  const out: Record<string, { avant: unknown; après: unknown } | 'modifié'> = {};
  for (const k of keys) {
    if (after[k] === undefined) continue;
    const a = plain(before?.[k]);
    const b = plain(after[k]);
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (HIDDEN.has(k)) out[k] = 'modifié';
    else if (MASKED.has(k)) out[k] = { avant: maskIdentifier(a as string), après: maskIdentifier(b as string) };
    else out[k] = { avant: a, après: b };
  }
  return out;
}

/** Journal d'audit des actions sensibles (CDC §6.1), en ajout seul. */
@Injectable()
export class AuditService {
  log(tx: Tx, actor: AuditWho | null, action: string, entity: string, entityId?: string | null, data?: unknown) {
    return tx.auditLog.create({
      data: {
        tenantId: actor?.tenantId ?? (data as any)?.tenantId,
        userId: actor?.userId ?? null,
        userName: actor?.name ?? 'Système',
        action,
        entity,
        entityId: entityId ?? null,
        data: (data ?? undefined) as Prisma.InputJsonValue | undefined,
        ip: actor?.ip ?? (data as any)?.ip ?? null,
      },
    });
  }
}
