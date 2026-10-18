'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ArrowLeft, Check, Printer, RotateCcw } from 'lucide-react';
import { Loader, StatusBadge } from '@/components/espace/bits';
import { Button, Card, Dialog, DialogContent, Field, Input, PageHeader, Table, Textarea, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime, note } from '@/lib/format';
import { useAction, useApi } from '@/lib/use-api';
import { cn } from '@/lib/utils';

type Run = {
  class: { id: string; name: string; site: string; headTeacher: { firstName: string; lastName: string } | null };
  term: { id: string; name: string }; status: string; steps: { code: string; label: string }[]; history: { at: string; by: string; action: string }[];
  subjects: { classSubjectId: string; name: string; coefficient: number; teacher: string | null; stats: { mean: number | null } }[];
  classStats: { mean: number | null; min: number | null; max: number | null };
  students: { id: string; name: string; matricule: string; average: number | null; rank: number | null; subjects: Record<string, number | null>; distinction: string | null; evolution: number | null; absences: number; sanctions: number; appreciation: string; councilDecision: string; reportCardId: string | null }[];
};

const NEXT_LABEL: Record<string, string> = { SAISIE: 'Clore la saisie et passer au contrôle', CONTROLE: 'Passer au conseil de classe', CONSEIL: 'Valider les bulletins', VALIDE: 'Publier aux familles' };

