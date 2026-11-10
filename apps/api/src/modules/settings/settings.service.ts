import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomInt } from 'crypto';
import { Actor, forgetSessions } from '../../common/auth';
import { can } from '../../common/permissions';
import { AuditService, auditChanges } from '../../common/audit.service';
import { PrismaService, Tx } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { assertOwned } from '../../common/ownership';
import { toDate } from '../../common/util';
import { country, schoolOperators, tenantPhone } from '../../common/country';
import { hashPassword } from '../auth/auth.service';
import { createSmsProvider, sendQuietly } from '../notifications/sms.provider';
import { FilesService } from '../files/files.service';
import { config, tenantOrigin } from '../../config';
import {
  AcademicYearDto, AcademicYearUpdateDto, AssignmentDto, BulkCoefficientDto, ClassDto, ClassSubjectDto, LevelDto, RoomDto, SiteDto, StaffDto,
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
    /// Moyenne annuelle minimale pour passer en classe supérieure, saisie par l'école. Vide : aucune décision proposée automatiquement.
    passMark: null as number | null,
  },
  /// Bloquer l'accès au bulletin en ligne en cas d'impayé (option CDC §3.3), désactivé par défaut.
  blockReportCardIfUnpaid: false,
  /// SMS aux familles. absenceSms : à chaque absence à l'appel ; paymentSms : à chaque paiement encaissé ;
  /// smsAlways : SMS même si le parent a vu la notification dans l'application (sinon SMS seulement si non lue après 10 min).
  notifications: { absenceSms: true, paymentSms: true, smsAlways: true },
  /// Identité officielle imprimée sur les documents : saisie par la direction, jamais pré-remplie.
  identity: {
    authorization: '',
    legalMentions: '',
    headName: '',
    headTitle: 'Le chef d’établissement',
    phone: '',
    email: '',
    address: '',
    signatureKey: null as string | null,
    stampKey: null as string | null,
  },
  /// Image de l'école sur le site public et les documents : logo envoyé par la direction et couleur principale.
  branding: {
    logoKey: null as string | null,
    /// Logo fourni avec l'installation (fichier statique), utilisé tant qu'aucun logo n'a été envoyé.
    logoUrl: null as string | null,
    primaryColor: null as string | null,
  },
};

export type SchoolIdentity = ReturnType<typeof schoolIdentity>;

export function tenantSettings(raw: unknown): typeof DEFAULT_SETTINGS {
  const s = (raw ?? {}) as any;
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    grading: { ...DEFAULT_SETTINGS.grading, ...(s.grading ?? {}) },
    notifications: { ...DEFAULT_SETTINGS.notifications, ...(s.notifications ?? {}) },
    identity: { ...DEFAULT_SETTINGS.identity, ...(s.authorization ? { authorization: s.authorization } : {}), ...(s.identity ?? {}) },
    branding: { ...DEFAULT_SETTINGS.branding, ...(s.branding ?? {}) },
  };
}

/** Adresse publique de la photo d'un site ; la fin de la clé change à chaque envoi, ce qui renouvelle le cache. */
export const sitePhotoUrl = (slug: string, id: string, key: string) => `/api/v1/public/${slug}/sites/${id}/photo?v=${key.split('/').pop()!.slice(0, 8)}`;

/** Adresse publique du logo : celui envoyé par la direction, sinon celui de l'installation, sinon aucun. */
export function logoUrl(tenant: { slug?: string; settings: unknown }) {
  const b = tenantSettings(tenant.settings).branding;
  if (b.logoKey && tenant.slug) return `/api/v1/public/${tenant.slug}/logo?v=${b.logoKey.split('/').pop()!.slice(0, 8)}`;
  return b.logoUrl || null;
}

