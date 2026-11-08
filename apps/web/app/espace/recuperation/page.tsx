'use client';

import { useState } from 'react';
import { LifeBuoy } from 'lucide-react';
import { Loader } from '@/components/espace/bits';
import { Badge, Button, Card, Dialog, DialogContent, Empty, Field, Input, PageHeader, Select, Textarea, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime, ROLE_LABEL } from '@/lib/format';
import { useAction, useApi } from '@/lib/use-api';

type Request = {
  id: string; userId: string; userName: string; userRoles: string[]; requestedById: string | null; requestedByName: string; requestedByPlatform: boolean;
  reason: string; identityCheck: string; identityNote: string | null; requiresPlatform: boolean; status: string;
  decidedByName: string | null; decidedByPlatform: boolean; decisionNote: string | null; decidedAt: string | null; expiresAt: string;
  activationExpiresAt: string | null; completedAt: string | null; createdAt: string; canDecide: boolean;
};
type Staff = { id: string; firstName: string; lastName: string; status: string; totpEnabled: boolean; roles: { role: string }[] };

const IDENTITY: Record<string, string> = {
  PIECE_IDENTITE: 'Pièce d’identité vue en personne',
  RAPPEL_NUMERO_CONNU: 'Rappel au numéro connu de l’établissement',
  CONNAISSANCE_PERSONNELLE: 'Personne connue, vue en personne',
  AUTRE: 'Autre vérification (à préciser)',
};
const STATUS: Record<string, [string, 'good' | 'bad' | 'warn' | undefined]> = {
  PENDING: ['En attente de validation', 'warn'],
  APPROVED: ['Validée : code remis, en attente du nouveau téléphone', 'warn'],
  COMPLETED: ['Terminée : nouveau téléphone configuré', 'good'],
  REJECTED: ['Refusée', 'bad'],
  CANCELLED: ['Annulée', undefined],
  EXPIRED: ['Expirée', undefined],
};

