'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileText, Paperclip, Plus } from 'lucide-react';
import { Badge, Button, Card, Chips, Dialog, DialogContent, ErrorNote, Field, Input, Select, Textarea } from '@/components/ui';
import { pf } from '@/lib/platform';
import { CodeField, frDate, money, useSubmit } from './facturation-outils';

/**
 * Factures et documents (lot G5c) : documents provisoires de l'abonnement et des prestations, jamais une facture fiscale
 * (lot G5f) ; prochain document de chaque client, ou la décision qu'il attend ; exclusions qui touchent un document émis,
 * décidées par le Super Admin (D-G5-13 B), avec l'avoir provisoire qui suit ; devis et proformas de prestations du
 * catalogue (lot G5g). Chaque opération demande un code actuel de l'application d'authentification. Aucun paiement ici.
 */

type Kind = 'SUBSCRIPTION' | 'CREDIT_NOTE' | 'SERVICE_QUOTE' | 'SERVICE_PROFORMA';
type Doc = {
  id: string; kind: Kind; label: string; reference: string; group: { id: string; name: string }; currency: string; issueDate: string; dueDate: string | null;
  total: number; yearLabel: string | null; relatedDocumentId: string | null; createdByName: string; establishments: number; tenantIds: string[]; title: string | null;
};
type Next = { state: string; message?: string; decision?: string; line?: { kindLabel: string; date: string; pupils: number; due: number } };
type Plan = {
  groupId: string; groupName: string; state: 'READY' | 'CLOSED' | 'NOTHING'; decision?: string; message?: string; date?: string; yearLabel?: string; total?: number;
  establishments: { tenantId: string; name: string; next: Next }[];
};
type List = {
  decisions: { firstYearDivisor: 'SCHOOL_MONTHS' | 'TWELVE' | null; rounding: 'FLOOR' | null }; openDecisions: Record<string, string>; mention: string; documents: Doc[]; plans: Plan[];
};
type Preview = {
  related: string; state: 'READY' | 'NONE' | 'CLOSED'; amount?: number; alreadyBilled?: number; message?: string; decision?: string;
  year?: { pupils: number; fullYear: number; amount: number; minimumApplied: boolean; share: { months: number; of: number } | null };
};
type Exclusion = {
  id: string; tenant: { id: string; name: string }; currency: string | null; status: 'PENDING' | 'VALIDATED' | 'REFUSED'; countLabel: string; referenceDate: string;
  yearLabel: string; matricule: string; className: string | null; cancelReason: string | null; justification: string; fileUrl: string | null; requestedByName: string;
  requestedAt: string; decidedByName: string | null; decidedAt: string | null; decisionNote: string | null; documentDate: string | null; requestDeadline: string | null;
  preview: Preview | null;
};
type Exclusions = { mention: string; waiting: number; exclusions: Exclusion[] };
type Line = {
  id: string; position: number; tenant: { id: string; name: string }; label: string; amount: number; countKind: string | null; referenceDate: string | null; pupils: number | null;
  pupilsChange: number | null; pricePerPupil: number | null; minimum: number | null; minimumApplied: boolean | null; fullYear: number | null; shareMonths: number | null;
  shareOf: number | null; yearAmount: number | null; alreadyBilled: number | null; serviceName: string | null; quantity: number | null; unitPrice: number | null;
  priceBasis: string | null;
};
type Detail = Omit<Doc, 'establishments' | 'tenantIds' | 'title' | 'relatedDocumentId'> & {
  data: Record<string, unknown> | null; createdByKind: string; related: { id: string; reference: string; kind: Kind } | null;
  relatedBy: { id: string; reference: string; kind: Kind; total: number }[]; lines: Line[];
};
type Establishment = { id: string; name: string; currency: string; group: string };
type Price = { id: string; name: string; amount: number | null; catalogAmount: number | null; currency: string; basis: string; label: string };
type Open = { kind: 'decide'; x: Exclusion } | { kind: 'detail'; id: string } | { kind: 'new' };

