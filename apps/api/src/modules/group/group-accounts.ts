import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { GroupRole, Prisma } from '@prisma/client';
import { IsBoolean, IsEmail, IsEnum, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { country } from '../../common/country';
import { normalizePhone } from '../../common/util';
import { config } from '../../config';
import { hashPassword } from '../auth/auth.service';
import { temporaryPassword } from '../settings/settings.service';

/** Comptes de la console des groupes (lot G2) : règles communes au Super Admin et au responsable général du groupe. */

export const GROUP_ROLE_LABELS: Record<GroupRole, string> = {
  GENERAL: 'Responsable général du groupe',
  FINANCIER: 'Responsable financier du groupe',
  PEDAGOGIQUE: 'Responsable pédagogique du groupe',
};

/** Adresse de la console : toujours celle de la plateforme, jamais l'adresse d'une école. */
export function groupConsoleUrl() {
  return config.platformDomain ? `https://${config.platformDomain}/groupe/connexion` : `${config.webOrigin}/groupe/connexion`;
}

export class GroupAccountDto {
  @IsString() @MinLength(1, { message: 'Prénom obligatoire' }) @MaxLength(80) firstName: string;
  @IsString() @MinLength(1, { message: 'Nom obligatoire' }) @MaxLength(80) lastName: string;
  @IsOptional() @ValidateIf((_, v) => v !== null && v !== '') @IsString() @MaxLength(30) phone?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null && v !== '') @IsEmail({}, { message: 'Adresse e-mail invalide' }) @MaxLength(160) email?: string | null;
  @IsEnum(GroupRole, { message: 'Rôle inconnu' }) role: GroupRole;
}

export class GroupAccountUpdateDto {
  @IsOptional() @IsEnum(GroupRole, { message: 'Rôle inconnu' }) role?: GroupRole;
  @IsOptional() @IsBoolean() active?: boolean;
}

/** Ce que l'on montre d'un compte : jamais son mot de passe, son secret ni ses codes. */
export const ACCOUNT_VIEW = {
  id: true, groupId: true, firstName: true, lastName: true, phone: true, email: true, role: true, active: true,
  mustChangePassword: true, totpEnabled: true, lockedUntil: true, lastLoginAt: true, createdAt: true,
} satisfies Prisma.GroupAccountSelect;

export type AccountView = Prisma.GroupAccountGetPayload<{ select: typeof ACCOUNT_VIEW }>;

/** Vue d'un compte, avec son état lisible : bloqué, à activer (première connexion pas encore faite). */
export function accountView(a: AccountView) {
  const locked = !!a.lockedUntil && a.lockedUntil > new Date();
  return { ...a, roleLabel: GROUP_ROLE_LABELS[a.role], locked, pendingFirstLogin: a.mustChangePassword || !a.totpEnabled };
}

const UNIQUE = 'Ce téléphone ou cette adresse e-mail sert déjà à un compte de groupe Cahiora : choisissez-en un autre.';

/** Téléphone au format international, d'après le pays du groupe ; e-mail en minuscules. Un identifiant au moins. */
export function accountIdentifiers(dto: { phone?: string | null; email?: string | null }, groupCountry: string) {
  const phoneRaw = dto.phone?.trim() || null;
  const email = dto.email?.trim().toLowerCase() || null;
  if (!phoneRaw && !email) throw new BadRequestException('Indiquez un téléphone ou une adresse e-mail : ce sera l’identifiant de connexion');
  const phone = phoneRaw ? normalizePhone(phoneRaw, country(groupCountry).dial) : null;
  if (phone && !/^\+\d{8,15}$/.test(phone)) throw new BadRequestException('Numéro de téléphone invalide');
  return { phone, email };
}

/** Crée un compte avec un mot de passe provisoire, renvoyé une seule fois en clair. */
export async function createGroupAccount(tx: Prisma.TransactionClient, groupId: string, dto: GroupAccountDto) {
  const g = await tx.schoolGroup.findUnique({ where: { id: groupId }, select: { id: true, country: true } });
  if (!g) throw new NotFoundException('Groupe introuvable');
  const { phone, email } = accountIdentifiers(dto, g.country);
  const password = temporaryPassword();
  try {
    const a = await tx.groupAccount.create({
      data: {
        groupId, firstName: dto.firstName.trim(), lastName: dto.lastName.trim().toUpperCase(), phone, email, role: dto.role,
        passwordHash: await hashPassword(password), mustChangePassword: true,
      },
      select: ACCOUNT_VIEW,
    });
    return { account: a, temporaryPassword: password };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException(UNIQUE);
    throw e;
  }
}

/**
 * Remet un accès : nouveau mot de passe provisoire, double authentification et codes de récupération effacés,
 * toutes les sessions fermées. À la connexion suivante, le compte choisit un mot de passe et configure de nouveau
 * son application d'authentification avant d'ouvrir la console.
 */
export async function resetGroupAccount(tx: Prisma.TransactionClient, groupId: string, accountId: string, reason: string) {
  const a = await tx.groupAccount.findFirst({ where: { id: accountId, groupId }, select: ACCOUNT_VIEW });
  if (!a) throw new NotFoundException('Compte introuvable');
  const password = temporaryPassword();
  const now = new Date();
  await tx.groupAccount.update({
    where: { id: a.id },
    data: {
      passwordHash: await hashPassword(password), mustChangePassword: true, passwordChangedAt: now, failedLogins: 0, lockedUntil: null,
      totpSecret: null, totpEnabled: false, totpLastStep: null,
    },
  });
  await tx.groupRecoveryCode.deleteMany({ where: { accountId: a.id } });
  const closed = await revokeSessions(tx, a.id, reason);
  return { account: a, temporaryPassword: password, sessionsClosed: closed };
}

/** Ferme toutes les sessions ouvertes d'un compte (sauf une, si précisée). */
export async function revokeSessions(tx: Prisma.TransactionClient, accountId: string, reason: string, except?: string) {
  const r = await tx.groupSession.updateMany({
    where: { accountId, revokedAt: null, ...(except ? { NOT: { id: except } } : {}) },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return r.count;
}

/** Il reste toujours au moins un responsable général actif : un groupe ne peut pas s'enfermer dehors. */
export async function assertGeneralRemains(tx: Prisma.TransactionClient, groupId: string, changedId: string, next: { role?: GroupRole; active?: boolean }) {
  // Verrou sur les responsables généraux actifs du groupe : deux retraits simultanés (chacun retirant l'autre) ne
  // passent pas tous les deux ; le second voit le premier et est refusé.
  await tx.$queryRaw`SELECT id FROM group_accounts WHERE group_id = ${groupId}::uuid AND role = 'GENERAL' AND active ORDER BY id FOR UPDATE`;
  const a = await tx.groupAccount.findFirst({ where: { id: changedId, groupId }, select: { role: true, active: true, totpEnabled: true } });
  if (!a) throw new NotFoundException('Compte introuvable');
  const staysGeneral = (next.role ?? a.role) === 'GENERAL' && (next.active ?? a.active);
  if (a.role !== 'GENERAL' || !a.active || staysGeneral) return a;
  const others = await tx.groupAccount.count({ where: { groupId, role: 'GENERAL', active: true, NOT: { id: changedId } } });
  if (!others) throw new BadRequestException('Il faut au moins un responsable général actif dans le groupe : nommez-en un autre d’abord');
  return a;
}
