import {
  BadRequestException, Body, CanActivate, ConflictException, Controller, ForbiddenException, Get, Header, Injectable, NotFoundException, Param, ParseUUIDPipe, Post,
  Query, Req, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import type { Request } from 'express';
import { AuditService } from '../../common/audit.service';
import { Actor, Can, CurrentActor, forgetAccess, Public, WholeSchool } from '../../common/auth';
import { CURRENCIES, localDay, money } from '../../common/country';
import { PrismaService, Tx } from '../../common/prisma.service';
import { RawValue } from '../../common/util';
import { FilesService, MAX_UPLOAD_BYTES, UPLOAD_THROTTLE } from '../files/files.service';
import { PlatformActor, platformLog } from '../platform/group-journal';
import { PlatformDb, PlatformGuard } from '../platform/platform';
import { cahioraMessage } from './access';
import { BillingService, PLATFORM_TZ } from './billing';
import { STATUS_LABELS } from './billing-rules';
import { notifyDirection } from './billing-tasks';
import {
  accessSentence, creditSentence, dayLabel, meansVersion, paymentJournals, syncPaymentAccess, useCredit,
} from './payments-access';
import {
  activeMeans, availableCredit, CREDIT_ENTRY_LABELS, CreditEntryKind, documentPayment, GROUP_PAYMENT_PENDING, matchesStatus, meansCode, meansError, meansOn,
  normalizedReference, PAYMENT_STATUS_LABELS, paymentError, PAYMENTS_LOCKED, paymentsUnlocked, RECEIPT_MENTION, REFUND_STATUS_LABELS, refundDecisionError,
  refundRequestError, REFUNDS_CLOSED, RefundStatus, STATUS_FILTERS, StatusFilter, transferError,
} from './payments-rules';
import { financialTotals } from './payments-totals';

/**
 * Paiements de l'abonnement Cahiora (lot G5d-2), plan validé par Dankou le 20 novembre 2026 (« Tout valider ») :
 * - Super Admin (D-G5-17 A, D-G5-34 lue A : un seul rôle, chaque validation nommée et confirmée par le code de son
 *   application) : moyens de paiement en versions datées (verrou 2), enregistrement d'un paiement reçu avec son
 *   justificatif (établissement payeur, document concerné, montant attendu et reçu, date, moyen, référence, agent),
 *   annulation d'une saisie par une contre-écriture motivée, avoirs et crédits, décisions sur les demandes de
 *   remboursement, transferts de crédit dans un groupe avec leur autorisation, rapports où facturé et encaissé ne se
 *   confondent jamais ;
 * - direction de tout l'établissement (école indépendante ; D-G5-19 encore ouverte pour l'école d'un groupe) : état du
 *   paiement de chaque document, reçus provisoires « PROV-REC-… », crédit disponible et demande de remboursement ;
 *   moyens de paiement montrés seulement une fois activés.
 * Deux verrous empêchent tout paiement réel tant que la situation juridique et fiscale de Cahiora n'est pas validée
 * (D-G5-33) : le verrou 1 du serveur (variable BILLING_PAYMENTS_UNLOCKED, fermé par défaut, donc en production) refuse
 * chaque écriture de ce lot avant même de lire la demande ; le verrou 2 (activation de chaque moyen, datée, confirmée
 * par le code) ne s'ouvre pas tant que le premier est fermé. Aucun prestataire de paiement n'est appelé, aucun SMS n'est
 * envoyé (notifications dans l'application seulement). Reçus et documents restent provisoires, sans valeur fiscale.
 */

const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

/** Verrou 1 : toute écriture du lot est refusée tant que le serveur ne l'ouvre pas, avant même la lecture de la demande. */
@Injectable()
export class PaymentsOpenGuard implements CanActivate {
  canActivate() {
    if (!paymentsUnlocked()) throw new ForbiddenException(PAYMENTS_LOCKED);
    return true;
  }
}
export const PaymentsOpen = () => UseGuards(PaymentsOpenGuard);

const CODE = { message: 'Code de votre application d’authentification : 6 chiffres' };
const DAY = { message: 'Date attendue au format AAAA-MM-JJ' };
const AMOUNT = { message: 'Montant : nombre entier, sans espace ni décimale' };
const MOTIF = { message: 'Motif : 5 à 300 caractères' };
const MEANS = { message: 'Moyen de paiement inconnu' };

export class PaymentMeansDto {
  /** Moyen existant dont c'est la version suivante ; absent pour un nouveau moyen. */
  @IsOptional() @Matches(/^[A-Z0-9_]{1,40}$/, MEANS) meansCode?: string;
  @IsString() @Length(2, 80, { message: 'Nom du moyen de paiement : 2 à 80 caractères' }) name: string;
  @IsString() @Length(5, 1000, { message: 'Coordonnées et instructions pour les établissements : 5 à 1 000 caractères' }) instructions: string;
  @IsIn(CURRENCIES, { message: 'Monnaie non prise en charge' }) currency: string;
  @RawValue() @IsBoolean({ message: 'Activé : oui ou non' }) active: boolean;
  @Matches(/^\d{4}-\d{2}-\d{2}$/, DAY) effectiveFrom: string;
  @IsString(MOTIF) @MinLength(5, MOTIF) @MaxLength(300, MOTIF) reason: string;
  @IsString(CODE) @Length(6, 8, CODE) code: string;
}

/** Formulaire avec justificatif (multipart) : chaque champ arrive en texte. */
export class RecordPaymentDto {
  @IsUUID('all', { message: 'Établissement payeur invalide' }) tenantId: string;
  @IsUUID('all', { message: 'Document concerné invalide' }) documentId: string;
  @Matches(/^\d{1,10}$/, AMOUNT) amount: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/, DAY) paidOn: string;
  @Matches(/^[A-Z0-9_]{1,40}$/, MEANS) meansCode: string;
  @IsString() @Length(3, 100, { message: 'Référence de la transaction : 3 à 100 caractères' }) transactionRef: string;
  @IsOptional() @IsString() @MaxLength(500, { message: 'Commentaire : 500 caractères au plus' }) note?: string;
  @IsString(CODE) @Length(6, 8, CODE) code: string;
}

export class CancelPaymentDto {
  @IsString(MOTIF) @MinLength(5, MOTIF) @MaxLength(300, MOTIF) reason: string;
  @IsString(CODE) @Length(6, 8, CODE) code: string;
}

