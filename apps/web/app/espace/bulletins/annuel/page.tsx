'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowLeft, Printer } from 'lucide-react';
import { Loader } from '@/components/espace/bits';
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, PageHeader, Select, Stat, Table, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { date, note } from '@/lib/format';
import type { Term } from '@/lib/types';
import { useAction, useApi } from '@/lib/use-api';

type Outcome = 'ADMIS' | 'NON_ADMIS';
type Annual = {
  class: { id: string; name: string; site: string };
  year: { label: string; startDate: string; endDate: string };
  passMark: number | null;
  terms: { id: string; name: string; weight: number; classAverage: number | null }[];
  classStats: { mean: number | null; min: number | null; max: number | null };
  students: { id: string; name: string; matricule: string; terms: Record<string, number | null>; average: number | null; rank: number | null; complete: boolean; distinction: string | null; proposed: Outcome | null; outcome: Outcome | null; note: string; final: Outcome | null }[];
  summary: { admis: number; nonAdmis: number; undecided: number; total: number };
};
const LABEL: Record<Outcome, string> = { ADMIS: 'Admis', NON_ADMIS: 'Non admis' };

export default function ResultatsAnnuels() {
  const settings = useApi<{ currentYear: { terms: Term[] } | null }>('/settings');
  const last = settings.data?.currentYear?.terms.at(-1);
  const classes = useApi<{ classId: string; className: string; site: string }[]>(last ? `/report-cards/runs?termId=${last.id}` : null);
  const [classId, setClassId] = useState('');
  useEffect(() => { if (!classId && classes.data?.length) setClassId(classes.data[0].classId); }, [classes.data, classId]);
  return (
    <>
      <Link href="/espace/bulletins" className="inline-flex items-center gap-1 text-sm font-bold text-brand print:hidden"><ArrowLeft className="size-4" /> Bulletins</Link>
      <PageHeader title="Résultats de fin d’année" subtitle="Moyenne générale annuelle de chaque élève, rang, mention et décision de passage." actions={<Button variant="outline" onClick={() => window.print()} className="print:hidden"><Printer className="size-4" /> Imprimer le tableau</Button>} />
      <ErrorNote error={settings.error ?? classes.error} />
      {classes.data && classes.data.length === 0 && <Empty title="Aucune classe">Seuls le professeur principal et la direction voient les résultats d’une classe.</Empty>}
      {classes.data && classes.data.length > 0 && (
        <Field label="Classe" className="max-w-xs print:hidden">
          <Select value={classId} onChange={(e) => setClassId(e.target.value)}>{classes.data.map((c) => <option key={c.classId} value={c.classId}>{c.className} · {c.site}</option>)}</Select>
        </Field>
      )}
      {classId && <ClassResults key={classId} classId={classId} />}
    </>
  );
}

