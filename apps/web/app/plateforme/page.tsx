'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { KeyRound, LifeBuoy, LogOut, Network, Pencil, Plus, ShieldCheck } from 'lucide-react';
import { RecoveryCodesPanel } from '@/components/recovery-codes';
import { Badge, Button, Card, Chips, Dialog, DialogContent, Empty, ErrorNote, Field, Input, PageHeader, Select, Table, Textarea, useToast } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { pf } from '@/lib/platform';
import { GroupDialog, Groups, MoveDialog, PLATFORM_GROUP_ACTIONS, platformGroupDetail, type Group, type GroupRef } from './groupes';

type Admin = { id: string; name: string; email: string; mustChangePassword: boolean; totpEnabled: boolean; mustSetupTwoFactor?: boolean; platformDomain: string | null };
type Tenant = {
  id: string; slug: string; name: string; shortName: string | null; country: string; currency: string; timezone: string; status: 'ACTIVE' | 'SUSPENDED'; domain: string | null;
  platformNotes: string | null; smsSender: string | null; createdAt: string; demo: boolean; students: number; staff: number; sites: number; lastActivityAt: string | null;
  group: GroupRef; groupJoinedAt: string;
};
type Audit = { id: string; action: string; tenantId: string | null; createdAt: string; data: unknown; adminName: string | null; ip: string | null };
type Secret = { title: string; school: string; identifier: string; password: string };

const ACTIONS: Record<string, string> = {
  'platform.auth.login': 'Connexion', 'platform.auth.failed': 'Échec de connexion', 'platform.auth.locked': 'Compte verrouillé',
  'platform.auth.password_changed': 'Mot de passe changé', 'platform.tenant.created': 'École créée', 'platform.tenant.updated': 'École modifiée',
  'platform.tenant.suspended': 'École suspendue', 'platform.tenant.reactivated': 'École réactivée', 'platform.tenant.director_reset': 'Mot de passe Direction remis',
  'platform.admin.created_cli': 'Compte Super Admin créé', 'platform.admin.reset_cli': 'Récupération exceptionnelle du Super Admin (commande serveur)',
  'platform.auth.recovery_code_used': 'Connexion avec un code de récupération', 'platform.auth.recovery_code_failed': 'Code de récupération incorrect',
  'platform.auth.recovery_codes_generated': 'Codes de récupération créés', 'platform.recovery.requested': 'Demande de récupération d’un compte d’école',
  'platform.recovery.approved': 'Récupération d’un compte d’école validée', 'platform.recovery.rejected': 'Récupération d’un compte d’école refusée',
  'platform.auth.logout': 'Déconnexion', 'platform.auth.2fa_failed': 'Code de double authentification incorrect',
  'platform.auth.2fa_enabled': 'Double authentification activée', 'platform.auth.2fa_reset': 'Double authentification reconfigurée',
  'platform.auth.refused': 'Connexion refusée (compte bloqué ou désactivé)', 'platform.auth.unknown_identifier': 'Connexion avec un e-mail inconnu',
  ...PLATFORM_GROUP_ACTIONS,
};
type Country = { code: string; name: string; dial: string; currency: string; timezone: string; einvoice: string | null };
type Locale = { country: string; currency: string; timezone: string };

/** Pays pris en charge par la plateforme (indicatif, monnaie et fuseau par défaut). */
function useCountries() {
  const [list, setList] = useState<Country[]>([]);
  useEffect(() => {
    pf<Country[]>('GET', '/countries').then(setList).catch(() => setList([]));
  }, []);
  return list;
}

const currencyName = (c: string) => (c === 'XOF' ? 'Franc CFA (XOF)' : c === 'XAF' ? 'Franc CFA (XAF)' : c === 'GNF' ? 'Franc guinéen (GNF)' : c);

