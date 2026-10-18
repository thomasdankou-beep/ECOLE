'use client';

import { useEffect, useState } from 'react';
import { Eye, Lock, Plus, Save } from 'lucide-react';
import { Loader } from '@/components/espace/bits';
import { Badge, Button, Card, Chips, Dialog, DialogContent, DialogTrigger, Empty, Field, Input, PageHeader, Select, Table, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { date, note, today } from '@/lib/format';
import type { Term } from '@/lib/types';
import { useAction, useApi } from '@/lib/use-api';

type CS = { id: string; coefficient: number; subject: { name: string }; class: { id: string; name: string; site: { name: string } } };
type Assessment = { id: string; title: string; kind: string; weight: number; maxScore: number; date: string; published: boolean; stats: { mean: number | null; min: number | null; max: number | null } };
type Book = {
  classSubject: { subject: string; className: string; coefficient: number }; locked: boolean; runStatus: string;
  assessments: Assessment[];
  students: { id: string; firstName: string; lastName: string; grades: Record<string, { score: number | null; absent: boolean; exempt: boolean }>; average: number | null; appreciation: string }[];
  stats: { mean: number | null; min: number | null; max: number | null };
};
const KIND: Record<string, string> = { INTERROGATION: 'Interrogation', DEVOIR: 'Devoir', COMPOSITION: 'Composition' };

export default function Notes() {
  const base = useApi<{ classSubjects: CS[]; terms: Term[] }>('/evaluation/class-subjects');
  const [cs, setCs] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    if (!base.data) return;
    if (!cs && base.data.classSubjects[0]) setCs(base.data.classSubjects[0].id);
    if (!term) {
      const now = today();
      setTerm((base.data.terms.find((t) => t.startDate.slice(0, 10) <= now && t.endDate.slice(0, 10) >= now) ?? base.data.terms[0])?.id ?? '');
    }
  }, [base.data, cs, term]);

  return (
    <>
      <PageHeader title="Saisie des notes" subtitle="Notes sur 20 ou sur le barème de l’évaluation. Les familles voient une note une fois publiée." />
      <Loader {...base}>
        {(b) => b.classSubjects.length === 0 ? <Empty title="Aucune matière ne vous est attribuée">La direction affecte les enseignants aux classes dans les paramètres.</Empty> : (
          <>
            <Card className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <Field label="Classe et matière">
                <Select value={cs} onChange={(e) => setCs(e.target.value)}>{b.classSubjects.map((c) => <option key={c.id} value={c.id}>{c.class.name} · {c.subject.name} (coef. {note(c.coefficient)})</option>)}</Select>
              </Field>
              <div className="grid gap-1.5"><span className="text-[13px] font-bold text-muted">Période</span><Chips label="Période" value={term} onChange={setTerm} options={b.terms.map((t) => ({ value: t.id, label: t.name }))} /></div>
            </Card>
            {cs && term && <Gradebook key={`${cs}-${term}`} cs={cs} term={term} />}
          </>
        )}
      </Loader>
    </>
  );
}

