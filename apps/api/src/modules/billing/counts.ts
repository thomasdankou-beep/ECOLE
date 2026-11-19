import {
  BadRequestException, Body, Controller, Get, Header, Injectable, Logger, NotFoundException, Param, ParseUUIDPipe, Post, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Prisma, Subscription } from '@prisma/client';
import { IsIn, IsOptional, IsString, IsUUID, Length, Matches, MaxLength } from 'class-validator';
import { AuditService } from '../../common/audit.service';
import { Actor, Can, CurrentActor, WholeSchool } from '../../common/auth';
import { localDay } from '../../common/country';
import { PrismaService, Tx } from '../../common/prisma.service';
import { FilesService, MAX_UPLOAD_BYTES, UPLOAD_THROTTLE } from '../files/files.service';
import { PlatformDb } from '../platform/platform';
import { billableRows, BillableRow, endOfSchoolDay, enrollmentEpisodes } from '../students/enrollments';
import { frDay, isDay } from './billing-rules';
import { AlreadyDone, jobOnce, notifyDirection, systemJournals } from './billing-tasks';
import {
  auditDepartureDays, BASIS_LABELS, CountBasis, CountCalendar, CountItem, CountKind, CountRecord, CountStage, COUNT_KIND_LABELS, countView, DueCount, dueCounts,
  freeEndYear, resolveItems, sortCounts,
} from './counts-rules';

/**
 * Comptages des élèves facturables (lot G5b, cahier des charges G5 §5 ; décisions D-G5-13 B, D-G5-14 A et D-G5-16 A
 * du 19 novembre 2026) :
 * - tâche planifiée : comptage figé à la fin d'un essai ou d'un pilote ; aux dates du calendrier, comptage provisoire
 *   le lendemain, vérification par la direction, puis comptage figé. La liste se calcule dans l'espace de l'école (rôle
 *   des écoles, historique des inscriptions rejoué) ; la base l'enregistre par la fonction record_billing_count, avec le
 *   rôle de la plateforme, qui ne lit ensuite que des nombres ;
 * - direction : comptages, liste nominative, demandes de correction et décisions (Paramètres › Effectifs facturables) ;
 * - Super Admin : les nombres de chaque comptage, jamais un nom (BillingService.establishments).
 * Aucun montant, aucune facture, aucun SMS : le calcul et les documents arrivent au lot G5c.
 */

type Sub = Subscription & { tenant: { id: string; name: string; timezone: string; groupId: string } };
type Year = { id: string; label: string; startDate: string; endDate: string };
type RecordRow = { count_id: string; count_pupils: number; count_cumulative: number; count_to_check: number; count_excluded: number; count_hash: string; count_review_until: Date | null };
type CountRow = {
  id: string; year_label: string; academic_year_id: string; kind: CountKind; reference_date: Date; stage: CountStage; calendar_version: number | null; pupils: number;
  cumulative: number; to_check: number; excluded: number; list_hash: string; at: Date; known_at: Date; review_until: Date | null; time_zone: string; created_at: Date;
};

const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const pupilsText = (n: number) => `${n} élève${n > 1 ? 's' : ''}`;
const DEPARTURE_BASES: CountBasis[] = ['DEPARTURE_AUDIT', 'DEPARTURE_UNKNOWN', 'DEPARTURE_DIRECTION'];