/** Pays, monnaie et fuseau horaire : choisir le pays remplit les deux autres, qui restent modifiables. */
function LocaleFields({ value, onChange, countries }: { value: Locale; onChange: (v: Locale) => void; countries: Country[] }) {
  const current = countries.find((c) => c.code === value.country);
  const currencies = [...new Set(countries.map((c) => c.currency))];
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Field label="Pays" hint={current ? `Indicatif +${current.dial}` : undefined}>
        <Select value={value.country} onChange={(e) => {
          const c = countries.find((x) => x.code === e.target.value);
          onChange(c ? { country: c.code, currency: c.currency, timezone: c.timezone } : { ...value, country: e.target.value });
        }} required>
          {!countries.length && <option value={value.country}>{value.country}</option>}
          {countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
        </Select>
      </Field>
      <Field label="Monnaie">
        <Select value={value.currency} onChange={(e) => onChange({ ...value, currency: e.target.value })} required>
          {(currencies.length ? currencies : [value.currency]).map((c) => <option key={c} value={c}>{currencyName(c)}</option>)}
        </Select>
      </Field>
      <Field label="Fuseau horaire" hint="Pour la date du jour de l’appel et des relances."><Input value={value.timezone} onChange={(e) => onChange({ ...value, timezone: e.target.value })} required maxLength={60} /></Field>
    </div>
  );
}

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
      {admin.mustChangePassword ? <ChangePassword done={() => setAdmin({ ...admin, mustChangePassword: false })} /> : (
        <>
          {(!admin.totpEnabled || admin.mustSetupTwoFactor) && <TwoFactor required={!!admin.mustSetupTwoFactor} done={() => setAdmin({ ...admin, totpEnabled: true, mustSetupTwoFactor: false })} />}
          {!admin.mustSetupTwoFactor && (
            <>
              {admin.totpEnabled && <AccountSecurity email={admin.email} />}
              <Schools admin={admin} />
            </>
          )}
        </>
      )}
    </div>
  );
}

