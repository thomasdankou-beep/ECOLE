'use client';

import { useCallback, useEffect, useState } from 'react';
import { History, Plus } from 'lucide-react';
import { Badge, Button, Card, Dialog, DialogContent, ErrorNote, Field, Input, Missing, Select, Textarea } from '@/components/ui';
import { pf } from '@/lib/platform';
import { CodeField, frDate, money, need, ready, useSubmit } from './facturation-outils';

/**
 * Prestations complémentaires (lot G5g), la « Tarification et prestations » du cahier des charges : catalogue en
 * versions datées, prix du catalogue, remises, tarifs particuliers et gratuités, historique, et prix d'une prestation
 * pour un établissement un jour donné. Rien n'est facturé ici : une prestation n'entre dans un devis ou une facture que
 * si quelqu'un l'y ajoute (lot G5c). Chaque changement demande un code de l'application d'authentification.
 */

type Pricing = 'FIXED' | 'FREE' | 'QUOTE';
type Kind = 'PRICE' | 'SPECIAL_PRICE' | 'DISCOUNT_PERCENT' | 'DISCOUNT_AMOUNT' | 'FREE';
type Rule = {
  id: string; kind: Kind; kindLabel: string; text: string; tenantId: string | null; tenantName: string | null; scope: string; currency: string | null; value: number | null;
  effectiveFrom: string; plannedTo: string | null; lastDay: string | null; state: 'En cours' | 'À venir' | 'Terminée' | 'Annulée'; stopped: boolean; reason: string; createdByName: string;
};
type Version = { version: number; name: string; description: string | null; pricing: Pricing; active: boolean; effectiveFrom: string };
type Service = {
  id: string; code: string; name: string; description: string | null; pricing: Pricing; pricingLabel: string; active: boolean; inCatalogSince: string;
  current: { version: number; effectiveFrom: string } | null; last: Version; upcoming: (Version & { pricingLabel: string })[];
  prices: { currency: string; value: number | null; since: string | null; next: { value: number | null; effectiveFrom: string } | null }[];
  rules: Rule[];
};
type Establishment = { id: string; name: string; currency: string; group: string; today: string };
type Catalog = { today: string; currencies: string[]; pricings: { value: Pricing; label: string }[]; kinds: { value: Kind; label: string }[]; establishments: Establishment[]; services: Service[] };
type PriceList = {
  tenant: { id: string; name: string; currency: string }; day: string;
  items: { id: string; name: string; pricing: Pricing | null; amount: number | null; catalogAmount: number | null; currency: string; basis: string; label: string; rule: { text: string; effectiveFrom: string; lastDay: string | null } | null }[];
};
type HistoryEntry = { at: string; by: string; reason: string; title: string; detail: string };
type Open =
  | { kind: 'create' } | { kind: 'version'; s: Service } | { kind: 'price'; s: Service } | { kind: 'rule'; s: Service } | { kind: 'history'; s: Service }
  | { kind: 'end'; r: Rule & { service: string } };

const STATE_TONE: Record<Rule['state'], 'info' | 'good' | 'warn' | 'bad' | 'accent'> = { 'En cours': 'good', 'À venir': 'info', Terminée: 'warn', Annulée: 'bad' };
/** Colonnes du catalogue à partir de la largeur d'une tablette ; au téléphone, chaque prestation s'empile. */
const SERVICE_COLS = 'md:grid-cols-[minmax(0,2fr)_minmax(0,1.5fr)_minmax(0,1fr)_auto] md:gap-3';
const toAmount = (v: string) => Number(v.replace(/[\s  ]/g, ''));
const toPercent = (v: string) => Math.round(Number(v.replace(',', '.')) * 100);
const eve = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** Prix du catalogue d'une prestation, monnaie par monnaie, avec le prochain prix s'il est déjà fixé. */
function CatalogPrice({ s }: { s: Service }) {
  if (s.pricing === 'FREE') return <span>Gratuite</span>;
  if (s.pricing === 'QUOTE') return <span>Sur devis</span>;
  if (s.prices.length === 0) return <span className="text-warn">Prix à fixer (INFORMATION MANQUANTE)</span>;
  return (
    <span className="grid gap-0.5">
      {s.prices.map((p) => (
        <span key={p.currency}>
          {p.value === null ? <span className="text-muted">Pas encore de prix en {p.currency}</span> : <><b>{money(p.value, p.currency)}</b> <span className="text-xs text-muted">depuis le {frDate(p.since)}</span></>}
          {p.next && p.next.value !== null && <span className="block text-xs">puis {money(p.next.value, p.currency)} le {frDate(p.next.effectiveFrom)}</span>}
        </span>
      ))}
    </span>
  );
}

