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

export default function Compte() {
  const { me, reload, logout } = useAuth();
  const p = useSearchParams();
  const first = p.get('premiere') === '1' || me?.user.mustChangePassword;
  const router = useRouter();
  const toast = useToast();
  const { busy, run } = useAction();
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [totp, setTotp] = useState<{ qr: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
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
          {me?.user.totpEnabled ? <p className="text-muted">Un code de votre application d’authentification est demandé à chaque connexion.</p> : totp ? (
            <form className="grid gap-3" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.post('/auth/2fa/enable', { code }), toast, 'Double authentification activée')) { setTotp(null); reload(); } }}>
              <p className="text-sm">Scannez ce QR code avec Google Authenticator ou une application équivalente, puis saisissez le code affiché.</p>
              <img src={totp.qr} alt="QR code de configuration" className="mx-auto size-44 rounded bg-white p-2" />
              <p className="break-all text-center font-mono text-xs text-muted">{totp.secret}</p>
              <Field label="Code à 6 chiffres"><Input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required className="text-center font-mono text-xl tracking-[0.3em]" /></Field>
              <Button type="submit" loading={busy}>Activer</Button>
            </form>
          ) : (
            <div className="grid gap-3">
              <p className="text-muted">Recommandée pour la direction et la comptabilité : même avec votre mot de passe, personne ne peut se connecter sans votre téléphone.</p>
              <Button variant="outline" loading={busy} onClick={async () => { const r = await run(() => api.post<{ qr: string; secret: string }>('/auth/2fa/setup'), toast); if (r) setTotp(r); }}>Configurer</Button>
            </div>
          )}
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
