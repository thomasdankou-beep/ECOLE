'use client';

import { SchoolLogo } from '@/components/site/brand';
import { useSearchParams } from 'next/navigation';
import { Printer } from 'lucide-react';
import { Loader } from '@/components/espace/bits';
import { LegalFooter, Letterhead, PrintBar, Signatory, type SchoolIdentity } from '@/components/print/letterhead';
import { VerifyQr } from '@/components/qr';
import { Button } from '@/components/ui';
import { date, fcfa } from '@/lib/format';
import { useApi } from '@/lib/use-api';

type Doc = { id: string; kind: string; label: string; number: string; verifyCode: string; issuedAt: string; data: any };

export default function ImprimerDocuments() {
  const ids = useSearchParams().get('ids') ?? '';
  const q = useApi<{ tenant: { name: string }; identity: SchoolIdentity; documents: Doc[] }>(ids ? `/documents/print?ids=${ids}` : null);
  return (
    <>
      <PrintBar><Button onClick={() => window.print()}><Printer className="size-4" /> Imprimer</Button></PrintBar>
      <Loader {...q}>
        {({ tenant, identity, documents }) => (
          <div className="grid gap-6 print:block">
            {documents.map((d) => d.kind === 'CARTE_SCOLAIRE' ? <Card key={d.id} d={d} school={tenant.name} logo={identity.logoUrl} /> : <Letter key={d.id} d={d} identity={identity} />)}
          </div>
        )}
      </Loader>
    </>
  );
}

function Letter({ d, identity }: { d: Doc; identity: SchoolIdentity }) {
  const s = d.data.student;
  const born = s.birthDate ? `né(e) le ${date(s.birthDate, { day: 'numeric', month: 'long', year: 'numeric' })}${s.birthPlace ? ` à ${s.birthPlace}` : ''}` : '';
  return (
    <article className="mx-auto grid w-full max-w-[210mm] gap-6 bg-white p-8 text-black shadow-sm print:break-after-page print:shadow-none">
      <Letterhead identity={identity} site={d.data.site} />
      <div className="text-center">
        <h1 className="font-display text-3xl font-bold uppercase">{d.label}</h1>
        <p className="font-mono text-sm">N° {d.number}</p>
      </div>
      <p className="text-[15px] leading-7">
        Je soussigné(e), {identity.headName ? <b>{identity.headName}</b> : 'le chef d’établissement'}{identity.headName ? `, ${identity.headTitle.replace(/^Le |^La /, '').toLowerCase()}` : ''} du {identity.name}, certifie que l’élève <b>{s.lastName} {s.firstName}</b>{born ? `, ${born}` : ''}, matricule <b>{s.matricule}</b>,
        {d.kind === 'ATTESTATION_INSCRIPTION' ? ' est régulièrement inscrit(e)' : ' fréquente régulièrement l’établissement'} en classe de <b>{d.data.class}</b>
        {d.data.track ? ` (${d.data.track})` : ''}, site de {d.data.site}, au titre de l’année scolaire <b>{d.data.year}</b>.
      </p>
      {d.kind === 'ATTESTATION_PAIEMENT' && d.data.payments && (
        <p className="text-[15px] leading-7">À ce jour, la famille a réglé <b>{fcfa(d.data.payments.paid)}</b> sur un total facturé de {fcfa(d.data.payments.total)}.</p>
      )}
      <p className="text-[15px]">En foi de quoi, le présent document lui est délivré pour servir et valoir ce que de droit.</p>
      <div className="flex items-end justify-between gap-6">
        <VerifyQr code={d.verifyCode} />
        <div className="text-center">
          <p>Fait le {date(d.issuedAt, { day: 'numeric', month: 'long', year: 'numeric' })}</p>
          <Signatory identity={identity} className="mt-2" />
        </div>
      </div>
      <LegalFooter identity={identity} />
    </article>
  );
}

function Card({ d, school, logo }: { d: Doc; school: string; logo?: string | null }) {
  const s = d.data.student;
  return (
    <article className="mx-auto w-[86mm] overflow-hidden rounded-xl border-2 border-brand bg-white text-black print:mb-4 print:break-inside-avoid">
      <div className="flex items-center gap-2 bg-brand px-3 py-2 text-white">
        <SchoolLogo url={logo} name={school} size={32} className="bg-white" />
        <div className="leading-tight">
          <p className="font-display text-sm font-bold uppercase">{school}</p>
          <p className="text-[10px]">Carte scolaire {d.data.year}</p>
        </div>
      </div>
      <div className="flex gap-3 p-3">
        <div className="grid h-24 w-20 flex-none place-items-center rounded bg-sunk text-[10px] text-muted">{s.photoUrl ? <img src={s.photoUrl} alt="" className="size-full object-cover" /> : 'Photo'}</div>
        <div className="min-w-0 flex-1 text-[12px] leading-snug">
          <p className="font-bold uppercase">{s.lastName}</p>
          <p className="font-bold">{s.firstName}</p>
          <p>Matricule : <b className="font-mono">{s.matricule}</b></p>
          <p>Classe : {d.data.class}</p>
          <p>Site : {d.data.site}</p>
        </div>
        <VerifyQr code={d.verifyCode} size={64} />
      </div>
      <div className="flex h-1.5"><span className="flex-1 bg-red" /><span className="flex-1 bg-orange" /><span className="flex-1 bg-yellow" /></div>
    </article>
  );
}
