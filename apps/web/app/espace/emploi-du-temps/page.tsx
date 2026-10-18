'use client';

import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { Loader } from '@/components/espace/bits';
import { Badge, Button, Card, Chips, Dialog, DialogContent, Empty, Field, Input, PageHeader, Select, Textarea, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { date, DAYS, hhmm, today } from '@/lib/format';
import { can } from '@/lib/perm';
import type { ClassRow } from '@/lib/types';
import { qs, useAction, useApi } from '@/lib/use-api';
import { cn } from '@/lib/utils';

type Change = { id: string; date: string; kind: 'CANCELLED' | 'MOVED' | 'ROOM_CHANGED'; newDate: string | null; newStartMinute: number | null; newEndMinute: number | null; newRoomName: string | null; reason: string | null };
type Slot = { id: string; dayOfWeek: number; startMinute: number; endMinute: number; room: { id: string; name: string } | null; subject: { name: string }; class: { id: string; name: string }; classSubjectId: string; teachers: { firstName: string; lastName: string }[]; changes: Change[] };

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + (m || 0); };
const toTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export default function EmploiDuTemps() {
  const { role, child, me } = useAuth();
  const family = role === 'PARENT' || role === 'ELEVE';
  const manage = can(role, 'timetable.manage');
  const [week, setWeek] = useState(today());
  const [classId, setClassId] = useState('');
  const [view, setView] = useState<'mine' | 'class'>(role === 'ENSEIGNANT' ? 'mine' : 'class');
  const classes = useApi<ClassRow[]>(!family ? '/classes' : null);
  const kid = useApi<{ currentClass: { id: string } | null }>(family && child ? `/students/${child.id}` : null);
  const effectiveClass = family ? kid.data?.currentClass?.id : classId || (view === 'class' ? classes.data?.[0]?.id : undefined);
  const path = view === 'mine' && role === 'ENSEIGNANT' ? `/timetable${qs({ teacherId: me?.user.id, week })}` : effectiveClass ? `/timetable${qs({ classId: effectiveClass, week })}` : null;
  const q = useApi<{ week: string; slots: Slot[] }>(path);
  const [day, setDay] = useState(() => String((new Date().getUTCDay() || 7) > 6 ? 1 : new Date().getUTCDay() || 1));
  const [selected, setSelected] = useState<Slot | null>(null);
  const [adding, setAdding] = useState(false);

  return (
    <>
      <PageHeader title="Emploi du temps" subtitle={family ? `${child?.firstName} · ${child?.className ?? ''}` : 'Les changements sont envoyés aux élèves, aux parents et aux enseignants.'} actions={manage && effectiveClass && view === 'class' && <Button onClick={() => setAdding(true)}><Plus className="size-4" /> Ajouter un cours</Button>} />
      <Card className="flex flex-wrap items-end gap-3">
        {role === 'ENSEIGNANT' && <Chips label="Vue" value={view} onChange={(v) => setView(v as 'mine' | 'class')} options={[{ value: 'mine', label: 'Mes cours' }, { value: 'class', label: 'Par classe' }]} />}
        {!family && view === 'class' && (
          <Field label="Classe" className="min-w-56 flex-1">
            <Select value={effectiveClass ?? ''} onChange={(e) => setClassId(e.target.value)}>{classes.data?.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.site.name}</option>)}</Select>
          </Field>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button variant="outline" size="icon" aria-label="Semaine précédente" onClick={() => setWeek(addDays(q.data?.week ?? week, -7))}><ChevronLeft className="size-5" /></Button>
          <span className="min-w-44 text-center text-sm font-bold">Semaine du {date(q.data?.week ?? week, { day: 'numeric', month: 'long' })}</span>
          <Button variant="outline" size="icon" aria-label="Semaine suivante" onClick={() => setWeek(addDays(q.data?.week ?? week, 7))}><ChevronRight className="size-5" /></Button>
        </div>
      </Card>
      <div className="lg:hidden"><Chips label="Jour" value={day} onChange={setDay} options={[1, 2, 3, 4, 5, 6].map((d) => ({ value: String(d), label: DAYS[d] }))} /></div>
      {path ? (
        <Loader {...q}>
          {(d) => (
            <div className="grid gap-3 lg:grid-cols-6">
              {[1, 2, 3, 4, 5, 6].map((dw) => {
                const slots = d.slots.filter((s) => s.dayOfWeek === dw);
                const iso = addDays(d.week, dw - 1);
                return (
                  <section key={dw} className={cn('grid content-start gap-2', String(dw) !== day && 'hidden lg:grid')}>
                    <h2 className={cn('rounded-lg px-2 py-1 text-center text-lg font-bold', iso === today() ? 'bg-brand text-brand-ink' : 'bg-sunk')}>{DAYS[dw]} <span className="text-sm font-semibold opacity-75">{date(iso, { day: 'numeric', month: 'short' })}</span></h2>
                    {slots.length === 0 && <p className="py-4 text-center text-sm text-muted">Pas de cours</p>}
                    {slots.map((s) => {
                      const ch = s.changes.find((c) => c.date.slice(0, 10) === iso);
                      const movedIn = s.changes.find((c) => c.kind === 'MOVED' && c.newDate?.slice(0, 10) !== iso && c.date.slice(0, 10) === iso);
                      return (
                        <button key={s.id} type="button" disabled={!manage} onClick={() => setSelected(s)} className={cn('grid gap-0.5 rounded-lg border-l-4 border-brand bg-surface p-2.5 text-left shadow-sm enabled:cursor-pointer enabled:hover:ring-2 enabled:hover:ring-brand', ch?.kind === 'CANCELLED' && 'border-bad opacity-70', ch?.kind === 'MOVED' && 'border-orange', ch?.kind === 'ROOM_CHANGED' && 'border-warn')}>
                          <span className="tabular text-sm font-bold text-muted">{hhmm(s.startMinute)} – {hhmm(s.endMinute)}</span>
                          <span className={cn('font-bold leading-tight', ch?.kind === 'CANCELLED' && 'line-through')}>{s.subject.name}</span>
                          <span className="text-sm">{view === 'mine' ? s.class.name : s.teachers.map((t) => `${t.firstName[0]}. ${t.lastName}`).join(', ')}{s.room ? ` · ${ch?.kind === 'ROOM_CHANGED' ? ch.newRoomName : s.room.name}` : ''}</span>
                          {ch?.kind === 'CANCELLED' && <Badge tone="bad">Annulé{ch.reason ? ` · ${ch.reason}` : ''}</Badge>}
                          {movedIn && movedIn.newDate && <Badge tone="accent">Déplacé au {date(movedIn.newDate, { weekday: 'short', day: 'numeric' })} {hhmm(movedIn.newStartMinute!)}</Badge>}
                          {ch?.kind === 'ROOM_CHANGED' && <Badge tone="warn">Changement de salle</Badge>}
                        </button>
                      );
                    })}
                    {d.slots.flatMap((s) => s.changes.filter((c) => c.kind === 'MOVED' && c.newDate?.slice(0, 10) === iso).map((c) => (
                      <div key={c.id} className="grid gap-0.5 rounded-lg border-l-4 border-orange bg-orange-soft p-2.5">
                        <span className="tabular text-sm font-bold">{hhmm(c.newStartMinute!)} – {hhmm(c.newEndMinute!)}</span>
                        <span className="font-bold">{s.subject.name}</span>
                        <Badge tone="accent">Cours rattrapé</Badge>
                      </div>
                    )))}
                  </section>
                );
              })}
            </div>
          )}
        </Loader>
      ) : <Empty title="Choisissez une classe" />}
      {manage && selected && <SlotDialog slot={selected} week={q.data?.week ?? week} onClose={() => setSelected(null)} onDone={() => { setSelected(null); q.reload(); }} />}
      {manage && adding && effectiveClass && <AddSlot classId={effectiveClass} classes={classes.data ?? []} onClose={() => setAdding(false)} onDone={() => { setAdding(false); q.reload(); }} />}
    </>
  );
}

