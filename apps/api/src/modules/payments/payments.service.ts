import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { config } from '../../config';
import { Actor } from '../../common/auth';
import { AuditService } from '../../common/audit.service';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { normalizePhone } from '../../common/util';
import { FinanceService } from '../finance/finance.service';
import { createPaymentProvider, PaymentProvider, ProviderEvent, SandboxProvider } from './providers';

/// Opérateurs Mobile Money proposés au parent (liste à confirmer avec l'agrégateur retenu).
export const OPERATORS = ['MTN MoMo', 'Moov Money'];

@Injectable()
export class PaymentsService {
  private log = new Logger('Payments');
  provider: PaymentProvider = createPaymentProvider(config.payments.provider);

  constructor(private db: PrismaService, private scope: ScopeService, private finance: FinanceService, private audit: AuditService) {}

  /** Le parent lance un paiement Mobile Money ; la facture n'est réglée qu'à la confirmation de l'opérateur. */
  async initiate(actor: Actor, dto: { invoiceId: string; amount: number; operator: string; phone: string }) {
    const transactionId = `SK${Date.now().toString(36).toUpperCase()}${randomBytes(4).toString('hex').toUpperCase()}`;
    const payment = await this.db.forTenant(actor.tenantId, async (tx) => {
      const inv = await tx.invoice.findUnique({ where: { id: dto.invoiceId }, include: { student: true } });
      if (!inv) throw new NotFoundException('Facture introuvable');
      await this.scope.assertStudent(tx, actor, inv.studentId);
      this.finance.assertPayable(inv, dto.amount);
      const p = await tx.payment.create({
        data: {
          tenantId: actor.tenantId, invoiceId: inv.id, studentId: inv.studentId, amount: dto.amount, method: 'ONLINE',
          provider: this.provider.name, operator: dto.operator, transactionId, payerPhone: normalizePhone(dto.phone), status: 'INITIATED',
        },
      });
      await tx.$executeRaw`INSERT INTO payment_routes (transaction_id, tenant_id) VALUES (${transactionId}, ${actor.tenantId}::uuid)`;
      await this.audit.log(tx, actor, 'payment.initiated', 'Payment', p.id, { amount: dto.amount, operator: dto.operator });
      return { ...p, studentName: `${inv.student.firstName} ${inv.student.lastName}`, label: inv.label };
    });

    try {
      const r = await this.provider.initiate({
        transactionId, amount: dto.amount, currency: 'XOF', description: `${payment.label} ${payment.studentName}`,
        payerPhone: payment.payerPhone ?? undefined, operator: dto.operator, customerName: actor.name,
        notifyUrl: `${config.publicApiUrl}/api/v1/payments/webhook/${this.provider.name}`,
        returnUrl: `${config.webOrigin}/espace/frais?paiement=${payment.id}`,
      });
      await this.db.forTenant(actor.tenantId, (tx) => tx.payment.update({ where: { id: payment.id }, data: { status: 'PENDING', providerRef: r.providerRef } }));
      return { paymentId: payment.id, transactionId, status: 'PENDING', ...r };
    } catch (e: any) {
      await this.db.forTenant(actor.tenantId, (tx) => tx.payment.update({ where: { id: payment.id }, data: { status: 'FAILED', rawCallback: { error: String(e.message) } } }));
      throw new BadRequestException(`Le paiement n'a pas pu démarrer : ${e.message}`);
    }
  }

  /** Webhook de l'agrégateur : signature vérifiée, puis statut confirmé auprès de l'agrégateur. */
  async webhook(providerName: string, headers: Record<string, any>, body: any) {
    if (providerName !== this.provider.name) throw new BadRequestException('Fournisseur inattendu');
    let transactionId: string;
    try {
      ({ transactionId } = await this.provider.parseWebhook(headers, body));
    } catch (e: any) {
      this.log.warn(`Webhook rejeté : ${e.message}`);
      throw new BadRequestException('Webhook invalide');
    }
    return this.reconcile(transactionId, body);
  }

