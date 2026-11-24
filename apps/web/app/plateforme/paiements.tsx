'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Ban, HandCoins, Lock, LockOpen, Plus, Printer, Receipt, Shuffle } from 'lucide-react';
import { Badge, Button, Card, Dialog, DialogContent, Empty, ErrorNote, Field, Input, Select, Stat, Table, Textarea } from '@/components/ui';
import { pf } from '@/lib/platform';
import { CodeField, frDate, money, useSubmit } from './facturation-outils';

/**
 * Paiements, avoirs et crédits, rapports financiers (lot G5d-2), plan validé par Dankou le 20 novembre 2026 :
 * - Paiements : moyens de paiement en versions datées (verrou 2), établissements et ce qui leur reste à payer, saisie
 *   d'un paiement reçu avec son justificatif (D-G5-17 A), reçu provisoire, annulation d'une saisie par contre-écriture ;
 * - Avoirs et crédits : avoirs provisoires et leur imputation (choix 1 A), crédits des établissements, demandes de
 *   remboursement à décider avec leur preuve, transferts de crédit dans un groupe avec leur autorisation (D-G5-15 A) ;
 * - Rapports financiers : facturé et encaissé jamais confondus, par monnaie, filtres de période, d'établissement, de
 *   groupe et d'état (§14).
 * Chaque écriture demande un code actuel de l'application d'authentification. Tant que le verrou du serveur est fermé
 * (par défaut, donc en production), l'API refuse chaque écriture : les écrans le disent, l'historique reste lisible.
 * Aucun prestataire n'est appelé : Cahiora enregistre à la main ce qu'il a reçu.
 * Ajustement G5d2-5 (20 novembre 2026) : la ressaisie d'un paiement annulé le désigne, une seule fois ; un justificatif
 * déjà joint ou un paiement semblable exige le motif de cet autre versement (réservé à Cahiora).
 */

type MoneyRow = { currency: string; amount: number };
type Means = { id: string; code: string; version: number; name: string; instructions: string; currency: string; active: boolean; effectiveFrom: string; reason: string; createdByName: string; createdAt: string };
type PayStatus = 'NOTHING_DUE' | 'PENDING' | 'PARTIAL' | 'PAID' | 'CANCELLED' | 'GROUP_PENDING';
type DocPayment = { status: PayStatus; label: string; overdue: boolean; due: number | null; paid: number | null; balance: number | null };
type PayDoc = { id: string; reference: string; issueDate: string; dueDate: string | null; total: number; credited: number } & DocPayment;
type Credit = { balance: number; reserved: number; available: number };
type Establishment = {
  tenantId: string; name: string; group: { id: string; name: string; size: number }; currency: string; today: string; alone: boolean; groupPending: string | null;
  subscription: { status: string; statusLabel: string } | null; documents: PayDoc[]; graceDocument: { id: string; reference: string; balance: number } | null;
  credit: Credit; means: { code: string; name: string }[];
};
type Payment = {
  id: string; receiptNumber: string; tenantId: string; tenantName: string; group: { id: string; name: string }; documentId: string; documentReference: string; currency: string;
  expectedAmount: number; amount: number; paidOn: string; meansName: string; transactionRef: string; creditAmount: number; note: string | null; recordedByName: string; recordedAt: string;
  status: 'VALIDATED' | 'CANCELLED'; statusLabel: string; cancelledAt: string | null; cancelledByName: string | null; cancelReason: string | null; allocations: { reference: string; amount: number }[];
  /** G5d2-5 : reçu du paiement annulé que celui-ci ressaisit, reçu de la ressaisie d'un paiement annulé, motif d'un autre versement. */
  replacesPaymentId: string | null; replacesReceipt: string | null; reenteredBy: string | null; similarReason: string | null;
};
/** Paiement annulé pas encore ressaisi, à désigner lors de sa ressaisie (G5d2-5). */
type Reentry = { id: string; receiptNumber: string; tenantId: string; tenantName: string; amount: number; currency: string; paidOn: string; transactionRef: string; cancelledAt: string };
type Overview = {
  unlocked: boolean; lockMessage: string | null; mention: string; today: string; currencies: string[]; means: { current: Means[]; versions: Means[] }; establishments: Establishment[]; payments: Payment[];
  toReenter: Reentry[]; duplicateRule: string;
};
type PaymentDetail = Payment & {
  proofUrl: string; proofMime: string;
  movements: { reference: string; amount: number; reversal: boolean; createdAt: string }[];
  creditEntries: { kind: string; label: string; amount: number; createdAt: string }[];
};
type Entry = { id: string; kind: string; label: string; amount: number; createdAt: string; createdByName: string; receiptNumber: string | null; documentReference: string | null };
type CreditEstablishment = { tenantId: string; name: string; currency: string; group: { id: string; name: string; size: number }; credit: Credit; entries: Entry[] };
type CreditNote = {
  id: string; reference: string; issueDate: string; currency: string; total: number; relatedReference: string | null; tenantName: string | null; state: 'IMPUTED' | 'GROUP_PENDING';
  stateLabel: string; allocations: { reference: string; amount: number }[]; credit: number;
};
type Refund = {
  id: string; tenantId: string; tenantName: string; currency: string; amount: number; status: 'PENDING' | 'REFUNDED' | 'REFUSED'; statusLabel: string; message: string | null;
  requestedByName: string; requestedAt: string; decidedByName: string | null; decidedAt: string | null; decisionNote: string | null; refundedOn: string | null;
  refundMeans: string | null; refundRef: string | null; proofUrl: string | null;
};
type Transfer = { id: string; groupName: string; fromName: string; toName: string; currency: string; amount: number; authorizedBy: string; reason: string; createdByName: string; createdAt: string; proofUrl: string | null };
type Credits = { unlocked: boolean; lockMessage: string | null; today: string; establishments: CreditEstablishment[]; creditNotes: CreditNote[]; refunds: Refund[]; transfers: Transfer[] };
type ReportDoc = { id: string; reference: string; issueDate: string; dueDate: string | null; currency: string; total: number; group: { id: string; name: string }; establishments: { id: string; name: string }[]; payment: DocPayment };
type Totals = { billed: MoneyRow[]; credited: MoneyRow[]; collected: MoneyRow[]; refunded: MoneyRow[]; unpaid: MoneyRow[]; groupPending: MoneyRow[]; credits: MoneyRow[] };
type Report = {
  filters: { from: string | null; to: string | null; tenantId: string | null; groupId: string | null; status: string | null };
  totals: Totals; documents: ReportDoc[]; payments: Payment[]; mention: string;
  groups: { id: string; name: string }[]; tenants: { id: string; name: string; groupId: string }[];
};

