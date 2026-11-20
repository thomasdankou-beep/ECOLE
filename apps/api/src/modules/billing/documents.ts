import {
  BadRequestException, Body, Controller, Get, Header, Injectable, Logger, NotFoundException, Param, ParseUUIDPipe, Post, Req, UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import { IsIn, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { Actor, Can, CurrentActor, Public } from '../../common/auth';
import { localDay, money } from '../../common/country';
import { PrismaService } from '../../common/prisma.service';
import { FilesService } from '../files/files.service';
import { PlatformActor } from '../platform/group-journal';
import { PlatformDb, PlatformGuard } from '../platform/platform';
import { AmountDecisions, DECISIONS, exclusionDeadline, FREE_END_KINDS, firstDueDate, GRACE_DAYS, Line, OPEN_DECISIONS, SchoolYear } from './amounts-rules';
import { BillingService, PLATFORM_TZ } from './billing';
import { addDays, frDay, isDay } from './billing-rules';
import { notifyDirection, SYSTEM } from './billing-tasks';
import { COUNT_KIND_LABELS, CountKind } from './counts-rules';
import { accessSentence, creditNoteSentence, creditSentence, imputeCreditNote, useCredit } from './payments-access';
import {
  CountFact, CreditPlan, creditLine, creditLineLabel, EstablishmentFacts, GroupPlan, groupPlan, LineFact, nextLine, NextLine, PlannedEstablishment,
  subscriptionLineLabel,
} from './documents-rules';

/**
 * Documents provisoires de l'abonnement Cahiora (lot G5c, étape 2), cahier des charges G5 du 14 novembre 2026 :
 * - tâche planifiée (après les comptages) et acceptation des conditions commerciales : pour chaque client (groupe) dont
 *   les conditions sont acceptées, le document de chaque comptage figé qui n'en a pas encore, dans l'ordre des dates :
 *   première demande à la fin de la gratuité, puis compléments, ou relevé à 0 F quand rien n'est dû (documents-rules) ;
 * - un calcul qui attend une décision de Dankou n'émet rien : le Super Admin voit « En attente de la décision … » ;
 * - la base refait chaque contrôle et chaque calcul (issue_billing_document), et un document émis ne change plus ;
 * - Super Admin : tous les documents et ce qui attend ; direction d'une école indépendante : ses documents (D-G5-19 est
 *   encore ouvert pour l'école d'un groupe de plusieurs établissements).
 * Aucun document n'est une facture : référence provisoire « PROV-… » et mention « Document provisoire, sans valeur
 * fiscale » (§16 ; les factures attendent les mentions légales et fiscales, lot G5f). Aucun paiement, aucun SMS.
 */

/**
 * Seuls les abonnements dont la direction a accepté les conditions commerciales (lot G5a) reçoivent des documents
 * (D-G5-1). Depuis le lot G5d-1, un accès peut être limité avant toute acceptation : c'est la date d'acceptation qui
 * compte, plus l'état de l'abonnement (la base fait le même contrôle à chaque ligne tirée d'un comptage).
 */

/** École d'un groupe de plusieurs établissements : ce qu'elle verra des documents du groupe attend D-G5-19. */
export const GROUP_SCHOOL_PENDING = 'En attente de la décision D-G5-19 (ce que voit la direction d’un établissement de groupe) : les documents de Cahiora sont adressés à votre groupe.';

/** Mention portée par chaque document de G5c. */
export const PROVISIONAL_MENTION = 'Document provisoire, sans valeur fiscale : ce n’est pas une facture.';

export const DOCUMENT_KIND_LABELS = {
  SUBSCRIPTION: 'Proforma de l’abonnement',
  STATEMENT: 'Relevé de l’abonnement, rien à payer',
  CREDIT_NOTE: 'Avoir provisoire',
  SERVICE_QUOTE: 'Devis de prestations',
  SERVICE_PROFORMA: 'Proforma de prestations',
} as const;

type DocumentKind = 'SUBSCRIPTION' | 'CREDIT_NOTE' | 'SERVICE_QUOTE' | 'SERVICE_PROFORMA';
type IssueRow = { document_id: string; document_reference: string; document_total: number };
type ExclusionRow = {
  tenant_id: string; correction_id: string; status: 'PENDING' | 'VALIDATED' | 'REFUSED'; count_id: string; count_kind: CountKind; reference_date: Date; year_label: string;
  matricule: string; class_name: string | null; cancel_reason: string | null; justification: string; file_key: string | null; file_mime: string | null;
  requested_by_name: string; requested_at: Date; decided_by_name: string | null; decided_at: Date | null; decision_note: string | null; document_date: Date | null;
};

const CODE = { message: 'Code de votre application d’authentification : 6 chiffres' };

/**
 * Décision du Super Admin sur une exclusion qui touche un document émis (D-G5-13 B), confirmée par un code actuel de
 * son application d'authentification : une validation peut émettre un avoir (opération financière, lot G5a).
 */
export class ExclusionDecisionDto {
  @IsUUID('all', { message: 'Établissement invalide' }) tenantId: string;
  @IsIn(['VALIDATED', 'REFUSED'], { message: 'Décision inconnue' }) decision: 'VALIDATED' | 'REFUSED';
  @IsOptional() @IsString() @MaxLength(500, { message: 'Motif : 500 caractères au plus' }) note?: string;
  @IsString(CODE) @Length(6, 8, CODE) code: string;
}
type SchoolRow = {
  document_id: string; kind: DocumentKind; reference: string; currency: string; issue_date: Date; due_date: Date | null; total: number; year_label: string | null;
  related_document_id: string | null; data: Prisma.JsonValue; created_at: Date; line_id: string; position: number; label: string; amount: number; count_kind: CountKind | null;
  reference_date: Date | null; pupils: number | null; pupils_change: number | null; price_per_pupil: number | null; minimum: number | null; minimum_applied: boolean | null;
  full_year: number | null; share_months: number | null; share_of: number | null; year_amount: number | null; already_billed: number | null; service_name: string | null;
  quantity: number | null; unit_price: number | null;
};

const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const pupilsText = (n: number) => `${n} élève${n > 1 ? 's' : ''} facturable${n > 1 ? 's' : ''}`;

/** Erreur d'une fonction de la base (préfixe « CAHIORA: ») ; toute autre erreur reste une erreur. */
export function cahioraMessage(e: unknown) {
  const m = (e instanceof Error ? e.message : String(e)).match(/CAHIORA: ([^\n"]+)/);
  return m ? m[1].trim() : null;
}

/** Libellé d'un document : un document d'abonnement à 0 F est un relevé. */
export function documentLabel(kind: DocumentKind, total: number) {
  return kind === 'SUBSCRIPTION' && total === 0 ? DOCUMENT_KIND_LABELS.STATEMENT : DOCUMENT_KIND_LABELS[kind];
}

/** Tarif figé à l'acceptation des conditions (lot G5a), dans la monnaie de l'établissement ; null sinon. */
function acceptedTariff(acceptedAt: Date | null | undefined, json: Prisma.JsonValue | null | undefined, currency: string) {
  if (!acceptedAt) return { tariff: null, blocked: null };
  const t = json as { currency?: unknown; pricePerPupil?: unknown; minimum?: unknown } | null;
  const valid = t && Number.isSafeInteger(t.pricePerPupil) && (t.pricePerPupil as number) >= 1 && Number.isSafeInteger(t.minimum) && (t.minimum as number) >= 0;
  if (!valid) return { tariff: null, blocked: 'INFORMATION MANQUANTE : tarif accepté illisible' };
  if (t.currency !== currency) return { tariff: null, blocked: `INFORMATION MANQUANTE : tarif accepté en ${String(t.currency)}, établissement en ${currency}` };
  return { tariff: { pricePerPupil: t.pricePerPupil as number, minimum: t.minimum as number }, blocked: null };
}

/** Une ligne calculée, telle que la montre le Super Admin. */
function lineView(l: Line) {
  return {
    kind: l.kind, kindLabel: COUNT_KIND_LABELS[l.kind], date: l.date, yearLabel: l.yearLabel, pupils: l.pupils, pupilsChange: l.pupilsChange, pricePerPupil: l.pricePerPupil,
    minimum: l.minimum, minimumApplied: l.minimumApplied, fullYear: l.fullYear, share: l.share, amount: l.amount, rounded: l.rounded, alreadyBilled: l.alreadyBilled,
    due: l.due, creditToReview: l.creditToReview,
  };
}

function nextView(n: NextLine) {
  if (n.state !== 'READY') return { state: n.state, message: n.message };
  if ('closed' in n.line) return { state: 'CLOSED' as const, decision: n.line.decision, message: n.line.message, countKind: n.count.kind, countDate: n.count.date };
  return { state: 'READY' as const, line: lineView(n.line) };
}

/** Avoir calculé, tel que le montre le Super Admin avant de décider. */
function creditView(p: CreditPlan) {
  if (p.state === 'CLOSED') return { state: p.state, decision: p.closed.decision, message: p.closed.message };
  const year = { pupils: p.year.pupils, fullYear: p.year.fullYear, share: p.year.share, amount: p.year.amount, minimumApplied: p.year.minimumApplied, rounded: p.year.rounded };
  if (p.state === 'NONE') return { state: p.state, message: p.message, year, amount: 0 };
  return { state: p.state, year, alreadyBilled: p.alreadyBilled, amount: p.amount };
}

/** Ce qui attend pour un client : son prochain document, ou ce qui l'empêche. */
function planView(group: { id: string; name: string }, plan: GroupPlan) {
  const establishments = plan.establishments.map((e) => ({ tenantId: e.tenantId, name: e.name, next: nextView(e.next) }));
  if (plan.state === 'NOTHING') return { groupId: group.id, groupName: group.name, state: plan.state, establishments };
  if (plan.state === 'CLOSED') return { groupId: group.id, groupName: group.name, state: plan.state, decision: plan.closed.decision, message: plan.closed.message, establishments };
  return { groupId: group.id, groupName: group.name, state: plan.state, date: plan.date, yearLabel: plan.yearLabel, total: plan.total, establishments };
}

type ClientGroup = Awaited<ReturnType<BillingDocumentsService['facts']>>;

@Injectable()
export class BillingDocumentsService {
  private log = new Logger('Documents');
  private running = false;
  /**
   * Réponses de Dankou qui ouvrent les calculs fermés (amounts-rules) : celles du jour, aucune au 19 novembre 2026.
   * Les essais automatiques les remplacent pour vérifier ce qui suivra ses réponses ; l'application ne les change jamais.
   */
  decisions: AmountDecisions = DECISIONS;

  constructor(private platform: PlatformDb, private db: PrismaService, private files: FilesService, private billing: BillingService) {}

  // ---------------------------------------------------------------- Données d'un client

  /** Établissements d'un client (groupe) avec ce qu'il faut pour calculer : des dates et des nombres, jamais un nom d'élève. */
  async facts(groupId: string) {
    const g = await this.platform.schoolGroup.findUnique({
      where: { id: groupId },
      select: {
        id: true, name: true,
        tenants: {
          orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true, name: true, timezone: true, currency: true, groupId: true,
            subscription: { select: { id: true, status: true, acceptedAt: true, acceptedTariff: true, graceEnd: true, events: { where: { kind: { in: ['TRIAL_ENDED', 'PILOT_ENDED'] } }, select: { data: true } } } },
            billingCalendars: { select: { yearLabel: true, version: true, startDate: true, endDate: true } },
            billingCounts: { where: { stage: 'FROZEN' }, select: { id: true, kind: true, stage: true, referenceDate: true, yearLabel: true, cumulative: true, academicYearId: true } },
            billingDocumentLines: {
              where: { document: { kind: { in: ['SUBSCRIPTION', 'CREDIT_NOTE'] } } },
              select: {
                id: true, documentId: true, countId: true, referenceDate: true, amount: true, pupils: true, pricePerPupil: true, minimum: true, shareMonths: true,
                shareOf: true, document: { select: { kind: true, yearLabel: true, createdAt: true } },
              },
            },
          },
        },
      },
    });
    if (!g) throw new NotFoundException('Client introuvable');
    const establishments: (EstablishmentFacts & { timezone: string; currency: string; blocked: string | null; graceEnd: string | null })[] = [];
    for (const t of g.tenants) {
      const { tariff, blocked } = acceptedTariff(t.subscription?.acceptedAt, t.subscription?.acceptedTariff, t.currency);
      const lastFreeDay = (t.subscription?.events ?? []).map((e) => (e.data as Record<string, unknown> | null)?.lastFreeDay).filter(isDay).sort().pop() ?? null;
      // Élèves facturables de chaque comptage figé, exclusions validées depuis retirées (calculés par la base).
      const billable = new Map((await this.platform.$queryRaw<{ count_id: string; billable: number }[]>`SELECT * FROM billing_counts_billable(${t.id}::uuid)`)
        .map((r) => [r.count_id, r.billable]));
      const counts: CountFact[] = t.billingCounts.map((c) => ({
        id: c.id, kind: c.kind, stage: c.stage, date: iso(c.referenceDate)!, yearLabel: c.yearLabel, cumulative: billable.get(c.id) ?? c.cumulative,
      }));
      const lines: LineFact[] = t.billingDocumentLines.map((l) => ({
        id: l.id, documentId: l.documentId, documentKind: l.document.kind as LineFact['documentKind'], yearLabel: l.document.yearLabel!, countId: l.countId,
        referenceDate: iso(l.referenceDate), amount: l.amount, pupils: l.pupils, pricePerPupil: l.pricePerPupil, minimum: l.minimum, shareMonths: l.shareMonths,
        shareOf: l.shareOf, createdAt: l.document.createdAt,
      }));
      // Dates de l'année : dernière version du calendrier de facturation, sinon l'année scolaire de l'école.
      const years: Record<string, SchoolYear> = {};
      for (const c of [...t.billingCalendars].sort((a, b) => a.version - b.version)) years[c.yearLabel] = { label: c.yearLabel, startDate: iso(c.startDate)!, endDate: iso(c.endDate)! };
      const missing = [...new Set(t.billingCounts.filter((c) => !years[c.yearLabel]).map((c) => c.academicYearId))];
      if (missing.length) {
        const rows = await this.platform.inTenant(t.id, (tx) => tx.academicYear.findMany({ where: { id: { in: missing } }, select: { label: true, startDate: true, endDate: true } }));
        for (const y of rows) years[y.label] ??= { label: y.label, startDate: iso(y.startDate)!, endDate: iso(y.endDate)! };
      }
      establishments.push({ tenantId: t.id, name: t.name, timezone: t.timezone, currency: t.currency, tariff, blocked, lastFreeDay, graceEnd: iso(t.subscription?.graceEnd), counts, lines, years });
    }
    return { group: { id: g.id, name: g.name }, establishments };
  }

  /** Prochain document d'un client, calculé avec les décisions du jour. */
  plan(c: ClientGroup): GroupPlan {
    const planned: PlannedEstablishment[] = c.establishments.map((e) => ({
      tenantId: e.tenantId, name: e.name, next: e.blocked ? { state: 'MISSING', message: e.blocked } : nextLine(e, this.decisions),
    }));
    if (!planned.length) return { state: 'NOTHING', establishments: [] };
    return groupPlan(planned);
  }

  /** Clients dont au moins un établissement a accepté les conditions commerciales. */
  private async clientGroups() {
    return this.platform.schoolGroup.findMany({
      where: { tenants: { some: { subscription: { acceptedAt: { not: null } } } } }, select: { id: true, name: true }, orderBy: { name: 'asc' },
    });
  }

  // ---------------------------------------------------------------- Émission

  /** Émet les documents dus à `now` pour chaque client. Sans effet la seconde fois. */
  async runDue(now = new Date()): Promise<{ done: string[]; busy?: boolean }> {
    if (this.running) return { done: [], busy: true };
    this.running = true;
    try {
      const done: string[] = [];
      for (const g of await this.clientGroups()) {
        try {
          done.push(...(await this.forGroup(g.id, now)));
        } catch (e) {
          // Un client en erreur n'empêche pas les autres ; le document sera repris au passage suivant.
          this.log.error(`Documents de ${g.name} : ${e instanceof Error ? e.message : e}`);
        }
      }
      return { done };
    } finally {
      this.running = false;
    }
  }

  /** Documents dus d'un établissement (après l'acceptation de ses conditions) ; jamais une erreur pour l'appelant. */
  async forTenant(tenantId: string, now = new Date()) {
    try {
      const t = await this.platform.tenant.findUnique({ where: { id: tenantId }, select: { groupId: true } });
      return t ? await this.forGroup(t.groupId, now) : [];
    } catch (e) {
      this.log.error(`Documents après l’acceptation des conditions : ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }

  /**
   * Documents dus d'un client, l'un après l'autre : un comptage figé peut en attendre un autre (conditions acceptées
   * après le comptage initial, par exemple). S'arrête au premier calcul fermé.
   */
  async forGroup(groupId: string, now = new Date()) {
    const out: string[] = [];
    for (let i = 0; i < 12; i++) {
      const facts = await this.facts(groupId);
      const plan = this.plan(facts);
      if (plan.state !== 'READY') break;
      const r = await this.issue(facts, plan, now);
      if (!r) break;
      out.push(`document:${plan.lines.map((l) => l.count.kind).join('+')}:${plan.date}:${r.document_total}:${facts.group.name}`);
    }
    return out;
  }

  private async issue(c: ClientGroup, plan: Extract<GroupPlan, { state: 'READY' }>, now: Date) {
    const issueDay = localDay(PLATFORM_TZ, now);
    const tenants = c.establishments.filter((e) => plan.lines.some((l) => l.tenantId === e.tenantId));
    const currencies = [...new Set(tenants.map((t) => t.currency))];
    if (currencies.length !== 1) throw new Error('Établissements d’un même document dans des monnaies différentes');
    const currency = currencies[0];
    const firstLine = plan.lines.find((l) => FREE_END_KINDS.includes(l.count.kind));
    const first = firstLine ? tenants.find((t) => t.tenantId === firstLine.tenantId)! : null;
    const lastFreeDay = first?.lastFreeDay ?? null;
    // Délai de grâce fixé dans l'abonnement à la fin de la gratuité (lot G5d-1), sinon 15 jours (D-G5-30 A).
    const graceEnd = lastFreeDay ? first!.graceEnd ?? addDays(lastFreeDay, GRACE_DAYS) : null;
    const dueDate = lastFreeDay ? firstDueDate(lastFreeDay, issueDay, graceEnd) : null;
    const lines = plan.lines.map((l) => ({
      tenantId: l.tenantId, label: subscriptionLineLabel(l.name, l.count.kind, l.count.date), amount: l.line.due, countId: l.count.id, pupils: l.line.pupils,
      pupilsChange: l.line.pupilsChange, pricePerPupil: l.line.pricePerPupil, minimum: l.line.minimum, minimumApplied: l.line.minimumApplied, fullYear: l.line.fullYear,
      shareMonths: l.line.share?.months ?? null, shareOf: l.line.share?.of ?? null, yearAmount: l.line.amount, alreadyBilled: l.line.alreadyBilled,
    }));
    const kind = plan.lines[0].count.kind;
    const data = {
      title: `Abonnement Cahiora ${plan.yearLabel} · ${COUNT_KIND_LABELS[kind]} du ${frDay(plan.date)}`,
      mention: PROVISIONAL_MENTION,
      client: { groupId: c.group.id, name: c.group.name },
      establishments: tenants.map((t) => ({ tenantId: t.tenantId, name: t.name })),
      tariff: { currency, pricePerPupil: plan.lines[0].line.pricePerPupil, minimum: plan.lines[0].line.minimum },
      countKind: kind, countDate: plan.date, statement: plan.total === 0,
      graceEnd,
      rounded: plan.lines.some((l) => l.line.rounded) ? 'FLOOR' : null,
      decisions: { ...this.decisions },
    };
    try {
      return await this.platform.$transaction(async (tx) => {
        const [r] = await tx.$queryRaw<IssueRow[]>`
          SELECT * FROM issue_billing_document(${c.group.id}::uuid, 'SUBSCRIPTION', ${currency}, ${issueDay}::date, ${dueDate}::date, ${plan.yearLabel},
            NULL::uuid, ${JSON.stringify(data)}::jsonb, ${JSON.stringify(lines)}::jsonb, 'system', NULL::uuid, ${SYSTEM})`;
        const summary = { documentId: r.document_id, reference: r.document_reference, kind: 'SUBSCRIPTION', total: r.document_total, yearLabel: plan.yearLabel, issueDate: issueDay, dueDate };
        await documentJournals(tx, c.group, r.document_id, 'billing.document_issued', summary, plan.lines.map((l) => ({
          tenant: { id: l.tenantId, name: l.name }, data: { countKind: l.count.kind, referenceDate: l.count.date, pupils: l.line.pupils, amount: l.line.due },
        })));
        // La direction d'une école indépendante est prévenue ; celle d'une école de groupe attend D-G5-19.
        if (c.establishments.length === 1) {
          const l = plan.lines[0];
          const label = documentLabel('SUBSCRIPTION', r.document_total);
          // Lot G5d-2 (D-G5-15 A) : le crédit disponible de l'établissement se déduit aussitôt de ses documents à payer.
          const used = r.document_total > 0 ? await useCredit(tx, { id: l.tenantId, name: l.name, groupId: c.group.id }, null) : null;
          await notifyDirection(tx, l.tenantId, 'billing.document_issued',
            r.document_total ? `Document provisoire de votre abonnement Cahiora : ${money(r.document_total, currency)}` : 'Relevé de votre abonnement Cahiora : rien à payer',
            `${label} ${r.document_reference} du ${frDay(issueDay)} : ${pupilsText(l.line.pupils)} au ${frDay(l.count.date)} (${COUNT_KIND_LABELS[l.count.kind].toLowerCase()}), `
            + `${r.document_total ? `${money(r.document_total, currency)}${dueDate ? `, échéance le ${frDay(dueDate)}` : ''}` : 'rien de plus à payer à cette date'}. `
            + `${PROVISIONAL_MENTION} Il est dans Paramètres › Abonnement Cahiora.`
            + (used ? ` ${creditSentence(used, currency)}${accessSentence(used.access, currency) ? ` ${accessSentence(used.access, currency)}` : ''}` : ''));
        }
        return r;
      }, { timeout: 60000 });
    } catch (e) {
      // Émis entre-temps par un autre passage, ou refusé par les contrôles de la base : rien n'est écrit.
      const m = cahioraMessage(e);
      if (m) {
        this.log.warn(`Document de ${c.group.name} non émis : ${m}`);
        return null;
      }
      throw e;
    }
  }

  // ---------------------------------------------------------------- Super Admin

  /** Tous les documents, les plus récents d'abord, et ce qui attend pour chaque client. */
  async platformDocuments() {
    const docs = await this.platform.billingDocument.findMany({
      orderBy: [{ issueDate: 'desc' }, { createdAt: 'desc' }], take: 500,
      include: { group: { select: { id: true, name: true } }, lines: { orderBy: { position: 'asc' }, select: { tenantId: true, label: true, amount: true } } },
    });
    const plans = [];
    for (const g of await this.clientGroups()) plans.push(planView(g, this.plan(await this.facts(g.id))));
    return {
      decisions: { ...this.decisions },
      openDecisions: OPEN_DECISIONS,
      mention: PROVISIONAL_MENTION,
      documents: docs.map((d) => ({
        id: d.id, kind: d.kind, label: documentLabel(d.kind, d.total), reference: d.reference, group: d.group, currency: d.currency, issueDate: iso(d.issueDate),
        dueDate: iso(d.dueDate), total: d.total, yearLabel: d.yearLabel, relatedDocumentId: d.relatedDocumentId, createdByName: d.createdByName, createdAt: d.createdAt,
        establishments: [...new Set(d.lines.map((l) => l.tenantId))].length, tenantIds: [...new Set(d.lines.map((l) => l.tenantId))],
        title: (d.data as Record<string, unknown>)?.title ?? null,
      })),
      plans,
    };
  }

  /** Un document et ses lignes. */
  async platformDocument(id: string) {
    const d = await this.platform.billingDocument.findUnique({
      where: { id },
      include: {
        group: { select: { id: true, name: true } }, lines: { orderBy: { position: 'asc' }, include: { tenant: { select: { id: true, name: true } } } },
        related: { select: { id: true, reference: true, kind: true } }, relatedBy: { select: { id: true, reference: true, kind: true, total: true } },
      },
    });
    if (!d) throw new NotFoundException('Document introuvable');
    return {
      id: d.id, kind: d.kind, label: documentLabel(d.kind, d.total), reference: d.reference, group: d.group, currency: d.currency, issueDate: iso(d.issueDate),
      dueDate: iso(d.dueDate), total: d.total, yearLabel: d.yearLabel, data: d.data, createdByKind: d.createdByKind, createdByName: d.createdByName, createdAt: d.createdAt,
      related: d.related, relatedBy: d.relatedBy,
      lines: d.lines.map((l) => ({
        id: l.id, position: l.position, tenant: l.tenant, label: l.label, amount: l.amount, countKind: l.countKind, referenceDate: iso(l.referenceDate), pupils: l.pupils,
        pupilsChange: l.pupilsChange, pricePerPupil: l.pricePerPupil, minimum: l.minimum, minimumApplied: l.minimumApplied, fullYear: l.fullYear, shareMonths: l.shareMonths,
        shareOf: l.shareOf, yearAmount: l.yearAmount, alreadyBilled: l.alreadyBilled, relatedLineId: l.relatedLineId, serviceName: l.serviceName, quantity: l.quantity,
        unitPrice: l.unitPrice, priceBasis: l.priceBasis,
      })),
    };
  }

  // ---------------------------------------------------------------- Exclusions qui touchent un document (D-G5-13 B)

  /**
   * Avoir d'un établissement pour une année : ligne de son dernier document d'abonnement, élèves facturables de son
   * comptage (exclusions validées retirées ; `pending` : la demande encore en attente est retirée aussi, pour l'aperçu),
   * déjà demandé. La base refait ce calcul à l'émission.
   */
  private async creditFor(tx: Prisma.TransactionClient, tenantId: string, yearLabel: string, pending: boolean) {
    const order: Prisma.BillingDocumentLineOrderByWithRelationInput[] = [{ referenceDate: 'desc' }, { document: { createdAt: 'desc' } }];
    const related = await tx.billingDocumentLine.findFirst({
      where: { tenantId, document: { kind: 'SUBSCRIPTION', yearLabel } }, orderBy: order,
      select: {
        id: true, documentId: true, countId: true, countKind: true, referenceDate: true, pricePerPupil: true, minimum: true, shareMonths: true, shareOf: true,
        document: { select: { reference: true } },
      },
    });
    if (!related?.countId || !related.countKind || !related.referenceDate || related.pricePerPupil === null || related.minimum === null) return null;
    const last = await tx.billingDocumentLine.findFirst({ where: { tenantId, document: { kind: { in: ['SUBSCRIPTION', 'CREDIT_NOTE'] }, yearLabel } }, orderBy: order, select: { pupils: true } });
    const [b] = await tx.$queryRaw<{ billable: number }[]>`SELECT billable FROM billing_counts_billable(${tenantId}::uuid) WHERE count_id = ${related.countId}::uuid`;
    const [a] = await tx.$queryRaw<{ billed: number }[]>`SELECT billing_already_billed(${tenantId}::uuid, ${yearLabel}) AS billed`;
    const plan = creditLine({
      related: { pricePerPupil: related.pricePerPupil, minimum: related.minimum, shareMonths: related.shareMonths, shareOf: related.shareOf },
      pupils: Math.max(0, b.billable - (pending ? 1 : 0)), previousPupils: last?.pupils ?? 0, alreadyBilled: a.billed,
    }, this.decisions);
    return { related: { ...related, countKind: related.countKind, referenceDate: iso(related.referenceDate)! }, plan };
  }

  /** Demandes d'exclusion du ressort du Super Admin, et l'avoir que donnerait chaque demande en attente. */
  async platformExclusions() {
    const rows = await this.platform.$queryRaw<ExclusionRow[]>`SELECT * FROM platform_count_exclusions()`;
    const tenants = new Map((await this.platform.tenant.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.tenant_id))] } }, select: { id: true, name: true, currency: true },
    })).map((t) => [t.id, t]));
    const exclusions = [];
    for (const r of rows) {
      const t = tenants.get(r.tenant_id);
      const documentDate = iso(r.document_date);
      const credit = r.status === 'PENDING' ? await this.creditFor(this.platform, r.tenant_id, r.year_label, true) : null;
      exclusions.push({
        id: r.correction_id, tenant: { id: r.tenant_id, name: t?.name ?? '' }, currency: t?.currency ?? null, status: r.status, countKind: r.count_kind,
        countLabel: COUNT_KIND_LABELS[r.count_kind], referenceDate: iso(r.reference_date), yearLabel: r.year_label, matricule: r.matricule, className: r.class_name,
        cancelReason: r.cancel_reason, justification: r.justification, fileUrl: r.file_key ? this.files.signedUrl(r.file_key) : null,
        requestedByName: r.requested_by_name, requestedAt: r.requested_at, decidedByName: r.decided_by_name, decidedAt: r.decided_at, decisionNote: r.decision_note,
        documentDate, requestDeadline: documentDate ? exclusionDeadline(documentDate) : null,
        preview: credit && { related: credit.related.document.reference, ...creditView(credit.plan) },
      });
    }
    return { mention: PROVISIONAL_MENTION, waiting: exclusions.filter((x) => x.status === 'PENDING').length, exclusions };
  }

  /**
   * Décision du Super Admin (D-G5-13 B) et, pour une exclusion validée, l'avoir provisoire dans la même transaction :
   * rien n'est inscrit si l'un ou l'autre est refusé. Au minimum, la décision s'inscrit sans avoir.
   */
  async decideExclusion(admin: PlatformActor, id: string, dto: ExclusionDecisionDto, now = new Date()) {
    if (dto.decision === 'REFUSED' && (dto.note?.trim().length ?? 0) < 5) throw new BadRequestException('Un refus exige un motif (5 caractères au moins)');
    await this.billing.confirm(admin, dto.code);
    try {
      return await this.platform.$transaction(async (tx) => {
        const [d] = await tx.$queryRaw<{ document_date: Date; year_label: string }[]>`
          SELECT * FROM decide_count_exclusion_platform(${dto.tenantId}::uuid, ${id}::uuid, ${dto.decision}, ${dto.note?.trim() || null}, ${admin.id}::uuid,
            ${admin.name}, ${admin.ip ?? null})`;
        const t = await tx.tenant.findUniqueOrThrow({
          where: { id: dto.tenantId }, select: { id: true, name: true, currency: true, group: { select: { id: true, name: true, _count: { select: { tenants: true } } } } },
        });
        let credit: Awaited<ReturnType<BillingDocumentsService['issueCredit']>> | null = null;
        let message: string | null = null;
        if (dto.decision === 'VALIDATED') {
          const c = await this.creditFor(tx, t.id, d.year_label, false);
          if (!c) throw new BadRequestException('Aucun document d’abonnement à corriger pour cette année');
          if (c.plan.state === 'CLOSED') throw new BadRequestException(c.plan.closed.message);
          if (c.plan.state === 'NONE') message = c.plan.message;
          else credit = await this.issueCredit(tx, t, d.year_label, c.related, c.plan, id, admin, now);
        }
        const action = dto.decision === 'VALIDATED' ? 'billing.count_exclusion_validated' : 'billing.count_exclusion_refused';
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${t.id}, true)`;
        await tx.auditLog.createMany({
          data: [{
            tenantId: t.id, userId: null, userName: `Super Admin de la plateforme (${admin.name})`, action, entity: 'CountCorrection', entityId: id,
            data: { decidedBy: 'platform', note: dto.note?.trim() || null, credit: credit && { reference: credit.reference, total: credit.total } } as Prisma.InputJsonValue,
          }],
        });
        // La direction est prévenue ; le montant de l'avoir seulement si elle voit les documents (école indépendante, D-G5-19).
        const sees = t.group._count.tenants === 1;
        const body = dto.decision === 'REFUSED'
          ? `Le Super Admin de Cahiora a refusé l’exclusion demandée : ${dto.note!.trim()}`
          : credit && sees
            ? `Le Super Admin de Cahiora a validé l’exclusion demandée. Avoir provisoire ${credit.reference} de ${money(credit.total, t.currency)}, dans Paramètres › Abonnement Cahiora. ${PROVISIONAL_MENTION}`
              + (credit.imputed ? [creditNoteSentence(credit.imputed, t.currency), accessSentence(credit.imputed.access, t.currency)].filter(Boolean).map((x) => ` ${x}`).join('') : '')
            : `Le Super Admin de Cahiora a validé l’exclusion demandée.${message ? ` ${message}.` : ''}`;
        await notifyDirection(tx, t.id, action, dto.decision === 'VALIDATED' ? 'Exclusion validée par Cahiora' : 'Exclusion refusée par Cahiora', body);
        return { status: dto.decision, credit, message };
      }, { timeout: 60000 });
    } catch (e) {
      const m = cahioraMessage(e);
      if (m) throw new BadRequestException(m);
      throw e;
    }
  }

  private async issueCredit(
    tx: Prisma.TransactionClient, t: { id: string; name: string; currency: string; group: { id: string; name: string } }, yearLabel: string,
    related: { id: string; documentId: string; countKind: CountKind; referenceDate: string; document: { reference: string } }, plan: Extract<CreditPlan, { state: 'READY' }>,
    correctionId: string, admin: PlatformActor, now: Date,
  ) {
    const issueDay = localDay(PLATFORM_TZ, now);
    const y = plan.year;
    const line = {
      tenantId: t.id, label: creditLineLabel(t.name, related.countKind, related.referenceDate), amount: plan.amount, pupils: y.pupils, pupilsChange: plan.pupilsChange,
      pricePerPupil: y.pricePerPupil, minimum: y.minimum, minimumApplied: y.minimumApplied, fullYear: y.fullYear, shareMonths: y.share?.months ?? null,
      shareOf: y.share?.of ?? null, yearAmount: y.amount, alreadyBilled: plan.alreadyBilled, relatedLineId: related.id, correctionId,
    };
    const data = {
      title: `Avoir provisoire · abonnement Cahiora ${yearLabel}`,
      mention: PROVISIONAL_MENTION,
      client: { groupId: t.group.id, name: t.group.name },
      establishments: [{ tenantId: t.id, name: t.name }],
      reason: 'Exclusion validée d’une inscription annulée pour erreur de saisie (D-G5-13 B)',
      related: { documentId: related.documentId, reference: related.document.reference, countKind: related.countKind, countDate: related.referenceDate },
      tariff: { currency: t.currency, pricePerPupil: y.pricePerPupil, minimum: y.minimum },
      rounded: y.rounded ? 'FLOOR' : null,
    };
    const [r] = await tx.$queryRaw<IssueRow[]>`
      SELECT * FROM issue_billing_document(${t.group.id}::uuid, 'CREDIT_NOTE', ${t.currency}, ${issueDay}::date, NULL::date, ${yearLabel}, ${related.documentId}::uuid,
        ${JSON.stringify(data)}::jsonb, ${JSON.stringify([line])}::jsonb, 'platform', ${admin.id}::uuid, ${admin.name})`;
    await documentJournals(tx, t.group, r.document_id, 'billing.credit_note_issued', {
      documentId: r.document_id, reference: r.document_reference, kind: 'CREDIT_NOTE', total: r.document_total, yearLabel, issueDate: issueDay,
      relatedDocumentId: related.documentId,
    }, [{ tenant: { id: t.id, name: t.name }, data: { pupils: y.pupils, amount: plan.amount, correctionId } }], admin);
    // Lot G5d-2 (choix 1 A) : l'avoir s'impute aussitôt sur le document qu'il corrige, puis les autres, puis le crédit.
    const imputed = await imputeCreditNote(tx, r.document_id, { id: t.id, name: t.name, groupId: t.group.id }, admin);
    return { documentId: r.document_id, reference: r.document_reference, total: r.document_total, imputed };
  }

  // ---------------------------------------------------------------- Direction de l'établissement

  /**
   * Documents de l'établissement, les plus récents d'abord (direction seulement). Une école d'un groupe de plusieurs
   * établissements n'en voit aucun tant que D-G5-19 n'est pas tranché : `groupPending` le dit à l'écran.
   */
  schoolDocuments(actor: Actor) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const [v] = await tx.$queryRaw<{ visible: boolean | null }[]>`SELECT current_tenant_sees_billing_documents() AS visible`;
      const rows = await tx.$queryRaw<SchoolRow[]>`SELECT * FROM current_tenant_billing_documents()`;
      const byId = new Map<string, ReturnType<typeof schoolDocument>>();
      for (const r of rows) {
        if (!byId.has(r.document_id)) byId.set(r.document_id, schoolDocument(r));
        byId.get(r.document_id)!.lines.push(schoolLine(r));
      }
      return { mention: PROVISIONAL_MENTION, groupPending: v?.visible === false ? GROUP_SCHOOL_PENDING : null, documents: [...byId.values()] };
    });
  }
}

