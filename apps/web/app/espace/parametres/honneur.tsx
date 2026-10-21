'use client';

import { useRef, useState } from 'react';
import { Award, ImageUp, Trash2 } from 'lucide-react';
import { Loader, Section } from '@/components/espace/bits';
import { Badge, Button, Dialog, DialogContent, Empty, Field, Input, Table, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { note } from '@/lib/format';
import { useAction, useApi } from '@/lib/use-api';

type Honor = { id: string; displayName: string; className: string; term: string; distinction: string | null; average: number | null; showAverage: boolean; photoUrl: string | null };
type Suggestion = { reportCardId: string; name: string; suggestedName: string; className: string; term: string; average: number; rank: number | null; distinction: string | null; schoolTop: boolean };

/** Élèves à l'honneur sur la page d'accueil : la direction choisit parmi les bulletins publiés, avec l'accord des parents. */
export function Honneur() {
  const q = useApi<{ honors: Honor[]; suggestions: Suggestion[]; publishedTerms: number }>('/honors');
  const [pick, setPick] = useState<(Suggestion & { displayName: string; showAverage: boolean; consent: boolean }) | null>(null);
  const toast = useToast();
  const { busy, run } = useAction();
  return (
    <Loader {...q}>
      {(d) => (
        <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
          <Section title="Sur la page d’accueil">
            {d.honors.length === 0 ? <Empty title="Aucun élève à l’honneur">Choisissez un élève dans la liste : il apparaîtra sur la page d’accueil de l’école.</Empty> : (
              <ul className="grid gap-2">{d.honors.map((h) => <HonorRow key={h.id} h={h} onChange={q.reload} />)}</ul>
            )}
          </Section>
          <Section title="Meilleurs résultats des bulletins publiés">
            <p className="mb-3 text-sm text-muted">Les cinq meilleures moyennes de l’école, puis la première de chaque classe, pour chaque trimestre dont les bulletins sont publiés aux familles. Rien n’est mis en ligne sans votre choix.</p>
            {d.suggestions.length === 0 ? <Empty title="Aucun bulletin publié pour l’instant">Les propositions apparaissent dès que les bulletins d’un trimestre sont publiés aux familles.</Empty> : (
              <Table>
                <thead><tr><th>Élève</th><th>Classe</th><th className="text-right">Moyenne</th><th /></tr></thead>
                <tbody>{d.suggestions.map((s) => (
                  <tr key={s.reportCardId}>
                    <td><b>{s.name}</b><span className="block text-xs text-muted">{s.term}{s.schoolTop ? ' · meilleures moyennes de l’école' : ' · 1er de sa classe'}</span></td>
                    <td>{s.className}</td>
                    <td className="tabular text-right font-bold">{note(s.average)}</td>
                    <td className="text-right"><Button size="sm" variant="outline" onClick={() => setPick({ ...s, displayName: s.suggestedName, showAverage: true, consent: false })}><Award className="size-4" /> Mettre à l’honneur</Button></td>
                  </tr>
                ))}</tbody>
              </Table>
            )}
          </Section>
          <Dialog open={!!pick} onOpenChange={(o) => !o && setPick(null)}>
            {pick && (
              <DialogContent title="Mettre un élève à l’honneur" description={`${pick.name} · ${pick.className} · ${pick.term} · moyenne ${note(pick.average)}`}>
                <form className="grid gap-3" onSubmit={async (e) => {
                  e.preventDefault();
                  if (await run(() => api.post('/honors', { reportCardId: pick.reportCardId, displayName: pick.displayName, showAverage: pick.showAverage, consent: pick.consent }), toast, 'Publié sur la page d’accueil')) { setPick(null); q.reload(); }
                }}>
                  <Field label="Nom affiché sur le site" hint="Par prudence, prénom et initiale du nom. Vous pouvez écrire le nom complet si les parents sont d’accord.">
                    <Input value={pick.displayName} onChange={(e) => setPick({ ...pick, displayName: e.target.value })} maxLength={60} required />
                  </Field>
                  <label className="flex min-h-11 items-center gap-3 font-bold"><input type="checkbox" className="size-5" checked={pick.showAverage} onChange={(e) => setPick({ ...pick, showAverage: e.target.checked })} /> Afficher la moyenne ({note(pick.average)} / 20)</label>
                  <label className="flex items-start gap-3 rounded-lg bg-warn-soft p-3 font-bold"><input type="checkbox" className="mt-0.5 size-5" checked={pick.consent} onChange={(e) => setPick({ ...pick, consent: e.target.checked })} /> Les parents ont donné leur accord pour publier le nom de l’élève (et sa photo si vous en ajoutez une) sur le site de l’école.</label>
                  <Button type="submit" loading={busy} disabled={!pick.consent}>Publier sur la page d’accueil</Button>
                </form>
              </DialogContent>
            )}
          </Dialog>
        </div>
      )}
    </Loader>
  );
}

function HonorRow({ h, onChange }: { h: Honor; onChange: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const { busy, run } = useAction();
  return (
    <li className="flex items-center gap-3 rounded-lg bg-sunk p-3">
      {h.photoUrl ? <img src={h.photoUrl} alt="" className="size-14 rounded-full object-cover" /> : <div className="grid size-14 place-items-center rounded-full bg-brand-soft text-brand"><Award className="size-6" /></div>}
      <div className="min-w-0 flex-1">
        <p className="font-bold">{h.displayName}</p>
        <p className="text-sm text-muted">{h.className} · {h.term}{h.average !== null ? ` · ${note(h.average)} / 20` : ''}</p>
        {!h.showAverage && <Badge tone="info">Moyenne masquée sur le site</Badge>}
      </div>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        const body = new FormData();
        body.append('file', file);
        if (await run(() => api.post(`/honors/${h.id}/photo`, body), toast, 'Photo enregistrée')) onChange();
      }} />
      <Button size="sm" variant="ghost" loading={busy} onClick={() => input.current?.click()}><ImageUp className="size-4" /> {h.photoUrl ? 'Changer la photo' : 'Photo'}</Button>
      <Button size="icon" variant="ghost" aria-label={`Retirer ${h.displayName} du site`} loading={busy} onClick={async () => { if (await run(() => api.del(`/honors/${h.id}`), toast, 'Retiré de la page d’accueil')) onChange(); }}><Trash2 className="size-4" /></Button>
    </li>
  );
}
