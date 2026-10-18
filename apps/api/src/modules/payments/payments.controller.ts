import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsIn, IsInt, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { Actor, Can, CurrentActor, Public } from '../../common/auth';
import { OPERATORS, PaymentsService } from './payments.service';

class InitiateDto {
  @IsUUID() invoiceId: string;
  @IsInt() @Min(100) amount: number;
  @IsIn(OPERATORS) operator: string;
  @IsString() @MaxLength(30) phone: string;
}

class SandboxDecisionDto {
  @IsBoolean() success: boolean;
}

@ApiTags('Paiements en ligne')
@Controller('payments')
export class PaymentsController {
  constructor(private s: PaymentsService) {}

  @Get('operators')
  @Public()
  operators() {
    return { provider: this.s.provider.name, operators: OPERATORS };
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

  @Public()
  @Get('sandbox/:transactionId')
  sandboxInfo(@Param('transactionId') t: string) {
    return this.s.sandboxInfo(t);
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Post('sandbox/:transactionId/decision')
  @HttpCode(200)
  sandboxDecide(@Param('transactionId') t: string, @Body() dto: SandboxDecisionDto) {
    return this.s.sandboxDecide(t, dto.success);
  }
}
