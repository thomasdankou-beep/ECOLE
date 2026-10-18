'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Smartphone } from 'lucide-react';
import { AuthShell } from '@/components/site/auth-shell';
import { Button, ErrorNote, Skeleton } from '@/components/ui';
import { publicGet, publicPost } from '@/lib/api';
import { fcfa } from '@/lib/format';

type Info = { amount: number; operator: string; phone: string | null; label: string; status: string; paymentId: string };

/**
 * Écran de paiement du prestataire « bac à sable » : remplace la page de l'opérateur Mobile Money
 * tant que le contrat avec un agrégateur n'est pas signé (INFORMATION MANQUANTE).
 */
export default function Simulation() {
  const { transactionId } = useParams<{ transactionId: string }>();
  const router = useRouter();
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<'ok' | 'ko' | null>(null);

  useEffect(() => {
    publicGet<Info>(`/payments/sandbox/${encodeURIComponent(transactionId)}`).then(setInfo).catch(setError);
  }, [transactionId]);

  async function decide(success: boolean) {
    setBusy(success ? 'ok' : 'ko');
    try {
      await publicPost(`/payments/sandbox/${encodeURIComponent(transactionId)}/decision`, { success });
      router.replace(`/espace/frais?paiement=${info?.paymentId ?? ''}`);
    } catch (e) {
      setError(e);
      setBusy(null);
    }
  }

  return (
    <AuthShell title="Paiement Mobile Money" subtitle="Environnement de test : aucun argent réel n’est débité.">
      {error ? <ErrorNote error={error} /> : !info ? <Skeleton className="h-40" /> : (
        <div className="grid gap-4">
          <div className="grid justify-items-center gap-1 rounded-xl bg-sunk p-5 text-center">
            <Smartphone className="size-10 text-orange" />
            <p className="text-sm text-muted">{info.operator} · {info.phone}</p>
            <p className="tabular font-display text-4xl font-bold">{fcfa(info.amount)}</p>
            <p className="text-sm">{info.label}</p>
          </div>
          {info.status === 'PENDING' || info.status === 'INITIATED' ? (
            <>
              <p className="text-sm text-muted">Sur un vrai téléphone, l’opérateur demanderait ici votre code secret. Choisissez le résultat à simuler :</p>
              <Button size="lg" variant="success" loading={busy === 'ok'} disabled={!!busy} onClick={() => decide(true)}>Confirmer le paiement</Button>
              <Button size="lg" variant="outline" loading={busy === 'ko'} disabled={!!busy} onClick={() => decide(false)}>Refuser</Button>
            </>
          ) : (
            <Button size="lg" onClick={() => router.replace('/espace/frais')}>Paiement déjà traité, revenir</Button>
          )}
        </div>
      )}
    </AuthShell>
  );
}
