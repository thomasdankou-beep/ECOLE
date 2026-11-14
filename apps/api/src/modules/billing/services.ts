import {
  BadRequestException, Body, ConflictException, Controller, Get, Header, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import { Public } from '../../common/auth';
import { CURRENCIES, localDay } from '../../common/country';
import { groupLog, PlatformActor, platformLog, schoolLogInTx } from '../platform/group-journal';
import { PlatformDb, PlatformGuard } from '../platform/platform';
import { BillingService, PLATFORM_TZ } from './billing';
import { frDay, isDay } from './billing-rules';
import {
  endErrors, lastDayOf, PRICING_LABELS, PRICINGS, RATE_KINDS, RATE_LABELS, RateInput, RateKind, rateErrors, rateText, serviceCode, servicePrice,
  ServicePricing, ServiceRate, ServiceVersion, serviceVersionOn, versionErrors,
} from './services-rules';

/**
 * Prestations complémentaires de Cahiora, lot G5g (cahier des charges G5, §7 et §15) : catalogue en versions datées,
 * prix du catalogue datés, remises, tarifs particuliers et gratuités, historique, et prix d'une prestation pour un
 * établissement un jour donné. Réservé au Super Admin ; chaque changement exige un code actuel de son application
 * d'authentification, a une date d'effet jamais passée et un motif, et s'inscrit dans les journaux dans la même
 * transaction. Rien n'est facturé ici : les prestations entreront dans les devis et les factures avec le lot G5c,
 * seulement quand quelqu'un les y ajoute.
 */

const DAY = { message: 'Date attendue au format AAAA-MM-JJ' };
const MOTIF = { message: 'Motif : 5 à 300 caractères' };
const CODE = { message: 'Code de votre application d’authentification : 6 chiffres' };
const NAME = { message: 'Nom : de 3 à 120 caractères' };
const DESCRIPTION = { message: 'Description : 2 000 caractères au plus' };
const PRICING = { message: 'Mode de prix : prix fixe, gratuite ou sur devis' };

class CodeDto {
  @IsString(CODE) @Length(6, 8, CODE) code: string;
}

export class ServiceCreateDto extends CodeDto {
  @IsString(NAME) @MinLength(3, NAME) @MaxLength(120, NAME) name: string;
  @IsOptional() @IsString(DESCRIPTION) @MaxLength(2000, DESCRIPTION) description?: string | null;
  @IsIn(PRICINGS, PRICING) pricing: ServicePricing;
  /** Prix du catalogue de départ, pour un prix fixe ; sans lui, le prix reste à fixer. */
  @IsOptional() @IsInt({ message: 'Prix : nombre entier' }) price?: number | null;
  @IsOptional() @IsIn(CURRENCIES, { message: 'Monnaie non prise en charge' }) currency?: string | null;
  @Matches(/^\d{4}-\d{2}-\d{2}$/, DAY) effectiveFrom: string;
  @IsString(MOTIF) @MinLength(5, MOTIF) @MaxLength(300, MOTIF) reason: string;
}

export class ServiceVersionDto extends CodeDto {
  @IsString(NAME) @MinLength(3, NAME) @MaxLength(120, NAME) name: string;
  @IsOptional() @IsString(DESCRIPTION) @MaxLength(2000, DESCRIPTION) description?: string | null;
  @IsIn(PRICINGS, PRICING) pricing: ServicePricing;
  @IsBoolean({ message: 'Active : oui ou non' }) active: boolean;
  @Matches(/^\d{4}-\d{2}-\d{2}$/, DAY) effectiveFrom: string;
  @IsString(MOTIF) @MinLength(5, MOTIF) @MaxLength(300, MOTIF) reason: string;
}

export class ServiceRateDto extends CodeDto {
  @IsIn(RATE_KINDS, { message: 'Genre de règle inconnu' }) kind: RateKind;
  /** Établissement visé ; vide : tous les établissements. */
  @IsOptional() @IsUUID('all', { message: 'Établissement inconnu' }) tenantId?: string | null;
  @IsOptional() @IsIn(CURRENCIES, { message: 'Monnaie non prise en charge' }) currency?: string | null;
  /** Montant, ou pourcentage en centièmes (1500 = 15 %) ; vide pour une gratuité. */
  @IsOptional() @IsInt({ message: 'Valeur : nombre entier' }) value?: number | null;
  @Matches(/^\d{4}-\d{2}-\d{2}$/, DAY) effectiveFrom: string;
  @IsOptional() @Matches(/^(\d{4}-\d{2}-\d{2})?$/, DAY) effectiveTo?: string | null;
  @IsString(MOTIF) @MinLength(5, MOTIF) @MaxLength(300, MOTIF) reason: string;
}

export class RateEndDto extends CodeDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, DAY) lastDay: string;
  @IsString(MOTIF) @MinLength(5, MOTIF) @MaxLength(300, MOTIF) reason: string;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const laterDay = (a: string, b: string) => (a > b ? a : b);

