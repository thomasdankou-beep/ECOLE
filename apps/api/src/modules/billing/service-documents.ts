import { BadRequestException, Body, Controller, Injectable, NotFoundException, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { Public } from '../../common/auth';
import { localDay, money } from '../../common/country';
import { PlatformActor } from '../platform/group-journal';
import { PlatformDb, PlatformGuard } from '../platform/platform';
import { BillingService, PLATFORM_TZ } from './billing';
import { notifyDirection } from './billing-tasks';
import { cahioraMessage, DOCUMENT_KIND_LABELS, documentJournals, PROVISIONAL_MENTION } from './documents';
import { ServicesService } from './services';
import { PriceBasis } from './services-rules';

/**
 * Devis et proformas de prestations complémentaires (lot G5c), cahier des charges G5 du 14 novembre 2026, §7, §15 et
 * §16 : des documents provisoires clairement identifiés, jamais une facture fiscale, aucun paiement (D-G5-33 ouverte).
 * Le Super Admin les établit pour un établissement, avec un code actuel de son application d'authentification, à
 * partir du catalogue de G5g : nom et prix de chaque prestation le jour du document pour cet établissement (une seule
 * règle, jamais de cumul). Une prestation sur devis n'entre que dans un devis, au prix qu'il saisit ; une proforma
 * reprend un devis tel quel, une seule fois, ou se fait directement avec des prestations à prix du catalogue. Rien
 * n'est jamais ajouté d'office. La base refait chaque prix (service_unit_price) avant d'écrire.
 * INFORMATION MANQUANTE : durée de validité d'un devis, échéance d'une proforma (aucune date n'est inscrite).
 */

const CODE = { message: 'Code de votre application d’authentification : 6 chiffres' };
const NOT_OFFERED: PriceBasis[] = ['NOT_IN_CATALOG', 'INACTIVE', 'MISSING'];
export const QUOTE_VALIDITY_MISSING = 'INFORMATION MANQUANTE : durée de validité d’un devis non fixée';
export const PROFORMA_DUE_MISSING = 'INFORMATION MANQUANTE : échéance d’une proforma non fixée';

export class ServiceItemDto {
  @IsUUID('all', { message: 'Prestation invalide' }) serviceId: string;
  @IsInt({ message: 'Quantité : nombre entier' }) @Min(1, { message: 'Quantité : 1 au moins' }) @Max(1000, { message: 'Quantité : 1 000 au plus' }) quantity: number;
  /** Prix unitaire saisi : seulement pour une prestation sur devis, dans un devis. */
  @IsOptional() @IsInt({ message: 'Prix unitaire : nombre entier' }) @Min(0, { message: 'Prix unitaire : jamais négatif' })
  @Max(100_000_000, { message: 'Prix unitaire trop élevé' }) unitPrice?: number;
}

export class ServiceDocumentDto {
  @IsIn(['SERVICE_QUOTE', 'SERVICE_PROFORMA'], { message: 'Document inconnu' }) kind: 'SERVICE_QUOTE' | 'SERVICE_PROFORMA';
  @IsUUID('all', { message: 'Établissement invalide' }) tenantId: string;
  /** Proforma qui reprend un devis : ses lignes telles quelles. */
  @IsOptional() @IsUUID('all', { message: 'Devis invalide' }) quoteId?: string;
  @IsOptional() @IsArray() @ArrayMinSize(1, { message: 'Ajoutez au moins une prestation' }) @ArrayMaxSize(20, { message: '20 prestations au plus' })
  @ValidateNested({ each: true }) @Type(() => ServiceItemDto) items?: ServiceItemDto[];
  @IsString(CODE) @Length(6, 8, CODE) code: string;
}

/** Ligne envoyée à issue_billing_document. */
type ServiceLine = {
  tenantId: string; label: string; amount: number; serviceId: string; serviceName: string; quantity: number; unitPrice: number; priceBasis: string;
};
/** Ce que le document garde de chaque prestation : sa base de prix et la règle appliquée, en clair. */
type ItemNote = { serviceId: string; code: string | null; name: string; basis: string; basisLabel: string; catalogAmount: number | null; rule: string | null };

@Injectable()
export class ServiceDocumentsService {
  constructor(private platform: PlatformDb, private billing: BillingService, private services: ServicesService) {}

  /** Devis ou proforma de prestations pour un établissement, daté du jour de l'éditeur. */
  async issue(admin: PlatformActor, dto: ServiceDocumentDto, now = new Date()) {
    const issueDay = localDay(PLATFORM_TZ, now);
    const t = await this.platform.tenant.findUnique({
      where: { id: dto.tenantId }, select: { id: true, name: true, currency: true, group: { select: { id: true, name: true, _count: { select: { tenants: true } } } } },
    });
    if (!t) throw new NotFoundException('Établissement introuvable');
    const fromQuote = dto.kind === 'SERVICE_PROFORMA' && !!dto.quoteId;
    if (dto.quoteId && dto.kind !== 'SERVICE_PROFORMA') throw new BadRequestException('Seule une proforma reprend un devis');
    if (fromQuote && dto.items?.length) throw new BadRequestException('Une proforma reprend les lignes du devis telles quelles : n’ajoutez pas de prestation');
    if (!fromQuote && !dto.items?.length) throw new BadRequestException('Ajoutez au moins une prestation');

    const { lines, notes, quote } = fromQuote ? await this.fromQuote(t, dto.quoteId!) : await this.priced(t, dto, issueDay);
    await this.billing.confirm(admin, dto.code);
    const label = DOCUMENT_KIND_LABELS[dto.kind];
    const data = {
      title: `${dto.kind === 'SERVICE_QUOTE' ? 'Devis provisoire' : 'Proforma'} · prestations Cahiora`,
      mention: PROVISIONAL_MENTION,
      client: { groupId: t.group.id, name: t.group.name },
      establishments: [{ tenantId: t.id, name: t.name }],
      priceDay: quote?.priceDay ?? issueDay,
      items: notes,
      quote: quote && { documentId: quote.id, reference: quote.reference },
      validity: dto.kind === 'SERVICE_QUOTE' ? QUOTE_VALIDITY_MISSING : null,
      due: dto.kind === 'SERVICE_PROFORMA' ? PROFORMA_DUE_MISSING : null,
    };
    try {
      return await this.platform.$transaction(async (tx) => {
        const [r] = await tx.$queryRaw<{ document_id: string; document_reference: string; document_total: number }[]>`
          SELECT * FROM issue_billing_document(${t.group.id}::uuid, ${dto.kind}, ${t.currency}, ${issueDay}::date, NULL::date, NULL, ${quote?.id ?? null}::uuid,
            ${JSON.stringify(data)}::jsonb, ${JSON.stringify(lines)}::jsonb, 'platform', ${admin.id}::uuid, ${admin.name})`;
        const action = dto.kind === 'SERVICE_QUOTE' ? 'billing.service_quote_issued' : 'billing.service_proforma_issued';
        await documentJournals(tx, t.group, r.document_id, action, {
          documentId: r.document_id, reference: r.document_reference, kind: dto.kind, total: r.document_total, issueDate: issueDay, relatedDocumentId: quote?.id ?? null,
        }, [{ tenant: { id: t.id, name: t.name }, data: { items: lines.map((l) => ({ serviceName: l.serviceName, quantity: l.quantity, unitPrice: l.unitPrice, amount: l.amount })) } }], admin);
        // La direction est prévenue quand elle voit les documents (école indépendante, D-G5-19) ; jamais par SMS.
        if (t.group._count.tenants === 1) {
          await notifyDirection(tx, t.id, action, `${label} Cahiora`,
            `${label} ${r.document_reference} : ${money(r.document_total, t.currency)}, dans Paramètres › Abonnement Cahiora. ${PROVISIONAL_MENTION}`);
        }
        return { documentId: r.document_id, reference: r.document_reference, total: r.document_total };
      }, { timeout: 60000 });
    } catch (e) {
      const m = cahioraMessage(e);
      if (m) throw new BadRequestException(m);
      throw e;
    }
  }

  /** Lignes au prix du catalogue de ce jour pour l'établissement ; prix saisi pour une prestation sur devis (devis seulement). */
  private async priced(t: { id: string; name: string; currency: string }, dto: ServiceDocumentDto, day: string) {
    const { items } = await this.services.prices(t.id, day);
    const byId = new Map(items.map((p) => [p.id, p]));
    const seen = new Set<string>();
    const lines: ServiceLine[] = [];
    const notes: ItemNote[] = [];
    for (const item of dto.items!) {
      const p = byId.get(item.serviceId);
      if (!p) throw new NotFoundException('Prestation introuvable');
      if (seen.has(p.id)) throw new BadRequestException(`${p.name} : une seule ligne par prestation (indiquez la quantité)`);
      seen.add(p.id);
      if (NOT_OFFERED.includes(p.basis)) throw new BadRequestException(`${p.name} : ${p.label}`);
      let unit: number;
      if (p.basis === 'QUOTE') {
        if (dto.kind !== 'SERVICE_QUOTE') throw new BadRequestException(`${p.name} : prestation sur devis, établissez d’abord un devis, puis sa proforma`);
        if (item.unitPrice === undefined) throw new BadRequestException(`${p.name} : saisissez le prix unitaire (prestation sur devis)`);
        unit = item.unitPrice;
      } else {
        unit = p.amount!;
        if (item.unitPrice !== undefined && item.unitPrice !== unit) {
          throw new BadRequestException(`${p.name} : le prix vient du catalogue (${money(unit, t.currency)} ce jour) ; il se saisit seulement pour une prestation sur devis`);
        }
      }
      lines.push({ tenantId: t.id, label: `${t.name} · ${p.name}`, amount: item.quantity * unit, serviceId: p.id, serviceName: p.name, quantity: item.quantity, unitPrice: unit, priceBasis: p.basis });
      notes.push({ serviceId: p.id, code: p.code, name: p.name, basis: p.basis, basisLabel: p.label, catalogAmount: p.catalogAmount, rule: p.rule?.text ?? null });
    }
    return { lines, notes, quote: null };
  }

  /** Proforma d'un devis du même établissement : ses lignes, dans le même ordre, avec ses prix. */
  private async fromQuote(t: { id: string; group: { id: string } }, quoteId: string) {
    const q = await this.platform.billingDocument.findUnique({ where: { id: quoteId }, include: { lines: { orderBy: { position: 'asc' } } } });
    if (!q || q.kind !== 'SERVICE_QUOTE' || q.groupId !== t.group.id || q.lines.some((l) => l.tenantId !== t.id)) throw new NotFoundException('Devis introuvable pour cet établissement');
    if (await this.platform.billingDocument.count({ where: { relatedDocumentId: q.id, kind: 'SERVICE_PROFORMA' } })) throw new BadRequestException('Ce devis a déjà sa proforma');
    const lines: ServiceLine[] = q.lines.map((l) => ({
      tenantId: l.tenantId, label: l.label, amount: l.amount, serviceId: l.serviceId!, serviceName: l.serviceName!, quantity: l.quantity!, unitPrice: l.unitPrice!, priceBasis: l.priceBasis!,
    }));
    const notes = ((q.data as { items?: ItemNote[] } | null)?.items ?? []);
    return { lines, notes, quote: { id: q.id, reference: q.reference, priceDay: (q.data as { priceDay?: string } | null)?.priceDay ?? q.issueDate.toISOString().slice(0, 10) } };
  }
}

@ApiTags('Plateforme : facturation')
@Public()
@UseGuards(PlatformGuard)
@Controller()
export class ServiceDocumentsController {
  constructor(private s: ServiceDocumentsService) {}

  /** Devis ou proforma de prestations (Super Admin, code exigé). */
  @Post('platform/billing/service-documents') @Throttle({ default: { limit: 20, ttl: 60000 } })
  issue(@Req() req: Request, @Body() dto: ServiceDocumentDto) {
    return this.s.issue((req as unknown as { platformAdmin: PlatformActor }).platformAdmin, dto);
  }
}
