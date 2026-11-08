'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Loader, Section } from '@/components/espace/bits';
import { Badge, Button, Field, Input, PageHeader, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime, ROLE_LABEL } from '@/lib/format';
import { useAction, useApi } from '@/lib/use-api';
import { RecoveryCodesPanel } from '@/components/recovery-codes';

export default function Compte() {
  const { me, reload, logout } = useAuth();
  const p = useSearchParams();
  const first = p.get('premiere') === '1' || me?.user.mustChangePassword;
  const router = useRouter();
  const toast = useToast();
  const { busy, run } = useAction();
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const sessions = useApi<{ id: string; userAgent: string | null; ip: string | null; createdAt: string; lastUsedAt: string | null; current?: boolean }[]>('/auth/sessions');
  const [large, setLarge] = useState(() => typeof document !== 'undefined' && document.documentElement.dataset.largeText === 'true');

  return (
    <>
      <PageHeader title="Mon compte" subtitle={me ? `${me.user.firstName} ${me.user.lastName} · ${me.user.roles.map((r) => ROLE_LABEL[r.role]).join(', ')}` : undefined} />
      {first && <p className="rounded-xl bg-warn-soft p-4 font-bold text-warn">Pour votre sécurité, choisissez un nouveau mot de passe avant de continuer.</p>}
      {p.get('securite') === '1' && <p className="rounded-xl bg-warn-soft p-4 font-bold text-warn">Votre rôle demande la double authentification : activez-la ci-dessous.</p>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Mot de passe">
          <form className="grid gap-3" onSubmit={async (e) => {
            e.preventDefault();
            if (pw.next !== pw.confirm) return toast('Les deux mots de passe ne correspondent pas', 'bad');
            if (await run(() => api.post('/auth/change-password', { current: pw.current, next: pw.next }), toast, 'Mot de passe changé')) { setPw({ current: '', next: '', confirm: '' }); await reload(); if (first) router.replace('/espace'); }
          }}>
            <Field label="Mot de passe actuel"><Input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required /></Field>
            <Field label="Nouveau mot de passe" hint="Au moins 8 caractères, avec des lettres et des chiffres."><Input type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} required minLength={8} /></Field>
            <Field label="Confirmer"><Input type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} required /></Field>
            <Button type="submit" loading={busy}>Changer le mot de passe</Button>
          </form>
        </Section>
        <Section title="Double authentification" action={me?.user.totpEnabled ? <Badge tone="good"><ShieldCheck className="size-3" /> Activée</Badge> : <Badge>Désactivée</Badge>}>
          <TwoFactor enabled={!!me?.user.totpEnabled} account={me?.user.phone ?? me?.user.email ?? undefined} reconfigure={p.get('reconfigurer') === '1'} remaining={p.get('restants')} onChange={reload} />
        </Section>
        <Section title="Appareils connectés" action={<Button size="sm" variant="ghost" className="text-bad" loading={busy} onClick={async () => { if (await run(() => api.post('/auth/logout-all'), toast, 'Tous les appareils sont déconnectés')) { await logout(); router.replace('/connexion'); } }}>Tout déconnecter</Button>}>
          <Loader {...sessions}>
            {(rows) => (
              <ul className="grid gap-2">{rows.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2 rounded-lg bg-sunk px-3 py-2 text-sm">
                  <span className="min-w-0"><span className="block truncate font-bold">{s.userAgent?.replace(/\(.*?\)/g, '').slice(0, 60) || 'Appareil inconnu'}</span><span className="text-muted">Depuis le {dateTime(s.createdAt)}</span></span>
                  {s.current ? <Badge tone="good">Cet appareil</Badge> : <Button size="sm" variant="ghost" onClick={async () => { if (await run(() => api.del(`/auth/sessions/${s.id}`), toast, 'Appareil déconnecté')) sessions.reload(); }}>Déconnecter</Button>}
                </li>
              ))}</ul>
            )}
          </Loader>
        </Section>
        <Section title="Affichage">
          <label className="flex min-h-11 items-center gap-3 font-bold">
            <input type="checkbox" className="size-5" checked={large} onChange={(e) => { setLarge(e.target.checked); document.documentElement.dataset.largeText = String(e.target.checked); try { localStorage.setItem('erp.large', String(e.target.checked)); } catch { /* préférence non mémorisée */ } }} />
            Texte agrandi
          </label>
        </Section>
      </div>
    </>
  );
}

type Setup = { qr: string; secret: string; setupToken: string };

/**
 * Double authentification : activation, changement de téléphone, codes de récupération.
 * Après une connexion avec un code de récupération, un jeton de 10 minutes (gardé pour cet onglet seulement)
 * permet de configurer le nouveau téléphone sans le code de l'ancien.
 */