const NOT_OFFERED = ['NOT_IN_CATALOG', 'INACTIVE', 'MISSING'];
const KIND_TONE: Record<Kind, 'info' | 'good' | 'warn' | 'accent'> = { SUBSCRIPTION: 'info', CREDIT_NOTE: 'good', SERVICE_QUOTE: 'accent', SERVICE_PROFORMA: 'warn' };
const PLAN_TONE = { READY: 'good', CLOSED: 'warn', NOTHING: 'info' } as const;
const STATUS: Record<Exclusion['status'], [string, 'warn' | 'good' | 'bad']> = { PENDING: ['À décider', 'warn'], VALIDATED: ['Validée', 'good'], REFUSED: ['Refusée', 'bad'] };
const dateTime = (d: string) => new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
const pupils = (n: number) => `${n} élève${n > 1 ? 's' : ''}`;
const share = (y: Preview['year']) => (y?.share ? `, part ${y.share.months}/${y.share.of}` : '');

export function Documents() {
  const [list, setList] = useState<List | null>(null);
  const [ex, setEx] = useState<Exclusions | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const load = useCallback(() => {
    pf<List>('GET', '/billing/documents').then(setList).catch(setError);
    pf<Exclusions>('GET', '/billing/exclusions').then(setEx).catch(setError);
  }, []);
  useEffect(load, [load]);
  if (error) return <ErrorNote error={error} />;
  if (!list || !ex) return null;
  const done = () => { setOpen(null); load(); };
  const pending = ex.exclusions.filter((x) => x.status === 'PENDING');
  const decided = ex.exclusions.filter((x) => x.status !== 'PENDING');
  const d = list.decisions;
  return (
    <div className="grid gap-4">
      <Card className="grid gap-2">
        <h3 className="font-bold">Documents provisoires</h3>
        <p className="rounded-lg bg-warn-soft p-2 text-sm font-bold">{list.mention}</p>
        <p className="text-sm text-muted">Proformas et relevés de l’abonnement, avoirs, devis et proformas de prestations : jamais une facture fiscale (lot G5f), aucun paiement ici (lot G5d). Un document émis ne change plus.</p>
        <p className="text-sm">
          Part de la première année : <b>{d.firstYearDivisor === 'SCHOOL_MONTHS' ? 'mois de l’année scolaire' : d.firstYearDivisor === 'TWELVE' ? '12 mois' : 'en attente de votre décision (D-G5-29)'}</b>
          {' · '}Arrondi d’une part : <b>{d.rounding === 'FLOOR' ? 'au franc inférieur' : 'en attente de votre décision'}</b>
        </p>
      </Card>

      <Card className="grid gap-3">
        <div>
          <h3 className="font-bold">Exclusions à décider {pending.length > 0 && <Badge tone="warn">{pending.length}</Badge>}</h3>
          <p className="text-sm text-muted">Une inscription annulée pour erreur de saisie, déjà demandée par un document émis : Cahiora décide (D-G5-13 B). Validée, elle donne un avoir provisoire si le montant de l’année baisse ; au minimum annuel, rien ne change. Jamais le nom de l’élève ici.</p>
        </div>
        {pending.length === 0 ? <p className="text-sm text-muted">Aucune demande en attente.</p> : (
          <ul className="grid gap-2" aria-label="Exclusions à décider">
            {pending.map((x) => (
              <li key={x.id} className="grid gap-1 rounded-lg border border-line p-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="min-w-0"><b>{x.tenant.name}</b><span className="block text-muted">Inscription {x.matricule}{x.className ? ` · ${x.className}` : ''}</span></span>
                  <Badge tone="warn">À décider</Badge>
                </div>
                <span>{x.countLabel} du {frDate(x.referenceDate)} · document du {frDate(x.documentDate)} · demandée le {dateTime(x.requestedAt)} par {x.requestedByName}</span>
                <PreviewText p={x.preview} currency={x.currency} />
                <div className="pt-1"><Button size="sm" onClick={() => setOpen({ kind: 'decide', x })} aria-label={`Décider : inscription ${x.matricule}, ${x.tenant.name}`}>Décider</Button></div>
              </li>
            ))}
          </ul>
        )}
        {decided.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer font-bold">Décisions prises ({decided.length})</summary>
            <ul className="mt-2 grid gap-2">
              {decided.map((x) => (
                <li key={x.id} className="grid gap-0.5 rounded-lg bg-sunk p-2">
                  <span className="flex flex-wrap items-center justify-between gap-2"><b>{x.tenant.name} · {x.matricule}</b><Badge tone={STATUS[x.status][1]}>{STATUS[x.status][0]}</Badge></span>
                  <span className="text-xs text-muted">Le {x.decidedAt ? dateTime(x.decidedAt) : '—'} par {x.decidedByName}{x.decisionNote ? ` : « ${x.decisionNote} »` : ''}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>

      <Card className="grid gap-3">
        <div>
          <h3 className="font-bold">Prochain document de chaque client</h3>
          <p className="text-sm text-muted">Calculé par la tâche planifiée à partir des comptages figés ; un calcul qui attend une décision ne produit aucun montant.</p>
        </div>
        {list.plans.length === 0 ? <p className="text-sm text-muted">Aucun client avec un abonnement.</p> : (
          <ul className="grid gap-2" aria-label="Prochain document de chaque client">
            {list.plans.map((p) => (
              <li key={p.groupId} className="grid gap-1 rounded-lg bg-sunk p-3 text-sm">
                <span className="flex flex-wrap items-start justify-between gap-2">
                  <b>{p.groupName}</b>
                  <Badge tone={PLAN_TONE[p.state]}>{p.state === 'READY' ? 'Prêt' : p.state === 'CLOSED' ? `En attente : ${p.decision}` : 'Rien à émettre'}</Badge>
                </span>
                {p.state === 'READY' && <span>Document du {frDate(p.date)} : <b>{money(p.total ?? 0, null)}</b> (année {p.yearLabel})</span>}
                {p.state === 'CLOSED' && <span>{p.message}</span>}
                {p.establishments.map((e) => (
                  <span key={e.tenantId} className="text-xs text-muted">{e.name} : {e.next.line ? `${e.next.line.kindLabel} du ${frDate(e.next.line.date)}, ${pupils(e.next.line.pupils)}, ${money(e.next.line.due, null)}` : e.next.message}</span>
                ))}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="grid gap-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="font-bold">Documents émis</h3>
            <p className="text-sm text-muted">Du plus récent au plus ancien. Référence provisoire « PROV-… », jamais un numéro de facture.</p>
          </div>
          <Button onClick={() => setOpen({ kind: 'new' })}><Plus className="size-4" /> Devis ou proforma de prestations</Button>
        </div>
        {list.documents.length === 0 ? <p className="text-sm text-muted">Aucun document émis.</p> : (
          <ul className="grid gap-2" aria-label="Documents émis">
            {list.documents.map((x) => (
              <li key={x.id} className="grid gap-1 rounded-lg border border-line p-3 text-sm md:grid-cols-[minmax(0,1.4fr)_minmax(0,1.6fr)_auto_auto] md:items-center md:gap-3">
                <span className="min-w-0"><Badge tone={KIND_TONE[x.kind]}>{x.label}</Badge><span className="mt-1 block font-mono text-xs">{x.reference}</span></span>
                <span className="min-w-0"><b>{x.group.name}</b><span className="block text-xs text-muted">Le {frDate(x.issueDate)}{x.dueDate ? ` · échéance le ${frDate(x.dueDate)}` : ''}{x.yearLabel ? ` · année ${x.yearLabel}` : ''}</span></span>
                <b className="md:text-right">{x.kind === 'CREDIT_NOTE' ? '− ' : ''}{money(x.total, x.currency)}</b>
                <Button size="sm" variant="outline" onClick={() => setOpen({ kind: 'detail', id: x.id })} aria-label={`Voir ${x.label} ${x.reference}`}><FileText className="size-4" /> Voir</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        {open?.kind === 'decide' && <DecideDialog x={open.x} done={done} />}
        {open?.kind === 'detail' && <DetailDialog id={open.id} />}
        {open?.kind === 'new' && <ServiceDocumentDialog docs={list.documents} done={done} />}
      </Dialog>
    </div>
  );
}

/** Ce que donnerait la validation : l'avoir, rien au minimum, ou la décision qu'attend le calcul. */
function PreviewText({ p, currency }: { p: Preview | null; currency: string | null }) {
  if (!p) return null;
  if (p.state === 'CLOSED') return <span className="text-warn">Avoir en attente de la décision {p.decision} : {p.message}</span>;
  if (p.state === 'NONE') return <span>Si elle est validée : aucun avoir ({p.message?.toLowerCase()}).</span>;
  return (
    <span>
      Si elle est validée : avoir provisoire de <b>{money(p.amount ?? 0, currency)}</b> sur le document {p.related}
      <span className="block text-xs text-muted">{pupils(p.year?.pupils ?? 0)} après l’exclusion{share(p.year)} : {money(p.year?.amount ?? 0, currency)} pour l’année, {money(p.alreadyBilled ?? 0, currency)} déjà demandés.</span>
    </span>
  );
}

function DecideDialog({ x, done }: { x: Exclusion; done: () => void }) {
  const [note, setNote] = useState('');
  const [code, setCode] = useState('');
  const [local, setLocal] = useState<string | null>(null);
  const { busy, error, submit } = useSubmit(done, 'Décision enregistrée');
  const send = (decision: 'VALIDATED' | 'REFUSED') => {
    if (decision === 'REFUSED' && note.trim().length < 5) return setLocal('Un refus exige un motif (5 caractères au moins).');
    setLocal(null);
    return submit(() => pf('POST', `/billing/exclusions/${x.id}/decision`, { tenantId: x.tenant.id, decision, note: note.trim() || undefined, code }));
  };
  return (
    <DialogContent title={`Exclusion : inscription ${x.matricule}`} description={`${x.tenant.name} · ${x.countLabel} du ${frDate(x.referenceDate)}, déjà demandée par le document du ${frDate(x.documentDate)}.`}>
      <div className="grid gap-3 text-sm">
        <p className="rounded-lg bg-sunk p-2">Annulation : « {x.cancelReason ?? '—'} »<br />Justification : « {x.justification} »</p>
        {x.fileUrl && <a className="inline-flex items-center gap-1 font-bold text-brand underline" href={x.fileUrl} target="_blank" rel="noreferrer"><Paperclip className="size-4" /> Voir le justificatif</a>}
        <PreviewText p={x.preview} currency={x.currency} />
        <Field label="Motif de la décision" hint="Obligatoire pour un refus ; la direction le lit.">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </Field>
        <CodeField value={code} onChange={setCode} />
        <ErrorNote error={local ?? error} />
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => send('VALIDATED')} loading={busy} disabled={code.length !== 6}>Valider l’exclusion</Button>
          <Button variant="outline" onClick={() => send('REFUSED')} disabled={busy || code.length !== 6}>Refuser</Button>
        </div>
        <p className="text-xs text-muted">Décision définitive, datée et inscrite dans les journaux ; l’avoir éventuel est émis dans la même opération. Aucun remboursement automatique.</p>
      </div>
    </DialogContent>
  );
}

function DetailDialog({ id }: { id: string }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { pf<Detail>('GET', `/billing/documents/${id}`).then(setD).catch(setError); }, [id]);
  if (error) return <DialogContent title="Document"><ErrorNote error={error} /></DialogContent>;
  if (!d) return <DialogContent title="Document"><p className="text-sm text-muted">Chargement…</p></DialogContent>;
  const data = d.data ?? {};
  const info = (k: string) => (typeof data[k] === 'string' ? (data[k] as string) : null);
  return (
    <DialogContent title={`${d.label} ${d.reference}`} description={`${d.group.name} · émis le ${frDate(d.issueDate)} par ${d.createdByName}`}>
      <div className="grid gap-3 text-sm">
        <p className="rounded-lg bg-warn-soft p-2 font-bold">{info('mention')}</p>
        {d.related && <p>Document lié : {d.related.reference}</p>}
        {d.relatedBy.length > 0 && <p>Repris par : {d.relatedBy.map((r) => `${r.reference} (${money(r.total, d.currency)})`).join(', ')}</p>}
        <ul className="grid gap-2" aria-label="Lignes du document">
          {d.lines.map((l) => (
            <li key={l.id} className="grid gap-0.5 rounded-lg bg-sunk p-2">
              <span className="flex flex-wrap justify-between gap-2"><b className="min-w-0">{l.label}</b><b>{money(l.amount, d.currency)}</b></span>
              {l.quantity !== null && <span className="text-xs text-muted">{l.quantity} × {money(l.unitPrice ?? 0, d.currency)}{l.priceBasis === 'QUOTE' ? ' (prix saisi sur le devis)' : ''}</span>}
              {l.pupils !== null && (
                <span className="text-xs text-muted">
                  {pupils(l.pupils)}{l.pupilsChange ? ` (${l.pupilsChange > 0 ? '+' : ''}${l.pupilsChange})` : ''} × {money(l.pricePerPupil ?? 0, d.currency)}, minimum {money(l.minimum ?? 0, d.currency)}{l.minimumApplied ? ' (appliqué)' : ''}
                  {l.shareMonths ? `, part ${l.shareMonths}/${l.shareOf}` : ''} : {money(l.yearAmount ?? 0, d.currency)} pour l’année, {money(l.alreadyBilled ?? 0, d.currency)} déjà demandés
                </span>
              )}
            </li>
          ))}
        </ul>
        <p className="flex justify-between gap-2 text-base"><b>Total</b><b>{d.kind === 'CREDIT_NOTE' ? '− ' : ''}{money(d.total, d.currency)}</b></p>
        {d.dueDate && <p>Échéance : {frDate(d.dueDate)}</p>}
        {info('validity') && <p className="text-warn">{info('validity')}</p>}
        {info('due') && <p className="text-warn">{info('due')}</p>}
      </div>
    </DialogContent>
  );
}

/** Devis ou proforma de prestations pour un établissement, aux prix du catalogue du jour ; une proforma peut reprendre un devis. */
function ServiceDocumentDialog({ docs, done }: { docs: Doc[]; done: () => void }) {
  const [establishments, setEstablishments] = useState<Establishment[] | null>(null);
  const [tenantId, setTenantId] = useState('');
  const [kind, setKind] = useState<'SERVICE_QUOTE' | 'SERVICE_PROFORMA'>('SERVICE_PROFORMA');
  const [quoteId, setQuoteId] = useState('');
  const [prices, setPrices] = useState<Price[] | null>(null);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [unit, setUnit] = useState<Record<string, string>>({});
  const [code, setCode] = useState('');
  const [loadError, setLoadError] = useState<unknown>(null);
  const { busy, error, submit } = useSubmit(done, kind === 'SERVICE_QUOTE' ? 'Devis provisoire émis' : 'Proforma émise');
  useEffect(() => {
    pf<{ establishments: Establishment[] }>('GET', '/billing/services').then((c) => { setEstablishments(c.establishments); setTenantId(c.establishments[0]?.id ?? ''); }).catch(setLoadError);
  }, []);
  useEffect(() => {
    if (!tenantId) return;
    // Les prix d'un établissement choisi avant ne remplacent jamais ceux de l'établissement choisi ensuite.
    let current = true;
    setPrices(null);
    setQty({});
    setUnit({});
    setQuoteId('');
    pf<{ items: Price[] }>('GET', `/billing/services/prices?tenantId=${tenantId}`)
      .then((r) => { if (current) setPrices(r.items); })
      .catch((e) => { if (current) setLoadError(e); });
    return () => { current = false; };
  }, [tenantId]);
  const currency = establishments?.find((t) => t.id === tenantId)?.currency ?? 'XOF';
  const quotes = useMemo(() => docs.filter((d) => d.kind === 'SERVICE_QUOTE' && d.tenantIds.includes(tenantId) && !docs.some((p) => p.relatedDocumentId === d.id)), [docs, tenantId]);
  const offered = (prices ?? []).filter((p) => !NOT_OFFERED.includes(p.basis) && (kind === 'SERVICE_QUOTE' || p.basis !== 'QUOTE'));
  const items = offered.flatMap((p) => {
    const n = Number(qty[p.id] ?? '0');
    if (!Number.isInteger(n) || n < 1) return [];
    const price = p.basis === 'QUOTE' ? Number((unit[p.id] ?? '').replace(/[\s  ]/g, '')) : p.amount ?? 0;
    return [{ p, n, price }];
  });
  const total = items.reduce((s, i) => s + i.n * (Number.isFinite(i.price) ? i.price : 0), 0);
  const fromQuote = kind === 'SERVICE_PROFORMA' && !!quoteId;
  const send = () => submit(() => pf('POST', '/billing/service-documents', fromQuote
    ? { kind, tenantId, quoteId, code }
    : { kind, tenantId, code, items: items.map((i) => ({ serviceId: i.p.id, quantity: i.n, ...(i.p.basis === 'QUOTE' ? { unitPrice: i.price } : {}) })) }));
  if (loadError) return <DialogContent title="Devis ou proforma de prestations"><ErrorNote error={loadError} /></DialogContent>;
  return (
    <DialogContent title="Devis ou proforma de prestations" description="Prix du catalogue de ce jour pour l’établissement ; une prestation sur devis se chiffre dans un devis, que sa proforma reprend tel quel.">
      <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <Field label="Établissement">
          <Select value={tenantId} onChange={(e) => setTenantId(e.target.value)}>{(establishments ?? []).map((t) => <option key={t.id} value={t.id}>{t.name} ({t.group})</option>)}</Select>
        </Field>
        <Chips label="Document" value={kind} onChange={(k) => { setKind(k); setQuoteId(''); }} options={[{ value: 'SERVICE_PROFORMA', label: 'Proforma' }, { value: 'SERVICE_QUOTE', label: 'Devis' }]} />
        {kind === 'SERVICE_PROFORMA' && quotes.length > 0 && (
          <Field label="Reprendre un devis" hint="Facultatif : la proforma reprend alors le devis tel quel.">
            <Select value={quoteId} onChange={(e) => setQuoteId(e.target.value)}>
              <option value="">Non : prestations du catalogue</option>
              {quotes.map((q) => <option key={q.id} value={q.id}>{q.reference} du {frDate(q.issueDate)} : {money(q.total, q.currency)}</option>)}
            </Select>
          </Field>
        )}
        {!fromQuote && (
          prices === null ? <p className="text-sm text-muted">Chargement des prix…</p> : (
            <ul className="grid gap-2" aria-label="Prestations du catalogue">
              {offered.map((p) => (
                <li key={p.id} className="grid gap-2 rounded-lg bg-sunk p-2 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                  <span className="min-w-0"><b>{p.name}</b><span className="block text-xs text-muted">{p.basis === 'QUOTE' ? 'Sur devis : prix à saisir' : `${money(p.amount ?? 0, p.currency)} · ${p.label}`}</span></span>
                  <span className="flex gap-2">
                    <Field label="Quantité" className="w-24"><Input inputMode="numeric" value={qty[p.id] ?? ''} placeholder="0" aria-label={`Quantité : ${p.name}`} onChange={(e) => setQty({ ...qty, [p.id]: e.target.value.replace(/\D/g, '') })} /></Field>
                    {p.basis === 'QUOTE' && <Field label="Prix unitaire" className="w-32"><Input inputMode="numeric" value={unit[p.id] ?? ''} aria-label={`Prix unitaire : ${p.name}`} onChange={(e) => setUnit({ ...unit, [p.id]: e.target.value.replace(/[^\d\s]/g, '') })} /></Field>}
                  </span>
                </li>
              ))}
            </ul>
          )
        )}
        {!fromQuote && <p className="flex justify-between gap-2 font-bold"><span>Total</span><span>{money(total, currency)}</span></p>}
        <p className="text-xs text-muted">{kind === 'SERVICE_QUOTE' ? 'Durée de validité d’un devis : INFORMATION MANQUANTE, aucune date n’est inscrite.' : 'Échéance d’une proforma : INFORMATION MANQUANTE, aucune date n’est inscrite.'} Document provisoire, sans valeur fiscale.</p>
        <CodeField value={code} onChange={setCode} />
        <ErrorNote error={error} />
        <Button type="submit" loading={busy} disabled={code.length !== 6 || (!fromQuote && items.length === 0)}>{kind === 'SERVICE_QUOTE' ? 'Émettre le devis' : 'Émettre la proforma'}</Button>
      </form>
    </DialogContent>
  );
}
