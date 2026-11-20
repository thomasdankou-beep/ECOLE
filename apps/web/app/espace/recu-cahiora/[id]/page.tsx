'use client';

import { useParams } from 'next/navigation';
import { Printer } from 'lucide-react';
import { Loader } from '@/components/espace/bits';
import { PrintBar } from '@/components/print/letterhead';
import { CahioraReceipt, type CahioraReceiptView } from '@/components/print/recu-cahiora';
import { Button } from '@/components/ui';
import { useApi } from '@/lib/use-api';

/** Reçu provisoire d'un paiement de l'abonnement Cahiora (lot G5d-2), vu et imprimé par la direction de l'établissement. */
export default function RecuCahiora() {
  const { id } = useParams<{ id: string }>();
  const q = useApi<CahioraReceiptView>(`/settings/subscription/receipts/${id}`);
  return (
    <>
      <PrintBar><Button onClick={() => window.print()} disabled={!q.data}><Printer className="size-4" /> Imprimer</Button></PrintBar>
      <Loader {...q}>{(r) => <CahioraReceipt r={r} />}</Loader>
    </>
  );
}
