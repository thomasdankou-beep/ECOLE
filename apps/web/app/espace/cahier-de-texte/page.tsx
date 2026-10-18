'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Loader } from '@/components/espace/bits';
import { Button, Card, Empty, Field, Input, PageHeader, Select, Textarea, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { date, today } from '@/lib/format';
import { useAction, useApi } from '@/lib/use-api';

type CS = { id: string; subject: { name: string }; class: { id: string; name: string } };

export default function CahierDeTexte() {
  const p = useSearchParams();
  const base = useApi<{ classSubjects: CS[] }>('/evaluation/class-subjects');
  const [cs, setCs] = useState(p.get('cs') ?? '');
  const list = useApi<any[]>(cs ? `/lessons?classSubjectId=${cs}` : null);
  const empty = { title: '', content: '', homework: '', homeworkDue: '' };
  const [f, setF] = useState({ ...empty, date: p.get('date') ?? today() });
  const [editing, setEditing] = useState<string | null>(null);
  const toast = useToast();
  const { busy, run } = useAction();

  useEffect(() => {
    if (!cs && base.data?.classSubjects[0]) setCs(base.data.classSubjects[0].id);
  }, [base.data, cs]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body = { title: f.title, content: f.content, homework: f.homework || undefined, homeworkDue: f.homeworkDue || undefined };
    const ok = editing
      ? await run(() => api.patch(`/lessons/${editing}`, body), toast, 'Séance modifiée')
      : await run(() => api.post('/lessons', { ...body, classSubjectId: cs, date: f.date }), toast, 'Séance enregistrée, visible par les élèves et les parents');
    if (ok) { setF({ ...empty, date: today() }); setEditing(null); list.reload(); }
  }

  return (
    <>
      <PageHeader title="Cahier de texte" subtitle="Contenu des séances et devoirs à faire, visibles par les élèves et les parents." />
      <Loader {...base}>
        {(b) => (
          <Card className="grid gap-3">
            <Field label="Classe et matière"><Select value={cs} onChange={(e) => setCs(e.target.value)}>{b.classSubjects.map((c) => <option key={c.id} value={c.id}>{c.class.name} · {c.subject.name}</option>)}</Select></Field>
          </Card>
        )}
      </Loader>
      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <Card>
          <form onSubmit={submit} className="grid gap-3">
            <h2 className="text-2xl font-bold">{editing ? 'Modifier la séance' : 'Nouvelle séance'}</h2>
            <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
              <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} disabled={!!editing} required /></Field>
              <Field label="Titre"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required maxLength={160} /></Field>
            </div>
            <Field label="Contenu de la séance"><Textarea value={f.content} onChange={(e) => setF({ ...f, content: e.target.value })} required maxLength={4000} /></Field>
            <Field label="Travail à faire (facultatif)"><Textarea value={f.homework} onChange={(e) => setF({ ...f, homework: e.target.value })} maxLength={1000} className="min-h-16" /></Field>
            <Field label="Pour le"><Input type="date" value={f.homeworkDue} onChange={(e) => setF({ ...f, homeworkDue: e.target.value })} /></Field>
            <div className="flex gap-2">
              <Button type="submit" loading={busy} disabled={!cs}>{editing ? 'Enregistrer' : 'Ajouter'}</Button>
              {editing && <Button type="button" variant="outline" onClick={() => { setEditing(null); setF({ ...empty, date: today() }); }}>Annuler</Button>}
            </div>
          </form>
        </Card>
        <Card>
          <h2 className="mb-3 text-2xl font-bold">Séances</h2>
          <Loader {...list}>
            {(rows) => rows.length === 0 ? <Empty title="Aucune séance" /> : (
              <ul className="grid gap-2">{rows.map((l) => (
                <li key={l.id} className="rounded-lg bg-sunk p-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-bold">{date(l.date, { weekday: 'short', day: 'numeric', month: 'short' })} · {l.title}</p>
                    <button type="button" className="cursor-pointer text-sm font-bold text-brand" onClick={() => { setEditing(l.id); setF({ date: l.date.slice(0, 10), title: l.title, content: l.content, homework: l.homework ?? '', homeworkDue: l.homeworkDue?.slice(0, 10) ?? '' }); }}>Modifier</button>
                  </div>
                  <p className="whitespace-pre-line text-sm">{l.content}</p>
                  {l.homework && <p className="mt-1 text-sm"><b>À faire{l.homeworkDue ? ` pour le ${date(l.homeworkDue, { day: 'numeric', month: 'short' })}` : ''} :</b> {l.homework}</p>}
                </li>
              ))}</ul>
            )}
          </Loader>
        </Card>
      </div>
    </>
  );
}
