'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { AuthShell } from '@/components/site/auth-shell';
import { RecoveryCodesPanel } from '@/components/recovery-codes';
import { Button, ErrorNote, Field, Input } from '@/components/ui';
import { publicPost, setSession } from '@/lib/api';
import { usePublicSchool } from '@/lib/public-school';
import { tenantOrThrow } from '@/lib/tenant';
import { useAuth } from '@/lib/auth';

type Tokens = { twoFactorRequired: false; accessToken: string; mustChangePassword: boolean; mustSetupTwoFactor?: boolean };
type LoginResult =
  | { twoFactorRequired: true; challenge: string }
  | { twoFactorRequired: false; reenrollRequired: true; challenge: string }
  | (Tokens & { reenrollRequired?: undefined; recoveryUsed?: true; recoveryCodesRemaining?: number; reconfigureToken?: string; recoveryCodes?: string[] });

/** Étapes : mot de passe, code de l'application, code de récupération, code de réactivation, nouveau téléphone, nouveaux codes. */
type Step = 'password' | 'totp' | 'recovery' | 'activation' | 'newphone' | 'codes';

const TITLES: Record<Step, [string, string]> = {
  password: ['Connexion', 'Parents, élèves et personnel de l’école.'],
  totp: ['Code de sécurité', "Saisissez le code à 6 chiffres affiché dans votre application d'authentification."],
  recovery: ['Code de récupération', 'Saisissez un de vos codes de récupération (par exemple K7MQ4-T9XWR). Chaque code ne sert qu’une fois.'],
  activation: ['Réactiver la double authentification', 'Votre établissement a validé la récupération de votre compte. Saisissez le code de réactivation qu’il vous a remis.'],
  newphone: ['Nouveau téléphone', 'Scannez ce QR code avec Google Authenticator sur votre nouveau téléphone, puis saisissez le code affiché.'],
  codes: ['Vos codes de récupération', 'Votre nouveau téléphone est configuré.'],
};

