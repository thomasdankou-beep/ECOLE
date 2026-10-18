'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Smartphone, XCircle } from 'lucide-react';
import { Loader, StatusBadge } from '@/components/espace/bits';
import { Button, Card, Dialog, DialogContent, Empty, Field, Input, PageHeader, Select, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { date, fcfa } from '@/lib/format';
import { useAction, useApi } from '@/lib/use-api';

export default function Frais() {
  const { child, me } = useAuth();
  const paymentId = useSearchParams().get('paiement');
  const q = useApi<any[]>(`/finance/invoices?studentId=${child!.id}`);
  const [pay, setPay] = useState<any | null>(null);
  const rows = q.data?.filter((i) => i.status !== 'CANCELLED') ?? [];
  const due = rows.reduce((s, i) => s + i.remaining, 0);
  const receipts = rows.flatMap((i) => i.payments.filter((p: any) => p.receipt && !p.receipt.cancelledAt).map((p: any) => ({ ...p, label: i.label })));

  return (
    <>
      <PageHeader title="Frais scolaires" subtitle={`${child!.firstName} ${child!.lastName} · ${me?.year?.label ?? ''}`} />
      {paymentId && <PaymentStatus id={paymentId} onSettled={q.reload} />}
      <Loader {...q}>
        {() => (
          <>
            <Card className={due ? 'border-orange bg-orange-soft' : 'border-good bg-good-soft'}>
              <p className="text-sm font-bold uppercase tracking-wider">Reste à payer</p>
              <p className="tabular font-display text-5xl font-bold">{fcfa(due)}</p>
              {!due && <p className="font-bold text-good">Tout est réglé, merci.</p>}
            </Card>
            {rows.length === 0 ? <Empty title="Aucune facture" /> : (
              <div className="grid gap-3 md:grid-cols-2">
                {rows.map((i) => (
                  <Card key={i.id} className="grid gap-2">
                    <div className="flex items-start justify-between gap-2">
                      <div><p className="text-lg font-bold">{i.label}</p><p className="text-sm text-muted">Échéance {date(i.dueDate, { day: 'numeric', month: 'long', year: 'numeric' })}</p></div>
                      <StatusBadge status={i.status} />
                    </div>
                    <div className="flex items-end justify-between gap-2">
                      <p className="text-sm">Montant {fcfa(i.total)} · payé {fcfa(i.paid)}</p>
                      <p className="tabular text-xl font-bold">{fcfa(i.remaining)}</p>
                    </div>
                    {i.remaining > 0 && <Button variant="accent" size="lg" onClick={() => setPay(i)}><Smartphone className="size-5" /> Payer par Mobile Money</Button>}
                  </Card>
                ))}
              </div>
            )}
            {receipts.length > 0 && (
              <Card>
                <h2 className="mb-2 text-xl font-bold">Reçus</h2>
                <ul className="grid gap-1">{receipts.map((p) => (
                  <li key={p.id}><Link href={`/espace/recu/${p.receipt.id}`} className="flex min-h-11 items-center justify-between gap-2 rounded-lg px-2 hover:bg-sunk"><span><b>{p.receipt.number}</b> · {p.label} · {date(p.confirmedAt)}</span><b>{fcfa(p.amount)}</b></Link></li>
                ))}</ul>
              </Card>
            )}
          </>
        )}
      </Loader>
      {pay && <PayDialog invoice={pay} phone={me?.user.phone ?? ''} onClose={() => setPay(null)} />}
    </>
  );
}

function PayDialog({ invoice, phone, onClose }: { invoice: any; phone: string; onClose: () => void }) {
  const ops = useApi<{ provider: string; operators: string[] }>('/payments/operators');
  const [f, setF] = useState({ amount: String(invoice.remaining), operator: '', phone: phone.replace(/^\+229/, '') });
  const toast = useToast();
  const { busy, run } = useAction();
  useEffect(() => {
    if (ops.data && !f.operator) setF((x) => ({ ...x, operator: ops.data!.operators[0] ?? '' }));
  }, [ops.data, f.operator]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Payer par Mobile Money" description={invoice.label}>
        <form className="grid gap-3" onSubmit={async (e) => {
          e.preventDefault();
          const r = await run(() => api.post<{ checkoutUrl?: string; paymentId: string }>('/payments/mobile-money', { invoiceId: invoice.id, amount: Number(f.amount), operator: f.operator, phone: f.phone }), toast);
          if (r?.checkoutUrl) window.location.href = r.checkoutUrl;
          else if (r) window.location.href = `/espace/frais?paiement=${r.paymentId}`;
        }}>
          <Field label="Montant (FCFA)" hint={`Vous pouvez payer en plusieurs fois. Reste dû : ${fcfa(invoice.remaining)}`}><Input type="number" inputMode="numeric" min={100} max={invoice.remaining} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} required className="text-2xl font-bold" /></Field>
          <Field label="Opérateur"><Select value={f.operator} onChange={(e) => setF({ ...f, operator: e.target.value })} required>{ops.data?.operators.map((o) => <option key={o}>{o}</option>)}</Select></Field>
          <Field label="Numéro Mobile Money"><Input type="tel" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} required /></Field>
          {ops.data?.provider === 'sandbox' && <p className="rounded-lg bg-warn-soft p-2 text-sm font-bold text-warn">Mode test : aucun argent réel ne sera débité.</p>}
          <Button type="submit" size="lg" variant="accent" loading={busy}>Continuer</Button>
          <p className="text-xs text-muted">Vous validerez le paiement sur votre téléphone. Le reçu est émis dès la confirmation de l’opérateur.</p>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PaymentStatus({ id, onSettled }: { id: string; onSettled: () => void }) {
  const router = useRouter();
  const [p, setP] = useState<{ status: string; amount: number; receipt: { id: string; number: string } | null } | null>(null);
  useEffect(() => {
    let stop = false;
    let n = 0;
    const tick = async () => {
      try {
        const r = await api.get<any>(`/payments/${id}`);
        if (stop) return;
        setP(r);
        if (r.status === 'SUCCESS' || r.status === 'FAILED' || r.status === 'CANCELLED') { onSettled(); return; }
      } catch { /* nouvel essai */ }
      if (++n < 40 && !stop) setTimeout(tick, 3000);
    };
    tick();
    return () => { stop = true; };
  }, [id, onSettled]);

  if (!p) return null;
  const close = <Button size="sm" variant="ghost" onClick={() => router.replace('/espace/frais')}>Fermer</Button>;
  if (p.status === 'SUCCESS')
    return (
      <Card className="flex flex-wrap items-center gap-3 border-good bg-good-soft">
        <CheckCircle2 className="size-8 text-good" />
        <p className="flex-1 font-bold text-good">Paiement de {fcfa(p.amount)} confirmé.</p>
        {p.receipt && <Button asChild><Link href={`/espace/recu/${p.receipt.id}`}>Voir le reçu {p.receipt.number}</Link></Button>}
        {close}
      </Card>
    );
  if (p.status === 'FAILED' || p.status === 'CANCELLED')
    return (
      <Card className="flex flex-wrap items-center gap-3 border-bad bg-bad-soft">
        <XCircle className="size-8 text-bad" />
        <p className="flex-1 font-bold text-bad">Le paiement n’a pas abouti. Aucun montant n’a été enregistré.</p>
        {close}
      </Card>
    );
  return (
    <Card className="flex items-center gap-3">
      <Loader2 className="size-6 animate-spin text-brand" />
      <p className="flex-1 font-bold">Paiement en attente de confirmation par l’opérateur…</p>
    </Card>
  );
}