export default function Conseil() {
  const p = useSearchParams();
  const classId = p.get('classId')!;
  const termId = p.get('termId')!;
  const { role } = useAuth();
  const q = useApi<Run>(`/report-cards/runs/${classId}/${termId}`);
  const toast = useToast();
  const { busy, run } = useAction();
  const [entries, setEntries] = useState<Record<string, { appreciation: string; councilDecision: string }>>({});
  const [reopen, setReopen] = useState(false);
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (q.data) setEntries(Object.fromEntries(q.data.students.map((s) => [s.id, { appreciation: s.appreciation, councilDecision: s.councilDecision }])));
  }, [q.data]);

  return (
    <>
      <Link href="/espace/bulletins" className="inline-flex items-center gap-1 text-sm font-bold text-brand"><ArrowLeft className="size-4" /> Bulletins</Link>
      <Loader {...q}>
        {(r) => {
          const idx = r.steps.findIndex((s) => s.code === r.status);
          const council = r.status === 'CONSEIL';
          const directionOnly = r.status === 'CONSEIL' || r.status === 'VALIDE';
          const canAdvance = r.status !== 'PUBLIE' && (!directionOnly || role === 'DIRECTION');
          const cards = r.students.filter((s) => s.reportCardId).map((s) => s.reportCardId);
          return (
            <>
              <PageHeader
                title={`${r.class.name} · ${r.term.name}`}
                subtitle={<>{r.class.site} · Professeur principal : {r.class.headTeacher ? `${r.class.headTeacher.firstName} ${r.class.headTeacher.lastName}` : 'non désigné'} · Moyenne de classe {note(r.classStats.mean)}</>}
                actions={<>
                  {cards.length > 0 && <Button asChild variant="outline"><Link href={`/espace/bulletins/${cards[0]}?tous=${cards.join(',')}`}><Printer className="size-4" /> Imprimer les bulletins</Link></Button>}
                  {role === 'DIRECTION' && r.status !== 'SAISIE' && r.status !== 'PUBLIE' && <Button variant="outline" onClick={() => setReopen(true)}><RotateCcw className="size-4" /> Rouvrir la saisie</Button>}
                  {canAdvance && <Button loading={busy} onClick={async () => { if (await run(() => api.post(`/report-cards/runs/${classId}/${termId}/advance`), toast, r.status === 'VALIDE' ? 'Bulletins publiés, familles prévenues' : 'Étape suivante')) q.reload(); }}><Check className="size-4" /> {NEXT_LABEL[r.status]}</Button>}
                </>}
              />
              <ol className="grid grid-cols-5 gap-1 text-center text-xs font-bold sm:text-sm">
                {r.steps.map((s, i) => (
                  <li key={s.code} className={cn('rounded-lg px-1 py-2', i < idx ? 'bg-good-soft text-good' : i === idx ? 'bg-brand text-brand-ink' : 'bg-sunk text-muted')}>{s.label}</li>
                ))}
              </ol>
              <Card>
                <Table>
                  <thead>
                    <tr>
                      <th>Rang</th><th>Élève</th>
                      {r.subjects.map((s) => <th key={s.classSubjectId} className="text-right" title={s.teacher ?? ''}>{s.name.slice(0, 10)}<span className="block font-semibold">×{note(s.coefficient)}</span></th>)}
                      <th className="text-right">Moy.</th><th>Mention</th><th className="text-right">Abs.</th>
                      {(council || r.status === 'VALIDE' || r.status === 'PUBLIE') && <><th className="min-w-56">Appréciation générale</th><th className="min-w-40">Décision</th></>}
                    </tr>
                  </thead>
                  <tbody>{r.students.map((s) => (
                    <tr key={s.id}>
                      <td className="font-bold">{s.rank ?? '—'}</td>
                      <td className="whitespace-nowrap font-bold">{s.name}{s.evolution !== null && <span className={cn('ml-1 text-xs', s.evolution >= 0 ? 'text-good' : 'text-bad')}>{s.evolution >= 0 ? '▲' : '▼'} {note(Math.abs(s.evolution))}</span>}</td>
                      {r.subjects.map((x) => <td key={x.classSubjectId} className={cn('text-right', (s.subjects[x.classSubjectId] ?? 20) < 10 && 'text-bad')}>{note(s.subjects[x.classSubjectId])}</td>)}
                      <td className="text-right font-bold">{note(s.average)}</td>
                      <td className="text-sm">{s.distinction ?? ''}</td>
                      <td className="text-right">{s.absences}</td>
                      {(council || r.status === 'VALIDE' || r.status === 'PUBLIE') && (
                        <>
                          <td><Input disabled={!council} className="min-h-10" value={entries[s.id]?.appreciation ?? ''} onChange={(e) => setEntries({ ...entries, [s.id]: { ...entries[s.id], appreciation: e.target.value } })} /></td>
                          <td><Input disabled={!council} className="min-h-10" placeholder="Ex. Admis en classe supérieure" value={entries[s.id]?.councilDecision ?? ''} onChange={(e) => setEntries({ ...entries, [s.id]: { ...entries[s.id], councilDecision: e.target.value } })} /></td>
                        </>
                      )}
                    </tr>
                  ))}</tbody>
                </Table>
                {council && (
                  <Button className="mt-3" loading={busy} onClick={async () => {
                    await run(() => api.put(`/report-cards/runs/${classId}/${termId}/council`, { entries: Object.entries(entries).map(([studentId, e]) => ({ studentId, appreciation: e.appreciation || undefined, councilDecision: e.councilDecision || undefined })) }), toast, 'Décisions du conseil enregistrées');
                  }}>Enregistrer les décisions</Button>
                )}
              </Card>
              {r.history.length > 0 && (
                <Card>
                  <h2 className="mb-2 text-xl font-bold">Historique</h2>
                  <ul className="grid gap-1 text-sm">{[...r.history].reverse().map((h, i) => <li key={i}><span className="text-muted">{dateTime(h.at)}</span> · {h.by} · {h.action}</li>)}</ul>
                </Card>
              )}
              <p className="text-sm text-muted">Étape actuelle : <StatusBadge status={r.status} />. La validation fige les bulletins et verrouille les notes ; seule la direction valide et publie.</p>
              <Dialog open={reopen} onOpenChange={setReopen}>
                <DialogContent title="Rouvrir la saisie des notes" description="Les bulletins non publiés sont supprimés et les enseignants peuvent corriger leurs notes.">
                  <form className="grid gap-3" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.post(`/report-cards/runs/${classId}/${termId}/reopen`, { reason }), toast, 'Saisie rouverte')) { setReopen(false); q.reload(); } }}>
                    <Field label="Motif"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} required /></Field>
                    <Button type="submit" variant="danger" loading={busy}>Rouvrir</Button>
                  </form>
                </DialogContent>
              </Dialog>
            </>
          );
        }}
      </Loader>
    </>
  );
}
