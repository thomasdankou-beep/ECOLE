'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { KeyRound, LogOut, Pencil, Plus, ShieldCheck } from 'lucide-react';
import { Badge, Button, Card, Chips, Dialog, DialogContent, Empty, ErrorNote, Field, Input, PageHeader, Table, Textarea, useToast } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { pf } from '@/lib/platform';

type Admin = { id: string; name: string; email: string; mustChangePassword: boolean; platformDomain: string | null };
type Tenant = {
  id: string; slug: string; name: string; shortName: string | null; country: string; status: 'ACTIVE' | 'SUSPENDED'; domain: string | null;
  platformNotes: string | null; createdAt: string; demo: boolean; students: number; staff: number; sites: number; lastActivityAt: string | null;
};
type Audit = { id: string; action: string; tenantId: string | null; createdAt: string; data: unknown };
type Secret = { title: string; school: string; identifier: string; password: string };

const ACTIONS: Record<string, string> = {
  'platform.auth.login': 'Connexion', 'platform.auth.failed': 'Échec de connexion', 'platform.auth.locked': 'Compte verrouillé',
  'platform.auth.password_changed': 'Mot de passe changé', 'platform.tenant.created': 'École créée', 'platform.tenant.updated': 'École modifiée',
  'platform.tenant.suspended': 'École suspendue', 'platform.tenant.reactivated': 'École réactivée', 'platform.tenant.director_reset': 'Mot de passe Direction remis',
  'platform.admin.created_cli': 'Compte Super Admin créé', 'platform.admin.reset_cli': 'Mot de passe Super Admin remis',
};
const when = (d: string | null) => (d ? new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—');

export default function Plateforme() {
  const router = useRouter();
  const [admin, setAdmin] = useState<Admin | null>(null);
  useEffect(() => {
    pf<Admin>('GET', '/me').then(setAdmin).catch((e) => { if (e instanceof ApiError && e.status === 401) router.replace('/plateforme/connexion'); });
  }, [router]);
  if (!admin) return null;
  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <span className="flex items-center gap-2 font-display text-xl font-bold text-brand"><ShieldCheck className="size-6" /> Administration de la plateforme</span>
        <span className="flex items-center gap-2 text-sm">
          <span className="font-bold">{admin.name}</span>
          <Button variant="ghost" size="sm" onClick={async () => { await pf('POST', '/auth/logout'); router.replace('/plateforme/connexion'); }}><LogOut className="size-4" /> Se déconnecter</Button>
        </span>
      </header>
      {admin.mustChangePassword ? <ChangePassword done={() => setAdmin({ ...admin, mustChangePassword: false })} /> : <Schools admin={admin} />}
    </div>
  );
}

function ChangePassword({ done }: { done: () => void }) {
  const [f, setF] = useState({ current: '', password: '', confirm: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Card className="mx-auto grid max-w-md gap-4">
      <h1 className="text-2xl font-bold">Choisissez votre mot de passe</h1>
      <p className="text-muted">Le mot de passe provisoire doit être remplacé avant d’accéder aux écoles. Au moins 12 caractères.</p>
      <form className="grid gap-3" onSubmit={async (e) => {
        e.preventDefault();
        if (f.password !== f.confirm) return setError(new Error('Les deux mots de passe ne correspondent pas'));
        setBusy(true);
        setError(null);
        try {
          await pf('POST', '/auth/password', { current: f.current, password: f.password });
          done();
        } catch (err) {
          setError(err);
        } finally {
          setBusy(false);
        }
      }}>
        <Field label="Mot de passe provisoire"><Input type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} required /></Field>
        <Field label="Nouveau mot de passe"><Input type="password" autoComplete="new-password" minLength={12} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required /></Field>
        <Field label="Confirmer"><Input type="password" autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} required /></Field>
        <ErrorNote error={error} />
        <Button type="submit" loading={busy}>Enregistrer</Button>
      </form>
    </Card>
  );
}

