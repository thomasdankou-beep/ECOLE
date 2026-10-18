'use client';

import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { Loader, StatusBadge } from '@/components/espace/bits';
import { Button, Card, Chips, Empty, Field, Input, PageHeader, Select, Table, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { date, hhmm } from '@/lib/format';
import { can } from '@/lib/perm';
import type { ClassRow } from '@/lib/types';
import { qs, useAction, useApi } from '@/lib/use-api';

export default function Assiduite() {
  const { role } = useAuth();
  const [f, setF] = useState(useSearchParams().get('f') ?? '');
  const [classId, setClassId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const classes = useApi<ClassRow[]>('/classes');
  const q = useApi<any[]>(`/attendance/absences${qs({ justification: f, classId, from, to })}`);
  const review = can(role, 'attendance.review');
  const toast = useToast();
  const { busy, run } = useAction();

  return (
    <>
      <PageHeader title="Absences et retards" subtitle={review ? 'Examinez les justificatifs envoyés par les parents.' : undefined} />
      <Chips label="Justification" value={f} onChange={setF} options={[{ value: '', label: 'Toutes' }, { value: 'PENDING', label: 'À examiner' }, { value: 'NONE', label: 'Non justifiées' }, { value: 'ACCEPTED', label: 'Justifiées' }, { value: 'REJECTED', label: 'Refusées' }]} />
      <Card className="grid gap-3 sm:grid-cols-3">
        <Field label="Classe"><Select value={classId} onChange={(e) => setClassId(e.target.value)}><option value="">Toutes</option>{classes.data?.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.site.name}</option>)}</Select></Field>
        <Field label="Du"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="Au"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </Card>
      <Card>
        <Loader {...q}>
          {(rows) => rows.length === 0 ? <Empty title="Aucune absence pour ces critères" /> : (
            <Table>
              <thead><tr><th>Élève</th><th>Classe</th><th>Date</th><th>Cours</th><th>Type</th><th>Justification</th>{review && <th />}</tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.id}>
                  <td className="font-bold">{r.student.lastName} {r.student.firstName}</td>
                  <td>{r.class.name}</td>
                  <td className="whitespace-nowrap">{date(r.date)} · {hhmm(r.startMinute)}</td>
                  <td>{r.subject ?? '—'}</td>
                  <td><StatusBadge status={r.status} />{r.minutesLate ? <span className="text-sm"> {r.minutesLate} min</span> : null}</td>
                  <td>
                    <StatusBadge status={r.justification} justification />
                    {r.justificationReason && <span className="block max-w-56 text-sm">{r.justificationReason}</span>}
                    {r.justificationFileUrl && <a href={r.justificationFileUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm font-bold text-brand">Pièce jointe <ExternalLink className="size-3" /></a>}
                  </td>
                  {review && (
                    <td className="whitespace-nowrap text-right">
                      {r.justification === 'PENDING' && (
                        <div className="flex justify-end gap-1.5">
                          <Button size="sm" variant="success" loading={busy} onClick={async () => { if (await run(() => api.post(`/attendance/records/${r.id}/review`, { accept: true }), toast, 'Justificatif accepté')) q.reload(); }}>Accepter</Button>
                          <Button size="sm" variant="outline" loading={busy} onClick={async () => { if (await run(() => api.post(`/attendance/records/${r.id}/review`, { accept: false }), toast, 'Justificatif refusé')) q.reload(); }}>Refuser</Button>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              ))}</tbody>
            </Table>
          )}
        </Loader>
      </Card>
    </>
  );
}
