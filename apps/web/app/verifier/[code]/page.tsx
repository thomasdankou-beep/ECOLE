'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { AuthShell } from '@/components/site/auth-shell';
import { Skeleton } from '@/components/ui';
import { publicGet } from '@/lib/api';
import { date } from '@/lib/format';

type Result = { valid: boolean; revoked?: boolean; kind?: string; summary?: string; issuedAt?: string; issuer?: string };

export default function VerifierCode() {
  const { code } = useParams<{ code: string }>();
  const [r, setR] = useState<Result | null>(null);
  useEffect(() => {
    publicGet<Result>(`/public/verify/${encodeURIComponent(code)}`).then(setR).catch(() => setR({ valid: false }));
  }, [code]);

  return (
    <AuthShell title="Vérification du document">
      {!r ? (
        <Skeleton className="h-32" />
      ) : r.valid ? (
        <div className="grid gap-3">
          <p className="flex items-center gap-2 text-xl font-extrabold text-good"><ShieldCheck className="size-8" /> Document authentique</p>
          <dl className="grid gap-2 rounded-lg bg-sunk p-4 text-sm">
            <div><dt className="font-bold text-muted">Émetteur</dt><dd className="text-base font-bold">{r.issuer}</dd></div>
            <div><dt className="font-bold text-muted">Document</dt><dd className="text-base">{r.summary}</dd></div>
            <div><dt className="font-bold text-muted">Émis le</dt><dd>{date(r.issuedAt, { day: 'numeric', month: 'long', year: 'numeric' })}</dd></div>
          </dl>
          <p className="text-sm text-muted">Comparez ces informations avec le document papier présenté.</p>
        </div>
      ) : (
        <div className="grid gap-3">
          <p className="flex items-center gap-2 text-xl font-extrabold text-bad"><ShieldAlert className="size-8" /> {r.revoked ? 'Document annulé' : 'Code inconnu'}</p>
          <p className="text-muted">{r.revoked ? 'Ce document a été annulé par l’école et n’est plus valable.' : 'Aucun document ne correspond à ce code. Vérifiez la saisie ou contactez l’école.'}</p>
        </div>
      )}
      <Link href="/verifier" className="mt-5 block text-center text-sm font-bold text-brand">Vérifier un autre code</Link>
    </AuthShell>
  );
}
