import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Equals, IsBoolean, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { Actor, Can, CurrentActor, Public } from '../../common/auth';
import { AuditService } from '../../common/audit.service';
import { PrismaService, Tx } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { FilesService, MAX_UPLOAD_BYTES } from '../files/files.service';

const photoUrl = (slug: string, id: string, key: string) => `/api/v1/public/${slug}/honors/${id}/photo?v=${key.split('/').pop()!.slice(0, 8)}`;

class HonorDto {
  @IsUUID() reportCardId: string;
  /// Nom tel qu'il apparaîtra sur le site, par exemple « Carine H. ».
  @IsString() @MinLength(2) @MaxLength(60) displayName: string;
  @IsBoolean() showAverage: boolean;
  /// La direction confirme avoir l'accord des parents : rien n'est publié sans.
  @Equals(true, { message: 'Confirmez l’accord des parents avant de publier' }) consent: boolean;
}

/**
 * Élèves à l'honneur sur le site public. Rien n'est publié automatiquement : la direction choisit parmi les bulletins
 * déjà publiés, confirme l'accord des parents et décide du nom affiché ; elle peut retirer l'élève à tout moment.
 */
@Injectable()
export class HonorsService {
  constructor(private db: PrismaService, private audit: AuditService, private scope: ScopeService, private files: FilesService) {}

