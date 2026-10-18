import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomInt } from 'crypto';
import { Actor } from '../../common/auth';
import { AuditService } from '../../common/audit.service';
import { PrismaService, Tx } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { normalizePhone, toDate } from '../../common/util';
import { hashPassword } from '../auth/auth.service';
import { createSmsProvider } from '../notifications/sms.provider';
import { config } from '../../config';
import {
  AcademicYearDto, AssignmentDto, ClassDto, ClassSubjectDto, LevelDto, RoomDto, SiteDto, StaffDto,
  StaffUpdateDto, SubjectDto, TrackDto,
} from './settings.dto';

/** Valeurs par défaut des paramètres d'établissement. Les seuils viennent de l'exemple du CDC §3.3, à confirmer par l'école. */
export const DEFAULT_SETTINGS = {
  grading: {
    distinctions: [
      { min: 16, label: 'Félicitations' },
      { min: 14, label: 'Encouragements' },
      { min: 12, label: "Tableau d'honneur" },
    ],
    /// 'exclude' : une note manquante est ignorée ; 'zero' : comptée 0 (CDC §3.3).
    missingGrade: 'exclude',
  },
  /// Bloquer l'accès au bulletin en ligne en cas d'impayé (option CDC §3.3), désactivé par défaut.
  blockReportCardIfUnpaid: false,
  notifications: { absenceSms: true },
};

export function tenantSettings(raw: unknown): typeof DEFAULT_SETTINGS {
  const s = (raw ?? {}) as any;
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    grading: { ...DEFAULT_SETTINGS.grading, ...(s.grading ?? {}) },
    notifications: { ...DEFAULT_SETTINGS.notifications, ...(s.notifications ?? {}) },
  };
}

/** Mot de passe provisoire lisible, à changer à la première connexion. */
export function temporaryPassword() {
  const words = ['Kisito', 'Togbin', 'Hedomey', 'Ecole', 'Savoir', 'Reussir'];
  return `${words[randomInt(words.length)]}${randomInt(1000, 10000)}`;
}

function uniqueViolation(e: unknown, message: string): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException(message);
  throw e;
}

@Injectable()
export class SettingsService {
  private sms = createSmsProvider(config.smsProvider);
  constructor(private db: PrismaService, private audit: AuditService, private scope: ScopeService) {}