/** En-tête et signataire des documents officiels (bulletins, reçus, attestations). */
export function schoolIdentity(tenant: { name: string; slug?: string; settings: unknown }, files: FilesService) {
  const s = tenantSettings(tenant.settings);
  const id = s.identity;
  const pub = ((s as any).public ?? {}) as { phone?: string; slogan?: string };
  return {
    name: tenant.name,
    authorization: id.authorization || null,
    legalMentions: id.legalMentions || null,
    headName: id.headName || null,
    headTitle: id.headTitle || DEFAULT_SETTINGS.identity.headTitle,
    phone: id.phone || pub.phone || null,
    email: id.email || null,
    address: id.address || null,
    slogan: pub.slogan ?? null,
    signatureUrl: id.signatureKey ? files.signedUrl(id.signatureKey, 3600) : null,
    stampUrl: id.stampKey ? files.signedUrl(id.stampKey, 3600) : null,
    logoUrl: logoUrl(tenant),
    primaryColor: s.branding.primaryColor,
  };
}

/** Mot de passe provisoire lisible, à changer à la première connexion. */
/**
 * Mot de passe provisoire (SEC-023) : 10 caractères tirés au hasard, au moins une lettre et un chiffre,
 * sans caractères faciles à confondre dans un SMS (0/O, 1/l/I). Environ 10^17 possibilités.
 */
const TEMP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
export function temporaryPassword() {
  for (;;) {
    let pw = '';
    for (let i = 0; i < 10; i++) pw += TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)];
    if (/[a-zA-Z]/.test(pw) && /\d/.test(pw)) return pw;
  }
}

/** Textes du site public : chaînes et listes courtes uniquement ; les images restent celles fournies avec l'installation. */
function publicTexts(raw: unknown, current: Record<string, unknown> = {}) {
  const r = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => str(x, 160)).filter(Boolean).slice(0, 10) : undefined);
  return {
    heroImage: current.heroImage, trackImages: current.trackImages,
    slogan: str(r.slogan, 120), tagline: str(r.tagline, 160), phone: str(r.phone, 40), motto: str(r.motto, 160),
    /// Examen préparé au collège (BEPC ou autre selon le pays), affiché sur la page d'accueil ; vide = aucun nom d'examen.
    collegeExam: str(r.collegeExam, 40),
    rentree: typeof r.rentree === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.rentree) ? r.rentree : undefined,
    highlights: list(r.highlights), reasons: list(r.reasons),
    entranceTest: typeof r.entranceTest === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.entranceTest) ? r.entranceTest : undefined,
    requiredDocuments: Array.isArray(r.requiredDocuments) ? r.requiredDocuments.map((x) => str(x, 200)).filter(Boolean).slice(0, 15) : undefined,
  };
}

function uniqueViolation(e: unknown, message: string): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException(message);
  throw e;
}

@Injectable()
export class SettingsService {
  private sms = createSmsProvider(config.smsProvider);
  constructor(private db: PrismaService, private audit: AuditService, private scope: ScopeService, private files: FilesService) {}

