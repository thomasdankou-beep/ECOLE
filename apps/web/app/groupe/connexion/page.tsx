'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Building2 } from 'lucide-react';
import { RecoveryCodesPanel } from '@/components/recovery-codes';
import { Button, ErrorNote, Field, Input } from '@/components/ui';
import { gp } from '@/lib/group';

type LoginStep =
  | { step: 'code'; challenge: string }
  | { step: 'first-login'; token: string; needsPassword: boolean; needsTwoFactor: boolean };
type Setup = { qr: string; secret: string; setupToken: string };
type Stage =
  | { kind: 'login' }
  | { kind: 'code'; challenge: string; recovery: boolean }
  | { kind: 'password'; token: string }
  | { kind: 'twofactor'; token: string; setup: Setup | null }
  | { kind: 'codes'; codes: string[] };

/**
 * Connexion à la console du groupe (lot G2). La double authentification est obligatoire : à la première connexion,
 * le compte choisit son mot de passe, configure son application d'authentification et note ses codes de
 * récupération ; la console ne s'ouvre qu'ensuite.
 */
export default function GroupeConnexion() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>({ kind: 'login' });
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const next = (r: LoginStep) => {
    setPassword('');
    setConfirm('');
    setCode('');
    if (r.step === 'code') return setStage({ kind: 'code', challenge: r.challenge, recovery: false });
    if (r.needsPassword) return setStage({ kind: 'password', token: r.token });
    return setStage({ kind: 'twofactor', token: r.token, setup: null });
  };

  // Étape de configuration : le QR code est demandé dès l'arrivée sur l'étape.
  useEffect(() => {
    if (stage.kind !== 'twofactor' || stage.setup) return;
    let live = true;
    gp<Setup>('POST', '/auth/first-login/2fa/setup', { token: stage.token })
      .then((setup) => { if (live) setStage({ ...stage, setup }); })
      .catch((e) => { if (live) setError(e); });
    return () => { live = false; };
  }, [stage]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (stage.kind === 'login') {
        next(await gp<LoginStep>('POST', '/auth/login', { identifier: identifier.trim(), password }));
      } else if (stage.kind === 'code' && stage.recovery) {
        const r = await gp<{ reconfigureToken: string; recoveryCodesRemaining: number }>('POST', '/auth/recovery', { challenge: stage.challenge, code: code.trim() });
        try { sessionStorage.setItem('erp.gp.reconfigure', r.reconfigureToken); } catch { /* il faudra un code de l'application */ }
        router.replace(`/groupe?reconfigurer=1&restants=${r.recoveryCodesRemaining}`);
      } else if (stage.kind === 'code') {
        await gp('POST', '/auth/code', { challenge: stage.challenge, code: code.trim() });
        router.replace('/groupe');
      } else if (stage.kind === 'password') {
        if (password !== confirm) throw new Error('Les deux mots de passe ne sont pas identiques');
        next(await gp<LoginStep>('POST', '/auth/first-login/password', { token: stage.token, password }));
      } else if (stage.kind === 'twofactor' && stage.setup) {
        const r = await gp<{ recoveryCodes: string[] }>('POST', '/auth/first-login/2fa/enable', { token: stage.token, setupToken: stage.setup.setupToken, code: code.trim() });
        setCode('');
        setStage({ kind: 'codes', codes: r.recoveryCodes });
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const restart = () => { setStage({ kind: 'login' }); setCode(''); setPassword(''); setConfirm(''); setError(null); };

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-2 text-brand">
          <Building2 className="size-8" />
          <span className="font-display text-2xl font-bold">Console du groupe</span>
        </div>
        <div className="grid gap-4 rounded-2xl border border-line bg-surface p-5 shadow-sm sm:p-6">
          {stage.kind === 'codes' ? (
            <>
              <h1 className="text-2xl font-bold">Étape 3 sur 3 : vos codes de récupération</h1>
              <p className="text-muted">Ils vous permettront d’entrer si vous perdez votre téléphone.</p>
              <RecoveryCodesPanel codes={stage.codes} doneLabel="Ouvrir la console" onDone={() => router.replace('/groupe')} />
            </>
          ) : (
            <form className="grid gap-4" onSubmit={submit}>
              {stage.kind === 'login' && (
                <>
                  <h1 className="text-3xl font-bold">Connexion</h1>
                  <p className="text-sm text-muted">Pour les promoteurs et responsables d’un groupe scolaire. Les directions et le personnel des écoles se connectent sur l’adresse de leur école.</p>
                  <Field label="Téléphone ou e-mail"><Input autoComplete="username" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required maxLength={160} /></Field>
                  <Field label="Mot de passe"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required maxLength={200} /></Field>
                </>
              )}
              {stage.kind === 'code' && (
                stage.recovery ? (
                  <>
                    <h1 className="text-2xl font-bold">Code de récupération</h1>
                    <p className="text-muted">Saisissez un de vos codes de récupération (par exemple K7MQ4-T9XWR). Chaque code ne sert qu’une fois.</p>
                    <Field label="Code de récupération"><Input autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={14} value={code} onChange={(e) => setCode(e.target.value)} required autoFocus placeholder="XXXXX-XXXXX" className="text-center font-mono text-xl uppercase tracking-[0.2em]" /></Field>
                  </>
                ) : (
                  <>
                    <h1 className="text-2xl font-bold">Double authentification</h1>
                    <p className="text-muted">Saisissez le code à 6 chiffres affiché par votre application d’authentification.</p>
                    <Field label="Code"><Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required autoFocus className="text-center font-mono text-xl tracking-[0.3em]" /></Field>
                  </>
                )
              )}
              {stage.kind === 'password' && (
                <>
                  <h1 className="text-2xl font-bold">Étape 1 sur 3 : votre mot de passe</h1>
                  <p className="text-muted">Remplacez le mot de passe provisoire par un mot de passe à vous : au moins 12 caractères, avec des lettres et des chiffres.</p>
                  <Field label="Nouveau mot de passe"><Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={12} maxLength={200} /></Field>
                  <Field label="Confirmer le mot de passe"><Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={12} maxLength={200} /></Field>
                </>
              )}
              {stage.kind === 'twofactor' && (
                <>
                  <h1 className="text-2xl font-bold">Étape 2 sur 3 : double authentification</h1>
                  <p className="text-sm">
                    Obligatoire pour tous les comptes de groupe : même avec votre mot de passe, personne ne pourra entrer sans votre téléphone.
                    Installez une application d’authentification (Google Authenticator, Microsoft Authenticator…), scannez ce QR code, puis saisissez le code affiché.
                  </p>
                  {stage.setup ? (
                    <>
                      <img src={stage.setup.qr} alt="QR code de configuration" className="mx-auto size-44 rounded bg-white p-2" />
                      <p className="break-all text-center font-mono text-xs text-muted">{stage.setup.secret}</p>
                      <Field label="Code à 6 chiffres"><Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required className="text-center font-mono text-xl tracking-[0.3em]" /></Field>
                    </>
                  ) : !error && <p className="text-center text-muted">Préparation…</p>}
                </>
              )}
              <ErrorNote error={error} />
              {(stage.kind !== 'twofactor' || stage.setup) && (
                <Button type="submit" loading={busy}>
                  {stage.kind === 'login' ? 'Se connecter' : stage.kind === 'password' ? 'Enregistrer mon mot de passe' : stage.kind === 'twofactor' ? 'Activer' : 'Valider'}
                </Button>
              )}
              {stage.kind === 'code' && (
                <button type="button" className="cursor-pointer text-sm font-bold text-brand" onClick={() => { setStage({ ...stage, recovery: !stage.recovery }); setCode(''); setError(null); }}>
                  {stage.recovery ? 'Utiliser plutôt le code de l’application' : 'Je n’ai plus accès à mon application d’authentification'}
                </button>
              )}
              {stage.kind === 'code' && stage.recovery && (
                <p className="rounded-lg bg-sunk p-3 text-sm text-muted"><b>Téléphone et codes perdus ?</b> Demandez au responsable général de votre groupe, ou à Cahiora, de vous remettre un accès.</p>
              )}
              {stage.kind !== 'login' && <Button type="button" variant="ghost" onClick={restart}>Recommencer</Button>}
            </form>
          )}
        </div>
      </div>
    </main>
  );
}
