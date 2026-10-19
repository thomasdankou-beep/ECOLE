import { Body, Controller, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { DocumentKind, Prisma } from '@prisma/client';
import { IsEnum, IsUUID } from 'class-validator';
import { Actor, Can, CurrentActor, Public } from '../../common/auth';
import { AuditService } from '../../common/audit.service';
import { PrismaService, Tx } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { nextNumber, pad, verifyCode } from '../../common/util';
import { FilesService } from '../files/files.service';
import { schoolIdentity } from '../settings/settings.service';

export const DOC_LABEL: Record<DocumentKind, string> = {
  CERTIFICAT_SCOLARITE: 'Certificat de scolarité',
  ATTESTATION_INSCRIPTION: "Attestation d'inscription",
  CARTE_SCOLAIRE: 'Carte scolaire',
  ATTESTATION_PAIEMENT: 'Attestation de paiement',
};
const DOC_PREFIX: Record<DocumentKind, string> = { CERTIFICAT_SCOLARITE: 'CS', ATTESTATION_INSCRIPTION: 'AI', CARTE_SCOLAIRE: 'CA', ATTESTATION_PAIEMENT: 'AP' };

class IssueDto {
  @IsEnum(DocumentKind) kind: DocumentKind;
  @IsUUID() studentId: string;
}
class BatchDto {
  @IsEnum(DocumentKind) kind: DocumentKind;
  @IsUUID() classId: string;
}

/** Documents officiels avec QR de vérification publique (CDC §4.1). */
@Injectable()
export class DocumentsService {
  constructor(private db: PrismaService, private scope: ScopeService, private audit: AuditService, private files: FilesService) {}

  private async issueInTx(tx: Tx, actor: Actor, kind: DocumentKind, studentId: string) {
    const yearId = await this.scope.currentYearId(tx);
    const s = await tx.student.findUniqueOrThrow({
      where: { id: studentId },
      include: { enrollments: { where: { academicYearId: yearId, status: 'ACTIVE' }, include: { class: { include: { site: true, level: true, track: true } }, academicYear: true } } },
    });
    const enr = s.enrollments[0];
    if (!enr) throw new NotFoundException("L'élève n'est pas inscrit pour l'année en cours");
    const data: Record<string, unknown> = {
      student: { firstName: s.firstName, lastName: s.lastName, matricule: s.matricule, birthDate: s.birthDate, birthPlace: s.birthPlace, sex: s.sex, photoUrl: s.photoUrl },
      class: enr.class.name, level: enr.class.level.name, track: enr.class.track?.name ?? null, site: enr.class.site.name, siteAddress: enr.class.site.address,
      year: enr.academicYear.label, enrolledAt: enr.enrolledAt,
    };
    if (kind === 'ATTESTATION_PAIEMENT') {
      const agg = await tx.invoice.aggregate({ where: { studentId, status: { not: 'CANCELLED' } }, _sum: { total: true, paid: true } });
      data.payments = { total: agg._sum.total ?? 0, paid: agg._sum.paid ?? 0 };
    }
    const year = new Date().getUTCFullYear();
    const number = `${DOC_PREFIX[kind]}-${year}-${pad(await nextNumber(tx, actor.tenantId, `doc-${kind}-${year}`))}`;
    const code = verifyCode();
    const doc = await tx.document.create({ data: { tenantId: actor.tenantId, kind, number, studentId, verifyCode: code, data: data as Prisma.InputJsonValue, issuedById: actor.userId } });
    await tx.verificationEntry.create({
      data: { code, tenantId: actor.tenantId, kind: DOC_LABEL[kind], issuedAt: doc.issuedAt, summary: `${DOC_LABEL[kind]} n° ${number} · ${s.firstName} ${s.lastName} · ${enr.class.name} · ${enr.academicYear.label}` },
    });
    await this.audit.log(tx, actor, 'document.issued', 'Document', doc.id, { kind, number, studentId });
    return doc;
  }

  issue(actor: Actor, dto: IssueDto) {
    return this.db.forTenant(actor.tenantId, (tx) => this.issueInTx(tx, actor, dto.kind, dto.studentId));
  }

  /** Génération en lot (ex. toutes les cartes scolaires d'une classe). */
  batch(actor: Actor, dto: BatchDto) {
    return this.db.forTenant(
      actor.tenantId,
      async (tx) => {
        const enr = await tx.enrollment.findMany({ where: { classId: dto.classId, status: 'ACTIVE' }, select: { studentId: true } });
        const ids: string[] = [];
        for (const e of enr) ids.push((await this.issueInTx(tx, actor, dto.kind, e.studentId)).id);
        return { count: ids.length, ids };
      },
      { timeout: 120000 },
    );
  }

  list(actor: Actor, studentId?: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const visible = await this.scope.studentIds(tx, actor);
      if (studentId) await this.scope.assertStudent(tx, actor, studentId);
      return tx.document.findMany({
        where: { ...(visible ? { studentId: { in: visible } } : {}), ...(studentId ? { studentId } : {}) },
        select: { id: true, kind: true, number: true, issuedAt: true, student: { select: { id: true, firstName: true, lastName: true, matricule: true } } },
        orderBy: { issuedAt: 'desc' },
        take: 300,
      });
    });
  }

  get(actor: Actor, ids: string[]) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const docs = await tx.document.findMany({ where: { id: { in: ids } } });
      if (!docs.length) throw new NotFoundException('Document introuvable');
      for (const d of docs) await this.scope.assertStudent(tx, actor, d.studentId);
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: actor.tenantId }, select: { name: true, settings: true } });
      const identity = schoolIdentity(tenant, this.files);
      return { tenant: { name: tenant.name, authorization: identity.authorization }, identity, documents: docs.map((d) => ({ ...d, label: DOC_LABEL[d.kind] })) };
    });
  }

  /** Vérification publique d'un QR code : ne révèle que le résumé imprimé sur le document. */
  async verify(code: string) {
    const e = await this.db.verificationEntry.findUnique({ where: { code: code.toUpperCase() } });
    if (!e) return { valid: false };
    const t = await this.db.tenant.findUnique({ where: { id: e.tenantId }, select: { name: true } });
    return { valid: !e.revokedAt, revoked: !!e.revokedAt, kind: e.kind, summary: e.summary, issuedAt: e.issuedAt, issuer: t?.name };
  }
}

@ApiTags('Documents')
@Controller()
export class DocumentsController {
  constructor(private s: DocumentsService) {}

  @ApiBearerAuth()
  @Post('documents') @Can('documents.issue')
  issue(@CurrentActor() a: Actor, @Body() dto: IssueDto) { return this.s.issue(a, dto); }

  @ApiBearerAuth()
  @Post('documents/batch') @Can('documents.issue')
  batch(@CurrentActor() a: Actor, @Body() dto: BatchDto) { return this.s.batch(a, dto); }

  @ApiBearerAuth()
  @Get('documents') @Can('documents.read')
  list(@CurrentActor() a: Actor, @Query('studentId') studentId?: string) { return this.s.list(a, studentId); }

  /** Un ou plusieurs documents (ids séparés par des virgules) pour l'impression. */
  @ApiBearerAuth()
  @Get('documents/print') @Can('documents.read')
  print(@CurrentActor() a: Actor, @Query('ids') ids: string) { return this.s.get(a, (ids ?? '').split(',').filter(Boolean).slice(0, 500)); }

  @Public()
  @Get('public/verify/:code')
  verify(@Param('code') code: string) { return this.s.verify(code); }
}