/** Double authentification du Super Admin (SEC-021) : proposée tant qu'elle n'est pas active. */
function TwoFactor({ done, required }: { done: () => void; required?: boolean }) {
  const [setup, setSetup] = useState<{ qr: string; secret: string; setupToken: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Card className="mb-4 grid gap-3 border-warn">
      <h2 className="flex items-center gap-2 text-lg font-bold"><KeyRound className="size-5" /> {required ? 'Nouvelle double authentification obligatoire' : 'Activez la double authentification'}</h2>
      {required && <p className="font-bold text-warn">Votre compte a été récupéré par la procédure exceptionnelle. Configurez votre nouveau téléphone pour accéder aux écoles.</p>}
      {codes ? (
        <div className="max-w-md"><RecoveryCodesPanel codes={codes} doneLabel="Accéder aux écoles" onDone={done} /></div>
      ) : setup ? (
        <form className="grid max-w-sm gap-3" onSubmit={(e) => { e.preventDefault(); act(async () => { const r = await pf<{ recoveryCodes?: string[] }>('POST', '/auth/2fa/enable', { code: code.trim(), setupToken: setup.setupToken }); if (r.recoveryCodes?.length) setCodes(r.recoveryCodes); else done(); }); }}>
          <p className="text-sm">Scannez ce QR code avec Google Authenticator ou une application équivalente, puis saisissez le code affiché.</p>
          <img src={setup.qr} alt="QR code de configuration" className="mx-auto size-44 rounded bg-white p-2" />
          <p className="break-all text-center font-mono text-xs text-muted">{setup.secret}</p>
          <Field label="Code à 6 chiffres"><Input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required className="text-center font-mono text-xl tracking-[0.3em]" /></Field>
          <ErrorNote error={error} />
          <Button type="submit" loading={busy}>Activer</Button>
        </form>
      ) : (
        <div className="grid gap-3">
          <p className="text-muted">Ce compte peut créer, suspendre et réinitialiser toutes les écoles. Avec la double authentification, votre mot de passe seul ne suffit plus : un code de votre téléphone est demandé à chaque connexion.</p>
          <ErrorNote error={error} />
          <Button className="justify-self-start" variant="outline" loading={busy} onClick={() => act(async () => setSetup(await pf('POST', '/auth/2fa/setup', {})))}>Configurer</Button>
        </div>
      )}
    </Card>
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
  const [tab, setTab] = useState<'ecoles' | 'groupes' | 'recuperation' | 'journal'>('ecoles');
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [newGroup, setNewGroup] = useState(false);
  const [edit, setEdit] = useState<Tenant | null>(null);
  const [move, setMove] = useState<Tenant | null>(null);
  const [secret, setSecret] = useState<Secret | null>(null);
  const countries = useCountries();
  const load = useCallback(() => {
    pf<Tenant[]>('GET', '/tenants').then(setTenants).catch(setError);
    pf<Group[]>('GET', '/groups').then(setGroups).catch(setError);
    pf<Audit[]>('GET', '/audit').then(setAudit).catch(() => {});
  }, []);
  useEffect(load, [load]);
  const address = (t: Tenant) => t.domain ?? (admin.platformDomain ? `${t.slug}.${admin.platformDomain}` : `${t.slug} (domaine de la plateforme à configurer)`);
  const names = new Map((tenants ?? []).map((t) => [t.id, t.name]));
  const members = new Map<string, number>();
  for (const t of tenants ?? []) members.set(t.group.id, (members.get(t.group.id) ?? 0) + 1);

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
      {tab === 'groupes' ? (
        <PageHeader title="Groupes scolaires" subtitle="Le compte client : une ou plusieurs écoles, une seule facture plus tard." actions={<Button onClick={() => setNewGroup(true)}><Plus className="size-4" /> Nouveau groupe</Button>} />
      ) : (
        <PageHeader title="Écoles clientes" subtitle="Chaque école a sa propre adresse, ses données séparées et son compte Direction." actions={<Button onClick={() => setCreating(true)}><Plus className="size-4" /> Nouvelle école</Button>} />
      )}
      {secret && <SecretCard s={secret} close={() => setSecret(null)} />}
      <Chips label="Rubrique" value={tab} onChange={setTab} options={[{ value: 'ecoles', label: 'Écoles' }, { value: 'groupes', label: 'Groupes' }, { value: 'recuperation', label: 'Récupération des comptes' }, { value: 'journal', label: 'Journal' }]} />
      <ErrorNote error={error} />
      {tab === 'ecoles' && tenants && (tenants.length === 0 ? <Empty title="Aucune école">Créez la première école cliente.</Empty> : (
        <Card className="overflow-x-auto p-0">
          <Table>
            <thead><tr><th>École</th><th>Groupe</th><th>Adresse</th><th>Pays</th><th>État</th><th className="text-right">Élèves</th><th className="text-right">Personnel</th><th className="text-right">Sites</th><th>Dernière connexion</th><th /></tr></thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.id}>
                  <td className="font-bold">{t.name}{t.demo && <Badge tone="info" className="ml-2">Démo</Badge>}</td>
                  <td className="text-sm">{t.group.name}{(members.get(t.group.id) ?? 0) <= 1 && <span className="block text-xs text-muted">indépendante</span>}</td>
                  <td className="text-sm">{address(t)}</td>
                  <td className="text-sm">{t.country}</td>
                  <td>{t.status === 'ACTIVE' ? <Badge tone="good">Active</Badge> : <Badge tone="bad">Suspendue</Badge>}</td>
                  <td className="text-right">{t.students}</td>
                  <td className="text-right">{t.staff}</td>
                  <td className="text-right">{t.sites}</td>
                  <td className="text-sm">{when(t.lastActivityAt)}</td>
                  <td>
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" aria-label={`Modifier ${t.name}`} onClick={() => setEdit(t)}><Pencil className="size-4" /></Button>
                      <Button variant="ghost" size="icon" aria-label={`Changer le groupe de ${t.name}`} onClick={() => setMove(t)}><Network className="size-4" /></Button>
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
      {tab === 'groupes' && <Groups groups={groups} countries={countries} reload={load} />}
      {tab === 'recuperation' && tenants && <Recoveries tenants={tenants} reload={load} />}
      {tab === 'journal' && (
        <Card className="overflow-x-auto p-0">
          <Table>
            <thead><tr><th>Date</th><th>Administrateur</th><th>Action</th><th>École</th><th>Adresse IP</th></tr></thead>
            <tbody>{audit.map((a) => {
              const detail = platformGroupDetail(a.action, a.data);
              return (
                <tr key={a.id}>
                  <td className="text-sm">{when(a.createdAt)}</td><td className="font-bold">{a.adminName ?? '—'}</td>
                  <td>{ACTIONS[a.action] ?? a.action}{detail && <span className="block text-xs text-muted">{detail}</span>}</td>
                  <td>{a.tenantId ? names.get(a.tenantId) ?? '—' : '—'}</td><td className="font-mono text-xs">{a.ip ?? ''}</td>
                </tr>
              );
            })}</tbody>
          </Table>
        </Card>
      )}
      <Dialog open={creating} onOpenChange={setCreating}>
        {creating && <CreateDialog platformDomain={admin.platformDomain} groups={groups} done={(s) => { setCreating(false); setSecret(s); load(); }} />}
      </Dialog>
      <Dialog open={newGroup} onOpenChange={setNewGroup}>
        {newGroup && <GroupDialog g={null} countries={countries} done={() => { setNewGroup(false); toast('Groupe créé'); load(); }} />}
      </Dialog>
      <Dialog open={!!move} onOpenChange={(o) => !o && setMove(null)}>
        {move && <MoveDialog t={move} groups={groups} done={(message) => { setMove(null); toast(message); load(); }} />}
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

function CreateDialog({ platformDomain, groups, done }: { platformDomain: string | null; groups: Group[]; done: (s: Secret) => void }) {
  const [f, setF] = useState({ name: '', shortName: '', slug: '', matriculePrefix: '', domain: '', siteName: '', firstName: '', lastName: '', phone: '', email: '', groupId: '' });
  const countries = useCountries();
  const [loc, setLoc] = useState<Locale>({ country: 'BJ', currency: 'XOF', timezone: 'Africa/Porto-Novo' });
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
            name: f.name, shortName: f.shortName || undefined, slug: f.slug, matriculePrefix: f.matriculePrefix, domain: f.domain || undefined, siteName: f.siteName, ...loc,
            groupId: f.groupId || undefined,
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
        <Field label="Groupe scolaire" hint="Une école indépendante forme un groupe à elle seule, à son nom. Toutes les écoles d’un groupe comptent dans la même monnaie.">
          <Select value={f.groupId} onChange={(e) => setF({ ...f, groupId: e.target.value })}>
            <option value="">Nouveau groupe à son nom (école indépendante)</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </Select>
        </Field>
        <LocaleFields value={loc} onChange={setLoc} countries={countries} />
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
          <Field label="Téléphone" hint={`Il recevra son mot de passe par SMS. Sans indicatif, +${countries.find((c) => c.code === loc.country)?.dial ?? '229'} est ajouté.`}><Input type="tel" value={f.phone} onChange={set('phone')} required maxLength={30} /></Field>
          <Field label="E-mail (facultatif)"><Input type="email" value={f.email} onChange={set('email')} maxLength={120} /></Field>
        </div>
        <ErrorNote error={error} />
        <Button type="submit" loading={busy}>Créer l’école</Button>
      </form>
    </DialogContent>
  );
}

function EditDialog({ t, done }: { t: Tenant; done: () => void }) {
  const [f, setF] = useState({ name: t.name, shortName: t.shortName ?? '', domain: t.domain ?? '', platformNotes: t.platformNotes ?? '', smsSender: t.smsSender ?? '' });
  const countries = useCountries();
  const [loc, setLoc] = useState<Locale>({ country: t.country, currency: t.currency, timezone: t.timezone });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <DialogContent title={`Modifier ${t.name}`}>
      <form className="grid gap-3" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await pf('PATCH', `/tenants/${t.id}`, { name: f.name, shortName: f.shortName || null, domain: f.domain || null, platformNotes: f.platformNotes || null, smsSender: f.smsSender.trim() || null, ...loc });
          done();
        } catch (err) {
          setError(err);
        } finally {
          setBusy(false);
        }
      }}>
        <Field label="Nom complet"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={3} maxLength={160} /></Field>
        <Field label="Nom court"><Input value={f.shortName} onChange={(e) => setF({ ...f, shortName: e.target.value })} maxLength={60} /></Field>
        <LocaleFields value={loc} onChange={setLoc} countries={countries} />
        <Field label="Nom de domaine propre"><Input value={f.domain} onChange={(e) => setF({ ...f, domain: e.target.value })} maxLength={120} /></Field>
        <Field label="Nom d’expéditeur des SMS" hint="Tel qu’enregistré chez le fournisseur SMS (11 caractères au plus, sans accent, ex. ST KISITO). Vide : nom de la plateforme. Ne le saisissez qu’une fois validé par les opérateurs."><Input value={f.smsSender} onChange={(e) => setF({ ...f, smsSender: e.target.value })} maxLength={11} placeholder="ST KISITO" /></Field>
        <Field label="Notes internes" hint="Visibles seulement ici : contact, contrat, remarques."><Textarea value={f.platformNotes} onChange={(e) => setF({ ...f, platformNotes: e.target.value })} rows={3} maxLength={4000} /></Field>
        <ErrorNote error={error} />
        <Button type="submit" loading={busy}>Enregistrer</Button>
      </form>
    </DialogContent>
  );
}

