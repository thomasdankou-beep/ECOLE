'use client';

import { useState } from 'react';
import { Megaphone, Plus } from 'lucide-react';
import { Loader } from '@/components/espace/bits';
import { Badge, Button, Card, Dialog, DialogContent, DialogTrigger, Empty, Field, Input, PageHeader, Select, Textarea, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime } from '@/lib/format';
import { can } from '@/lib/perm';
import type { ClassRow } from '@/lib/types';
import { useAction, useApi } from '@/lib/use-api';

const AUDIENCE: Record<string, string> = { ALL: 'Toute l’école', PARENTS: 'Parents', STAFF: 'Personnel', TEACHERS: 'Enseignants', CLASS: 'Une classe' };

export default function Annonces() {
  const { role } = useAuth();
  const q = useApi<any[]>('/announcements');
  return (
    <>
      <PageHeader title="Annonces" actions={can(role, 'announcements.write') && <NewAnnouncement onDone={q.reload} />} />
      <Loader {...q}>
        {(rows) => rows.length === 0 ? <Empty title="Aucune annonce" /> : (
          <div className="grid gap-3">
            {rows.map((a) => (
              <Card key={a.id} className={a.urgent ? 'border-bad' : ''}>
                <div className="flex flex-wrap items-center gap-2">
                  <Megaphone className="size-5 text-orange" />
                  <h2 className="flex-1 text-xl font-bold">{a.title}</h2>
                  {a.urgent && <Badge tone="bad">Urgent</Badge>}
                  <Badge tone="brand">{a.class ? a.class.name : AUDIENCE[a.audience]}</Badge>
                </div>
                <p className="mt-2 whitespace-pre-line">{a.body}</p>
                <p className="mt-2 text-xs text-muted">{dateTime(a.createdAt)}</p>
              </Card>
            ))}
          </div>
        )}
      </Loader>
    </>
  );
}

function NewAnnouncement({ onDone }: { onDone: () => void }) {
  const { me } = useAuth();
  const [open, setOpen] = useState(false);
  const classes = useApi<ClassRow[]>(open ? '/classes' : null);
  const [f, setF] = useState({ title: '', body: '', audience: 'ALL', classId: '', siteId: '', urgent: false });
  const toast = useToast();
  const { busy, run } = useAction();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus className="size-4" /> Nouvelle annonce</Button></DialogTrigger>
      <DialogContent title="Nouvelle annonce" description="Diffusée dans l’application ; un SMS part aussi si elle n’est pas lue, ou tout de suite si elle est urgente.">
        <form className="grid gap-3" onSubmit={async (e) => {
          e.preventDefault();
          const r = await run(() => api.post<{ recipients: number }>('/announcements', { title: f.title, body: f.body, audience: f.audience, classId: f.audience === 'CLASS' ? f.classId : undefined, siteId: f.siteId || undefined, urgent: f.urgent }), toast);
          if (r) { toast(`Annonce envoyée à ${r.recipients} personne(s)`); setOpen(false); onDone(); }
        }}>
          <Field label="Titre"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required maxLength={160} /></Field>
          <Field label="Message"><Textarea value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} required maxLength={4000} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Destinataires"><Select value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value })}>{Object.entries(AUDIENCE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
            {f.audience === 'CLASS' ? (
              <Field label="Classe"><Select value={f.classId} onChange={(e) => setF({ ...f, classId: e.target.value })} required><option value="">Choisir</option>{classes.data?.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.site.name}</option>)}</Select></Field>
            ) : (
              <Field label="Site"><Select value={f.siteId} onChange={(e) => setF({ ...f, siteId: e.target.value })}><option value="">Tous les sites</option>{me?.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
            )}
          </div>
          <label className="flex min-h-11 items-center gap-3 font-bold text-bad"><input type="checkbox" className="size-5" checked={f.urgent} onChange={(e) => setF({ ...f, urgent: e.target.checked })} /> Alerte urgente (SMS immédiat)</label>
          <Button type="submit" loading={busy}>Envoyer</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
