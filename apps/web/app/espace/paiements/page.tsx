'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Download } from 'lucide-react';
import { Loader, StatusBadge } from '@/components/espace/bits';
import { Button, Card, Chips, Dialog, DialogContent, Empty, Field, Input, PageHeader, Table, Textarea, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime, fcfa, METHOD_LABEL } from '@/lib/format';
import { qs, useAction, useApi } from '@/lib/use-api';

export default function Paiements() {
  const [status, setStatus] = useState('SUCCESS');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const q = useApi<any[]>(`/finance/payments${qs({ status, from, to })}`);
  const [cancel, setCancel] = useState<any | null>(null);
  const [reason, setReason] = useState('');
  const toast = useToast();
  const { busy, run } = useAction();
  const total = q.data?.filter((p) => p.status === 'SUCCESS' && !p.receipt?.cancelledAt).reduce((s, p) => s + p.amount, 0) ?? 0;

  return (
    <>
      <PageHeader title="Paiements" subtitle={q.data ? `${q.data.length} paiement(s) · ${fcfa(total)} encaissés` : undefined} actions={<Button variant="outline" onClick={() => api.download(`/finance/payments/export.csv${qs({ from, to })}`, `paiements-${from || 'debut'}-${to || 'fin'}.csv`).catch((e) => toast(e.message, 'bad'))}><Download className="size-4" /> Export Excel (CSV)</Button>} />
      <Chips label="Statut" value={status} onChange={setStatus} options={[{ value: 'SUCCESS', label: 'Réussis' }, { value: 'PENDING', label: 'En attente' }, { value: 'FAILED', label: 'Échoués' }, { value: '', label: 'Tous' }]} />
      <Card className="grid grid-cols-2 gap-3 sm:max-w-md">
        <Field label="Du"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="Au"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </Card>
      <Card>
        <Loader {...q}>
          {(rows) => rows.length === 0 ? <Empty title="Aucun paiement" /> : (
            <Table>
              <thead><tr><th>Date</th><th>Élève</th><th>Objet</th><th>Moyen</th><th className="text-right">Montant</th><th>Statut</th><th>Reçu</th><th /></tr></thead>
              <tbody>{rows.map((p) => (
                <tr key={p.id} className={p.receipt?.cancelledAt ? 'opacity-60' : ''}>
                  <td className="whitespace-nowrap">{dateTime(p.confirmedAt ?? p.createdAt)}</td>
                  <td className="font-bold">{p.student.lastName} {p.student.firstName}</td>
                  <td>{p.invoice.label}</td>
                  <td>{METHOD_LABEL[p.method]}{p.operator ? ` · ${p.operator}` : ''}</td>
                  <td className="text-right font-bold">{fcfa(p.amount)}</td>
                  <td><StatusBadge status={p.status} /></td>
                  <td>{p.receipt && <Link href={`/espace/recu/${p.receipt.id}`} className={`font-mono text-sm font-bold text-brand hover:underline ${p.receipt.cancelledAt ? 'line-through' : ''}`}>{p.receipt.number}</Link>}</td>
                  <td className="text-right">{p.receipt && !p.receipt.cancelledAt && <Button size="sm" variant="ghost" className="text-bad" onClick={() => { setCancel(p); setReason(''); }}>Annuler</Button>}</td>
                </tr>
              ))}</tbody>
            </Table>
          )}
        </Loader>
      </Card>
      <Dialog open={!!cancel} onOpenChange={(o) => !o && setCancel(null)}>
        {cancel && (
          <DialogContent title={`Annuler le reçu ${cancel.receipt.number}`} description="Un reçu n’est jamais supprimé : il est marqué annulé et le montant est remis à la charge de la famille. L’opération est tracée.">
            <form className="grid gap-3" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.post(`/finance/receipts/${cancel.receipt.id}/cancel`, { reason }), toast, 'Reçu annulé')) { setCancel(null); q.reload(); } }}>
              <Field label="Motif"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} required /></Field>
              <Button type="submit" variant="danger" loading={busy}>Annuler le reçu</Button>
            </form>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
