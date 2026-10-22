import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Actor } from '../../common/auth';
import { AuditService } from '../../common/audit.service';
import { can } from '../../common/permissions';
import { PrismaService, Tx } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { nextNumber, normalizePhone, pad, toDate } from '../../common/util';
import { hashPassword } from '../auth/auth.service';
import { FilesService } from '../files/files.service';
import { FinanceService } from '../finance/finance.service';
import { SettingsService, temporaryPassword } from '../settings/settings.service';
import { ChangeClassDto, EnrollStudentDto, GuardianInput, UpdateStudentDto, WithdrawDto } from './students.dto';

@Injectable()
export class StudentsService {
  constructor(
    private db: PrismaService,
    private scope: ScopeService,
    private audit: AuditService,
    private settings: SettingsService,
    private finance: FinanceService,
    private files: FilesService,
  ) {}

  /** Lien signé (15 minutes) vers la photo de l'élève, ou null. */
  photoUrl(s: { photoKey: string | null; photoUrl?: string | null }) {
    return s.photoKey ? this.files.signedUrl(s.photoKey) : s.photoUrl ?? null;
  }

  list(actor: Actor, q?: string, classId?: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const yearId = await this.scope.currentYearId(tx);
      const visible = await this.scope.studentIds(tx, actor);
      const where: Prisma.StudentWhereInput = {
        ...(visible ? { id: { in: visible } } : {}),
        ...(classId ? { enrollments: { some: { classId, status: 'ACTIVE' } } } : {}),
        ...(q
          ? { OR: [{ lastName: { contains: q, mode: 'insensitive' } }, { firstName: { contains: q, mode: 'insensitive' } }, { matricule: { contains: q, mode: 'insensitive' } }] }
          : {}),
      };
      const students = await tx.student.findMany({
        where,
        select: {
          id: true, matricule: true, firstName: true, lastName: true, sex: true, birthDate: true, status: true,
          enrollments: { where: { academicYearId: yearId }, select: { class: { select: { id: true, name: true, site: { select: { id: true, name: true } } } } } },
        },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        take: 500,
      });
      // Le solde n'est montré qu'aux rôles qui ont accès aux finances (jamais aux enseignants).
      const balances = can(actor.role, 'finance.read') ? await this.finance.balances(tx, students.map((s) => s.id)) : null;
      return students.map(({ enrollments, ...s }) => ({
        ...s,
        class: enrollments[0]?.class ?? null,
        ...(balances ? { balance: balances.get(s.id) ?? 0 } : {}),
      }));
    });
  }

  get(actor: Actor, id: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      await this.scope.assertStudent(tx, actor, id);
      const yearId = await this.scope.currentYearId(tx);
      const s = await tx.student.findUnique({
        where: { id },
        include: {
          guardians: { include: { guardian: { select: { id: true, firstName: true, lastName: true, phone: true, email: true, userId: true } } } },
          enrollments: { include: { class: { select: { id: true, name: true, site: { select: { name: true } } } }, academicYear: { select: { label: true } } }, orderBy: { enrolledAt: 'desc' } },
        },
      });
      if (!s) throw new NotFoundException('Élève introuvable');
      const current = s.enrollments.find((e) => e.academicYearId === yearId);
      const balance = can(actor.role, 'finance.read') ? (await this.finance.balances(tx, [id])).get(id) ?? 0 : undefined;
      // Les coordonnées des responsables ne sont pas exposées aux élèves.
      const guardians = actor.role === 'ELEVE' ? s.guardians.map((g) => ({ ...g, guardian: { ...g.guardian, phone: null, email: null } })) : s.guardians;
      // Les pièces du dossier ne sont visibles que de la direction et du secrétariat.
      const files = can(actor.role, 'students.write')
        ? (await tx.studentFile.findMany({ where: { studentId: id }, orderBy: { createdAt: 'asc' } })).map((f) => this.fileView(f))
        : undefined;
      const { photoKey, ...rest } = s;
      return { ...rest, photoUrl: this.photoUrl(s), guardians, currentClass: current?.class ?? null, balance, hasAccount: !!s.userId, files };
    });
  }

  enroll(actor: Actor, dto: EnrollStudentDto) {
    return this.db.forTenant(actor.tenantId, (tx) => this.enrollInTx(tx, actor, dto));
  }

  /** Inscription : dossier élève, responsables, inscription dans la classe, comptes, factures (CDC §4.1 étape 6). */
  async enrollInTx(tx: Tx, actor: Actor, dto: EnrollStudentDto) {
    const yearId = await this.scope.currentYearId(tx);
    const klass = await tx.class.findUnique({ where: { id: dto.classId }, include: { _count: { select: { enrollments: { where: { status: 'ACTIVE' } } } } } });
    if (!klass || klass.academicYearId !== yearId) throw new BadRequestException("Cette classe n'existe pas pour l'année en cours");
    if (klass.capacity && klass._count.enrollments >= klass.capacity) throw new ConflictException(`La classe ${klass.name} est complète (${klass.capacity} places)`);

    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: actor.tenantId } });
    const year = await tx.academicYear.findUniqueOrThrow({ where: { id: yearId } });
    const prefix = ((tenant.settings as any)?.matriculePrefix as string) || tenant.slug.replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase() || 'ELV';
    const yy = String(year.startDate.getUTCFullYear()).slice(2);
    const matricule = `${prefix}-${yy}-${pad(await nextNumber(tx, actor.tenantId, `matricule-${yy}`), 4)}`;

    const student = await tx.student.create({
      data: {
        tenantId: actor.tenantId, matricule, firstName: dto.firstName.trim(), lastName: dto.lastName.trim().toUpperCase(), sex: dto.sex,
        birthDate: dto.birthDate ? toDate(dto.birthDate) : null, birthPlace: dto.birthPlace, allergies: dto.allergies,
      },
    });
    await tx.enrollment.create({ data: { tenantId: actor.tenantId, studentId: student.id, classId: klass.id, academicYearId: yearId } });

    const credentials: { name: string; identifier: string; temporaryPassword: string }[] = [];
    for (const [i, g] of dto.guardians.entries()) {
      const r = await this.linkGuardian(tx, actor, student.id, g, i === 0);
      if (r.temporaryPassword) credentials.push({ name: `${g.firstName} ${g.lastName}`, identifier: r.phone, temporaryPassword: r.temporaryPassword });
    }

    if (dto.createStudentAccount) {
      const password = temporaryPassword();
      const user = await tx.user.create({
        data: {
          tenantId: actor.tenantId, firstName: student.firstName, lastName: student.lastName, passwordHash: await hashPassword(password),
          roles: { create: [{ tenantId: actor.tenantId, role: 'ELEVE' }] },
        },
      });
      await tx.student.update({ where: { id: student.id }, data: { userId: user.id } });
      credentials.push({ name: `${student.firstName} ${student.lastName} (élève)`, identifier: matricule, temporaryPassword: password });
    }

    let invoices = 0;
    if (dto.createInvoices) invoices = await this.finance.invoiceFromCatalog(tx, actor, student.id, klass.id, !!dto.returning);

    if (dto.applicationId) {
      await tx.application.update({ where: { id: dto.applicationId }, data: { status: 'INSCRIT', studentId: student.id } });
    }
    await this.audit.log(tx, actor, 'student.enrolled', 'Student', student.id, { matricule, classId: klass.id });
    return { id: student.id, matricule, credentials, invoices };
  }

  /** Rattache un responsable ; réutilise la fiche et le compte existants (fratrie) d'après le téléphone. */
  async linkGuardian(tx: Tx, actor: Actor, studentId: string, g: GuardianInput, primary: boolean) {
    const phone = normalizePhone(g.phone);
    let guardian = await tx.guardian.findFirst({ where: { phone } });
    if (!guardian) {
      guardian = await tx.guardian.create({
        data: { tenantId: actor.tenantId, firstName: g.firstName.trim(), lastName: g.lastName.trim().toUpperCase(), phone, email: g.email?.toLowerCase() },
      });
    }
    await tx.studentGuardian.upsert({
      where: { studentId_guardianId: { studentId, guardianId: guardian.id } },
      create: { tenantId: actor.tenantId, studentId, guardianId: guardian.id, relation: g.relation, isPrimary: g.isPrimary ?? primary },
      update: { relation: g.relation },
    });

    let temporaryPassword_: string | undefined;
    if (!guardian.userId) {
      let user = await tx.user.findFirst({ where: { phone } });
      if (!user) {
        temporaryPassword_ = temporaryPassword();
        user = await tx.user.create({
          data: { tenantId: actor.tenantId, firstName: guardian.firstName, lastName: guardian.lastName, phone, email: guardian.email, passwordHash: await hashPassword(temporaryPassword_) },
        });
        await this.settings.sendCredentials(tx, actor, phone, temporaryPassword_);
      }
      await tx.guardian.update({ where: { id: guardian.id }, data: { userId: user.id } });
      guardian.userId = user.id;
    }
    // Un enseignant parent d'élève cumule les deux rôles sur le même compte (CDC §2).
    // (siteId NULL : la contrainte d'unicité ne joue pas, d'où la vérification explicite.)
    const hasParent = await tx.userRole.count({ where: { userId: guardian.userId, role: 'PARENT' } });
    if (!hasParent) await tx.userRole.create({ data: { tenantId: actor.tenantId, userId: guardian.userId, role: 'PARENT' } });
    return { guardianId: guardian.id, phone, temporaryPassword: temporaryPassword_ };
  }

  update(actor: Actor, id: string, dto: UpdateStudentDto) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const s = await tx.student.update({
        where: { id },
        data: { ...dto, lastName: dto.lastName?.toUpperCase(), birthDate: dto.birthDate ? toDate(dto.birthDate) : undefined },
      });
      await this.audit.log(tx, actor, 'student.updated', 'Student', id, dto);
      return s;
    });
  }

  /** Photo d'identité de l'élève (JPEG, PNG ou WebP), remplaçable à tout moment ; sans fichier, la photo est retirée. */
  setPhoto(actor: Actor, id: string, file?: { buffer: Buffer; mimetype: string; size: number }) {
    if (file && !file.mimetype.startsWith('image/')) throw new BadRequestException('Envoyez une photo (JPEG, PNG ou WebP)');
    return this.db.forTenant(actor.tenantId, async (tx) => {
      await this.scope.assertStudent(tx, actor, id);
      const photoKey = file ? await this.files.save(actor.tenantId, 'eleves/photos', file) : null;
      const s = await tx.student.update({ where: { id }, data: { photoKey } });
      await this.audit.log(tx, actor, file ? 'student.photo_set' : 'student.photo_removed', 'Student', id);
      return { photoUrl: this.photoUrl(s) };
    });
  }

  private fileView(f: { id: string; label: string; fileKey: string; mime: string; size: number; createdAt: Date }) {
    return { id: f.id, label: f.label, mime: f.mime, size: f.size, createdAt: f.createdAt, url: this.files.signedUrl(f.fileKey) };
  }

  /** Pièce du dossier (extrait de naissance, pièce d'identité, attestation…) : photo ou PDF de 5 Mo au plus. */
  addFile(actor: Actor, id: string, label: string, file?: { buffer: Buffer; mimetype: string; size: number }) {
    if (!file) throw new BadRequestException('Choisissez le fichier à envoyer');
    const name = (label ?? '').trim().slice(0, 120);
    if (!name) throw new BadRequestException('Indiquez de quelle pièce il s’agit');
    return this.db.forTenant(actor.tenantId, async (tx) => {
      await this.scope.assertStudent(tx, actor, id);
      const fileKey = await this.files.save(actor.tenantId, 'eleves/pieces', file);
      const f = await tx.studentFile.create({ data: { tenantId: actor.tenantId, studentId: id, label: name, fileKey, mime: file.mimetype, size: file.size, uploadedById: actor.userId } });
      await this.audit.log(tx, actor, 'student.file_added', 'Student', id, { fileId: f.id, label: name });
      return this.fileView(f);
    });
  }

  /** Remplace le fichier d'une pièce (nouvelle version) en gardant son nom, ou renomme la pièce. */
  updateFile(actor: Actor, id: string, fileId: string, label?: string, file?: { buffer: Buffer; mimetype: string; size: number }) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      await this.scope.assertStudent(tx, actor, id);
      const current = await tx.studentFile.findFirst({ where: { id: fileId, studentId: id } });
      if (!current) throw new NotFoundException('Pièce introuvable');
      const data: Prisma.StudentFileUpdateInput = {};
      if (label?.trim()) data.label = label.trim().slice(0, 120);
      if (file) Object.assign(data, { fileKey: await this.files.save(actor.tenantId, 'eleves/pieces', file), mime: file.mimetype, size: file.size, uploadedById: actor.userId });
      const f = await tx.studentFile.update({ where: { id: fileId }, data });
      await this.audit.log(tx, actor, 'student.file_updated', 'Student', id, { fileId, label: f.label, replaced: !!file });
      return this.fileView(f);
    });
  }

  removeFile(actor: Actor, id: string, fileId: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      await this.scope.assertStudent(tx, actor, id);
      const { count } = await tx.studentFile.deleteMany({ where: { id: fileId, studentId: id } });
      if (!count) throw new NotFoundException('Pièce introuvable');
      await this.audit.log(tx, actor, 'student.file_removed', 'Student', id, { fileId });
      return { ok: true };
    });
  }

  addGuardian(actor: Actor, id: string, dto: GuardianInput) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const r = await this.linkGuardian(tx, actor, id, dto, false);
      await this.audit.log(tx, actor, 'student.guardian_added', 'Student', id, { phone: r.phone });
      return r;
    });
  }

  changeClass(actor: Actor, id: string, dto: ChangeClassDto) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const yearId = await this.scope.currentYearId(tx);
      const e = await tx.enrollment.update({ where: { studentId_academicYearId: { studentId: id, academicYearId: yearId } }, data: { classId: dto.classId } });
      await this.audit.log(tx, actor, 'student.class_changed', 'Student', id, dto);
      return e;
    });
  }

  withdraw(actor: Actor, id: string, dto: WithdrawDto) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const yearId = await this.scope.currentYearId(tx);
      await tx.student.update({ where: { id }, data: { status: dto.status } });
      await tx.enrollment.updateMany({ where: { studentId: id, academicYearId: yearId }, data: { status: dto.status } });
      await this.audit.log(tx, actor, 'student.withdrawn', 'Student', id, dto);
      return { ok: true };
    });
  }
}
