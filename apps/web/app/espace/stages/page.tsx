'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ArrowLeft, Plus } from 'lucide-react';
import { Loader, Section } from '@/components/espace/bits';
import { Badge, Button, Card, Chips, Dialog, DialogContent, Empty, Field, Input, PageHeader, Select, Table, Textarea, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import type { ClassRow } from '@/lib/types';
import { useAction, useApi } from '@/lib/use-api';

type Ref = { levels: { id: string; name: string }[]; tracks: { id: string; name: string }[]; sites: { id: string; name: string }[]; rooms: { id: string; name: string; siteId: string; kind: string; capacity: number | null }[]; subjects: { id: string; name: string; practical: boolean }[] };
type Period = { id: string; label: string; levelId: string | null; trackId: string | null; startDate: string; endDate: string; notes: string | null; placed?: number; done?: number };
type Status = 'PLANNED' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';
type Placement = { id: string; company: string; companyAddress: string | null; companyPhone: string | null; tutorName: string | null; tutorPhone: string | null; status: Status; notes: string | null };
type Row = { id: string; matricule: string; firstName: string; lastName: string; class: { name: string; site: { name: string } }; placement: Placement | null };

const STATUS: Record<Status, { label: string; tone: 'brand' | 'warn' | 'good' | undefined }> = {
  PLANNED: { label: 'Prévu', tone: 'brand' },
  IN_PROGRESS: { label: 'En cours', tone: 'warn' },
  DONE: { label: 'Terminé', tone: 'good' },
  CANCELLED: { label: 'Annulé', tone: undefined },
};

export default function Stages() {
  const ref = useApi<Ref>('/settings');
  const [tab, setTab] = useState<'stages' | 'ateliers'>('stages');
  return (
    <>
      <PageHeader title="Stages et ateliers" subtitle="Périodes de stage en entreprise par niveau et filière, placement des élèves, et organisation des travaux pratiques d’atelier." />
      <Chips label="Rubrique" value={tab} onChange={setTab} options={[{ value: 'stages', label: 'Stages en entreprise' }, { value: 'ateliers', label: 'Travaux d’atelier' }]} />
      <Loader {...ref}>{(r) => (tab === 'stages' ? <Periods r={r} /> : <Workshops r={r} />)}</Loader>
    </>
  );
}

function Periods({ r }: { r: Ref }) {
  const q = useApi<Period[]>('/internships/periods');
  const [edit, setEdit] = useState<Partial<Period> | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const name = (p: Period) => [r.levels.find((l) => l.id === p.levelId)?.name, r.tracks.find((t) => t.id === p.trackId)?.name].filter(Boolean).join(' · ') || 'Tous les élèves';
  if (open) return <PeriodDetail id={open} back={() => { setOpen(null); q.reload(); }} onEdit={(p) => setEdit(p)} scope={name} />;
  return (
    <>
      <div><Button onClick={() => setEdit({ label: '', levelId: null, trackId: null, startDate: '', endDate: '', notes: '' })}><Plus className="size-4" /> Nouvelle période de stage</Button></div>
      <Loader {...q}>
        {(rows) => rows.length === 0 ? (
          <Empty title="Aucune période de stage">Créez une période pour chaque stage organisé par l’école (dates, niveau et filière concernés), puis placez les élèves.</Empty>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {rows.map((p) => (
              <Card key={p.id} className="grid gap-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-display text-lg font-bold">{p.label}</p>
                    <p className="text-sm text-muted">{name(p)} · du {date(p.startDate)} au {date(p.endDate)}</p>
                  </div>
                  <Badge tone="brand">{p.placed} placé{(p.placed ?? 0) > 1 ? 's' : ''}</Badge>
                </div>
                {p.notes && <p className="whitespace-pre-line text-sm">{p.notes}</p>}
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => setOpen(p.id)}>Élèves et entreprises</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEdit(p)}>Modifier</Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </Loader>
      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        {edit && <PeriodDialog edit={edit} setEdit={setEdit} r={r} done={() => { setEdit(null); q.reload(); }} />}
      </Dialog>
    </>
  );
}

function PeriodDialog({ edit, setEdit, r, done }: { edit: Partial<Period>; setEdit: (p: Partial<Period>) => void; r: Ref; done: () => void }) {
  const toast = useToast();
  const { busy, run } = useAction();
  return (
    <DialogContent title={edit.id ? 'Modifier la période de stage' : 'Nouvelle période de stage'}>
      <form className="grid gap-3" onSubmit={async (e) => {
        e.preventDefault();
        const body = { label: edit.label, levelId: edit.levelId || null, trackId: edit.trackId || null, startDate: edit.startDate?.slice(0, 10), endDate: edit.endDate?.slice(0, 10), notes: edit.notes || null };
        if (await run(() => (edit.id ? api.patch(`/internships/periods/${edit.id}`, body) : api.post('/internships/periods', body)), toast, 'Période enregistrée')) done();
      }}>
        <Field label="Intitulé"><Input value={edit.label ?? ''} onChange={(e) => setEdit({ ...edit, label: e.target.value })} required placeholder="Ex. Stage de fin d’année" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Niveau"><Select value={edit.levelId ?? ''} onChange={(e) => setEdit({ ...edit, levelId: e.target.value || null })}><option value="">Tous</option>{r.levels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>
          <Field label="Filière"><Select value={edit.trackId ?? ''} onChange={(e) => setEdit({ ...edit, trackId: e.target.value || null })}><option value="">Toutes</option>{r.tracks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
          <Field label="Début"><Input type="date" value={edit.startDate?.slice(0, 10) ?? ''} onChange={(e) => setEdit({ ...edit, startDate: e.target.value })} required /></Field>
          <Field label="Fin"><Input type="date" value={edit.endDate?.slice(0, 10) ?? ''} onChange={(e) => setEdit({ ...edit, endDate: e.target.value })} required /></Field>
        </div>
        <Field label="Organisation (facultatif)" hint="Objectifs, documents à fournir, modalités d’évaluation… tels que décidés par l’école.">
          <Textarea rows={4} value={edit.notes ?? ''} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} maxLength={2000} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={busy}>Enregistrer</Button>
          {edit.id && <Button type="button" variant="ghost" loading={busy} onClick={async () => { if (await run(() => api.del(`/internships/periods/${edit.id}`), toast, 'Période supprimée')) done(); }}>Supprimer</Button>}
        </div>
      </form>
    </DialogContent>
  );
}

function PeriodDetail({ id, back, onEdit, scope }: { id: string; back: () => void; onEdit: (p: Period) => void; scope: (p: Period) => string }) {
  const q = useApi<{ period: Period; students: Row[] }>(`/internships/periods/${id}`);
  const [place, setPlace] = useState<{ student: Row; f: Partial<Placement> } | null>(null);
  const [filter, setFilter] = useState<'tous' | 'sans'>('tous');
  return (
    <Loader {...q}>
      {({ period, students }) => {
        const rows = filter === 'sans' ? students.filter((s) => !s.placement || s.placement.status === 'CANCELLED') : students;
        const placed = students.filter((s) => s.placement && s.placement.status !== 'CANCELLED').length;
        return (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" size="sm" onClick={back}><ArrowLeft className="size-4" /> Toutes les périodes</Button>
              <Button variant="ghost" size="sm" onClick={() => onEdit(period)}>Modifier la période</Button>
            </div>
            <Card className="grid gap-1">
              <p className="font-display text-xl font-bold">{period.label}</p>
              <p className="text-sm text-muted">{scope(period)} · du {date(period.startDate)} au {date(period.endDate)} · {placed} élève{placed > 1 ? 's' : ''} placé{placed > 1 ? 's' : ''} sur {students.length}</p>
              {period.notes && <p className="mt-1 whitespace-pre-line text-sm">{period.notes}</p>}
            </Card>
            <Chips label="Filtre" value={filter} onChange={setFilter} options={[{ value: 'tous', label: 'Tous les élèves' }, { value: 'sans', label: 'Sans entreprise' }]} />
            <Card>
              {rows.length === 0 ? <Empty title="Aucun élève">Aucun élève inscrit ne correspond à ce niveau et à cette filière.</Empty> : (
                <Table>
                  <thead><tr><th>Élève</th><th>Classe</th><th>Entreprise</th><th>Tuteur</th><th>État</th><th /></tr></thead>
                  <tbody>{rows.map((s) => (
                    <tr key={s.id}>
                      <td><b>{s.lastName} {s.firstName}</b><span className="block font-mono text-xs text-muted">{s.matricule}</span></td>
                      <td>{s.class.name}<span className="block text-xs text-muted">{s.class.site.name}</span></td>
                      <td>{s.placement ? <>{s.placement.company}{s.placement.companyPhone && <span className="block text-xs text-muted">{s.placement.companyPhone}</span>}</> : '—'}</td>
                      <td>{s.placement?.tutorName ?? '—'}{s.placement?.tutorPhone && <span className="block text-xs text-muted">{s.placement.tutorPhone}</span>}</td>
                      <td>{s.placement ? <Badge tone={STATUS[s.placement.status].tone}>{STATUS[s.placement.status].label}</Badge> : <Badge>À placer</Badge>}</td>
                      <td className="text-right"><Button size="sm" variant={s.placement ? 'ghost' : 'outline'} onClick={() => setPlace({ student: s, f: s.placement ?? { company: '', status: 'PLANNED' } })}>{s.placement ? 'Modifier' : 'Placer'}</Button></td>
                    </tr>
                  ))}</tbody>
                </Table>
              )}
            </Card>
            <Dialog open={!!place} onOpenChange={(o) => !o && setPlace(null)}>
              {place && <PlacementDialog periodId={period.id} place={place} setPlace={setPlace} done={() => { setPlace(null); q.reload(); }} />}
            </Dialog>
          </>
        );
      }}
    </Loader>
  );
}

function PlacementDialog({ periodId, place, setPlace, done }: { periodId: string; place: { student: Row; f: Partial<Placement> }; setPlace: (p: { student: Row; f: Partial<Placement> }) => void; done: () => void }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const { student, f } = place;
  const set = (k: keyof Placement) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setPlace({ student, f: { ...f, [k]: e.target.value } });
  return (
    <DialogContent title={`Stage de ${student.firstName} ${student.lastName}`} description={student.class.name}>
      <form className="grid gap-3" onSubmit={async (e) => {
        e.preventDefault();
        const body = { studentId: student.id, company: f.company, companyAddress: f.companyAddress || null, companyPhone: f.companyPhone || null, tutorName: f.tutorName || null, tutorPhone: f.tutorPhone || null, status: f.status, notes: f.notes || null };
        if (await run(() => api.put(`/internships/periods/${periodId}/placements`, body), toast, 'Stage enregistré')) done();
      }}>
        <Field label="Entreprise d’accueil"><Input value={f.company ?? ''} onChange={set('company')} required maxLength={160} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Adresse"><Input value={f.companyAddress ?? ''} onChange={set('companyAddress')} maxLength={300} /></Field>
          <Field label="Téléphone de l’entreprise"><Input value={f.companyPhone ?? ''} onChange={set('companyPhone')} maxLength={40} /></Field>
          <Field label="Tuteur en entreprise"><Input value={f.tutorName ?? ''} onChange={set('tutorName')} maxLength={120} /></Field>
          <Field label="Téléphone du tuteur"><Input value={f.tutorPhone ?? ''} onChange={set('tutorPhone')} maxLength={40} /></Field>
        </div>
        <Field label="État"><Select value={f.status ?? 'PLANNED'} onChange={set('status')}>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</Select></Field>
        <Field label="Remarques"><Textarea rows={3} value={f.notes ?? ''} onChange={set('notes')} maxLength={2000} /></Field>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={busy}>Enregistrer</Button>
          {f.id && <Button type="button" variant="ghost" loading={busy} onClick={async () => { if (await run(() => api.del(`/internships/placements/${f.id}`), toast, 'Placement retiré')) done(); }}>Retirer le placement</Button>}
        </div>
      </form>
    </DialogContent>
  );
}

const DAYS = ['', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
const hm = (m: number) => `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;

function Workshops({ r }: { r: Ref }) {
  const classes = useApi<ClassRow[]>('/classes');
  const workshops = r.rooms.filter((x) => x.kind === 'WORKSHOP' || x.kind === 'LAB');
  const practical = r.subjects.filter((s) => s.practical);
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted">Les ateliers sont des salles de type « Atelier » ou « Laboratoire », et les travaux pratiques des matières cochées « Travaux pratiques d’atelier ». Les séances se placent dans l’<Link href="/espace/emploi-du-temps" className="font-bold text-brand underline">emploi du temps</Link>, qui vérifie qu’un atelier n’est pas occupé deux fois. Pour ajouter ou modifier un atelier ou une matière : <Link href="/espace/parametres" className="font-bold text-brand underline">Paramètres</Link>, rubrique « Sites, salles, matières ».</p>
      <Section title="Matières de travaux pratiques">
        {practical.length === 0 ? <Empty title="Aucune matière de travaux pratiques">Cochez « Travaux pratiques d’atelier » sur les matières concernées dans Paramètres.</Empty> : (
          <Loader {...classes}>
            {(cls) => (
              <ul className="grid gap-1.5">{practical.map((s) => {
                const where = cls.filter((c) => c.subjects.some((x) => x.subject.id === s.id));
                return <li key={s.id} className="rounded-lg bg-sunk px-3 py-2"><b>{s.name}</b><span className="block text-sm text-muted">{where.length ? where.map((c) => c.name).join(', ') : 'Enseignée dans aucune classe pour l’instant'}</span></li>;
              })}</ul>
            )}
          </Loader>
        )}
      </Section>
      {workshops.length === 0 ? <Empty title="Aucun atelier enregistré">Indiquez le type « Atelier » sur les salles concernées dans Paramètres.</Empty> : (
        <div className="grid gap-4 lg:grid-cols-2">{workshops.map((w) => <WorkshopCard key={w.id} w={w} site={r.sites.find((s) => s.id === w.siteId)?.name} />)}</div>
      )}
    </div>
  );
}

function WorkshopCard({ w, site }: { w: Ref['rooms'][number]; site?: string }) {
  const q = useApi<{ slots: { id: string; dayOfWeek: number; startMinute: number; endMinute: number; subject: { name: string }; class: { name: string }; teachers: { lastName: string }[] }[] }>(`/timetable?roomId=${w.id}`);
  return (
    <Section title={`${w.name}${site ? ` · ${site}` : ''}`} action={w.capacity ? <Badge>{w.capacity} places</Badge> : undefined}>
      <Loader {...q}>
        {({ slots }) => slots.length === 0 ? <p className="text-sm text-muted">Aucune séance prévue cette semaine.</p> : (
          <ul className="grid gap-1.5">{[...slots].sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startMinute - b.startMinute).map((s) => (
            <li key={s.id} className="grid grid-cols-[110px_1fr] gap-2 rounded-lg bg-sunk px-3 py-2 text-sm">
              <span className="font-bold">{DAYS[s.dayOfWeek]} {hm(s.startMinute)}–{hm(s.endMinute)}</span>
              <span>{s.class.name} · {s.subject.name}{s.teachers.length ? ` · ${s.teachers.map((t) => t.lastName).join(', ')}` : ''}</span>
            </li>
          ))}</ul>
        )}
      </Loader>
    </Section>
  );
}
