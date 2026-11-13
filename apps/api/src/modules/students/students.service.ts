import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Actor } from '../../common/auth';
import { AuditService, auditChanges, maskIdentifier } from '../../common/audit.service';
import { assertOwned } from '../../common/ownership';
import { can } from '../../common/permissions';
import { PrismaService, Tx } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { nextNumber, pad, toDate } from '../../common/util';
import { tenantPhone } from '../../common/country';
import { hashPassword } from '../auth/auth.service';
import { FilesService } from '../files/files.service';
import { FinanceService } from '../finance/finance.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService, temporaryPassword } from '../settings/settings.service';
import { DUPLICATE_REASON_LABELS, DuplicateReason, enrollmentEvent, findDuplicates, historyStudentIds, nameKey, suspectedPairs } from './enrollments';
import {
  CancelEnrollmentDto, ChangeClassDto, DuplicateDecisionDto, EnrollStudentDto, GuardianInput, ReenrollDto, UpdateStudentDto, WithdrawDto,
} from './students.dto';

@Injectable()
export class StudentsService {
  constructor(
    private db: PrismaService,
    private scope: ScopeService,
    private audit: AuditService,
    private settings: SettingsService,
    private finance: FinanceService,
    private files: FilesService,
    private notifications: NotificationsService,
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
          enrollments: { where: { academicYearId: yearId }, select: { status: true, class: { select: { id: true, name: true, site: { select: { id: true, name: true } } } } } },
        },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        take: 500,
      });
      // Le solde n'est montré qu'aux rôles qui ont accès aux finances (jamais aux enseignants).
      const balances = can(actor.role, 'finance.read') ? await this.finance.balances(tx, students.map((s) => s.id)) : null;
      return students.map(({ enrollments, ...s }) => ({
        ...s,
        // Lot G4 : une inscription annulée ne place plus l'élève dans une classe.
        class: enrollments[0] && enrollments[0].status !== 'CANCELLED' ? enrollments[0].class : null,
        enrollmentStatus: enrollments[0]?.status ?? null,
        ...(balances ? { balance: balances.get(s.id) ?? 0 } : {}),
      }));
    });
  }

  get(actor: Actor, id: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      // Lot G4 : l'historique des inscriptions (motifs de sortie et d'annulation) n'est montré qu'à la direction et au secrétariat.
      const full = can(actor.role, 'students.write');
      await this.scope.assertStudent(tx, actor, id).catch(async (e: unknown) => {
        // Un ancien élève (parti, ou pas encore réinscrit cette année) reste consultable par la direction et le
        // secrétariat de son dernier site, pour être réinscrit (lot G4). Rien de plus pour les autres rôles.
        if (!(e instanceof ForbiddenException) || !full) throw e;
        await this.assertHistoryScope(tx, actor, id);
      });
      const yearId = await this.scope.currentYearId(tx);
      const s = await tx.student.findUnique({
        where: { id },
        include: {
          guardians: { include: { guardian: { select: { id: true, firstName: true, lastName: true, phone: true, email: true, userId: true } } } },
          enrollments: {
            include: {
              class: { select: { id: true, name: true, site: { select: { name: true } } } },
              academicYear: { select: { label: true, startDate: true } },
              ...(full ? { events: { orderBy: { createdAt: 'asc' as const }, select: { id: true, kind: true, data: true, actorName: true, createdAt: true } } } : {}),
            },
            orderBy: [{ academicYear: { startDate: 'desc' } }, { enrolledAt: 'desc' }],
          },
        },
      });
      if (!s) throw new NotFoundException('Élève introuvable');
      const current = s.enrollments.find((e) => e.academicYearId === yearId && e.status === 'ACTIVE');
      const thisYear = s.enrollments.find((e) => e.academicYearId === yearId);
      const enrollments = full ? s.enrollments : s.enrollments.map(({ exitReason, cancelReason, cancelledById, ...e }) => e);
      const balance = can(actor.role, 'finance.read') ? (await this.finance.balances(tx, [id])).get(id) ?? 0 : undefined;
      // Les coordonnées des responsables ne sont pas exposées aux élèves.
      const guardians = actor.role === 'ELEVE' ? s.guardians.map((g) => ({ ...g, guardian: { ...g.guardian, phone: null, email: null } })) : s.guardians;
      // Les pièces du dossier ne sont visibles que de la direction et du secrétariat.
      const files = can(actor.role, 'students.write')
        ? (await tx.studentFile.findMany({ where: { studentId: id }, orderBy: { createdAt: 'asc' } })).map((f) => this.fileView(f))
        : undefined;
      const { photoKey, ...all } = s;
      // SEC-014 : la santé (allergies) n'est pas visible du comptable ni de l'élève (matrice RBAC, ligne Santé).
      const { allergies, ...withoutHealth } = all;
      const rest = actor.role === 'COMPTABLE' || actor.role === 'ELEVE' ? withoutHealth : all;
      // Réinscription possible depuis le dossier : aucune inscription active cette année (lot G4).
      const reenrollable = full && (!thisYear || thisYear.status !== 'ACTIVE');
      const currentYear = await tx.academicYear.findUniqueOrThrow({ where: { id: yearId }, select: { id: true, label: true } });
      return { ...rest, enrollments, photoUrl: this.photoUrl(s), guardians, currentClass: current?.class ?? null, balance, hasAccount: !!s.userId, files, reenrollable, currentYear };
    });
  }

  enroll(actor: Actor, dto: EnrollStudentDto) {
    return this.db.forTenant(actor.tenantId, (tx) => this.enrollInTx(tx, actor, dto));
  }

  /** Inscription : dossier élève, responsables, inscription dans la classe, comptes, factures (CDC §4.1 étape 6). */
  async enrollInTx(tx: Tx, actor: Actor, dto: EnrollStudentDto) {
    const yearId = await this.scope.currentYearId(tx);
    // SEC-013 : un compte limité à un site n'inscrit que dans une classe de son site.
    await this.scope.assertClass(tx, actor, dto.classId);
    const klass = await tx.class.findUnique({ where: { id: dto.classId }, include: { _count: { select: { enrollments: { where: { status: 'ACTIVE' } } } } } });
    if (!klass || klass.academicYearId !== yearId) throw new BadRequestException("Cette classe n'existe pas pour l'année en cours");
    if (klass.capacity && klass._count.enrollments >= klass.capacity) throw new ConflictException(`La classe ${klass.name} est complète (${klass.capacity} places)`);
    if (dto.applicationId) await this.assertApplication(tx, actor, dto.applicationId);

    // Lot G4 : un dossier qui ressemble à cet élève (même nom, et même date de naissance ou un parent en commun) arrête
    // l'inscription. La personne réinscrit l'élève sur son dossier, ou confirme avec un motif qu'il s'agit d'un autre
    // élève ; la paire est alors soumise à la direction. Aucun dossier n'est jamais fusionné ni supprimé.
    const firstName = dto.firstName.trim();
    const lastName = dto.lastName.trim().toUpperCase();
    const birthDate = dto.birthDate ? toDate(dto.birthDate) : null;
    const phones = await Promise.all(dto.guardians.map((g) => tenantPhone(tx, actor.tenantId, g.phone)));
    const duplicates = await findDuplicates(tx, { firstName, lastName, birthDate, phones });
    if (duplicates.length && !dto.confirmNotDuplicate) {
      // Un personnel limité à un site voit qu'un dossier existe sur un autre site (nom, matricule, site), sans le détail.
      const mine = (d: (typeof duplicates)[number]) => !actor.siteIds.length || (!!d.lastSiteId && actor.siteIds.includes(d.lastSiteId));
      throw new ConflictException({
        statusCode: 409,
        code: 'DOUBLON_POSSIBLE',
        message: 'Un dossier qui ressemble à cet élève existe déjà. Un élève qui revient se réinscrit sur son dossier, avec son matricule.',
        candidates: duplicates.map((d) => (mine(d)
          ? {
            id: d.id, matricule: d.matricule, firstName: d.firstName, lastName: d.lastName, birthDate: d.birthDate, reason: d.reason, reasonLabel: d.reasonLabel,
            lastClass: d.lastClass, lastYear: d.lastYear, lastSite: d.lastSite, enrolledThisYear: d.enrolledThisYear, otherSite: false,
          }
          : {
            id: null, matricule: d.matricule, firstName: d.firstName, lastName: d.lastName, birthDate: null, reason: d.reason, reasonLabel: d.reasonLabel,
            lastClass: null, lastYear: d.lastYear, lastSite: d.lastSite, enrolledThisYear: d.enrolledThisYear, otherSite: true,
          })),
      });
    }
    const duplicateNote = (dto.duplicateNote ?? '').trim();
    if (duplicates.length && duplicateNote.length < 5) throw new BadRequestException('Indiquez pourquoi il ne s’agit pas du même élève (5 caractères au moins)');

    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: actor.tenantId } });
    const year = await tx.academicYear.findUniqueOrThrow({ where: { id: yearId } });
    const prefix = ((tenant.settings as any)?.matriculePrefix as string) || tenant.slug.replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase() || 'ELV';
    const yy = String(year.startDate.getUTCFullYear()).slice(2);
    const matricule = `${prefix}-${yy}-${pad(await nextNumber(tx, actor.tenantId, `matricule-${yy}`), 4)}`;

    const student = await tx.student.create({
      data: {
        tenantId: actor.tenantId, matricule, firstName, lastName, sex: dto.sex,
        birthDate, birthPlace: dto.birthPlace, allergies: dto.allergies,
      },
    });
    const type = dto.returning ? 'RETURNING' : 'NEW';
    const enrollment = await tx.enrollment.create({ data: { tenantId: actor.tenantId, studentId: student.id, classId: klass.id, academicYearId: yearId, type } });
    await enrollmentEvent(tx, actor, enrollment.id, 'ENROLLED', { classId: klass.id, className: klass.name, type, ...(dto.applicationId ? { applicationId: dto.applicationId } : {}) });
    for (const d of duplicates) {
      await tx.duplicateReview.create({ data: { tenantId: actor.tenantId, studentId: student.id, otherId: d.id, reason: d.reason, note: duplicateNote, createdById: actor.userId } });
    }
    if (duplicates.length) {
      // La direction (de tout l'établissement ou du site de la classe) est prévenue : c'est elle qui tranche.
      const directors = await tx.userRole.findMany({ where: { role: 'DIRECTION', OR: [{ siteId: null }, { siteId: klass.siteId }] }, select: { userId: true } });
      await this.notifications.notify(tx, actor.tenantId, directors.map((d) => d.userId), {
        kind: 'duplicate', title: 'Doublon possible à vérifier',
        body: `${firstName} ${lastName} (${matricule}) ressemble au dossier ${duplicates.map((d) => d.matricule).join(', ')}. Élèves › Doublons.`,
        data: { studentId: student.id }, smsMode: 'none',
      });
    }

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

    if (dto.applicationId) await tx.application.update({ where: { id: dto.applicationId }, data: { status: 'INSCRIT', studentId: student.id } });
    await this.audit.log(tx, actor, 'student.enrolled', 'Student', student.id, {
      matricule, classId: klass.id, type, ...(duplicates.length ? { duplicatesSignalled: duplicates.map((d) => d.matricule), duplicateNote } : {}),
    });
    return { id: student.id, matricule, credentials, invoices };
  }

  /** Rattache un responsable ; réutilise la fiche et le compte existants (fratrie) d'après le téléphone. */
  async linkGuardian(tx: Tx, actor: Actor, studentId: string, g: GuardianInput, primary: boolean) {
    const phone = await tenantPhone(tx, actor.tenantId, g.phone);
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
      await this.scope.assertStudent(tx, actor, id);
      const before = await tx.student.findUniqueOrThrow({ where: { id } });
      const s = await tx.student.update({
        where: { id },
        data: { ...dto, lastName: dto.lastName?.toUpperCase(), birthDate: dto.birthDate ? toDate(dto.birthDate) : undefined },
      });
      // SEC-033 et SEC-037 : avant et après, sans recopier les allergies.
      await this.audit.log(tx, actor, 'student.updated', 'Student', id, auditChanges(before, s, Object.keys(dto)));
      return s;
    });
  }

  /** Photo d'identité de l'élève (JPEG, PNG ou WebP), remplaçable à tout moment ; sans fichier, la photo est retirée. */
  async setPhoto(actor: Actor, id: string, file?: { buffer: Buffer; mimetype: string; size: number }) {
    if (file && !file.mimetype.startsWith('image/')) throw new BadRequestException('Envoyez une photo (JPEG, PNG ou WebP)');
    // Fichier traité (antivirus, ré-encodage) hors transaction ; l'ancienne photo est effacée après validation (SEC-028).
    const photoKey = file ? await this.files.save(actor.tenantId, 'eleves/photos', file) : null;
    return this.files.commit(photoKey, () => this.db.forTenant(actor.tenantId, async (tx) => {
      await this.scope.assertStudent(tx, actor, id);
      const prev = await tx.student.findUniqueOrThrow({ where: { id }, select: { photoKey: true } });
      const s = await tx.student.update({ where: { id }, data: { photoKey } });
      await this.audit.log(tx, actor, file ? 'student.photo_set' : 'student.photo_removed', 'Student', id);
      return { result: { photoUrl: this.photoUrl(s) }, old: [prev.photoKey] };
    }));
  }

  private fileView(f: { id: string; label: string; fileKey: string; mime: string; size: number; createdAt: Date }) {
    return { id: f.id, label: f.label, mime: f.mime, size: f.size, createdAt: f.createdAt, url: this.files.signedUrl(f.fileKey) };
  }

  /** Pièce du dossier (extrait de naissance, pièce d'identité, attestation…) : photo ou PDF de 5 Mo au plus. */
  addFile(actor: Actor, id: string, label: string, file?: { buffer: Buffer; mimetype: string; size: number }) {
    if (!file) throw new BadRequestException('Choisissez le fichier à envoyer');
    const name = (label ?? '').trim().slice(0, 120);
    if (!name) throw new BadRequestException('Indiquez de quelle pièce il s’agit');
    return this.files.save(actor.tenantId, 'eleves/pieces', file).then((fileKey) => this.files.commit(fileKey, () => this.db.forTenant(actor.tenantId, async (tx) => {
      await this.scope.assertStudent(tx, actor, id);
      const f = await tx.studentFile.create({ data: { tenantId: actor.tenantId, studentId: id, label: name, fileKey, mime: file.mimetype, size: file.size, uploadedById: actor.userId } });
      await this.audit.log(tx, actor, 'student.file_added', 'Student', id, { fileId: f.id, label: name });
      return { result: this.fileView(f) };
    })));
  }

  /** Remplace le fichier d'une pièce (nouvelle version) en gardant son nom, ou renomme la pièce. */
  async updateFile(actor: Actor, id: string, fileId: string, label?: string, file?: { buffer: Buffer; mimetype: string; size: number }) {
    const fileKey = file ? await this.files.save(actor.tenantId, 'eleves/pieces', file) : null;
    return this.files.commit(fileKey, () => this.db.forTenant(actor.tenantId, async (tx) => {
      await this.scope.assertStudent(tx, actor, id);
      const current = await tx.studentFile.findFirst({ where: { id: fileId, studentId: id } });
      if (!current) throw new NotFoundException('Pièce introuvable');
      const data: Prisma.StudentFileUpdateInput = {};
      if (label?.trim()) data.label = label.trim().slice(0, 120);
      if (file && fileKey) Object.assign(data, { fileKey, mime: file.mimetype, size: file.size, uploadedById: actor.userId });
      const f = await tx.studentFile.update({ where: { id: fileId }, data });
      await this.audit.log(tx, actor, 'student.file_updated', 'Student', id, { fileId, label: f.label, replaced: !!file });
      return { result: this.fileView(f), old: fileKey ? [current.fileKey] : [] };
    }));
  }

  /** Supprime la pièce et son fichier sur le disque (SEC-028). */
  removeFile(actor: Actor, id: string, fileId: string) {
    return this.files.commit(null, () => this.db.forTenant(actor.tenantId, async (tx) => {
      await this.scope.assertStudent(tx, actor, id);
      const current = await tx.studentFile.findFirst({ where: { id: fileId, studentId: id } });
      if (!current) throw new NotFoundException('Pièce introuvable');
      await tx.studentFile.delete({ where: { id: current.id } });
      await this.audit.log(tx, actor, 'student.file_removed', 'Student', id, { fileId });
      return { result: { ok: true }, old: [current.fileKey] };
    }));
  }

  addGuardian(actor: Actor, id: string, dto: GuardianInput) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      await this.scope.assertStudent(tx, actor, id);
      const r = await this.linkGuardian(tx, actor, id, dto, false);
      await this.audit.log(tx, actor, 'student.guardian_added', 'Student', id, { phone: maskIdentifier(r.phone) }); // SEC-037
      return r;
    });
  }

  changeClass(actor: Actor, id: string, dto: ChangeClassDto) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const yearId = await this.scope.currentYearId(tx);
      await this.scope.assertStudent(tx, actor, id);
      await this.scope.assertClass(tx, actor, dto.classId);
      const target = await tx.class.findUniqueOrThrow({ where: { id: dto.classId }, select: { academicYearId: true, name: true } });
      if (target.academicYearId !== yearId) throw new BadRequestException("Cette classe n'existe pas pour l'année en cours");
      const before = await tx.enrollment.findUnique({ where: { studentId_academicYearId: { studentId: id, academicYearId: yearId } }, include: { class: { select: { name: true } } } });
      if (!before || before.status !== 'ACTIVE') throw new BadRequestException("Cet élève n'est pas inscrit dans une classe cette année");
      const e = await tx.enrollment.update({ where: { id: before.id }, data: { classId: dto.classId } });
      if (before.classId !== dto.classId) {
        await enrollmentEvent(tx, actor, e.id, 'CLASS_CHANGED', { fromClassId: before.classId, fromClass: before.class.name, toClassId: dto.classId, toClass: target.name });
      }
      await this.audit.log(tx, actor, 'student.class_changed', 'Student', id, dto);
      return e;
    });
  }

  /** Départ en cours d'année (transfert, abandon) : date de sortie et motif ; dossier, notes et paiements conservés. */
  withdraw(actor: Actor, id: string, dto: WithdrawDto) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const yearId = await this.scope.currentYearId(tx);
      await this.scope.assertStudent(tx, actor, id);
      const e = await tx.enrollment.findUnique({
        where: { studentId_academicYearId: { studentId: id, academicYearId: yearId } },
        include: { class: { select: { name: true } }, academicYear: { select: { startDate: true } } },
      });
      if (!e || e.status !== 'ACTIVE') throw new BadRequestException("Cet élève n'est pas inscrit dans une classe cette année");
      const day = dto.exitDate.slice(0, 10);
      const exitDate = toDate(day);
      if (exitDate < e.academicYear.startDate) throw new BadRequestException('La date de sortie précède la rentrée de l’année en cours');
      if (exitDate.getTime() > Date.now() + 86_400_000) throw new BadRequestException('La date de sortie ne peut pas être dans le futur');
      const reason = dto.reason.trim();
      await tx.student.update({ where: { id }, data: { status: dto.status } });
      await tx.enrollment.update({ where: { id: e.id }, data: { status: dto.status, exitDate, exitReason: reason } });
      await enrollmentEvent(tx, actor, e.id, dto.status, { exitDate: day, reason, className: e.class.name });
      await this.audit.log(tx, actor, 'student.withdrawn', 'Student', id, { status: dto.status, reason, exitDate: day });
      return { ok: true };
    });
  }

  /**
   * GRP-003 : un personnel limité à un site ne convertit que les pré-inscriptions de son site. Lot G4 : une
   * pré-inscription qui a déjà servi à inscrire un élève ne sert pas une seconde fois pour un autre dossier.
   */
  private async assertApplication(tx: Tx, actor: Actor, applicationId: string, studentId?: string) {
    const application = await tx.application.findUnique({ where: { id: applicationId }, select: { siteId: true, studentId: true } });
    if (!application) throw new NotFoundException('Pré-inscription introuvable');
    if (actor.siteIds.length && !(application.siteId && actor.siteIds.includes(application.siteId))) throw new ForbiddenException('Pré-inscription hors de votre périmètre');
    if (application.studentId && application.studentId !== studentId) {
      const used = await tx.student.findUnique({ where: { id: application.studentId }, select: { matricule: true } });
      throw new ConflictException(`Cette pré-inscription a déjà servi à inscrire un élève${used ? ` (${used.matricule})` : ''}`);
    }
  }

  /**
   * Périmètre d'un élève qui n'est pas (ou plus) inscrit dans une classe cette année : pour un personnel limité à un
   * site, le site de sa dernière classe (lot G4).
   */
  private async assertHistoryScope(tx: Tx, actor: Actor, studentId: string) {
    if (!actor.siteIds.length) return assertOwned(tx, { student: studentId });
    const last = await tx.enrollment.findFirst({ where: { studentId }, orderBy: { academicYear: { startDate: 'desc' } }, select: { class: { select: { siteId: true } } } });
    if (!last || !actor.siteIds.includes(last.class.siteId)) throw new ForbiddenException('Élève hors de votre périmètre');
  }

  /**
   * Élèves à réinscrire (lot G4) : inscrits jusqu'au bout d'une année antérieure (par défaut la précédente), sans
   * inscription pour l'année en cours. Pour chacun : sa classe, la décision de fin d'année et, pour qui voit les
   * finances, son solde (affiché seulement : aucune règle de blocage n'est appliquée).
   */
  reenrollmentCandidates(actor: Actor, fromYearId?: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const current = await tx.academicYear.findFirst({ where: { isCurrent: true }, select: { id: true, label: true, startDate: true } });
      if (!current) throw new NotFoundException("Aucune année scolaire courante n'est définie");
      const years = await tx.academicYear.findMany({ where: { startDate: { lt: current.startDate } }, orderBy: { startDate: 'desc' }, select: { id: true, label: true } });
      const from = fromYearId ? years.find((y) => y.id === fromYearId) : years[0];
      if (fromYearId && !from) throw new BadRequestException("Choisissez une année antérieure à l'année en cours");
      const toYear = { id: current.id, label: current.label };
      if (!from) return { toYear, fromYear: null, years, items: [] };
      const rows = await tx.enrollment.findMany({
        where: {
          academicYearId: from.id,
          status: 'ACTIVE',
          ...(actor.siteIds.length ? { class: { siteId: { in: actor.siteIds } } } : {}),
          student: { enrollments: { none: { academicYearId: current.id, status: { not: 'CANCELLED' } } } },
        },
        select: {
          student: { select: { id: true, matricule: true, firstName: true, lastName: true, status: true, annualDecisions: { where: { academicYearId: from.id }, select: { outcome: true } } } },
          class: { select: { id: true, name: true, level: { select: { name: true } }, site: { select: { id: true, name: true } } } },
        },
        orderBy: [{ class: { name: 'asc' } }, { student: { lastName: 'asc' } }, { student: { firstName: 'asc' } }],
        take: 3000,
      });
      const balances = can(actor.role, 'finance.read') ? await this.finance.balances(tx, rows.map((r) => r.student.id)) : null;
      return {
        toYear,
        fromYear: from,
        years,
        items: rows.map(({ student: { annualDecisions, ...st }, class: c }) => ({
          ...st,
          outcome: annualDecisions[0]?.outcome ?? null,
          fromClass: { id: c.id, name: c.name, level: c.level.name, site: c.site },
          ...(balances ? { balance: balances.get(st.id) ?? 0 } : {}),
        })),
      };
    });
  }

  /**
   * Réinscription pour l'année en cours, sur le dossier existant (lot G4) : même matricule ; notes, bulletins,
   * paiements, factures et historique des années précédentes inchangés. Une inscription de l'année annulée ou
   * terminée par un départ est rétablie (une seule inscription par élève et par année), sans nouvelle facture.
   */
  reenroll(actor: Actor, id: string, dto: ReenrollDto) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const yearId = await this.scope.currentYearId(tx);
      await this.assertHistoryScope(tx, actor, id);
      await this.scope.assertClass(tx, actor, dto.classId);
      const klass = await tx.class.findUnique({
        where: { id: dto.classId },
        include: { academicYear: { select: { label: true } }, _count: { select: { enrollments: { where: { status: 'ACTIVE' } } } } },
      });
      if (!klass || klass.academicYearId !== yearId) throw new BadRequestException("Cette classe n'existe pas pour l'année en cours");
      const student = await tx.student.findUniqueOrThrow({ where: { id }, select: { matricule: true, firstName: true, lastName: true, status: true } });
      const existing = await tx.enrollment.findUnique({ where: { studentId_academicYearId: { studentId: id, academicYearId: yearId } }, include: { class: { select: { name: true } } } });
      if (existing?.status === 'ACTIVE') throw new ConflictException(`${student.firstName} ${student.lastName} est déjà inscrit(e) pour ${klass.academicYear.label} (${existing.class.name})`);
      if (klass.capacity && klass._count.enrollments >= klass.capacity) throw new ConflictException(`La classe ${klass.name} est complète (${klass.capacity} places)`);
      if (dto.applicationId) await this.assertApplication(tx, actor, dto.applicationId, id);

      let enrollmentId: string;
      let invoices = 0;
      if (existing) {
        await tx.enrollment.update({
          where: { id: existing.id },
          data: { status: 'ACTIVE', classId: klass.id, cancelledAt: null, cancelReason: null, cancelledById: null, exitDate: null, exitReason: null },
        });
        await enrollmentEvent(tx, actor, existing.id, 'REINSTATED', {
          previousStatus: existing.status, previousClass: existing.class.name, classId: klass.id, className: klass.name, studentStatusBefore: student.status,
          cancelReason: existing.cancelReason, exitDate: existing.exitDate?.toISOString().slice(0, 10) ?? null, exitReason: existing.exitReason,
        });
        enrollmentId = existing.id;
      } else {
        const previous = await tx.enrollment.findFirst({
          where: { studentId: id }, orderBy: { academicYear: { startDate: 'desc' } },
          select: { class: { select: { name: true } }, academicYear: { select: { label: true } } },
        });
        const e = await tx.enrollment.create({ data: { tenantId: actor.tenantId, studentId: id, classId: klass.id, academicYearId: yearId, type: 'RETURNING' } });
        await enrollmentEvent(tx, actor, e.id, 'REENROLLED', {
          classId: klass.id, className: klass.name, fromYear: previous?.academicYear.label ?? null, fromClass: previous?.class.name ?? null, studentStatusBefore: student.status,
        });
        enrollmentId = e.id;
        if (dto.createInvoices) invoices = await this.finance.invoiceFromCatalog(tx, actor, id, klass.id, true);
      }
      if (student.status !== 'ACTIVE') await tx.student.update({ where: { id }, data: { status: 'ACTIVE' } });
      if (dto.applicationId) await tx.application.update({ where: { id: dto.applicationId }, data: { status: 'INSCRIT', studentId: id } });
      await this.audit.log(tx, actor, existing ? 'student.enrollment_reinstated' : 'student.reenrolled', 'Student', id, {
        matricule: student.matricule, classId: klass.id, enrollmentId, invoices, ...(dto.applicationId ? { applicationId: dto.applicationId } : {}),
      });
      return { id, matricule: student.matricule, enrollmentId, className: klass.name, year: klass.academicYear.label, invoices, reinstated: !!existing };
    });
  }

  /**
   * Annulation de l'inscription de l'année (lot G4), par la direction, avec un motif : saisie par erreur, doublon…
   * L'inscription n'est jamais supprimée ; elle ne compte plus à partir de cette date. Les factures déjà créées ne
   * sont pas annulées automatiquement (aucun remboursement automatique) : la comptabilité les traite.
   */
  cancelEnrollment(actor: Actor, id: string, dto: CancelEnrollmentDto) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const yearId = await this.scope.currentYearId(tx);
      await this.assertHistoryScope(tx, actor, id);
      const e = await tx.enrollment.findUnique({ where: { studentId_academicYearId: { studentId: id, academicYearId: yearId } }, include: { class: { select: { name: true } } } });
      if (!e) throw new BadRequestException("Cet élève n'a pas d'inscription pour l'année en cours");
      if (e.status === 'CANCELLED') throw new ConflictException('Cette inscription est déjà annulée');
      const reason = dto.reason.trim();
      if (reason.length < 5) throw new BadRequestException('Indiquez le motif de l’annulation (5 caractères au moins)');
      await tx.enrollment.update({ where: { id: e.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason, cancelledById: actor.userId } });
      // L'élève retrouve la situation qu'il avait avant cette (ré)inscription (par exemple « Transféré » s'il était parti) ;
      // un nouvel élève inscrit par erreur garde son dossier, sans classe pour l'année.
      const lastStart = await tx.enrollmentEvent.findFirst({ where: { enrollmentId: e.id, kind: { in: ['REENROLLED', 'REINSTATED'] } }, orderBy: { createdAt: 'desc' }, select: { data: true } });
      const before = (lastStart?.data as { studentStatusBefore?: string } | null)?.studentStatusBefore;
      const restore = e.status === 'ACTIVE' && (before === 'TRANSFERRED' || before === 'WITHDRAWN' || before === 'GRADUATED') ? before : null;
      if (restore) await tx.student.update({ where: { id }, data: { status: restore } });
      await enrollmentEvent(tx, actor, e.id, 'CANCELLED', { reason, previousStatus: e.status, className: e.class.name, ...(restore ? { studentStatusRestored: restore } : {}) });
      await this.audit.log(tx, actor, 'student.enrollment_cancelled', 'Student', id, { enrollmentId: e.id, reason });
      return { ok: true };
    });
  }

  /**
   * Doublons possibles (lot G4), pour la direction : paires signalées à l'inscription et en attente, paires repérées
   * parmi les dossiers existants (même règle), et dernières décisions. Rien n'est fusionné ni annulé automatiquement.
   */
  duplicateReviews(actor: Actor) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      // Périmètre : les élèves dont la dernière classe est sur les sites de l'acteur (tous pour une direction générale).
      const visible = await historyStudentIds(tx, actor.siteIds);
      const reviews = await tx.duplicateReview.findMany({ orderBy: { createdAt: 'desc' }, take: 500 });
      const known = new Set(reviews.flatMap((r) => [`${r.studentId}|${r.otherId}`, `${r.otherId}|${r.studentId}`]));
      const suspected = (await suspectedPairs(tx, visible)).filter((p) => !known.has(`${p.studentId}|${p.otherId}`)).slice(0, 200);
      const inScope = (r: { studentId: string; otherId: string }) => !visible || (visible.includes(r.studentId) && visible.includes(r.otherId));
      const kept = reviews.filter(inScope);
      const ids = [...new Set([...kept, ...suspected].flatMap((r) => [r.studentId, r.otherId]))];
      const rows = await tx.student.findMany({
        where: { id: { in: ids } },
        select: {
          id: true, matricule: true, firstName: true, lastName: true, birthDate: true, status: true, createdAt: true,
          enrollments: { orderBy: { academicYear: { startDate: 'desc' } }, take: 1, select: { status: true, class: { select: { name: true } }, academicYear: { select: { label: true } } } },
        },
      });
      const byId = new Map(rows.map(({ enrollments, ...s }) => [s.id, { ...s, lastClass: enrollments[0]?.class.name ?? null, lastYear: enrollments[0]?.academicYear.label ?? null, lastStatus: enrollments[0]?.status ?? null }]));
      const pair = (r: { studentId: string; otherId: string; reason: string }) => ({
        reason: r.reason, reasonLabel: DUPLICATE_REASON_LABELS[r.reason as DuplicateReason] ?? r.reason, student: byId.get(r.studentId), other: byId.get(r.otherId),
      });
      return {
        pending: [
          ...kept.filter((r) => r.status === 'PENDING').map((r) => ({ id: r.id, ...pair(r), note: r.note, signalledAt: r.createdAt })),
          ...suspected.map((p) => ({ id: null, ...pair(p), note: null, signalledAt: null })),
        ],
        decided: kept.filter((r) => r.status !== 'PENDING').slice(0, 50).map((r) => ({ id: r.id, ...pair(r), status: r.status, decisionNote: r.decisionNote, decidedAt: r.decidedAt })),
      };
    });
  }

  /** Décision de la direction sur deux dossiers qui se ressemblent : élèves différents, ou même élève (lot G4). */
  decideDuplicate(actor: Actor, dto: DuplicateDecisionDto) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      if (dto.studentId === dto.otherId) throw new BadRequestException('Choisissez deux dossiers différents');
      await this.assertHistoryScope(tx, actor, dto.studentId);
      await this.assertHistoryScope(tx, actor, dto.otherId);
      const both = await tx.student.findMany({
        where: { id: { in: [dto.studentId, dto.otherId] } },
        select: { id: true, matricule: true, firstName: true, lastName: true, birthDate: true, createdAt: true, guardians: { select: { guardian: { select: { phone: true } } } } },
      });
      if (both.length !== 2) throw new NotFoundException('Élève introuvable');
      // Le dossier le plus récent d'abord, comme à la détection.
      const [a, b] = both.sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime() || y.id.localeCompare(x.id));
      if (nameKey(a.firstName, a.lastName) !== nameKey(b.firstName, b.lastName)) throw new BadRequestException('Ces deux dossiers ne portent pas le même nom');
      const sameBirth = !!a.birthDate && !!b.birthDate && a.birthDate.getTime() === b.birthDate.getTime();
      const phones = new Set(a.guardians.map((g) => g.guardian.phone));
      const sharedPhone = b.guardians.some((g) => phones.has(g.guardian.phone));
      if (!sameBirth && !sharedPhone) throw new BadRequestException('Ces deux dossiers ne se ressemblent pas assez pour être un doublon');
      const existing = await tx.duplicateReview.findFirst({ where: { OR: [{ studentId: a.id, otherId: b.id }, { studentId: b.id, otherId: a.id }] } });
      const data = { status: dto.decision, decidedById: actor.userId, decidedAt: new Date(), decisionNote: dto.note?.trim() || null };
      const r = existing
        ? await tx.duplicateReview.update({ where: { id: existing.id }, data })
        : await tx.duplicateReview.create({ data: { tenantId: actor.tenantId, studentId: a.id, otherId: b.id, reason: sameBirth ? 'NOM_NAISSANCE' : 'NOM_TELEPHONE', ...data } });
      await this.audit.log(tx, actor, 'student.duplicate_decided', 'Student', a.id, { otherId: b.id, decision: dto.decision, matricules: [a.matricule, b.matricule], note: data.decisionNote });
      return { id: r.id, status: r.status };
    });
  }
}