/** Décision sur une demande de remboursement (multipart : le justificatif accompagne un remboursement). */
export class RefundDecisionDto {
  @IsIn(['REFUNDED', 'REFUSED'], { message: 'Décision inconnue' }) decision: 'REFUNDED' | 'REFUSED';
  @IsOptional() @IsString() @MaxLength(500, { message: 'Note : 500 caractères au plus' }) note?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, DAY) refundedOn?: string;
  @IsOptional() @IsString() @MaxLength(80, { message: 'Moyen du remboursement : 2 à 80 caractères' }) means?: string;
  @IsOptional() @IsString() @MaxLength(100, { message: 'Référence du remboursement : 3 à 100 caractères' }) reference?: string;
  @IsString(CODE) @Length(6, 8, CODE) code: string;
}

/** Transfert d'un crédit dans un groupe (multipart : l'écrit de l'autorisation peut être joint). */
export class CreditTransferDto {
  @IsUUID('all', { message: 'Établissement qui cède le crédit invalide' }) fromTenantId: string;
  @IsUUID('all', { message: 'Établissement qui reçoit le crédit invalide' }) toTenantId: string;
  @Matches(/^\d{1,10}$/, AMOUNT) amount: string;
  @IsString() @Length(5, 300, { message: 'Autorisation : qui l’a donnée et par quel écrit (5 à 300 caractères)' }) authorizedBy: string;
  @IsString(MOTIF) @MinLength(5, MOTIF) @MaxLength(300, MOTIF) reason: string;
  @IsString(CODE) @Length(6, 8, CODE) code: string;
}

export class ReportQueryDto {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, DAY) from?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, DAY) to?: string;
  @IsOptional() @IsUUID('all', { message: 'Établissement invalide' }) tenantId?: string;
  @IsOptional() @IsUUID('all', { message: 'Groupe invalide' }) groupId?: string;
  @IsOptional() @IsIn(STATUS_FILTERS as unknown as string[], { message: 'État inconnu' }) status?: StatusFilter;
}

export class RefundRequestDto {
  @Type(() => Number) @IsInt(AMOUNT) @Min(1, AMOUNT) @Max(1_000_000_000, AMOUNT) amount: number;
  @IsOptional() @IsString() @MaxLength(1000, { message: 'Message : 1 000 caractères au plus' }) message?: string;
}

type PayableRow = { document_id: string; reference: string; issue_date: Date; due_date: Date | null; created_at: Date; total: number; credited: number; paid: number; balance: number };
type GraceRow = { document_id: string; reference: string; balance: number };
type RecordRow = { payment_id: string; receipt_number: string; expected: number; allocated: number; credit: number };
type CancelRow = { tenant_id: string; receipt_number: string; reversed: number; credit_reversed: number; uses_reversed: number };
type DecisionRow = { refund_tenant: string; refund_status: string; refund_amount: number };

const PAYMENT_INCLUDE = {
  tenant: { select: { id: true, name: true, group: { select: { id: true, name: true } } } },
  document: { select: { id: true, reference: true, issueDate: true } },
  allocations: { orderBy: { createdAt: 'asc' }, include: { document: { select: { reference: true } } } },
} satisfies Prisma.BillingPaymentInclude;
type PaymentWithAll = Prisma.BillingPaymentGetPayload<{ include: typeof PAYMENT_INCLUDE }>;

/** Un paiement tel que le lit le Super Admin : jamais modifié ; une saisie annulée le reste, marquée. */
function paymentView(p: PaymentWithAll) {
  const status = p.cancelledAt ? 'CANCELLED' : 'VALIDATED';
  return {
    id: p.id, receiptNumber: p.receiptNumber, tenantId: p.tenantId, tenantName: p.tenant.name, group: p.tenant.group, documentId: p.documentId, documentReference: p.document.reference,
    currency: p.currency, expectedAmount: p.expectedAmount, amount: p.amount, paidOn: iso(p.paidOn), meansName: p.meansName, transactionRef: p.transactionRef,
    creditAmount: p.creditAmount, note: p.note, recordedByName: p.recordedByName, recordedAt: p.recordedAt, status, statusLabel: PAYMENT_STATUS_LABELS[status],
    cancelledAt: p.cancelledAt, cancelledByName: p.cancelledByName, cancelReason: p.cancelReason,
    allocations: p.allocations.filter((a) => a.amount > 0).map((a) => ({ reference: a.document.reference, amount: a.amount })),
  };
}

/** Reçu provisoire, à imprimer : jamais une facture ni un reçu fiscal (§16). */
function receiptView(r: {
  receiptNumber: string; payer: string; group: string | null; documentReference: string; currency: string; expectedAmount: number; amount: number; paidOn: string;
  meansName: string; transactionRef: string; creditAmount: number; recordedAt: Date; cancelledAt: Date | null; allocations: { reference: string; amount: number }[]; agent: string | null;
}) {
  return {
    ...r, mention: RECEIPT_MENTION, title: `Reçu provisoire ${r.receiptNumber}`, issuer: 'Cahiora',
    lines: [
      ['Établissement payeur', r.payer], ...(r.group ? [['Client', r.group]] : []), ['Document concerné', r.documentReference],
      ['Montant attendu', money(r.expectedAmount, r.currency)], ['Montant reçu', money(r.amount, r.currency)], ['Date du paiement', dayLabel(r.paidOn)],
      ['Moyen de paiement', r.meansName], ['Référence de la transaction', r.transactionRef],
      ...r.allocations.map((a) => [`Imputé sur ${a.reference}`, money(a.amount, r.currency)]),
      ...(r.creditAmount > 0 ? [['Crédit de l’établissement', money(r.creditAmount, r.currency)]] : []),
      ['Enregistré par', r.agent ? `Cahiora (${r.agent})` : 'Cahiora'],
    ] as [string, string][],
    cancelled: r.cancelledAt ? `Saisie annulée par Cahiora le ${r.cancelledAt.toLocaleDateString('fr-FR', { timeZone: PLATFORM_TZ })} : ce reçu ne vaut plus.` : null,
  };
}

@Injectable()
export class BillingPaymentsService {
  constructor(private db: PlatformDb, private files: FilesService, private billing: BillingService) {}

