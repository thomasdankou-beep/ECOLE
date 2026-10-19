'use client';

import { useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Loader } from '@/components/espace/bits';
import { Badge, Button, Card, Empty, Field, Input, Select, Table, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { note } from '@/lib/format';
import type { ClassRow } from '@/lib/types';
import { useAction, useApi } from '@/lib/use-api';

type Subject = { id: string; code: string; name: string; practical?: boolean };

/** Coefficients par niveau et filière : une valeur appliquée d'un coup à toutes les classes concernées. */
export function Coefficients({ subjects }: { subjects: Subject[] }) {
  const q = useApi<ClassRow[]>('/classes');
  return <Loader {...q}>{(classes) => <Grid classes={classes} subjects={subjects} reload={q.reload} />}</Loader>;
}

function Grid({ classes, subjects, reload }: { classes: ClassRow[]; subjects: Subject[]; reload: () => void }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const groups = useMemo(() => {
    const m = new Map<string, { key: string; label: string; levelId: string; trackId: string | null; classes: ClassRow[] }>();
    for (const c of classes) {
      const key = `${c.levelId}:${c.trackId ?? ''}`;
      if (!m.has(key)) m.set(key, { key, label: [c.level.name, c.track?.name].filter(Boolean).join(' · '), levelId: c.levelId, trackId: c.trackId, classes: [] });
      m.get(key)!.classes.push(c);
    }
    return [...m.values()];
  }, [classes]);
  const [key, setKey] = useState(groups[0]?.key ?? '');
  const g = groups.find((x) => x.key === key) ?? groups[0];
  if (!g) return <Empty title="Aucune classe cette année">Créez d’abord les classes dans « Classes et matières ».</Empty>;

  const save = (subjectId: string, coefficient: number | null) =>
    run(() => api.put('/class-subjects/bulk', { levelId: g.levelId, trackId: g.trackId, subjectId, coefficient }), toast, coefficient === null ? 'Matière retirée de ces classes' : 'Coefficient appliqué').then((ok) => ok && reload());

  return (
    <Card className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Niveau et filière" className="min-w-60">
          <Select value={g.key} onChange={(e) => setKey(e.target.value)}>{groups.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</Select>
        </Field>
        <p className="pb-2 text-sm text-muted">Classes concernées : {g.classes.map((c) => c.name).join(', ')}</p>
      </div>
      <p className="text-sm text-muted">Le coefficient saisi s’applique à toutes ces classes. Pour une classe seulement, passez par « Classes et matières ». Les moyennes non encore validées sont recalculées.</p>
      <Table>
        <thead><tr><th>Matière</th><th>Actuel</th><th className="w-32">Coefficient</th><th /></tr></thead>
        <tbody>
          {subjects.map((s) => {
            const values = g.classes.map((c) => c.subjects.find((x) => x.subject.id === s.id)?.coefficient).filter((v) => v !== undefined).map(Number);
            const same = values.length === g.classes.length && values.every((v) => v === values[0]);
            const current = values.length === 0 ? '—' : same ? note(values[0]) : `varie (${[...new Set(values)].map((v) => note(v)).join(', ')})`;
            return (
              <tr key={`${g.key}-${s.id}`}>
                <td className="font-bold">{s.name}{s.practical && <Badge tone="accent" className="ml-2">TP</Badge>}</td>
                <td>{current}{values.length > 0 && values.length < g.classes.length && <span className="text-xs text-muted"> · {values.length}/{g.classes.length} classes</span>}</td>
                <td>
                  <Input aria-label={`Coefficient ${s.name}`} type="number" min={0} max={20} step={0.5} className="min-h-10" defaultValue={same ? values[0] : ''} placeholder="—"
                    onBlur={(e) => { const v = e.target.value; if (v !== '' && !(same && Number(v) === values[0])) save(s.id, Number(v)); }} />
                </td>
                <td className="text-right">{values.length > 0 && <Button variant="ghost" size="icon" aria-label={`Retirer ${s.name}`} loading={busy} onClick={() => save(s.id, null)}><Trash2 className="size-4" /></Button>}</td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </Card>
  );
}