function schoolDocument(r: SchoolRow) {
  return {
    id: r.document_id, kind: r.kind, label: documentLabel(r.kind, r.total), reference: r.reference, currency: r.currency, issueDate: iso(r.issue_date), dueDate: iso(r.due_date),
    total: r.total, yearLabel: r.year_label, relatedDocumentId: r.related_document_id, data: r.data, createdAt: r.created_at, lines: [] as ReturnType<typeof schoolLine>[],
  };
}

function schoolLine(r: SchoolRow) {
  return {
    id: r.line_id, position: r.position, label: r.label, amount: r.amount, countKind: r.count_kind, referenceDate: iso(r.reference_date), pupils: r.pupils, pupilsChange: r.pupils_change,
    pricePerPupil: r.price_per_pupil, minimum: r.minimum, minimumApplied: r.minimum_applied, fullYear: r.full_year, shareMonths: r.share_months, shareOf: r.share_of,
    yearAmount: r.year_amount, alreadyBilled: r.already_billed, serviceName: r.service_name, quantity: r.quantity, unitPrice: r.unit_price,
  };
}

/**
 * Journaux d'un document : plateforme et groupe une fois (toutes les lignes), et chaque établissement concerné (sa
 * ligne seulement), dans la transaction de l'émission ; au nom de la tâche planifiée ou du Super Admin.
 */
