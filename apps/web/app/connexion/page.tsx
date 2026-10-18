'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { AuthShell } from '@/components/site/auth-shell';
import { Button, ErrorNote, Field, Input } from '@/components/ui';
import { publicPost, setSession, TENANT } from '@/lib/api';
import { useAuth } from '@/lib/auth';

type LoginResult = { twoFactorRequired: true; challenge: string } | { twoFactorRequired: false; accessToken: string; mustChangePassword: boolean; mustSetupTwoFactor?: boolean };

export default function Connexion() {
  const auth = useAuth();
  const router = useRouter();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (auth.ready && auth.me) router.replace('/espace');
  }, [auth.ready, auth.me, router]);

  async function finish(r: LoginResult) {
    if (r.twoFactorRequired) {
      setChallenge(r.challenge);
      return;
    }
    setSession(r.accessToken);
    await auth.reload();
    router.replace(r.mustChangePassword ? '/espace/compte?premiere=1' : r.mustSetupTwoFactor ? '/espace/compte?securite=1' : '/espace');
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (challenge) await finish(await publicPost<LoginResult>('/auth/2fa/verify', { challenge, code: code.trim() }));
      else await finish(await publicPost<LoginResult>('/auth/login', { tenant: TENANT, identifier: identifier.trim(), password }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title={challenge ? 'Code de sécurité' : 'Connexion'} subtitle={challenge ? "Saisissez le code à 6 chiffres affiché dans votre application d'authentification." : 'Parents, élèves et personnel de l’école.'}>
      <form onSubmit={submit} className="grid gap-4">
        {challenge ? (
          <Field label="Code">
            <Input inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value)} autoFocus required className="text-center font-mono text-2xl tracking-[0.4em]" />
          </Field>
        ) : (
          <>
            <Field label="Téléphone, e-mail ou matricule" hint="Exemple : 01 97 00 00 01 ou SKG-26-0001">
              <Input autoComplete="username" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required autoFocus />
            </Field>
            <Field label="Mot de passe">
              <div className="relative">
                <Input type={show ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required className="pr-12" />
                <button type="button" onClick={() => setShow(!show)} className="absolute inset-y-0 right-0 grid w-11 cursor-pointer place-items-center text-muted" aria-label={show ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}>
                  {show ? <EyeOff className="size-5" /> : <Eye className="size-5" />}
                </button>
              </div>
            </Field>
          </>
        )}
        <ErrorNote error={error} />
        <Button type="submit" size="lg" loading={busy}>{challenge ? 'Valider' : 'Se connecter'}</Button>
        {challenge ? (
          <button type="button" className="cursor-pointer text-sm font-bold text-brand" onClick={() => { setChallenge(null); setCode(''); }}>Revenir</button>
        ) : (
          <Link href="/mot-de-passe-oublie" className="text-center text-sm font-bold text-brand">Mot de passe oublié ?</Link>
        )}
      </form>
      <DemoAccounts onPick={(id) => { setIdentifier(id); setPassword('Kisito2026'); }} />
    </AuthShell>
  );
}

/* Comptes fictifs créés par le jeu de données de démonstration (npm run db:seed). */
const DEMO = [
  ['Direction', '+2290190000010'],
  ['Secrétariat', '+2290190000011'],
  ['Enseignant', '+2290190000001'],
  ['Vie scolaire', '+2290190000012'],
  ['Comptable', '+2290190000013'],
  ['Parent', '+2290197000001'],
  ['Élève', 'SKG-26-0001'],
] as const;

function DemoAccounts({ onPick }: { onPick: (id: string) => void }) {
  if (process.env.NEXT_PUBLIC_DEMO === 'false') return null;
  return (
    <details className="mt-5 rounded-lg bg-sunk p-3 text-sm">
      <summary className="cursor-pointer font-bold">Comptes de démonstration</summary>
      <p className="mt-2 text-muted">Données fictives. Mot de passe : Kisito2026</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {DEMO.map(([label, id]) => (
          <button key={id} type="button" onClick={() => onPick(id)} className="min-h-9 cursor-pointer rounded-full border border-line bg-surface px-3 font-bold hover:border-brand">
            {label}
          </button>
        ))}
      </div>
    </details>
  );
}
