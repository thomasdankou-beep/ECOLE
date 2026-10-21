import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Payment, Prisma } from '@prisma/client';
import { Actor } from '../../common/auth';
import { AuditService } from '../../common/audit.service';
import { PrismaService, Tx } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { fcfa, isoDay, nextNumber, pad, toDate, verifyCode } from '../../common/util';
import { NotificationsService } from '../notifications/notifications.service';
import { BatchInvoiceDto, CashClosingDto, DeskPaymentDto, FeeGridDto, FeeTypeDto, InvoiceDto, RemindDto } from './finance.dto';
import { FilesService } from '../files/files.service';
import { schoolIdentity } from '../settings/settings.service';

const METHOD_LABEL: Record<string, string> = {
  CASH: 'Espèces', CHEQUE: 'Chèque', TRANSFER: 'Virement', MOBILE_MONEY_DESK: 'Mobile Money (au bureau)', ONLINE: 'Paiement en ligne',
};

@Injectable()
export class FinanceService {
  constructor(
    private db: PrismaService,
    private scope: ScopeService,
    private audit: AuditService,
    private notifications: NotificationsService,
    private files: FilesService,
  ) {}

  /** Reste à payer par élève (factures non annulées). */
  async balances(tx: Tx, studentIds: string[]): Promise<Map<string, number>> {
    if (!studentIds.length) return new Map();
    const rows = await tx.invoice.groupBy({
      by: ['studentId'],
      where: { studentId: { in: studentIds }, status: { not: 'CANCELLED' } },
      _sum: { total: true, paid: true },
    });
    return new Map(rows.map((r) => [r.studentId, (r._sum.total ?? 0) - (r._sum.paid ?? 0)]));
  }