export default function Connexion() {
  const auth = useAuth();
  const router = useRouter();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [step, setStep] = useState<Step>('password');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<{ qr: string; secret: string; setupToken: string } | null>(null);
  const [done, setDone] = useState<Tokens & { recoveryCodes?: string[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  // Pendant une connexion qui vient d'aboutir, c'est elle qui choisit la page suivante (compte, nouveaux codes…).
  const leaving = useRef(false);

  useEffect(() => {
    if (auth.ready && auth.me && step !== 'codes' && !leaving.current) router.replace('/espace');
  }, [auth.ready, auth.me, router, step]);

  function go(next: Step) {
    setStep(next);
    setCode('');
    setError(null);
  }

  async function open(r: Tokens) {
    leaving.current = true;
    setSession(r.accessToken);
    await auth.reload();
    router.replace(r.mustChangePassword ? '/espace/compte?premiere=1' : r.mustSetupTwoFactor ? '/espace/compte?securite=1' : '/espace');
  }

  async function finish(r: LoginResult) {
    if (r.twoFactorRequired) {
      setChallenge(r.challenge);
      return go('totp');
    }
    if (r.reenrollRequired) {
      setChallenge(r.challenge);
      return go('activation');
    }
    if (r.recoveryUsed && r.reconfigureToken) {
      // Jeton de 10 minutes pour configurer le nouveau téléphone sans le code de l'ancien.
      try { sessionStorage.setItem('erp.reconfigure', r.reconfigureToken); } catch { /* il faudra un nouveau code de récupération */ }
      leaving.current = true;
      setSession(r.accessToken);
      await auth.reload();
      router.replace(r.mustChangePassword ? '/espace/compte?premiere=1' : `/espace/compte?reconfigurer=1&restants=${r.recoveryCodesRemaining ?? ''}`);
      return;
    }
    await open(r);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (step === 'totp') await finish(await publicPost<LoginResult>('/auth/2fa/verify', { challenge, code: code.trim() }));
      else if (step === 'recovery') await finish(await publicPost<LoginResult>('/auth/2fa/recovery', { challenge, code: code.trim() }));
      else if (step === 'activation') {
        setSetup(await publicPost<{ qr: string; secret: string; setupToken: string }>('/auth/2fa/reenroll/start', { challenge, activationCode: code.trim() }));
        go('newphone');
      } else if (step === 'newphone') {
        const r = await publicPost<Tokens & { recoveryCodes: string[] }>('/auth/2fa/reenroll/finish', { challenge, setupToken: setup?.setupToken, code: code.trim() });
        setSession(r.accessToken);
        setDone(r);
        setSetup(null);
        go('codes');
      } else await finish(await publicPost<LoginResult>('/auth/login', { tenant: await tenantOrThrow(), identifier: identifier.trim(), password }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  function restart() {
    setChallenge(null);
    setSetup(null);
    go('password');
  }

  const [title, subtitle] = TITLES[step];
  if (step === 'codes' && done) {
    return (
      <AuthShell title={title} subtitle={subtitle}>
        <RecoveryCodesPanel codes={done.recoveryCodes ?? []} account={identifier.trim()} doneLabel="Accéder à mon espace" onDone={() => open(done)} />
      </AuthShell>
    );
  }

  return (
    <AuthShell title={title} subtitle={subtitle}>
      <form onSubmit={submit} className="grid gap-4">
        {step === 'totp' && (
          <Field label="Code">
            <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} autoFocus required className="text-center font-mono text-2xl tracking-[0.4em]" />
          </Field>
        )}
        {step === 'recovery' && (
          <Field label="Code de récupération">
            <Input autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={14} value={code} onChange={(e) => setCode(e.target.value)} autoFocus required placeholder="XXXXX-XXXXX" className="text-center font-mono text-xl uppercase tracking-[0.2em]" />
          </Field>
        )}
        {step === 'activation' && (
          <Field label="Code de réactivation" hint="8 caractères, valable 24 heures. Il vous a été remis par la direction ou par le support Cahiora.">
            <Input autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={10} value={code} onChange={(e) => setCode(e.target.value)} autoFocus required placeholder="XXXX-XXXX" className="text-center font-mono text-xl uppercase tracking-[0.2em]" />
          </Field>
        )}
        {step === 'newphone' && setup && (
          <>
            <img src={setup.qr} alt="QR code de configuration" className="mx-auto size-44 rounded bg-white p-2" />
            <p className="break-all text-center font-mono text-xs text-muted">{setup.secret}</p>
            <Field label="Code à 6 chiffres">
              <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} autoFocus required className="text-center font-mono text-xl tracking-[0.3em]" />
            </Field>
          </>
        )}
        {step === 'password' && (
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
        <Button type="submit" size="lg" loading={busy}>{step === 'password' ? 'Se connecter' : step === 'newphone' ? 'Activer sur ce téléphone' : 'Valider'}</Button>
        {step === 'totp' && (
          <button type="button" className="cursor-pointer text-sm font-bold text-brand" onClick={() => go('recovery')}>Je n’ai plus accès à mon application d’authentification</button>
        )}
        {step === 'recovery' && (
          <>
            <button type="button" className="cursor-pointer text-sm font-bold text-brand" onClick={() => go('totp')}>Utiliser plutôt le code de l’application</button>
            <p className="rounded-lg bg-sunk p-3 text-sm text-muted">
              <b className="text-ink">Téléphone et codes perdus ?</b> Adressez-vous à la direction de votre établissement. Après vérification de votre identité, une autre personne de la direction validera la récupération et vous remettra un code de réactivation. Pour un compte Direction, c’est le support Cahiora qui valide.
            </p>
          </>
        )}
        {step === 'password' ? (
          <Link href="/mot-de-passe-oublie" className="text-center text-sm font-bold text-brand">Mot de passe oublié ?</Link>
        ) : (
          <button type="button" className="cursor-pointer text-sm font-bold text-muted" onClick={restart}>Revenir à la connexion</button>
        )}
      </form>
      {step === 'password' && <DemoAccounts onPick={(id) => { setIdentifier(id); setPassword('Kisito2026'); }} />}
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
  const school = usePublicSchool();
  // Seule l'école de démonstration (réglage « demo » posé par le jeu de données) affiche ces comptes.
  if (process.env.NEXT_PUBLIC_DEMO === 'false' || !school?.demo) return null;
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
