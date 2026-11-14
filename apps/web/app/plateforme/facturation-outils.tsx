'use client';

import { useState } from 'react';
import { Field, Input, useToast } from '@/components/ui';

/** Outils partagés des écrans « Commercial et facturation » du Super Admin (lots G5a et G5g). */

export const frDate = (d: string | null | undefined) => (d ? new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '—');
export const money = (n: number, currency: string | null) => `${new Intl.NumberFormat('fr-FR').format(n).replace(/[  ]/g, ' ')} ${!currency || currency === 'XOF' || currency === 'XAF' ? 'FCFA' : currency}`;

/** Code à 6 chiffres de l'application d'authentification, demandé pour chaque opération financière. */
export function CodeField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Field label="Code de votre application d’authentification" hint="Exigé pour chaque opération de facturation.">
      <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={value} onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))} required className="max-w-40 text-center font-mono tracking-[0.3em]" />
    </Field>
  );
}

/** Formulaire d'une opération : envoi, erreur affichée, fermeture et rechargement en cas de succès. */
export function useSubmit(done: () => void, success: string) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      toast(success);
      done();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}