type Setup = { qr: string; secret: string; setupToken: string };

/**
 * Sécurité du compte Super Admin : codes de récupération, changement de téléphone. Après une connexion avec un code
 * de récupération, un jeton de 10 minutes permet de configurer le nouveau téléphone sans le code de l'ancien.
 */
function AccountSecurity({ email }: { email: string }) {
  const [st, setSt] = useState<{ total: number; remaining: number; createdAt: string | null } | null>(null);
  const [ask, setAsk] = useState<'regen' | 'phone' | null>(null);
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<Setup | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [params] = useState(() => (typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search)));
  const [token] = useState(() => {
    if (params.get('reconfigurer') !== '1') return null;
    try { return sessionStorage.getItem('erp.pf.reconfigure'); } catch { return null; }
  });
  const load = useCallback(() => { pf<{ total: number; remaining: number; createdAt: string | null }>('GET', '/auth/recovery-codes').then(setSt).catch(() => setSt(null)); }, []);
  useEffect(load, [load]);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const low = st && (st.total === 0 || st.remaining <= 3);

  if (codes) return <Card className="mb-4 max-w-xl"><RecoveryCodesPanel codes={codes} account={email} doneLabel="C’est noté" onDone={() => { setCodes(null); load(); }} /></Card>;
  if (setup) {
    return (
      <Card className="mb-4 max-w-sm">
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); act(async () => {
          const r = await pf<{ recoveryCodes?: string[] }>('POST', '/auth/2fa/enable', { code: code.trim(), setupToken: setup.setupToken });
          try { sessionStorage.removeItem('erp.pf.reconfigure'); } catch { /* rien à effacer */ }
          setSetup(null); setCode('');
          if (r.recoveryCodes?.length) setCodes(r.recoveryCodes);
        }); }}>
          <p className="text-sm font-bold">Scannez ce QR code avec le nouveau téléphone, puis saisissez le code affiché.</p>
          <img src={setup.qr} alt="QR code de configuration" className="mx-auto size-44 rounded bg-white p-2" />
          <p className="break-all text-center font-mono text-xs text-muted">{setup.secret}</p>
          <Field label="Code à 6 chiffres"><Input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required className="text-center font-mono text-xl tracking-[0.3em]" /></Field>
          <ErrorNote error={error} />
          <Button type="submit" loading={busy}>Utiliser ce nouveau téléphone</Button>
          <Button type="button" variant="ghost" onClick={() => setSetup(null)}>Annuler</Button>
        </form>
      </Card>
    );
  }
  if (!token && !low && !ask) {
    return (
      <p className="mb-3 flex flex-wrap items-center gap-2 text-sm text-muted">
        <KeyRound className="size-4" /> Codes de récupération : {st ? `${st.remaining} sur ${st.total}` : '…'}
        <button type="button" className="cursor-pointer font-bold text-brand" onClick={() => setAsk('regen')}>Créer de nouveaux codes</button>
        <button type="button" className="cursor-pointer font-bold text-brand" onClick={() => setAsk('phone')}>Changer de téléphone</button>
      </p>
    );
  }
  return (
    <Card className="mb-4 grid max-w-xl gap-3 border-warn">
      {token ? (
        <>
          <p className="font-bold text-warn">Vous vous êtes connecté avec un code de récupération{params.get('restants') ? ` (il vous en reste ${params.get('restants')})` : ''}. Configurez maintenant votre nouveau téléphone.</p>
          <ErrorNote error={error} />
          <Button className="justify-self-start" loading={busy} onClick={() => act(async () => setSetup(await pf<Setup>('POST', '/auth/2fa/setup', { reconfigureToken: token })))}>Configurer mon nouveau téléphone</Button>
        </>
      ) : ask ? (
        <form className="grid max-w-sm gap-3" onSubmit={(e) => { e.preventDefault(); act(async () => {
          if (ask === 'phone') setSetup(await pf<Setup>('POST', '/auth/2fa/setup', { code: code.trim() }));
          else setCodes((await pf<{ recoveryCodes: string[] }>('POST', '/auth/recovery-codes', { code: code.trim() })).recoveryCodes);
          setAsk(null); setCode('');
        }); }}>
          <Field label="Code actuel de votre application" hint={ask === 'regen' ? 'Les anciens codes de récupération cesseront de fonctionner.' : undefined}>
            <Input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required autoFocus className="text-center font-mono text-xl tracking-[0.3em]" />
          </Field>
          <ErrorNote error={error} />
          <div className="flex gap-2"><Button type="submit" loading={busy}>Continuer</Button><Button type="button" variant="ghost" onClick={() => { setAsk(null); setCode(''); }}>Annuler</Button></div>
        </form>
      ) : (
        <>
          <p className="font-bold text-warn">{st?.total === 0 ? 'Vous n’avez pas encore de codes de récupération. Sans eux, la perte de votre téléphone impose la procédure exceptionnelle sur le serveur.' : `Il ne vous reste que ${st?.remaining} codes de récupération.`}</p>
          <Button className="justify-self-start" variant="outline" onClick={() => setAsk('regen')}>{st?.total === 0 ? 'Créer mes codes de récupération' : 'Créer de nouveaux codes'}</Button>
        </>
      )}
    </Card>
  );
}