/** Erreur d'une fonction de la base (préfixe « CAHIORA: ») rendue à l'écran ; toute autre erreur reste une erreur. */
function cahioraMessage(e: unknown) {
  const m = (e instanceof Error ? e.message : String(e)).match(/CAHIORA: ([^\n"]+)/);
  return m ? m[1].trim() : null;
}

/** Dernière version du calendrier de chaque année scolaire, dates en AAAA-MM-JJ. */
function latestCalendars(rows: Prisma.BillingCalendarGetPayload<object>[]): CountCalendar[] {
  const seen = new Map<string, Prisma.BillingCalendarGetPayload<object>>();
  for (const c of rows) if (!seen.has(c.yearLabel) || seen.get(c.yearLabel)!.version < c.version) seen.set(c.yearLabel, c);
  return [...seen.values()].map((c) => ({
    yearLabel: c.yearLabel, version: c.version, startDate: iso(c.startDate)!, endDate: iso(c.endDate)!, preparationFrom: iso(c.preparationFrom),
    initialCountDate: iso(c.initialCountDate)!, firstRegularizationDate: iso(c.firstRegularizationDate)!, finalRegularizationDate: iso(c.finalRegularizationDate)!,
  }));
}

/** Ligne de current_tenant_billing_counts() en comptage affichable. */
function record(c: CountRow): CountRecord & { academicYearId: string } {
  return {
    id: c.id, yearLabel: c.year_label, academicYearId: c.academic_year_id, kind: c.kind, referenceDate: iso(c.reference_date)!, stage: c.stage,
    calendarVersion: c.calendar_version, pupils: c.pupils, cumulative: c.cumulative, toCheck: c.to_check, excluded: c.excluded, listHash: c.list_hash,
    at: c.at, knownAt: c.known_at, reviewUntil: iso(c.review_until), timeZone: c.time_zone, createdAt: c.created_at,
  };
}

export class CountCorrectionDto {
  @IsIn(['EXCLUSION', 'DEPARTURE_DATE'], { message: 'Type de correction inconnu' }) kind: 'EXCLUSION' | 'DEPARTURE_DATE';
  @IsUUID('all', { message: 'Inscription invalide' }) enrollmentId: string;
  @IsString() @Length(5, 500, { message: 'Justification : 5 à 500 caractères' }) justification: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Date de départ attendue au format AAAA-MM-JJ' }) departureDate?: string;
}

export class CountDecisionDto {
  @IsIn(['VALIDATED', 'REFUSED'], { message: 'Décision inconnue' }) decision: 'VALIDATED' | 'REFUSED';
  @IsOptional() @IsString() @MaxLength(500, { message: 'Motif : 500 caractères au plus' }) note?: string;
}

@Injectable()
export class CountsService {
  private log = new Logger('Comptages');
  private running = false;

  constructor(private db: PrismaService, private platform: PlatformDb, private files: FilesService, private audit: AuditService) {}

  // ---------------------------------------------------------------- Tâche planifiée

  /** Fait les comptages dus à `now` pour chaque établissement abonné. Sans effet la seconde fois. */
  async runDue(now = new Date()): Promise<{ done: string[]; busy?: boolean }> {
    if (this.running) return { done: [], busy: true };
    this.running = true;
    try {
      const done: string[] = [];
      const subs: Sub[] = await this.platform.subscription.findMany({ include: { tenant: { select: { id: true, name: true, timezone: true, groupId: true } } } });
      for (const s of subs) {
        try {
          done.push(...(await this.forSubscription(s, now)));
        } catch (e) {
          // Un établissement en erreur n'empêche pas les autres ; le comptage sera repris au passage suivant.
          this.log.error(`Comptage des élèves pour ${s.tenant.name} : ${e instanceof Error ? e.message : e}`);
        }
      }
      return { done };
    } finally {
      this.running = false;
    }
  }

  private async forSubscription(s: Sub, now: Date) {
    const today = localDay(s.tenant.timezone, now);
    const ended = await this.platform.subscriptionEvent.findMany({ where: { subscriptionId: s.id, kind: { in: ['TRIAL_ENDED', 'PILOT_ENDED'] } }, select: { kind: true, data: true } });
    const lastFree = (kind: string) =>
      ended.filter((e) => e.kind === kind).map((e) => (e.data as Record<string, unknown> | null)?.lastFreeDay).filter(isDay).sort().pop() ?? null;
    const calendars = latestCalendars(await this.platform.billingCalendar.findMany({ where: { tenantId: s.tenantId } }));
    const recorded = await this.platform.billingCount.findMany({
      where: { tenantId: s.tenantId }, select: { kind: true, stage: true, referenceDate: true, yearLabel: true, reviewUntil: true },
    });
    const due = dueCounts(
      today,
      { status: s.status, trialEnd: iso(s.trialEnd), pilotEnd: iso(s.pilotEnd), endedTrial: lastFree('TRIAL_ENDED'), endedPilot: lastFree('PILOT_ENDED') },
      calendars,
      recorded.map((r) => ({ kind: r.kind, stage: r.stage, date: iso(r.referenceDate)!, yearLabel: r.yearLabel, reviewUntil: iso(r.reviewUntil) })),
    );
    if (!due.length) return [];
    const years = await this.yearsOf(s.tenantId);
    const out: string[] = [];
    for (const d of due) {
      const year = d.yearLabel ? years.find((y) => y.label === d.yearLabel) ?? null : freeEndYear(d.date, calendars, years);
      if (!year) {
        if (await this.blocked(s, d)) out.push(`count-blocked:${d.kind}:${d.date}:${s.tenant.name}`);
      } else if (await this.record(s, d, year, now, today)) {
        out.push(`count-${d.stage === 'FROZEN' ? 'frozen' : 'provisional'}:${d.kind}:${d.date}:${s.tenant.name}`);
      }
    }
    return out;
  }

  /** Années scolaires de l'établissement : dates seulement (droits du rôle de la plateforme, lot G5a). */
  private yearsOf(tenantId: string): Promise<Year[]> {
    return this.platform.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      const rows = await tx.academicYear.findMany({ select: { id: true, label: true, startDate: true, endDate: true } });
      return rows.map((y) => ({ id: y.id, label: y.label, startDate: iso(y.startDate)!, endDate: iso(y.endDate)! }));
    });
  }

  /**
   * Liste d'un comptage, calculée dans l'espace de l'école à l'instant `knownAt` : historique des inscriptions rejoué,
   * départs d'avant l'historique datés (direction, sinon journal d'audit), exclusions validées au plus tard à cet instant.
   */
  private async items(tx: Tx, yearId: string, date: string, timeZone: string, knownAt: Date) {
    const { rows } = await billableRows(tx, yearId, date, timeZone, knownAt);
    const unknown = rows.filter((r) => r.state === 'UNKNOWN');
    const logs = unknown.length
      ? await tx.auditLog.findMany({ where: { action: 'student.withdrawn', entityId: { in: unknown.map((r) => r.studentId) }, createdAt: { lte: knownAt } }, select: { entityId: true, createdAt: true } })
      : [];
    const corrections = await tx.countCorrection.findMany({
      where: { status: 'VALIDATED', decidedAt: { lte: knownAt }, enrollment: { academicYearId: yearId } },
      select: { kind: true, enrollmentId: true, departureDate: true }, orderBy: [{ decidedAt: 'asc' }, { requestedAt: 'asc' }],
    });
    const direction = new Map<string, string>();
    for (const c of corrections) if (c.kind === 'DEPARTURE_DATE' && c.departureDate) direction.set(c.enrollmentId, iso(c.departureDate)!);
    const excluded = new Set(corrections.filter((c) => c.kind === 'EXCLUSION').map((c) => c.enrollmentId));
    const audit = auditDepartureDays(unknown, logs, knownAt, timeZone);
    return { rows, audit, list: resolveItems(date, rows, { direction, audit }, excluded) };
  }

  /** Enregistre un comptage : liste calculée dans l'école, puis la base contrôle, compte, calcule le cumul et l'empreinte. */
  private async record(s: Sub, d: DueCount, year: Year, now: Date, today: string) {
    const tz = s.tenant.timezone;
    const at = endOfSchoolDay(d.date, tz);
    // Fin d'essai ou de pilote : historique tel qu'à la fin du dernier jour gratuit. Comptage figé du calendrier : tel qu'à
    // la fin du dernier jour de vérification. Provisoire : tel qu'au moment du comptage.
    const knownAt = d.kind === 'TRIAL_END' || d.kind === 'PILOT_END' ? at : d.stage === 'FROZEN' ? endOfSchoolDay(d.reviewUntil!, tz) : now;
    const { list } = await this.db.forTenant(s.tenantId, (tx) => this.items(tx, year.id, d.date, tz, knownAt), { timeout: 60000 });
    const key = `count:${s.tenantId}:${year.label}:${d.kind}:${d.date}:${d.stage}`;
    return jobOnce(this.platform, key, d.stage === 'FROZEN' ? 'COUNT_FROZEN' : 'COUNT_PROVISIONAL', s.tenantId, d.date, async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${s.tenantId}, true)`;
      const [r] = await tx.$queryRaw<RecordRow[]>`
        SELECT * FROM record_billing_count(${s.tenantId}::uuid, ${year.id}::uuid, ${d.kind}, ${d.date}::date, ${d.stage}, ${d.calendarVersion}::int,
          ${JSON.stringify(list)}::jsonb, ${at.toISOString()}::timestamptz, ${knownAt.toISOString()}::timestamptz, ${today}::date)`;
      if (!r) throw new AlreadyDone();
      const label = COUNT_KIND_LABELS[d.kind];
      const reviewUntil = iso(r.count_review_until);
      const data = {
        countId: r.count_id, kind: d.kind, stage: d.stage, referenceDate: d.date, yearLabel: year.label, pupils: r.count_pupils, cumulative: r.count_cumulative,
        toCheck: r.count_to_check, excluded: r.count_excluded, listHash: r.count_hash, reviewUntil,
      };
      await systemJournals(tx, s.tenant, 'BillingCount', r.count_id, d.stage === 'FROZEN' ? 'billing.count_frozen' : 'billing.count_recorded', data);
      const n = pupilsText(r.count_pupils);
      if (d.stage === 'PROVISIONAL') {
        await notifyDirection(tx, s.tenantId, 'billing.count_recorded', `Comptage des élèves du ${frDay(d.date)} : vérifiez la liste`,
          `${label} de l’année ${year.label} : ${n} au ${frDay(d.date)}. Vous avez jusqu’au ${frDay(reviewUntil!)} inclus pour vérifier la liste dans Paramètres › Effectifs facturables : demander l’exclusion d’une inscription annulée par erreur de saisie, ou dater un départ enregistré avant l’historique des inscriptions. Le comptage sera ensuite figé.`);
      } else {
        await notifyDirection(tx, s.tenantId, 'billing.count_frozen', `Comptage des élèves du ${frDay(d.date)} : ${n}`,
          d.kind === 'TRIAL_END' || d.kind === 'PILOT_END'
            ? `${n} inscrit${r.count_pupils > 1 ? 's' : ''} à la fin de votre ${d.kind === 'TRIAL_END' ? 'essai gratuit' : 'période pilote'}, le ${frDay(d.date)}. Ce comptage est figé et sert au calcul de votre abonnement Cahiora ; la liste est dans Paramètres › Effectifs facturables.`
            : `La vérification est terminée : ${label.toLowerCase()} de l’année ${year.label} figé à ${n} au ${frDay(d.date)}. Il ne change plus et sert au calcul de votre abonnement Cahiora ; la liste reste dans Paramètres › Effectifs facturables.`);
      }
    });
  }

  /** Comptage impossible faute d'année scolaire : une alerte et une notification, une seule fois ; il se fera dès que l'année existera. */
  private blocked(s: Sub, d: DueCount) {
    const label = COUNT_KIND_LABELS[d.kind];
    const missing = d.yearLabel ? `l’année scolaire « ${d.yearLabel} » n’existe pas dans l’espace de l’école` : 'aucune année scolaire de l’école ne contient cette date';
    return jobOnce(this.platform, `count-blocked:${s.tenantId}:${d.kind}:${d.date}`, 'COUNT_BLOCKED', s.tenantId, d.date, async (tx) => {
      await tx.platformAlert.create({
        data: { tenantId: s.tenantId, kind: 'COUNT_BLOCKED', dueDate: day(d.date), message: `${label} du ${frDay(d.date)} en attente pour ${s.tenant.name} : ${missing}. Le comptage se fera dès que l’année existera.` },
      });
      await systemJournals(tx, s.tenant, 'Subscription', s.id, 'billing.count_blocked', { kind: d.kind, referenceDate: d.date, yearLabel: d.yearLabel });
      await notifyDirection(tx, s.tenantId, 'billing.count_blocked', 'Comptage des élèves en attente',
        `${label} du ${frDay(d.date)} : ${missing}. Créez-la dans Paramètres › Année et périodes ; le comptage se fera ensuite de lui-même.`);
    });
  }

  // ---------------------------------------------------------------- Direction de l'établissement

  private async rows(tx: Tx) {
    return sortCounts((await tx.$queryRaw<CountRow[]>`SELECT * FROM current_tenant_billing_counts()`).map(record));
  }

  private async timezone(tx: Tx, tenantId: string) {
    return (await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } })).timezone;
  }

  /** Comptages de l'établissement, les plus récents d'abord, avec les demandes encore en attente. */
  schoolCounts(actor: Actor) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const today = localDay(await this.timezone(tx, actor.tenantId));
      const rows = await this.rows(tx);
      const pending = await tx.countCorrection.groupBy({ by: ['countId'], where: { status: 'PENDING' }, _count: { _all: true } });
      const waiting = new Map(pending.map((p) => [p.countId, p._count._all]));
      return { today, counts: rows.map((c) => ({ ...countView(c, today, rows), pendingRequests: waiting.get(c.id) ?? 0 })) };
    });
  }

  /**
   * Un comptage et sa liste nominative (espace de l'école seulement) : classe et site à la date, motif, inscription
   * annulée depuis, doublon possible, demandes de correction. Pendant la vérification, la liste telle qu'elle serait
   * figée maintenant (`live`) : élèves ajoutés ou retirés depuis le comptage provisoire.
   */
  schoolCount(actor: Actor, id: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const tz = await this.timezone(tx, actor.tenantId);
      const today = localDay(tz);
      const all = await this.rows(tx);
      const c = all.find((r) => r.id === id);
      if (!c) throw new NotFoundException('Comptage introuvable');
      const count = countView(c, today, all);
      const items = (await tx.billingCountItem.findMany({ where: { countId: id }, select: { enrollmentId: true, classId: true, siteId: true, counted: true, basis: true, departureDate: true } }))
        .map((i) => ({ ...i, basis: i.basis as CountBasis, departureDate: iso(i.departureDate) }));
      let live: { list: CountItem[]; audit: Map<string, string>; rows: BillableRow[] } | null = null;
      if (count.reviewOpen) live = await this.items(tx, c.academicYearId, count.referenceDate, tz, new Date());
      const liveIds = new Set(live?.list.filter((i) => i.counted).map((i) => i.enrollmentId));
      const added = live ? live.list.filter((i) => i.counted && !items.some((x) => x.enrollmentId === i.enrollmentId && x.counted)) : [];
      const ids = [...new Set([...items, ...added].map((i) => i.enrollmentId))];
      const enrollments = new Map((await tx.enrollment.findMany({
        where: { id: { in: ids } },
        select: { id: true, status: true, cancelReason: true, student: { select: { id: true, matricule: true, firstName: true, lastName: true } } },
      })).map((e) => [e.id, e]));
      const classes = new Map((await tx.class.findMany({ where: { id: { in: [...new Set([...items, ...added].map((i) => i.classId))] } }, select: { id: true, name: true } })).map((x) => [x.id, x.name]));
      const sites = new Map((await tx.site.findMany({ select: { id: true, name: true } })).map((x) => [x.id, x.name]));
      const studentIds = [...enrollments.values()].map((e) => e.student.id);
      const duplicates = await tx.duplicateReview.findMany({
        where: { status: { in: ['PENDING', 'SAME'] }, OR: [{ studentId: { in: studentIds } }, { otherId: { in: studentIds } }] }, select: { studentId: true, otherId: true, status: true },
      });
      const corrections = await tx.countCorrection.findMany({
        where: { enrollment: { academicYearId: c.academicYearId } }, orderBy: { requestedAt: 'desc' },
        include: { enrollment: { select: { student: { select: { matricule: true, firstName: true, lastName: true } } } } },
      });
      const exclusionOf = (enrollmentId: string) => corrections.find((k) => k.kind === 'EXCLUSION' && k.enrollmentId === enrollmentId && k.status !== 'REFUSED') ?? null;
      const person = (enrollmentId: string, i: { classId: string; siteId: string | null; counted: boolean; basis: CountBasis; departureDate: string | null }) => {
        const e = enrollments.get(enrollmentId);
        const dup = duplicates.filter((x) => x.studentId === e?.student.id || x.otherId === e?.student.id);
        const exclusion = exclusionOf(enrollmentId);
        return {
          enrollmentId, studentId: e?.student.id ?? null, matricule: e?.student.matricule ?? '', name: e ? `${e.student.lastName} ${e.student.firstName}` : '',
          className: classes.get(i.classId) ?? 'Classe supprimée', siteName: i.siteId ? sites.get(i.siteId) ?? null : null,
          counted: i.counted, basis: i.basis, basisLabel: BASIS_LABELS[i.basis], departureDate: i.departureDate,
          enrollmentStatus: e?.status ?? null, cancelReason: e?.status === 'CANCELLED' ? e.cancelReason : null,
          duplicate: dup.some((x) => x.status === 'SAME') ? 'SAME' : dup.length ? 'PENDING' : null,
          exclusion: exclusion && { id: exclusion.id, status: exclusion.status },
          canExclude: count.reviewOpen && e?.status === 'CANCELLED' && !exclusion,
          canDate: count.reviewOpen && DEPARTURE_BASES.includes(i.basis),
          auditDay: live?.audit.get(enrollmentId) ?? (i.basis === 'DEPARTURE_AUDIT' ? i.departureDate : null),
          stillCounted: live ? liveIds.has(enrollmentId) : null,
        };
      };
      const order = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'fr');
      return {
        today, count,
        items: items.map((i) => person(i.enrollmentId, i)).sort(order),
        live: live && {
          pupils: live.list.filter((i) => i.counted).length,
          added: added.map((i) => person(i.enrollmentId, i)).sort(order),
          removed: items.filter((i) => i.counted && !liveIds.has(i.enrollmentId)).length,
        },
        corrections: corrections.map((k) => ({
          id: k.id, kind: k.kind, enrollmentId: k.enrollmentId, matricule: k.enrollment.student.matricule, name: `${k.enrollment.student.lastName} ${k.enrollment.student.firstName}`,
          countId: k.countId, status: k.status, departureDate: iso(k.departureDate), justification: k.justification,
          fileUrl: k.fileKey ? this.files.signedUrl(k.fileKey) : null, requestedByName: k.requestedByName, requestedAt: k.requestedAt,
          decidedByName: k.decidedByName, decidedAt: k.decidedAt, decisionNote: k.decisionNote,
        })),
      };
    });
  }

  /**
   * Bornes de la date d'un départ enregistré avant l'historique, pour la période qui couvre le jour R : pas avant
   * l'arrivée de l'élève, pas après la date du journal d'audit (D-G5-16 A : la direction peut seulement l'avancer).
   */
  private async departureLimits(tx: Tx, enrollmentId: string, referenceDate: string, timeZone: string) {
    const e = await tx.enrollment.findUnique({
      where: { id: enrollmentId },
      select: { id: true, studentId: true, status: true, enrolledAt: true, events: { select: { kind: true, data: true, createdAt: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
    });
    if (!e) return null;
    const at = endOfSchoolDay(referenceDate, timeZone);
    const now = new Date();
    const ep = enrollmentEpisodes(e, e.events).find((x) => x.start <= at && x.end?.kind === 'UNKNOWN' && (!x.end.before || x.end.before > at));
    if (!ep || ep.end?.kind !== 'UNKNOWN') return null;
    const logs = await tx.auditLog.findMany({ where: { action: 'student.withdrawn', entityId: e.studentId, createdAt: { lte: now } }, select: { entityId: true, createdAt: true } });
    const row = { enrollmentId: e.id, studentId: e.studentId, classId: '', siteId: null, state: 'UNKNOWN' as const, unknown: { since: ep.start, before: ep.end.before } };
    return { since: localDay(timeZone, ep.start), auditDay: auditDepartureDays([row], logs, now, timeZone).get(e.id) ?? null };
  }

  /** Demande de correction pendant la vérification (D-G5-14 A), avec un justificatif facultatif (photo ou PDF). */
  async requestCorrection(actor: Actor, countId: string, dto: CountCorrectionDto, file?: { buffer: Buffer; mimetype: string; size: number }) {
    if (dto.kind === 'DEPARTURE_DATE' && !(dto.departureDate && isDay(dto.departureDate))) throw new BadRequestException('Date de départ : date invalide');
    if (dto.kind === 'EXCLUSION' && dto.departureDate) throw new BadRequestException('Une exclusion ne porte pas de date de départ');
    const newKey = file ? await this.files.save(actor.tenantId, 'comptages', file) : null;
    return this.files.commit(newKey, () => this.db.forTenant(actor.tenantId, async (tx) => {
      const tz = await this.timezone(tx, actor.tenantId);
      const today = localDay(tz);
      if (dto.kind === 'DEPARTURE_DATE') {
        const c = (await this.rows(tx)).find((r) => r.id === countId);
        if (!c) throw new NotFoundException('Comptage introuvable');
        const limits = await this.departureLimits(tx, dto.enrollmentId, c.referenceDate, tz);
        if (!limits) throw new BadRequestException('Cette inscription n’a pas de départ enregistré avant l’historique des inscriptions à cette date');
        if (dto.departureDate! < limits.since) throw new BadRequestException(`La date de départ précède l’arrivée de l’élève (le ${frDay(limits.since)})`);
        if (limits.auditDay && dto.departureDate! > limits.auditDay) {
          throw new BadRequestException(`La date de départ ne peut pas être après celle du journal (le ${frDay(limits.auditDay)}) : vous pouvez seulement l’avancer`);
        }
      }
      try {
        const [r] = await tx.$queryRaw<{ id: string }[]>`
          SELECT request_count_correction(${countId}::uuid, ${dto.kind}, ${dto.enrollmentId}::uuid, ${dto.departureDate ?? null}::date, ${dto.justification.trim()},
            ${newKey}, ${file?.mimetype ?? null}, ${file?.size ?? null}::int, ${actor.userId}::uuid, ${actor.name}, ${actor.ip ?? null}, ${today}::date) AS id`;
        await this.audit.log(tx, actor, dto.kind === 'EXCLUSION' ? 'billing.count_exclusion_requested' : 'billing.count_departure_dated', 'CountCorrection', r.id,
          { countId, enrollmentId: dto.enrollmentId, departureDate: dto.departureDate ?? null, justificatif: !!newKey });
        return { result: { id: r.id, status: dto.kind === 'EXCLUSION' ? 'PENDING' : 'VALIDATED' } };
      } catch (e) {
        const message = cahioraMessage(e);
        if (message) throw new BadRequestException(message);
        throw e;
      }
    }));
  }

  /** Décision sur une demande d'exclusion (D-G5-13 B : la direction, tant qu'aucun document émis n'est touché). */
  decide(actor: Actor, id: string, dto: CountDecisionDto) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      try {
        const [r] = await tx.$queryRaw<{ status: string }[]>`
          SELECT decide_count_correction(${id}::uuid, ${dto.decision}, ${dto.note?.trim() || null}, ${actor.userId}::uuid, ${actor.name}, ${actor.ip ?? null}) AS status`;
        await this.audit.log(tx, actor, dto.decision === 'VALIDATED' ? 'billing.count_exclusion_validated' : 'billing.count_exclusion_refused', 'CountCorrection', id,
          { note: dto.note?.trim() || null });
        return { status: r.status };
      } catch (e) {
        const message = cahioraMessage(e);
        if (message) throw new BadRequestException(message);
        throw e;
      }
    });
  }
}

@ApiTags('Paramètres')
@Controller()
export class CountsController {
  constructor(private s: CountsService) {}

  /** Comptages des élèves facturables de l'établissement : direction seulement. */
  @Get('settings/billing-counts') @Can('settings.manage') @Header('Cache-Control', 'no-store')
  list(@CurrentActor() a: Actor) { return this.s.schoolCounts(a); }

  @Get('settings/billing-counts/:id') @Can('settings.manage') @Header('Cache-Control', 'no-store')
  one(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.s.schoolCount(a, id); }

  @Post('settings/billing-counts/:id/corrections') @Can('settings.manage') @WholeSchool('Seule la direction de tout l’établissement corrige un comptage')
  @ApiConsumes('multipart/form-data')
  @Throttle(UPLOAD_THROTTLE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  correct(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CountCorrectionDto, @UploadedFile() file?: Express.Multer.File) {
    return this.s.requestCorrection(a, id, dto, file);
  }

  @Post('settings/billing-counts/corrections/:id/decision') @Can('settings.manage') @WholeSchool('Seule la direction de tout l’établissement décide d’une exclusion')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  decide(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CountDecisionDto) { return this.s.decide(a, id, dto); }
}
