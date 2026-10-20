'use client';

import { useRef, useState } from 'react';
import { ImageUp, Trash2 } from 'lucide-react';
import { Section } from '@/components/espace/bits';
import { Letterhead, Signatory, type SchoolIdentity } from '@/components/print/letterhead';
import { Button, Field, Input, Textarea, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useAction } from '@/lib/use-api';

export type IdentitySettings = { authorization: string; legalMentions: string; headName: string; headTitle: string; phone: string; email: string; address: string };

/** Identité officielle imprimée sur les bulletins, reçus et attestations : saisie par la direction, rien n'est pré-rempli. */
export function Etablissement({ settings, identity, reload }: { settings: IdentitySettings; identity: SchoolIdentity; reload: () => void }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const [f, setF] = useState<IdentitySettings>(settings);
  const set = (k: keyof IdentitySettings) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const preview: SchoolIdentity = {
    ...identity,
    authorization: f.authorization || null, legalMentions: f.legalMentions || null, headName: f.headName || null,
    headTitle: f.headTitle || 'Le chef d’établissement', phone: f.phone || identity.phone, email: f.email || null, address: f.address || null,
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Section title="Informations officielles">
        <form className="grid gap-3" onSubmit={async (e) => {
          e.preventDefault();
          if (await run(() => api.patch('/settings', { settings: { identity: f } }), toast, 'Informations enregistrées')) reload();
        }}>
          <Field label="Numéro d’autorisation d’ouverture" hint="Tel qu’il figure sur l’arrêté. Imprimé en tête de chaque document.">
            <Input value={f.authorization} onChange={set('authorization')} maxLength={200} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Nom du chef d’établissement"><Input value={f.headName} onChange={set('headName')} maxLength={120} /></Field>
            <Field label="Titre" hint="Ex. Le Directeur, La Proviseure"><Input value={f.headTitle} onChange={set('headTitle')} maxLength={80} /></Field>
            <Field label="Téléphone de l’école"><Input value={f.phone} onChange={set('phone')} maxLength={40} placeholder={identity.phone ?? ''} /></Field>
            <Field label="Adresse e-mail"><Input type="email" value={f.email} onChange={set('email')} maxLength={120} /></Field>
          </div>
          <Field label="Adresse postale"><Input value={f.address} onChange={set('address')} maxLength={300} /></Field>
          <Field label="Mentions légales en pied de document" hint="Ex. IFU, RCCM, références de l’arrêté. Laissez vide si vous n’en avez pas.">
            <Textarea value={f.legalMentions} onChange={set('legalMentions')} maxLength={1000} rows={3} />
          </Field>
          <Button type="submit" loading={busy}>Enregistrer</Button>
        </form>
      </Section>
      <div className="grid content-start gap-4">
        <Section title="Signature et cachet">
          <p className="mb-3 text-sm text-muted">Photo nette sur fond blanc (PNG de préférence). Ils sont imprimés sur les bulletins et attestations ; le cachet figure aussi sur les reçus.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <ImageSlot kind="signature" label="Signature" url={identity.signatureUrl} onChange={reload} />
            <ImageSlot kind="stamp" label="Cachet" url={identity.stampUrl} onChange={reload} />
          </div>
        </Section>
        <Section title="Aperçu sur un document">
          <div className="grid gap-4 rounded-lg bg-white p-4 text-black">
            <Letterhead identity={preview} />
            <div className="flex justify-end"><Signatory identity={preview} /></div>
          </div>
        </Section>
      </div>
    </div>
  );
}

const DONE = { signature: ['Signature enregistrée', 'Signature retirée'], stamp: ['Cachet enregistré', 'Cachet retiré'], logo: ['Logo enregistré', 'Logo retiré'] } as const;

export function ImageSlot({ kind, label, url, onChange, removable = true }: { kind: 'signature' | 'stamp' | 'logo'; label: string; url: string | null | undefined; onChange: () => void; removable?: boolean }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="grid gap-2 rounded-lg bg-sunk p-3">
      <p className="font-bold">{label}</p>
      <div className="grid h-24 place-items-center rounded bg-white">
        {url ? <img src={url} alt={label} className="max-h-20" /> : <span className="text-xs text-muted">Aucune image</span>}
      </div>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        const body = new FormData();
        body.append('file', file);
        if (await run(() => api.post(`/settings/identity/${kind}`, body), toast, DONE[kind][0])) onChange();
      }} />
      <div className="flex gap-2">
        <Button type="button" size="sm" variant="outline" loading={busy} onClick={() => input.current?.click()}><ImageUp className="size-4" /> {url ? 'Remplacer' : 'Envoyer'}</Button>
        {url && removable && <Button type="button" size="sm" variant="ghost" aria-label={`Retirer : ${label.toLowerCase()}`} onClick={async () => { if (await run(() => api.del(`/settings/identity/${kind}`), toast, DONE[kind][1])) onChange(); }}><Trash2 className="size-4" /></Button>}
      </div>
    </div>
  );
}
