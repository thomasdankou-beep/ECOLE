'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { Building2, KeyRound, LogOut, MonitorSmartphone, Plus, ShieldCheck, UserCog } from 'lucide-react';
import { RecoveryCodesPanel } from '@/components/recovery-codes';
import { Badge, Button, Card, CardTitle, Chips, Empty, ErrorNote, Field, Input, PageHeader, Select, Table, useToast } from '@/components/ui';
import { ApiError } from '@/lib/api';
import {
  accountState, dateTime, gp, GROUP_ACTIONS, GROUP_ROLE_HINTS, GROUP_ROLE_LABELS, groupLogDetail, type GroupAccount, type GroupLog, type GroupRole,
} from '@/lib/group';

type Me = {
  account: GroupAccount & { recoveryCodesRemaining: number };
  group: { id: string; name: string; legalName: string | null; promoter: string | null; phone: string | null; email: string | null; address: string | null; country: string; taxId: string | null; status: string };
  idleMinutes: number;
  sessionHours: number;
};
type School = { id: string; name: string; shortName: string | null; slug: string; status: 'ACTIVE' | 'SUSPENDED'; address: string; groupJoinedAt: string };
type Session = { id: string; ip: string | null; userAgent: string | null; createdAt: string; lastUsedAt: string; expiresAt: string; current: boolean };
type Tab = 'apercu' | 'comptes' | 'journal' | 'compte';

const day = (d: string) => new Date(d).toLocaleDateString('fr-FR');

/** Une session expirée (inactivité, 8 heures, compte désactivé) ramène à la page de connexion. */
function useExpired() {
  const router = useRouter();
  return useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 401) router.replace('/groupe/connexion');
  }, [router]);
}

export default function Page() {
  return <Suspense><Console /></Suspense>;
}

/**
 * Console du groupe (lot G2) : la fiche du groupe et ses établissements ; pour le responsable général, les comptes
 * et le journal du groupe ; pour chacun, son compte (mot de passe, double authentification, appareils connectés).
 * Aucune donnée d'élève : les chiffres agrégés des établissements arriveront au lot suivant.
 */
function Console() {
  const router = useRouter();
  const params = useSearchParams();
  const expired = useExpired();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tab, setTab] = useState<Tab>(params.get('reconfigurer') ? 'compte' : 'apercu');

  const load = useCallback(() => gp<Me>('GET', '/auth/me').then(setMe).catch((e) => { expired(e); setError(e); }), [expired]);
  useEffect(() => { load(); }, [load]);

  async function logout() {
    await gp('POST', '/auth/logout').catch(() => undefined);
    router.replace('/groupe/connexion');
  }

  if (!me) {
    return (
      <main className="mx-auto grid max-w-3xl gap-4 px-4 py-10">
        {error ? (
          <>
            <ErrorNote error={error} />
            <Button variant="outline" onClick={logout}><LogOut className="size-4" /> Se déconnecter</Button>
          </>
        ) : <p className="text-muted">Chargement…</p>}
      </main>
    );
  }

  const general = me.account.role === 'GENERAL';
  const tabs: { value: Tab; label: string }[] = [
    { value: 'apercu', label: 'Vue d’ensemble' },
    ...(general ? [{ value: 'comptes' as Tab, label: 'Comptes' }, { value: 'journal' as Tab, label: 'Journal' }] : []),
    { value: 'compte', label: 'Mon compte' },
  ];
  return (
    <main className="mx-auto grid max-w-5xl gap-5 px-4 py-6 sm:py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-brand">
          <Building2 className="size-7 shrink-0" />
          <span className="truncate font-display text-lg font-bold">Cahiora · console du groupe</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-right text-sm">
            <b className="block">{me.account.firstName} {me.account.lastName}</b>
            <span className="text-muted">{me.account.roleLabel}</span>
          </span>
          <Button variant="outline" size="sm" onClick={logout}><LogOut className="size-4" /> Se déconnecter</Button>
        </div>
      </header>
      <PageHeader title={me.group.name} subtitle={me.group.legalName ?? undefined} />
      <Chips label="Rubrique" value={tab} onChange={setTab} options={tabs} />
      {tab === 'apercu' && <Overview me={me} />}
      {tab === 'comptes' && general && <Accounts />}
      {tab === 'journal' && general && <Journal />}
      {tab === 'compte' && <MyAccount me={me} reload={load} />}
    </main>
  );
}

