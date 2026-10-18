'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Phone } from 'lucide-react';
import { Loader, StatusBadge } from '@/components/espace/bits';
import { Button, Card, Chips, Dialog, DialogContent, Empty, Field, Input, PageHeader, Select, Textarea, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { date, dateTime } from '@/lib/format';
import { qs, useAction, useApi } from '@/lib/use-api';

const STATUSES = [
  ['RECU', 'Reçue'], ['INCOMPLET', 'Incomplète'], ['EN_TEST', 'En test'], ['ACCEPTE', 'Acceptée'], ['LISTE_ATTENTE', 'Liste d’attente'], ['REFUSE', 'Refusée'], ['INSCRIT', 'Inscrit'],
] as const;

export default function Preinscriptions() {
  const [status, setStatus] = useState('');
  const q = useApi<{ items: any[]; funnel: Record<string, number> }>(`/applications${qs({ status })}`);
  const [edit, setEdit] = useState<any | null>(null);
  const toast = useToast();
  const { busy, run } = useAction();

  return (
    <>
      <PageHeader title="Pré-inscriptions" subtitle="Demandes envoyées depuis le site de l’école. La famille est prévenue par SMS à chaque décision." />
      <Chips label="Statut" value={status} onChange={setStatus} options={[{ value: '', label: 'Toutes' }, ...STATUSES.map(([v, l]) => ({ value: v, label: `${l}${q.data?.funnel[v] ? ` (${q.data.funnel[v]})` : ''}` }))]} />
      <Loader {...q}>
        {(d) => d.items.length === 0 ? <Empty title="Aucune demande" /> : (
          <div className="grid gap-3 md:grid-cols-2">
            {d.items.map((a) => (
              <Card key={a.id} className="grid gap-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-lg font-bold">{a.studentLastName} {a.studentFirstName}</p>
                    <p className="font-mono text-xs text-muted">{a.reference} · reçue le {dateTime(a.createdAt)}</p>
                  </div>
                  <StatusBadge status={a.status} />
                </div>
                <p className="text-sm"><b>{a.wantedLevel}</b>{a.wantedTrack ? ` · ${a.wantedTrack}` : ''}{a.wantedSite ? ` · ${a.wantedSite}` : ''}</p>
                <p className="text-sm">{a.guardianName} · <a className="font-bold text-brand" href={`tel:${a.guardianPhone}`}><Phone className="inline size-3.5" /> {a.guardianPhone}</a></p>
                {a.birthDate && <p className="text-sm text-muted">Né(e) le {date(a.birthDate)}{a.previousSchool ? ` · ${a.previousSchool}` : ''}</p>}
                {a.message && <p className="rounded-lg bg-sunk px-3 py-2 text-sm">{a.message}</p>}
                {a.testResult && <p className="text-sm"><b>Test :</b> {a.testResult}</p>}
                <div className="mt-1 flex flex-wrap gap-2">
                  {a.status !== 'INSCRIT' && <Button variant="outline" size="sm" onClick={() => setEdit({ ...a })}>Mettre à jour</Button>}
                  {a.status === 'ACCEPTE' && <Button size="sm" asChild><Link href={`/espace/inscription?dossier=${a.id}`}>Inscrire</Link></Button>}
                </div>
              </Card>
            ))}
          </div>
        )}
      </Loader>
      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        {edit && (
          <DialogContent title={`Dossier ${edit.reference}`} description={`${edit.studentFirstName} ${edit.studentLastName}`}>
            <form className="grid gap-3" onSubmit={async (e) => {
              e.preventDefault();
              if (await run(() => api.patch(`/applications/${edit.id}`, { status: edit.status, testResult: edit.testResult || undefined, notes: edit.notes || undefined }), toast, 'Dossier mis à jour')) { setEdit(null); q.reload(); }
            }}>
              <Field label="Statut"><Select value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}>{STATUSES.filter(([v]) => v !== 'INSCRIT').map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
              <Field label="Résultat du test"><Input value={edit.testResult ?? ''} onChange={(e) => setEdit({ ...edit, testResult: e.target.value })} /></Field>
              <Field label="Notes internes"><Textarea value={edit.notes ?? ''} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></Field>
              <Button type="submit" loading={busy}>Enregistrer et prévenir la famille</Button>
            </form>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
