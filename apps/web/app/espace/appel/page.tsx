'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Check, Clock, X } from 'lucide-react';
import { Loader } from '@/components/espace/bits';
import { Button, Card, Empty, Field, Input, PageHeader, Select, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { date, hhmm, today } from '@/lib/format';
import type { ClassRow } from '@/lib/types';
import { qs, useAction, useApi } from '@/lib/use-api';
import { cn } from '@/lib/utils';

type Status = 'PRESENT' | 'ABSENT' | 'LATE';
type Sheet = { takenAt: string | null; students: { id: string; firstName: string; lastName: string; matricule: string; status: Status; minutesLate: number | null }[] };

export default function Appel() {
  const p = useSearchParams();
  const classId = p.get('classId');
  const day = p.get('date') ?? today();
  const start = p.get('start');
  return classId && start ? <RollCall classId={classId} day={day} start={Number(start)} cs={p.get('cs')} /> : <Pick day={day} />;
}

/** Choix du cours : la classe et le créneau de l'emploi du temps du jour. */
function Pick({ day }: { day: string }) {
  const router = useRouter();
  const { role } = useAuth();
  const [d, setD] = useState(day);
  const [classId, setClassId] = useState('');
  const mine = useApi<any[]>(role === 'ENSEIGNANT' ? `/attendance/my-courses?date=${d}` : null);
  const classes = useApi<ClassRow[]>(role !== 'ENSEIGNANT' ? '/classes' : null);
  const tt = useApi<{ slots: any[] }>(classId ? `/timetable?classId=${classId}&week=${d}` : null);
  const dow = new Date(`${d}T00:00:00Z`).getUTCDay() || 7;
  const go = (c: string, start: number, cs?: string) => router.push(`/espace/appel${qs({ classId: c, date: d, start, cs })}`);

  return (
    <>
      <PageHeader title="Faire l’appel" subtitle="Choisissez le cours. Les parents des absents sont prévenus automatiquement." />
      <Card className="grid gap-3 sm:grid-cols-2">
        <Field label="Jour"><Input type="date" value={d} onChange={(e) => setD(e.target.value || today())} /></Field>
        {role !== 'ENSEIGNANT' && (
          <Field label="Classe"><Select value={classId} onChange={(e) => setClassId(e.target.value)}><option value="">Choisir</option>{classes.data?.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.site.name}</option>)}</Select></Field>
        )}
      </Card>
      {role === 'ENSEIGNANT' ? (
        <Loader {...mine}>
          {(rows) => rows.length === 0 ? <Empty title="Aucun cours ce jour-là" /> : (
            <div className="grid gap-2">{rows.map((c) => (
              <button key={c.slotId} type="button" disabled={c.cancelled} onClick={() => go(c.classId, c.startMinute, c.classSubjectId)} className="flex min-h-16 cursor-pointer items-center gap-3 rounded-xl border border-line bg-surface p-4 text-left hover:border-brand disabled:opacity-50">
                <span className="tabular w-16 font-display text-xl font-bold">{hhmm(c.startMinute)}</span>
                <span className="flex-1 font-bold">{c.subject} · {c.className}</span>
                <span className="text-sm text-muted">{c.cancelled ? 'Annulé' : c.taken ? 'Appel fait' : 'À faire'}</span>
              </button>
            ))}</div>
          )}
        </Loader>
      ) : classId ? (
        <Loader {...tt}>
          {({ slots }) => {
            const todays = slots.filter((s) => s.dayOfWeek === dow);
            return todays.length === 0 ? (
              <Empty title="Pas de cours prévu ce jour-là" action={<Button variant="outline" onClick={() => go(classId, 480)}>Appel hors emploi du temps (8 h)</Button>} />
            ) : (
              <div className="grid gap-2">{todays.map((s) => (
                <button key={s.id} type="button" onClick={() => go(classId, s.startMinute, s.classSubjectId)} className="flex min-h-16 cursor-pointer items-center gap-3 rounded-xl border border-line bg-surface p-4 text-left hover:border-brand">
                  <span className="tabular w-16 font-display text-xl font-bold">{hhmm(s.startMinute)}</span>
                  <span className="flex-1 font-bold">{s.subject.name}</span>
                </button>
              ))}</div>
            );
          }}
        </Loader>
      ) : null}
    </>
  );
}