function Schools({ admin }: { admin: Admin }) {
  const toast = useToast();
  const [tab, setTab] = useState<'ecoles' | 'journal'>('ecoles');
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [edit, setEdit] = useState<Tenant | null>(null);
  const [secret, setSecret] = useState<Secret | null>(null);
  const load = useCallback(() => {
    pf<Tenant[]>('GET', '/tenants').then(setTenants).catch(setError);
    pf<Audit[]>('GET', '/audit').then(setAudit).catch(() => {});
  }, []);
  useEffect(load, [load]);
  const address = (t: Tenant) => t.domain ?? (admin.platformDomain ? `${t.slug}.${admin.platformDomain}` : `${t.slug} (domaine de la plateforme à configurer)`);
  const names = new Map((tenants ?? []).map((t) => [t.id, t.name]));

  async function toggle(t: Tenant) {
    const status = t.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
    try {
      await pf('PATCH', `/tenants/${t.id}`, { status });
      toast(status === 'SUSPENDED' ? `${t.name} est suspendue : plus aucune connexion possible` : `${t.name} est réactivée`);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Erreur', 'bad');
    }
  }
  async function reset(t: Tenant) {
    try {
      const r = await pf<{ identifier: string; name: string; temporaryPassword: string }>('POST', `/tenants/${t.id}/reset-director`);
      setSecret({ title: `Nouveau mot de passe pour ${r.name}`, school: t.name, identifier: r.identifier, password: r.temporaryPassword });
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Erreur', 'bad');
    }
  }

  return (
    <>
      <PageHeader title="Écoles clientes" subtitle="Chaque école a sa propre adresse, ses données séparées et son compte Direction." actions={<Button onClick={() => setCreating(true)}><Plus className="size-4" /> Nouvelle école</Button>} />
      {secret && <SecretCard s={secret} close={() => setSecret(null)} />}
      <Chips label="Rubrique" value={tab} onChange={setTab} options={[{ value: 'ecoles', label: 'Écoles' }, { value: 'journal', label: 'Journal' }]} />
      <ErrorNote error={error} />
      {tab === 'ecoles' && tenants && (tenants.length === 0 ? <Empty title="Aucune école">Créez la première école cliente.</Empty> : (
        <Card className="overflow-x-auto p-0">
          <Table>
            <thead><tr><th>École</th><th>Adresse</th><th>État</th><th className="text-right">Élèves</th><th className="text-right">Personnel</th><th className="text-right">Sites</th><th>Dernière connexion</th><th /></tr></thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.id}>
                  <td className="font-bold">{t.name}{t.demo && <Badge tone="info" className="ml-2">Démo</Badge>}</td>
                  <td className="text-sm">{address(t)}</td>
                  <td>{t.status === 'ACTIVE' ? <Badge tone="good">Active</Badge> : <Badge tone="bad">Suspendue</Badge>}</td>
                  <td className="text-right">{t.students}</td>
                  <td className="text-right">{t.staff}</td>
                  <td className="text-right">{t.sites}</td>
                  <td className="text-sm">{when(t.lastActivityAt)}</td>
                  <td>
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" aria-label={`Modifier ${t.name}`} onClick={() => setEdit(t)}><Pencil className="size-4" /></Button>
                      <Button variant="ghost" size="icon" aria-label={`Nouveau mot de passe Direction pour ${t.name}`} onClick={() => reset(t)}><KeyRound className="size-4" /></Button>
                      <Button variant="outline" size="sm" onClick={() => toggle(t)}>{t.status === 'ACTIVE' ? 'Suspendre' : 'Réactiver'}</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ))}
      {tab === 'journal' && (
        <Card className="overflow-x-auto p-0">
          <Table>
            <thead><tr><th>Date</th><th>Action</th><th>École</th></tr></thead>
            <tbody>{audit.map((a) => <tr key={a.id}><td className="text-sm">{when(a.createdAt)}</td><td>{ACTIONS[a.action] ?? a.action}</td><td>{a.tenantId ? names.get(a.tenantId) ?? '—' : '—'}</td></tr>)}</tbody>
          </Table>
        </Card>
      )}
      <Dialog open={creating} onOpenChange={setCreating}>
        {creating && <CreateDialog platformDomain={admin.platformDomain} done={(s) => { setCreating(false); setSecret(s); load(); }} />}
      </Dialog>
      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        {edit && <EditDialog t={edit} done={() => { setEdit(null); load(); }} />}
      </Dialog>
    </>
  );
}

function SecretCard({ s, close }: { s: Secret; close: () => void }) {
  return (
    <Card className="mb-4 grid gap-2 border-2 border-warn">
      <p className="font-bold">{s.title} · {s.school}</p>
      <p>Identifiant : <b>{s.identifier}</b></p>
      <p>Mot de passe provisoire : <b className="font-mono text-lg">{s.password}</b></p>
      <p className="text-sm text-muted">Il est affiché une seule fois et a aussi été envoyé par SMS. La personne devra le changer à sa première connexion.</p>
      <Button variant="outline" size="sm" className="justify-self-start" onClick={close}>J’ai noté le mot de passe</Button>
    </Card>
  );
}