function useRooms() {
  const s = useApi<{ rooms: { id: string; name: string; siteId: string }[]; sites: { id: string; name: string }[] }>('/settings');
  return useMemo(() => (s.data?.rooms ?? []).map((r) => ({ ...r, label: `${r.name} · ${s.data?.sites.find((x) => x.id === r.siteId)?.name ?? ''}` })), [s.data]);
}

function SlotDialog({ slot, week, onClose, onDone }: { slot: Slot; week: string; onClose: () => void; onDone: () => void }) {
  const rooms = useRooms();
  const toast = useToast();
  const { busy, run } = useAction();
  const occurrence = addDays(week, slot.dayOfWeek - 1);
  const [mode, setMode] = useState<'once' | 'always'>('once');
  const [kind, setKind] = useState<'CANCELLED' | 'MOVED' | 'ROOM_CHANGED'>('CANCELLED');
  const [f, setF] = useState({ date: occurrence, newDate: occurrence, start: toTime(slot.startMinute), end: toTime(slot.endMinute), room: slot.room?.id ?? '', reason: '' });
  const [perm, setPerm] = useState({ day: String(slot.dayOfWeek), start: toTime(slot.startMinute), end: toTime(slot.endMinute), room: slot.room?.id ?? '' });
  const existing = slot.changes.find((c) => c.date.slice(0, 10) === occurrence);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`${slot.subject.name} · ${slot.class.name}`} description={`${DAYS[slot.dayOfWeek]} ${hhmm(slot.startMinute)} – ${hhmm(slot.endMinute)}${slot.room ? ` · ${slot.room.name}` : ''}`}>
        <Chips label="Portée" value={mode} onChange={(v) => setMode(v as 'once' | 'always')} options={[{ value: 'once', label: 'Une seule fois' }, { value: 'always', label: 'Toutes les semaines' }]} />
        {mode === 'once' ? (
          <form className="mt-4 grid gap-3" onSubmit={async (e) => {
            e.preventDefault();
            const body: Record<string, unknown> = { date: f.date, kind, reason: f.reason || undefined };
            if (kind === 'MOVED') Object.assign(body, { newDate: f.newDate, newStartMinute: toMin(f.start), newEndMinute: toMin(f.end), newRoomId: f.room || undefined });
            if (kind === 'ROOM_CHANGED') body.newRoomId = f.room;
            if (await run(() => api.post(`/timetable/slots/${slot.id}/changes`, body), toast, 'Modification enregistrée et familles prévenues')) onDone();
          }}>
            {existing && (
              <div className="flex items-center justify-between gap-2 rounded-lg bg-warn-soft p-3 text-sm font-bold text-warn">
                Une modification existe déjà pour ce jour.
                <Button type="button" size="sm" variant="outline" loading={busy} onClick={async () => { if (await run(() => api.del(`/timetable/changes/${existing.id}`), toast, 'Cours rétabli')) onDone(); }}>Rétablir le cours</Button>
              </div>
            )}
            <Field label="Séance du"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} required /></Field>
            <Field label="Action"><Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}><option value="CANCELLED">Annuler la séance</option><option value="MOVED">Déplacer la séance</option><option value="ROOM_CHANGED">Changer de salle</option></Select></Field>
            {kind === 'MOVED' && (
              <div className="grid grid-cols-3 gap-2">
                <Field label="Nouvelle date" className="col-span-3"><Input type="date" value={f.newDate} onChange={(e) => setF({ ...f, newDate: e.target.value })} required /></Field>
                <Field label="Début"><Input type="time" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} required /></Field>
                <Field label="Fin"><Input type="time" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} required /></Field>
              </div>
            )}
            {kind !== 'CANCELLED' && <Field label="Salle"><Select value={f.room} onChange={(e) => setF({ ...f, room: e.target.value })} required={kind === 'ROOM_CHANGED'}><option value="">Même salle</option>{rooms.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</Select></Field>}
            <Field label="Motif communiqué aux familles (facultatif)"><Textarea value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} className="min-h-16" maxLength={200} /></Field>
            <Button type="submit" loading={busy}>Enregistrer et prévenir</Button>
          </form>
        ) : (
          <form className="mt-4 grid gap-3" onSubmit={async (e) => {
            e.preventDefault();
            if (await run(() => api.patch(`/timetable/slots/${slot.id}`, { dayOfWeek: Number(perm.day), startMinute: toMin(perm.start), endMinute: toMin(perm.end), roomId: perm.room || null }), toast, 'Créneau modifié')) onDone();
          }}>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Jour"><Select value={perm.day} onChange={(e) => setPerm({ ...perm, day: e.target.value })}>{[1, 2, 3, 4, 5, 6].map((d) => <option key={d} value={d}>{DAYS[d]}</option>)}</Select></Field>
              <Field label="Début"><Input type="time" value={perm.start} onChange={(e) => setPerm({ ...perm, start: e.target.value })} /></Field>
              <Field label="Fin"><Input type="time" value={perm.end} onChange={(e) => setPerm({ ...perm, end: e.target.value })} /></Field>
            </div>
            <Field label="Salle"><Select value={perm.room} onChange={(e) => setPerm({ ...perm, room: e.target.value })}><option value="">Sans salle</option>{rooms.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</Select></Field>
            <p className="text-sm text-muted">Les conflits (classe, enseignant ou salle déjà pris) sont vérifiés avant l’enregistrement.</p>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" loading={busy}>Enregistrer</Button>
              <Button type="button" variant="danger" loading={busy} onClick={async () => { if (await run(() => api.del(`/timetable/slots/${slot.id}`), toast, 'Créneau supprimé')) onDone(); }}>Supprimer le créneau</Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AddSlot({ classId, classes, onClose, onDone }: { classId: string; classes: ClassRow[]; onClose: () => void; onDone: () => void }) {
  const rooms = useRooms();
  const klass = classes.find((c) => c.id === classId);
  const toast = useToast();
  const { busy, run } = useAction();
  const [f, setF] = useState({ cs: klass?.subjects[0]?.id ?? '', day: '1', start: '08:00', end: '10:00', room: '' });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Ajouter un cours · ${klass?.name ?? ''}`}>
        <form className="grid gap-3" onSubmit={async (e) => {
          e.preventDefault();
          if (await run(() => api.post('/timetable/slots', { classSubjectId: f.cs, dayOfWeek: Number(f.day), startMinute: toMin(f.start), endMinute: toMin(f.end), roomId: f.room || null }), toast, 'Cours ajouté')) onDone();
        }}>
          <Field label="Matière"><Select value={f.cs} onChange={(e) => setF({ ...f, cs: e.target.value })} required>{klass?.subjects.map((s) => <option key={s.id} value={s.id}>{s.subject.name}{s.assignments[0] ? ` · ${s.assignments[0].teacher.lastName}` : ' · sans enseignant'}</option>)}</Select></Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Jour"><Select value={f.day} onChange={(e) => setF({ ...f, day: e.target.value })}>{[1, 2, 3, 4, 5, 6].map((d) => <option key={d} value={d}>{DAYS[d]}</option>)}</Select></Field>
            <Field label="Début"><Input type="time" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></Field>
            <Field label="Fin"><Input type="time" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></Field>
          </div>
          <Field label="Salle"><Select value={f.room} onChange={(e) => setF({ ...f, room: e.target.value })}><option value="">Sans salle</option>{rooms.filter((r) => r.siteId === klass?.siteId).map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</Select></Field>
          <Button type="submit" loading={busy}>Ajouter</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