const INCLUDE = {
  versions: { orderBy: { version: 'asc' } },
  rates: { orderBy: { createdAt: 'asc' }, include: { stop: true, tenant: { select: { id: true, name: true } } } },
} satisfies Prisma.ServiceInclude;

/** Verrou des noms de prestations, pris avant toute création ou tout changement de nom (noms uniques). */
const lockNames = (tx: Prisma.TransactionClient) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('services:names'))`;
/** Verrou d'une prestation, pris avant d'ajouter une version ou une règle. */
const lockService = (tx: Prisma.TransactionClient, id: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`service_versions:${id}`}))`;
type Row = Prisma.ServiceGetPayload<{ include: typeof INCLUDE }>;
type RateRow = Row['rates'][number];

function versionsOf(row: { versions: Row['versions'] }): ServiceVersion[] {
  return row.versions.map((v) => ({ id: v.id, version: v.version, name: v.name, description: v.description, pricing: v.pricing, active: v.active, effectiveFrom: iso(v.effectiveFrom)!, createdAt: v.createdAt }));
}

function rateOf(r: Omit<RateRow, 'tenant'>): ServiceRate {
  return {
    id: r.id, kind: r.kind, tenantId: r.tenantId, currency: r.currency, value: r.value, effectiveFrom: iso(r.effectiveFrom)!,
    effectiveTo: lastDayOf(iso(r.effectiveTo), iso(r.stop?.lastDay)), createdAt: r.createdAt,
  };
}

/** Une règle telle que l'affiche le Super Admin. */
function ruleView(r: RateRow, today: string) {
  const plannedTo = iso(r.effectiveTo);
  const lastDay = lastDayOf(plannedTo, iso(r.stop?.lastDay));
  const effectiveFrom = iso(r.effectiveFrom)!;
  const cancelled = lastDay !== null && lastDay < effectiveFrom;
  const state = cancelled ? 'Annulée' : effectiveFrom > today ? 'À venir' : lastDay !== null && lastDay < today ? 'Terminée' : 'En cours';
  return {
    id: r.id, kind: r.kind, kindLabel: RATE_LABELS[r.kind], text: rateText(r), tenantId: r.tenantId, tenantName: r.tenant?.name ?? null,
    scope: r.tenant ? r.tenant.name : 'Tous les établissements', currency: r.currency, value: r.value, effectiveFrom, plannedTo, lastDay, state,
    stopped: !!r.stop, stopReason: r.stop?.reason ?? null, reason: r.reason, createdByName: r.createdByName, createdAt: r.createdAt,
  };
}

/** Ce qui change d'une version à la suivante, en clair. */
function versionChanges(prev: ServiceVersion | undefined, v: ServiceVersion) {
  if (!prev) return [`${v.name} · ${PRICING_LABELS[v.pricing]}`];
  const out: string[] = [];
  if (prev.name !== v.name) out.push(`Nom : ${v.name}`);
  if ((prev.description ?? '') !== (v.description ?? '')) out.push(v.description ? 'Description modifiée' : 'Description retirée');
  if (prev.pricing !== v.pricing) out.push(`Mode de prix : ${PRICING_LABELS[v.pricing]}`);
  if (prev.active !== v.active) out.push(v.active ? 'Réactivée' : 'Désactivée');
  return out;
}

