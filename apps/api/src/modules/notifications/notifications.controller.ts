import { BadRequestException, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Actor, Can, CurrentActor } from '../../common/auth';
import { PrismaService } from '../../common/prisma.service';
import { NotificationsService } from './notifications.service';

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private db: PrismaService, private notifications: NotificationsService) {}

  /** SMS envoyés aux familles sur un mois (par défaut le mois en cours) : direction seulement. */
  @Get('sms') @Can('settings.manage')
  sms(@CurrentActor() actor: Actor, @Query('month') month?: string) {
    const m = month ?? new Date().toISOString().slice(0, 7);
    if (!/^20\d\d-(0[1-9]|1[0-2])$/.test(m)) throw new BadRequestException('Mois attendu au format AAAA-MM');
    return this.notifications.smsLog(actor.tenantId, m);
  }

  @Get()
  list(@CurrentActor() actor: Actor, @Query('unread') unread?: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const where = { userId: actor.userId, channel: 'IN_APP' as const, ...(unread === 'true' ? { readAt: null } : {}) };
      const [items, unreadCount] = await Promise.all([
        tx.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50 }),
        tx.notification.count({ where: { userId: actor.userId, channel: 'IN_APP', readAt: null } }),
      ]);
      return { items, unreadCount };
    });
  }

  @Post(':id/read')
  read(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.forTenant(actor.tenantId, (tx) =>
      tx.notification.updateMany({ where: { id, userId: actor.userId, readAt: null }, data: { readAt: new Date() } }),
    );
  }

  @Post('read-all')
  readAll(@CurrentActor() actor: Actor) {
    return this.db.forTenant(actor.tenantId, (tx) =>
      tx.notification.updateMany({ where: { userId: actor.userId, readAt: null }, data: { readAt: new Date() } }),
    );
  }
}