function ClassResults({ classId }: { classId: string }) {
  const { role } = useAuth();
  const q = useApi<Annual>(`/report-cards/annual/${classId}`);
  const toast = useToast();
  const { busy, run } = useAction();
  const [draft, setDraft] = useState<Record<string, { outcome: Outcome | null; note: string }>>({});
  useEffect(() => { if (q.data) setDraft(Object.fromEntries(q.data.students.map((s) => [s.id, { outcome: s.outcome, note: s.note }]))); }, [q.data]);
  const direction = role === 'DIRECTION';
  return (
    <Loader {...q}>
      {(a) => (
        <div className="grid gap-4">
          <p className="text-sm text-muted">Année {a.year.label} · rentrée le {date(a.year.startDate)}, fin d’année le {date(a.year.endDate)} · moyenne annuelle = {a.terms.map((t) => `${t.name} × ${note(t.weight)}`).join(' + ')}, divisé par {note(a.terms.reduce((x, t) => x + t.weight, 0))}.</p>
          {a.passMark === null && (
            <p className="rounded-xl bg-warn-soft p-4 text-sm font-bold text-warn print:hidden">Aucun seuil de passage saisi : aucune décision n’est proposée automatiquement. La direction peut le renseigner dans Paramètres › Mentions et règles, ou arrêter chaque décision ci-dessous.</p>
          )}
          <div className="flex flex-wrap gap-2 print:hidden">
            <Button asChild><Link href={`/espace/bulletins/annuel/imprimer?classId=${classId}`}><Printer className="size-4" /> Bulletins annuels de la classe</Link></Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Moyenne de la classe" value={note(a.classStats.mean)} detail={`de ${note(a.classStats.min)} à ${note(a.classStats.max)}`} />
            <Stat label="Admis" value={a.summary.admis} detail={a.summary.total ? `${Math.round((a.summary.admis / a.summary.total) * 100)} % de la classe` : undefined} tone="good" />
            <Stat label="Non admis" value={a.summary.nonAdmis} tone="bad" />
            <Stat label="Sans décision" value={a.summary.undecided} detail={a.passMark !== null ? `Seuil de passage : ${note(a.passMark)} / 20` : undefined} />
          </div>
          <Card>
            {a.students.length === 0 ? <Empty title="Aucun élève inscrit dans cette classe" /> : (
              <Table>
                <thead><tr><th>Élève</th>{a.terms.map((t) => <th key={t.id} className="text-right">{t.name}</th>)}<th className="text-right">Moyenne annuelle</th><th className="text-right">Rang</th><th>Mention</th><th>Proposé</th><th>Décision</th></tr></thead>
                <tbody>{a.students.map((s) => {
                  const d = draft[s.id] ?? { outcome: s.outcome, note: s.note };
                  const final = d.outcome ?? s.proposed;
                  return (
                    <tr key={s.id}>
                      <td><b>{s.name}</b><span className="block text-xs text-muted">{s.matricule}</span><Link className="text-xs font-bold text-brand hover:underline print:hidden" href={`/espace/bulletins/annuel/imprimer?classId=${classId}&ids=${s.id}`}>Bulletin annuel</Link></td>
                      {a.terms.map((t) => <td key={t.id} className="tabular text-right">{note(s.terms[t.id])}</td>)}
                      <td className="tabular text-right font-bold">{note(s.average)}{s.average !== null && !s.complete && <span className="block text-xs font-normal text-muted">provisoire</span>}</td>
                      <td className="text-right">{s.rank ?? '—'}</td>
                      <td className="text-sm">{s.distinction ?? '—'}</td>
                      <td className="text-sm">{s.proposed ? LABEL[s.proposed] : '—'}</td>
                      <td>
                        {direction ? (
                          <div className="grid gap-1 print:hidden">
                            <Select aria-label={`Décision pour ${s.name}`} className="min-h-9 min-w-52 text-sm" value={d.outcome ?? ''} onChange={(e) => setDraft({ ...draft, [s.id]: { ...d, outcome: (e.target.value || null) as Outcome | null } })}>
                              <option value="">{s.proposed ? `Selon la moyenne (${LABEL[s.proposed]})` : 'À décider'}</option>
                              <option value="ADMIS">Admis</option>
                              <option value="NON_ADMIS">Non admis</option>
                            </Select>
                            {d.outcome && <Input aria-label={`Motif pour ${s.name}`} className="min-h-9 text-sm" placeholder="Motif (facultatif)" value={d.note} maxLength={200} onChange={(e) => setDraft({ ...draft, [s.id]: { ...d, note: e.target.value } })} />}
                          </div>
                        ) : null}
                        <span className={direction ? 'hidden print:inline' : ''}>{final ? <Badge tone={final === 'ADMIS' ? 'good' : 'bad'}>{LABEL[final]}</Badge> : '—'}</span>
                      </td>
                    </tr>
                  );
                })}</tbody>
              </Table>
            )}
          </Card>
          {direction && a.students.length > 0 && (
            <Button className="justify-self-start print:hidden" loading={busy} onClick={async () => {
              if (await run(() => api.put(`/report-cards/annual/${classId}`, { entries: a.students.map((s) => ({ studentId: s.id, outcome: draft[s.id]?.outcome ?? null, note: draft[s.id]?.note || undefined })) }), toast, 'Décisions enregistrées')) q.reload();
            }}>Enregistrer les décisions</Button>
          )}
        </div>
      )}
    </Loader>
  );
}