  private async means(today: string) {
    const versions = (await this.db.billingPaymentMeans.findMany({ orderBy: [{ code: 'asc' }, { version: 'desc' }] })).map(meansVersion);
    return { versions, current: meansOn(versions, today) };
  }

  /** Établissement (avec son groupe et sa taille) ; 404 s'il n'existe pas. */
  private async tenant(id: string) {
    const t = await this.db.tenant.findUnique({
      where: { id }, select: { id: true, name: true, groupId: true, timezone: true, currency: true, group: { select: { id: true, name: true, _count: { select: { tenants: true } } } } },
    });
    if (!t) throw new NotFoundException('Établissement introuvable');
    return t;
  }

  private async credit(db: Pick<PlatformDb, '$queryRaw'>, tenantId: string) {
    const [c] = await db.$queryRaw<{ balance: number; reserved: number }[]>`
      SELECT billing_credit_balance(${tenantId}::uuid) AS balance, billing_credit_reserved(${tenantId}::uuid) AS reserved`;
    return { balance: c.balance, reserved: c.reserved, available: availableCredit(c.balance, c.reserved) };
  }

  /**
   * Paiements : verrou 1, moyens de paiement (version en vigueur et historique), établissements qui ont des documents
   * de l'abonnement avec ce qui leur reste à payer, et les derniers paiements enregistrés.
   */
  async overview() {
    const unlocked = paymentsUnlocked();
    const today = localDay(PLATFORM_TZ);
    const means = await this.means(today);
    const tenants = await this.db.tenant.findMany({
      where: { billingDocumentLines: { some: { document: { kind: 'SUBSCRIPTION' } } } }, orderBy: { name: 'asc' },
      select: {
        id: true, name: true, currency: true, timezone: true, groupId: true, group: { select: { id: true, name: true, _count: { select: { tenants: true } } } },
        subscription: { select: { status: true } },
      },
    });
    const establishments = [];
    for (const t of tenants) {
      const alone = t.group._count.tenants === 1;
      const tToday = localDay(t.timezone);
      const docs = alone ? await this.db.$queryRaw<PayableRow[]>`SELECT * FROM billing_payable_documents(${t.id}::uuid)` : [];
      const [g] = alone ? await this.db.$queryRaw<GraceRow[]>`SELECT * FROM billing_grace_document(${t.id}::uuid)` : [];
      establishments.push({
        tenantId: t.id, name: t.name, group: { id: t.group.id, name: t.group.name, size: t.group._count.tenants }, currency: t.currency, today: tToday, alone,
        groupPending: alone ? null : GROUP_PAYMENT_PENDING,
        subscription: t.subscription ? { status: t.subscription.status, statusLabel: STATUS_LABELS[t.subscription.status] } : null,
        documents: docs.map((d) => ({
          id: d.document_id, reference: d.reference, issueDate: iso(d.issue_date), dueDate: iso(d.due_date), total: d.total, credited: d.credited,
          ...documentPayment({ total: d.total, credited: d.credited, paid: d.paid, dueDate: iso(d.due_date) }, tToday),
        })),
        graceDocument: g ? { id: g.document_id, reference: g.reference, balance: g.balance } : null,
        credit: await this.credit(this.db, t.id),
        means: activeMeans(means.versions, t.currency, tToday, unlocked).map((m) => ({ code: m.code, name: m.name })),
      });
    }
    const payments = await this.db.billingPayment.findMany({ orderBy: { recordedAt: 'desc' }, take: 200, include: PAYMENT_INCLUDE });
    return {
      unlocked, lockMessage: unlocked ? null : PAYMENTS_LOCKED, mention: RECEIPT_MENTION, today, currencies: CURRENCIES,
      means: { current: means.current, versions: means.versions }, establishments, payments: payments.map(paymentView),
    };
  }

  /** Un paiement, son justificatif (lien signé, quinze minutes), ses imputations et contre-écritures, son reçu provisoire. */
  async payment(id: string) {
    const p = await this.db.billingPayment.findUnique({ where: { id }, include: PAYMENT_INCLUDE });
    if (!p) throw new NotFoundException('Paiement introuvable');
    const entries = await this.db.billingCreditEntry.findMany({ where: { paymentId: id }, orderBy: { createdAt: 'asc' } });
    return {
      ...paymentView(p), proofUrl: this.files.signedUrl(p.proofKey), proofMime: p.proofMime,
      movements: p.allocations.map((a) => ({ reference: a.document.reference, amount: a.amount, reversal: a.amount < 0, createdAt: a.createdAt })),
      creditEntries: entries.map((e) => ({ kind: e.kind, label: CREDIT_ENTRY_LABELS[e.kind as CreditEntryKind], amount: e.amount, createdAt: e.createdAt })),
      receipt: receiptView({
        receiptNumber: p.receiptNumber, payer: p.tenant.name, group: p.tenant.group.name, documentReference: p.document.reference, currency: p.currency,
        expectedAmount: p.expectedAmount, amount: p.amount, paidOn: iso(p.paidOn)!, meansName: p.meansName, transactionRef: p.transactionRef, creditAmount: p.creditAmount,
        recordedAt: p.recordedAt, cancelledAt: p.cancelledAt, allocations: paymentView(p).allocations, agent: p.recordedByName,
      }),
    };
  }

  /**
   * Nouvelle version d'un moyen de paiement (verrou 2) : nouveau moyen ou version suivante, nom et coordonnées donnés
   * par Dankou, monnaie, activé ou non, date d'effet à partir d'aujourd'hui, motif ; code de l'application exigé.
   */
  async addMeans(actor: PlatformActor, dto: PaymentMeansDto) {
    const today = localDay(PLATFORM_TZ);
    const error = meansError(dto, today, CURRENCIES, paymentsUnlocked());
    if (error) throw new BadRequestException(error);
    const isNew = !dto.meansCode;
    const code = dto.meansCode ?? meansCode(dto.name);
    await this.billing.confirm(actor, dto.code);
    try {
      return await this.db.$transaction(async (tx) => {
        const [r] = await tx.$queryRaw<{ means_id: string; means_code: string; means_version: number }[]>`
          SELECT * FROM add_billing_payment_means(${code}, ${isNew}, ${dto.name}, ${dto.instructions}, ${dto.currency}, ${dto.active}, ${dto.effectiveFrom}::date,
            ${dto.reason}, ${actor.id}::uuid, ${actor.name}, ${today}::date)`;
        await platformLog(tx, actor, 'billing.payment_means_added', null, {
          code: r.means_code, version: r.means_version, name: dto.name.trim(), currency: dto.currency, active: dto.active, effectiveFrom: dto.effectiveFrom, reason: dto.reason.trim(),
        });
        return { id: r.means_id, code: r.means_code, version: r.means_version };
      });
    } catch (e) {
      const m = cahioraMessage(e);
      if (m) throw new BadRequestException(m);
      throw e;
    }
  }

