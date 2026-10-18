'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Loader, StatusBadge } from '@/components/espace/bits';
import { Button, Card, Dialog, DialogContent, DialogTrigger, Empty, Field, Input, PageHeader, Select, Table, Textarea, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { date, today } from '@/lib/format';
import { can } from '@/lib/perm';
import type { ClassRow, StudentRow } from '@/lib/types';
import { useAction, useApi } from '@/lib/use-api';

const KINDS = ['Avertissement', 'Blâme', 'Retenue', 'Exclusion temporaire', 'Travail d’intérêt scolaire'];

export default function Sanctions() {
  const { role } = useAuth();
  const q = useApi<any[]>('/sanctions');
  const canCreate = can(role, 'sanctions.propose') || can(role, 'sanctions.manage');
  const validate = can(role, 'sanctions.validate');
  const toast = useToast();
  const { busy, run } = useAction();
  return (
    <>
      <PageHeader title="Discipline" subtitle={role === 'ENSEIGNANT' ? 'Vous proposez, la direction valide. Les familles ne voient que les sanctions validées.' : 'Les sanctions validées sont visibles par la famille.'} actions={canCreate && <NewSanction onDone={q.reload} />} />
      <Card>
        <Loader {...q}>
          {(rows) => rows.length === 0 ? <Empty title="Aucune sanction" /> : (
            <Table>
              <thead><tr><th>Date</th><th>Élève</th><th>Sanction</th><th>Motif</th><th>Statut</th>{validate && <th />}</tr></thead>
              <tbody>{rows.map((s) => (
                <tr key={s.id}>
                  <td className="whitespace-nowrap">{date(s.date)}</td>
                  <td className="font-bold">{s.student.lastName} {s.student.firstName}</td>
                  <td>{s.kind}</td>
                  <td className="max-w-72 text-sm">{s.reason}</td>
                  <td><StatusBadge status={s.status} /></td>
                  {validate && <td className="whitespace-nowrap text-right">{s.status === 'PROPOSED' && (
                    <div className="flex justify-end gap-1.5">
                      <Button size="sm" variant="success" loading={busy} onClick={async () => { if (await run(() => api.post(`/sanctions/${s.id}/decision`, { validate: true }), toast, 'Sanction validée, famille prévenue')) q.reload(); }}>Valider</Button>
                      <Button size="sm" variant="outline" loading={busy} onClick={async () => { if (await run(() => api.post(`/sanctions/${s.id}/decision`, { validate: false }), toast, 'Sanction rejetée')) q.reload(); }}>Rejeter</Button>
                    </div>
                  )}</td>}
                </tr>
              ))}</tbody>
            </Table>
          )}
        </Loader>
      </Card>
    </>
  );
}

function NewSanction({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const classes = useApi<ClassRow[]>(open ? '/classes' : null);
  const [classId, setClassId] = useState('');
  const students = useApi<StudentRow[]>(classId ? `/students?classId=${classId}` : null);
  const [f, setF] = useState({ studentId: '', kind: KINDS[0], reason: '', date: today() });
  const toast = useToast();
  const { busy, run } = useAction();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus className="size-4" /> Nouvelle sanction</Button></DialogTrigger>
      <DialogContent title="Nouvelle sanction">
        <form className="grid gap-3" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.post('/sanctions', f), toast, 'Sanction enregistrée')) { setOpen(false); onDone(); } }}>
          <Field label="Classe"><Select value={classId} onChange={(e) => setClassId(e.target.value)} required><option value="">Choisir</option>{classes.data?.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.site.name}</option>)}</Select></Field>
          <Field label="Élève"><Select value={f.studentId} onChange={(e) => setF({ ...f, studentId: e.target.value })} required><option value="">Choisir</option>{students.data?.map((s) => <option key={s.id} value={s.id}>{s.lastName} {s.firstName}</option>)}</Select></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{KINDS.map((k) => <option key={k}>{k}</option>)}</Select></Field>
            <Field label="Date des faits"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} required /></Field>
          </div>
          <Field label="Motif"><Textarea value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} required maxLength={500} /></Field>
          <Button type="submit" loading={busy}>Enregistrer</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