function Gradebook({ cs, term }: { cs: string; term: string }) {
  const q = useApi<Book>(`/evaluation/gradebook?classSubjectId=${cs}&termId=${term}`);
  const toast = useToast();
  const { busy, run } = useAction();
  const [draft, setDraft] = useState<Record<string, Record<string, string>>>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [appr, setAppr] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!q.data) return;
    const d: Record<string, Record<string, string>> = {};
    for (const a of q.data.assessments) {
      d[a.id] = {};
      for (const s of q.data.students) {
        const g = s.grades[a.id];
        d[a.id][s.id] = !g ? '' : g.absent ? 'abs' : g.exempt ? 'disp' : g.score === null ? '' : String(g.score).replace('.', ',');
      }
    }
    setDraft(d);
    setDirty(new Set());
    setAppr(Object.fromEntries(q.data.students.map((s) => [s.id, s.appreciation ?? ''])));
  }, [q.data]);

  async function saveAll(book: Book) {
    for (const a of book.assessments.filter((x) => dirty.has(x.id))) {
      const grades = book.students.map((s) => {
        const v = (draft[a.id]?.[s.id] ?? '').trim().toLowerCase();
        if (v === 'abs') return { studentId: s.id, score: null, absent: true };
        if (v === 'disp') return { studentId: s.id, score: null, exempt: true };
        if (v === '') return { studentId: s.id, score: null };
        return { studentId: s.id, score: Number(v.replace(',', '.')) };
      });
      const bad = grades.find((g) => g.score !== null && (Number.isNaN(g.score) || g.score < 0 || g.score > a.maxScore));
      if (bad) return toast(`Note invalide dans « ${a.title} » : entre 0 et ${a.maxScore}, ou abs, ou disp.`, 'bad');
      const ok = await run(() => api.put(`/evaluation/assessments/${a.id}/grades`, { grades }), toast);
      if (!ok) return;
    }
    toast('Notes enregistrées');
    q.reload();
  }

  return (
    <Loader {...q}>
      {(b) => (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {b.locked ? <Badge tone="warn"><Lock className="size-3" /> Notes verrouillées (bulletins en cours de validation)</Badge> : <NewAssessment cs={cs} term={term} onDone={q.reload} />}
            <span className="text-sm text-muted">Moyenne de la classe : <b>{note(b.stats.mean)}</b> · min {note(b.stats.min)} · max {note(b.stats.max)}</span>
          </div>
          {b.assessments.length === 0 ? <Empty title="Aucune évaluation pour cette période">Créez une interrogation, un devoir ou une composition pour saisir les notes.</Empty> : (
            <Card>
              <Table>
                <thead>
                  <tr>
                    <th>Élève</th>
                    {b.assessments.map((a) => (
                      <th key={a.id} className="min-w-28">
                        <span className="block normal-case tracking-normal text-ink">{a.title}</span>
                        <span className="block font-semibold normal-case tracking-normal">{KIND[a.kind]} · /{a.maxScore} · ×{note(a.weight)} · {date(a.date, { day: 'numeric', month: 'short' })}</span>
                        {a.published ? <Badge tone="good">Publiée</Badge> : !b.locked && <button type="button" className="cursor-pointer text-xs font-bold text-brand underline" onClick={async () => { if (await run(() => api.post(`/evaluation/assessments/${a.id}/publish`), toast, 'Notes publiées aux familles')) q.reload(); }}><Eye className="inline size-3" /> Publier</button>}
                      </th>
                    ))}
                    <th className="text-right">Moyenne</th>
                    <th className="min-w-56">Appréciation</th>
                  </tr>
                </thead>
                <tbody>
                  {b.students.map((s) => (
                    <tr key={s.id}>
                      <td className="whitespace-nowrap font-bold">{s.lastName} {s.firstName}</td>
                      {b.assessments.map((a) => (
                        <td key={a.id}>
                          <Input
                            inputMode="decimal"
                            disabled={b.locked}
                            aria-label={`${a.title}, ${s.firstName}`}
                            className="min-h-10 w-20 text-center tabular"
                            value={draft[a.id]?.[s.id] ?? ''}
                            onChange={(e) => { setDraft((d) => ({ ...d, [a.id]: { ...d[a.id], [s.id]: e.target.value } })); setDirty((x) => new Set(x).add(a.id)); }}
                          />
                        </td>
                      ))}
                      <td className={`text-right font-bold ${s.average !== null && s.average < 10 ? 'text-bad' : ''}`}>{note(s.average)}</td>
                      <td>
                        <Input
                          disabled={b.locked}
                          value={appr[s.id] ?? ''}
                          placeholder="Ex. Bon trimestre, continuez"
                          onChange={(e) => setAppr((x) => ({ ...x, [s.id]: e.target.value }))}
                          onBlur={async (e) => {
                            if ((e.target.value ?? '') === (s.appreciation ?? '')) return;
                            await run(() => api.put('/evaluation/appreciations', { studentId: s.id, classSubjectId: cs, termId: term, text: e.target.value }), toast, 'Appréciation enregistrée');
                          }}
                          className="min-h-10"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <p className="mt-3 text-sm text-muted">Tapez « abs » pour une absence à l’évaluation, « disp » pour un élève dispensé. Les virgules sont acceptées.</p>
            </Card>
          )}
          {!b.locked && dirty.size > 0 && (
            <div className="sticky bottom-20 z-10 flex items-center gap-3 rounded-xl border border-line bg-surface p-3 shadow-lg lg:bottom-4">
              <p className="flex-1 font-bold">Modifications non enregistrées</p>
              <Button size="lg" loading={busy} onClick={() => saveAll(b)}><Save className="size-4" /> Enregistrer</Button>
            </div>
          )}
        </>
      )}
    </Loader>
  );
}

function NewAssessment({ cs, term, onDone }: { cs: string; term: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ title: '', kind: 'INTERROGATION', weight: '1', maxScore: '20', date: today() });
  const toast = useToast();
  const { busy, run } = useAction();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus className="size-4" /> Nouvelle évaluation</Button></DialogTrigger>
      <DialogContent title="Nouvelle évaluation">
        <form className="grid gap-3" onSubmit={async (e) => {
          e.preventDefault();
          if (await run(() => api.post('/evaluation/assessments', { classSubjectId: cs, termId: term, title: f.title, kind: f.kind, weight: Number(f.weight), maxScore: Number(f.maxScore), date: f.date }), toast, 'Évaluation créée')) { setOpen(false); onDone(); }
        }}>
          <Field label="Intitulé"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Ex. Interrogation 3" required /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
            <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} required /></Field>
            <Field label="Barème (noté sur)"><Input type="number" min={1} max={100} value={f.maxScore} onChange={(e) => setF({ ...f, maxScore: e.target.value })} /></Field>
            <Field label="Poids dans la moyenne" hint="1 = normal, 2 = compte double"><Input type="number" min={0.25} max={10} step={0.25} value={f.weight} onChange={(e) => setF({ ...f, weight: e.target.value })} /></Field>
          </div>
          <Button type="submit" loading={busy}>Créer</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
