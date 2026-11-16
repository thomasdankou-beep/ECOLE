import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import { IsString, Length } from 'class-validator';
import type { Request } from 'express';
import { Public } from '../../common/auth';
import { config, tenantOrigin } from '../../config';
import { createSmsProvider, sendQuietly } from '../notifications/sms.provider';
import {
  ACCOUNT_VIEW, accountView, assertGeneralRemains, createGroupAccount, GROUP_ROLE_LABELS, GroupAccountDto, GroupAccountUpdateDto, groupConsoleUrl,
  resetGroupAccount, revokeSessions,
} from './group-accounts';
import { accountLog, confirmTotp, GroupActor, GroupCodeOnlyDto, GroupGuard, GroupHostGuard, GroupRoles } from './group-auth';
import { GroupDb } from './group-db';

/**
 * Console du promoteur (lot G2) : ce que le groupe voit de lui-même, sans aucune donnée d'école.
 * - Tous les comptes du groupe : la fiche du groupe et la liste de ses établissements (nom, adresse, état).
 * - Responsable général : en plus, les comptes du groupe et le journal du groupe.
 * Les chiffres des établissements (effectifs, encaissements, résultats) arrivent au lot G3, calculés à part et
 * sans aucune donnée nominative. Le rôle de base erp_group n'a aucun droit sur les tables d'école : la console ne
 * peut lire ni un élève, ni un compte d'école, ni une note, même par erreur de code.
 */

/** Créer un compte depuis la console : confirmé par le code actuel de l'application du responsable général. */
export class GroupConsoleAccountDto extends GroupAccountDto {
  @IsString() @Length(6, 8) code: string;
}

const CONFIRM_FAILED = 'Code de votre application incorrect. Après 5 erreurs, le compte est bloqué 15 minutes.';

const SCHOOL = {
  id: true, slug: true, name: true, shortName: true, country: true, currency: true, status: true, domain: true, groupJoinedAt: true,
} as const;

@Injectable()
export class GroupConsoleService {
  private sms = createSmsProvider(config.smsProvider);
  constructor(private db: GroupDb) {}

  private view(t: { slug: string; domain: string | null } & Record<string, unknown>) {
    return { ...t, address: tenantOrigin({ slug: t.slug, domain: t.domain }) };
  }

  /** Établissements du groupe de la session. La base ne montre que ceux de ce groupe (Row Level Security). */
  establishments(actor: GroupActor) {
    return this.db.inGroup(actor.groupId, async (tx) => {
      const rows = await tx.tenant.findMany({ where: { groupId: actor.groupId }, select: SCHOOL, orderBy: { name: 'asc' } });
      return rows.map((t) => this.view(t));
    });
  }

  /** Un établissement : 404 s'il n'appartient pas au groupe de la session, même avec un identifiant exact (T-02). */
  establishment(actor: GroupActor, id: string) {
    return this.db.inGroup(actor.groupId, async (tx) => {
      const t = await tx.tenant.findFirst({ where: { id, groupId: actor.groupId }, select: SCHOOL });
      if (!t) throw new NotFoundException('Établissement introuvable');
      return this.view(t);
    });
  }

  accounts(actor: GroupActor) {
    return this.db.inGroup(actor.groupId, async (tx) => {
      const rows = await tx.groupAccount.findMany({ where: { groupId: actor.groupId }, select: ACCOUNT_VIEW, orderBy: [{ active: 'desc' }, { lastName: 'asc' }] });
      return rows.map((a) => ({ ...accountView(a), self: a.id === actor.accountId }));
    });
  }

  private me(tx: Prisma.TransactionClient, actor: GroupActor) {
    return tx.groupAccount.findUniqueOrThrow({ where: { id: actor.accountId }, select: { id: true, groupId: true, firstName: true, lastName: true } });
  }

  /**
   * Créer un compte ou remettre un accès donne un mot de passe provisoire : le responsable général confirme avec le
   * code actuel de son application. Une session volée ne suffit donc pas pour s'ouvrir un compte durable.
   */
  private async confirm(tx: Prisma.TransactionClient, actor: GroupActor, code: string) {
    const a = await tx.groupAccount.findUniqueOrThrow({ where: { id: actor.accountId } });
    return (await confirmTotp(tx, a, code, actor.ip)) ? a : null;
  }

  private async sendCredentials(phone: string | null, password: string) {
    if (!phone) return;
    await sendQuietly(this.sms, phone, `Votre accès à la console de votre groupe Cahiora : ${groupConsoleUrl()}. Identifiant : ${phone}. Mot de passe provisoire : ${password}. Changez-le à la première connexion.`);
  }