  // ------------------------------------------------------------ Catalogue des frais
  feeTypes(actor: Actor) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const yearId = await this.scope.currentYearId(tx);
      return tx.feeType.findMany({ where: { academicYearId: yearId }, orderBy: [{ active: 'desc' }, { name: 'asc' }] });
    });
  }

  createFeeType(actor: Actor, dto: FeeTypeDto) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const academicYearId = await this.scope.currentYearId(tx);
      const f = await tx.feeType.create({ data: { ...dto, dueDate: dto.dueDate ? toDate(dto.dueDate) : null, tenantId: actor.tenantId, academicYearId } });
      await this.audit.log(tx, actor, 'fee_type.created', 'FeeType', f.id, dto);
      return f;
    });
  }

  /** Grille des montants par niveau et filière : un frais par combinaison, les factures déjà émises ne changent pas. */
  saveFeeGrid(actor: Actor, dto: FeeGridDto) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const academicYearId = await this.scope.currentYearId(tx);
      const dueDate = dto.dueDate ? toDate(dto.dueDate) : undefined;
      let saved = 0;
      for (const r of dto.rows) {
        const trackId = r.trackId ?? null;
        const existing = await tx.feeType.findFirst({ where: { academicYearId, name: dto.name, levelId: r.levelId, trackId } });
        if (r.amount === null || r.amount === undefined) {
          if (existing?.active) await tx.feeType.update({ where: { id: existing.id }, data: { active: false } });
          continue;
        }
        const kind = { ...(dto.audience ? { audience: dto.audience } : {}), ...(dto.optional !== undefined ? { optional: dto.optional } : {}) };
        if (existing) await tx.feeType.update({ where: { id: existing.id }, data: { amount: r.amount, active: true, ...(dueDate ? { dueDate } : {}), ...kind } });
        else await tx.feeType.create({ data: { tenantId: actor.tenantId, academicYearId, name: dto.name, levelId: r.levelId, trackId, amount: r.amount, dueDate: dueDate ?? null, ...kind } });
        saved++;
      }
      await this.audit.log(tx, actor, 'fee_type.grid', 'FeeType', null, { name: dto.name, rows: dto.rows.length, saved });
      return { saved };
    });
  }

  updateFeeType(actor: Actor, id: string, dto: Partial<FeeTypeDto>) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const f = await tx.feeType.update({ where: { id }, data: { ...dto, dueDate: dto.dueDate ? toDate(dto.dueDate) : undefined } });
      await this.audit.log(tx, actor, 'fee_type.updated', 'FeeType', id, dto);
      return f;
    });
  }

  private async newInvoice(tx: Tx, actor: Actor, studentId: string, label: string, dueDate: Date, items: { label: string; amount: number; feeTypeId?: string }[]) {
    const total = items.reduce((a, i) => a + i.amount, 0);
    const year = new Date().getUTCFullYear();
    const number = `FAC-${year}-${pad(await nextNumber(tx, actor.tenantId, `invoice-${year}`))}`;
    return tx.invoice.create({
      data: {
        tenantId: actor.tenantId, number, studentId, label, total, dueDate, createdById: actor.userId,
        items: { create: items.map((i) => ({ tenantId: actor.tenantId, label: i.label, amount: i.amount, feeTypeId: i.feeTypeId })) },
      },
    });
  }

  /**
   * Factures d'un inscrit d'après le catalogue de sa classe (niveau et filière) : frais de tous,
   * plus ceux des nouveaux (inscription) ou des anciens élèves (réinscription). Les frais facultatifs ne sont jamais facturés d'office.
   */
  async invoiceFromCatalog(tx: Tx, actor: Actor, studentId: string, classId: string, returning = false): Promise<number> {
    const klass = await tx.class.findUniqueOrThrow({ where: { id: classId } });
    const fees = await tx.feeType.findMany({
      where: {
        academicYearId: klass.academicYearId, active: true, optional: false, audience: { in: ['ALL', returning ? 'RETURNING' : 'NEW'] },
        AND: [{ OR: [{ levelId: null }, { levelId: klass.levelId }] }, { OR: [{ trackId: null }, { trackId: klass.trackId }] }],
      },
    });
    for (const f of fees) {
      if (!f.amount) continue;
      await this.newInvoice(tx, actor, studentId, f.name, f.dueDate ?? new Date(), [{ label: f.name, amount: f.amount, feeTypeId: f.id }]);
    }
    return fees.filter((f) => f.amount).length;
  }

  // ------------------------------------------------------------ Factures
  invoices(actor: Actor, filters: { studentId?: string; status?: string; classId?: string }) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const visible = await this.scope.studentIds(tx, actor);
      if (filters.studentId) await this.scope.assertStudent(tx, actor, filters.studentId);
      const yearId = await this.scope.currentYearId(tx);
      const rows = await tx.invoice.findMany({
        where: {
          ...(visible ? { studentId: { in: visible } } : {}),
          ...(filters.studentId ? { studentId: filters.studentId } : {}),
          ...(filters.status ? { status: filters.status as any } : {}),
          ...(filters.classId ? { student: { enrollments: { some: { classId: filters.classId, academicYearId: yearId } } } } : {}),
        },
        include: {
          items: true,
          student: { select: { id: true, matricule: true, firstName: true, lastName: true } },
          payments: { where: { status: 'SUCCESS' }, select: { id: true, amount: true, method: true, operator: true, confirmedAt: true, receipt: { select: { id: true, number: true, cancelledAt: true } } }, orderBy: { confirmedAt: 'desc' } },
        },
        orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
        take: 1000,
      });
      return rows.map((r) => ({ ...r, remaining: r.status === 'CANCELLED' ? 0 : r.total - r.paid }));
    });
  }

  createInvoice(actor: Actor, dto: InvoiceDto) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const inv = await this.newInvoice(tx, actor, dto.studentId, dto.label, toDate(dto.dueDate), dto.items);
      await this.audit.log(tx, actor, 'invoice.created', 'Invoice', inv.id, { number: inv.number, total: inv.total });
      return inv;
    });
  }

  /** Facturation en lot d'un tarif pour une classe ou pour tous les élèves concernés (CDC §4.4). */
  batchInvoice(actor: Actor, dto: BatchInvoiceDto) {
    return this.db.forTenant(
      actor.tenantId,
      async (tx) => {
        const fee = await tx.feeType.findUniqueOrThrow({ where: { id: dto.feeTypeId } });
        const enr = await tx.enrollment.findMany({
          where: {
            academicYearId: fee.academicYearId, status: 'ACTIVE',
            ...(dto.classId ? { classId: dto.classId } : {}),
            class: { ...(fee.levelId ? { levelId: fee.levelId } : {}), ...(fee.trackId ? { trackId: fee.trackId } : {}) },
          },
          select: { studentId: true },
        });
        const already = await tx.invoiceItem.findMany({ where: { feeTypeId: fee.id, invoice: { status: { not: 'CANCELLED' } } }, select: { invoice: { select: { studentId: true } } } });
        const skip = new Set(already.map((a) => a.invoice.studentId));
        let created = 0;
        for (const e of enr) {
          if (skip.has(e.studentId)) continue;
          await this.newInvoice(tx, actor, e.studentId, fee.name, fee.dueDate ?? new Date(), [{ label: fee.name, amount: fee.amount, feeTypeId: fee.id }]);
          created++;
        }
        await this.audit.log(tx, actor, 'invoice.batch', 'FeeType', fee.id, { created, skipped: skip.size });
        return { created, alreadyInvoiced: enr.length - created };
      },
      { timeout: 120000 },
    );
  }

  cancelInvoice(actor: Actor, id: string, reason: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const inv = await tx.invoice.findUniqueOrThrow({ where: { id } });
      if (inv.paid > 0) throw new ConflictException('Cette facture a déjà reçu des paiements : annulez d’abord les reçus par un avoir');
      await tx.invoice.update({ where: { id }, data: { status: 'CANCELLED' } });
      await this.audit.log(tx, actor, 'invoice.cancelled', 'Invoice', id, { reason });
      return { ok: true };
    });
  }

  // ------------------------------------------------------------ Encaissements
  deskPayment(actor: Actor, dto: DeskPaymentDto) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      if (dto.idempotencyKey) {
        const prev = await tx.payment.findUnique({ where: { idempotencyKey: dto.idempotencyKey }, include: { receipt: true } });
        if (prev) return { payment: prev, receipt: prev.receipt, duplicate: true };
      }
      const inv = await tx.invoice.findUniqueOrThrow({ where: { id: dto.invoiceId } });
      this.assertPayable(inv, dto.amount);
      const year = new Date().getUTCFullYear();
      const payment = await tx.payment.create({
        data: {
          tenantId: actor.tenantId, invoiceId: inv.id, studentId: inv.studentId, amount: dto.amount, method: dto.method,
          providerRef: dto.reference, transactionId: `DESK-${actor.tenantId.slice(0, 8)}-${year}-${pad(await nextNumber(tx, actor.tenantId, `desk-${year}`), 6)}`,
          idempotencyKey: dto.idempotencyKey, status: 'SUCCESS', receivedById: actor.userId, confirmedAt: new Date(),
        },
      });
      const receipt = await this.applyPayment(tx, actor, payment);
      return { payment, receipt, duplicate: false };
    });
  }

  assertPayable(inv: { status: string; total: number; paid: number }, amount: number) {
    if (inv.status === 'CANCELLED') throw new BadRequestException('Facture annulée');
    const remaining = inv.total - inv.paid;
    if (remaining <= 0) throw new BadRequestException('Cette facture est déjà soldée');
    if (amount > remaining) throw new BadRequestException(`Le montant dépasse le reste à payer (${fcfa(remaining)})`);
  }

  /**
   * Rapprochement : met à jour la facture, émet le reçu numéroté avec QR de vérification
   * et prévient les responsables. Appelé au guichet et à la confirmation de l'opérateur.
   */
  async applyPayment(tx: Tx, actor: Actor | null, payment: Payment) {
    const inv = await tx.invoice.findUniqueOrThrow({ where: { id: payment.invoiceId }, include: { student: true } });
    const paid = inv.paid + payment.amount;
    await tx.invoice.update({ where: { id: inv.id }, data: { paid, status: paid >= inv.total ? 'PAID' : 'PARTIAL' } });
    const year = new Date().getUTCFullYear();
    const number = `REC-${year}-${pad(await nextNumber(tx, payment.tenantId, `receipt-${year}`))}`;
    const code = verifyCode();
    const receipt = await tx.receipt.create({ data: { tenantId: payment.tenantId, number, paymentId: payment.id, verifyCode: code } });
    await tx.verificationEntry.create({
      data: {
        code, tenantId: payment.tenantId, kind: 'Reçu de paiement', issuedAt: receipt.issuedAt,
        summary: `Reçu ${number} · ${inv.student.firstName} ${inv.student.lastName.charAt(0)}. · ${fcfa(payment.amount)} · ${inv.label}`,
      },
    });
    await this.audit.log(tx, actor, 'payment.confirmed', 'Payment', payment.id, { tenantId: payment.tenantId, amount: payment.amount, method: payment.method, receipt: number });
    const parents = await this.notifications.guardianUserIds(tx, inv.studentId);
    const left = inv.total - paid;
    await this.notifications.notify(tx, payment.tenantId, parents, {
      kind: 'payment',
      title: 'Paiement reçu',
      body: `Paiement de ${fcfa(payment.amount)} reçu pour ${inv.student.firstName} (${inv.label}). Reçu ${number}. ${left > 0 ? `Reste à payer : ${fcfa(left)}.` : 'Facture soldée.'}`,
      sms: `Paiement de ${fcfa(payment.amount)} reçu pour ${inv.student.firstName}. Reçu ${number}.`,
      data: { receiptId: receipt.id, invoiceId: inv.id },
      smsMode: 'fallback',
    });
    return receipt;
  }

  /** Un reçu ne se supprime jamais : il est annulé par un avoir, la facture est réouverte (CDC §4.4). */
  cancelReceipt(actor: Actor, id: string, reason: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const r = await tx.receipt.findUniqueOrThrow({ where: { id }, include: { payment: true } });
      if (r.cancelledAt) throw new ConflictException('Ce reçu est déjà annulé');
      await tx.receipt.update({ where: { id }, data: { cancelledAt: new Date(), cancelReason: reason, cancelledById: actor.userId } });
      await tx.payment.update({ where: { id: r.paymentId }, data: { status: 'CANCELLED' } });
      const inv = await tx.invoice.findUniqueOrThrow({ where: { id: r.payment.invoiceId } });
      const paid = inv.paid - r.payment.amount;
      await tx.invoice.update({ where: { id: inv.id }, data: { paid, status: paid <= 0 ? 'OPEN' : 'PARTIAL' } });
      await tx.verificationEntry.update({ where: { code: r.verifyCode }, data: { revokedAt: new Date() } });
      await this.audit.log(tx, actor, 'receipt.cancelled', 'Receipt', id, { number: r.number, amount: r.payment.amount, reason });
      return { ok: true };
    });
  }

  receipt(actor: Actor, id: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const r = await tx.receipt.findUnique({
        where: { id },
        include: {
          payment: {
            include: {
              invoice: { select: { number: true, label: true, total: true, paid: true } },
              student: { select: { id: true, matricule: true, firstName: true, lastName: true, enrollments: { select: { class: { select: { name: true, site: { select: { name: true } } } } }, orderBy: { enrolledAt: 'desc' }, take: 1 } } },
            },
          },
        },
      });
      if (!r) throw new NotFoundException('Reçu introuvable');
      await this.scope.assertStudent(tx, actor, r.payment.studentId);
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: actor.tenantId }, select: { name: true, settings: true } });
      return { ...r, methodLabel: METHOD_LABEL[r.payment.method], tenant: { name: tenant.name }, identity: schoolIdentity(tenant, this.files) };
    });
  }

  payments(actor: Actor, filters: { status?: string; method?: string; from?: string; to?: string }) {
    return this.db.forTenant(actor.tenantId, (tx) =>
      tx.payment.findMany({
        where: {
          ...(filters.status ? { status: filters.status as any } : {}),
          ...(filters.method ? { method: filters.method as any } : {}),
          ...(filters.from || filters.to ? { createdAt: { gte: filters.from ? toDate(filters.from) : undefined, lt: filters.to ? new Date(toDate(filters.to).getTime() + 86400000) : undefined } } : {}),
        },
        include: { student: { select: { matricule: true, firstName: true, lastName: true } }, receipt: { select: { id: true, number: true, cancelledAt: true } }, invoice: { select: { label: true, number: true } } },
        orderBy: { createdAt: 'desc' },
        take: 500,
      }),
    );
  }

  // ------------------------------------------------------------ Impayés et relances
  unpaid(actor: Actor, classId?: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const yearId = await this.scope.currentYearId(tx);
      const today = toDate(isoDay(new Date()));
      const rows = await tx.invoice.findMany({
        where: {
          status: { in: ['OPEN', 'PARTIAL'] },
          dueDate: { lt: today },
          ...(classId ? { student: { enrollments: { some: { classId, academicYearId: yearId } } } } : {}),
        },
        include: {
          student: {
            select: {
              id: true, matricule: true, firstName: true, lastName: true,
              enrollments: { where: { academicYearId: yearId }, select: { class: { select: { id: true, name: true } } } },
              guardians: { where: { isPrimary: true }, select: { guardian: { select: { firstName: true, lastName: true, phone: true } } } },
            },
          },
        },
        orderBy: { dueDate: 'asc' },
      });
      return rows.map((r) => ({
        id: r.id, number: r.number, label: r.label, total: r.total, paid: r.paid, remaining: r.total - r.paid, dueDate: r.dueDate,
        daysLate: Math.floor((today.getTime() - r.dueDate.getTime()) / 86400000),
        student: { id: r.student.id, matricule: r.student.matricule, name: `${r.student.firstName} ${r.student.lastName}`, class: r.student.enrollments[0]?.class ?? null },
        guardian: r.student.guardians[0]?.guardian ?? null,
      }));
    });
  }

  /** Balance âgée : montants dus à 0-30, 31-60, 61-90 et plus de 90 jours (CDC §4.4). */
  async aging(actor: Actor) {
    const rows = await this.unpaid(actor);
    const buckets = [
      { label: '0 à 30 jours', min: 0, max: 30, amount: 0, count: 0 },
      { label: '31 à 60 jours', min: 31, max: 60, amount: 0, count: 0 },
      { label: '61 à 90 jours', min: 61, max: 90, amount: 0, count: 0 },
      { label: 'Plus de 90 jours', min: 91, max: Infinity, amount: 0, count: 0 },
    ];
    for (const r of rows) {
      const b = buckets.find((x) => r.daysLate >= x.min && r.daysLate <= x.max)!;
      b.amount += r.remaining;
      b.count++;
    }
    return buckets.map(({ min, max, ...b }) => b);
  }

  /** Relance groupée des familles débitrices : SMS immédiat + notification (CDC §4.4). */
  remind(actor: Actor, dto: RemindDto) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const yearId = await this.scope.currentYearId(tx);
      const enr = await tx.enrollment.findMany({
        where: { academicYearId: yearId, status: 'ACTIVE', ...(dto.classId ? { classId: dto.classId } : {}), ...(dto.studentIds?.length ? { studentId: { in: dto.studentIds } } : {}) },
        select: { student: { select: { id: true, firstName: true, matricule: true } } },
      });
      const balances = await this.balances(tx, enr.map((e) => e.student.id));
      let families = 0;
      for (const { student } of enr) {
        const due = balances.get(student.id) ?? 0;
        if (due <= 0) continue;
        const parents = await this.notifications.guardianUserIds(tx, student.id);
        families += await this.notifications.notify(tx, actor.tenantId, parents, {
          kind: 'reminder',
          title: 'Rappel de paiement',
          body: `Il reste ${fcfa(due)} à régler pour la scolarité de ${student.firstName}. Vous pouvez payer par Mobile Money depuis votre espace parent (référence ${student.matricule}).`,
          sms: `Rappel : il reste ${fcfa(due)} a regler pour ${student.firstName}. Ref ${student.matricule}.`,
          smsMode: 'immediate',
        });
      }
      await this.audit.log(tx, actor, 'finance.reminders_sent', 'Invoice', null, { classId: dto.classId, families });
      return { families };
    });
  }

  // ------------------------------------------------------------ Pilotage
  dashboard(actor: Actor) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const today = toDate(isoDay(new Date()));
      const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
      const sum = async (where: Prisma.PaymentWhereInput) => (await tx.payment.aggregate({ where: { status: 'SUCCESS', ...where }, _sum: { amount: true }, _count: true }));
      const [todayAgg, monthAgg, invAgg, pending, byMethod] = await Promise.all([
        sum({ confirmedAt: { gte: today } }),
        sum({ confirmedAt: { gte: monthStart } }),
        tx.invoice.aggregate({ where: { status: { not: 'CANCELLED' } }, _sum: { total: true, paid: true } }),
        tx.payment.count({ where: { status: { in: ['INITIATED', 'PENDING'] } } }),
        tx.payment.groupBy({ by: ['method'], where: { status: 'SUCCESS', confirmedAt: { gte: monthStart } }, _sum: { amount: true } }),
      ]);
      const expected = invAgg._sum.total ?? 0;
      const collected = invAgg._sum.paid ?? 0;
      return {
        today: { amount: todayAgg._sum.amount ?? 0, count: todayAgg._count },
        month: { amount: monthAgg._sum.amount ?? 0, count: monthAgg._count },
        expected, collected, remaining: expected - collected,
        recoveryRate: expected ? Math.round((collected / expected) * 1000) / 10 : null,
        pendingOnline: pending,
        byMethod: byMethod.map((m) => ({ method: m.method, label: METHOD_LABEL[m.method], amount: m._sum.amount ?? 0 })),
        aging: await this.aging(actor),
      };
    });
  }

  /** Clôture de caisse journalière : espèces encaissées par le caissier contre montant compté. */
  closeCash(actor: Actor, dto: CashClosingDto) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const day = toDate(isoDay(new Date()));
      const agg = await tx.payment.aggregate({ where: { status: 'SUCCESS', method: 'CASH', receivedById: actor.userId, confirmedAt: { gte: day } }, _sum: { amount: true } });
      const expected = agg._sum.amount ?? 0;
      const closing = await tx.cashClosing
        .create({ data: { tenantId: actor.tenantId, date: day, cashierId: actor.userId, expected, counted: dto.counted, difference: dto.counted - expected, comment: dto.comment } })
        .catch((e) => {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('La caisse du jour est déjà clôturée');
          throw e;
        });
      await this.audit.log(tx, actor, 'cash.closed', 'CashClosing', closing.id, { expected, counted: dto.counted });
      return closing;
    });
  }

  cashClosings(actor: Actor) {
    return this.db.forTenant(actor.tenantId, (tx) => tx.cashClosing.findMany({ orderBy: { date: 'desc' }, take: 60 }));
  }

  /**
   * Export des encaissements en CSV pour le logiciel comptable.
   * Le plan de comptes SYSCOHADA de l'école n'est pas connu (INFORMATION MANQUANTE) : colonnes génériques.
   */
  exportPaymentsCsv(actor: Actor, from?: string, to?: string) {
    return this.payments(actor, { status: 'SUCCESS', from, to }).then((rows) => {
      const head = ['date', 'recu', 'facture', 'matricule', 'eleve', 'libelle', 'mode', 'montant_fcfa', 'reference'];
      const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const lines = rows.map((p) =>
        [isoDay(p.confirmedAt ?? p.createdAt), p.receipt?.number, p.invoice.number, p.student.matricule, `${p.student.firstName} ${p.student.lastName}`, p.invoice.label, METHOD_LABEL[p.method], p.amount, p.providerRef ?? p.transactionId].map(esc).join(';'),
      );
      return [head.join(';'), ...lines].join('\n');
    });
  }
}
