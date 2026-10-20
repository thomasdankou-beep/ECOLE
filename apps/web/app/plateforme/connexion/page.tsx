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
            await pf('POST', '/auth/login', { email: email.trim(), password });
            router.replace('/plateforme');
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}>
          <h1 className="text-3xl font-bold">Connexion Super Admin</h1>
          <Field label="Adresse e-mail"><Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
          <Field label="Mot de passe"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
          <ErrorNote error={error} />
          <Button type="submit" loading={busy}>Se connecter</Button>
        </form>
      </div>
    </main>
  );
}
