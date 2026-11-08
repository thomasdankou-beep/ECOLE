'use client';

import { useState } from 'react';
import { Copy, Download, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui';

/**
 * Codes de récupération affichés une seule fois : le serveur ne garde que leur empreinte.
 * La personne les copie ou les télécharge, puis confirme les avoir rangés avant de continuer.
 */
export function RecoveryCodesPanel({ codes, account, onDone, doneLabel = 'Continuer' }: { codes: string[]; account?: string; onDone: () => void; doneLabel?: string }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = [
    'Codes de récupération Cahiora',
    account ? `Compte : ${account}` : '',
    `Créés le ${new Date().toLocaleString('fr-FR')}`,
    '',
    ...codes,
    '',
    'Chaque code ne sert qu’une seule fois, si vous n’avez plus votre téléphone.',
    'Gardez ce papier en lieu sûr, à part de votre téléphone. Ne le partagez avec personne.',
  ].filter((l, i) => l || i > 2).join('\n');

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'codes-de-recuperation-cahiora.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className="grid gap-3" data-testid="recovery-codes">
      <p className="flex items-start gap-2 rounded-lg bg-warn-soft p-3 text-sm font-bold text-warn">
        <KeyRound className="mt-0.5 size-4 shrink-0" />
        Notez ces {codes.length} codes maintenant : ils ne seront plus jamais affichés. Chacun sert une seule fois si vous perdez votre téléphone.
      </p>
      <ol className="grid grid-cols-2 gap-2 rounded-lg bg-sunk p-3 font-mono text-sm sm:text-base">
        {codes.map((c) => <li key={c} className="text-center tracking-wider">{c}</li>)}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={copy}><Copy className="size-4" /> {copied ? 'Copiés' : 'Copier'}</Button>
        <Button type="button" variant="outline" size="sm" onClick={download}><Download className="size-4" /> Télécharger</Button>
      </div>
      <label className="flex min-h-11 items-center gap-3 text-sm font-bold">
        <input type="checkbox" className="size-5" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        J’ai noté ces codes en lieu sûr
      </label>
      <Button type="button" disabled={!saved} onClick={onDone}>{doneLabel}</Button>
    </div>
  );
}