function RollCall({ classId, day, start, cs }: { classId: string; day: string; start: number; cs: string | null }) {
  const q = useApi<Sheet>(`/attendance/sheet?classId=${classId}&date=${day}&startMinute=${start}`);
  const [marks, setMarks] = useState<Record<string, { status: Status; minutesLate?: number }>>({});
  const toast = useToast();
  const router = useRouter();
  const { busy, run } = useAction();

  useEffect(() => {
    if (q.data) setMarks(Object.fromEntries(q.data.students.map((s) => [s.id, { status: s.status, minutesLate: s.minutesLate ?? undefined }])));
  }, [q.data]);

  const counts = useMemo(() => {
    const v = Object.values(marks);
    return { ABSENT: v.filter((m) => m.status === 'ABSENT').length, LATE: v.filter((m) => m.status === 'LATE').length };
  }, [marks]);

  const set = (id: string, status: Status) => setMarks((m) => ({ ...m, [id]: { status, minutesLate: status === 'LATE' ? m[id]?.minutesLate ?? 10 : undefined } }));

  async function save() {
    const records = Object.entries(marks).map(([studentId, m]) => ({ studentId, status: m.status, ...(m.status === 'LATE' ? { minutesLate: m.minutesLate ?? 10 } : {}) }));
    const r = await run(() => api.post('/attendance', { classId, classSubjectId: cs ?? undefined, date: day, startMinute: start, records }), toast, counts.ABSENT ? `Appel enregistré. ${counts.ABSENT} famille(s) prévenue(s).` : 'Appel enregistré, tout le monde est présent.');
    if (r) router.push('/espace');
  }

  return (
    <>
      <PageHeader title="Feuille d’appel" subtitle={`${date(day, { weekday: 'long', day: 'numeric', month: 'long' })} à ${hhmm(start)}`} />
      <Loader {...q}>
        {(sheet) => (
          <>
            {sheet.takenAt && <p className="rounded-xl bg-good-soft px-4 py-3 font-bold text-good">Appel déjà fait. Vous pouvez le corriger.</p>}
            <p className="text-sm text-muted">Tout le monde est présent par défaut : touchez seulement les absents et les retards.</p>
            <div className="grid gap-2">
              {sheet.students.map((s) => {
                const m = marks[s.id]?.status ?? 'PRESENT';
                return (
                  <Card key={s.id} className="flex flex-wrap items-center gap-2 p-3 sm:p-3">
                    <p className="min-w-0 flex-1 font-bold">{s.lastName} {s.firstName}</p>
                    <div className="flex gap-1.5" role="group" aria-label={`Présence de ${s.firstName}`}>
                      {([['PRESENT', 'Présent', Check, 'bg-good'], ['ABSENT', 'Absent', X, 'bg-bad'], ['LATE', 'Retard', Clock, 'bg-warn']] as const).map(([v, l, I, bg]) => (
                        <button key={v} type="button" aria-pressed={m === v} onClick={() => set(s.id, v)} className={cn('flex min-h-11 cursor-pointer items-center gap-1 rounded-lg border border-line px-3 text-sm font-bold', m === v && `${bg} border-transparent text-white`)}>
                          <I className="size-4" /> {l}
                        </button>
                      ))}
                    </div>
                    {m === 'LATE' && (
                      <label className="flex items-center gap-1 text-sm">
                        <Input type="number" min={1} max={240} className="w-20" value={marks[s.id]?.minutesLate ?? 10} onChange={(e) => setMarks((x) => ({ ...x, [s.id]: { status: 'LATE', minutesLate: Number(e.target.value) } }))} aria-label="Minutes de retard" /> min
                      </label>
                    )}
                  </Card>
                );
              })}
            </div>
            <div className="sticky bottom-20 z-10 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-3 shadow-lg lg:bottom-4">
              <p className="flex-1 font-bold">{sheet.students.length - counts.ABSENT} présent(s) · {counts.ABSENT} absent(s) · {counts.LATE} retard(s)</p>
              <Button size="lg" onClick={save} loading={busy}>Valider l’appel</Button>
            </div>
          </>
        )}
      </Loader>
    </>
  );
}
