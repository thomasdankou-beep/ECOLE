'use client';

import { Loader } from '@/components/espace/bits';
import { Card, Empty, PageHeader } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { date, today } from '@/lib/format';
import { useApi } from '@/lib/use-api';

export default function Devoirs() {
  const { child } = useAuth();
  const q = useApi<any[]>(`/lessons/homework/${child!.id}`);
  return (
    <>
      <PageHeader title="Devoirs et cahier de texte" subtitle={`${child!.firstName} · ${child!.className ?? ''}`} />
      <Loader {...q}>
        {(rows) => rows.length === 0 ? <Empty title="Rien pour le moment" /> : (
          <div className="grid gap-3">
            {rows.map((l) => {
              const late = l.homeworkDue && l.homeworkDue.slice(0, 10) < today();
              return (
                <Card key={l.id} className={late ? 'opacity-70' : ''}>
                  <p className="text-sm font-bold uppercase tracking-wider text-orange">{l.classSubject.subject.name}</p>
                  <p className="text-lg font-bold">{l.title}</p>
                  <p className="text-sm text-muted">Séance du {date(l.date, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
                  <p className="mt-1 whitespace-pre-line">{l.content}</p>
                  {l.homework && <p className="mt-2 rounded-lg bg-brand-soft px-3 py-2"><b>À faire{l.homeworkDue ? ` pour le ${date(l.homeworkDue, { weekday: 'long', day: 'numeric', month: 'long' })}` : ''} :</b> {l.homework}</p>}
                </Card>
              );
            })}
          </div>
        )}
      </Loader>
    </>
  );
}
