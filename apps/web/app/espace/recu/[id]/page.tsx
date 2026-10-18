'use client';

import { useParams } from 'next/navigation';
import { Printer } from 'lucide-react';
import { Loader } from '@/components/espace/bits';
import { Letterhead, PrintBar } from '@/components/print/letterhead';
import { VerifyQr } from '@/components/qr';
import { Button } from '@/components/ui';
import { dateTime, fcfa } from '@/lib/format';
import { useApi } from '@/lib/use-api';

type Receipt = {
  id: string; number: string; verifyCode: string; issuedAt: string; cancelledAt: string | null; cancelReason: string | null; methodLabel: string; tenant: { name: string };
  payment: { amount: number; reference?: string | null; operator: string | null; transactionId: string; invoice: { number: string; label: string; total: number; paid: number }; student: { matricule: string; firstName: string; lastName: string; enrollments: { class: { name: string; site: { name: string } } }[] } };
};

export default function Recu() {
  const { id } = useParams<{ id: string }>();
  const q = useApi<Receipt>(`/finance/receipts/${id}`);
  return (
    <>
      <PrintBar><Button onClick={() => window.print()}><Printer className="size-4" /> Imprimer</Button></PrintBar>
      <Loader {...q}>
        {(r) => {
          const cls = r.payment.student.enrollments[0]?.class;
          return (
            <article className="relative mx-auto grid w-full max-w-[148mm] gap-4 overflow-hidden bg-white p-6 text-black shadow-sm print:shadow-none">
              {r.cancelledAt && <p className="absolute right-[-40px] top-10 rotate-[30deg] bg-bad px-16 py-1 text-lg font-extrabold text-white">ANNULÉ</p>}
              <Letterhead name={r.tenant.name} site={cls?.site.name} />
              <div className="flex items-baseline justify-between">
                <h1 className="font-display text-2xl font-bold uppercase">Reçu de paiement</h1>
                <p className="font-mono font-bold">N° {r.number}</p>
              </div>
              <dl className="grid grid-cols-[140px_1fr] gap-y-1.5 text-sm">
                <dt>Date</dt><dd className="font-bold">{dateTime(r.issuedAt)}</dd>
                <dt>Élève</dt><dd className="font-bold">{r.payment.student.lastName} {r.payment.student.firstName} · {r.payment.student.matricule}</dd>
                <dt>Classe</dt><dd>{cls ? `${cls.name} · ${cls.site.name}` : '—'}</dd>
                <dt>Objet</dt><dd>{r.payment.invoice.label} (facture {r.payment.invoice.number})</dd>
                <dt>Moyen</dt><dd>{r.methodLabel}{r.payment.operator ? ` · ${r.payment.operator}` : ''}</dd>
              </dl>
              <div className="rounded-lg border-2 border-brand p-3 text-center">
                <p className="text-xs uppercase">Montant reçu</p>
                <p className="tabular font-display text-4xl font-bold">{fcfa(r.payment.amount)}</p>
              </div>
              <p className="text-sm">Facture : {fcfa(r.payment.invoice.total)} · déjà réglé : {fcfa(r.payment.invoice.paid)} · reste : <b>{fcfa(r.payment.invoice.total - r.payment.invoice.paid)}</b></p>
              {r.cancelledAt && <p className="rounded bg-bad-soft p-2 text-sm text-bad">Reçu annulé le {dateTime(r.cancelledAt)} : {r.cancelReason}</p>}
              <div className="flex items-end justify-between">
                <VerifyQr code={r.verifyCode} size={80} />
                <div className="text-center text-sm"><p>Le caissier</p><p className="mt-10 text-xs text-black/60">Signature et cachet</p></div>
              </div>
              <p className="text-center text-[11px] text-black/60">Reçu non fiscal. Facture normalisée e-MECeF : INFORMATION MANQUANTE (raccordement à prévoir).</p>
            </article>
          );
        }}
      </Loader>
    </>
  );
}
