'use client';

import { useEffect, useState } from 'react';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import { Loader, Section } from '@/components/espace/bits';
import { Badge, Button, Card, Chips, Dialog, DialogContent, Empty, Field, Input, PageHeader, Select, Table, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { date, note } from '@/lib/format';
import type { ClassRow } from '@/lib/types';
import { useAction, useApi } from '@/lib/use-api';
import { useAuth } from '@/lib/auth';
import type { SchoolIdentity } from '@/components/print/letterhead';
import { Coefficients } from './coefficients';
import { Etablissement, type IdentitySettings } from './etablissement';
import { ImageEcole, type PublicTexts } from './image';

type Settings = {
  tenant: { name: string; shortName: string | null; identity: SchoolIdentity; settings: { public?: PublicTexts; branding: { primaryColor: string | null }; grading: { distinctions: { min: number; label: string }[]; missingGrade: 'exclude' | 'zero' }; blockReportCardIfUnpaid: boolean; notifications: { absenceSms: boolean }; identity: IdentitySettings } };
  currentYear: { id: string; label: string; startDate: string; endDate: string; terms: { id: string; name: string; startDate: string; endDate: string; weight: string }[] } | null;
  years: { id: string; label: string; isCurrent: boolean }[];
  sites: { id: string; name: string; address: string | null; phone: string | null; active: boolean }[];
  levels: { id: string; name: string; cycle: string; position: number }[];
  tracks: { id: string; code: string; name: string; cycle: string }[];
  rooms: { id: string; name: string; siteId: string; kind: RoomKind; capacity: number | null }[];
  subjects: { id: string; code: string; name: string; practical: boolean }[];
};
type RoomKind = 'CLASSROOM' | 'WORKSHOP' | 'LAB' | 'OTHER';
const ROOM_KINDS: Record<RoomKind, string> = { CLASSROOM: 'Salle de classe', WORKSHOP: 'Atelier', LAB: 'Laboratoire', OTHER: 'Autre' };
const CYCLES: Record<string, string> = { COLLEGE: 'Collège', LYCEE_GENERAL: 'Lycée général', LYCEE_TECHNIQUE: 'Lycée technique', PRIMAIRE: 'Primaire', MATERNELLE: 'Maternelle' };

export default function Parametres() {
  const q = useApi<Settings>('/settings');
  const [tab, setTab] = useState('etablissement');
  useEffect(() => {
    const r = new URLSearchParams(window.location.search).get('rubrique');
    if (r) setTab(r);
  }, []);
  return (
    <>
      <PageHeader title="Paramètres" subtitle="Tout ce que l’école renseigne elle-même : identité officielle, logo et site public, classes, matières et coefficients, salles et ateliers, année, règles des bulletins." />
      <Chips label="Rubrique" value={tab} onChange={setTab} options={[
        { value: 'etablissement', label: 'Établissement' }, { value: 'image', label: 'Logo et site public' }, { value: 'classes', label: 'Classes et matières' }, { value: 'coefficients', label: 'Coefficients' },
        { value: 'structure', label: 'Sites, salles, matières' }, { value: 'annee', label: 'Année et périodes' }, { value: 'regles', label: 'Mentions et règles' },
      ]} />
      <Loader {...q}>
        {(s) => (
          <>
            {tab === 'etablissement' && <Etablissement settings={s.tenant.settings.identity} identity={s.tenant.identity} reload={q.reload} />}
            {tab === 'image' && <ImageEcole name={s.tenant.name} shortName={s.tenant.shortName} logoUrl={s.tenant.identity.logoUrl} primaryColor={s.tenant.settings.branding.primaryColor} texts={s.tenant.settings.public ?? {}} reload={q.reload} />}
            {tab === 'classes' && <Classes s={s} />}
            {tab === 'coefficients' && <Coefficients subjects={s.subjects} />}
            {tab === 'structure' && <Structure s={s} reload={q.reload} />}
            {tab === 'annee' && <Year s={s} reload={q.reload} />}
            {tab === 'regles' && <Rules s={s} reload={q.reload} />}
          </>
        )}
      </Loader>
    </>
  );
}

function Classes({ s }: { s: Settings }) {
  const classes = useApi<ClassRow[]>('/classes');
  const staff = useApi<{ id: string; firstName: string; lastName: string; roles: { role: string }[] }[]>('/staff');
  const teachers = staff.data?.filter((u) => u.roles.some((r) => r.role === 'ENSEIGNANT')) ?? [];
  const [edit, setEdit] = useState<any | null>(null);
  const [open, setOpen] = useState<ClassRow | null>(null);
  const toast = useToast();
  const { busy, run } = useAction();
  useEffect(() => {
    if (open && classes.data) setOpen(classes.data.find((c) => c.id === open.id) ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classes.data]);

  return (
    <>
      <div><Button onClick={() => setEdit({ name: '', siteId: s.sites.find((x) => x.active)?.id, levelId: s.levels[0]?.id, trackId: '', capacity: 40, headTeacherId: '' })}><Plus className="size-4" /> Nouvelle classe</Button></div>
      <Card>
        <Loader {...classes}>
          {(rows) => rows.length === 0 ? <Empty title="Aucune classe" /> : (
            <Table>
              <thead><tr><th>Classe</th><th>Site</th><th>Filière</th><th>Effectif</th><th>Prof. principal</th><th>Matières</th><th /></tr></thead>
              <tbody>{rows.map((c) => (
                <tr key={c.id}>
                  <td className="font-bold">{c.name}</td>
                  <td>{c.site.name}</td>
                  <td>{c.track?.name ?? '—'}</td>
                  <td>{c.studentCount}{c.capacity ? ` / ${c.capacity}` : ''}</td>
                  <td>{c.headTeacher ? `${c.headTeacher.firstName} ${c.headTeacher.lastName}` : '—'}</td>
                  <td>{c.subjects.length}</td>
                  <td className="whitespace-nowrap text-right">
                    <Button size="sm" variant="ghost" onClick={() => setOpen(c)}>Matières et enseignants</Button>
                    <Button size="sm" variant="ghost" onClick={() => setEdit({ id: c.id, name: c.name, siteId: c.siteId, levelId: c.levelId, trackId: c.trackId ?? '', capacity: c.capacity ?? '', headTeacherId: c.headTeacherId ?? '' })}>Modifier</Button>
                  </td>
                </tr>
              ))}</tbody>
            </Table>
          )}
        </Loader>
      </Card>
      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        {edit && (
          <DialogContent title={edit.id ? 'Modifier la classe' : 'Nouvelle classe'}>
            <form className="grid gap-3" onSubmit={async (e) => {
              e.preventDefault();
              const body = { name: edit.name, siteId: edit.siteId, levelId: edit.levelId, trackId: edit.trackId || null, capacity: edit.capacity ? Number(edit.capacity) : null, headTeacherId: edit.headTeacherId || null };
              if (await run(() => (edit.id ? api.patch(`/classes/${edit.id}`, body) : api.post('/classes', body)), toast, 'Classe enregistrée')) { setEdit(null); classes.reload(); }
            }}>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Nom"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required placeholder="Ex. 2e année F4" /></Field>
                <Field label="Capacité"><Input type="number" min={1} value={edit.capacity} onChange={(e) => setEdit({ ...edit, capacity: e.target.value })} /></Field>
                <Field label="Site"><Select value={edit.siteId} onChange={(e) => setEdit({ ...edit, siteId: e.target.value })}>{s.sites.filter((x) => x.active || x.id === edit.siteId).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
                <Field label="Niveau"><Select value={edit.levelId} onChange={(e) => setEdit({ ...edit, levelId: e.target.value })}>{s.levels.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
                <Field label="Filière"><Select value={edit.trackId} onChange={(e) => setEdit({ ...edit, trackId: e.target.value })}><option value="">Aucune</option>{s.tracks.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
                <Field label="Professeur principal"><Select value={edit.headTeacherId} onChange={(e) => setEdit({ ...edit, headTeacherId: e.target.value })}><option value="">Aucun</option>{teachers.map((t) => <option key={t.id} value={t.id}>{t.lastName} {t.firstName}</option>)}</Select></Field>
              </div>
              <Button type="submit" loading={busy}>Enregistrer</Button>
            </form>
          </DialogContent>
        )}
      </Dialog>
      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        {open && <ClassSubjects klass={open} subjects={s.subjects} teachers={teachers} onChange={classes.reload} />}
      </Dialog>
    </>
  );
}

function ClassSubjects({ klass, subjects, teachers, onChange }: { klass: ClassRow; subjects: Settings['subjects']; teachers: { id: string; firstName: string; lastName: string }[]; onChange: () => void }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const [add, setAdd] = useState({ subjectId: '', coefficient: '1' });
  const free = subjects.filter((x) => !klass.subjects.some((cs) => cs.subject.id === x.id));
  return (
    <DialogContent title={`Matières · ${klass.name}`} description="Coefficients et enseignants. Modifier un coefficient recalcule les moyennes non validées." className="max-w-2xl">
      <div className="grid gap-2">
        {klass.subjects.map((cs) => (
          <div key={cs.id} className="grid gap-2 rounded-lg bg-sunk p-3 sm:grid-cols-[1fr_90px_1fr_auto] sm:items-center">
            <p className="font-bold">{cs.subject.name}</p>
            <Input aria-label="Coefficient" type="number" min={0} max={20} step={0.5} defaultValue={Number(cs.coefficient)} className="min-h-10" onBlur={async (e) => { if (Number(e.target.value) !== Number(cs.coefficient)) { if (await run(() => api.put(`/classes/${klass.id}/subjects`, { subjectId: cs.subject.id, coefficient: Number(e.target.value) }), toast, 'Coefficient enregistré')) onChange(); } }} />
            <div className="flex flex-wrap items-center gap-1">
              {cs.assignments.map((a) => (
                <Badge key={a.id} tone="brand">{a.teacher.lastName}<button type="button" aria-label={`Retirer ${a.teacher.lastName}`} className="cursor-pointer" onClick={async () => { if (await run(() => api.del(`/assignments/${a.id}`), toast, 'Enseignant retiré')) onChange(); }}><X className="size-3" /></button></Badge>
              ))}
              <Select aria-label="Affecter un enseignant" className="min-h-9 w-40 text-sm" value="" onChange={async (e) => { if (e.target.value && (await run(() => api.post('/assignments', { teacherId: e.target.value, classSubjectId: cs.id }), toast, 'Enseignant affecté'))) onChange(); }}>
                <option value="">+ Enseignant</option>
                {teachers.filter((t) => !cs.assignments.some((a) => a.teacher.id === t.id)).map((t) => <option key={t.id} value={t.id}>{t.lastName} {t.firstName}</option>)}
              </Select>
            </div>
            <Button variant="ghost" size="icon" aria-label="Retirer la matière" loading={busy} onClick={async () => { if (await run(() => api.del(`/class-subjects/${cs.id}`), toast, 'Matière retirée')) onChange(); }}><Trash2 className="size-4" /></Button>
          </div>
        ))}
      </div>
      {free.length > 0 && (
        <form className="mt-4 flex flex-wrap items-end gap-2" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.put(`/classes/${klass.id}/subjects`, { subjectId: add.subjectId, coefficient: Number(add.coefficient) }), toast, 'Matière ajoutée')) { setAdd({ subjectId: '', coefficient: '1' }); onChange(); } }}>
          <Field label="Ajouter une matière" className="min-w-48 flex-1"><Select value={add.subjectId} onChange={(e) => setAdd({ ...add, subjectId: e.target.value })} required><option value="">Choisir</option>{free.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
          <Field label="Coefficient" className="w-28"><Input type="number" min={0} max={20} step={0.5} value={add.coefficient} onChange={(e) => setAdd({ ...add, coefficient: e.target.value })} /></Field>
          <Button type="submit" loading={busy}><Plus className="size-4" /> Ajouter</Button>
        </form>
      )}
    </DialogContent>
  );
}

type RefEdit =
  | { kind: 'site'; id: string; name: string; address: string; phone: string; active: boolean }
  | { kind: 'level'; id: string; name: string; cycle: string; position: number }
  | { kind: 'track'; id: string; code: string; name: string; cycle: string }
  | { kind: 'room'; id: string; name: string; siteId: string; roomKind: RoomKind; capacity: number | string | null }
  | { kind: 'subject'; id: string; code: string; name: string; practical: boolean };

function Structure({ s, reload }: { s: Settings; reload: () => void }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const [site, setSite] = useState({ name: '', address: '', phone: '' });
  const [level, setLevel] = useState({ name: '', cycle: 'COLLEGE', position: String(s.levels.length + 1) });
  const [track, setTrack] = useState({ code: '', name: '', cycle: 'LYCEE_TECHNIQUE' });
  const [room, setRoom] = useState({ name: '', siteId: s.sites[0]?.id ?? '', kind: 'CLASSROOM' as RoomKind, capacity: '' });
  const [subject, setSubject] = useState({ code: '', name: '', practical: false });
  const [edit, setEdit] = useState<RefEdit | null>(null);
  const post = async (path: string, body: object, ok: string, reset: () => void) => { if (await run(() => api.post(path, body), toast, ok)) { reset(); reload(); } };
  const editBtn = (label: string, e: RefEdit) => <button type="button" className="ml-1 inline-flex cursor-pointer items-center opacity-70 hover:opacity-100" aria-label={`Modifier ${label}`} onClick={() => setEdit(e)}><Pencil className="size-3" /></button>;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Section title="Sites">
        <p className="mb-2 text-sm text-muted">Les sites actifs sont affichés sur la page d’accueil publique de l’école.</p>
        <ul className="mb-3 grid gap-1.5">{s.sites.map((x) => (
          <li key={x.id} className="flex items-start justify-between gap-2 rounded-lg bg-sunk px-3 py-2">
            <span><b>{x.name}</b>{!x.active && <Badge className="ml-2">Inactif</Badge>}<span className="block text-sm text-muted">{x.address}{x.phone ? ` · ${x.phone}` : ''}</span></span>
            <Button size="sm" variant="ghost" onClick={() => setEdit({ kind: 'site', id: x.id, name: x.name, address: x.address ?? '', phone: x.phone ?? '', active: x.active })}>Modifier</Button>
          </li>
        ))}</ul>
        <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); post('/sites', { name: site.name, address: site.address || undefined, phone: site.phone || undefined }, 'Site ajouté', () => setSite({ name: '', address: '', phone: '' })); }}>
          <div className="grid grid-cols-2 gap-2"><Input placeholder="Nom du site" value={site.name} onChange={(e) => setSite({ ...site, name: e.target.value })} required /><Input placeholder="Téléphone" value={site.phone} onChange={(e) => setSite({ ...site, phone: e.target.value })} /></div>
          <Input placeholder="Adresse" value={site.address} onChange={(e) => setSite({ ...site, address: e.target.value })} />
          <Button type="submit" variant="outline" loading={busy}><Plus className="size-4" /> Ajouter un site</Button>
        </form>
      </Section>
      <Section title="Salles et ateliers">
        {s.sites.map((site) => (
          <div key={site.id} className="mb-3">
            <p className="mb-1 text-[13px] font-bold text-muted">{site.name}</p>
            <div className="flex flex-wrap gap-1.5">{s.rooms.filter((x) => x.siteId === site.id).map((x) => (
              <Badge key={x.id} tone={x.kind === 'CLASSROOM' ? undefined : 'accent'}>{x.name}{x.kind !== 'CLASSROOM' ? ` · ${ROOM_KINDS[x.kind]}` : ''}{x.capacity ? ` · ${x.capacity} pl.` : ''}{editBtn(x.name, { kind: 'room', id: x.id, name: x.name, siteId: x.siteId, roomKind: x.kind, capacity: x.capacity })}</Badge>
            ))}</div>
          </div>
        ))}
        <form className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_1fr_1fr_80px_auto]" onSubmit={(e) => { e.preventDefault(); post('/rooms', { name: room.name, siteId: room.siteId, kind: room.kind, capacity: room.capacity ? Number(room.capacity) : null }, 'Salle ajoutée', () => setRoom({ ...room, name: '', capacity: '' })); }}>
          <Input placeholder="Ex. Atelier 3" value={room.name} onChange={(e) => setRoom({ ...room, name: e.target.value })} required aria-label="Nom de la salle" />
          <Select value={room.siteId} onChange={(e) => setRoom({ ...room, siteId: e.target.value })} aria-label="Site">{s.sites.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
          <Select value={room.kind} onChange={(e) => setRoom({ ...room, kind: e.target.value as RoomKind })} aria-label="Type">{Object.entries(ROOM_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
          <Input type="number" min={1} placeholder="Places" value={room.capacity} onChange={(e) => setRoom({ ...room, capacity: e.target.value })} aria-label="Capacité" />
          <Button type="submit" variant="outline" size="icon" aria-label="Ajouter la salle"><Plus className="size-4" /></Button>
        </form>
      </Section>
      <Section title="Niveaux">
        <div className="mb-3 flex flex-wrap gap-1.5">{s.levels.map((x) => <Badge key={x.id} tone="brand">{x.name} · {CYCLES[x.cycle]}{editBtn(x.name, { kind: 'level', id: x.id, name: x.name, cycle: x.cycle, position: x.position })}</Badge>)}</div>
        <form className="grid grid-cols-[1fr_1fr_70px_auto] gap-2" onSubmit={(e) => { e.preventDefault(); post('/levels', { name: level.name, cycle: level.cycle, position: Number(level.position) }, 'Niveau ajouté', () => setLevel({ ...level, name: '', position: String(Number(level.position) + 1) })); }}>
          <Input placeholder="Ex. 3e année" value={level.name} onChange={(e) => setLevel({ ...level, name: e.target.value })} required aria-label="Nom du niveau" />
          <Select value={level.cycle} onChange={(e) => setLevel({ ...level, cycle: e.target.value })} aria-label="Cycle">{Object.entries(CYCLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
          <Input type="number" value={level.position} onChange={(e) => setLevel({ ...level, position: e.target.value })} aria-label="Ordre" />
          <Button type="submit" variant="outline" size="icon" aria-label="Ajouter le niveau"><Plus className="size-4" /></Button>
        </form>
      </Section>
      <Section title="Filières">
        <div className="mb-3 flex flex-wrap gap-1.5">{s.tracks.map((x) => <Badge key={x.id} tone="accent">{x.name}{editBtn(x.name, { kind: 'track', id: x.id, code: x.code, name: x.name, cycle: x.cycle })}</Badge>)}</div>
        <form className="grid grid-cols-[90px_1fr_auto] gap-2" onSubmit={(e) => { e.preventDefault(); post('/tracks', track, 'Filière ajoutée', () => setTrack({ ...track, code: '', name: '' })); }}>
          <Input placeholder="Code" value={track.code} onChange={(e) => setTrack({ ...track, code: e.target.value })} required aria-label="Code" />
          <Input placeholder="Nom de la filière" value={track.name} onChange={(e) => setTrack({ ...track, name: e.target.value })} required aria-label="Nom" />
          <Button type="submit" variant="outline" size="icon" aria-label="Ajouter la filière"><Plus className="size-4" /></Button>
        </form>
      </Section>
      <Section title="Matières" className="lg:col-span-2">
        <div className="mb-3 flex flex-wrap gap-1.5">{s.subjects.map((x) => <Badge key={x.id} tone={x.practical ? 'accent' : 'brand'}>{x.name}{x.practical ? ' · TP atelier' : ''}{editBtn(x.name, { kind: 'subject', id: x.id, code: x.code, name: x.name, practical: x.practical })}</Badge>)}</div>
        <form className="grid grid-cols-[90px_1fr_auto] items-center gap-2 sm:max-w-2xl sm:grid-cols-[90px_1fr_auto_auto]" onSubmit={(e) => { e.preventDefault(); post('/subjects', subject, 'Matière ajoutée', () => setSubject({ code: '', name: '', practical: false })); }}>
          <Input placeholder="Code" value={subject.code} onChange={(e) => setSubject({ ...subject, code: e.target.value })} required aria-label="Code" />
          <Input placeholder="Ex. Technologie" value={subject.name} onChange={(e) => setSubject({ ...subject, name: e.target.value })} required aria-label="Nom" />
          <label className="col-span-2 flex min-h-11 items-center gap-2 text-sm font-bold sm:col-span-1"><input type="checkbox" className="size-5" checked={subject.practical} onChange={(e) => setSubject({ ...subject, practical: e.target.checked })} /> Travaux pratiques d’atelier</label>
          <Button type="submit" variant="outline" size="icon" aria-label="Ajouter la matière"><Plus className="size-4" /></Button>
        </form>
      </Section>
      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        {edit && <RefDialog edit={edit} setEdit={setEdit} sites={s.sites} done={() => { setEdit(null); reload(); }} />}
      </Dialog>
    </div>
  );
}

function RefDialog({ edit, setEdit, sites, done }: { edit: RefEdit; setEdit: (e: RefEdit) => void; sites: Settings['sites']; done: () => void }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const titles = { site: 'Modifier le site', level: 'Modifier le niveau', track: 'Modifier la filière', room: 'Modifier la salle', subject: 'Modifier la matière' };
  const save = async () => {
    const body =
      edit.kind === 'site' ? { name: edit.name, address: edit.address || undefined, phone: edit.phone || undefined, active: edit.active }
      : edit.kind === 'level' ? { name: edit.name, cycle: edit.cycle, position: Number(edit.position) }
      : edit.kind === 'track' ? { code: edit.code, name: edit.name, cycle: edit.cycle }
      : edit.kind === 'room' ? { name: edit.name, siteId: edit.siteId, kind: edit.roomKind, capacity: edit.capacity ? Number(edit.capacity) : null }
      : { code: edit.code, name: edit.name, practical: edit.practical };
    if (await run(() => api.patch(`/${edit.kind === 'site' ? 'sites' : edit.kind === 'level' ? 'levels' : edit.kind === 'track' ? 'tracks' : edit.kind === 'room' ? 'rooms' : 'subjects'}/${edit.id}`, body), toast, 'Modification enregistrée')) done();
  };
  return (
    <DialogContent title={titles[edit.kind]}>
      <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {'code' in edit && <Field label="Code"><Input value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value })} required /></Field>}
        <Field label="Nom"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required /></Field>
        {edit.kind === 'site' && (
          <>
            <Field label="Adresse"><Input value={edit.address} onChange={(e) => setEdit({ ...edit, address: e.target.value })} maxLength={300} /></Field>
            <Field label="Téléphone"><Input value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} maxLength={40} /></Field>
            <label className="flex min-h-11 items-center gap-3 font-bold"><input type="checkbox" className="size-5" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Site actif</label>
            {!edit.active && <p className="text-sm text-muted">Un site inactif n’apparaît plus sur la page d’accueil ni dans le choix du site d’une nouvelle classe. Ses classes, salles et élèves sont conservés.</p>}
          </>
        )}
        {(edit.kind === 'level' || edit.kind === 'track') && (
          <Field label="Cycle"><Select value={edit.cycle} onChange={(e) => setEdit({ ...edit, cycle: e.target.value })}>{Object.entries(CYCLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
        )}
        {edit.kind === 'level' && <Field label="Ordre d’affichage"><Input type="number" value={edit.position} onChange={(e) => setEdit({ ...edit, position: Number(e.target.value) })} /></Field>}
        {edit.kind === 'room' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Site"><Select value={edit.siteId} onChange={(e) => setEdit({ ...edit, siteId: e.target.value })}>{sites.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
            <Field label="Type"><Select value={edit.roomKind} onChange={(e) => setEdit({ ...edit, roomKind: e.target.value as RoomKind })}>{Object.entries(ROOM_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
            <Field label="Nombre de places"><Input type="number" min={1} value={edit.capacity ?? ''} onChange={(e) => setEdit({ ...edit, capacity: e.target.value })} /></Field>
          </div>
        )}
        {edit.kind === 'subject' && <label className="flex min-h-11 items-center gap-3 font-bold"><input type="checkbox" className="size-5" checked={edit.practical} onChange={(e) => setEdit({ ...edit, practical: e.target.checked })} /> Travaux pratiques d’atelier</label>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={busy}>Enregistrer</Button>
          {edit.kind === 'room' && <Button type="button" variant="ghost" loading={busy} onClick={async () => { if (await run(() => api.del(`/rooms/${edit.id}`), toast, 'Salle supprimée')) done(); }}><Trash2 className="size-4" /> Supprimer la salle</Button>}
        </div>
      </form>
    </DialogContent>
  );
}

function Year({ s, reload: reloadSettings }: { s: Settings; reload: () => void }) {
  const auth = useAuth();
  // L'année en cours figure aussi dans l'en-tête de l'espace : on la relit après chaque changement.
  const reload = () => { reloadSettings(); auth.reload(); };
  const toast = useToast();
  const { busy, run } = useAction();
  const [f, setF] = useState({ label: '', startDate: '', endDate: '', terms: [{ name: 'Trimestre 1', startDate: '', endDate: '' }, { name: 'Trimestre 2', startDate: '', endDate: '' }, { name: 'Trimestre 3', startDate: '', endDate: '' }] });
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Section title={`Année en cours${s.currentYear ? ` · ${s.currentYear.label}` : ''}`}>
        {s.currentYear ? (
          <>
            <p className="mb-2 text-sm text-muted">Du {date(s.currentYear.startDate)} au {date(s.currentYear.endDate)}</p>
            <ul className="grid gap-1.5">{s.currentYear.terms.map((t) => <li key={t.id} className="flex justify-between rounded-lg bg-sunk px-3 py-2"><b>{t.name}</b><span className="text-sm">{date(t.startDate)} → {date(t.endDate)} · poids {note(t.weight)}</span></li>)}</ul>
          </>
        ) : <Empty title="Aucune année en cours" />}
        {s.years.filter((y) => !y.isCurrent).length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">{s.years.filter((y) => !y.isCurrent).map((y) => <Button key={y.id} size="sm" variant="outline" loading={busy} onClick={async () => { if (await run(() => api.post(`/academic-years/${y.id}/current`), toast, `${y.label} devient l’année en cours`)) reload(); }}>Passer à {y.label}</Button>)}</div>
        )}
      </Section>
      <Section title="Préparer une nouvelle année">
        <form className="grid gap-2" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.post('/academic-years', { ...f, isCurrent: false }), toast, 'Année créée')) reload(); }}>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Libellé"><Input placeholder="2027-2028" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} required /></Field>
            <Field label="Début"><Input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} required /></Field>
            <Field label="Fin"><Input type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} required /></Field>
          </div>
          {f.terms.map((t, i) => (
            <div key={i} className="grid grid-cols-3 gap-2">
              <Input aria-label="Période" value={t.name} onChange={(e) => setF({ ...f, terms: f.terms.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} required />
              <Input aria-label="Début" type="date" value={t.startDate} onChange={(e) => setF({ ...f, terms: f.terms.map((x, j) => (j === i ? { ...x, startDate: e.target.value } : x)) })} required />
              <Input aria-label="Fin" type="date" value={t.endDate} onChange={(e) => setF({ ...f, terms: f.terms.map((x, j) => (j === i ? { ...x, endDate: e.target.value } : x)) })} required />
            </div>
          ))}
          <Button type="submit" variant="outline" loading={busy}>Créer l’année</Button>
        </form>
      </Section>
    </div>
  );
}

