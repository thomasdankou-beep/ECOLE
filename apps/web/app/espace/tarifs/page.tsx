'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Loader } from '@/components/espace/bits';
import { Badge, Button, Card, Dialog, DialogContent, DialogTrigger, Empty, Field, Input, PageHeader, Select, Table, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { date, fcfa } from '@/lib/format';
import { useAction, useApi } from '@/lib/use-api';

type Fee = { id: string; name: string; amount: number; levelId: string | null; trackId: string | null; dueDate: string | null; active: boolean };

export default function Tarifs() {
  const q = useApi<Fee[]>('/finance/fee-types');
  const settings = useApi<{ levels: { id: string; name: string }[]; tracks: { id: string; name: string }[] }>('/settings');
  const [edit, setEdit] = useState<Partial<Fee> | null>(null);
  const toast = useToast();
  const { busy, run } = useAction();
  const lvl = (id: string | null) => settings.data?.levels.find((l) => l.id === id)?.name;
  const trk = (id: string | null) => settings.data?.tracks.find((l) => l.id === id)?.name;

  return (
    <>
      <PageHeader title="Frais et tarifs" subtitle="Catalogue des frais de l’année. Les montants sont saisis par l’école ; ceux de la démonstration sont fictifs." actions={<Button onClick={() => setEdit({ name: '', amount: 0, levelId: null, trackId: null, dueDate: null, active: true })}><Plus className="size-4" /> Nouveau frais</Button>} />
      <Card>
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
      </Card>
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