  /** Référentiel complet pour les écrans de paramétrage et les listes déroulantes. */
  overview(actor: Actor) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const year = await tx.academicYear.findFirst({ where: { isCurrent: true }, include: { terms: { orderBy: { position: 'asc' } } } });
      const [sites, years, levels, tracks, rooms, subjects, tenant] = await Promise.all([
        tx.site.findMany({ orderBy: { name: 'asc' } }),
        tx.academicYear.findMany({ orderBy: { startDate: 'desc' }, include: { terms: { orderBy: { position: 'asc' } } } }),
        tx.level.findMany({ orderBy: { position: 'asc' } }),
        tx.track.findMany({ orderBy: { name: 'asc' } }),
        tx.room.findMany({ orderBy: { name: 'asc' } }),
        tx.subject.findMany({ orderBy: { name: 'asc' } }),
        tx.tenant.findUniqueOrThrow({ where: { id: actor.tenantId } }),
      ]);
      return { tenant: { id: tenant.id, name: tenant.name, settings: tenantSettings(tenant.settings) }, currentYear: year, sites, years, levels, tracks, rooms, subjects };
    });
  }

  updateTenantSettings(actor: Actor, settings: Record<string, unknown>) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const t = await tx.tenant.findUniqueOrThrow({ where: { id: actor.tenantId } });
      const merged = tenantSettings({ ...(t.settings as object), ...settings });
      await tx.tenant.update({ where: { id: t.id }, data: { settings: merged as any } });
      await this.audit.log(tx, actor, 'settings.updated', 'Tenant', t.id, settings);
      return merged;
    });
  }

  // ------------------------------------------------------------ Sites
  createSite(actor: Actor, dto: SiteDto) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const site = await tx.site.create({ data: { ...dto, tenantId: actor.tenantId } }).catch((e) => uniqueViolation(e, 'Un site porte déjà ce nom'));
      await this.audit.log(tx, actor, 'site.created', 'Site', site.id, dto);
      return site;
    });
  }

  updateSite(actor: Actor, id: string, dto: Partial<SiteDto>) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const site = await tx.site.update({ where: { id }, data: dto });
      await this.audit.log(tx, actor, 'site.updated', 'Site', id, dto);
      return site;
    });
  }

  // ------------------------------------------------------------ Années et périodes
  createYear(actor: Actor, dto: AcademicYearDto) {
    if (!dto.terms.length) throw new BadRequestException('Ajoutez au moins une période (trimestre ou semestre)');
    return this.db.forTenant(actor.tenantId, async (tx) => {
      if (dto.isCurrent) await tx.academicYear.updateMany({ data: { isCurrent: false } });
      const year = await tx.academicYear
        .create({
          data: {
            tenantId: actor.tenantId, label: dto.label, startDate: toDate(dto.startDate), endDate: toDate(dto.endDate), isCurrent: !!dto.isCurrent,
            terms: { create: dto.terms.map((t, i) => ({ tenantId: actor.tenantId, name: t.name, position: i + 1, weight: t.weight ?? 1, startDate: toDate(t.startDate), endDate: toDate(t.endDate) })) },
          },
          include: { terms: true },
        })
        .catch((e) => uniqueViolation(e, 'Cette année scolaire existe déjà'));
      await this.audit.log(tx, actor, 'year.created', 'AcademicYear', year.id, { label: dto.label });
      return year;
    });
  }

  setCurrentYear(actor: Actor, id: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      await tx.academicYear.updateMany({ data: { isCurrent: false } });
      const y = await tx.academicYear.update({ where: { id }, data: { isCurrent: true } });
      await this.audit.log(tx, actor, 'year.current', 'AcademicYear', id);
      return y;
    });
  }

  // ------------------------------------------------------------ Référentiels simples
  createLevel(actor: Actor, dto: LevelDto) {
    return this.simpleCreate(actor, 'level', dto, 'Ce niveau existe déjà');
  }
  createTrack(actor: Actor, dto: TrackDto) {
    return this.simpleCreate(actor, 'track', dto, 'Ce code de filière existe déjà');
  }
  createRoom(actor: Actor, dto: RoomDto) {
    return this.simpleCreate(actor, 'room', dto, 'Cette salle existe déjà sur ce site');
  }
  createSubject(actor: Actor, dto: SubjectDto) {
    return this.simpleCreate(actor, 'subject', dto, 'Ce code de matière existe déjà');
  }

  private simpleCreate(actor: Actor, model: 'level' | 'track' | 'room' | 'subject', dto: object, conflict: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const row = await (tx[model] as any).create({ data: { ...dto, tenantId: actor.tenantId } }).catch((e: unknown) => uniqueViolation(e, conflict));
      await this.audit.log(tx, actor, `${model}.created`, model, row.id, dto);
      return row;
    });
  }

  // ------------------------------------------------------------ Classes
  listClasses(actor: Actor, yearId?: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const year = yearId ?? (await this.scope.currentYearId(tx));
      const visible = await this.scope.classIds(tx, actor);
      const classes = await tx.class.findMany({
        where: { academicYearId: year, ...(visible ? { id: { in: visible } } : {}) },
        include: {
          site: { select: { id: true, name: true } },
          level: { select: { id: true, name: true, position: true } },
          track: { select: { id: true, code: true, name: true } },
          headTeacher: { select: { id: true, firstName: true, lastName: true } },
          _count: { select: { enrollments: { where: { status: 'ACTIVE' } } } },
          subjects: {
            include: {
              subject: true,
              assignments: { include: { teacher: { select: { id: true, firstName: true, lastName: true } } } },
            },
            orderBy: { subject: { name: 'asc' } },
          },
        },
        orderBy: [{ level: { position: 'asc' } }, { name: 'asc' }],
      });
      return classes.map(({ _count, ...c }) => ({ ...c, studentCount: _count.enrollments }));
    });
  }

  createClass(actor: Actor, dto: ClassDto) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const academicYearId = await this.scope.currentYearId(tx);
      const c = await tx.class
        .create({ data: { ...dto, tenantId: actor.tenantId, academicYearId } })
        .catch((e) => uniqueViolation(e, 'Une classe porte déjà ce nom cette année'));
      await this.audit.log(tx, actor, 'class.created', 'Class', c.id, dto);
      return c;
    });
  }

  updateClass(actor: Actor, id: string, dto: Partial<ClassDto>) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const c = await tx.class.update({ where: { id }, data: dto });
      await this.audit.log(tx, actor, 'class.updated', 'Class', id, dto);
      return c;
    });
  }

  /** Ajoute une matière à une classe ou modifie son coefficient. */
  upsertClassSubject(actor: Actor, classId: string, dto: ClassSubjectDto) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const cs = await tx.classSubject.upsert({
        where: { classId_subjectId: { classId, subjectId: dto.subjectId } },
        create: { tenantId: actor.tenantId, classId, subjectId: dto.subjectId, coefficient: dto.coefficient },
        update: { coefficient: dto.coefficient },
      });
      await this.audit.log(tx, actor, 'class_subject.upserted', 'ClassSubject', cs.id, dto);
      return cs;
    });
  }

  removeClassSubject(actor: Actor, id: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const used = await tx.assessment.count({ where: { classSubjectId: id } });
      if (used) throw new ConflictException('Des évaluations existent déjà pour cette matière : elle ne peut plus être retirée');
      await tx.classSubject.delete({ where: { id } });
      await this.audit.log(tx, actor, 'class_subject.removed', 'ClassSubject', id);
      return { ok: true };
    });
  }

  // ------------------------------------------------------------ Affectations
  assign(actor: Actor, dto: AssignmentDto) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const teacher = await tx.userRole.findFirst({ where: { userId: dto.teacherId, role: 'ENSEIGNANT' } });
      if (!teacher) throw new BadRequestException("Cette personne n'a pas le rôle Enseignant");
      const a = await tx.teacherAssignment
        .create({ data: { tenantId: actor.tenantId, ...dto } })
        .catch((e) => uniqueViolation(e, 'Cet enseignant est déjà affecté à cette matière'));
      await this.audit.log(tx, actor, 'assignment.created', 'TeacherAssignment', a.id, dto);
      return a;
    });
  }

  unassign(actor: Actor, id: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      await tx.teacherAssignment.delete({ where: { id } });
      await this.audit.log(tx, actor, 'assignment.removed', 'TeacherAssignment', id);
      return { ok: true };
    });
  }

  // ------------------------------------------------------------ Personnel et comptes
  listStaff(actor: Actor) {
    return this.db.forTenant(actor.tenantId, (tx) =>
      tx.user.findMany({
        where: { roles: { some: { role: { in: ['DIRECTION', 'SECRETARIAT', 'ENSEIGNANT', 'VIE_SCOLAIRE', 'COMPTABLE'] } } } },
        select: {
          id: true, firstName: true, lastName: true, phone: true, email: true, status: true, lastLoginAt: true, totpEnabled: true,
          roles: { select: { role: true, siteId: true } },
          assignments: { select: { id: true, classSubject: { select: { id: true, coefficient: true, subject: { select: { name: true } }, class: { select: { id: true, name: true } } } } } },
        },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      }),
    );
  }

  createStaff(actor: Actor, dto: StaffDto) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const password = temporaryPassword();
      const phone = normalizePhone(dto.phone);
      const user = await tx.user
        .create({
          data: {
            tenantId: actor.tenantId, firstName: dto.firstName, lastName: dto.lastName, phone, email: dto.email?.toLowerCase(),
            passwordHash: await hashPassword(password), mustChangePassword: true,
            roles: { create: dto.roles.map((r) => ({ tenantId: actor.tenantId, role: r.role, siteId: r.siteId ?? null })) },
          },
        })
        .catch((e) => uniqueViolation(e, 'Un compte existe déjà avec ce téléphone ou cet e-mail'));
      await this.audit.log(tx, actor, 'user.created', 'User', user.id, { roles: dto.roles });
      await this.sendCredentials(tx, actor, phone, password);
      return { id: user.id, temporaryPassword: password };
    });
  }

  updateStaff(actor: Actor, id: string, dto: StaffUpdateDto) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const data: Prisma.UserUpdateInput = {
        firstName: dto.firstName, lastName: dto.lastName, email: dto.email?.toLowerCase(),
        phone: dto.phone ? normalizePhone(dto.phone) : undefined,
        status: dto.active === undefined ? undefined : dto.active ? 'ACTIVE' : 'DISABLED',
      };
      await tx.user.update({ where: { id }, data }).catch((e) => uniqueViolation(e, 'Ce téléphone ou cet e-mail est déjà utilisé'));
      if (dto.roles) {
        if (id === actor.userId && !dto.roles.some((r) => r.role === 'DIRECTION')) {
          throw new BadRequestException('Vous ne pouvez pas retirer votre propre rôle Direction');
        }
        await tx.userRole.deleteMany({ where: { userId: id, role: { notIn: ['PARENT', 'ELEVE'] } } });
        await tx.userRole.createMany({ data: dto.roles.map((r) => ({ tenantId: actor.tenantId, userId: id, role: r.role, siteId: r.siteId ?? null })), skipDuplicates: true });
      }
      if (dto.active === false || dto.roles) {
        await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      }
      await this.audit.log(tx, actor, dto.roles ? 'user.roles_changed' : 'user.updated', 'User', id, dto);
      return { ok: true };
    });
  }

  resetPassword(actor: Actor, id: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const password = temporaryPassword();
      const user = await tx.user.update({ where: { id }, data: { passwordHash: await hashPassword(password), mustChangePassword: true, failedLogins: 0, lockedUntil: null } });
      await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.log(tx, actor, 'user.password_reset_by_admin', 'User', id);
      if (user.phone) await this.sendCredentials(tx, actor, user.phone, password);
      return { temporaryPassword: password };
    });
  }

  async sendCredentials(tx: Tx, actor: Actor, phone: string, password: string) {
    const tenant = await tx.tenant.findUnique({ where: { id: actor.tenantId } });
    if (!tenant) throw new NotFoundException();
    await this.sms.send(phone, `${tenant.shortName ?? tenant.name} : votre compte est prêt. Identifiant : ${phone}. Mot de passe provisoire : ${password}. Connectez-vous sur ${config.webOrigin}/connexion`);
  }
}