const PAY_TONE: Record<PayStatus, 'info' | 'good' | 'warn' | 'bad' | 'accent'> = {
  NOTHING_DUE: 'info', PENDING: 'warn', PARTIAL: 'accent', PAID: 'good', CANCELLED: 'info', GROUP_PENDING: 'info',
};
const dateTime = (d: string | null) => (d ? new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
/** Montants d'une liste par monnaie, jamais additionnés d'une monnaie à l'autre. */
export const moneyRows = (rows: MoneyRow[]) => (rows.length ? rows.map((r) => money(r.amount, r.currency)).join(' · ') : '0');

/** Verrou du serveur : fermé, aucune écriture (l'API refuse avant de lire la demande) ; ouvert, saisies à la main par Cahiora. */
function LockNote({ unlocked, message }: { unlocked: boolean; message: string | null }) {
  return unlocked ? (
    <p className="flex items-start gap-2 rounded-lg bg-sunk p-3 text-sm" data-testid="verrou-paiements">
      <LockOpen className="mt-0.5 size-4 flex-none" aria-hidden />
      <span><b>Verrou du serveur ouvert.</b> Cahiora enregistre à la main les paiements qu’il a reçus : aucun prestataire n’est appelé, aucun paiement en ligne. Chaque reçu reste provisoire, sans valeur fiscale.</span>
    </p>
  ) : (
    <p className="flex items-start gap-2 rounded-lg bg-warn-soft p-3 text-sm font-bold text-warn" data-testid="verrou-paiements">
      <Lock className="mt-0.5 size-4 flex-none" aria-hidden />
      <span>{message} L’historique reste lisible ; aucun moyen de paiement n’est montré aux établissements.</span>
    </p>
  );
}

function PayBadge({ p }: { p: DocPayment }) {
  return <Badge tone={p.overdue ? 'bad' : PAY_TONE[p.status]}>{p.label}</Badge>;
}

// ---------------------------------------------------------------- Paiements

export function Paiements() {
  const [d, setD] = useState<Overview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [dialog, setDialog] = useState<{ kind: 'means'; base: Means | null } | { kind: 'record'; e: Establishment } | { kind: 'payment'; id: string } | null>(null);
  const load = useCallback(() => {
    pf<Overview>('GET', '/billing/payments').then(setD).catch(setError);
  }, []);
  useEffect(load, [load]);
  if (error) return <ErrorNote error={error} />;
  if (!d) return null;
  const done = () => { setDialog(null); load(); };
  const validated = d.payments.filter((p) => p.status === 'VALIDATED');
  const owing = d.establishments.filter((e) => e.documents.some((x) => (x.balance ?? 0) > 0));
  return (
    <div className="grid gap-4">
      <LockNote unlocked={d.unlocked} message={d.lockMessage} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Paiements validés" value={validated.length} detail="Enregistrés par Cahiora" />
        <Stat label="Saisies annulées" value={d.payments.length - validated.length} detail="Par contre-écriture" />
        <Stat label="Établissements avec un reste à payer" value={owing.length} tone={owing.length ? 'warn' : undefined} />
        <Stat label="Moyens de paiement activés" value={d.unlocked ? d.means.current.filter((m) => m.active).length : 0} detail={d.unlocked ? undefined : 'Verrou du serveur fermé'} />
      </div>

      <Card className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-bold">Moyens de paiement</h3>
          <Button size="sm" onClick={() => setDialog({ kind: 'means', base: null })} disabled={!d.unlocked}><Plus className="size-4" /> Nouveau moyen</Button>
        </div>
        <p className="text-sm text-muted">Nom, coordonnées et instructions de chaque moyen viennent de vous : rien n’est prérempli. Un moyen activé n’est montré qu’aux établissements de sa monnaie, à partir de sa date d’effet.</p>
        {d.means.current.length === 0 ? <p className="text-sm text-muted">Aucun moyen de paiement enregistré.</p> : (
          <ul className="grid gap-2" aria-label="Moyens de paiement">
            {d.means.current.map((m) => (
              <li key={m.code} className="grid gap-1 rounded-lg border border-line p-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="min-w-0"><b>{m.name}</b><span className="block text-xs text-muted">{m.code} · {m.currency} · version {m.version} depuis le {frDate(m.effectiveFrom)}</span></span>
                  <Badge tone={m.active && d.unlocked ? 'good' : 'info'}>{m.active ? (d.unlocked ? 'Activé' : 'Activé, verrou fermé') : 'Désactivé'}</Badge>
                </div>
                <p className="whitespace-pre-wrap rounded bg-sunk p-2">{m.instructions}</p>
                <div><Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'means', base: m })} disabled={!d.unlocked}>Nouvelle version</Button></div>
              </li>
            ))}
          </ul>
        )}
        {d.means.versions.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer font-bold">Historique des versions ({d.means.versions.length})</summary>
            <ul className="mt-2 grid gap-1">
              {d.means.versions.map((m) => (
                <li key={m.id} className="rounded bg-sunk p-2">
                  <b>{m.name}</b> ({m.code}, version {m.version}) : {m.active ? 'activé' : 'désactivé'} à partir du {frDate(m.effectiveFrom)}, {m.currency}
                  <span className="block text-xs text-muted">{dateTime(m.createdAt)} par {m.createdByName} · {m.reason}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>

      <Card className="grid gap-3">
        <h3 className="font-bold">Établissements et documents à payer</h3>
        {d.establishments.length === 0 ? <Empty title="Aucun document de l’abonnement">Les proformas de l’abonnement arrivent avec les documents provisoires (rubrique Factures et documents).</Empty> : (
          <ul className="grid gap-2" aria-label="Établissements et documents à payer">
            {d.establishments.map((e) => {
              const open = e.documents.filter((x) => (x.balance ?? 0) > 0);
              return (
                <li key={e.tenantId} className="grid gap-2 rounded-lg border border-line p-3 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span className="min-w-0"><b>{e.name}</b><span className="block text-xs text-muted">{e.group.name}{e.group.size > 1 ? ` · groupe de ${e.group.size} établissements` : ''} · {e.currency}</span></span>
                    {e.subscription && <Badge tone={e.subscription.status === 'ACTIVE' ? 'good' : e.subscription.status === 'LIMITED' ? 'bad' : 'warn'}>{e.subscription.statusLabel}</Badge>}
                  </div>
                  {e.groupPending ? <p className="text-muted">{e.groupPending}.</p> : (
                    <>
                      <Table>
                        <thead><tr><th>Document</th><th>Échéance</th><th>Montant</th><th>Avoirs</th><th>Payé</th><th>Reste</th><th>État</th></tr></thead>
                        <tbody>
                          {e.documents.map((x) => (
                            <tr key={x.id}>
                              <td><span className="font-mono text-xs">{x.reference}</span><span className="block text-xs text-muted">du {frDate(x.issueDate)}</span></td>
                              <td>{x.dueDate ? frDate(x.dueDate) : 'À fixer'}</td>
                              <td>{money(x.total, e.currency)}</td>
                              <td>{x.credited ? `− ${money(x.credited, e.currency)}` : '—'}</td>
                              <td>{money(x.paid ?? 0, e.currency)}</td>
                              <td><b>{money(x.balance ?? 0, e.currency)}</b></td>
                              <td><PayBadge p={x} /></td>
                            </tr>
                          ))}
                        </tbody>
                      </Table>
                      <p className="text-muted">
                        {e.graceDocument ? `Document de la fin de la gratuité : ${e.graceDocument.reference}, ${e.graceDocument.balance > 0 ? `reste ${money(e.graceDocument.balance, e.currency)} ; l’accès complet revient quand il est entièrement payé.` : 'entièrement payé.'}` : 'Aucun document de la fin de la gratuité.'}
                        {' '}Crédit disponible : {money(e.credit.available, e.currency)}{e.credit.reserved ? ` (${money(e.credit.reserved, e.currency)} réservés par une demande de remboursement)` : ''}.
                      </p>
                      <p className="text-muted">{e.means.length ? `Moyens activés pour cet établissement : ${e.means.map((m) => m.name).join(', ')}.` : 'Aucun moyen de paiement activé pour cet établissement.'}</p>
                      <div>
                        <Button size="sm" onClick={() => setDialog({ kind: 'record', e })} disabled={!d.unlocked || !e.means.length || !e.documents.length} aria-label={`Enregistrer un paiement de ${e.name}`}>
                          <HandCoins className="size-4" /> Enregistrer un paiement
                        </Button>
                        {d.unlocked && !open.length && e.documents.length > 0 && <span className="ml-2 text-xs text-muted">Rien ne reste à payer : un paiement deviendrait un crédit.</span>}
                      </div>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card className="grid gap-3">
        <div>
          <h3 className="font-bold">Paiements enregistrés</h3>
          <p className="text-sm text-muted">{d.duplicateRule}</p>
        </div>
        {d.toReenter.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer font-bold">Saisies annulées pas encore ressaisies ({d.toReenter.length})</summary>
            <ul className="mt-2 grid gap-1" aria-label="Saisies annulées pas encore ressaisies">
              {d.toReenter.map((r) => (
                <li key={r.id} className="rounded bg-sunk p-2">
                  <b className="font-mono text-xs">{r.receiptNumber}</b> · {r.tenantName} · {money(r.amount, r.currency)} du {frDate(r.paidOn)}, référence <span className="font-mono text-xs">{r.transactionRef}</span>
                  <span className="block text-xs text-muted">Annulée le {dateTime(r.cancelledAt)} : à désigner si ce paiement est ressaisi.</span>
                </li>
              ))}
            </ul>
          </details>
        )}
        {d.payments.length === 0 ? <p className="text-sm text-muted">Aucun paiement enregistré.</p> : <PaymentsTable payments={d.payments} open={(id) => setDialog({ kind: 'payment', id })} />}
      </Card>

      <Dialog open={!!dialog} onOpenChange={(o) => !o && setDialog(null)}>
        {dialog?.kind === 'means' && <MeansDialog base={dialog.base} currencies={d.currencies} today={d.today} done={done} />}
        {dialog?.kind === 'record' && <RecordDialog e={dialog.e} toReenter={d.toReenter} done={done} />}
        {dialog?.kind === 'payment' && <PaymentDialog id={dialog.id} unlocked={d.unlocked} done={done} />}
      </Dialog>
    </div>
  );
}

function PaymentsTable({ payments, open }: { payments: Payment[]; open?: (id: string) => void }) {
  return (
    <Table aria-label="Paiements enregistrés">
      <thead><tr><th>Reçu</th><th>Établissement</th><th>Document</th><th>Montant reçu</th><th>Date</th><th>Moyen et référence</th><th>État</th><th /></tr></thead>
      <tbody>
        {payments.map((p) => (
          <tr key={p.id}>
            <td>
              <span className={`font-mono text-xs font-bold ${p.cancelledAt ? 'line-through' : ''}`}>{p.receiptNumber}</span>
              {p.replacesReceipt && <span className="block text-xs text-muted">ressaisie de {p.replacesReceipt}</span>}
              {p.reenteredBy && <span className="block text-xs text-muted">ressaisi par {p.reenteredBy}</span>}
            </td>
            <td>{p.tenantName}</td>
            <td className="font-mono text-xs">{p.documentReference}</td>
            <td><b>{money(p.amount, p.currency)}</b>{p.creditAmount > 0 && <span className="block text-xs text-muted">dont {money(p.creditAmount, p.currency)} en crédit</span>}</td>
            <td>{frDate(p.paidOn)}</td>
            <td>{p.meansName}<span className="block font-mono text-xs text-muted">{p.transactionRef}</span></td>
            <td><Badge tone={p.status === 'VALIDATED' ? 'good' : 'bad'}>{p.statusLabel}</Badge></td>
            <td>{open && <Button size="sm" variant="outline" onClick={() => open(p.id)} aria-label={`Détail du paiement ${p.receiptNumber}`}>Détail</Button>}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function MeansDialog({ base, currencies, today: day, done }: { base: Means | null; currencies: string[]; today: string; done: () => void }) {
  const [f, setF] = useState({
    name: base?.name ?? '', instructions: base?.instructions ?? '', currency: base?.currency ?? currencies[0] ?? 'XOF', active: base?.active ?? false, effectiveFrom: day, reason: '', code: '',
  });
  const { busy, error, submit } = useSubmit(done, base ? 'Nouvelle version du moyen de paiement enregistrée' : 'Moyen de paiement enregistré');
  return (
    <DialogContent title={base ? `Nouvelle version : ${base.name}` : 'Nouveau moyen de paiement'} description="Une version ne se modifie plus : la suivante la remplace à sa date d’effet. Une date passée ne change jamais ce qui a déjà été vu.">
      <form className="grid gap-3" onSubmit={(ev) => { ev.preventDefault(); submit(() => pf('POST', '/billing/payment-means', { ...f, ...(base ? { meansCode: base.code } : {}) })); }}>
        <Field label="Nom du moyen" hint="Tel que les établissements le liront (2 à 80 caractères).">
          <Input value={f.name} minLength={2} maxLength={80} onChange={(x) => setF({ ...f, name: x.target.value })} required />
        </Field>
        <Field label="Coordonnées et instructions" hint="Numéro, titulaire, banque, référence à indiquer… données par vous seulement (5 à 1 000 caractères).">
          <Textarea rows={4} value={f.instructions} minLength={5} maxLength={1000} onChange={(x) => setF({ ...f, instructions: x.target.value })} required />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Monnaie">
            <Select value={f.currency} onChange={(x) => setF({ ...f, currency: x.target.value })} disabled={!!base}>
              {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </Field>
          <Field label="Date d’effet" hint="Aujourd’hui ou plus tard (un an au plus).">
            <Input type="date" value={f.effectiveFrom} min={day} onChange={(x) => setF({ ...f, effectiveFrom: x.target.value })} required />
          </Field>
        </div>
        <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-line p-3 text-sm">
          <input type="checkbox" className="size-5 accent-[var(--brand)]" checked={f.active} onChange={(x) => setF({ ...f, active: x.target.checked })} />
          <span>Activé : montré aux établissements de cette monnaie à partir de la date d’effet</span>
        </label>
        <Field label="Motif" hint="5 à 300 caractères, inscrit au journal.">
          <Input value={f.reason} minLength={5} maxLength={300} onChange={(x) => setF({ ...f, reason: x.target.value })} required />
        </Field>
        <CodeField value={f.code} onChange={(code) => setF({ ...f, code })} />
        <ErrorNote error={error} />
        <Button type="submit" loading={busy}>Enregistrer la version</Button>
      </form>
    </DialogContent>
  );
}

function RecordDialog({ e, toReenter, done }: { e: Establishment; toReenter: Reentry[]; done: () => void }) {
  const first = e.documents.find((x) => x.id === e.graceDocument?.id && (x.balance ?? 0) > 0) ?? e.documents.find((x) => (x.balance ?? 0) > 0) ?? e.documents[0];
  const [f, setF] = useState({
    documentId: first?.id ?? '', amount: '', paidOn: e.today, meansCode: e.means[0]?.code ?? '', transactionRef: '', replacesPaymentId: '', similarReason: '', note: '', code: '',
  });
  // Les saisies annulées de cet établissement d'abord : une ressaisie pour un autre établissement reste possible (erreur d'établissement).
  const reentries = [...toReenter.filter((r) => r.tenantId === e.tenantId), ...toReenter.filter((r) => r.tenantId !== e.tenantId)];
  const [file, setFile] = useState<File | null>(null);
  const { busy, error, submit } = useSubmit(done, 'Paiement enregistré : reçu provisoire émis');
  const doc = e.documents.find((x) => x.id === f.documentId);
  const amount = Number(f.amount) || 0;
  const surplus = doc ? Math.max(0, amount - (doc.balance ?? 0)) : 0;
  const send = () => {
    const form = new FormData();
    form.append('tenantId', e.tenantId);
    for (const [k, v] of Object.entries(f)) if (v !== '') form.append(k, v);
    if (file) form.append('file', file);
    return pf('POST', '/billing/payments', form);
  };
  return (
    <DialogContent title={`Enregistrer un paiement : ${e.name}`} description="Ce que Cahiora a réellement reçu, avec sa preuve. Le paiement va au document concerné, le surplus aux autres documents du plus ancien au plus récent, puis devient un crédit (choix 1 A).">
      <form className="grid gap-3" onSubmit={(ev) => { ev.preventDefault(); submit(send); }}>
        <Field label="Document concerné">
          <Select value={f.documentId} onChange={(x) => setF({ ...f, documentId: x.target.value })} required>
            {e.documents.map((x) => <option key={x.id} value={x.id}>{x.reference} · reste {money(x.balance ?? 0, e.currency)} · {x.label}</option>)}
          </Select>
        </Field>
        <p className="rounded-lg bg-sunk p-2 text-sm">Montant attendu : <b>{money(doc?.balance ?? 0, e.currency)}</b>{doc?.dueDate ? `, échéance le ${frDate(doc.dueDate)}` : ''}.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Montant reçu" hint={`En ${e.currency}, nombre entier.`}>
            <Input inputMode="numeric" value={f.amount} onChange={(x) => setF({ ...f, amount: x.target.value.replace(/\D/g, '') })} required />
          </Field>
          <Field label="Date du paiement" hint="Ni future, ni avant le document.">
            <Input type="date" value={f.paidOn} max={e.today} min={doc?.issueDate} onChange={(x) => setF({ ...f, paidOn: x.target.value })} required />
          </Field>
        </div>
        {amount > 0 && doc && (
          <p className="text-sm text-muted">
            {amount < (doc.balance ?? 0) ? `Paiement partiel : il restera ${money((doc.balance ?? 0) - amount, e.currency)} sur ce document ; l’accès ne change pas (D-G5-43 A).` : surplus > 0 ? `Surplus de ${money(surplus, e.currency)} : aux autres documents à payer, puis en crédit de l’établissement.` : 'Le document sera entièrement payé.'}
          </p>
        )}
        <Field label="Moyen de paiement">
          <Select value={f.meansCode} onChange={(x) => setF({ ...f, meansCode: x.target.value })} required>
            {e.means.map((m) => <option key={m.code} value={m.code}>{m.name}</option>)}
          </Select>
        </Field>
        <Field label="Référence de la transaction" hint="Une même référence ne s’enregistre qu’une fois (3 à 100 caractères) ; celle d’une saisie annulée revient seulement dans sa ressaisie.">
          <Input value={f.transactionRef} minLength={3} maxLength={100} onChange={(x) => setF({ ...f, transactionRef: x.target.value })} required />
        </Field>
        {reentries.length > 0 && (
          <Field label="Ressaisie d’un paiement annulé" hint="Seulement si ce paiement remplace une saisie annulée : désignez-la (une ressaisie ne se fait qu’une fois).">
            <Select value={f.replacesPaymentId} onChange={(x) => setF({ ...f, replacesPaymentId: x.target.value })}>
              <option value="">Non : nouveau paiement</option>
              {reentries.map((r) => (
                <option key={r.id} value={r.id}>{r.receiptNumber} · {r.tenantName} · {money(r.amount, r.currency)} du {frDate(r.paidOn)} · réf. {r.transactionRef}</option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Justificatif du paiement" hint="Photo ou PDF de la preuve reçue (obligatoire).">
          <Input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(x) => setFile(x.target.files?.[0] ?? null)} required />
        </Field>
        <Field label="Motif d’un autre versement (si Cahiora le demande)" hint="Seulement quand un paiement semblable ou un même justificatif existe déjà : pourquoi ce versement est distinct (5 à 300 caractères). Jamais montré à l’établissement.">
          <Input value={f.similarReason} maxLength={300} onChange={(x) => setF({ ...f, similarReason: x.target.value })} />
        </Field>
        <Field label="Commentaire interne (facultatif)" hint="Jamais montré à l’établissement.">
          <Input value={f.note} maxLength={500} onChange={(x) => setF({ ...f, note: x.target.value })} />
        </Field>
        <CodeField value={f.code} onChange={(code) => setF({ ...f, code })} />
        <ErrorNote error={error} />
        <Button type="submit" loading={busy}>Enregistrer le paiement</Button>
      </form>
    </DialogContent>
  );
}

function PaymentDialog({ id, unlocked, done }: { id: string; unlocked: boolean; done: () => void }) {
  const [p, setP] = useState<PaymentDetail | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [f, setF] = useState({ reason: '', code: '' });
  const { busy, error, submit } = useSubmit(done, 'Saisie annulée par une contre-écriture');
  useEffect(() => {
    pf<PaymentDetail>('GET', `/billing/payments/${id}`).then(setP).catch(setLoadError);
  }, [id]);
  return (
    <DialogContent title={p ? `Paiement ${p.receiptNumber}` : 'Paiement'} description="Un paiement enregistré ne se modifie jamais : une erreur se corrige par une contre-écriture motivée.">
      <ErrorNote error={loadError} />
      {p && (
        <div className="grid gap-3 text-sm">
          <dl className="grid grid-cols-[minmax(0,140px)_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted">Établissement</dt><dd>{p.tenantName}</dd>
            <dt className="text-muted">Document</dt><dd className="font-mono text-xs">{p.documentReference}</dd>
            <dt className="text-muted">Attendu / reçu</dt><dd>{money(p.expectedAmount, p.currency)} / <b>{money(p.amount, p.currency)}</b></dd>
            <dt className="text-muted">Date, moyen</dt><dd>{frDate(p.paidOn)} · {p.meansName}</dd>
            <dt className="text-muted">Référence</dt><dd className="font-mono text-xs">{p.transactionRef}</dd>
            <dt className="text-muted">Enregistré</dt><dd>{dateTime(p.recordedAt)} par {p.recordedByName}</dd>
            {p.replacesReceipt && <><dt className="text-muted">Ressaisie de</dt><dd className="font-mono text-xs">{p.replacesReceipt} (saisie annulée)</dd></>}
            {p.reenteredBy && <><dt className="text-muted">Ressaisi par</dt><dd className="font-mono text-xs">{p.reenteredBy}</dd></>}
            {p.similarReason && <><dt className="text-muted">Motif d’un autre versement</dt><dd>{p.similarReason}</dd></>}
            {p.note && <><dt className="text-muted">Commentaire interne</dt><dd>{p.note}</dd></>}
          </dl>
          <p><a href={p.proofUrl} target="_blank" rel="noreferrer" className="font-bold text-brand underline">Ouvrir le justificatif</a> <span className="text-xs text-muted">(lien valable quinze minutes)</span></p>
          <div>
            <b>Imputations</b>
            <ul className="mt-1 grid gap-1">
              {p.movements.map((m, i) => <li key={i} className={m.reversal ? 'text-bad' : ''}>{m.reversal ? 'Reprise' : 'Imputé'} sur {m.reference} : {money(Math.abs(m.amount), p.currency)} <span className="text-xs text-muted">({dateTime(m.createdAt)})</span></li>)}
              {p.creditEntries.map((c, i) => <li key={`c${i}`}>{c.label} : {money(c.amount, p.currency)} <span className="text-xs text-muted">({dateTime(c.createdAt)})</span></li>)}
              {p.movements.length + p.creditEntries.length === 0 && <li className="text-muted">Aucune.</li>}
            </ul>
          </div>
          <Button asChild variant="outline" className="justify-self-start">
            <Link href={`/plateforme/recu/${p.id}`} target="_blank"><Printer className="size-4" /> Reçu provisoire à imprimer</Link>
          </Button>
          {p.cancelledAt ? (
            <p className="rounded-lg bg-bad-soft p-3 text-bad">Saisie annulée le {dateTime(p.cancelledAt)} par {p.cancelledByName} : {p.cancelReason}</p>
          ) : (
            <form className="grid gap-3 rounded-lg border border-line p-3" onSubmit={(ev) => { ev.preventDefault(); submit(() => pf('POST', `/billing/payments/${p.id}/cancel`, f)); }}>
              <b className="flex items-center gap-2"><Ban className="size-4" /> Annuler cette saisie</b>
              <p className="text-muted">Ses imputations et son crédit sont repris ; si le document de la fin de la gratuité n’est plus entièrement payé, l’abonnement revient en attente de paiement. Le motif reste à Cahiora.</p>
              <Field label="Motif de l’annulation" hint="5 à 300 caractères.">
                <Input value={f.reason} minLength={5} maxLength={300} onChange={(x) => setF({ ...f, reason: x.target.value })} required disabled={!unlocked} />
              </Field>
              <CodeField value={f.code} onChange={(code) => setF({ ...f, code })} />
              <ErrorNote error={error} />
              <Button type="submit" variant="outline" loading={busy} disabled={!unlocked}>Annuler la saisie</Button>
            </form>
          )}
        </div>
      )}
    </DialogContent>
  );
}

// ---------------------------------------------------------------- Avoirs et crédits

export function AvoirsCredits() {
  const [d, setD] = useState<Credits | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [dialog, setDialog] = useState<{ kind: 'refund'; r: Refund } | { kind: 'transfer'; from: CreditEstablishment } | null>(null);
  const load = useCallback(() => {
    pf<Credits>('GET', '/billing/credits').then(setD).catch(setError);
  }, []);
  useEffect(load, [load]);
  if (error) return <ErrorNote error={error} />;
  if (!d) return null;
  const done = () => { setDialog(null); load(); };
  const pending = d.refunds.filter((r) => r.status === 'PENDING');
  const decided = d.refunds.filter((r) => r.status !== 'PENDING');
  const withCredit = d.establishments.filter((e) => e.credit.balance > 0);
  return (
    <div className="grid gap-4">
      <LockNote unlocked={d.unlocked} message={d.lockMessage} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Demandes de remboursement" value={pending.length} detail="En attente de décision" tone={pending.length ? 'warn' : undefined} />
        <Stat label="Établissements avec un crédit" value={withCredit.length} />
        <Stat label="Avoirs émis" value={d.creditNotes.length} />
        <Stat label="Avoirs de documents de groupe" value={d.creditNotes.filter((c) => c.state === 'GROUP_PENDING').length} detail="Attendent D-G5-19 et D-G5-32" />
      </div>

      <Card className="grid gap-3">
        <h3 className="font-bold">Demandes de remboursement</h3>
        <p className="text-sm text-muted">Un crédit se rembourse seulement sur demande de la direction, validée ici avec sa preuve. Un crédit déjà déduit d’un document ne se rembourse pas. La direction peut demander un remboursement même pendant un accès limité, dès que les remboursements sont ouverts (verrou du serveur).</p>
        {pending.length === 0 ? <p className="text-sm text-muted">Aucune demande en attente.</p> : (
          <ul className="grid gap-2" aria-label="Demandes de remboursement en attente">
            {pending.map((r) => (
              <li key={r.id} className="grid gap-2 rounded-lg border border-line p-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="min-w-0"><b>{r.tenantName}</b><span className="block text-xs text-muted">Demande du {dateTime(r.requestedAt)} par {r.requestedByName}</span></span>
                  <b>{money(r.amount, r.currency)}</b>
                </div>
                {r.message && <p className="whitespace-pre-wrap rounded bg-sunk p-2">« {r.message} »</p>}
                <div><Button size="sm" onClick={() => setDialog({ kind: 'refund', r })} disabled={!d.unlocked} aria-label={`Décider la demande de ${r.tenantName}`}>Décider</Button></div>
              </li>
            ))}
          </ul>
        )}
        {decided.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer font-bold">Demandes décidées ({decided.length})</summary>
            <ul className="mt-2 grid gap-2" aria-label="Demandes de remboursement décidées">
              {decided.map((r) => (
                <li key={r.id} className="grid gap-1 rounded-lg bg-sunk p-3">
                  <span className="flex flex-wrap justify-between gap-2"><b>{r.tenantName} · {money(r.amount, r.currency)}</b><Badge tone={r.status === 'REFUNDED' ? 'good' : 'bad'}>{r.statusLabel}</Badge></span>
                  <span className="text-xs text-muted">Décidée le {dateTime(r.decidedAt)} par {r.decidedByName}</span>
                  {r.status === 'REFUNDED' ? <span>Remboursé le {frDate(r.refundedOn)} ({r.refundMeans}, référence {r.refundRef}){r.proofUrl && <> · <a href={r.proofUrl} target="_blank" rel="noreferrer" className="font-bold text-brand underline">preuve</a></>}</span> : <span>Motif : {r.decisionNote}</span>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>

      <Card className="grid gap-3">
        <h3 className="font-bold">Crédits des établissements</h3>
        {d.establishments.length === 0 ? <p className="text-sm text-muted">Aucun crédit pour le moment.</p> : (
          <ul className="grid gap-2" aria-label="Crédits des établissements">
            {d.establishments.map((e) => (
              <li key={e.tenantId} className="grid gap-2 rounded-lg border border-line p-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="min-w-0"><b>{e.name}</b><span className="block text-xs text-muted">{e.group.name}{e.group.size > 1 ? ` · groupe de ${e.group.size} établissements` : ''}</span></span>
                  <span className="text-right">Disponible : <b>{money(e.credit.available, e.currency)}</b>{e.credit.reserved > 0 && <span className="block text-xs text-muted">{money(e.credit.reserved, e.currency)} réservés</span>}</span>
                </div>
                {e.entries.length > 0 && (
                  <details>
                    <summary className="cursor-pointer font-bold">Écritures ({e.entries.length})</summary>
                    <ul className="mt-2 grid gap-1">
                      {e.entries.map((x) => (
                        <li key={x.id} className="flex flex-wrap justify-between gap-2 rounded bg-sunk p-2">
                          <span>{x.label}{x.receiptNumber ? ` · reçu ${x.receiptNumber}` : ''}{x.documentReference ? ` · ${x.documentReference}` : ''}<span className="block text-xs text-muted">{dateTime(x.createdAt)} · {x.createdByName}</span></span>
                          <b className={x.amount < 0 ? 'text-bad' : 'text-good'}>{x.amount < 0 ? '− ' : '+ '}{money(Math.abs(x.amount), e.currency)}</b>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {e.group.size > 1 && (
                  <div>
                    <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'transfer', from: e })} disabled={!d.unlocked || e.credit.available <= 0} aria-label={`Transférer le crédit de ${e.name}`}>
                      <Shuffle className="size-4" /> Transférer dans le groupe
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="grid gap-3">
        <h3 className="font-bold">Avoirs provisoires et leur imputation</h3>
        <p className="text-sm text-muted">Un avoir va d’abord au document qu’il corrige, puis aux autres documents à payer, puis au crédit de l’établissement (choix 1 A).</p>
        {d.creditNotes.length === 0 ? <p className="text-sm text-muted">Aucun avoir émis.</p> : (
          <Table aria-label="Avoirs provisoires">
            <thead><tr><th>Avoir</th><th>Établissement</th><th>Sur</th><th>Montant</th><th>Imputation</th></tr></thead>
            <tbody>
              {d.creditNotes.map((c) => (
                <tr key={c.id}>
                  <td><span className="font-mono text-xs">{c.reference}</span><span className="block text-xs text-muted">du {frDate(c.issueDate)}</span></td>
                  <td>{c.tenantName ?? '—'}</td>
                  <td className="font-mono text-xs">{c.relatedReference ?? '—'}</td>
                  <td>{money(c.total, c.currency)}</td>
                  <td>
                    {c.state === 'GROUP_PENDING' ? <span className="text-muted">{c.stateLabel}</span> : (
                      <span>{c.allocations.map((a) => `${a.reference} : ${money(a.amount, c.currency)}`).join(' · ')}{c.credit > 0 ? `${c.allocations.length ? ' · ' : ''}crédit : ${money(c.credit, c.currency)}` : ''}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card className="grid gap-3">
        <h3 className="font-bold">Transferts de crédit dans les groupes</h3>
        {d.transfers.length === 0 ? <p className="text-sm text-muted">Aucun transfert.</p> : (
          <ul className="grid gap-2" aria-label="Transferts de crédit">
            {d.transfers.map((t) => (
              <li key={t.id} className="grid gap-1 rounded-lg bg-sunk p-3 text-sm">
                <b>{t.fromName} → {t.toName} : {money(t.amount, t.currency)}</b>
                <span className="text-xs text-muted">{t.groupName} · {dateTime(t.createdAt)} par {t.createdByName}</span>
                <span>Autorisation : {t.authorizedBy}{t.proofUrl && <> · <a href={t.proofUrl} target="_blank" rel="noreferrer" className="font-bold text-brand underline">écrit joint</a></>}</span>
                <span className="text-muted">Motif interne : {t.reason}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Dialog open={!!dialog} onOpenChange={(o) => !o && setDialog(null)}>
        {dialog?.kind === 'refund' && <RefundDialog r={dialog.r} today={d.today} done={done} />}
        {dialog?.kind === 'transfer' && <TransferDialog from={dialog.from} all={d.establishments} done={done} />}
      </Dialog>
    </div>
  );
}

/** `today` : le jour de Cahiora (Porto-Novo), donné par le serveur, jamais celui de l'appareil. */
function RefundDialog({ r, today, done }: { r: Refund; today: string; done: () => void }) {
  const [f, setF] = useState({ decision: 'REFUNDED' as 'REFUNDED' | 'REFUSED', note: '', refundedOn: today, means: '', reference: '', code: '' });
  const [file, setFile] = useState<File | null>(null);
  const { busy, error, submit } = useSubmit(done, f.decision === 'REFUNDED' ? 'Remboursement enregistré' : 'Demande refusée');
  const refunded = f.decision === 'REFUNDED';
  const send = () => {
    const form = new FormData();
    form.append('decision', f.decision);
    form.append('code', f.code);
    if (f.note.trim()) form.append('note', f.note);
    if (refunded) {
      form.append('refundedOn', f.refundedOn);
      form.append('means', f.means);
      form.append('reference', f.reference);
      if (file) form.append('file', file);
    }
    return pf('POST', `/billing/refunds/${r.id}/decision`, form);
  };
  return (
    <DialogContent title={`Remboursement : ${r.tenantName}`} description={`Demande de ${money(r.amount, r.currency)} du ${dateTime(r.requestedAt)} par ${r.requestedByName}. Une décision ne se modifie plus.`}>
      <form className="grid gap-3" onSubmit={(ev) => { ev.preventDefault(); submit(send); }}>
        <Field label="Décision">
          <Select value={f.decision} onChange={(x) => setF({ ...f, decision: x.target.value as 'REFUNDED' | 'REFUSED' })}>
            <option value="REFUNDED">Remboursé : Cahiora a versé le montant</option>
            <option value="REFUSED">Refusé : le montant reste dans le crédit</option>
          </Select>
        </Field>
        {refunded ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Date du remboursement"><Input type="date" value={f.refundedOn} max={today} onChange={(x) => setF({ ...f, refundedOn: x.target.value })} required /></Field>
              <Field label="Moyen du remboursement"><Input value={f.means} minLength={2} maxLength={80} onChange={(x) => setF({ ...f, means: x.target.value })} required /></Field>
            </div>
            <Field label="Référence du remboursement" hint="3 à 100 caractères."><Input value={f.reference} minLength={3} maxLength={100} onChange={(x) => setF({ ...f, reference: x.target.value })} required /></Field>
            <Field label="Preuve du remboursement" hint="Photo ou PDF (obligatoire)."><Input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(x) => setFile(x.target.files?.[0] ?? null)} required /></Field>
            <Field label="Note (facultative)"><Input value={f.note} maxLength={500} onChange={(x) => setF({ ...f, note: x.target.value })} /></Field>
          </>
        ) : (
          <Field label="Motif du refus" hint="Lu par la direction (5 à 500 caractères). Le montant redevient disponible et se déduit des documents à payer.">
            <Textarea rows={3} value={f.note} minLength={5} maxLength={500} onChange={(x) => setF({ ...f, note: x.target.value })} required />
          </Field>
        )}
        <CodeField value={f.code} onChange={(code) => setF({ ...f, code })} />
        <ErrorNote error={error} />
        <Button type="submit" loading={busy}>Enregistrer la décision</Button>
      </form>
    </DialogContent>
  );
}

function TransferDialog({ from, all, done }: { from: CreditEstablishment; all: CreditEstablishment[]; done: () => void }) {
  const targets = all.filter((e) => e.group.id === from.group.id && e.tenantId !== from.tenantId && e.currency === from.currency);
  const [f, setF] = useState({ toTenantId: targets[0]?.tenantId ?? '', amount: '', authorizedBy: '', reason: '', code: '' });
  const [file, setFile] = useState<File | null>(null);
  const { busy, error, submit } = useSubmit(done, 'Crédit transféré');
  const send = () => {
    const form = new FormData();
    form.append('fromTenantId', from.tenantId);
    for (const [k, v] of Object.entries(f)) form.append(k, v);
    if (file) form.append('file', file);
    return pf('POST', '/billing/credit-transfers', form);
  };
  return (
    <DialogContent title={`Transférer le crédit de ${from.name}`} description={`Dans le groupe ${from.group.name} seulement, au plus ${money(from.credit.available, from.currency)}. Deux écritures et une trace dans les journaux ; le crédit reçu se déduit aussitôt des documents à payer.`}>
      <form className="grid gap-3" onSubmit={(ev) => { ev.preventDefault(); submit(send); }}>
        <Field label="Établissement qui reçoit">
          <Select value={f.toTenantId} onChange={(x) => setF({ ...f, toTenantId: x.target.value })} required>
            {targets.map((t) => <option key={t.tenantId} value={t.tenantId}>{t.name}</option>)}
          </Select>
        </Field>
        <Field label="Montant" hint={`En ${from.currency}, nombre entier.`}><Input inputMode="numeric" value={f.amount} onChange={(x) => setF({ ...f, amount: x.target.value.replace(/\D/g, '') })} required /></Field>
        <Field label="Autorisation" hint="Qui l’a donnée et par quel écrit (5 à 300 caractères)."><Input value={f.authorizedBy} minLength={5} maxLength={300} onChange={(x) => setF({ ...f, authorizedBy: x.target.value })} required /></Field>
        <Field label="Écrit de l’autorisation (facultatif)" hint="Photo ou PDF."><Input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(x) => setFile(x.target.files?.[0] ?? null)} /></Field>
        <Field label="Motif" hint="Interne à Cahiora (5 à 300 caractères)."><Input value={f.reason} minLength={5} maxLength={300} onChange={(x) => setF({ ...f, reason: x.target.value })} required /></Field>
        <CodeField value={f.code} onChange={(code) => setF({ ...f, code })} />
        <ErrorNote error={error} />
        <Button type="submit" loading={busy} disabled={!targets.length}>Transférer</Button>
      </form>
    </DialogContent>
  );
}

// ---------------------------------------------------------------- Rapports financiers

const TOTALS: [keyof Totals, string, string][] = [
  ['billed', 'Facturé', 'Proformas de l’abonnement (documents provisoires)'],
  ['credited', 'Avoirs', 'Avoirs provisoires émis'],
  ['collected', 'Encaissé', 'Paiements validés par Cahiora, saisies annulées déduites'],
  ['refunded', 'Remboursé', 'Crédits remboursés aux établissements'],
  ['unpaid', 'Impayés', 'Reste à payer aujourd’hui (établissements seuls)'],
  ['groupPending', 'Documents de groupe', 'Paiement en attente de D-G5-19 et D-G5-32'],
  ['credits', 'Crédits disponibles', 'Aujourd’hui, remboursements demandés déduits'],
];
const STATUS_OPTIONS = [
  ['', 'Tous les états'], ['PENDING', 'En attente'], ['PARTIAL', 'Partiellement payé'], ['OVERDUE', 'En retard'], ['PAID', 'Payé'], ['CANCELLED', 'Annulé par avoir'], ['NOTHING_DUE', 'Rien à payer'],
] as const;

export function Rapports() {
  const [f, setF] = useState({ from: '', to: '', groupId: '', tenantId: '', status: '' });
  const [query, setQuery] = useState('');
  const [d, setD] = useState<Report | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    setError(null);
    pf<Report>('GET', `/billing/reports${query}`).then(setD).catch(setError);
  }, [query]);
  const apply = (ev: React.FormEvent) => {
    ev.preventDefault();
    const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
    setQuery(q ? `?${q}` : '');
  };
  const tenants = d ? d.tenants.filter((t) => !f.groupId || t.groupId === f.groupId) : [];
  return (
    <div className="grid gap-4">
      <form className="no-print grid gap-3 rounded-xl border border-line p-3 sm:grid-cols-3 lg:grid-cols-6" onSubmit={apply} aria-label="Filtres du rapport">
        <Field label="Du"><Input type="date" value={f.from} onChange={(x) => setF({ ...f, from: x.target.value })} /></Field>
        <Field label="Au"><Input type="date" value={f.to} onChange={(x) => setF({ ...f, to: x.target.value })} /></Field>
        <Field label="Groupe">
          <Select value={f.groupId} onChange={(x) => setF({ ...f, groupId: x.target.value, tenantId: '' })}>
            <option value="">Tous les groupes</option>
            {d?.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </Select>
        </Field>
        <Field label="Établissement">
          <Select value={f.tenantId} onChange={(x) => setF({ ...f, tenantId: x.target.value })}>
            <option value="">Tous les établissements</option>
            {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </Field>
        <Field label="État des documents">
          <Select value={f.status} onChange={(x) => setF({ ...f, status: x.target.value })}>
            {STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </Field>
        <div className="flex items-end gap-2">
          <Button type="submit">Afficher</Button>
          <Button type="button" variant="outline" onClick={() => window.print()} aria-label="Imprimer le rapport"><Printer className="size-4" /></Button>
        </div>
      </form>
      <ErrorNote error={error} />
      {d && (
        <>
          <Card className="grid gap-2">
            <h3 className="flex items-center gap-2 font-bold"><Receipt className="size-4" /> Totaux par monnaie</h3>
            <p className="text-sm text-muted">Facturé et encaissé ne se confondent jamais : les documents restent provisoires, l’encaissé ne compte que les paiements validés par Cahiora. Aucune monnaie ne s’additionne à une autre.</p>
            <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" aria-label="Totaux financiers">
              {TOTALS.map(([k, label, hint]) => (
                <div key={k} className="grid gap-0.5 rounded-lg bg-sunk p-3">
                  <dt className="text-xs font-bold uppercase tracking-wider text-muted">{label}</dt>
                  <dd className="tabular text-lg font-bold" data-testid={`total-${k}`}>{moneyRows(d.totals[k])}</dd>
                  <dd className="text-xs text-muted">{hint}</dd>
                </div>
              ))}
            </dl>
            <p className="text-xs text-muted">Période : date du document, du paiement ou du remboursement ; l’état ne filtre que la liste des documents. {d.mention}</p>
          </Card>
          <Card className="grid gap-2">
            <h3 className="font-bold">Documents de l’abonnement ({d.documents.length})</h3>
            {d.documents.length === 0 ? <p className="text-sm text-muted">Aucun document pour ces filtres.</p> : (
              <Table aria-label="Documents du rapport">
                <thead><tr><th>Document</th><th>Établissements</th><th>Échéance</th><th>Montant</th><th>Payé</th><th>Reste</th><th>État</th></tr></thead>
                <tbody>
                  {d.documents.map((x) => (
                    <tr key={x.id}>
                      <td><span className="font-mono text-xs">{x.reference}</span><span className="block text-xs text-muted">du {frDate(x.issueDate)}</span></td>
                      <td>{x.establishments.map((e) => e.name).join(', ')}</td>
                      <td>{x.dueDate ? frDate(x.dueDate) : '—'}</td>
                      <td>{money(x.total, x.currency)}</td>
                      <td>{x.payment.paid === null ? '—' : money(x.payment.paid, x.currency)}</td>
                      <td>{x.payment.balance === null ? '—' : <b>{money(x.payment.balance, x.currency)}</b>}</td>
                      <td><PayBadge p={x.payment} /></td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card className="grid gap-2">
            <h3 className="font-bold">Paiements ({d.payments.length})</h3>
            {d.payments.length === 0 ? <p className="text-sm text-muted">Aucun paiement pour ces filtres.</p> : <PaymentsTable payments={d.payments} />}
          </Card>
        </>
      )}
    </div>
  );
}