type RecoveryReq = {
  id: string; tenantId: string; tenantName: string; userId: string; userName: string; userRoles: string[]; requestedByName: string; requestedByPlatform: boolean;
  reason: string; identityCheck: string; identityNote: string | null; status: string; decidedByName: string | null; decisionNote: string | null; decidedAt: string | null; createdAt: string;
};
type RecoveryAccount = { id: string; name: string; identifier: string; totpEnabled: boolean; twoFactorReenroll: boolean; roles: string[] };
const IDENTITY: Record<string, string> = {
  PIECE_IDENTITE: 'Pièce d’identité vue en personne', RAPPEL_NUMERO_CONNU: 'Rappel au numéro connu de l’école',
  CONNAISSANCE_PERSONNELLE: 'Personne connue, vue en personne', AUTRE: 'Autre vérification (à préciser)',
};
const RSTATUS: Record<string, string> = {
  PENDING: 'En attente', APPROVED: 'Validée, code remis', COMPLETED: 'Terminée', REJECTED: 'Refusée', CANCELLED: 'Annulée', EXPIRED: 'Expirée',
};

/** Récupération des comptes Direction (et des écoles sans second validateur) : vérification d'identité, puis code de réactivation. */
function Recoveries({ tenants, reload }: { tenants: Tenant[]; reload: () => void }) {
  const toast = useToast();
  const [rows, setRows] = useState<RecoveryReq[]>([]);
  const [tenantId, setTenantId] = useState('');
  const [accounts, setAccounts] = useState<RecoveryAccount[]>([]);
  const [f, setF] = useState({ userId: '', reason: '', identityCheck: '', identityNote: '' });
  const [decide, setDecide] = useState<{ r: RecoveryReq; kind: 'approve' | 'reject' } | null>(null);
  const [note, setNote] = useState('');
  const [issued, setIssued] = useState<{ name: string; code: string; expiresAt: string; school: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { pf<RecoveryReq[]>('GET', '/recovery-requests').then(setRows).catch(() => setRows([])); }, []);
  useEffect(load, [load]);
  useEffect(() => {
    setAccounts([]);
    if (tenantId) pf<RecoveryAccount[]>('GET', `/tenants/${tenantId}/recovery-accounts`).then(setAccounts).catch(() => setAccounts([]));
  }, [tenantId]);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (e) { toast(e instanceof Error ? e.message : 'Erreur', 'bad'); } finally { setBusy(false); }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
      <Card>
        <h2 className="mb-3 flex items-center gap-2 text-lg font-bold"><LifeBuoy className="size-5" /> Nouvelle demande</h2>
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); act(async () => {
          await pf('POST', `/tenants/${tenantId}/recovery-requests`, { ...f, identityNote: f.identityNote || undefined });
          toast('Demande créée : elle doit maintenant être validée');
          setF({ userId: '', reason: '', identityCheck: '', identityNote: '' });
          load(); reload();
        }); }}>
          <Field label="École"><Select value={tenantId} onChange={(e) => setTenantId(e.target.value)} required><option value="">Choisir…</option>{tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
          <Field label="Compte" hint="Comptes Direction et comptes avec double authentification. Le numéro est masqué : vérifiez-le auprès de la personne.">
            <Select value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })} required>
              <option value="">Choisir…</option>
              {accounts.map((a) => <option key={a.id} value={a.id} disabled={!a.totpEnabled}>{a.name} · {a.identifier}{a.totpEnabled ? '' : a.twoFactorReenroll ? ' (réactivation en cours)' : ' (sans double authentification)'}</option>)}
            </Select>
          </Field>
          <Field label="Vérification d’identité réalisée"><Select value={f.identityCheck} onChange={(e) => setF({ ...f, identityCheck: e.target.value })} required><option value="">Choisir…</option>{Object.entries(IDENTITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <Field label="Précision sur la vérification" hint="Jamais de mot de passe ni de code."><Input value={f.identityNote} onChange={(e) => setF({ ...f, identityNote: e.target.value })} required={f.identityCheck === 'AUTRE'} maxLength={500} /></Field>
          <Field label="Motif"><Textarea value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} required minLength={5} maxLength={500} /></Field>
          <Button type="submit" loading={busy}>Créer la demande</Button>
        </form>
      </Card>
      <Card>
        <h2 className="mb-3 text-lg font-bold">Demandes à traiter par la plateforme</h2>
        {rows.length === 0 ? <Empty title="Aucune demande" /> : (
          <ul className="grid gap-3">{rows.map((r) => (
            <li key={r.id} className="grid gap-1 rounded-lg border border-line p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2"><b>{r.userName} · {r.tenantName}</b><Badge tone={r.status === 'PENDING' ? 'warn' : r.status === 'COMPLETED' ? 'good' : undefined}>{RSTATUS[r.status] ?? r.status}</Badge></div>
              <p>{r.reason}</p>
              <p className="text-muted">Demandée par {r.requestedByPlatform ? `le Super Admin (${r.requestedByName})` : r.requestedByName} le {when(r.createdAt)} · {IDENTITY[r.identityCheck] ?? r.identityCheck}{r.identityNote ? ` (${r.identityNote})` : ''}</p>
              {r.decidedAt && <p className="text-muted">Décision de {r.decidedByName} le {when(r.decidedAt)}{r.decisionNote ? ` : ${r.decisionNote}` : ''}</p>}
              {r.status === 'PENDING' && (
                <div className="flex gap-2 pt-1">
                  <Button size="sm" onClick={() => { setNote(''); setDecide({ r, kind: 'approve' }); }}>Valider</Button>
                  <Button size="sm" variant="ghost" className="text-bad" onClick={() => { setNote(''); setDecide({ r, kind: 'reject' }); }}>Refuser</Button>
                </div>
              )}
            </li>
          ))}</ul>
        )}
      </Card>
      <Dialog open={!!decide} onOpenChange={(o) => !o && setDecide(null)}>
        {decide && (
          <DialogContent title={decide.kind === 'approve' ? `Valider la récupération de ${decide.r.userName}` : 'Refuser la demande'}
            description={decide.kind === 'approve' ? 'L’ancienne double authentification et les codes de ce compte seront retirés et ses sessions coupées. Le code de réactivation (24 heures) s’affichera une seule fois.' : undefined}>
            <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); act(async () => {
              const r = decide.r;
              if (decide.kind === 'approve') {
                const out = await pf<{ activationCode: string; expiresAt: string; user: { name: string } }>('POST', `/tenants/${r.tenantId}/recovery-requests/${r.id}/approve`, { note });
                setIssued({ name: out.user.name, code: out.activationCode, expiresAt: out.expiresAt, school: r.tenantName });
              } else await pf('POST', `/tenants/${r.tenantId}/recovery-requests/${r.id}/reject`, { note });
              setDecide(null);
              load();
            }); }}>
              <Field label={decide.kind === 'approve' ? 'Justification (vérification faite)' : 'Raison'}><Input value={note} onChange={(e) => setNote(e.target.value)} required minLength={3} maxLength={500} autoFocus /></Field>
              <Button type="submit" loading={busy}>{decide.kind === 'approve' ? 'Valider et afficher le code' : 'Confirmer'}</Button>
            </form>
          </DialogContent>
        )}
      </Dialog>
      <Dialog open={!!issued} onOpenChange={(o) => !o && setIssued(null)}>
        {issued && (
          <DialogContent title="Code de réactivation" description={`À remettre à ${issued.name} (${issued.school}) par appel au numéro connu, jamais par message. Il ne sera plus affiché.`}>
            <div className="grid gap-3">
              <p className="rounded-lg bg-sunk p-4 text-center font-mono text-3xl font-bold tracking-[0.3em]">{issued.code}</p>
              <p className="text-sm text-muted">Valable jusqu’au {when(issued.expiresAt)}, pour une seule utilisation.</p>
              <Button onClick={() => setIssued(null)}>J’ai remis le code</Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