function CreateDialog({ platformDomain, done }: { platformDomain: string | null; done: (s: Secret) => void }) {
  const [f, setF] = useState({ name: '', shortName: '', slug: '', matriculePrefix: '', domain: '', siteName: '', firstName: '', lastName: '', phone: '', email: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <DialogContent title="Nouvelle école" description="L’école démarre vide : la direction renseigne ensuite ses classes, frais, logo et textes.">
      <form className="grid gap-3" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const r = await pf<{ tenant: { name: string }; director: { identifier: string; temporaryPassword: string } }>('POST', '/tenants', {
            name: f.name, shortName: f.shortName || undefined, slug: f.slug, matriculePrefix: f.matriculePrefix, domain: f.domain || undefined, siteName: f.siteName,
            director: { firstName: f.firstName, lastName: f.lastName, phone: f.phone, email: f.email || undefined },
          });
          done({ title: 'École créée. Compte Direction', school: r.tenant.name, identifier: r.director.identifier, password: r.director.temporaryPassword });
        } catch (err) {
          setError(err);
        } finally {
          setBusy(false);
        }
      }}>
        <Field label="Nom complet"><Input value={f.name} onChange={set('name')} required minLength={3} maxLength={160} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Nom court"><Input value={f.shortName} onChange={set('shortName')} maxLength={60} /></Field>
          <Field label="Préfixe des matricules" hint="2 à 5 lettres, ex. CSL"><Input value={f.matriculePrefix} onChange={(e) => setF({ ...f, matriculePrefix: e.target.value.toUpperCase() })} required pattern="[A-Z]{2,5}" maxLength={5} /></Field>
        </div>
        <Field label="Identifiant de l’adresse" hint={platformDomain ? `L’école sera sur ${f.slug || 'identifiant'}.${platformDomain}` : 'Lettres minuscules, chiffres et tirets.'}>
          <Input value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value.toLowerCase() })} required pattern="[a-z0-9][a-z0-9-]{1,28}[a-z0-9]" maxLength={30} />
        </Field>
        <Field label="Nom de domaine propre (facultatif)" hint="Si l’école a déjà le sien, ex. www.monecole.bj"><Input value={f.domain} onChange={set('domain')} maxLength={120} /></Field>
        <Field label="Premier site" hint="Ex. le quartier ou la ville du campus principal."><Input value={f.siteName} onChange={set('siteName')} required maxLength={120} /></Field>
        <p className="pt-2 font-bold">Chef d’établissement (premier compte Direction)</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Prénom"><Input value={f.firstName} onChange={set('firstName')} required maxLength={80} /></Field>
          <Field label="Nom"><Input value={f.lastName} onChange={set('lastName')} required maxLength={80} /></Field>
          <Field label="Téléphone" hint="Il recevra son mot de passe par SMS."><Input type="tel" value={f.phone} onChange={set('phone')} required maxLength={30} /></Field>
          <Field label="E-mail (facultatif)"><Input type="email" value={f.email} onChange={set('email')} maxLength={120} /></Field>
        </div>
        <ErrorNote error={error} />
        <Button type="submit" loading={busy}>Créer l’école</Button>
      </form>
    </DialogContent>
  );
}

function EditDialog({ t, done }: { t: Tenant; done: () => void }) {
  const [f, setF] = useState({ name: t.name, shortName: t.shortName ?? '', domain: t.domain ?? '', platformNotes: t.platformNotes ?? '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <DialogContent title={`Modifier ${t.name}`}>
      <form className="grid gap-3" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await pf('PATCH', `/tenants/${t.id}`, { name: f.name, shortName: f.shortName || null, domain: f.domain || null, platformNotes: f.platformNotes || null });
          done();
        } catch (err) {
          setError(err);
        } finally {
          setBusy(false);
        }
      }}>
        <Field label="Nom complet"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={3} maxLength={160} /></Field>
        <Field label="Nom court"><Input value={f.shortName} onChange={(e) => setF({ ...f, shortName: e.target.value })} maxLength={60} /></Field>
        <Field label="Nom de domaine propre"><Input value={f.domain} onChange={(e) => setF({ ...f, domain: e.target.value })} maxLength={120} /></Field>
        <Field label="Notes internes" hint="Visibles seulement ici : contact, contrat, remarques."><Textarea value={f.platformNotes} onChange={(e) => setF({ ...f, platformNotes: e.target.value })} rows={3} maxLength={4000} /></Field>
        <ErrorNote error={error} />
        <Button type="submit" loading={busy}>Enregistrer</Button>
      </form>
    </DialogContent>
  );
}