function ServiceState({ s }: { s: Service }) {
  return (
    <span className="grid justify-items-start gap-1 text-xs">
      {!s.current ? <Badge tone="info">À venir</Badge> : s.active ? <Badge tone="good">Active</Badge> : <Badge tone="warn">Désactivée</Badge>}
      {!s.current && <span>Au catalogue à partir du {frDate(s.inCatalogSince)}</span>}
      {s.upcoming.map((v) => (
        <span key={v.version}>Le {frDate(v.effectiveFrom)} : {v.active ? (v.pricing !== s.pricing ? v.pricingLabel.toLowerCase() : 'nouvelle version') : 'désactivée'}</span>
      ))}
    </span>
  );
}

export function Prestations() {
  const [c, setC] = useState<Catalog | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const load = useCallback(() => {
    pf<Catalog>('GET', '/billing/services').then(setC).catch(setError);
  }, []);
  useEffect(load, [load]);
  if (error) return <ErrorNote error={error} />;
  if (!c) return null;
  const done = () => { setOpen(null); load(); };
  const rules = c.services.flatMap((s) => s.rules.map((r) => ({ ...r, service: s.name })));
  return (
    <div className="grid gap-4">
      <Card className="grid gap-3 p-0 sm:p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4">
          <div>
            <h3 className="font-bold">Catalogue des prestations</h3>
            <p className="text-sm text-muted">Aucune prestation n’est ajoutée d’office : elle entre dans un devis ou une facture seulement quand quelqu’un l’y ajoute (lot G5c). Chaque changement a une date d’effet, jamais passée, et un motif ; rien ne s’efface.</p>
          </div>
          <Button onClick={() => setOpen({ kind: 'create' })}><Plus className="size-4" /> Nouvelle prestation</Button>
        </div>
        {/* Une liste plutôt qu'un tableau : au téléphone, chaque prestation tient en largeur, boutons compris. */}
        <div>
          <div className={`hidden border-b border-line px-4 pb-2 text-xs font-bold uppercase tracking-wider text-muted md:grid ${SERVICE_COLS}`} aria-hidden="true">
            <span>Prestation</span><span>Prix du catalogue</span><span>État</span><span />
          </div>
          <ul aria-label="Catalogue des prestations">
            {c.services.map((s) => (
              <li key={s.id} className={`grid gap-2 border-b border-line px-4 py-3 last:border-b-0 md:items-center ${SERVICE_COLS}`}>
                <div>
                  <b>{s.name}</b>
                  <span className="block text-xs text-muted">{s.description ?? 'Description : INFORMATION MANQUANTE'}</span>
                </div>
                <div className="text-sm"><CatalogPrice s={s} /></div>
                <ServiceState s={s} />
                <div className="flex flex-wrap items-center gap-1 md:justify-end">
                  <Button size="sm" variant="outline" aria-label={`Modifier ${s.name}`} onClick={() => setOpen({ kind: 'version', s })}>Modifier</Button>
                  {s.last.pricing === 'FIXED' && <Button size="sm" variant="outline" aria-label={`Nouveau prix de ${s.name}`} onClick={() => setOpen({ kind: 'price', s })}>Nouveau prix</Button>}
                  {s.last.pricing !== 'FREE' && <Button size="sm" variant="outline" aria-label={`Remise, tarif particulier ou gratuité pour ${s.name}`} onClick={() => setOpen({ kind: 'rule', s })}>Remise ou tarif</Button>}
                  <Button size="icon" variant="ghost" aria-label={`Historique de ${s.name}`} onClick={() => setOpen({ kind: 'history', s })}><History className="size-4" /></Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </Card>

      <Card className="grid gap-3 p-0 sm:p-0">
        <div className="px-4 pt-4">
          <h3 className="font-bold">Remises, tarifs particuliers et gratuités</h3>
          <p className="text-sm text-muted">Une seule règle s’applique à la fois, jamais de cumul : la gratuité d’abord, puis le tarif particulier, puis le prix du catalogue moins une remise (celle de l’établissement avant celle de tous).</p>
        </div>
        {rules.length === 0 ? <p className="px-4 pb-4 text-sm text-muted">Aucune règle en cours ni à venir.</p> : (
          <ul aria-label="Remises, tarifs particuliers et gratuités en cours ou à venir" className="border-t border-line">
            {rules.map((r) => (
              <li key={r.id} className="grid gap-1 border-b border-line px-4 py-3 text-sm last:border-b-0 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1.6fr)_minmax(0,1.2fr)_auto] md:items-center md:gap-3">
                <div>
                  <b>{r.service}</b>
                  <span className="block">{r.scope}</span>
                </div>
                <div>{r.text}<span className="block text-xs text-muted">{r.reason}</span></div>
                <div>du {frDate(r.effectiveFrom)}{r.lastDay ? ` au ${frDate(r.lastDay)}` : ', sans fin'}</div>
                <div className="flex items-center gap-2 md:justify-end">
                  <Badge tone={STATE_TONE[r.state]}>{r.state}</Badge>
                  {!r.stopped && <Button size="sm" variant="outline" aria-label={`Arrêter : ${r.text}, ${r.scope}`} onClick={() => setOpen({ kind: 'end', r })}>Arrêter</Button>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <PriceCheck c={c} />

      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        {open?.kind === 'create' && <CreateDialog c={c} done={done} />}
        {open?.kind === 'version' && <VersionDialog c={c} s={open.s} done={done} />}
        {open?.kind === 'price' && <PriceDialog c={c} s={open.s} done={done} />}
        {open?.kind === 'rule' && <RuleDialog c={c} s={open.s} done={done} />}
        {open?.kind === 'end' && <EndDialog c={c} r={open.r} done={done} />}
        {open?.kind === 'history' && <HistoryDialog s={open.s} />}
      </Dialog>
    </div>
  );
}

/** Prix de chaque prestation pour un établissement, un jour donné : simple consultation, rien n'est facturé. */
function PriceCheck({ c }: { c: Catalog }) {
  const first = c.establishments[0];
  const [tenantId, setTenantId] = useState(first?.id ?? '');
  const [day, setDay] = useState(first?.today ?? c.today);
  const [list, setList] = useState<PriceList | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!tenantId || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
    setError(null);
    pf<PriceList>('GET', `/billing/services/prices?tenantId=${tenantId}&day=${day}`).then(setList).catch(setError);
  }, [tenantId, day, c]);
  if (!first) return null;
  return (
    <Card className="grid gap-3">
      <div>
        <h3 className="font-bold">Prix pour un établissement</h3>
        <p className="text-sm text-muted">Le prix que paierait un établissement le jour choisi, et la règle qui s’applique. Simple consultation : rien n’est ajouté à un devis ni à une facture.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Établissement"><Select value={tenantId} onChange={(e) => setTenantId(e.target.value)}>{c.establishments.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.group})</option>)}</Select></Field>
        <Field label="Jour"><Input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field>
      </div>
      <ErrorNote error={error} />
      {list && (
        <ul className="grid gap-2" aria-label="Prix des prestations pour cet établissement">
          {list.items.map((i) => (
            <li key={i.id} className="grid gap-0.5 rounded-lg bg-sunk p-2 text-sm">
              <span className="flex flex-wrap justify-between gap-2"><b>{i.name}</b><b>{i.amount === null ? '—' : money(i.amount, i.currency)}</b></span>
              <span className="text-xs text-muted">
                {i.label}{i.catalogAmount !== null && i.amount !== i.catalogAmount ? ` (prix du catalogue : ${money(i.catalogAmount, i.currency)})` : ''}
                {i.rule ? ` · ${i.rule.text}, du ${frDate(i.rule.effectiveFrom)}${i.rule.lastDay ? ` au ${frDate(i.rule.lastDay)}` : ''}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function CreateDialog({ c, done }: { c: Catalog; done: () => void }) {
  const [f, setF] = useState({ name: '', description: '', pricing: 'FIXED' as Pricing, price: '', currency: 'XOF', effectiveFrom: c.today, reason: '', code: '' });
  const { busy, error, submit } = useSubmit(done, 'Prestation ajoutée au catalogue');
  const missing = [need.text(f.name, 'le nom', 3), need.value(f.effectiveFrom, 'la date d’effet'), need.text(f.reason, 'le motif'), need.code(f.code)];
  return (
    <DialogContent title="Nouvelle prestation" description="Elle entre au catalogue à sa date d’effet. Aucune prestation n’est imposée à un établissement.">
      <form className="grid gap-3" onSubmit={(ev) => {
        ev.preventDefault();
        submit(() => pf('POST', '/billing/services', {
          name: f.name, description: f.description || null, pricing: f.pricing, effectiveFrom: f.effectiveFrom, reason: f.reason, code: f.code,
          ...(f.pricing === 'FIXED' && f.price.trim() ? { price: toAmount(f.price), currency: f.currency } : {}),
        }));
      }}>
        <Field label="Nom"><Input value={f.name} minLength={3} maxLength={120} onChange={(x) => setF({ ...f, name: x.target.value })} required /></Field>
        <Field label="Description" hint="Ce que comprend la prestation (facultatif)."><Textarea rows={3} maxLength={2000} value={f.description} onChange={(x) => setF({ ...f, description: x.target.value })} /></Field>
        <Field label="Mode de prix"><Select value={f.pricing} onChange={(x) => setF({ ...f, pricing: x.target.value as Pricing })}>{c.pricings.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</Select></Field>
        {f.pricing === 'FIXED' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Prix de départ" hint="Laissez vide si le prix n’est pas encore fixé."><Input inputMode="numeric" value={f.price} onChange={(x) => setF({ ...f, price: x.target.value })} /></Field>
            <Field label="Monnaie"><Select value={f.currency} onChange={(x) => setF({ ...f, currency: x.target.value })}>{c.currencies.map((m) => <option key={m} value={m}>{m}</option>)}</Select></Field>
          </div>
        )}
        <Field label="Date d’effet" hint="Aujourd’hui au plus tôt."><Input type="date" min={c.today} value={f.effectiveFrom} onChange={(x) => setF({ ...f, effectiveFrom: x.target.value })} required /></Field>
        <Field label="Motif"><Input value={f.reason} minLength={5} maxLength={300} onChange={(x) => setF({ ...f, reason: x.target.value })} required /></Field>
        <CodeField value={f.code} onChange={(code) => setF({ ...f, code })} />
        <ErrorNote error={error} />
        <Button type="submit" loading={busy} disabled={!ready(missing)}>Ajouter au catalogue</Button>
        <Missing items={missing} />
      </form>
    </DialogContent>
  );
}

function VersionDialog({ c, s, done }: { c: Catalog; s: Service; done: () => void }) {
  const [f, setF] = useState({ name: s.last.name, description: s.last.description ?? '', pricing: s.last.pricing, active: s.last.active, effectiveFrom: c.today, reason: '', code: '' });
  const { busy, error, submit } = useSubmit(done, 'Nouvelle version enregistrée');
  const missing = [need.text(f.name, 'le nom', 3), need.value(f.effectiveFrom, 'la date d’effet'), need.text(f.reason, 'le motif'), need.code(f.code)];
  return (
    <DialogContent title={`Modifier : ${s.last.name}`} description="Nom, description, mode de prix ou activation. La nouvelle version s’applique à partir de sa date d’effet ; l’ancienne reste dans l’historique.">
      <form className="grid gap-3" onSubmit={(ev) => { ev.preventDefault(); submit(() => pf('POST', `/billing/services/${s.id}/versions`, { ...f, description: f.description || null })); }}>
        <Field label="Nom"><Input value={f.name} minLength={3} maxLength={120} onChange={(x) => setF({ ...f, name: x.target.value })} required /></Field>
        <Field label="Description"><Textarea rows={3} maxLength={2000} value={f.description} onChange={(x) => setF({ ...f, description: x.target.value })} /></Field>
        <Field label="Mode de prix"><Select value={f.pricing} onChange={(x) => setF({ ...f, pricing: x.target.value as Pricing })}>{c.pricings.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</Select></Field>
        <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-line p-3">
          <input type="checkbox" className="size-5 flex-none accent-[var(--brand)]" checked={f.active} onChange={(x) => setF({ ...f, active: x.target.checked })} />
          <span>Proposée aux établissements (active)</span>
        </label>
        <Field label="Date d’effet" hint="Aujourd’hui au plus tôt."><Input type="date" min={c.today} value={f.effectiveFrom} onChange={(x) => setF({ ...f, effectiveFrom: x.target.value })} required /></Field>
        <Field label="Motif"><Input value={f.reason} minLength={5} maxLength={300} onChange={(x) => setF({ ...f, reason: x.target.value })} required /></Field>
        <CodeField value={f.code} onChange={(code) => setF({ ...f, code })} />
        <ErrorNote error={error} />
        <Button type="submit" loading={busy} disabled={!ready(missing)}>Enregistrer cette version</Button>
        <Missing items={missing} />
      </form>
    </DialogContent>
  );
}

function PriceDialog({ c, s, done }: { c: Catalog; s: Service; done: () => void }) {
  const [f, setF] = useState({ currency: s.prices[0]?.currency ?? 'XOF', value: '', effectiveFrom: c.today, reason: '', code: '' });
  const { busy, error, submit } = useSubmit(done, 'Nouveau prix enregistré');
  const missing = [need.value(f.value.trim(), 'le prix'), need.value(f.effectiveFrom, 'la date d’effet'), need.text(f.reason, 'le motif'), need.code(f.code)];
  return (
    <DialogContent title={`Nouveau prix : ${s.last.name}`} description="Pour tous les établissements, à partir de sa date d’effet, jamais avant. Le prix précédent reste dans l’historique.">
      <form className="grid gap-3" onSubmit={(ev) => {
        ev.preventDefault();
        submit(() => pf('POST', `/billing/services/${s.id}/rates`, { kind: 'PRICE', currency: f.currency, value: toAmount(f.value), effectiveFrom: f.effectiveFrom, reason: f.reason, code: f.code }));
      }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Prix"><Input inputMode="numeric" value={f.value} onChange={(x) => setF({ ...f, value: x.target.value })} required /></Field>
          <Field label="Monnaie"><Select value={f.currency} onChange={(x) => setF({ ...f, currency: x.target.value })}>{c.currencies.map((m) => <option key={m} value={m}>{m}</option>)}</Select></Field>
        </div>
        <Field label="Date d’effet" hint="Aujourd’hui au plus tôt."><Input type="date" min={c.today} value={f.effectiveFrom} onChange={(x) => setF({ ...f, effectiveFrom: x.target.value })} required /></Field>
        <Field label="Motif"><Input value={f.reason} minLength={5} maxLength={300} onChange={(x) => setF({ ...f, reason: x.target.value })} required /></Field>
        <CodeField value={f.code} onChange={(code) => setF({ ...f, code })} />
        <ErrorNote error={error} />
        <Button type="submit" loading={busy} disabled={!ready(missing)}>Enregistrer le prix</Button>
        <Missing items={missing} />
      </form>
    </DialogContent>
  );
}

function RuleDialog({ c, s, done }: { c: Catalog; s: Service; done: () => void }) {
  const kinds = c.kinds.filter((k) => k.value !== 'PRICE' && (s.last.pricing === 'FIXED' || k.value === 'SPECIAL_PRICE' || k.value === 'FREE'));
  const [f, setF] = useState({ kind: kinds[0].value, tenantId: '', currency: 'XOF', value: '', effectiveFrom: c.today, effectiveTo: '', reason: '', code: '' });
  const { busy, error, submit } = useSubmit(done, 'Règle enregistrée');
  const tenant = c.establishments.find((t) => t.id === f.tenantId) ?? null;
  const needsTenant = f.kind === 'SPECIAL_PRICE';
  const isMoney = f.kind === 'SPECIAL_PRICE' || f.kind === 'DISCOUNT_AMOUNT';
  const currency = tenant ? tenant.currency : f.currency;
  const missing = [needsTenant && need.value(f.tenantId, 'l’établissement'), f.kind !== 'FREE' && need.value(f.value.trim(), 'la valeur'),
    need.value(f.effectiveFrom, 'la date d’effet'), need.text(f.reason, 'le motif'), need.code(f.code)];
  return (
    <DialogContent title={`Remise, tarif particulier ou gratuité : ${s.last.name}`} description="Une seule règle s’applique à la fois, jamais de cumul. Elle commence au plus tôt aujourd’hui et peut s’arrêter plus tard ; rien ne s’efface.">
      <form className="grid gap-3" onSubmit={(ev) => {
        ev.preventDefault();
        submit(() => pf('POST', `/billing/services/${s.id}/rates`, {
          kind: f.kind, tenantId: f.tenantId || null, currency: isMoney ? currency : null,
          value: f.kind === 'FREE' ? null : f.kind === 'DISCOUNT_PERCENT' ? toPercent(f.value) : toAmount(f.value),
          effectiveFrom: f.effectiveFrom, effectiveTo: f.effectiveTo || null, reason: f.reason, code: f.code,
        }));
      }}>
        <Field label="Règle"><Select value={f.kind} onChange={(x) => setF({ ...f, kind: x.target.value as Kind })}>{kinds.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</Select></Field>
        <Field label="Pour" hint={needsTenant ? 'Un tarif particulier vise un établissement.' : undefined}>
          <Select value={f.tenantId} onChange={(x) => setF({ ...f, tenantId: x.target.value })} required={needsTenant}>
            {needsTenant ? <option value="">Choisissez un établissement</option> : <option value="">Tous les établissements</option>}
            {c.establishments.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.group})</option>)}
          </Select>
        </Field>
        {f.kind !== 'FREE' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={f.kind === 'DISCOUNT_PERCENT' ? 'Pourcentage' : f.kind === 'SPECIAL_PRICE' ? 'Prix pour cet établissement' : 'Montant de la remise'} hint={f.kind === 'DISCOUNT_PERCENT' ? 'Par exemple 10 pour 10 %.' : undefined}>
              <Input inputMode="decimal" value={f.value} onChange={(x) => setF({ ...f, value: x.target.value })} required />
            </Field>
            {isMoney && (tenant
              ? <Field label="Monnaie"><Input value={tenant.currency} readOnly /></Field>
              : <Field label="Monnaie"><Select value={f.currency} onChange={(x) => setF({ ...f, currency: x.target.value })}>{c.currencies.map((m) => <option key={m} value={m}>{m}</option>)}</Select></Field>)}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Date d’effet" hint="Aujourd’hui au plus tôt."><Input type="date" min={c.today} value={f.effectiveFrom} onChange={(x) => setF({ ...f, effectiveFrom: x.target.value })} required /></Field>
          <Field label="Dernier jour (facultatif)" hint="Vide : sans fin."><Input type="date" min={f.effectiveFrom} value={f.effectiveTo} onChange={(x) => setF({ ...f, effectiveTo: x.target.value })} /></Field>
        </div>
        <Field label="Motif"><Input value={f.reason} minLength={5} maxLength={300} onChange={(x) => setF({ ...f, reason: x.target.value })} required /></Field>
        <CodeField value={f.code} onChange={(code) => setF({ ...f, code })} />
        <ErrorNote error={error} />
        <Button type="submit" loading={busy} disabled={!ready(missing)}>Enregistrer la règle</Button>
        <Missing items={missing} />
      </form>
    </DialogContent>
  );
}

function EndDialog({ c, r, done }: { c: Catalog; r: Rule & { service: string }; done: () => void }) {
  const notStarted = r.effectiveFrom > c.today;
  const [f, setF] = useState({ cancel: notStarted, lastDay: notStarted ? r.effectiveFrom : c.today, reason: '', code: '' });
  const { busy, error, submit } = useSubmit(done, f.cancel ? 'Règle annulée' : 'Règle arrêtée');
  const missing = [!f.cancel && need.value(f.lastDay, 'le dernier jour d’application'), need.text(f.reason, 'le motif'), need.code(f.code)];
  return (
    <DialogContent title={`Arrêter : ${r.text}`} description={`${r.service}, ${r.scope}. La règle s’applique encore jusqu’au dernier jour choisi ; l’arrêt est définitif et reste dans l’historique.`}>
      <form className="grid gap-3" onSubmit={(ev) => { ev.preventDefault(); submit(() => pf('POST', `/billing/services/rates/${r.id}/end`, { lastDay: f.cancel ? eve(r.effectiveFrom) : f.lastDay, reason: f.reason, code: f.code })); }}>
        {notStarted && (
          <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-line p-3">
            <input type="checkbox" className="size-5 flex-none accent-[var(--brand)]" checked={f.cancel} onChange={(x) => setF({ ...f, cancel: x.target.checked })} />
            <span>Annuler cette règle : elle n’a pas commencé (début le {frDate(r.effectiveFrom)}) et ne s’appliquera jamais</span>
          </label>
        )}
        {!f.cancel && (
          <Field label="Dernier jour d’application" hint="Aujourd’hui au plus tôt."><Input type="date" min={notStarted ? r.effectiveFrom : c.today} max={r.plannedTo ? eve(r.plannedTo) : undefined} value={f.lastDay} onChange={(x) => setF({ ...f, lastDay: x.target.value })} required /></Field>
        )}
        <Field label="Motif"><Input value={f.reason} minLength={5} maxLength={300} onChange={(x) => setF({ ...f, reason: x.target.value })} required /></Field>
        <CodeField value={f.code} onChange={(code) => setF({ ...f, code })} />
        <ErrorNote error={error} />
        <Button type="submit" variant="outline" loading={busy} disabled={!ready(missing)}>{f.cancel ? 'Annuler la règle' : 'Arrêter la règle'}</Button>
        <Missing items={missing} />
      </form>
    </DialogContent>
  );
}

function HistoryDialog({ s }: { s: Service }) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    pf<{ entries: HistoryEntry[] }>('GET', `/billing/services/${s.id}/history`).then((h) => setEntries(h.entries)).catch(setError);
  }, [s.id]);
  return (
    <DialogContent title={`Historique : ${s.name}`} description="En ajout seul : rien ne s’efface ni ne se modifie.">
      <ErrorNote error={error} />
      {entries && (
        <ul className="grid max-h-[60vh] gap-2 overflow-y-auto">
          {entries.map((e, i) => (
            <li key={`${e.at}-${i}`} className="rounded-lg bg-sunk p-2 text-sm">
              <b>{e.title}</b>
              <span className="block text-xs text-muted">{new Date(e.at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })} · {e.by}</span>
              <span className="block text-xs">{e.detail}</span>
              <span className="block text-xs">Motif : {e.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </DialogContent>
  );
}