  async createAccount(actor: GroupActor, dto: GroupConsoleAccountDto) {
    // Un code faux est compté dans la transaction, qui est validée ; le refus n'est levé qu'ensuite.
    const r = await this.db.inGroup(actor.groupId, async (tx) => {
      const me = await this.confirm(tx, actor, dto.code);
      if (!me) return { error: new ForbiddenException(CONFIRM_FAILED) };
      const created = await createGroupAccount(tx, actor.groupId, dto);
      await accountLog(tx, me, 'group.account_created', actor.ip, { accountId: created.account.id, name: `${created.account.firstName} ${created.account.lastName}`, role: GROUP_ROLE_LABELS[created.account.role] });
      return created;
    });
    if ('error' in r) throw r.error;
    await this.sendCredentials(r.account.phone, r.temporaryPassword);
    return { account: accountView(r.account), temporaryPassword: r.temporaryPassword };
  }

  /** Changer le rôle d'un compte ou le désactiver : jamais le sien, et il reste toujours un responsable général actif. */
  updateAccount(actor: GroupActor, id: string, dto: GroupAccountUpdateDto) {
    if (id === actor.accountId) throw new BadRequestException('Vous ne pouvez pas changer votre propre rôle ni désactiver votre propre compte : un autre responsable général doit le faire');
    if (dto.role === undefined && dto.active === undefined) throw new BadRequestException('Rien à modifier');
    return this.db.inGroup(actor.groupId, async (tx) => {
      const before = await assertGeneralRemains(tx, actor.groupId, id, dto);
      const a = await tx.groupAccount.update({ where: { id }, data: { role: dto.role, active: dto.active }, select: ACCOUNT_VIEW });
      const closed = dto.active === false ? await revokeSessions(tx, id, 'compte désactivé') : 0;
      const me = await this.me(tx, actor);
      const changes: Record<string, unknown> = {};
      if (dto.role !== undefined && dto.role !== before.role) changes.role = GROUP_ROLE_LABELS[dto.role];
      if (dto.active !== undefined && dto.active !== before.active) changes.active = dto.active;
      await accountLog(tx, me, 'group.account_updated', actor.ip, { accountId: id, name: `${a.firstName} ${a.lastName}`, ...changes, sessionsClosed: closed });
      return accountView(a);
    });
  }

  /** Remettre l'accès d'un autre compte du groupe (téléphone perdu, mot de passe oublié) : nouveau mot de passe provisoire. */
  async resetAccount(actor: GroupActor, id: string, code: string) {
    if (id === actor.accountId) throw new BadRequestException('Pour votre propre compte, utilisez « Mon compte », ou demandez à un autre responsable général ou à Cahiora');
    const r = await this.db.inGroup(actor.groupId, async (tx) => {
      const me = await this.confirm(tx, actor, code);
      if (!me) return { error: new ForbiddenException(CONFIRM_FAILED) };
      const out = await resetGroupAccount(tx, actor.groupId, id, 'accès remis par le responsable général');
      await accountLog(tx, me, 'group.account_reset', actor.ip, { accountId: id, name: `${out.account.firstName} ${out.account.lastName}`, sessionsClosed: out.sessionsClosed });
      return out;
    });
    if ('error' in r) throw r.error;
    await this.sendCredentials(r.account.phone, r.temporaryPassword);
    return { account: accountView({ ...r.account, mustChangePassword: true, totpEnabled: false, lockedUntil: null }), temporaryPassword: r.temporaryPassword };
  }

  /** Journal du groupe (200 dernières lignes) : actions de Cahiora sur le groupe et actions de ses comptes. */
  journal(actor: GroupActor) {
    return this.db.inGroup(actor.groupId, (tx) => tx.groupAuditLog.findMany({ where: { groupId: actor.groupId }, orderBy: { createdAt: 'desc' }, take: 200 }));
  }
}

@ApiTags('Console du groupe')
@Public()
@UseGuards(GroupHostGuard, GroupGuard)
@Controller('group')
export class GroupConsoleController {
  constructor(private s: GroupConsoleService) {}

  private actor(req: Request) {
    return (req as any).groupActor as GroupActor;
  }

  @Get('establishments')
  establishments(@Req() req: Request) { return this.s.establishments(this.actor(req)); }

  @Get('establishments/:id')
  establishment(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) { return this.s.establishment(this.actor(req), id); }

  @Get('accounts') @GroupRoles('GENERAL')
  accounts(@Req() req: Request) { return this.s.accounts(this.actor(req)); }

  @Post('accounts') @GroupRoles('GENERAL') @Throttle({ default: { limit: 10, ttl: 60000 } }) @Header('Cache-Control', 'no-store')
  create(@Req() req: Request, @Body() dto: GroupConsoleAccountDto) { return this.s.createAccount(this.actor(req), dto); }

  @Patch('accounts/:id') @GroupRoles('GENERAL')
  update(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: GroupAccountUpdateDto) { return this.s.updateAccount(this.actor(req), id, dto); }

  @Post('accounts/:id/reset') @GroupRoles('GENERAL') @Throttle({ default: { limit: 10, ttl: 60000 } }) @Header('Cache-Control', 'no-store')
  reset(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: GroupCodeOnlyDto) { return this.s.resetAccount(this.actor(req), id, dto.code); }

  @Get('journal') @GroupRoles('GENERAL')
  journal(@Req() req: Request) { return this.s.journal(this.actor(req)); }
}