function uniqueViolation(e: unknown) {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

@Injectable()
export class ServicesService {
  constructor(private db: PlatformDb, private billing: BillingService) {}

  private async tenant(id: string) {
    const t = await this.db.tenant.findUnique({ where: { id }, select: { id: true, name: true, groupId: true, timezone: true, currency: true } });
    if (!t) throw new NotFoundException('Établissement introuvable');
    return t;
  }

  private async service(id: string) {
    const s = await this.db.service.findUnique({ where: { id }, include: INCLUDE });
    if (!s) throw new NotFoundException('Prestation introuvable');
    return s;
  }

  /** Une règle pour un établissement va aussi dans les journaux de son groupe et de l'établissement, sans le motif. */
  private async journals(tx: Prisma.TransactionClient, actor: PlatformActor, t: { id: string; name: string; groupId: string } | null, action: string, data: Record<string, unknown>, reason: string) {
    await platformLog(tx, actor, action, t?.id ?? null, { ...data, reason });
    if (!t) return;
    await groupLog(tx, actor, [{ groupId: t.groupId, action, data: { tenantName: t.name, ...data } }]);
    await schoolLogInTx(tx, actor, t.id, action, data);
  }

  /** Aucun autre nom actuel identique (sans tenir compte des majuscules ni des accents). */
  private async nameTaken(name: string, exceptId?: string, client: Pick<Prisma.TransactionClient, 'service'> = this.db) {
    const key = serviceCode(name);
    const rows = await client.service.findMany({ where: exceptId ? { id: { not: exceptId } } : {}, select: { versions: { orderBy: { version: 'desc' }, take: 1, select: { name: true } } } });
    return rows.some((r) => r.versions[0] && serviceCode(r.versions[0].name) === key);
  }

  // ---------------------------------------------------------------- Lecture

  private view(row: Row, today: string) {
    const versions = versionsOf(row);
    const current = serviceVersionOn(versions, today);
    const last = versions.at(-1)!;
    const upcoming = versions.filter((v) => v.effectiveFrom > today).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.version - b.version);
    const priceRows = row.rates.filter((r) => r.kind === 'PRICE');
    const prices = [...new Set(priceRows.map((r) => r.currency!))].sort().map((currency) => {
      const list = priceRows.filter((r) => r.currency === currency).map(rateOf);
      const now = list.filter((r) => r.effectiveFrom <= today).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.createdAt.getTime() - b.createdAt.getTime()).at(-1) ?? null;
      const next = list.filter((r) => r.effectiveFrom > today).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
      return { currency, value: now?.value ?? null, since: now?.effectiveFrom ?? null, next: next ? { value: next.value, effectiveFrom: next.effectiveFrom } : null };
    });
    const rules = row.rates.filter((r) => r.kind !== 'PRICE').map((r) => ruleView(r, today)).filter((r) => r.state === 'En cours' || r.state === 'À venir');
    const shown = current ?? last;
    return {
      id: row.id, code: row.code, createdAt: row.createdAt,
      name: shown.name, description: shown.description, pricing: shown.pricing, pricingLabel: PRICING_LABELS[shown.pricing], active: current ? current.active : false,
      inCatalogSince: versions.map((v) => v.effectiveFrom).sort()[0],
      current: current ? { version: current.version, effectiveFrom: current.effectiveFrom } : null,
      last: { version: last.version, name: last.name, description: last.description, pricing: last.pricing, active: last.active, effectiveFrom: last.effectiveFrom },
      upcoming: upcoming.map((v) => ({ version: v.version, name: v.name, pricing: v.pricing, pricingLabel: PRICING_LABELS[v.pricing], active: v.active, effectiveFrom: v.effectiveFrom })),
      prices, rules,
    };
  }

  /** Catalogue, avec les établissements clients pour les règles qui en visent un. */
  async list() {
    const today = localDay(PLATFORM_TZ);
    const [rows, tenants] = await Promise.all([
      this.db.service.findMany({ include: INCLUDE, orderBy: [{ createdAt: 'asc' }, { code: 'asc' }] }),
      this.db.tenant.findMany({ orderBy: [{ name: 'asc' }, { createdAt: 'asc' }], select: { id: true, name: true, currency: true, timezone: true, group: { select: { name: true } } } }),
    ]);
    return {
      today, currencies: CURRENCIES,
      pricings: PRICINGS.map((p) => ({ value: p, label: PRICING_LABELS[p] })),
      kinds: RATE_KINDS.map((k) => ({ value: k, label: RATE_LABELS[k] })),
      establishments: tenants.map((t) => ({ id: t.id, name: t.name, currency: t.currency, group: t.group.name, today: localDay(t.timezone) })),
      services: rows.map((r) => this.view(r, today)),
    };
  }

  /** Historique complet d'une prestation : versions, règles et arrêts, du plus récent au plus ancien. */
  async history(id: string) {
    const row = await this.service(id);
    const versions = versionsOf(row);
    const entries = [
      ...row.versions.map((v, i) => ({
        at: v.createdAt, by: v.createdByName, reason: v.reason,
        title: v.version === 1 ? 'Prestation créée' : `Version ${v.version}`,
        detail: `${versionChanges(versions[i - 1], versions[i]).join(' · ')} · à partir du ${frDay(iso(v.effectiveFrom)!)}`,
      })),
      ...row.rates.map((r) => ({
        at: r.createdAt, by: r.createdByName, reason: r.reason,
        title: `${RATE_LABELS[r.kind]} · ${r.tenant ? r.tenant.name : 'tous les établissements'}`,
        detail: `${rateText(r)} · à partir du ${frDay(iso(r.effectiveFrom)!)}${r.effectiveTo ? `, jusqu’au ${frDay(iso(r.effectiveTo)!)}` : ''}`,
      })),
      ...row.rates.filter((r) => r.stop).map((r) => {
        const cancelled = iso(r.stop!.lastDay)! < iso(r.effectiveFrom)!;
        return {
          at: r.stop!.createdAt, by: r.stop!.createdByName, reason: r.stop!.reason,
          title: `${cancelled ? 'Règle annulée' : 'Règle arrêtée'} · ${r.tenant ? r.tenant.name : 'tous les établissements'}`,
          detail: cancelled ? `${rateText(r)} : annulée avant son début` : `${rateText(r)} : dernier jour le ${frDay(iso(r.stop!.lastDay)!)}`,
        };
      }),
    ].sort((a, b) => b.at.getTime() - a.at.getTime());
    return { id: row.id, code: row.code, name: versions.at(-1)!.name, entries };
  }

  /**
   * Prix de chaque prestation pour un établissement, un jour donné (aujourd'hui pour lui, par défaut). Simple
   * consultation : rien n'est ajouté à un devis ni à une facture.
   */
  async prices(tenantId: string, onDay?: string) {
    const t = await this.tenant(tenantId);
    const d = onDay || localDay(t.timezone);
    if (!isDay(d)) throw new BadRequestException('Jour invalide');
    const rows = await this.db.service.findMany({ include: INCLUDE, orderBy: [{ createdAt: 'asc' }, { code: 'asc' }] });
    return {
      tenant: { id: t.id, name: t.name, currency: t.currency }, day: d,
      items: rows.map((row) => {
        const versions = versionsOf(row);
        const v = serviceVersionOn(versions, d);
        const result = servicePrice(v, row.rates.map(rateOf), t.id, t.currency, d);
        const rule = result.rule ? row.rates.find((r) => r.id === result.rule!.id)! : null;
        return {
          id: row.id, code: row.code, name: (v ?? versions.at(-1)!).name, pricing: v?.pricing ?? null,
          amount: result.amount, catalogAmount: result.catalogAmount, currency: result.currency, basis: result.basis, label: result.label,
          rule: rule ? { id: rule.id, text: rateText(rule), effectiveFrom: iso(rule.effectiveFrom), lastDay: rateOf(rule).effectiveTo } : null,
        };
      }),
    };
  }

  // ---------------------------------------------------------------- Changements (code exigé)

  /** Nouvelle prestation (version 1), avec au besoin son prix du catalogue de départ, à la même date d'effet. */
  async create(actor: PlatformActor, dto: ServiceCreateDto) {
    const today = localDay(PLATFORM_TZ);
    const name = dto.name.trim();
    const description = dto.description?.trim() || null;
    const errors = versionErrors({ name, description, pricing: dto.pricing, active: true, effectiveFrom: dto.effectiveFrom }, today, null);
    const hasPrice = dto.price !== undefined && dto.price !== null;
    const price: RateInput | null = hasPrice ? { kind: 'PRICE', tenantId: null, currency: dto.currency ?? null, value: dto.price!, effectiveFrom: dto.effectiveFrom, effectiveTo: null } : null;
    if (price) {
      if (dto.pricing !== 'FIXED') errors.push('Un prix de départ va seulement avec un prix fixe');
      else errors.push(...rateErrors('FIXED', price, today, CURRENCIES).filter((e) => !errors.includes(e)));
    }
    if (errors.length) throw new BadRequestException(errors);
    if (await this.nameTaken(name)) throw new ConflictException('Une prestation porte déjà ce nom');
    await this.billing.confirm(actor, dto.code);
    try {
      return await this.db.$transaction(async (tx) => {
        // Noms uniques même pour deux créations simultanées : la seconde attend la première, puis voit son nom.
        await lockNames(tx);
        if (await this.nameTaken(name, undefined, tx)) throw new ConflictException('Une prestation porte déjà ce nom');
        const base = serviceCode(name);
        const taken = new Set((await tx.service.findMany({ where: { code: { startsWith: base } }, select: { code: true } })).map((s) => s.code));
        let code = base;
        for (let i = 2; taken.has(code); i++) code = `${base}_${i}`;
        const s = await tx.service.create({ data: { code, createdById: actor.id, createdByName: actor.name } });
        await tx.serviceVersion.create({
          data: { serviceId: s.id, version: 1, name, description, pricing: dto.pricing, active: true, effectiveFrom: day(dto.effectiveFrom), reason: dto.reason.trim(), createdById: actor.id, createdByName: actor.name },
        });
        if (price) {
          await tx.serviceRate.create({
            data: { serviceId: s.id, kind: 'PRICE', currency: price.currency, value: price.value, effectiveFrom: day(dto.effectiveFrom), reason: dto.reason.trim(), createdById: actor.id, createdByName: actor.name },
          });
        }
        await this.journals(tx, actor, null, 'billing.service_created', {
          code, name, pricing: dto.pricing, effectiveFrom: dto.effectiveFrom, ...(price ? { price: rateText({ kind: 'PRICE', currency: price.currency, value: price.value }) } : {}),
        }, dto.reason.trim());
        return { id: s.id, code };
      });
    } catch (e) {
      if (uniqueViolation(e)) throw new ConflictException('Une prestation du même nom vient d’être créée : rechargez la page');
      throw e;
    }
  }

  /** Nouvelle version : nom, description, mode de prix ou activation, à partir de sa date d'effet (jamais passée). */
  async addVersion(actor: PlatformActor, id: string, dto: ServiceVersionDto) {
    const today = localDay(PLATFORM_TZ);
    const row = await this.service(id);
    const last = versionsOf(row).at(-1)!;
    const name = dto.name.trim();
    const description = dto.description?.trim() || null;
    const errors = versionErrors({ name, description, pricing: dto.pricing, active: dto.active, effectiveFrom: dto.effectiveFrom }, today, last);
    if (errors.length) throw new BadRequestException(errors);
    const renamed = serviceCode(name) !== serviceCode(last.name);
    if (renamed && (await this.nameTaken(name, id))) throw new ConflictException('Une prestation porte déjà ce nom');
    await this.billing.confirm(actor, dto.code);
    try {
      return await this.db.$transaction(async (tx) => {
        // Toujours dans le même ordre (noms, puis prestation) : deux changements simultanés passent l'un après l'autre.
        if (renamed) await lockNames(tx);
        await lockService(tx, id);
        const top = await tx.serviceVersion.findFirst({ where: { serviceId: id }, orderBy: { version: 'desc' }, select: { version: true } });
        if (top!.version !== last.version) throw new ConflictException('Cette prestation vient de changer : rechargez la page');
        if (renamed && (await this.nameTaken(name, id, tx))) throw new ConflictException('Une prestation porte déjà ce nom');
        const v = await tx.serviceVersion.create({
          data: { serviceId: id, version: last.version + 1, name, description, pricing: dto.pricing, active: dto.active, effectiveFrom: day(dto.effectiveFrom), reason: dto.reason.trim(), createdById: actor.id, createdByName: actor.name },
        });
        const changes = versionChanges(last, { ...last, name, description, pricing: dto.pricing, active: dto.active });
        await this.journals(tx, actor, null, 'billing.service_version', { code: row.code, version: v.version, name, effectiveFrom: dto.effectiveFrom, changes }, dto.reason.trim());
        return { id, version: v.version };
      });
    } catch (e) {
      if (uniqueViolation(e)) throw new ConflictException('Cette prestation vient de changer : rechargez la page');
      throw e;
    }
  }

  /**
   * Nouvelle règle : prix du catalogue (tous les établissements), tarif particulier d'un établissement, remise ou
   * gratuité (un établissement ou tous). Jamais rétroactive. Le mode de prix contrôlé est celui de la dernière version.
   */
  async addRate(actor: PlatformActor, id: string, dto: ServiceRateDto) {
    const row = await this.service(id);
    const last = versionsOf(row).at(-1)!;
    const t = dto.tenantId ? await this.tenant(dto.tenantId) : null;
    const today = t ? laterDay(localDay(PLATFORM_TZ), localDay(t.timezone)) : localDay(PLATFORM_TZ);
    const money = dto.kind === 'PRICE' || dto.kind === 'SPECIAL_PRICE' || dto.kind === 'DISCOUNT_AMOUNT';
    const input: RateInput = {
      kind: dto.kind, tenantId: t?.id ?? null, currency: money ? dto.currency || t?.currency || null : dto.currency ?? null,
      value: dto.value ?? null, effectiveFrom: dto.effectiveFrom, effectiveTo: dto.effectiveTo || null,
    };
    const errors = rateErrors(last.pricing, input, today, t ? [t.currency] : CURRENCIES);
    if (errors.length) throw new BadRequestException(errors);
    await this.billing.confirm(actor, dto.code);
    return this.db.$transaction(async (tx) => {
      // Une version ajoutée entre-temps (par exemple, la prestation devenue gratuite) est contrôlée à nouveau.
      await lockService(tx, id);
      const top = await tx.serviceVersion.findFirst({ where: { serviceId: id }, orderBy: { version: 'desc' }, select: { version: true, pricing: true } });
      if (top!.version !== last.version) {
        const again = rateErrors(top!.pricing, input, today, t ? [t.currency] : CURRENCIES);
        if (again.length) throw new BadRequestException(again);
      }
      const r = await tx.serviceRate.create({
        data: {
          serviceId: id, tenantId: input.tenantId, kind: input.kind, currency: input.currency, value: input.value, effectiveFrom: day(input.effectiveFrom),
          effectiveTo: input.effectiveTo ? day(input.effectiveTo) : null, reason: dto.reason.trim(), createdById: actor.id, createdByName: actor.name,
        },
      });
      await this.journals(tx, actor, t, 'billing.service_rule_added', {
        code: row.code, service: last.name, rule: rateText(r), effectiveFrom: input.effectiveFrom, ...(input.effectiveTo ? { lastDay: input.effectiveTo } : {}),
      }, dto.reason.trim());
      return { id: r.id };
    });
  }

  /** Arrêt d'une règle (ou annulation avant son début), une seule fois, jamais dans le passé, avec un motif. */
  async endRate(actor: PlatformActor, rateId: string, dto: RateEndDto) {
    const r = await this.db.serviceRate.findUnique({ where: { id: rateId }, include: { stop: true, service: { include: { versions: { orderBy: { version: 'desc' }, take: 1 } } } } });
    if (!r) throw new NotFoundException('Règle introuvable');
    const t = r.tenantId ? await this.tenant(r.tenantId) : null;
    const today = t ? laterDay(localDay(PLATFORM_TZ), localDay(t.timezone)) : localDay(PLATFORM_TZ);
    const errors = endErrors({ kind: r.kind, effectiveFrom: iso(r.effectiveFrom)!, plannedTo: iso(r.effectiveTo), stopped: !!r.stop }, dto.lastDay, today);
    if (errors.length) throw new BadRequestException(errors);
    await this.billing.confirm(actor, dto.code);
    const cancelled = dto.lastDay < iso(r.effectiveFrom)!;
    try {
      return await this.db.$transaction(async (tx) => {
        await tx.serviceRateEnd.create({ data: { rateId, lastDay: day(dto.lastDay), reason: dto.reason.trim(), createdById: actor.id, createdByName: actor.name } });
        await this.journals(tx, actor, t, cancelled ? 'billing.service_rule_cancelled' : 'billing.service_rule_ended', {
          code: r.service.code, service: r.service.versions[0].name, rule: rateText(r), ...(cancelled ? {} : { lastDay: dto.lastDay }),
        }, dto.reason.trim());
        return { id: rateId, lastDay: dto.lastDay, cancelled };
      });
    } catch (e) {
      if (uniqueViolation(e)) throw new ConflictException('Cette règle vient d’être arrêtée : rechargez la page');
      throw e;
    }
  }
}