function Overview({ me }: { me: Me }) {
  const expired = useExpired();
  const [schools, setSchools] = useState<School[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { gp<School[]>('GET', '/establishments').then(setSchools).catch((e) => { expired(e); setError(e); }); }, [expired]);
  const g = me.group;
  return (
    <div className="grid gap-4">
      <Card className="grid gap-3">
        <CardTitle>Votre groupe</CardTitle>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div><dt className="text-muted">Promoteur</dt><dd className="font-bold">{g.promoter ?? '—'}</dd></div>
          <div><dt className="text-muted">Contact</dt><dd className="font-bold">{[g.phone, g.email].filter(Boolean).join(' · ') || '—'}</dd></div>
          <div><dt className="text-muted">Adresse</dt><dd className="font-bold">{g.address ?? '—'}</dd></div>
          <div><dt className="text-muted">Identifiant fiscal</dt><dd className="font-bold">{g.taxId ?? '—'}</dd></div>
        </dl>
        <p className="text-xs text-muted">Pour corriger ces informations, écrivez à Cahiora.</p>
      </Card>
      <Card className="grid gap-3">
        <CardTitle>Établissements du groupe{schools ? ` (${schools.length})` : ''}</CardTitle>
        <ErrorNote error={error} />
        {schools && (schools.length === 0 ? <Empty title="Aucun établissement">Cahiora rattache vos établissements à votre groupe à votre demande.</Empty> : (
          <Table>
            <thead><tr><th>Établissement</th><th>Adresse</th><th>État</th><th>Dans le groupe depuis</th></tr></thead>
            <tbody>
              {schools.map((s) => (
                <tr key={s.id}>
                  <td className="font-bold">{s.name}</td>
                  <td className="text-sm"><a className="text-brand underline" href={s.address} target="_blank" rel="noreferrer">{s.address.replace(/^https?:\/\//, '')}</a></td>
                  <td>{s.status === 'ACTIVE' ? <Badge tone="good">Actif</Badge> : <Badge tone="bad">Suspendu</Badge>}</td>
                  <td className="text-sm">{day(s.groupJoinedAt)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ))}
      </Card>
      <Card className="grid gap-2">
        <CardTitle>Chiffres des établissements</CardTitle>
        <p className="text-sm text-muted">
          Les effectifs, la présence, les encaissements et les résultats de chaque établissement s’afficheront ici, calculés chaque nuit,
          sous forme de totaux seulement. La console ne montre jamais de liste d’élèves ni de dossier individuel.
        </p>
      </Card>
    </div>
  );
}

function Secret({ title, identifier, password, onClose }: { title: string; identifier: string; password: string; onClose: () => void }) {
  return (
    <div className="grid gap-2 rounded-lg border border-warn bg-warn-soft p-3 text-sm" role="status">
      <p className="font-bold">{title}</p>
      <p>Identifiant : <b>{identifier}</b></p>
      <p>Mot de passe provisoire : <b className="font-mono text-base tracking-wider">{password}</b></p>
      <p className="text-muted">Montré une seule fois. À la première connexion, la personne choisit son mot de passe et configure sa double authentification.</p>
      <Button size="sm" variant="outline" onClick={onClose}>J’ai transmis ces informations</Button>
    </div>
  );
}

function Accounts() {
  const toast = useToast();
  const expired = useExpired();
  const [rows, setRows] = useState<GroupAccount[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState<{ firstName: string; lastName: string; phone: string; email: string; role: GroupRole; code: string } | null>(null);
  const [secret, setSecret] = useState<{ title: string; identifier: string; password: string } | null>(null);
  const [reset, setReset] = useState<GroupAccount | null>(null);
  const [resetCode, setResetCode] = useState('');
  const [resetError, setResetError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => gp<GroupAccount[]>('GET', '/accounts').then(setRows).catch((e) => { expired(e); setError(e); }), [expired]);
  useEffect(() => { load(); }, [load]);

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try {
      await fn();
      toast(ok);
      await load();
    } catch (e) {
      expired(e);
      toast(e instanceof Error ? e.message : 'Erreur', 'bad');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4">
      {secret && <Secret {...secret} onClose={() => setSecret(null)} />}
      <Card className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Comptes de la console</CardTitle>
          {!form && <Button size="sm" onClick={() => { setForm({ firstName: '', lastName: '', phone: '', email: '', role: 'FINANCIER', code: '' }); setReset(null); }}><Plus className="size-4" /> Nouveau compte</Button>}
        </div>
        {form && (
          <form className="grid gap-3 rounded-lg bg-sunk p-3" onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const r = await gp<{ account: GroupAccount; temporaryPassword: string }>('POST', '/accounts', { ...form, code: form.code.trim() });
              setSecret({ title: `Compte créé : ${r.account.firstName} ${r.account.lastName}`, identifier: r.account.phone ?? r.account.email ?? '', password: r.temporaryPassword });
              setForm(null);
              await load();
            } catch (err) {
              expired(err);
              setError(err);
            } finally {
              setBusy(false);
            }
          }}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Prénom"><Input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} required maxLength={80} /></Field>
              <Field label="Nom"><Input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} required maxLength={80} /></Field>
              <Field label="Téléphone"><Input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} maxLength={30} /></Field>
              <Field label="E-mail"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} maxLength={160} /></Field>
            </div>
            <Field label="Rôle" hint={GROUP_ROLE_HINTS[form.role]}>
              <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as GroupRole })}>
                {(Object.keys(GROUP_ROLE_LABELS) as GroupRole[]).map((r) => <option key={r} value={r}>{GROUP_ROLE_LABELS[r]}</option>)}
              </Select>
            </Field>
            <p className="text-xs text-muted">Le téléphone ou l’e-mail sert d’identifiant. Un mot de passe provisoire est affiché une seule fois (et envoyé par SMS si un téléphone est indiqué).</p>
            <Field label="Code de votre application" hint="Pour confirmer que c’est bien vous : le code à 6 chiffres affiché par votre application d’authentification.">
              <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required className="max-w-48 text-center font-mono text-lg tracking-[0.3em]" />
            </Field>
            <ErrorNote error={error} />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" loading={busy}>Créer le compte</Button>
              <Button type="button" variant="ghost" onClick={() => { setForm(null); setError(null); }}>Annuler</Button>
            </div>
          </form>
        )}
        {!form && <ErrorNote error={error} />}
        {reset && (
          <form className="grid gap-3 rounded-lg border border-warn bg-warn-soft p-3" onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setResetError(null);
            try {
              const r = await gp<{ account: GroupAccount; temporaryPassword: string }>('POST', `/accounts/${reset.id}/reset`, { code: resetCode.trim() });
              setSecret({ title: `Accès remis : ${reset.firstName} ${reset.lastName}`, identifier: r.account.phone ?? r.account.email ?? '', password: r.temporaryPassword });
              setReset(null);
              setResetCode('');
              await load();
            } catch (err) {
              expired(err);
              setResetError(err);
            } finally {
              setBusy(false);
            }
          }}>
            <p className="font-bold">Remettre l’accès de {reset.firstName} {reset.lastName} ?</p>
            <p className="text-sm">Ses sessions sont fermées, son mot de passe et sa double authentification sont effacés. Vous recevez un mot de passe provisoire à lui transmettre.</p>
            <Field label="Code de votre application">
              <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={resetCode} onChange={(e) => setResetCode(e.target.value)} required autoFocus className="max-w-48 text-center font-mono text-lg tracking-[0.3em]" />
            </Field>
            <ErrorNote error={resetError} />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="danger" loading={busy}>Remettre l’accès</Button>
              <Button type="button" variant="ghost" onClick={() => { setReset(null); setResetCode(''); setResetError(null); }}>Annuler</Button>
            </div>
          </form>
        )}
        {rows && (
          <Table>
            <thead><tr><th>Nom</th><th>Identifiant</th><th>Rôle</th><th>État</th><th>Dernière connexion</th><th /></tr></thead>
            <tbody>
              {rows.map((a) => {
                const st = accountState(a);
                return (
                  <tr key={a.id}>
                    <td className="font-bold">{a.firstName} {a.lastName}{a.self && <span className="block text-xs font-normal text-muted">vous</span>}</td>
                    <td className="text-sm">{[a.phone, a.email].filter(Boolean).join(' · ')}</td>
                    <td className="text-sm">
                      {a.self ? a.roleLabel : (
                        <Select aria-label={`Rôle de ${a.firstName} ${a.lastName}`} value={a.role} disabled={busy} onChange={(e) => act(() => gp('PATCH', `/accounts/${a.id}`, { role: e.target.value }), 'Rôle changé')}>
                          {(Object.keys(GROUP_ROLE_LABELS) as GroupRole[]).map((r) => <option key={r} value={r}>{GROUP_ROLE_LABELS[r]}</option>)}
                        </Select>
                      )}
                    </td>
                    <td><Badge tone={st.tone}>{st.label}</Badge></td>
                    <td className="text-sm">{dateTime(a.lastLoginAt)}</td>
                    <td>
                      {!a.self && (
                        <div className="flex flex-wrap justify-end gap-1">
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => gp('PATCH', `/accounts/${a.id}`, { active: !a.active }), a.active ? 'Compte désactivé, sessions fermées' : 'Compte réactivé')}>
                            {a.active ? 'Désactiver' : 'Réactiver'}
                          </Button>
                          {a.active && (
                            <Button size="sm" variant="ghost" disabled={busy} aria-label={`Remettre l’accès de ${a.firstName} ${a.lastName}`} onClick={() => { setReset(a); setResetCode(''); setResetError(null); setForm(null); }}>
                              <KeyRound className="size-4" /> Remettre l’accès
                            </Button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
      <p className="text-sm text-muted">
        Désactiver un compte ferme aussitôt ses sessions. « Remettre l’accès » donne un nouveau mot de passe provisoire et efface sa double
        authentification : la personne la configure de nouveau à sa prochaine connexion. Il reste toujours au moins un responsable général actif.
      </p>
    </div>
  );
}

function Journal() {
  const expired = useExpired();
  const [rows, setRows] = useState<GroupLog[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { gp<GroupLog[]>('GET', '/journal').then(setRows).catch((e) => { expired(e); setError(e); }); }, [expired]);
  return (
    <Card className="grid gap-3">
      <CardTitle>Journal du groupe</CardTitle>
      <p className="text-sm text-muted">Connexions, changements de comptes et actions de Cahiora sur votre groupe. Les 200 dernières lignes ; rien ne peut y être effacé.</p>
      <ErrorNote error={error} />
      {rows && (rows.length === 0 ? <Empty title="Aucune ligne" /> : (
        <ul className="grid gap-2">
          {rows.map((r) => (
            <li key={r.id} className="rounded-lg border border-line p-2.5 text-sm">
              <div className="flex flex-wrap justify-between gap-2"><b>{GROUP_ACTIONS[r.action] ?? r.action}</b><span className="text-muted">{dateTime(r.createdAt)}</span></div>
              {groupLogDetail(r) && <p>{groupLogDetail(r)}</p>}
              <p className="text-xs text-muted">{r.actorName ?? '—'}{r.ip ? ` · ${r.ip}` : ''}</p>
            </li>
          ))}
        </ul>
      ))}
    </Card>
  );
}

type Setup = { qr: string; secret: string; setupToken: string };

function MyAccount({ me, reload }: { me: Me; reload: () => Promise<unknown> }) {
  const toast = useToast();
  const expired = useExpired();
  const params = useSearchParams();
  const [pw, setPw] = useState({ current: '', password: '', confirm: '' });
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [ask, setAsk] = useState<'phone' | 'regen' | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [token] = useState(() => {
    if (!params.get('reconfigurer')) return null;
    try { return sessionStorage.getItem('erp.gp.reconfigure'); } catch { return null; }
  });
  const loadSessions = useCallback(() => gp<Session[]>('GET', '/auth/sessions').then(setSessions).catch(expired), [expired]);
  useEffect(() => { loadSessions(); }, [loadSessions]);

  async function run<T>(fn: () => Promise<T>, ok?: string): Promise<T | null> {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (ok) toast(ok);
      return r;
    } catch (e) {
      expired(e);
      setError(e);
      return null;
    } finally {
      setBusy(false);
    }
  }

  if (codes) {
    return (
      <Card className="grid gap-3">
        <CardTitle>Nouveaux codes de récupération</CardTitle>
        <RecoveryCodesPanel codes={codes} account={`${me.account.firstName} ${me.account.lastName}`} doneLabel="C’est noté" onDone={() => { setCodes(null); reload(); }} />
      </Card>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="grid gap-3">
        <CardTitle className="flex items-center gap-2"><ShieldCheck className="size-5" /> Double authentification</CardTitle>
        {params.get('reconfigurer') && (
          <div className="grid gap-2 rounded-lg bg-warn-soft p-3 text-sm text-warn">
            <p className="font-bold">Vous vous êtes connecté avec un code de récupération{params.get('restants') ? ` (il vous en reste ${params.get('restants')})` : ''}.</p>
            {token ? (
              <>
                <p>Configurez dès maintenant votre nouveau téléphone : l’ancien cessera de fonctionner et vous recevrez de nouveaux codes.</p>
                <Button size="sm" loading={busy} onClick={async () => { const r = await run(() => gp<Setup>('POST', '/auth/2fa/setup', { reconfigureToken: token })); if (r) setSetup(r); }}>Configurer mon nouveau téléphone</Button>
              </>
            ) : <p>Le délai de 10 minutes est passé : utilisez le code de votre application, ou reconnectez-vous avec un code de récupération.</p>}
          </div>
        )}
        {setup ? (
          <form className="grid gap-3" onSubmit={async (e) => {
            e.preventDefault();
            const r = await run(() => gp<{ recoveryCodes: string[] }>('POST', '/auth/2fa/enable', { setupToken: setup.setupToken, code: code.trim() }), 'Nouveau téléphone configuré');
            if (r) {
              try { sessionStorage.removeItem('erp.gp.reconfigure'); } catch { /* rien à effacer */ }
              setSetup(null); setCode(''); setCodes(r.recoveryCodes);
              loadSessions();
            }
          }}>
            <p className="text-sm">Scannez ce QR code avec votre application d’authentification, puis saisissez le code affiché.</p>
            <img src={setup.qr} alt="QR code de configuration" className="mx-auto size-44 rounded bg-white p-2" />
            <p className="break-all text-center font-mono text-xs text-muted">{setup.secret}</p>
            <Field label="Code à 6 chiffres"><Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required className="text-center font-mono text-xl tracking-[0.3em]" /></Field>
            <ErrorNote error={error} />
            <Button type="submit" loading={busy}>Utiliser ce nouveau téléphone</Button>
            <Button type="button" variant="ghost" onClick={() => { setSetup(null); setCode(''); }}>Annuler</Button>
          </form>
        ) : (
          <>
            <p className="text-sm text-muted">Active et obligatoire : un code de votre application est demandé à chaque connexion.</p>
            <p className={`rounded-lg bg-sunk p-3 text-sm ${me.account.recoveryCodesRemaining <= 3 ? 'text-warn' : ''}`}>
              Codes de récupération encore utilisables : <b>{me.account.recoveryCodesRemaining}</b>.{me.account.recoveryCodesRemaining <= 3 ? ' Pensez à en créer de nouveaux.' : ''}
            </p>
            {ask ? (
              <form className="grid gap-3" onSubmit={async (e) => {
                e.preventDefault();
                if (ask === 'phone') {
                  const r = await run(() => gp<Setup>('POST', '/auth/2fa/setup', { code: code.trim() }));
                  if (r) { setSetup(r); setAsk(null); setCode(''); }
                } else {
                  const r = await run(() => gp<{ recoveryCodes: string[] }>('POST', '/auth/recovery-codes', { code: code.trim() }));
                  if (r) { setCodes(r.recoveryCodes); setAsk(null); setCode(''); }
                }
              }}>
                <Field label="Code actuel de votre application"><Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required className="text-center font-mono text-xl tracking-[0.3em]" /></Field>
                <ErrorNote error={error} />
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" loading={busy}>{ask === 'phone' ? 'Continuer' : 'Créer de nouveaux codes'}</Button>
                  <Button type="button" variant="ghost" onClick={() => { setAsk(null); setCode(''); setError(null); }}>Annuler</Button>
                </div>
              </form>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setAsk('phone')}>Changer de téléphone</Button>
                <Button variant="outline" size="sm" onClick={() => setAsk('regen')}>Nouveaux codes de récupération</Button>
              </div>
            )}
          </>
        )}
      </Card>

      <Card className="grid gap-3">
        <CardTitle className="flex items-center gap-2"><UserCog className="size-5" /> Mot de passe</CardTitle>
        <form className="grid gap-3" onSubmit={async (e) => {
          e.preventDefault();
          if (pw.password !== pw.confirm) return setError(new Error('Les deux mots de passe ne sont pas identiques'));
          const r = await run(() => gp<{ otherSessionsClosed: number }>('POST', '/auth/password', { current: pw.current, password: pw.password }), 'Mot de passe changé');
          if (r) { setPw({ current: '', password: '', confirm: '' }); loadSessions(); }
        }}>
          <Field label="Mot de passe actuel"><Input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required /></Field>
          <Field label="Nouveau mot de passe" hint="Au moins 12 caractères, avec des lettres et des chiffres. Vos autres sessions seront fermées."><Input type="password" autoComplete="new-password" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} required minLength={12} /></Field>
          <Field label="Confirmer"><Input type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} required minLength={12} /></Field>
          {!setup && !ask && <ErrorNote error={error} />}
          <Button type="submit" loading={busy}>Changer le mot de passe</Button>
        </form>
      </Card>

      <Card className="grid gap-3 lg:col-span-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2"><MonitorSmartphone className="size-5" /> Appareils connectés</CardTitle>
          {sessions && sessions.length > 1 && <Button size="sm" variant="outline" loading={busy} onClick={async () => { await run(() => gp('POST', '/auth/sessions/revoke-others'), 'Autres sessions fermées'); loadSessions(); }}>Fermer les autres sessions</Button>}
        </div>
        <p className="text-sm text-muted">Une session dure {me.sessionHours} heures au plus et se ferme après {me.idleMinutes} minutes sans activité.</p>
        {sessions && (
          <ul className="grid gap-2">
            {sessions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line p-2.5 text-sm">
                <span>
                  <b>{s.current ? 'Cet appareil' : (s.userAgent ?? 'Appareil inconnu').slice(0, 60)}</b>
                  <span className="block text-muted">Ouverte le {dateTime(s.createdAt)} · dernière activité {dateTime(s.lastUsedAt)}{s.ip ? ` · ${s.ip}` : ''}</span>
                </span>
                {!s.current && <Button size="sm" variant="ghost" onClick={async () => { await run(() => gp('POST', `/auth/sessions/${s.id}/revoke`), 'Session fermée'); loadSessions(); }}>Fermer</Button>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