  /**
   * Enregistre un paiement reçu (D-G5-17 A) avec son justificatif et le code de l'application : la base refait chaque
   * contrôle (document de l'établissement, montant, date, moyen activé ce jour-là, référence jamais enregistrée), impute
   * le paiement (choix 1 A), garde le surplus en crédit et numérote le reçu provisoire. Dans la même transaction : les
   * journaux, l'accès (choix 2 A) et la notification de la direction. Le justificatif est effacé si rien n'est inscrit.
   */
  async record(actor: PlatformActor, dto: RecordPaymentDto, file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Justificatif du paiement : joignez la preuve (photo ou PDF)');
    const t = await this.tenant(dto.tenantId);
    if (t.group._count.tenants !== 1) throw new BadRequestException(GROUP_PAYMENT_PENDING);
    const doc = await this.db.billingDocument.findUnique({ where: { id: dto.documentId }, select: { id: true, reference: true, issueDate: true } });
    if (!doc) throw new NotFoundException('Document introuvable');
    const today = localDay(t.timezone);
    const amount = Number(dto.amount);
    const error = paymentError({ amount, paidOn: dto.paidOn, transactionRef: dto.transactionRef }, today, iso(doc.issueDate)!);
    if (error) throw new BadRequestException(error);
    const twin = await this.db.billingPayment.findFirst({ where: { transactionKey: normalizedReference(dto.transactionRef), cancelledAt: null }, select: { receiptNumber: true } });
    if (twin) throw new ConflictException(`Cette référence de transaction est déjà enregistrée (reçu ${twin.receiptNumber}) : un même paiement ne s’enregistre qu’une fois`);
    await this.billing.confirm(actor, dto.code);
    const key = await this.files.save(t.id, 'paiements-cahiora', file);
    try {
      const result = await this.files.commit(key, async () => ({
        result: await this.db.$transaction(async (tx) => {
          const [r] = await tx.$queryRaw<RecordRow[]>`
            SELECT * FROM record_billing_payment(${t.id}::uuid, ${doc.id}::uuid, ${amount}::integer, ${dto.paidOn}::date, ${dto.meansCode}, ${dto.transactionRef}, ${key},
              ${file.mimetype}, ${dto.note?.trim() || null}, ${actor.id}::uuid, ${actor.name}, ${actor.ip ?? null}, ${today}::date)`;
          const p = await tx.billingPayment.findUniqueOrThrow({ where: { id: r.payment_id }, include: PAYMENT_INCLUDE });
          const v = paymentView(p);
          const data = {
            paymentId: p.id, receiptNumber: p.receiptNumber, documentReference: doc.reference, amount, expected: r.expected, allocated: r.allocated, credit: r.credit,
            paidOn: dto.paidOn, means: p.meansName, transactionRef: p.transactionRef, allocations: v.allocations,
          };
          await paymentJournals(tx, actor, t, 'billing.payment_recorded', data, { note: p.note });
          const access = await syncPaymentAccess(tx, t.id, { cause: 'PAYMENT', receiptNumber: p.receiptNumber }, actor);
          const parts = [
            `Cahiora a enregistré votre paiement de ${money(amount, t.currency)} du ${dayLabel(dto.paidOn)} (${p.meansName}, référence ${p.transactionRef}) : reçu provisoire ${p.receiptNumber}.`,
            v.allocations.length ? `Imputé sur ${v.allocations.map((a) => `${a.reference} (${money(a.amount, t.currency)})`).join(', ')}.` : '',
            r.credit > 0 ? `${money(r.credit, t.currency)} deviennent un crédit de votre établissement, déduit du prochain document.` : '',
            accessSentence(access, t.currency), `${RECEIPT_MENTION} Le reçu est dans Paramètres › Abonnement Cahiora.`,
          ];
          await notifyDirection(tx, t.id, 'billing.payment_recorded', `Paiement reçu par Cahiora : reçu provisoire ${p.receiptNumber}`, parts.filter(Boolean).join(' '));
          return { ...v, expected: r.expected, allocated: r.allocated, credit: r.credit, access: { kind: access.kind, status: access.status } };
        }, { timeout: 60000 }),
      }));
      forgetAccess(t.id);
      return result;
    } catch (e) {
      const m = cahioraMessage(e);
      if (m) throw new BadRequestException(m);
      throw e;
    }
  }

  /**
   * Annule la saisie d'un paiement par une contre-écriture motivée, une seule fois (code de l'application exigé) : ses
   * imputations et son crédit sont repris, rien n'est supprimé, le reçu reste marqué annulé. Si le document du délai de
   * grâce n'est plus entièrement payé, l'abonnement revient en attente de paiement. Le motif reste à Cahiora.
   */
  async cancel(actor: PlatformActor, id: string, dto: CancelPaymentDto) {
    const p = await this.db.billingPayment.findUnique({ where: { id }, select: { id: true, tenantId: true, cancelledAt: true, receiptNumber: true, amount: true, currency: true } });
    if (!p) throw new NotFoundException('Paiement introuvable');
    if (p.cancelledAt) throw new ConflictException('Ce paiement est déjà annulé');
    const t = await this.tenant(p.tenantId);
    const reason = dto.reason.trim();
    await this.billing.confirm(actor, dto.code);
    try {
      const result = await this.db.$transaction(async (tx) => {
        const [r] = await tx.$queryRaw<CancelRow[]>`SELECT * FROM cancel_billing_payment(${id}::uuid, ${reason}, ${actor.id}::uuid, ${actor.name}, ${actor.ip ?? null})`;
        const data = { paymentId: id, receiptNumber: r.receipt_number, amount: p.amount, reversed: r.reversed, creditReversed: r.credit_reversed, usesReversed: r.uses_reversed };
        await paymentJournals(tx, actor, t, 'billing.payment_cancelled', data, { reason });
        const access = await syncPaymentAccess(tx, t.id, { cause: 'PAYMENT_CANCELLED', receiptNumber: r.receipt_number }, actor);
        await notifyDirection(tx, t.id, 'billing.payment_cancelled', `Saisie d’un paiement annulée par Cahiora : reçu ${r.receipt_number}`,
          [`Cahiora a annulé l’enregistrement du paiement de ${money(p.amount, p.currency)} (reçu provisoire ${r.receipt_number}) : une erreur de saisie se corrige par une contre-écriture, rien n’est supprimé.`,
            r.uses_reversed > 0 ? `${money(r.uses_reversed, p.currency)} de crédit déduits grâce à ce paiement sont repris : les documents concernés attendent à nouveau leur paiement.` : '',
            accessSentence(access, p.currency)].filter(Boolean).join(' '));
        return { ...data, access: { kind: access.kind, status: access.status } };
      }, { timeout: 60000 });
      forgetAccess(t.id);
      return result;
    } catch (e) {
      const m = cahioraMessage(e);
      if (m) throw new BadRequestException(m);
      throw e;
    }
  }

