'use client';

import { useState } from 'react';
import { Loader } from '@/components/espace/bits';
import { Card, Chips, Empty, PageHeader } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { date, note } from '@/lib/format';
import { useApi } from '@/lib/use-api';
import { cn } from '@/lib/utils';

export default function Resultats() {
  const { child } = useAuth();
  const [term, setTerm] = useState('');
  const q = useApi<any>(`/evaluation/students/${child!.id}${term ? `?termId=${term}` : ''}`);
  return (
    <>
      <PageHeader title="Notes" subtitle={`${child!.firstName} · notes publiées par les enseignants`} />
      <Loader {...q}>
        {(g) => (
          <>
            <Chips label="Période" value={term || g.term?.id || ''} onChange={setTerm} options={g.terms.map((t: any) => ({ value: t.id, label: t.name }))} />
            <Card className="flex flex-wrap items-end gap-6">
              <div><p className="text-sm font-bold uppercase tracking-wider text-muted">Moyenne générale</p><p className="tabular font-display text-5xl font-bold">{note(g.average)}<span className="text-xl text-muted"> / 20</span></p></div>
              <div><p className="text-sm font-bold uppercase tracking-wider text-muted">Moyenne de la classe</p><p className="tabular font-display text-3xl font-bold text-muted">{note(g.classAverage)}</p></div>
            </Card>
            {g.subjects.length === 0 ? <Empty title="Pas encore de notes publiées" /> : (
              <div className="grid gap-3 md:grid-cols-2">
                {g.subjects.map((s: any) => (
                  <Card key={s.classSubjectId} className="grid gap-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="text-lg font-bold">{s.subject} <span className="text-sm font-semibold text-muted">coef. {note(s.coefficient)}</span></p>
                      <p className={cn('tabular font-display text-3xl font-bold', s.average !== null && s.average < 10 && 'text-bad')}>{note(s.average)}</p>
                    </div>
                    <p className="text-sm text-muted">Moyenne de la classe : {note(s.classAverage)}</p>
                    <ul className="grid gap-1">
                      {s.assessments.map((a: any) => (
                        <li key={a.id} className="flex justify-between gap-2 rounded-lg bg-sunk px-3 py-1.5 text-sm">
                          <span>{a.title} <span className="text-muted">· {date(a.date, { day: 'numeric', month: 'short' })}</span></span>
                          <b className="tabular">{a.absent ? 'Absent' : a.score === null ? '—' : `${note(a.score)} / ${a.maxScore}`}</b>
                        </li>
                      ))}
                    </ul>
                  </Card>
                ))}
              </div>
            )}
          </>
        )}
      </Loader>
    </>
  );
}
