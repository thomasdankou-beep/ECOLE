'use client';

import { useState } from 'react';
import { MessageSquareText, Phone } from 'lucide-react';
import { Loader } from '@/components/espace/bits';
import { Badge, Button, Card, Empty, Field, PageHeader, Select, Table, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { date, fcfa } from '@/lib/format';
import type { ClassRow } from '@/lib/types';
import { qs, useAction, useApi } from '@/lib/use-api';

export default function Impayes() {
  const [classId, setClassId] = useState('');
  const classes = useApi<ClassRow[]>('/classes');
  const q = useApi<any[]>(`/finance/unpaid${qs({ classId })}`);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const toast = useToast();
  const { busy, run } = useAction();
  const total = q.data?.reduce((s, r) => s + r.remaining, 0) ?? 0;
  const studentIds = [...new Set(q.data?.filter((r) => picked.has(r.id)).map((r) => r.student.id) ?? [])];

  return (
    <>
      <PageHeader title="Impayés et relances" subtitle={q.data ? `${q.data.length} facture(s) en retard · ${fcfa(total)}` : undefined} actions={
        <Button variant="accent" loading={busy} disabled={!q.data?.length} onClick={async () => {
          const r = await run(() => api.post<{ families: number }>('/finance/reminders', studentIds.length ? { studentIds } : { classId: classId || undefined }), toast);
          if (r) toast(`${r.families} famille(s) relancée(s) par notification et SMS`);
        }}><MessageSquareText className="size-4" /> {studentIds.length ? `Relancer ${studentIds.length} famille(s)` : 'Relancer toutes ces familles'}</Button>
      } />
      <Card className="grid gap-3 sm:max-w-sm"><Field label="Classe"><Select value={classId} onChange={(e) => { setClassId(e.target.value); setPicked(new Set()); }}><option value="">Toutes</option>{classes.data?.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.site.name}</option>)}</Select></Field></Card>
      <Card>
        <Loader {...q}>
          {(rows) => rows.length === 0 ? <Empty title="Aucun impayé">Toutes les échéances passées sont réglées.</Empty> : (
            <Table>
              <thead><tr><th><span className="sr-only">Choisir</span></th><th>Élève</th><th>Classe</th><th>Facture</th><th>Échéance</th><th className="text-right">Reste</th><th>Parent</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.id}>
                  <td><input type="checkbox" className="size-5" aria-label={`Choisir ${r.student.name}`} checked={picked.has(r.id)} onChange={(e) => { const n = new Set(picked); if (e.target.checked) n.add(r.id); else n.delete(r.id); setPicked(n); }} /></td>
                  <td className="font-bold">{r.student.name}</td>
                  <td>{r.student.class?.name}</td>
                  <td>{r.label}<span className="block font-mono text-xs text-muted">{r.number}</span></td>
                  <td className="whitespace-nowrap">{date(r.dueDate)} <Badge tone={r.daysLate > 60 ? 'bad' : 'warn'}>{r.daysLate} j</Badge></td>
                  <td className="text-right font-bold text-bad">{fcfa(r.remaining)}</td>
                  <td className="whitespace-nowrap">{r.guardian ? <a href={`tel:${r.guardian.phone}`} className="inline-flex items-center gap-1 font-bold text-brand"><Phone className="size-4" /> {r.guardian.firstName} {r.guardian.lastName}</a> : '—'}</td>
                </tr>
              ))}</tbody>
            </Table>
          )}
        </Loader>
      </Card>
    </>
  );
}