function TwoFactor({ enabled, account, reconfigure, remaining, onChange }: { enabled: boolean; account?: string; reconfigure: boolean; remaining: string | null; onChange: () => Promise<unknown> | void }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const status = useApi<{ twoFactorEnabled: boolean; total: number; remaining: number; createdAt: string | null }>('/auth/2fa/recovery-codes');
  const [setup, setSetup] = useState<Setup | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [ask, setAsk] = useState<'regen' | 'phone' | null>(null);
  const [token] = useState(() => {
    if (!reconfigure) return null;
    try { return sessionStorage.getItem('erp.reconfigure'); } catch { return null; }
  });

  async function startSetup(body: { code?: string; reconfigureToken?: string }) {
    const r = await run(() => api.post<Setup>('/auth/2fa/setup', body), toast);
    if (r) { setSetup(r); setAsk(null); setCode(''); }
  }

  if (codes) {
    return <RecoveryCodesPanel codes={codes} account={account} doneLabel="C’est noté" onDone={() => { setCodes(null); status.reload(); }} />;
  }

  if (setup) {
    return (
      <form className="grid gap-3" onSubmit={async (e) => {
        e.preventDefault();
        const r = await run(() => api.post<{ ok: true; recoveryCodes?: string[] }>('/auth/2fa/enable', { code, setupToken: setup.setupToken }), toast, enabled ? 'Nouveau téléphone configuré' : 'Double authentification activée');
        if (r) {
          try { sessionStorage.removeItem('erp.reconfigure'); } catch { /* rien à effacer */ }
          setSetup(null); setCode('');
          if (r.recoveryCodes?.length) setCodes(r.recoveryCodes);
          await onChange();
        }
      }}>
        <p className="text-sm">Scannez ce QR code avec Google Authenticator ou une application équivalente, puis saisissez le code affiché.</p>
        <img src={setup.qr} alt="QR code de configuration" className="mx-auto size-44 rounded bg-white p-2" />
        <p className="break-all text-center font-mono text-xs text-muted">{setup.secret}</p>
        <Field label="Code à 6 chiffres"><Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required className="text-center font-mono text-xl tracking-[0.3em]" /></Field>
        <Button type="submit" loading={busy}>{enabled ? 'Utiliser ce nouveau téléphone' : 'Activer'}</Button>
        <Button type="button" variant="ghost" onClick={() => { setSetup(null); setCode(''); }}>Annuler</Button>
      </form>
    );
  }

  if (!enabled) {
    return (
      <div className="grid gap-3">
        <p className="text-muted">Recommandée pour la direction et la comptabilité : même avec votre mot de passe, personne ne peut se connecter sans votre téléphone.</p>
        <Button variant="outline" loading={busy} onClick={() => startSetup({})}>Configurer</Button>
      </div>
    );
  }

  const st = status.data;
  return (
    <div className="grid gap-3">
      {reconfigure && (
        <div className="grid gap-2 rounded-lg bg-warn-soft p-3 text-sm text-warn">
          <p className="font-bold">Vous vous êtes connecté avec un code de récupération{remaining ? ` (il vous en reste ${remaining})` : ''}.</p>
          {token ? (
            <>
              <p>Configurez dès maintenant votre nouveau téléphone : l’ancien cessera de fonctionner et vous recevrez de nouveaux codes.</p>
              <Button size="sm" loading={busy} onClick={() => startSetup({ reconfigureToken: token })}>Configurer mon nouveau téléphone</Button>
            </>
          ) : <p>Le délai de 10 minutes pour configurer un nouveau téléphone est passé : reconnectez-vous avec un code de récupération si vous n’avez plus l’ancien.</p>}
        </div>
      )}
      <p className="text-muted">Un code de votre application d’authentification est demandé à chaque connexion.</p>
      <div className="rounded-lg bg-sunk p-3 text-sm">
        <p className="font-bold">Codes de récupération</p>
        {!st ? <p className="text-muted">Chargement…</p> : st.total === 0 ? (
          <p className="text-warn">Vous n’avez pas encore de codes : créez-les pour pouvoir vous connecter si vous perdez votre téléphone.</p>
        ) : (
          <p className={st.remaining <= 3 ? 'text-warn' : 'text-muted'}>
            {st.remaining} sur {st.total} encore utilisables{st.createdAt ? `, créés le ${dateTime(st.createdAt)}` : ''}.{st.remaining <= 3 ? ' Pensez à en créer de nouveaux.' : ''}
          </p>
        )}
      </div>
      {ask ? (
        <form className="grid gap-3" onSubmit={async (e) => {
          e.preventDefault();
          if (ask === 'phone') return startSetup({ code: code.trim() });
          const r = await run(() => api.post<{ recoveryCodes: string[] }>('/auth/2fa/recovery-codes', { code: code.trim() }), toast);
          if (r) { setCodes(r.recoveryCodes); setAsk(null); setCode(''); }
        }}>
          <Field label="Code actuel de votre application" hint={ask === 'regen' ? 'Les anciens codes de récupération cesseront de fonctionner.' : 'Code affiché sur votre téléphone actuel.'}>
            <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required autoFocus className="text-center font-mono text-xl tracking-[0.3em]" />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" loading={busy}>{ask === 'regen' ? (st?.total ? 'Créer de nouveaux codes' : 'Créer mes codes') : 'Continuer'}</Button>
            <Button type="button" variant="ghost" onClick={() => { setAsk(null); setCode(''); }}>Annuler</Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setAsk('regen')}>{st?.total ? 'Créer de nouveaux codes' : 'Créer mes codes de récupération'}</Button>
          <Button variant="ghost" size="sm" onClick={() => setAsk('phone')}>Changer de téléphone</Button>
        </div>
      )}
    </div>
  );
}
