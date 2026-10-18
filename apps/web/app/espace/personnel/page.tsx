'use client';

import { useState } from 'react';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { Loader, StatusBadge } from '@/components/espace/bits';
import { Button, Card, Dialog, DialogContent, Empty, Field, Input, PageHeader, Select, Table, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime, ROLE_LABEL } from '@/lib/format';
import { useAction, useApi } from '@/lib/use-api';

type Staff = { id: string; firstName: string; lastName: string; phone: string | null; email: string | null; status: string; lastLoginAt: string | null; totpEnabled: boolean; roles: { role: string; siteId: string | null }[]; assignments: { classSubject: { subject: { name: string }; class: { name: string } } }[] };
const STAFF_ROLES = ['DIRECTION', 'SECRETARIAT', 'ENSEIGNANT', 'VIE_SCOLAIRE', 'COMPTABLE'];

export default function Personnel() {
  const { me } = useAuth();
  const q = useApi<Staff[]>('/staff');
  const [edit, setEdit] = useState<Partial<Staff> & { roles: { role: string; siteId: string | null }[] } | null>(null);
  const [shown, setShown] = useState<{ name: string; password: string } | null>(null);
  const toast = useToast();
  const { busy, run } = useAction();
  const site = (id: string | null) => (id ? me?.sites.find((s) => s.id === id)?.name : null);

  return (
    <>
      <PageHeader title="Personnel" subtitle="Comptes du personnel, rôles et sites. Le mot de passe provisoire est envoyé par SMS." actions={<Button onClick={() => setEdit({ firstName: '', lastName: '', phone: '', email: '', roles: [{ role: 'ENSEIGNANT', siteId: null }] })}><Plus className="size-4" /> Nouveau compte</Button>} />
      <Card>
        <Loader {...q}>
          {(rows) => rows.length === 0 ? <Empty title="Aucun compte" /> : (
            <Table>
              <thead><tr><th>Nom</th><th>Téléphone</th><th>Rôles</th><th>Dernière connexion</th><th>Statut</th><th /></tr></thead>
              <tbody>{rows.map((s) => (
                <tr key={s.id}>
                  <td className="font-bold">{s.lastName} {s.firstName}{s.assignments.length > 0 && <span className="block text-xs font-normal text-muted">{s.assignments.slice(0, 3).map((a) => `${a.classSubject.subject.name} ${a.classSubject.class.name}`).join(' · ')}{s.assignments.length > 3 ? '…' : ''}</span>}</td>
                  <td className="whitespace-nowrap">{s.phone}</td>
                  <td>{s.roles.map((r) => `${ROLE_LABEL[r.role]}${site(r.siteId) ? ` (${site(r.siteId)})` : ''}`).join(', ')}</td>
                  <td className="whitespace-nowrap text-sm">{s.lastLoginAt ? dateTime(s.lastLoginAt) : 'Jamais'}</td>
                  <td><StatusBadge status={s.status} /></td>
                  <td className="whitespace-nowrap text-right">
                    <Button size="sm" variant="ghost" onClick={() => setEdit({ ...s, email: s.email ?? '', phone: s.phone ?? '' })}>Modifier</Button>
                    <Button size="sm" variant="ghost" loading={busy} onClick={async () => { const r = await run(() => api.post<{ temporaryPassword: string }>(`/users/${s.id}/reset-password`), toast); if (r) setShown({ name: `${s.firstName} ${s.lastName}`, password: r.temporaryPassword }); }}><KeyRound className="size-4" /> Réinitialiser</Button>
                  </td>
                </tr>
              ))}</tbody>
            </Table>
          )}
        </Loader>
      </Card>
      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        {edit && (
          <DialogContent title={edit.id ? 'Modifier le compte' : 'Nouveau compte'}>
            <form className="grid gap-3" onSubmit={async (e) => {
              e.preventDefault();
              const body = { firstName: edit.firstName, lastName: edit.lastName, phone: edit.phone, email: edit.email || undefined, roles: edit.roles.map((r) => ({ role: r.role, siteId: r.siteId || null })) };
              if (edit.id) {
                if (await run(() => api.patch(`/staff/${edit.id}`, { ...body, active: edit.status !== 'DISABLED' }), toast, 'Compte modifié')) { setEdit(null); q.reload(); }
              } else {
                const r = await run(() => api.post<{ temporaryPassword: string }>('/staff', body), toast, 'Compte créé');
                if (r) { setShown({ name: `${edit.firstName} ${edit.lastName}`, password: r.temporaryPassword }); setEdit(null); q.reload(); }
              }
            }}>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Nom"><Input value={edit.lastName ?? ''} onChange={(e) => setEdit({ ...edit, lastName: e.target.value })} required /></Field>
                <Field label="Prénoms"><Input value={edit.firstName ?? ''} onChange={(e) => setEdit({ ...edit, firstName: e.target.value })} required /></Field>
                <Field label="Téléphone"><Input type="tel" value={edit.phone ?? ''} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} required /></Field>
                <Field label="E-mail"><Input type="email" value={edit.email ?? ''} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
              </div>
              <p className="text-[13px] font-bold text-muted">Rôles</p>
              {edit.roles.map((r, i) => (
                <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
                  <Select aria-label="Rôle" value={r.role} onChange={(e) => setEdit({ ...edit, roles: edit.roles.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)) })}>{STAFF_ROLES.map((x) => <option key={x} value={x}>{ROLE_LABEL[x]}</option>)}</Select>
                  <Select aria-label="Site" value={r.siteId ?? ''} onChange={(e) => setEdit({ ...edit, roles: edit.roles.map((x, j) => (j === i ? { ...x, siteId: e.target.value || null } : x)) })}><option value="">Tous les sites</option>{me?.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
                  <Button type="button" variant="ghost" size="icon" aria-label="Retirer ce rôle" disabled={edit.roles.length === 1} onClick={() => setEdit({ ...edit, roles: edit.roles.filter((_, j) => j !== i) })}><Trash2 className="size-4" /></Button>
                </div>
              ))}
              <Button type="button" variant="ghost" onClick={() => setEdit({ ...edit, roles: [...edit.roles, { role: 'ENSEIGNANT', siteId: null }] })}><Plus className="size-4" /> Ajouter un rôle</Button>
              {edit.id && <label className="flex min-h-11 items-center gap-3 font-bold"><input type="checkbox" className="size-5" checked={edit.status !== 'DISABLED'} onChange={(e) => setEdit({ ...edit, status: e.target.checked ? 'ACTIVE' : 'DISABLED' })} /> Compte actif</label>}
              <Button type="submit" loading={busy}>Enregistrer</Button>
            </form>
          </DialogContent>
        )}
      </Dialog>
      <Dialog open={!!shown} onOpenChange={(o) => !o && setShown(null)}>
        {shown && (
          <DialogContent title="Mot de passe provisoire" description={`${shown.name} devra le changer à la première connexion. Il a aussi été envoyé par SMS.`}>
            <p className="rounded-lg bg-sunk p-4 text-center font-mono text-2xl font-bold">{shown.password}</p>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