  /** Élèves publiés et propositions : les meilleures moyennes de l'école et la première de chaque classe, par période publiée. */
  overview(actor: Actor) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const yearId = await this.scope.currentYearId(tx);
      const terms = await tx.term.findMany({ where: { academicYearId: yearId }, orderBy: { position: 'desc' } });
      const cards = await tx.reportCard.findMany({
        where: { termId: { in: terms.map((t) => t.id) }, publishedAt: { not: null }, average: { not: null } },
        include: { student: { select: { firstName: true, lastName: true } }, class: { select: { name: true } } },
        orderBy: { average: 'desc' },
      });
      const suggestions = terms.flatMap((t) => {
        const ofTerm = cards.filter((c) => c.termId === t.id);
        const school = ofTerm.slice(0, 5);
        const perClass = [...new Map(ofTerm.map((c) => [c.classId, c])).values()].filter((c) => !school.includes(c));
        return [...school, ...perClass].map((c) => ({
          reportCardId: c.id, studentId: c.studentId, name: `${c.student.firstName} ${c.student.lastName}`,
          suggestedName: `${c.student.firstName} ${c.student.lastName.charAt(0)}.`, className: c.class.name, term: t.name,
          average: Number(c.average), rank: c.rank, distinction: c.distinction, schoolTop: school.includes(c),
        }));
      });
      const honors = await tx.publicHonor.findMany({ orderBy: { createdAt: 'asc' } });
      const slug = await this.slug(tx, actor.tenantId);
      return { honors: honors.map((h) => this.view(h, true, slug)), suggestions, publishedTerms: [...new Set(cards.map((c) => c.termId))].length };
    });
  }

  private async slug(tx: Tx, tenantId: string) {
    return (await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { slug: true } })).slug;
  }

  private view(h: { id: string; displayName: string; className: string; termLabel: string; average: unknown; showAverage: boolean; distinction: string | null; photoKey: string | null; createdAt?: Date }, staff = false, slug?: string) {
    return {
      photoUrl: h.photoKey && slug ? photoUrl(slug, h.id, h.photoKey) : null,
      id: h.id, displayName: h.displayName, className: h.className, term: h.termLabel, distinction: h.distinction,
      average: h.showAverage || staff ? Number(h.average) : null, showAverage: h.showAverage, hasPhoto: !!h.photoKey,
      ...(staff ? { createdAt: h.createdAt } : {}),
    };
  }

  create(actor: Actor, dto: HonorDto) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const card = await tx.reportCard.findUnique({ where: { id: dto.reportCardId }, include: { class: true } });
      if (!card?.publishedAt) throw new BadRequestException('Seul un bulletin déjà publié aux familles peut être mis à l’honneur');
      const term = await tx.term.findUniqueOrThrow({ where: { id: card.termId }, include: { academicYear: true } });
      const h = await tx.publicHonor
        .create({
          data: {
            tenantId: actor.tenantId, studentId: card.studentId, reportCardId: card.id, displayName: dto.displayName.trim(),
            className: card.class.name, termLabel: `${term.name} ${term.academicYear.label}`, average: card.average,
            showAverage: dto.showAverage, distinction: card.distinction, consentAt: new Date(), createdById: actor.userId,
          },
        })
        .catch(() => { throw new ConflictException('Cet élève est déjà à l’honneur pour cette période'); });
      await this.audit.log(tx, actor, 'honor.published', 'PublicHonor', h.id, { reportCardId: card.id, displayName: h.displayName, consent: true });
      return this.view(h, true, await this.slug(tx, actor.tenantId));
    });
  }

  remove(actor: Actor, id: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      await tx.publicHonor.delete({ where: { id } });
      await this.audit.log(tx, actor, 'honor.removed', 'PublicHonor', id);
      return { ok: true };
    });
  }

  setPhoto(actor: Actor, id: string, file?: { buffer: Buffer; mimetype: string; size: number }) {
    if (file && !file.mimetype.startsWith('image/')) throw new BadRequestException('Envoyez une photo (JPEG, PNG ou WebP)');
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const photoKey = file ? await this.files.save(actor.tenantId, 'honneur', file) : null;
      const h = await tx.publicHonor.update({ where: { id }, data: { photoKey } });
      await this.audit.log(tx, actor, file ? 'honor.photo_set' : 'honor.photo_removed', 'PublicHonor', id);
      return this.view(h, true, await this.slug(tx, actor.tenantId));
    });
  }

  /** Pour le site public : seulement ce que la direction a choisi d'afficher. */
  static async publicList(tx: Tx, slug: string) {
    const rows = await tx.publicHonor.findMany({ orderBy: [{ createdAt: 'asc' }], take: 12 });
    return rows.map((h) => ({
      id: h.id, displayName: h.displayName, className: h.className, term: h.termLabel, distinction: h.distinction,
      average: h.showAverage ? Number(h.average) : null, hasPhoto: !!h.photoKey, photoUrl: h.photoKey ? photoUrl(slug, h.id, h.photoKey) : null,
    }));
  }

  async publicPhoto(slug: string, id: string) {
    const t = await this.db.tenant.findUnique({ where: { slug } });
    if (!t || t.status === 'SUSPENDED') throw new NotFoundException();
    const h = await this.db.forTenant(t.id, (tx) => tx.publicHonor.findUnique({ where: { id } }));
    if (!h?.photoKey) throw new NotFoundException('Aucune photo');
    return this.files.readKey(h.photoKey);
  }
}

@ApiTags('Site public')
@Controller()
export class HonorsController {
  constructor(private s: HonorsService) {}

  @ApiBearerAuth()
  @Get('honors') @Can('settings.manage')
  overview(@CurrentActor() a: Actor) { return this.s.overview(a); }

  @ApiBearerAuth()
  @Post('honors') @Can('settings.manage')
  create(@CurrentActor() a: Actor, @Body() dto: HonorDto) { return this.s.create(a, dto); }

  @ApiBearerAuth()
  @Delete('honors/:id') @Can('settings.manage')
  remove(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.s.remove(a, id); }

  @ApiBearerAuth()
  @Post('honors/:id/photo') @Can('settings.manage')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  photo(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file?: Express.Multer.File) { return this.s.setPhoto(a, id, file); }

  @ApiBearerAuth()
  @Delete('honors/:id/photo') @Can('settings.manage')
  removePhoto(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.s.setPhoto(a, id); }

  @Public()
  @Get('public/:tenant/honors/:id/photo')
  async publicPhoto(@Param('tenant') tenant: string, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const f = await this.s.publicPhoto(tenant, id);
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(f.buffer);
  }
}
