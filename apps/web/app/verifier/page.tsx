'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AuthShell } from '@/components/site/auth-shell';
import { Button, Field, Input } from '@/components/ui';

export default function Verifier() {
  const router = useRouter();
  const [code, setCode] = useState('');
  return (
    <AuthShell title="Vérifier un document" subtitle="Saisissez le code imprimé sous le QR code d’un bulletin, d’un reçu ou d’une attestation.">
      <form onSubmit={(e) => { e.preventDefault(); if (code.trim()) router.push(`/verifier/${encodeURIComponent(code.trim().toUpperCase())}`); }} className="grid gap-4">
        <Field label="Code de vérification"><Input value={code} onChange={(e) => setCode(e.target.value)} required className="font-mono uppercase tracking-wider" /></Field>
        <Button type="submit" size="lg">Vérifier</Button>
      </form>
    </AuthShell>
  );
}
