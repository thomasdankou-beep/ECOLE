'use client';

import { useState } from 'react';
import { Camera } from 'lucide-react';
import { Loader, StatusBadge } from '@/components/espace/bits';
import { Button, Card, Dialog, DialogContent, Empty, Field, PageHeader, Textarea, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { date, hhmm } from '@/lib/format';
import { useAction, useApi } from '@/lib/use-api';

export default function Absences() {
  const { child, role } = useAuth();
  const q = useApi<any[]>(`/attendance/absences?studentId=${child!.id}`);
  const [target, setTarget] = useState<any | null>(null);
  const [reason, setReason] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const toast = useToast();
  const { busy, run } = useAction();

  return (
    <>
      <PageHeader title="Absences et retards" subtitle={role === 'PARENT' ? 'Justifiez une absence avec un motif et, si possible, la photo d’un certificat.' : undefined} />
      <Loader {...q}>
        {(rows) => rows.length === 0 ? <Empty title="Aucune absence ni retard">Bravo !</Empty> : (
          <div className="grid gap-2">
            {rows.map((r) => (
              <Card key={r.id} className="flex flex-wrap items-center gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <p className="font-bold">{date(r.date, { weekday: 'long', day: 'numeric', month: 'long' })} · {hhmm(r.startMinute)}</p>
                  <p className="text-sm text-muted">{r.subject ?? 'Cours'}{r.minutesLate ? ` · ${r.minutesLate} min de retard` : ''}{r.justificationReason ? ` · « ${r.justificationReason} »` : ''}</p>
                </div>
                <StatusBadge status={r.status} />
                <StatusBadge status={r.justification} justification />
                {role === 'PARENT' && (r.justification === 'NONE' || r.justification === 'REJECTED') && <Button size="sm" onClick={() => { setTarget(r); setReason(''); setFile(null); }}>Justifier</Button>}
              </Card>
            ))}
          </div>
        )}
      </Loader>
      <Dialog open={!!target} onOpenChange={(o) => !o && setTarget(null)}>
        {target && (
          <DialogContent title="Justifier l’absence" description={`${date(target.date, { weekday: 'long', day: 'numeric', month: 'long' })} à ${hhmm(target.startMinute)}`}>
            <form className="grid gap-3" onSubmit={async (e) => {
              e.preventDefault();
              const fd = new FormData();
              fd.append('reason', reason);
              if (file) fd.append('file', file);
              if (await run(() => api.post(`/attendance/records/${target.id}/justify`, fd), toast, 'Justificatif envoyé à la vie scolaire')) { setTarget(null); q.reload(); }
            }}>
              <Field label="Motif"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={300} placeholder="Ex. Maladie, rendez-vous médical" /></Field>
              <label className="flex min-h-12 cursor-pointer items-center gap-2 rounded-lg border border-dashed border-line px-3 font-bold">
                <Camera className="size-5 text-brand" /> {file ? file.name : 'Photo du certificat (facultatif)'}
                <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" capture="environment" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              </label>
              <p className="text-xs text-muted">Image ou PDF, 5 Mo au plus.</p>
              <Button type="submit" loading={busy}>Envoyer</Button>
            </form>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