export async function documentJournals(
  tx: Prisma.TransactionClient, group: { id: string; name: string }, documentId: string, action: string, data: Record<string, unknown>,
  lines: { tenant: { id: string; name: string }; data: Record<string, unknown> }[], actor: { id: string; name: string; ip?: string | null } | null = null,
) {
  const all = { ...data, lines: lines.map((l) => ({ tenantId: l.tenant.id, tenantName: l.tenant.name, ...l.data })) };
  const tenantIds = [...new Set(lines.map((l) => l.tenant.id))];
  await tx.platformAuditLog.create({ data: { adminId: actor?.id ?? null, action, tenantId: tenantIds.length === 1 ? tenantIds[0] : null, data: all as Prisma.InputJsonValue, ip: actor?.ip ?? null } });
  await tx.groupAuditLog.create({
    data: {
      groupId: group.id, actorKind: actor ? 'platform' : 'system', actorId: actor?.id ?? null, actorName: actor ? `Super Admin Cahiora (${actor.name})` : SYSTEM, action,
      data: all as Prisma.InputJsonValue,
    },
  });
  for (const id of tenantIds) {
    const own = lines.filter((l) => l.tenant.id === id).map((l) => l.data);
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${id}, true)`;
    await tx.auditLog.createMany({
      data: [{ tenantId: id, userId: null, userName: actor ? `Super Admin de la plateforme (${actor.name})` : SYSTEM, action, entity: 'BillingDocument', entityId: documentId, data: { ...data, lines: own } as Prisma.InputJsonValue }],
    });
  }
}

@ApiTags('Plateforme : facturation')
@Public()
@UseGuards(PlatformGuard)
@Controller()
export class BillingDocumentsController {
  constructor(private s: BillingDocumentsService) {}

  @Get('platform/billing/documents') @Header('Cache-Control', 'no-store')
  list() { return this.s.platformDocuments(); }

  @Get('platform/billing/documents/:id') @Header('Cache-Control', 'no-store')
  one(@Param('id', ParseUUIDPipe) id: string) { return this.s.platformDocument(id); }

  /** Exclusions qui touchent un document émis : le Super Admin les décide (D-G5-13 B). */
  @Get('platform/billing/exclusions') @Header('Cache-Control', 'no-store')
  exclusions() { return this.s.platformExclusions(); }

  @Post('platform/billing/exclusions/:id/decision') @Throttle({ default: { limit: 20, ttl: 60000 } })
  decide(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ExclusionDecisionDto) {
    return this.s.decideExclusion((req as unknown as { platformAdmin: PlatformActor }).platformAdmin, id, dto);
  }
}

@ApiTags('Paramètres')
@Controller()
export class SchoolBillingDocumentsController {
  constructor(private s: BillingDocumentsService) {}

  /** Documents provisoires de l'abonnement de l'établissement : direction seulement. */
  @Get('settings/billing-documents') @Can('settings.manage') @Header('Cache-Control', 'no-store')
  list(@CurrentActor() a: Actor) { return this.s.schoolDocuments(a); }
}
