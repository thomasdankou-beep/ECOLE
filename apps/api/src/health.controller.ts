import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from './common/auth';
import { PrismaService } from './common/prisma.service';

@ApiTags('Santé')
@Controller('health')
export class HealthController {
  constructor(private db: PrismaService) {}

  @Public()
  @Get()
  async health() {
    await this.db.$queryRaw`SELECT 1`;
    return { status: 'ok', time: new Date().toISOString() };
  }
}
