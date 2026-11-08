import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsInt, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { Actor, Can, CurrentActor, Public } from '../../common/auth';
import { PaymentsService } from './payments.service';

class InitiateDto {
  @IsUUID() invoiceId: string;
  @IsInt() @Min(100) amount: number;
  @IsString() @MaxLength(40) operator: string;
  @IsString() @MaxLength(30) phone: string;
}

class SandboxDecisionDto {
  @IsBoolean() success: boolean;
}

@ApiTags('Paiements en ligne')
@Controller('payments')
export class PaymentsController {
  constructor(private s: PaymentsService) {}

  @ApiBearerAuth()
  @Get('operators') @Can('finance.pay')
  operators(@CurrentActor() a: Actor) {
    return this.s.operators(a);
  }

  @ApiBearerAuth()
  @Post('mobile-money') @Can('finance.pay')
  initiate(@CurrentActor() a: Actor, @Body() dto: InitiateDto) {
    return this.s.initiate(a, dto);
  }

  @ApiBearerAuth()
  @Get(':id') @Can('finance.read')
  get(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.s.get(a, id);
  }

  @Public()
  @Post('webhook/:provider')
  @HttpCode(200)
  webhook(@Param('provider') provider: string, @Req() req: Request, @Body() body: any) {
    return this.s.webhook(provider, req.headers as any, body);
  }

  /** Bac à sable : réservé au compte connecté qui a lancé le paiement, dans son établissement (SEC-005). */
  @ApiBearerAuth()
  @Get('sandbox/:transactionId') @Can('finance.pay')
  sandboxInfo(@CurrentActor() a: Actor, @Param('transactionId') t: string) {
    return this.s.sandboxInfo(a, t);
  }

  @ApiBearerAuth()
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Post('sandbox/:transactionId/decision') @Can('finance.pay')
  @HttpCode(200)
  sandboxDecide(@CurrentActor() a: Actor, @Param('transactionId') t: string, @Body() dto: SandboxDecisionDto) {
    return this.s.sandboxDecide(a, t, dto.success);
  }
}