  /**
   * Avoirs et crédits : crédit de chaque établissement (solde, réservé, disponible) et ses écritures, avoirs émis et
   * leur imputation, demandes de remboursement et décisions, transferts dans les groupes.
   */
  async credits() {
    const tenants = await this.db.tenant.findMany({
      orderBy: { name: 'asc' }, select: { id: true, name: true, currency: true, groupId: true, group: { select: { id: true, name: true, _count: { select: { tenants: true } } } } },
    });
    const names = new Map(tenants.map((t) => [t.id, t.name]));
    const entries = await this.db.billingCreditEntry.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 500, include: { payment: { select: { receiptNumber: true } }, document: { select: { reference: true } } },
    });
    const withCredit = new Set(entries.map((e) => e.tenantId));
    const establishments = [];
    for (const t of tenants) {
      const multi = t.group._count.tenants > 1;
      if (!withCredit.has(t.id) && !multi) continue;
      establishments.push({
        tenantId: t.id, name: t.name, currency: t.currency, group: { id: t.group.id, name: t.group.name, size: t.group._count.tenants }, credit: await this.credit(this.db, t.id),
        entries: entries.filter((e) => e.tenantId === t.id).slice(0, 50).map((e) => ({
          id: e.id, kind: e.kind, label: CREDIT_ENTRY_LABELS[e.kind as CreditEntryKind], amount: e.amount, createdAt: e.createdAt, createdByName: e.createdByName,
          receiptNumber: e.payment?.receiptNumber ?? null, documentReference: e.document?.reference ?? null, data: e.data,
        })),
      });
    }
    const refunds = await this.db.billingRefund.findMany({ orderBy: { requestedAt: 'desc' }, take: 200 });
    const transfers = await this.db.billingCreditTransfer.findMany({ orderBy: { createdAt: 'desc' }, take: 200, include: { group: { select: { name: true } } } });
    const notes = await this.db.billingDocument.findMany({
      where: { kind: 'CREDIT_NOTE' }, orderBy: [{ issueDate: 'desc' }, { createdAt: 'desc' }], take: 300,
      include: {
        lines: { select: { tenantId: true } }, related: { select: { reference: true } },
        creditAllocations: { include: { document: { select: { reference: true } } } }, creditEntries: { where: { kind: 'CREDIT_NOTE_SURPLUS' }, select: { amount: true } },
      },
    });
    return {
      unlocked: paymentsUnlocked(), lockMessage: paymentsUnlocked() ? null : PAYMENTS_LOCKED,
      establishments,
      creditNotes: notes.map((d) => {
        const credit = d.creditEntries.reduce((n, e) => n + e.amount, 0);
        const imputed = d.creditAllocations.length > 0 || credit > 0;
        const tenantId = d.lines[0]?.tenantId ?? null;
        return {
          id: d.id, reference: d.reference, issueDate: iso(d.issueDate), currency: d.currency, total: d.total, relatedReference: d.related?.reference ?? null,
          tenantName: tenantId ? names.get(tenantId) ?? null : null, state: imputed ? 'IMPUTED' : 'GROUP_PENDING',
          stateLabel: imputed ? 'Imputé' : GROUP_PAYMENT_PENDING,
          allocations: d.creditAllocations.map((a) => ({ reference: a.document.reference, amount: a.amount })), credit,
        };
      }),
      refunds: refunds.map((r) => ({
        id: r.id, tenantId: r.tenantId, tenantName: names.get(r.tenantId) ?? '', currency: r.currency, amount: r.amount, status: r.status,
        statusLabel: REFUND_STATUS_LABELS[r.status as RefundStatus], message: r.message, requestedByName: r.requestedByName, requestedAt: r.requestedAt,
        decidedByName: r.decidedByName, decidedAt: r.decidedAt, decisionNote: r.decisionNote, refundedOn: iso(r.refundedOn), refundMeans: r.refundMeans, refundRef: r.refundRef,
        proofUrl: r.proofKey ? this.files.signedUrl(r.proofKey) : null,
      })),
      transfers: transfers.map((x) => ({
        id: x.id, groupName: x.group.name, fromName: names.get(x.fromTenantId) ?? '', toName: names.get(x.toTenantId) ?? '', currency: x.currency, amount: x.amount,
        authorizedBy: x.authorizedBy, reason: x.reason, createdByName: x.createdByName, createdAt: x.createdAt, proofUrl: x.proofKey ? this.files.signedUrl(x.proofKey) : null,
      })),
    };
  }

  /**
   * Décision du Super Admin sur une demande de remboursement, une seule fois, avec le code de l'application : un
   * remboursement porte sa preuve (date, moyen, référence, justificatif) et retire le montant du crédit ; un refus porte
   * son motif et libère le montant réservé, aussitôt déduit des documents à payer s'il y en a.
   */
  async decideRefund(actor: PlatformActor, id: string, dto: RefundDecisionDto, file?: Express.Multer.File) {
    const r = await this.db.billingRefund.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Demande de remboursement introuvable');
    if (r.status !== 'PENDING') throw new ConflictException('Cette demande est déjà décidée');
    const t = await this.tenant(r.tenantId);
    const today = localDay(t.timezone);
    const error = refundDecisionError(dto, today, localDay(t.timezone, r.requestedAt));
    if (error) throw new BadRequestException(error);
    const refunded = dto.decision === 'REFUNDED';
    if (refunded && !file) throw new BadRequestException('Preuve du remboursement : joignez le justificatif (photo ou PDF)');
    await this.billing.confirm(actor, dto.code);
    const key = refunded ? await this.files.save(t.id, 'remboursements-cahiora', file!) : null;
    try {
      const result = await this.files.commit(key, async () => ({
        result: await this.db.$transaction(async (tx) => {
          const [d] = await tx.$queryRaw<DecisionRow[]>`
            SELECT * FROM decide_billing_refund(${id}::uuid, ${dto.decision}, ${dto.note?.trim() || null}, ${refunded ? dto.refundedOn! : null}::date,
              ${refunded ? dto.means!.trim() : null}, ${refunded ? dto.reference!.trim() : null}, ${key}, ${refunded ? file!.mimetype : null}, ${actor.id}::uuid, ${actor.name},
              ${actor.ip ?? null}, ${today}::date)`;
          const data = refunded
            ? { refundId: id, amount: d.refund_amount, refundedOn: dto.refundedOn, means: dto.means!.trim(), reference: dto.reference!.trim() }
            : { refundId: id, amount: d.refund_amount, note: dto.note!.trim() };
          await paymentJournals(tx, actor, t, refunded ? 'billing.refund_refunded' : 'billing.refund_refused', data);
          const used = refunded ? null : await useCredit(tx, t, actor);
          await notifyDirection(tx, t.id, refunded ? 'billing.refund_refunded' : 'billing.refund_refused',
            refunded ? `Remboursement de Cahiora : ${money(d.refund_amount, t.currency)}` : 'Demande de remboursement refusée par Cahiora',
            refunded
              ? `Cahiora vous a remboursé ${money(d.refund_amount, t.currency)} de votre crédit le ${dayLabel(dto.refundedOn!)} (${dto.means!.trim()}, référence ${dto.reference!.trim()}).`
              : [`Cahiora a refusé votre demande de remboursement de ${money(d.refund_amount, t.currency)} : ${dto.note!.trim()} Le montant reste dans votre crédit.`,
                used ? creditSentence(used, t.currency) : '', used ? accessSentence(used.access, t.currency) : ''].filter(Boolean).join(' '));
          return { id, status: d.refund_status, statusLabel: REFUND_STATUS_LABELS[d.refund_status as RefundStatus], amount: d.refund_amount, creditUsed: used?.used ?? 0 };
        }, { timeout: 60000 }),
      }));
      forgetAccess(t.id);
      return result;
    } catch (e) {
      const m = cahioraMessage(e);
      if (m) throw new BadRequestException(m);
      throw e;
    }
  }

  /**
   * Transfert d'un crédit entre deux établissements d'un même groupe (§9), avec l'autorisation (qui l'a donnée, par quel
   * écrit, joint s'il y en a un), un motif et le code de l'application ; deux écritures et une trace dans les journaux.
   */
  async transfer(actor: PlatformActor, dto: CreditTransferDto, file?: Express.Multer.File) {
    const from = await this.tenant(dto.fromTenantId);
    const to = await this.tenant(dto.toTenantId);
    const amount = Number(dto.amount);
    const c = await this.credit(this.db, from.id);
    const error = transferError({
      fromGroupId: from.groupId, toGroupId: to.groupId, fromCurrency: from.currency, toCurrency: to.currency, sameTenant: from.id === to.id, amount, available: c.available,
      authorizedBy: dto.authorizedBy, reason: dto.reason,
    });
    if (error) throw new BadRequestException(error);
    await this.billing.confirm(actor, dto.code);
    const key = file ? await this.files.save(from.id, 'transferts-credit', file) : null;
    try {
      const result = await this.files.commit(key, async () => ({
        result: await this.db.$transaction(async (tx) => {
          const [r] = await tx.$queryRaw<{ id: string }[]>`
            SELECT transfer_billing_credit(${from.id}::uuid, ${to.id}::uuid, ${amount}::integer, ${dto.authorizedBy}, ${dto.reason}, ${key}, ${file?.mimetype ?? null},
              ${actor.id}::uuid, ${actor.name}, ${actor.ip ?? null}) AS id`;
          const data = { transferId: r.id, amount, currency: from.currency, from: from.name, to: to.name, authorizedBy: dto.authorizedBy.trim() };
          await paymentJournals(tx, actor, from, 'billing.credit_transferred_out', data, { reason: dto.reason.trim() });
          await paymentJournals(tx, actor, to, 'billing.credit_transferred_in', data, { reason: dto.reason.trim() });
          const used = await useCredit(tx, to, actor);
          return { id: r.id, amount, creditUsed: used?.used ?? 0 };
        }, { timeout: 60000 }),
      }));
      forgetAccess(to.id);
      return result;
    } catch (e) {
      const m = cahioraMessage(e);
      if (m) throw new BadRequestException(m);
      throw e;
    }
  }

  /**
   * Rapports financiers (§14) : facturé (documents provisoires) et encaissé (paiements validés) séparés, avoirs,
   * remboursements, impayés et crédits disponibles, par monnaie ; filtres de période, d'établissement, de groupe et
   * d'état (l'état filtre la liste des documents ; les totaux suivent la période, l'établissement et le groupe).
   */
  async reports(q: ReportQueryDto) {
    if (q.from && q.to && q.from > q.to) throw new BadRequestException('Période : la date de début vient après la date de fin');
    let tenantIds: string[] | null = null;
    if (q.groupId) tenantIds = (await this.db.tenant.findMany({ where: { groupId: q.groupId }, select: { id: true } })).map((t) => t.id);
    if (q.tenantId) tenantIds = tenantIds ? tenantIds.filter((id) => id === q.tenantId) : [q.tenantId];
    const totals = await financialTotals(this.db, { from: q.from, to: q.to, tenantIds });
    const docs = await this.db.billingDocument.findMany({
      where: {
        kind: 'SUBSCRIPTION', issueDate: { gte: q.from ? new Date(`${q.from}T00:00:00.000Z`) : undefined, lte: q.to ? new Date(`${q.to}T00:00:00.000Z`) : undefined },
        ...(tenantIds ? { lines: { some: { tenantId: { in: tenantIds } } } } : {}),
      },
      orderBy: [{ issueDate: 'desc' }, { createdAt: 'desc' }], take: 500,
      include: { group: { select: { id: true, name: true } }, lines: { select: { tenantId: true, tenant: { select: { name: true, timezone: true } } } } },
    });
    const payable = new Map<string, PayableRow>();
    for (const tenantId of [...new Set(docs.filter((d) => new Set(d.lines.map((l) => l.tenantId)).size === 1).map((d) => d.lines[0].tenantId))]) {
      for (const row of await this.db.$queryRaw<PayableRow[]>`SELECT * FROM billing_payable_documents(${tenantId}::uuid)`) payable.set(row.document_id, row);
    }
    const documents = [];
    for (const d of docs) {
      const tenants = [...new Map(d.lines.map((l) => [l.tenantId, l.tenant])).entries()];
      const single = tenants.length === 1;
      const today = localDay(tenants[0]?.[1].timezone ?? PLATFORM_TZ);
      const row = payable.get(d.id);
      const p = single
        ? documentPayment({ total: d.total, credited: row?.credited ?? 0, paid: row?.paid ?? 0, dueDate: iso(d.dueDate) }, today)
        : null;
      if (q.status && (!p || !matchesStatus(p, q.status))) continue;
      documents.push({
        id: d.id, reference: d.reference, issueDate: iso(d.issueDate), dueDate: iso(d.dueDate), currency: d.currency, total: d.total, group: d.group,
        establishments: tenants.map(([id, x]) => ({ id, name: x.name })),
        payment: p ?? { status: 'GROUP_PENDING', label: GROUP_PAYMENT_PENDING, overdue: false, due: null, paid: null, balance: null },
      });
    }
    const payments = await this.db.billingPayment.findMany({
      where: {
        paidOn: { gte: q.from ? new Date(`${q.from}T00:00:00.000Z`) : undefined, lte: q.to ? new Date(`${q.to}T00:00:00.000Z`) : undefined },
        ...(tenantIds ? { tenantId: { in: tenantIds } } : {}),
      },
      orderBy: [{ paidOn: 'desc' }, { recordedAt: 'desc' }], take: 500, include: PAYMENT_INCLUDE,
    });
    return {
      filters: { from: q.from ?? null, to: q.to ?? null, tenantId: q.tenantId ?? null, groupId: q.groupId ?? null, status: q.status ?? null },
      totals, documents, payments: payments.map(paymentView), mention: RECEIPT_MENTION,
      groups: await this.db.schoolGroup.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
      tenants: await this.db.tenant.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, groupId: true } }),
    };
  }
}