export default function Recuperation() {
  const { me } = useAuth();
  const q = useApi<Request[]>('/recovery-requests');
  const staff = useApi<Staff[]>('/staff');
  const toast = useToast();
  const { busy, run } = useAction();
  const [form, setForm] = useState({ userId: '', reason: '', identityCheck: '', identityNote: '' });
  const [decide, setDecide] = useState<{ r: Request; kind: 'approve' | 'reject' } | null>(null);
  const [note, setNote] = useState('');
  const [issued, setIssued] = useState<{ name: string; code: string; expiresAt: string } | null>(null);

  const candidates = (staff.data ?? []).filter((s) => s.id !== me?.user.id && s.status === 'ACTIVE' && s.totpEnabled);

  return (
    <>
      <PageHeader title="Récupération des comptes" subtitle="Quand une personne a perdu son téléphone et ses codes de récupération. Une autre personne que le demandeur valide toujours." />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <Card>
          <h2 className="mb-3 flex items-center gap-2 font-display text-lg font-bold"><LifeBuoy className="size-5" /> Nouvelle demande</h2>
          <form className="grid gap-3" onSubmit={async (e) => {
            e.preventDefault();
            const r = await run(() => api.post<{ id: string; requiresPlatform: boolean }>('/recovery-requests', { ...form, identityNote: form.identityNote || undefined }), toast);
            if (r) {
              toast(r.requiresPlatform ? 'Demande envoyée au support Cahiora pour validation' : 'Demande créée : une autre personne de la direction doit la valider');
              setForm({ userId: '', reason: '', identityCheck: '', identityNote: '' });
              q.reload();
            }
          }}>
            <Field label="Compte concerné" hint="Seuls les comptes qui utilisent la double authentification sont proposés. Votre propre compte n’y figure pas.">
              <Select value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })} required>
                <option value="">Choisir…</option>
                {candidates.map((s) => <option key={s.id} value={s.id}>{s.lastName} {s.firstName} ({s.roles.map((r) => ROLE_LABEL[r.role]).join(', ')})</option>)}
              </Select>
            </Field>
            <Field label="Vérification d’identité réalisée">
              <Select value={form.identityCheck} onChange={(e) => setForm({ ...form, identityCheck: e.target.value })} required>
                <option value="">Choisir…</option>
                {Object.entries(IDENTITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            <Field label="Précision sur la vérification" hint="Par exemple : CNI n° vue au bureau. N’écrivez jamais de mot de passe ni de code.">
              <Input value={form.identityNote} onChange={(e) => setForm({ ...form, identityNote: e.target.value })} required={form.identityCheck === 'AUTRE'} maxLength={500} />
            </Field>
            <Field label="Motif">
              <Textarea value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} required minLength={5} maxLength={500} placeholder="Téléphone volé le 12/11, codes de récupération perdus" />
            </Field>
            <p className="rounded-lg bg-sunk p-3 text-sm text-muted">La récupération d’un compte Direction est validée par le support Cahiora. Pour les autres comptes, une autre personne de la direction valide ; s’il n’y en a pas, le support Cahiora valide.</p>
            <Button type="submit" loading={busy}>Créer la demande</Button>
          </form>
        </Card>
        <Card>
          <h2 className="mb-3 font-display text-lg font-bold">Demandes</h2>
          <Loader {...q}>
            {(rows) => rows.length === 0 ? <Empty title="Aucune demande" /> : (
              <ul className="grid gap-3">{rows.map((r) => {
                const [label, tone] = STATUS[r.status] ?? [r.status, undefined];
                return (
                  <li key={r.id} className="grid gap-1.5 rounded-lg border border-line p-3 text-sm" data-testid="recovery-request">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <b>{r.userName} <span className="font-normal text-muted">({r.userRoles.map((x) => ROLE_LABEL[x]).join(', ')})</span></b>
                      <Badge tone={tone}>{label}</Badge>
                    </div>
                    <p>{r.reason}</p>
                    <p className="text-muted">Demandée par {r.requestedByPlatform ? 'le support Cahiora' : r.requestedByName} le {dateTime(r.createdAt)} · {IDENTITY[r.identityCheck] ?? r.identityCheck}{r.identityNote ? ` (${r.identityNote})` : ''}</p>
                    {r.requiresPlatform && r.status === 'PENDING' && <p className="font-bold text-warn">Validation par le support Cahiora</p>}
                    {r.decidedAt && <p className="text-muted">{r.status === 'REJECTED' || r.status === 'CANCELLED' ? 'Décision' : 'Validée'} par {r.decidedByPlatform ? 'le support Cahiora' : r.decidedByName} le {dateTime(r.decidedAt)}{r.decisionNote ? ` : ${r.decisionNote}` : ''}</p>}
                    {(r.canDecide || (r.status === 'PENDING' && r.requestedById === me?.user.id)) && (
                      <div className="flex flex-wrap gap-2 pt-1">
                        {r.canDecide && <Button size="sm" onClick={() => { setNote(''); setDecide({ r, kind: 'approve' }); }}>Valider</Button>}
                        <Button size="sm" variant="ghost" className="text-bad" onClick={() => { setNote(''); setDecide({ r, kind: 'reject' }); }}>{r.requestedById === me?.user.id ? 'Annuler' : 'Refuser'}</Button>
                      </div>
                    )}
                  </li>
                );
              })}</ul>
            )}
          </Loader>
        </Card>
      </div>

      <Dialog open={!!decide} onOpenChange={(o) => !o && setDecide(null)}>
        {decide && (
          <DialogContent title={decide.kind === 'approve' ? `Valider la récupération de ${decide.r.userName}` : 'Refuser ou annuler la demande'}
            description={decide.kind === 'approve' ? 'Son ancienne double authentification et ses codes seront retirés, toutes ses sessions coupées. Un code de réactivation valable 24 heures s’affichera une seule fois : remettez-le en main propre ou par appel au numéro connu, jamais par message.' : undefined}>
            <form className="grid gap-3" onSubmit={async (e) => {
              e.preventDefault();
              const id = decide.r.id;
              if (decide.kind === 'approve') {
                const r = await run(() => api.post<{ activationCode: string; expiresAt: string; user: { name: string } }>(`/recovery-requests/${id}/approve`, { note }), toast);
                if (r) setIssued({ name: r.user.name, code: r.activationCode, expiresAt: r.expiresAt });
              } else if (!(await run(() => api.post(`/recovery-requests/${id}/reject`, { note }), toast, 'Demande fermée'))) return;
              setDecide(null);
              q.reload();
            }}>
              <Field label={decide.kind === 'approve' ? 'Justification (vérification faite)' : 'Raison'}>
                <Input value={note} onChange={(e) => setNote(e.target.value)} required minLength={3} maxLength={500} autoFocus />
              </Field>
              <Button type="submit" loading={busy} variant={decide.kind === 'approve' ? undefined : 'outline'}>{decide.kind === 'approve' ? 'Valider et afficher le code' : 'Confirmer'}</Button>
            </form>
          </DialogContent>
        )}
      </Dialog>

      <Dialog open={!!issued} onOpenChange={(o) => !o && setIssued(null)}>
        {issued && (
          <DialogContent title="Code de réactivation" description={`À remettre à ${issued.name}, en main propre ou par appel au numéro connu. Il ne sera plus affiché.`}>
            <div className="grid gap-3" data-testid="activation-code">
              <p className="rounded-lg bg-sunk p-4 text-center font-mono text-3xl font-bold tracking-[0.3em]">{issued.code}</p>
              <p className="text-sm text-muted">Valable jusqu’au {dateTime(issued.expiresAt)}, pour une seule utilisation. À la connexion, {issued.name} saisit son mot de passe, ce code, puis configure son nouveau téléphone.</p>
              <Button onClick={() => setIssued(null)}>J’ai remis le code</Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
