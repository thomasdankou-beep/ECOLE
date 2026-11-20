'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Printer } from 'lucide-react';
import { CahioraReceipt, type CahioraReceiptView } from '@/components/print/recu-cahiora';
import { PrintBar } from '@/components/print/letterhead';
import { Button, ErrorNote } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { pf } from '@/lib/platform';

/** Reçu provisoire d'un paiement enregistré par le Super Admin (lot G5d-2), à imprimer depuis la console. */
export default function RecuCahioraPlateforme() {
  const { id } = useParams<{ id: string }>();
  const [r, setR] = useState<CahioraReceiptView | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    pf<{ receipt: CahioraReceiptView }>('GET', `/billing/payments/${id}`).then((p) => setR(p.receipt)).catch(setError);
  }, [id]);
  return (
    <main className="mx-auto grid max-w-3xl gap-4 p-4">
      <PrintBar>
        <Button onClick={() => window.print()} disabled={!r}><Printer className="size-4" /> Imprimer</Button>
        <Link href="/plateforme" className="font-bold text-brand underline">Retour à la console</Link>
      </PrintBar>
      {error instanceof ApiError && error.status === 401 ? <p className="no-print">Connexion requise : <Link href="/plateforme/connexion" className="font-bold text-brand underline">se connecter</Link>.</p> : <ErrorNote error={error} />}
      {r && <CahioraReceipt r={r} />}
    </main>
  );
}
