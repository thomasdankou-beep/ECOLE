import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsNotEmpty, IsString, Length, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';
import { config } from '../../config';
import { Actor, CurrentActor, Public } from '../../common/auth';
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
class CodeDto {
  @IsString() @Length(6, 8) code: string;
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
    await this.auth.logout(req.cookies?.[COOKIE]);
    res.clearCookie(COOKIE, { path: '/api/v1/auth' });
  }

  @ApiBearerAuth()
  @Post('logout-all')
  @HttpCode(200)
  logoutAll(@CurrentActor() actor: Actor) {
    return this.auth.logoutAll(actor);
  }

  @ApiBearerAuth()
  @Get('me')
  me(@CurrentActor() actor: Actor) {
    return this.auth.me(actor);
  }

  @ApiBearerAuth()
  @Get('sessions')
  sessions(@CurrentActor() actor: Actor) {
    return this.auth.sessions(actor);
  }

  @ApiBearerAuth()
  @Delete('sessions/:id')
  revoke(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.auth.revokeSession(actor, id);
  }

  @ApiBearerAuth()
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
  @Post('2fa/setup')
  @HttpCode(200)
  setup(@CurrentActor() actor: Actor) {
    return this.auth.setupTwoFactor(actor);
  }

  @ApiBearerAuth()
  @Post('2fa/enable')
  @HttpCode(200)
  enable(@CurrentActor() actor: Actor, @Body() dto: CodeDto) {
    return this.auth.enableTwoFactor(actor, dto.code);
  }
}
