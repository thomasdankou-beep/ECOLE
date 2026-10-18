'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Printer, Search } from 'lucide-react';
import { Loader, StatusBadge } from '@/components/espace/bits';
import { Button, Card, Empty, Field, Input, PageHeader, Select, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { date, fcfa, METHOD_LABEL } from '@/lib/format';
import type { StudentRow } from '@/lib/types';
import { useAction, useApi } from '@/lib/use-api';
import { cn, uid } from '@/lib/utils';

export default function Guichet() {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [student, setStudent] = useState<StudentRow | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const results = useApi<StudentRow[]>(debounced.length >= 2 && !student ? `/students?q=${encodeURIComponent(debounced)}` : null);

  return (
    <>
      <PageHeader title="Guichet" subtitle="Encaissement au bureau : espèces, chèque, virement ou Mobile Money reçu au bureau. Un reçu numéroté est émis à chaque paiement." />
      {!student ? (
        <Card className="grid gap-3">
          <label className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nom ou matricule de l’élève" className="pl-10 text-lg" autoFocus aria-label="Rechercher un élève" />
          </label>
          {results.data && (results.data.length === 0 ? <p className="text-muted">Aucun élève trouvé.</p> : (
            <ul className="grid gap-1">{results.data.slice(0, 8).map((s) => (
              <li key={s.id}>
                <button type="button" onClick={() => setStudent(s)} className="flex min-h-12 w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-3 text-left hover:bg-sunk">
                  <span><b>{s.lastName} {s.firstName}</b> <span className="text-sm text-muted">· {s.matricule} · {s.class?.name}</span></span>
                  <span className={cn('font-bold', s.balance ? 'text-bad' : 'text-good')}>{fcfa(s.balance ?? 0)}</span>
                </button>
              </li>
            ))}</ul>
          ))}
        </Card>
      ) : (
        <Desk student={student} onBack={() => { setStudent(null); setQ(''); }} />
      )}
    </>
  );
}

function Desk({ student, onBack }: { student: StudentRow; onBack: () => void }) {
  const inv = useApi<any[]>(`/finance/invoices?studentId=${student.id}`);
  const [invoiceId, setInvoiceId] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('CASH');
  const [reference, setReference] = useState('');
  const [receipt, setReceipt] = useState<{ id: string; number: string } | null>(null);
  const key = useRef(uid());
  const toast = useToast();
  const { busy, run } = useAction();
  const open = inv.data?.filter((i) => i.remaining > 0 && i.status !== 'CANCELLED') ?? [];
  const selected = open.find((i) => i.id === invoiceId);

  useEffect(() => {
    if (!invoiceId && open[0]) { setInvoiceId(open[0].id); setAmount(String(open[0].remaining)); }
  }, [open, invoiceId]);

  async function pay(e: React.FormEvent) {
    e.preventDefault();
    const r = await run(() => api.post<{ receipt: { id: string; number: string }; duplicate: boolean }>('/finance/payments/desk', { invoiceId, amount: Number(amount), method, reference: reference || undefined, idempotencyKey: key.current }), toast);
    if (r) {
      toast(r.duplicate ? 'Ce paiement avait déjà été enregistré' : `Paiement enregistré · reçu ${r.receipt.number}`);
      setReceipt(r.receipt);
      key.current = uid();
      setInvoiceId('');
      setReference('');
      inv.reload();
    }
  }

  return (
    <>
      <Card className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xl font-bold">{student.lastName} {student.firstName}</p>
          <p className="text-sm text-muted">{student.matricule} · {student.class?.name} · {student.class?.site.name}</p>
        </div>
        <Button variant="outline" onClick={onBack}>Autre élève</Button>
      </Card>
      {receipt && (
        <Card className="flex flex-wrap items-center gap-3 border-good bg-good-soft">
          <p className="flex-1 font-bold text-good">Reçu {receipt.number} émis.</p>
          <Button asChild><Link href={`/espace/recu/${receipt.id}`}><Printer className="size-4" /> Imprimer le reçu</Link></Button>
        </Card>
      )}
      <Loader {...inv}>
        {() => open.length === 0 ? <Empty title="Aucune somme due">Toutes les factures de cet élève sont réglées.</Empty> : (
          <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
            <Card className="grid gap-2">
              <h2 className="text-xl font-bold">Factures à régler</h2>
              {open.map((i) => (
                <button key={i.id} type="button" onClick={() => { setInvoiceId(i.id); setAmount(String(i.remaining)); }} className={cn('flex min-h-14 cursor-pointer items-center justify-between gap-2 rounded-lg border px-3 text-left', invoiceId === i.id ? 'border-brand bg-brand-soft' : 'border-line')}>
                  <span><b>{i.label}</b><span className="block text-xs text-muted">{i.number} · échéance {date(i.dueDate)}</span></span>
                  <span className="text-right"><b className="block">{fcfa(i.remaining)}</b><StatusBadge status={i.status} /></span>
                </button>
              ))}
            </Card>
            <Card>
              <form onSubmit={pay} className="grid gap-3">
                <h2 className="text-xl font-bold">Encaisser</h2>
                <Field label="Montant reçu (FCFA)" hint={selected ? `Reste dû sur cette facture : ${fcfa(selected.remaining)}` : undefined}>
                  <Input type="number" inputMode="numeric" min={1} max={selected?.remaining} value={amount} onChange={(e) => setAmount(e.target.value)} required className="text-2xl font-bold tabular" />
                </Field>
                <Field label="Moyen de paiement">
                  <Select value={method} onChange={(e) => setMethod(e.target.value)}>{['CASH', 'MOBILE_MONEY_DESK', 'CHEQUE', 'TRANSFER'].map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}</Select>
                </Field>
                {method !== 'CASH' && <Field label="Référence (n° de chèque, de transaction…)"><Input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>}
                <Button type="submit" size="lg" variant="success" loading={busy} disabled={!invoiceId}>Valider et émettre le reçu</Button>
              </form>
            </Card>
          </div>
        )}
      </Loader>
    </>
  );
}
