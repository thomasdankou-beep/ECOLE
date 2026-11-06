'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Button, ErrorNote, Field, Input } from '@/components/ui';
import { pf } from '@/lib/platform';

export default function PlateformeConnexion() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-2 text-brand">
          <ShieldCheck className="size-8" />
          <span className="font-display text-2xl font-bold">Administration de la plateforme</span>
        </div>
        <form className="grid gap-4 rounded-2xl border border-line bg-surface p-5 shadow-sm sm:p-6" onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            if (challenge) {
              await pf('POST', '/auth/2fa/verify', { challenge, code: code.trim() });
              return router.replace('/plateforme');
            }
            const r = await pf<{ twoFactorRequired?: boolean; challenge?: string }>('POST', '/auth/login', { email: email.trim(), password });
            if (r.twoFactorRequired && r.challenge) {
              setChallenge(r.challenge);
              setPassword('');
              return;
            }
            router.replace('/plateforme');
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}>
          <h1 className="text-3xl font-bold">Connexion Super Admin</h1>
          {challenge ? (
            <>
              <p className="text-muted">Saisissez le code à 6 chiffres affiché par votre application d’authentification.</p>
              <Field label="Code"><Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required autoFocus className="text-center font-mono text-xl tracking-[0.3em]" /></Field>
              <ErrorNote error={error} />
              <Button type="submit" loading={busy}>Valider</Button>
              <Button type="button" variant="ghost" onClick={() => { setChallenge(null); setCode(''); setError(null); }}>Recommencer</Button>
            </>
          ) : (
            <>
              <Field label="Adresse e-mail"><Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
              <Field label="Mot de passe"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
              <ErrorNote error={error} />
              <Button type="submit" loading={busy}>Se connecter</Button>
            </>
          )}
        </form>
      </div>
    </main>
  );
}
