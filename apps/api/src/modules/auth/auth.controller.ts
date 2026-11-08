import { Body, Controller, Delete, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsNotEmpty, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';
import { config } from '../../config';
import { Actor, AllowPendingPassword, CurrentActor, Public } from '../../common/auth';
import { AuthService } from './auth.service';

class LoginDto {
  @IsString() @IsNotEmpty() tenant: string;
  @IsString() @IsNotEmpty() @MaxLength(120) identifier: string;
  @IsString() @IsNotEmpty() @MaxLength(200) password: string;
}
class TwoFactorDto {
  @IsString() challenge: string;
  @IsString() @Length(6, 8) code: string;
}
class ChangePasswordDto {
  @IsString() current: string;
  @IsString() @MaxLength(200) next: string;
}
class ForgotDto {
  @IsString() tenant: string;
  @IsString() identifier: string;
}
class ResetDto extends ForgotDto {
  @IsString() @Length(6, 6) code: string;
  @IsString() @MaxLength(200) password: string;
}
class SetupDto {
  /** Code actuel, exigé quand la double authentification est déjà active (SEC-019). */
  @IsOptional() @IsString() @Length(6, 8) code?: string;
  /** Jeton remis par une connexion avec un code de récupération : remplace le code de l'ancien téléphone (10 min). */
  @IsOptional() @IsString() @MaxLength(2000) reconfigureToken?: string;
}
class RecoveryLoginDto {
  @IsString() @IsNotEmpty() @MaxLength(2000) challenge: string;
  @IsString() @Length(8, 24) code: string;
}
class RegenerateDto {
  @IsString() @Length(6, 8) code: string;
}
class ReenrollStartDto {
  @IsString() @IsNotEmpty() @MaxLength(2000) challenge: string;
  @IsString() @Length(6, 20) activationCode: string;
}
class ReenrollFinishDto {
  @IsString() @IsNotEmpty() @MaxLength(2000) challenge: string;
  @IsString() @IsNotEmpty() @MaxLength(2000) setupToken: string;
  @IsString() @Length(6, 8) code: string;
}
class EnableDto {
  @IsString() @Length(6, 8) code: string;
  @IsString() @IsNotEmpty() @MaxLength(2000) setupToken: string;
}

const COOKIE = 'erp_rt';

@ApiTags('Authentification')
@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  private meta(req: Request) {
    return { ip: req.ip, userAgent: req.headers['user-agent'] };
  }

  private setCookie(res: Response, value: string) {
    res.cookie(COOKIE, value, {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: 'strict',
      path: '/api/v1/auth',
      maxAge: config.jwt.refreshTtlDays * 86400000,
    });
  }

  private respond(res: Response, r: any) {
    if (r.refreshCookie) {
      this.setCookie(res, r.refreshCookie);
      const { refreshCookie, ...rest } = r;
      return rest;
    }
    return r;
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.login(dto.tenant, dto.identifier, dto.password, this.meta(req)));
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('2fa/verify')
  @HttpCode(200)
  async verify(@Body() dto: TwoFactorDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.verifyTwoFactor(dto.challenge, dto.code, this.meta(req)));
  }

  /** Téléphone perdu : code de récupération à la place du code de l'application. */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('2fa/recovery')
  @HttpCode(200)
  async recovery(@Body() dto: RecoveryLoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.verifyRecoveryCode(dto.challenge, dto.code, this.meta(req)));
  }

  /** Récupération validée par l'établissement : code de réactivation remis en main propre, puis nouveau téléphone. */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('2fa/reenroll/start')
  @HttpCode(200)
  reenrollStart(@Body() dto: ReenrollStartDto, @Req() req: Request) {
    return this.auth.startReenroll(dto.challenge, dto.activationCode, this.meta(req));
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('2fa/reenroll/finish')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async reenrollFinish(@Body() dto: ReenrollFinishDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.finishReenroll(dto.challenge, dto.setupToken, dto.code, this.meta(req)));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    try {
      return this.respond(res, await this.auth.refresh(req.cookies?.[COOKIE], this.meta(req)));
    } catch (e) {
      res.clearCookie(COOKIE, { path: '/api/v1/auth' });
      throw e;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[COOKIE], req.ip);
    res.clearCookie(COOKIE, { path: '/api/v1/auth' });
  }

  @ApiBearerAuth()
  @AllowPendingPassword()
  @Post('logout-all')
  @HttpCode(200)
  logoutAll(@CurrentActor() actor: Actor) {
    return this.auth.logoutAll(actor);
  }

  @ApiBearerAuth()
  @AllowPendingPassword()
  @Get('me')
  me(@CurrentActor() actor: Actor) {
    return this.auth.me(actor);
  }

  @ApiBearerAuth()
  @AllowPendingPassword()
  @Get('sessions')
  sessions(@CurrentActor() actor: Actor) {
    return this.auth.sessions(actor);
  }

  @ApiBearerAuth()
  @AllowPendingPassword()
  @Delete('sessions/:id')
  revoke(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.auth.revokeSession(actor, id);
  }

  @ApiBearerAuth()
  @AllowPendingPassword()
  @Post('change-password')
  @HttpCode(200)
  changePassword(@CurrentActor() actor: Actor, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(actor, dto.current, dto.next);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('forgot')
  @HttpCode(200)
  forgot(@Body() dto: ForgotDto) {
    return this.auth.forgot(dto.tenant, dto.identifier);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('reset')
  @HttpCode(200)
  reset(@Body() dto: ResetDto) {
    return this.auth.reset(dto.tenant, dto.identifier, dto.code, dto.password);
  }

  @ApiBearerAuth()
  @AllowPendingPassword()
  @Post('2fa/setup')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  setup(@CurrentActor() actor: Actor, @Body() dto: SetupDto) {
    return this.auth.setupTwoFactor(actor, dto.code, dto.reconfigureToken);
  }

  @ApiBearerAuth()
  @Get('2fa/recovery-codes')
  recoveryStatus(@CurrentActor() actor: Actor) {
    return this.auth.recoveryCodesStatus(actor);
  }

  /** Génère ou régénère les codes de récupération avec le code actuel de l'application. */
  @ApiBearerAuth()
  @Post('2fa/recovery-codes')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Header('Cache-Control', 'no-store')
  regenerate(@CurrentActor() actor: Actor, @Body() dto: RegenerateDto) {
    return this.auth.regenerateRecoveryCodes(actor, dto.code);
  }

  @ApiBearerAuth()
  @AllowPendingPassword()
  @Post('2fa/enable')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  enable(@CurrentActor() actor: Actor, @Body() dto: EnableDto) {
    return this.auth.enableTwoFactor(actor, dto.code, dto.setupToken);
  }
}