@ApiTags('Plateforme : prestations complémentaires')
@Public()
@UseGuards(PlatformGuard)
@Controller()
export class ServicesController {
  constructor(private s: ServicesService) {}

  private actor(req: Request) {
    return (req as any).platformAdmin as PlatformActor;
  }

  @Get('platform/billing/services') @Header('Cache-Control', 'no-store')
  list() { return this.s.list(); }

  @Get('platform/billing/services/prices') @Header('Cache-Control', 'no-store')
  prices(@Query('tenantId', ParseUUIDPipe) tenantId: string, @Query('day') onDay?: string) { return this.s.prices(tenantId, onDay); }

  @Get('platform/billing/services/:id/history')
  history(@Param('id', ParseUUIDPipe) id: string) { return this.s.history(id); }

  @Post('platform/billing/services') @Throttle({ default: { limit: 20, ttl: 60000 } })
  create(@Req() req: Request, @Body() dto: ServiceCreateDto) { return this.s.create(this.actor(req), dto); }

  @Post('platform/billing/services/:id/versions') @Throttle({ default: { limit: 20, ttl: 60000 } })
  addVersion(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ServiceVersionDto) { return this.s.addVersion(this.actor(req), id, dto); }

  @Post('platform/billing/services/:id/rates') @Throttle({ default: { limit: 20, ttl: 60000 } })
  addRate(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ServiceRateDto) { return this.s.addRate(this.actor(req), id, dto); }

  @Post('platform/billing/services/rates/:rateId/end') @Throttle({ default: { limit: 20, ttl: 60000 } })
  endRate(@Req() req: Request, @Param('rateId', ParseUUIDPipe) rateId: string, @Body() dto: RateEndDto) { return this.s.endRate(this.actor(req), rateId, dto); }
}
