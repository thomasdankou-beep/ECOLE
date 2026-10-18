'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Layers, Plus, Trash2 } from 'lucide-react';
import { Loader, StatusBadge } from '@/components/espace/bits';
import { Button, Card, Chips, Dialog, DialogContent, DialogTrigger, Empty, Field, Input, PageHeader, Select, Table, Textarea, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { date, fcfa } from '@/lib/format';
import type { ClassRow, StudentRow } from '@/lib/types';
import { qs, useAction, useApi } from '@/lib/use-api';

export default function Factures() {
  const [status, setStatus] = useState('');
  const [classId, setClassId] = useState('');
  const classes = useApi<ClassRow[]>('/classes');
  const q = useApi<any[]>(`/finance/invoices${qs({ status, classId })}`);
  const [cancel, setCancel] = useState<any | null>(null);
  const [reason, setReason] = useState('');
  const toast = useToast();
  const { busy, run } = useAction();
  return (
    <>
      <PageHeader title="Factures" actions={<><BatchDialog classes={classes.data ?? []} onDone={q.reload} /><NewInvoice classes={classes.data ?? []} onDone={q.reload} /></>} />
      <Chips label="Statut" value={status} onChange={setStatus} options={[{ value: '', label: 'Toutes' }, { value: 'OPEN', label: 'À payer' }, { value: 'PARTIAL', label: 'Partielles' }, { value: 'PAID', label: 'Soldées' }, { value: 'CANCELLED', label: 'Annulées' }]} />
      <Card className="grid gap-3 sm:max-w-sm"><Field label="Classe"><Select value={classId} onChange={(e) => setClassId(e.target.value)}><option value="">Toutes</option>{classes.data?.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.site.name}</option>)}</Select></Field></Card>
      <Card>
        <Loader {...q}>
          {(rows) => rows.length === 0 ? <Empty title="Aucune facture" /> : (
            <Table>
              <thead><tr><th>N°</th><th>Élève</th><th>Objet</th><th>Échéance</th><th className="text-right">Montant</th><th className="text-right">Reste</th><th>Statut</th><th /></tr></thead>
              <tbody>{rows.map((i) => (
                <tr key={i.id}>
                  <td className="font-mono text-sm">{i.number}</td>
                  <td><Link href={`/espace/eleves/${i.student.id}`} className="font-bold text-brand hover:underline">{i.student.lastName} {i.student.firstName}</Link></td>
                  <td>{i.label}</td>
                  <td className="whitespace-nowrap">{date(i.dueDate)}</td>
                  <td className="text-right">{fcfa(i.total)}</td>
                  <td className="text-right font-bold">{fcfa(i.remaining)}</td>
                  <td><StatusBadge status={i.status} /></td>
                  <td className="text-right">{i.paid === 0 && i.status !== 'CANCELLED' && <Button size="sm" variant="ghost" className="text-bad" onClick={() => { setCancel(i); setReason(''); }}>Annuler</Button>}</td>
                </tr>
              ))}</tbody>
            </Table>
          )}
        </Loader>
      </Card>
      <Dialog open={!!cancel} onOpenChange={(o) => !o && setCancel(null)}>
        {cancel && (
          <DialogContent title={`Annuler la facture ${cancel.number}`} description="La facture reste dans l’historique avec le statut « Annulée ».">
            <form className="grid gap-3" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.post(`/finance/invoices/${cancel.id}/cancel`, { reason }), toast, 'Facture annulée')) { setCancel(null); q.reload(); } }}>
              <Field label="Motif"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} required /></Field>
              <Button type="submit" variant="danger" loading={busy}>Annuler la facture</Button>
            </form>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}

function BatchDialog({ classes, onDone }: { classes: ClassRow[]; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const fees = useApi<any[]>(open ? '/finance/fee-types' : null);
  const [f, setF] = useState({ feeTypeId: '', classId: '' });
  const toast = useToast();
  const { busy, run } = useAction();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button variant="outline"><Layers className="size-4" /> Facturer en lot</Button></DialogTrigger>
      <DialogContent title="Facturer en lot" description="Crée la facture d’un frais pour tous les élèves concernés qui ne l’ont pas encore.">
        <form className="grid gap-3" onSubmit={async (e) => {
          e.preventDefault();
          const r = await run(() => api.post<{ created: number }>('/finance/invoices/batch', { feeTypeId: f.feeTypeId, classId: f.classId || undefined }), toast);
          if (r) { toast(`${r.created ?? 0} facture(s) créée(s)`); setOpen(false); onDone(); }
        }}>
          <Field label="Frais"><Select value={f.feeTypeId} onChange={(e) => setF({ ...f, feeTypeId: e.target.value })} required><option value="">Choisir</option>{fees.data?.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.name} · {fcfa(x.amount)}</option>)}</Select></Field>
          <Field label="Classe (facultatif)"><Select value={f.classId} onChange={(e) => setF({ ...f, classId: e.target.value })}><option value="">Toutes les classes concernées</option>{classes.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.site.name}</option>)}</Select></Field>
          <Button type="submit" loading={busy}>Créer les factures</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NewInvoice({ classes, onDone }: { classes: ClassRow[]; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [classId, setClassId] = useState('');
  const students = useApi<StudentRow[]>(classId ? `/students?classId=${classId}` : null);
  const [f, setF] = useState({ studentId: '', label: '', dueDate: '' });
  const [items, setItems] = useState([{ label: '', amount: '' }]);
  const toast = useToast();
  const { busy, run } = useAction();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus className="size-4" /> Nouvelle facture</Button></DialogTrigger>
      <DialogContent title="Nouvelle facture">
        <form className="grid gap-3" onSubmit={async (e) => {
          e.preventDefault();
          if (await run(() => api.post('/finance/invoices', { ...f, items: items.map((i) => ({ label: i.label, amount: Number(i.amount) })) }), toast, 'Facture créée')) { setOpen(false); onDone(); }
        }}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Classe"><Select value={classId} onChange={(e) => setClassId(e.target.value)} required><option value="">Choisir</option>{classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
            <Field label="Élève"><Select value={f.studentId} onChange={(e) => setF({ ...f, studentId: e.target.value })} required><option value="">Choisir</option>{students.data?.map((s) => <option key={s.id} value={s.id}>{s.lastName} {s.firstName}</option>)}</Select></Field>
          </div>
          <div className="grid grid-cols-[1fr_160px] gap-3">
            <Field label="Objet"><Input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} required /></Field>
            <Field label="Échéance"><Input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} required /></Field>
          </div>
          {items.map((it, i) => (
            <div key={i} className="grid grid-cols-[1fr_130px_auto] items-end gap-2">
              <Field label={`Ligne ${i + 1}`}><Input value={it.label} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} required /></Field>
              <Field label="Montant"><Input type="number" min={1} value={it.amount} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} required /></Field>
              <Button type="button" variant="ghost" size="icon" aria-label="Retirer la ligne" disabled={items.length === 1} onClick={() => setItems(items.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>
            </div>
          ))}
          <Button type="button" variant="ghost" onClick={() => setItems([...items, { label: '', amount: '' }])}><Plus className="size-4" /> Ajouter une ligne</Button>
          <p className="text-right font-bold">Total : {fcfa(items.reduce((s, i) => s + (Number(i.amount) || 0), 0))}</p>
          <Button type="submit" loading={busy}>Créer la facture</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