@ApiTags('Plateforme : facturation')
@Public()
@UseGuards(PlatformGuard)
@Controller()
export class BillingPaymentsController {
  constructor(private s: BillingPaymentsService) {}

  private actor(req: Request) {
    return (req as any).platformAdmin as PlatformActor;
  }

  @Get('platform/billing/payments') @Header('Cache-Control', 'no-store')
  overview() { return this.s.overview(); }

  @Get('platform/billing/payments/:id') @Header('Cache-Control', 'no-store')
  payment(@Param('id', ParseUUIDPipe) id: string) { return this.s.payment(id); }

  @Post('platform/billing/payment-means') @PaymentsOpen() @Throttle({ default: { limit: 20, ttl: 60000 } })
  addMeans(@Req() req: Request, @Body() dto: PaymentMeansDto) { return this.s.addMeans(this.actor(req), dto); }

  @Post('platform/billing/payments') @PaymentsOpen()
  @ApiConsumes('multipart/form-data')
  @Throttle(UPLOAD_THROTTLE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  record(@Req() req: Request, @Body() dto: RecordPaymentDto, @UploadedFile() file?: Express.Multer.File) { return this.s.record(this.actor(req), dto, file); }

  @Post('platform/billing/payments/:id/cancel') @PaymentsOpen() @Throttle({ default: { limit: 20, ttl: 60000 } })
  cancel(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelPaymentDto) { return this.s.cancel(this.actor(req), id, dto); }

  @Get('platform/billing/credits') @Header('Cache-Control', 'no-store')
  credits() { return this.s.credits(); }

  @Post('platform/billing/refunds/:id/decision') @PaymentsOpen()
  @ApiConsumes('multipart/form-data')
  @Throttle(UPLOAD_THROTTLE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  decideRefund(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RefundDecisionDto, @UploadedFile() file?: Express.Multer.File) {
    return this.s.decideRefund(this.actor(req), id, dto, file);
  }

  @Post('platform/billing/credit-transfers') @PaymentsOpen()
  @ApiConsumes('multipart/form-data')
  @Throttle(UPLOAD_THROTTLE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  transfer(@Req() req: Request, @Body() dto: CreditTransferDto, @UploadedFile() file?: Express.Multer.File) { return this.s.transfer(this.actor(req), dto, file); }

  @Get('platform/billing/reports') @Header('Cache-Control', 'no-store')
  reports(@Query() q: ReportQueryDto) { return this.s.reports(q); }
}

// ---------------------------------------------------------------- Direction de l'établissement

type BalanceRow = { document_id: string; total: number; credited: number; paid: number; balance: number };
type SchoolPaymentRow = {
  id: string; receipt_number: string; document_reference: string; currency: string; expected_amount: number; amount: number; paid_on: Date; means_name: string;
  transaction_ref: string; credit_amount: number; recorded_at: Date; cancelled_at: Date | null; allocations: { reference: string; amount: number }[];
};
type SchoolEntryRow = { id: string; kind: CreditEntryKind; amount: number; currency: string; created_at: Date; receipt_number: string | null; document_reference: string | null; documents: unknown };
type SchoolRefundRow = {
  id: string; amount: number; currency: string; status: RefundStatus; message: string | null; requested_by_name: string; requested_at: Date; decided_at: Date | null;
  decision_note: string | null; refunded_on: Date | null; refund_means: string | null; refund_ref: string | null;
};

const schoolReceipt = (r: SchoolPaymentRow, payer: string) => receiptView({
  receiptNumber: r.receipt_number, payer, group: null, documentReference: r.document_reference, currency: r.currency, expectedAmount: r.expected_amount, amount: r.amount,
  paidOn: iso(r.paid_on)!, meansName: r.means_name, transactionRef: r.transaction_ref, creditAmount: r.credit_amount, recordedAt: r.recorded_at, cancelledAt: r.cancelled_at,
  allocations: r.allocations, agent: null,
});

/**
 * Paiements vus par la direction, école courante seulement (transaction ouverte sur elle), par les fonctions de la
 * base : état du paiement de chaque document, reçus provisoires, crédit et ses écritures, demandes de remboursement,
 * moyens de paiement activés (aucun tant que le verrou 1 est fermé). Jamais le nom de l'agent de Cahiora, le
 * justificatif, le commentaire interne ni le motif d'une annulation. Vide pour l'école d'un groupe (D-G5-19).
 */
export async function schoolPayments(tx: Tx, today: string) {
  const unlocked = paymentsUnlocked();
  const balances = await tx.$queryRaw<BalanceRow[]>`SELECT * FROM current_tenant_billing_balances()`;
  const payments = await tx.$queryRaw<SchoolPaymentRow[]>`SELECT * FROM current_tenant_billing_payments()`;
  const [c] = await tx.$queryRaw<{ balance: number; reserved: number }[]>`SELECT * FROM current_tenant_billing_credit()`;
  const entries = await tx.$queryRaw<SchoolEntryRow[]>`SELECT * FROM current_tenant_billing_credit_entries()`;
  const refunds = await tx.$queryRaw<SchoolRefundRow[]>`SELECT * FROM current_tenant_billing_refunds()`;
  const means = unlocked ? await tx.$queryRaw<{ code: string; name: string; instructions: string }[]>`SELECT * FROM current_tenant_payment_means(${today}::date)` : [];
  const credit = { balance: c?.balance ?? 0, reserved: c?.reserved ?? 0, available: availableCredit(c?.balance ?? 0, c?.reserved ?? 0) };
  const pending = refunds.some((r) => r.status === 'PENDING');
  return {
    unlocked,
    balances: new Map(balances.map((b) => [b.document_id, b])),
    receipts: payments.map((p) => ({
      id: p.id, receiptNumber: p.receipt_number, documentReference: p.document_reference, currency: p.currency, amount: p.amount, paidOn: iso(p.paid_on), meansName: p.means_name,
      transactionRef: p.transaction_ref, creditAmount: p.credit_amount, recordedAt: p.recorded_at, cancelled: !!p.cancelled_at, allocations: p.allocations,
      statusLabel: p.cancelled_at ? 'Saisie annulée par Cahiora' : 'Paiement validé par Cahiora',
    })),
    credit: {
      ...credit,
      entries: entries.map((e) => ({
        id: e.id, kind: e.kind, label: CREDIT_ENTRY_LABELS[e.kind], amount: e.amount, createdAt: e.created_at, receiptNumber: e.receipt_number, documentReference: e.document_reference,
        documents: e.documents,
      })),
    },
    refunds: refunds.map((r) => ({
      id: r.id, amount: r.amount, currency: r.currency, status: r.status, statusLabel: REFUND_STATUS_LABELS[r.status], message: r.message, requestedByName: r.requested_by_name,
      requestedAt: r.requested_at, decidedAt: r.decided_at, decisionNote: r.decision_note, refundedOn: iso(r.refunded_on), refundMeans: r.refund_means, refundRef: r.refund_ref,
    })),
    /** La direction peut demander le remboursement de son crédit disponible (verrou 1 ouvert, aucune demande en attente). */
    refundOpen: unlocked && credit.available > 0 && !pending,
    refundNote: !unlocked ? REFUNDS_CLOSED : pending ? 'Une demande de remboursement attend la décision de Cahiora : son montant est réservé.' : null,
    means,
  };
}

@Injectable()
export class SchoolBillingPaymentsService {
  constructor(private db: PrismaService, private audit: AuditService) {}

  /** Reçu provisoire d'un paiement de l'école, à imprimer. */
  receipt(actor: Actor, id: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const t = await tx.tenant.findUniqueOrThrow({ where: { id: actor.tenantId }, select: { name: true } });
      const [r] = await tx.$queryRaw<SchoolPaymentRow[]>`SELECT * FROM current_tenant_billing_payments() WHERE id = ${id}::uuid`;
      if (!r) throw new NotFoundException('Reçu introuvable');
      return schoolReceipt(r, t.name);
    });
  }

  /**
   * Demande de remboursement du crédit disponible (D-G5-15 A) par la direction de tout l'établissement : une à la fois,
   * au plus le crédit disponible, aussitôt réservé. La base refait chaque contrôle, horodate la demande et l'inscrit dans
   * les journaux de la plateforme et du groupe, avec une alerte pour le Super Admin ; l'API trace le journal de l'école.
   */
  requestRefund(actor: Actor, dto: RefundRequestDto) {
    const message = dto.message?.trim() || null;
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const [c] = await tx.$queryRaw<{ balance: number; reserved: number }[]>`SELECT * FROM current_tenant_billing_credit()`;
      if (!c) throw new ConflictException('Le crédit d’un établissement de groupe attend la décision D-G5-19');
      const [p] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::integer AS n FROM current_tenant_billing_refunds() WHERE status = 'PENDING'`;
      const error = refundRequestError(dto.amount, availableCredit(c.balance, c.reserved), p.n > 0);
      if (error) throw new BadRequestException(error);
      try {
        const [r] = await tx.$queryRaw<{ id: string }[]>`SELECT request_billing_refund(${actor.userId}::uuid, ${actor.name}, ${dto.amount}::integer, ${message}, ${actor.ip ?? null}) AS id`;
        await this.audit.log(tx, actor, 'billing.refund_requested', 'BillingRefund', r.id, { amount: dto.amount, message });
        return { id: r.id, amount: dto.amount };
      } catch (e) {
        const m = cahioraMessage(e);
        if (m) throw new BadRequestException(m);
        throw e;
      }
    });
  }
}

@ApiTags('Paramètres')
@Controller()
export class SchoolBillingPaymentsController {
  constructor(private s: SchoolBillingPaymentsService) {}

  @Get('settings/subscription/receipts/:id') @Can('settings.manage') @Header('Cache-Control', 'no-store')
  receipt(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.s.receipt(a, id); }

  /** Fermée pendant l'accès limité : seules la consultation, l'impression, l'export, la caisse et la régularisation y restent. */
  @Post('settings/subscription/refund-requests') @PaymentsOpen() @Can('settings.manage')
  @WholeSchool('Seule la direction de tout l’établissement demande un remboursement')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  requestRefund(@CurrentActor() a: Actor, @Body() dto: RefundRequestDto) { return this.s.requestRefund(a, dto); }
}