  /** Rapprochement idempotent : un webhook reçu deux fois ne génère qu'un reçu. */
  async reconcile(transactionId: string, raw?: unknown) {
    const route = await this.db.$queryRaw<{ tenant_id: string }[]>`SELECT tenant_id::text FROM payment_routes WHERE transaction_id = ${transactionId}`;
    if (!route.length) throw new NotFoundException('Transaction inconnue');
    const tenantId = route[0].tenant_id;
    const event: ProviderEvent = await this.provider.check(transactionId);
    return this.db.forTenant(tenantId, async (tx) => {
      // Verrou de ligne : deux webhooks simultanés ne peuvent pas confirmer deux fois.
      await tx.$queryRaw`SELECT id FROM payments WHERE "transactionId" = ${transactionId} FOR UPDATE`;
      const p = await tx.payment.findUniqueOrThrow({ where: { transactionId } });
      if (p.status === 'SUCCESS' || p.status === 'FAILED' || p.status === 'CANCELLED') return { status: p.status, alreadyProcessed: true };
      if (event.status === 'PENDING') return { status: p.status };
      if (event.status === 'SUCCESS' && event.amount !== undefined && event.amount !== p.amount) {
        await tx.payment.update({ where: { id: p.id }, data: { status: 'FAILED', rawCallback: { raw, event, error: 'Montant différent' } as any } });
        await this.audit.log(tx, null, 'payment.amount_mismatch', 'Payment', p.id, { tenantId, expected: p.amount, got: event.amount });
        return { status: 'FAILED' };
      }
      const updated = await tx.payment.update({
        where: { id: p.id },
        data: {
          status: event.status, providerRef: event.providerRef ?? p.providerRef,
          confirmedAt: event.status === 'SUCCESS' ? new Date() : null, rawCallback: (raw ?? event) as Prisma.InputJsonValue,
        },
      });
      if (event.status === 'SUCCESS') {
        const inv = await tx.invoice.findUniqueOrThrow({ where: { id: p.invoiceId } });
        if (inv.total - inv.paid < p.amount) {
          // Facture soldée entre-temps (paiement au guichet) : à rembourser, signalé à la comptabilité.
          await this.audit.log(tx, null, 'payment.overpaid', 'Payment', p.id, { tenantId, amount: p.amount });
        }
        await this.finance.applyPayment(tx, null, updated);
      }
      return { status: event.status };
    });
  }

  get(actor: Actor, id: string) {
    return this.db.forTenant(actor.tenantId, async (tx) => {
      const p = await tx.payment.findUnique({ where: { id }, include: { receipt: { select: { id: true, number: true } }, invoice: { select: { label: true, number: true } } } });
      if (!p) throw new NotFoundException();
      await this.scope.assertStudent(tx, actor, p.studentId);
      return p;
    });
  }

  /** Bac à sable : simule la validation du parent sur son téléphone, puis le webhook signé de l'agrégateur. */
  async sandboxDecide(transactionId: string, success: boolean) {
    if (this.provider.name !== 'sandbox') throw new NotFoundException();
    if (!SandboxProvider.decide(transactionId, success)) throw new NotFoundException('Transaction inconnue');
    const body = { transactionId };
    return this.webhook('sandbox', { 'x-sandbox-signature': SandboxProvider.sign(JSON.stringify(body)) }, body);
  }

  async sandboxInfo(transactionId: string) {
    if (this.provider.name !== 'sandbox') throw new NotFoundException();
    const route = await this.db.$queryRaw<{ tenant_id: string }[]>`SELECT tenant_id::text FROM payment_routes WHERE transaction_id = ${transactionId}`;
    if (!route.length) throw new NotFoundException();
    return this.db.forTenant(route[0].tenant_id, async (tx) => {
      const p = await tx.payment.findUniqueOrThrow({ where: { transactionId }, include: { invoice: { select: { label: true } } } });
      return { amount: p.amount, operator: p.operator, phone: p.payerPhone, label: p.invoice.label, status: p.status, paymentId: p.id };
    });
  }
}
