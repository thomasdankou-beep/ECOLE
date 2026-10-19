'use client';

import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { Loader } from '@/components/espace/bits';
import { Badge, Button, Card, Chips, Dialog, DialogContent, Empty, Field, Input, PageHeader, Select, Table, useToast } from '@/components/ui';
import type { ClassRow } from '@/lib/types';
import { api } from '@/lib/api';
import { date, fcfa } from '@/lib/format';
import { useAction, useApi } from '@/lib/use-api';

type Fee = { id: string; name: string; amount: number; levelId: string | null; trackId: string | null; dueDate: string | null; active: boolean };

export default function Tarifs() {
  const q = useApi<Fee[]>('/finance/fee-types');
  const settings = useApi<{ levels: { id: string; name: string }[]; tracks: { id: string; name: string }[] }>('/settings');
  const [edit, setEdit] = useState<Partial<Fee> | null>(null);
  const [view, setView] = useState<'liste' | 'grille'>('liste');
  const toast = useToast();
  const { busy, run } = useAction();
  const lvl = (id: string | null) => settings.data?.levels.find((l) => l.id === id)?.name;
  const trk = (id: string | null) => settings.data?.tracks.find((l) => l.id === id)?.name;

  return (
    <>
      <PageHeader title="Frais et tarifs" subtitle="Catalogue des frais de l’année. Les montants sont saisis par l’école ; ceux de la démonstration sont fictifs." actions={<Button onClick={() => setEdit({ name: '', amount: 0, levelId: null, trackId: null, dueDate: null, active: true })}><Plus className="size-4" /> Nouveau frais</Button>} />
      <Chips label="Affichage" value={view} onChange={setView} options={[{ value: 'liste', label: 'Liste des frais' }, { value: 'grille', label: 'Grille par niveau et filière' }]} />
      {view === 'grille' && q.data && <FeeGrid fees={q.data} reload={q.reload} />}
      {view === 'liste' && <Card>
        <Loader {...q}>
          {(rows) => rows.length === 0 ? <Empty title="Aucun frais défini" /> : (
            <Table>
              <thead><tr><th>Frais</th><th>Concerne</th><th>Échéance</th><th className="text-right">Montant</th><th>État</th><th /></tr></thead>
              <tbody>{rows.map((f) => (
                <tr key={f.id}>
                  <td className="font-bold">{f.name}</td>
                  <td>{[lvl(f.levelId), trk(f.trackId)].filter(Boolean).join(' · ') || 'Tous les élèves'}</td>
                  <td>{date(f.dueDate)}</td>
                  <td className="text-right font-bold">{fcfa(f.amount)}</td>
                  <td>{f.active ? <Badge tone="good">Actif</Badge> : <Badge>Inactif</Badge>}</td>
                  <td className="text-right"><Button size="sm" variant="ghost" onClick={() => setEdit(f)}>Modifier</Button></td>
                </tr>
              ))}</tbody>
            </Table>
          )}
        </Loader>
      </Card>}
      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        {edit && (
          <DialogContent title={edit.id ? 'Modifier le frais' : 'Nouveau frais'}>
            <form className="grid gap-3" onSubmit={async (e) => {
              e.preventDefault();
              const body = { name: edit.name, amount: Number(edit.amount), levelId: edit.levelId || null, trackId: edit.trackId || null, dueDate: edit.dueDate ? edit.dueDate.slice(0, 10) : null, active: edit.active };
              if (await run(() => (edit.id ? api.patch(`/finance/fee-types/${edit.id}`, body) : api.post('/finance/fee-types', body)), toast, 'Frais enregistré')) { setEdit(null); q.reload(); }
            }}>
              <Field label="Intitulé"><Input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required /></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Montant (FCFA)"><Input type="number" min={0} value={edit.amount ?? 0} onChange={(e) => setEdit({ ...edit, amount: Number(e.target.value) })} required /></Field>
                <Field label="Échéance"><Input type="date" value={edit.dueDate?.slice(0, 10) ?? ''} onChange={(e) => setEdit({ ...edit, dueDate: e.target.value || null })} /></Field>
                <Field label="Niveau"><Select value={edit.levelId ?? ''} onChange={(e) => setEdit({ ...edit, levelId: e.target.value || null })}><option value="">Tous</option>{settings.data?.levels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>
                <Field label="Filière"><Select value={edit.trackId ?? ''} onChange={(e) => setEdit({ ...edit, trackId: e.target.value || null })}><option value="">Toutes</option>{settings.data?.tracks.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>
              </div>
              <label className="flex min-h-11 items-center gap-3 font-bold"><input type="checkbox" className="size-5" checked={!!edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Frais actif</label>
              <Button type="submit" loading={busy}>Enregistrer</Button>
            </form>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}

/** Saisie d'un même frais pour chaque combinaison niveau et filière des classes de l'année. */
function FeeGrid({ fees, reload }: { fees: Fee[]; reload: () => void }) {
  const classes = useApi<ClassRow[]>('/classes');
  const toast = useToast();
  const { busy, run } = useAction();
  const names = [...new Set(fees.map((f) => f.name))].sort();
  const [name, setName] = useState(names.find((n) => /scolarit/i.test(n)) ?? names[0] ?? '');
  const [dueDate, setDueDate] = useState('');
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const combos = useMemo(() => {
    const m = new Map<string, { key: string; label: string; levelId: string; trackId: string | null; classes: string[] }>();
    for (const c of classes.data ?? []) {
      const key = `${c.levelId}:${c.trackId ?? ''}`;
      if (!m.has(key)) m.set(key, { key, label: [c.level.name, c.track?.name].filter(Boolean).join(' · '), levelId: c.levelId, trackId: c.trackId, classes: [] });
      m.get(key)!.classes.push(c.name);
    }
    return [...m.values()];
  }, [classes.data]);
  const existing = (levelId: string, trackId: string | null) => fees.find((f) => f.name === name && f.levelId === levelId && (f.trackId ?? null) === trackId && f.active);
  const value = (c: (typeof combos)[number]) => amounts[`${name}|${c.key}`] ?? (existing(c.levelId, c.trackId)?.amount?.toString() ?? '');

  return (
    <Card className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
        <Field label="Frais à saisir" hint="Choisissez un frais existant ou tapez un nouvel intitulé (ex. Scolarité, Inscription).">
          <Input list="fee-names" value={name} onChange={(e) => setName(e.target.value)} required />
          <datalist id="fee-names">{names.map((n) => <option key={n} value={n} />)}</datalist>
        </Field>
        <Field label="Échéance (facultatif)"><Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
      </div>
      <Loader {...classes}>
        {() => combos.length === 0 ? <Empty title="Aucune classe cette année">Créez d’abord les classes dans Paramètres.</Empty> : (
          <Table>
            <thead><tr><th>Niveau et filière</th><th>Classes</th><th className="w-44 text-right">Montant (FCFA)</th></tr></thead>
            <tbody>{combos.map((c) => (
              <tr key={c.key}>
                <td className="font-bold">{c.label}</td>
                <td className="text-sm text-muted">{c.classes.join(', ')}</td>
                <td><Input aria-label={`Montant ${c.label}`} type="number" min={0} className="min-h-10 text-right" placeholder="Non concerné" value={value(c)} onChange={(e) => setAmounts({ ...amounts, [`${name}|${c.key}`]: e.target.value })} /></td>
              </tr>
            ))}</tbody>
          </Table>
        )}
      </Loader>
      <p className="text-sm text-muted">Une case vide signifie que ce frais ne concerne pas ce niveau. Les factures déjà émises ne changent pas : les nouveaux montants servent aux prochaines factures.</p>
      <Button disabled={!name.trim() || combos.length === 0} loading={busy} onClick={async () => {
        const rows = combos.map((c) => ({ levelId: c.levelId, trackId: c.trackId, amount: value(c) === '' ? null : Number(value(c)) }));
        if (await run(() => api.put('/finance/fee-types/grid', { name: name.trim(), dueDate: dueDate || null, rows }), toast, 'Grille enregistrée')) { setAmounts({}); reload(); }
      }}>Enregistrer la grille</Button>
    </Card>
  );
}
