'use client';

import Link from 'next/link';
import { useState } from 'react';
import { AuthShell } from '@/components/site/auth-shell';
import { Button, ErrorNote, Field, Input } from '@/components/ui';
import { publicPost } from '@/lib/api';
import { tenantOrThrow } from '@/lib/tenant';

export default function MotDePasseOublie() {
  const [step, setStep] = useState<'ask' | 'reset' | 'done'>('ask');
  const [identifier, setIdentifier] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (step === 'ask') {
        await publicPost('/auth/forgot', { tenant: await tenantOrThrow(), identifier: identifier.trim() });
        setStep('reset');
      } else {
        await publicPost('/auth/reset', { tenant: await tenantOrThrow(), identifier: identifier.trim(), code: code.trim(), password });
        setStep('done');
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (step === 'done')
    return (
      <AuthShell title="Mot de passe changé" subtitle="Vous pouvez maintenant vous connecter avec votre nouveau mot de passe.">
        <Button asChild size="lg" className="w-full"><Link href="/connexion">Se connecter</Link></Button>
      </AuthShell>
    );

  return (
    <AuthShell title="Mot de passe oublié" subtitle={step === 'ask' ? 'Un code vous sera envoyé par SMS au numéro enregistré par l’école.' : 'Si ce compte existe, un code à 6 chiffres vient d’être envoyé par SMS.'}>
      <form onSubmit={submit} className="grid gap-4">
        <Field label="Téléphone, e-mail ou matricule">
          <Input value={identifier} onChange={(e) => setIdentifier(e.target.value)} required disabled={step === 'reset'} />
        </Field>
        {step === 'reset' && (
          <>
            <Field label="Code reçu par SMS">
              <Input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required autoFocus className="font-mono text-xl tracking-[0.3em]" />
            </Field>
            <Field label="Nouveau mot de passe" hint="Au moins 8 caractères, avec des lettres et des chiffres.">
              <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
            </Field>
          </>
        )}
        <ErrorNote error={error} />
        <Button type="submit" size="lg" loading={busy}>{step === 'ask' ? 'Recevoir un code' : 'Changer le mot de passe'}</Button>
        <Link href="/connexion" className="text-center text-sm font-bold text-brand">Retour à la connexion</Link>
      </form>
    </AuthShell>
  );
}