function Rules({ s, reload }: { s: Settings; reload: () => void }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const [r, setR] = useState(s.tenant.settings);
  return (
    <Card className="grid gap-4 lg:max-w-2xl">
      <Field label="Note manquante dans une moyenne" hint="Règle à confirmer par l’école (CDC §3.3).">
        <Select value={r.grading.missingGrade} onChange={(e) => setR({ ...r, grading: { ...r.grading, missingGrade: e.target.value as 'exclude' | 'zero' } })}>
          <option value="exclude">Ignorée (non comptée)</option>
          <option value="zero">Comptée 0</option>
        </Select>
      </Field>
      <div className="grid gap-2">
        <p className="text-[13px] font-bold text-muted">Mentions au bulletin (moyenne minimale)</p>
        <p className="text-xs text-muted">Les seuils proposés au départ sont des exemples : saisissez ceux de l’école. Ils s’appliquent aux prochains bulletins calculés.</p>
        {r.grading.distinctions.map((d, i) => (
          <div key={i} className="grid grid-cols-[90px_1fr_auto] gap-2">
            <Input type="number" min={0} max={20} step={0.5} aria-label="Moyenne minimale" value={d.min} onChange={(e) => setR({ ...r, grading: { ...r.grading, distinctions: r.grading.distinctions.map((x, j) => (j === i ? { ...x, min: Number(e.target.value) } : x)) } })} />
            <Input aria-label="Mention" value={d.label} onChange={(e) => setR({ ...r, grading: { ...r.grading, distinctions: r.grading.distinctions.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) } })} />
            <Button variant="ghost" size="icon" aria-label="Retirer" onClick={() => setR({ ...r, grading: { ...r.grading, distinctions: r.grading.distinctions.filter((_, j) => j !== i) } })}><Trash2 className="size-4" /></Button>
          </div>
        ))}
        <Button variant="ghost" onClick={() => setR({ ...r, grading: { ...r.grading, distinctions: [...r.grading.distinctions, { min: 10, label: '' }] } })}><Plus className="size-4" /> Ajouter une mention</Button>
      </div>
      <label className="flex min-h-11 items-center gap-3 font-bold"><input type="checkbox" className="size-5" checked={r.notifications.absenceSms} onChange={(e) => setR({ ...r, notifications: { ...r.notifications, absenceSms: e.target.checked } })} /> Prévenir les parents par SMS si l’absence n’est pas vue dans l’application</label>
      <label className="flex min-h-11 items-center gap-3 font-bold"><input type="checkbox" className="size-5" checked={r.blockReportCardIfUnpaid} onChange={(e) => setR({ ...r, blockReportCardIfUnpaid: e.target.checked })} /> Suspendre le bulletin en ligne en cas d’impayé</label>
      <Button loading={busy} onClick={async () => { if (await run(() => api.patch('/settings', { settings: { grading: { ...r.grading, distinctions: [...r.grading.distinctions].sort((a, b) => b.min - a.min) }, notifications: r.notifications, blockReportCardIfUnpaid: r.blockReportCardIfUnpaid } }), toast, 'Règles enregistrées')) reload(); }}>Enregistrer</Button>
    </Card>
  );
}