  /** Référentiel complet pour les écrans de paramétrage et les listes déroulantes. */
  overview(actor: Actor) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const actorSlug = (await tx.tenant.findUniqueOrThrow({ where: { id: actor.tenantId }, select: { slug: true } })).slug;
      const year = await tx.academicYear.findFirst({ where: { isCurrent: true }, include: { terms: { orderBy: { position: 'asc' } } } });
      const [sites, years, levels, tracks, rooms, subjects, tenant] = await Promise.all([
        tx.site.findMany({ orderBy: { name: 'asc' } }).then((rows) => rows.map(({ photoKey, ...x }) => ({ ...x, photoUrl: photoKey ? sitePhotoUrl(actorSlug, x.id, photoKey) : null }))),
        tx.academicYear.findMany({ orderBy: { startDate: 'desc' }, include: { terms: { orderBy: { position: 'asc' } } } }),
        tx.level.findMany({ orderBy: { position: 'asc' } }),
        tx.track.findMany({ orderBy: { name: 'asc' } }),
        tx.room.findMany({ orderBy: { name: 'asc' } }),
        tx.subject.findMany({ orderBy: { name: 'asc' } }),
        tx.tenant.findUniqueOrThrow({ where: { id: actor.tenantId } }),
      ]);
      // SEC-017 : la signature et le cachet (liens et clés de stockage) ne vont qu'à qui gère le paramétrage ;
      // les documents imprimés les reçoivent par leur propre route.
      const settings = tenantSettings(tenant.settings);
      const identity = schoolIdentity(tenant, this.files);
      if (!can(actor.role, 'settings.manage')) {
        settings.identity = { ...settings.identity, signatureKey: null, stampKey: null } as typeof settings.identity;
        Object.assign(identity, { signatureUrl: null, stampUrl: null });
      }
      return {
        tenant: {
          id: tenant.id, name: tenant.name, shortName: tenant.shortName, settings, identity,
          country: tenant.country, countryName: country(tenant.country).name, currency: tenant.currency, timezone: tenant.timezone,
          operators: schoolOperators(tenant), einvoice: country(tenant.country).einvoice,
        },
        currentYear: year, sites, years, levels, tracks, rooms, subjects,
      };
    });
  }

  updateTenantSettings(actor: Actor, settings: Record<string, unknown>, names: { name?: string; shortName?: string } = {}) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const t = await tx.tenant.findUniqueOrThrow({ where: { id: actor.tenantId } });
      const current = tenantSettings(t.settings);
      // La signature et le cachet ne changent que par leur envoi de fichier dédié.
      const incoming: Record<string, unknown> = settings.identity
        ? { ...settings, identity: { ...current.identity, ...(settings.identity as object), signatureKey: current.identity.signatureKey, stampKey: current.identity.stampKey } }
        : { ...settings };
      if (incoming.grading) {
        const g = incoming.grading as { passMark?: unknown };
        const mark = g.passMark === '' || g.passMark === undefined || g.passMark === null ? null : Number(g.passMark);
        if (mark !== null && !(mark >= 0 && mark <= 20)) throw new BadRequestException('Le seuil de passage va de 0 à 20');
        incoming.grading = { ...current.grading, ...(incoming.grading as object), passMark: mark };
      }
      // Le logo ne change que par son envoi de fichier ; la couleur doit être une couleur hexadécimale.
      if (incoming.branding) {
        const b = incoming.branding as { primaryColor?: unknown };
        const color = typeof b.primaryColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(b.primaryColor) ? b.primaryColor : null;
        incoming.branding = { ...current.branding, primaryColor: color };
      }
      // Opérateurs Mobile Money proposés aux parents, saisis par la direction (les noms seulement).
      if (incoming.payments) {
        const ops = (incoming.payments as { operators?: unknown }).operators;
        if (!Array.isArray(ops)) throw new BadRequestException('Liste des opérateurs invalide');
        const operators = [...new Set(ops.map((x) => (typeof x === 'string' ? x.trim().slice(0, 40) : '')).filter(Boolean))].slice(0, 10);
        incoming.payments = { operators };
      }
      if (incoming.notifications) {
        const n = incoming.notifications as Record<string, unknown>;
        const pick = (k: 'absenceSms' | 'paymentSms' | 'smsAlways') => (typeof n[k] === 'boolean' ? (n[k] as boolean) : current.notifications[k]);
        incoming.notifications = { absenceSms: pick('absenceSms'), paymentSms: pick('paymentSms'), smsAlways: pick('smsAlways') };
      }
      if ('demo' in incoming) delete incoming.demo;
      // Le nom d'expéditeur SMS est enregistré chez le fournisseur : seul le Super Admin le change.
      if ('smsSender' in incoming) delete incoming.smsSender;
      if (incoming.public) incoming.public = publicTexts(incoming.public, (current as any).public);
      const merged = tenantSettings({ ...(t.settings as object), ...incoming });
      const rename = {
        ...(names.name?.trim() ? { name: names.name.trim() } : {}),
        ...(names.shortName !== undefined ? { shortName: names.shortName.trim() || null } : {}),
      };
      await tx.tenant.update({ where: { id: t.id }, data: { settings: merged as any, ...rename } });
      // SEC-033 : ancienne et nouvelle valeur des seules rubriques modifiées.
      await this.audit.log(tx, actor, 'settings.updated', 'Tenant', t.id, {
        ...auditChanges(t.settings as Record<string, unknown>, merged as Record<string, unknown>, Object.keys(incoming)),
        ...auditChanges(t, rename),
      });
      return merged;
    });
  }

  /** Signature, cachet (imprimés sur les documents officiels) ou logo de l'école. */
  async setIdentityImage(actor: Actor, kind: 'signature' | 'stamp' | 'logo', file?: { buffer: Buffer; mimetype: string; size: number }) {
    if (file && !file.mimetype.startsWith('image/')) throw new BadRequestException('Envoyez une image (PNG, JPEG ou WebP)');
    const key = file ? await this.files.save(actor.tenantId, 'etablissement', file) : null;
    return this.files.commit(key, () => this.db.forTenant(actor.tenantId, async (tx) => {
      const t = await tx.tenant.findUniqueOrThrow({ where: { id: actor.tenantId } });
      const current = tenantSettings(t.settings);
      const previous = kind === 'logo' ? current.branding.logoKey : kind === 'signature' ? current.identity.signatureKey : current.identity.stampKey;
      const next = kind === 'logo'
        ? { ...current, branding: { ...current.branding, logoKey: key } }
        : { ...current, identity: { ...current.identity, [kind === 'signature' ? 'signatureKey' : 'stampKey']: key } };
      await tx.tenant.update({ where: { id: t.id }, data: { settings: next as any } });
      await this.audit.log(tx, actor, file ? `identity.${kind}.set` : `identity.${kind}.removed`, 'Tenant', t.id);
      return { result: schoolIdentity({ name: t.name, slug: t.slug, settings: next }, this.files), old: [previous] };
    }));
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
      const before = await tx.site.findUniqueOrThrow({ where: { id } });
      const site = await tx.site.update({ where: { id }, data: dto });
      await this.audit.log(tx, actor, 'site.updated', 'Site', id, auditChanges(before, site, Object.keys(dto)));
      return site;
    });
  }

  async setSitePhoto(actor: Actor, id: string, file?: { buffer: Buffer; mimetype: string; size: number }) {
    if (file && !file.mimetype.startsWith('image/')) throw new BadRequestException('Envoyez une photo (JPEG, PNG ou WebP)');
    const photoKey = file ? await this.files.save(actor.tenantId, 'sites', file) : null;
    return this.files.commit(photoKey, () => this.db.forTenant(actor.tenantId, async (tx) => {
      const prev = await tx.site.findUnique({ where: { id }, select: { photoKey: true } });
      if (!prev) throw new NotFoundException('Site introuvable');
      const site = await tx.site.update({ where: { id }, data: { photoKey } });
      await this.audit.log(tx, actor, file ? 'site.photo_set' : 'site.photo_removed', 'Site', id);
      return { result: { id: site.id, hasPhoto: !!site.photoKey }, old: [prev.photoKey] };
    }));
  }

  /** Photo d'un site pour la page d'accueil publique : seulement un site actif d'une école active. */
  async publicSitePhoto(slug: string, id: string) {
    const t = await this.db.tenant.findUnique({ where: { slug } });
    if (!t || t.status === 'SUSPENDED') throw new NotFoundException();
    const site = await this.db.forTenant(t.id, (tx) => tx.site.findUnique({ where: { id } }));
    if (!site?.photoKey || !site.active) throw new NotFoundException('Aucune photo');
    return this.files.readKey(site.photoKey);
  }

  // ------------------------------------------------------------ Années et périodes
  createYear(actor: Actor, dto: AcademicYearDto) {
    if (!dto.terms.length) throw new BadRequestException('Ajoutez au moins une période (trimestre ou semestre)');
    return this.db.forTenant(actor.tenantId, async (tx) => {
      // La première année d'une nouvelle école devient l'année en cours.
      const isCurrent = !!dto.isCurrent || !(await tx.academicYear.findFirst({ where: { isCurrent: true }, select: { id: true } }));
      if (isCurrent) await tx.academicYear.updateMany({ data: { isCurrent: false } });
      const year = await tx.academicYear
        .create({
          data: {
            tenantId: actor.tenantId, label: dto.label, startDate: toDate(dto.startDate), endDate: toDate(dto.endDate), isCurrent,
            terms: { create: dto.terms.map((t, i) => ({ tenantId: actor.tenantId, name: t.name, position: i + 1, weight: t.weight ?? 1, startDate: toDate(t.startDate), endDate: toDate(t.endDate) })) },
          },
          include: { terms: true },
        })
        .catch((e) => uniqueViolation(e, 'Cette année scolaire existe déjà'));
      await this.audit.log(tx, actor, 'year.created', 'AcademicYear', year.id, { label: dto.label });
      return year;
    });
  }

  /** Dates de rentrée et de fin d'année, et périodes (nom, dates, poids dans la moyenne annuelle), modifiables à tout moment. */
  updateYear(actor: Actor, id: string, dto: AcademicYearUpdateDto) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const year = await tx.academicYear.findUniqueOrThrow({ where: { id }, include: { terms: { orderBy: { position: 'asc' } } } });
      const start = dto.startDate ? toDate(dto.startDate) : year.startDate;
      const end = dto.endDate ? toDate(dto.endDate) : year.endDate;
      if (start >= end) throw new BadRequestException("La fin d'année doit venir après la rentrée");
      const terms = year.terms.map((t) => {
        const u = dto.terms?.find((x) => x.id === t.id);
        return { ...t, name: u?.name?.trim() || t.name, startDate: u?.startDate ? toDate(u.startDate) : t.startDate, endDate: u?.endDate ? toDate(u.endDate) : t.endDate, weight: u?.weight ?? Number(t.weight) };
      });
      if (dto.terms?.some((x) => !year.terms.some((t) => t.id === x.id))) throw new BadRequestException("Une période n'appartient pas à cette année");
      terms.forEach((t, i) => {
        if (t.startDate > t.endDate) throw new BadRequestException(`${t.name} : la fin doit venir après le début`);
        if (t.startDate < start || t.endDate > end) throw new BadRequestException(`${t.name} doit être comprise entre la rentrée et la fin d'année`);
        if (i > 0 && t.startDate <= terms[i - 1].endDate) throw new BadRequestException(`${t.name} commence avant la fin de ${terms[i - 1].name}`);
      });
      await tx.academicYear.update({ where: { id }, data: { label: dto.label?.trim() || undefined, startDate: start, endDate: end } }).catch((e) => uniqueViolation(e, 'Cette année scolaire existe déjà'));
      for (const t of terms) await tx.term.update({ where: { id: t.id }, data: { name: t.name, startDate: t.startDate, endDate: t.endDate, weight: t.weight } });
      await this.audit.log(tx, actor, 'year.updated', 'AcademicYear', id, dto);
      return tx.academicYear.findUniqueOrThrow({ where: { id }, include: { terms: { orderBy: { position: 'asc' } } } });
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

  updateLevel(actor: Actor, id: string, dto: Partial<LevelDto>) {
    return this.simpleUpdate(actor, 'level', id, dto, 'Ce niveau existe déjà');
  }
  updateTrack(actor: Actor, id: string, dto: Partial<TrackDto>) {
    return this.simpleUpdate(actor, 'track', id, dto, 'Ce code de filière existe déjà');
  }
  updateRoom(actor: Actor, id: string, dto: Partial<RoomDto>) {
    return this.simpleUpdate(actor, 'room', id, dto, 'Cette salle existe déjà sur ce site');
  }
  updateSubject(actor: Actor, id: string, dto: Partial<SubjectDto>) {
    return this.simpleUpdate(actor, 'subject', id, dto, 'Ce code de matière existe déjà');
  }

  /** Une salle n'est supprimée que si aucun cours n'y est prévu. */
  removeRoom(actor: Actor, id: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const used = await tx.timetableSlot.count({ where: { roomId: id } });
      if (used) throw new ConflictException(`Cette salle est utilisée par ${used} cours de l’emploi du temps : retirez-les d’abord`);
      await tx.room.delete({ where: { id } });
      await this.audit.log(tx, actor, 'room.removed', 'room', id);
      return { ok: true };
    });
  }

  private simpleUpdate(actor: Actor, model: 'level' | 'track' | 'room' | 'subject', id: string, dto: object, conflict: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      await assertOwned(tx, { site: (dto as { siteId?: string }).siteId });
      const before = await (tx[model] as any).findUnique({ where: { id } });
      const row = await (tx[model] as any).update({ where: { id }, data: dto }).catch((e: unknown) => uniqueViolation(e, conflict));
      await this.audit.log(tx, actor, `${model}.updated`, model, id, auditChanges(before, row, Object.keys(dto)));
      return row;
    });
  }

  private simpleCreate(actor: Actor, model: 'level' | 'track' | 'room' | 'subject', dto: object, conflict: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      await assertOwned(tx, { site: (dto as { siteId?: string }).siteId });
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
      await assertOwned(tx, { site: dto.siteId, level: dto.levelId, track: dto.trackId, user: dto.headTeacherId });
      const c = await tx.class
        .create({ data: { ...dto, tenantId: actor.tenantId, academicYearId } })
        .catch((e) => uniqueViolation(e, 'Une classe porte déjà ce nom cette année'));
      await this.audit.log(tx, actor, 'class.created', 'Class', c.id, dto);
      return c;
    });
  }

  updateClass(actor: Actor, id: string, dto: Partial<ClassDto>) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      await assertOwned(tx, { site: dto.siteId, level: dto.levelId, track: dto.trackId, user: dto.headTeacherId });
      const before = await tx.class.findUniqueOrThrow({ where: { id } });
      const c = await tx.class.update({ where: { id }, data: dto });
      await this.audit.log(tx, actor, 'class.updated', 'Class', id, auditChanges(before, c, Object.keys(dto)));
      return c;
    });
  }

  /** Ajoute une matière à une classe ou modifie son coefficient. */
  upsertClassSubject(actor: Actor, classId: string, dto: ClassSubjectDto) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      await assertOwned(tx, { class: classId, subject: dto.subjectId });
      const prev = await tx.classSubject.findUnique({ where: { classId_subjectId: { classId, subjectId: dto.subjectId } }, select: { coefficient: true } });
      const cs = await tx.classSubject.upsert({
        where: { classId_subjectId: { classId, subjectId: dto.subjectId } },
        create: { tenantId: actor.tenantId, classId, subjectId: dto.subjectId, coefficient: dto.coefficient },
        update: { coefficient: dto.coefficient },
      });
      await this.audit.log(tx, actor, 'class_subject.upserted', 'ClassSubject', cs.id, { classId, subjectId: dto.subjectId, ...auditChanges(prev, cs, ['coefficient']) });
      return cs;
    });
  }

  /** Même coefficient pour une matière dans toutes les classes d'un niveau (et d'une filière) de l'année en cours. */
  bulkCoefficient(actor: Actor, dto: BulkCoefficientDto) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      await assertOwned(tx, { level: dto.levelId, track: dto.trackId, subject: dto.subjectId });
      const academicYearId = await this.scope.currentYearId(tx);
      const classes = await tx.class.findMany({
        where: { academicYearId, levelId: dto.levelId, ...(dto.trackId !== undefined ? { trackId: dto.trackId } : {}) },
        select: { id: true },
      });
      if (!classes.length) throw new BadRequestException('Aucune classe ne correspond à ce niveau et à cette filière cette année');
      // SEC-033 : coefficients avant la modification, classe par classe.
      const before = await tx.classSubject.findMany({ where: { subjectId: dto.subjectId, classId: { in: classes.map((c) => c.id) } }, select: { classId: true, coefficient: true } });
      for (const c of classes) {
        if (dto.coefficient === null) {
          const cs = await tx.classSubject.findUnique({ where: { classId_subjectId: { classId: c.id, subjectId: dto.subjectId } } });
          if (!cs) continue;
          if (await tx.assessment.count({ where: { classSubjectId: cs.id } })) {
            throw new ConflictException('Des évaluations existent déjà pour cette matière dans une des classes : elle ne peut plus être retirée');
          }
          await tx.teacherAssignment.deleteMany({ where: { classSubjectId: cs.id } });
          await tx.classSubject.delete({ where: { id: cs.id } });
        } else {
          await tx.classSubject.upsert({
            where: { classId_subjectId: { classId: c.id, subjectId: dto.subjectId } },
            create: { tenantId: actor.tenantId, classId: c.id, subjectId: dto.subjectId, coefficient: dto.coefficient },
            update: { coefficient: dto.coefficient },
          });
        }
      }
      await this.audit.log(tx, actor, 'class_subject.bulk', 'Subject', dto.subjectId, {
        ...dto, classes: classes.length,
        avant: Object.fromEntries(before.map((b) => [b.classId, b.coefficient === null ? null : Number(b.coefficient)])),
      });
      return { classes: classes.length };
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
      await assertOwned(tx, { classSubject: dto.classSubjectId });
      const teacher = await tx.userRole.findFirst({ where: { userId: dto.teacherId, role: 'ENSEIGNANT' } });
      if (!teacher) throw new BadRequestException("Cette personne n'a pas le rôle Enseignant");
      const a = await tx.teacherAssignment
        .create({ data: { tenantId: actor.tenantId, ...dto } })
        .catch((e) => uniqueViolation(e, 'Cet enseignant est déjà affecté à cette matière'));
      // Affecter un professeur à une matière l'ajoute à ses matières s'il ne l'avait pas encore.
      const { subjectId } = await tx.classSubject.findUniqueOrThrow({ where: { id: dto.classSubjectId }, select: { subjectId: true } });
      await tx.teacherSubject.createMany({ data: [{ tenantId: actor.tenantId, teacherId: dto.teacherId, subjectId }], skipDuplicates: true });
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
          teacherSubjects: { select: { subject: { select: { id: true, name: true } } }, orderBy: { subject: { name: 'asc' } } },
        },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      }),
    );
  }

  createStaff(actor: Actor, dto: StaffDto) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      await assertOwned(tx, { site: dto.roles.map((r) => r.siteId), subject: dto.subjectIds });
      const password = temporaryPassword();
      const phone = await tenantPhone(tx, actor.tenantId, dto.phone);
      const user = await tx.user
        .create({
          data: {
            tenantId: actor.tenantId, firstName: dto.firstName, lastName: dto.lastName, phone, email: dto.email?.toLowerCase(),
            passwordHash: await hashPassword(password), mustChangePassword: true,
            roles: { create: dto.roles.map((r) => ({ tenantId: actor.tenantId, role: r.role, siteId: r.siteId ?? null })) },
          },
        })
        .catch((e) => uniqueViolation(e, 'Un compte existe déjà avec ce téléphone ou cet e-mail'));
      if (dto.subjectIds) await this.setTeacherSubjects(tx, actor, user.id, dto.subjectIds);
      await this.audit.log(tx, actor, 'user.created', 'User', user.id, { roles: dto.roles, subjectIds: dto.subjectIds });
      await this.sendCredentials(tx, actor, phone, password);
      return { id: user.id, temporaryPassword: password };
    });
  }

  updateStaff(actor: Actor, id: string, dto: StaffUpdateDto) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      await assertOwned(tx, { user: id, site: dto.roles?.map((r) => r.siteId), subject: dto.subjectIds });
      const before = await tx.user.findUniqueOrThrow({ where: { id }, include: { roles: { where: { role: { notIn: ['PARENT', 'ELEVE'] } } } } });
      const data: Prisma.UserUpdateInput = {
        firstName: dto.firstName, lastName: dto.lastName, email: dto.email?.toLowerCase(),
        phone: dto.phone ? await tenantPhone(tx, actor.tenantId, dto.phone) : undefined,
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
      if (dto.subjectIds) await this.setTeacherSubjects(tx, actor, id, dto.subjectIds);
      if (dto.active === false || dto.roles) {
        await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
        forgetSessions({ userId: id });
      }
      // SEC-033 : rôles et champs avant et après (téléphone et e-mail masqués, SEC-037).
      const role = (r: { role: string; siteId?: string | null }) => (r.siteId ? `${r.role}@${r.siteId}` : r.role);
      const rolesBefore = before.roles.map(role).sort();
      const rolesAfter = dto.roles?.map(role).sort();
      const after = { firstName: data.firstName, lastName: data.lastName, email: data.email, phone: data.phone, status: data.status };
      await this.audit.log(tx, actor, rolesAfter && JSON.stringify(rolesAfter) !== JSON.stringify(rolesBefore) ? 'user.roles_changed' : 'user.updated', 'User', id, {
        ...auditChanges(before, after),
        ...(rolesAfter && JSON.stringify(rolesAfter) !== JSON.stringify(rolesBefore) ? { roles: { avant: rolesBefore, après: rolesAfter } } : {}),
        ...(dto.subjectIds ? { subjectIds: dto.subjectIds } : {}),
      });
      return { ok: true };
    });
  }

  /** Remplace la liste des matières d'un professeur (une ou plusieurs ; vide pour aucune). */
  private async setTeacherSubjects(tx: Tx, actor: Actor, userId: string, subjectIds: string[]) {
    const ids = [...new Set(subjectIds)];
    if (ids.length) {
      const isTeacher = await tx.userRole.findFirst({ where: { userId, role: 'ENSEIGNANT' } });
      if (!isTeacher) throw new BadRequestException('Seul un compte avec le rôle Enseignant peut avoir des matières');
      if ((await tx.subject.count({ where: { id: { in: ids } } })) !== ids.length) throw new BadRequestException('Matière inconnue');
    }
    await tx.teacherSubject.deleteMany({ where: { teacherId: userId, subjectId: { notIn: ids } } });
    await tx.teacherSubject.createMany({ data: ids.map((subjectId) => ({ tenantId: actor.tenantId, teacherId: userId, subjectId })), skipDuplicates: true });
  }

  resetPassword(actor: Actor, id: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const password = temporaryPassword();
      const user = await tx.user.update({ where: { id }, data: { passwordHash: await hashPassword(password), mustChangePassword: true, failedLogins: 0, lockedUntil: null } });
      await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      forgetSessions({ userId: id });
      await this.audit.log(tx, actor, 'user.password_reset_by_admin', 'User', id);
      if (user.phone) await this.sendCredentials(tx, actor, user.phone, password);
      return { temporaryPassword: password };
    });
  }

  async sendCredentials(tx: Tx, actor: Actor, phone: string, password: string) {
    const tenant = await tx.tenant.findUnique({ where: { id: actor.tenantId } });
    if (!tenant) throw new NotFoundException();
    await sendQuietly(this.sms, phone, `${tenant.shortName ?? tenant.name} : votre compte est prêt. Identifiant : ${phone}. Mot de passe provisoire : ${password}. Connectez-vous sur ${tenantOrigin(tenant)}/connexion`, tenant.settings);
  }
}
