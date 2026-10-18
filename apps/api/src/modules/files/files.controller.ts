import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../common/auth';
import { FilesService } from './files.service';

@ApiTags('Fichiers')
@Controller('files')
export class FilesController {
  constructor(private files: FilesService) {}

  /** Téléchargement par URL signée (la signature tient lieu d'autorisation, durée 15 min). */
  @Public()
  @Get()
  async get(@Query('key') key: string, @Query('exp') exp: string, @Query('sig') sig: string, @Res() res: Response) {
    const f = await this.files.read(key ?? '', exp ?? '', sig ?? '');
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Cache-Control', 'private, max-age=900');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(f.buffer);
  }
}
