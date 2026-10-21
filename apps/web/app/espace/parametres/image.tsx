'use client';

import { useState } from 'react';
import { Section } from '@/components/espace/bits';
import { SchoolLogo } from '@/components/site/brand';
import { Button, Field, Input, Textarea, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useAction } from '@/lib/use-api';
import { ImageSlot } from './etablissement';

export type PublicTexts = { slogan?: string; tagline?: string; phone?: string; rentree?: string; entranceTest?: string; requiredDocuments?: string[]; highlights?: string[]; reasons?: string[]; motto?: string; [k: string]: unknown };

const DEFAULT_COLOR = '#1b3a8c';
const lines = (v: string) => v.split('\n').map((x) => x.trim()).filter(Boolean);

/** Nom, logo, couleur et textes du site public : saisis par l'école elle-même. */
export function ImageEcole({ name, shortName, logoUrl, primaryColor, texts, reload }: {
  name: string; shortName: string | null; logoUrl: string | null | undefined; primaryColor: string | null; texts: PublicTexts; reload: () => void;
}) {
  const toast = useToast();
  const { busy, run } = useAction();
  const [n, setN] = useState({ name, shortName: shortName ?? '', color: primaryColor ?? '' });
  const [t, setT] = useState({
    slogan: texts.slogan ?? '', tagline: texts.tagline ?? '', phone: texts.phone ?? '', rentree: texts.rentree ?? '', motto: texts.motto ?? '',
    highlights: (texts.highlights ?? []).join('\n'), reasons: (texts.reasons ?? []).join('\n'),
    entranceTest: texts.entranceTest ?? '', requiredDocuments: (texts.requiredDocuments ?? []).join('\n'),
  });
  const setText = (k: keyof typeof t) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setT({ ...t, [k]: e.target.value });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="grid content-start gap-4">
        <Section title="Nom et couleur">
          <form className="grid gap-3" onSubmit={async (e) => {
            e.preventDefault();
            const ok = await run(() => api.patch('/settings', { name: n.name, shortName: n.shortName, settings: { branding: { primaryColor: n.color || null } } }), toast, 'Nom et couleur enregistrés');
            if (ok) reload();
          }}>
            <Field label="Nom complet de l’école" hint="Affiché sur le site public et en tête des documents.">
              <Input value={n.name} onChange={(e) => setN({ ...n, name: e.target.value })} required minLength={3} maxLength={160} />
            </Field>
            <Field label="Nom court" hint="Pour les menus et les SMS. Ex. Saint Kisito-GESA">
              <Input value={n.shortName} onChange={(e) => setN({ ...n, shortName: e.target.value })} maxLength={60} />
            </Field>
            <Field label="Couleur principale" hint="Boutons, titres et bandeau. Laissez vide pour la couleur par défaut.">
              <div className="flex items-center gap-2">
                <input type="color" aria-label="Choisir la couleur" value={n.color || DEFAULT_COLOR} onChange={(e) => setN({ ...n, color: e.target.value })} className="h-11 w-14 cursor-pointer rounded border border-line bg-surface" />
                <Input value={n.color} onChange={(e) => setN({ ...n, color: e.target.value })} placeholder={DEFAULT_COLOR} pattern="#[0-9a-fA-F]{6}" maxLength={7} className="max-w-36" />
                {n.color && <Button type="button" variant="ghost" size="sm" onClick={() => setN({ ...n, color: '' })}>Par défaut</Button>}
              </div>
            </Field>
            <Button type="submit" loading={busy}>Enregistrer</Button>
          </form>
        </Section>
        <Section title="Logo">
          <p className="mb-3 text-sm text-muted">Image carrée de préférence (PNG sur fond transparent ou blanc). Sans logo, les initiales de l’école s’affichent.</p>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-center">
            <ImageSlot kind="logo" label="Logo" url={logoUrl} onChange={reload} removable={!!logoUrl?.startsWith('/api/')} />
            <div className="grid justify-items-center gap-1 text-xs text-muted">
              <SchoolLogo url={logoUrl} name={n.shortName || n.name} size={72} />
              Aperçu
            </div>
          </div>
        </Section>
      </div>
      <Section title="Textes du site public">
        <form className="grid gap-3" onSubmit={async (e) => {
          e.preventDefault();
          const pub = { ...texts, slogan: t.slogan, tagline: t.tagline, phone: t.phone, rentree: t.rentree || undefined, motto: t.motto, highlights: lines(t.highlights), reasons: lines(t.reasons), entranceTest: t.entranceTest || undefined, requiredDocuments: lines(t.requiredDocuments) };
          if (await run(() => api.patch('/settings', { settings: { public: pub } }), toast, 'Site public mis à jour')) reload();
        }}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Devise"><Input value={t.slogan} onChange={setText('slogan')} maxLength={120} placeholder="Ex. Éduquer · Former · Réussir" /></Field>
            <Field label="Téléphone affiché"><Input value={t.phone} onChange={setText('phone')} maxLength={40} /></Field>
          </div>
          <Field label="Accroche sous le nom"><Input value={t.tagline} onChange={setText('tagline')} maxLength={160} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Date de la rentrée" hint="Laissez vide pour ne pas l’afficher."><Input type="date" value={t.rentree} onChange={setText('rentree')} /></Field>
            <Field label="Date du test d’entrée" hint="Facultatif."><Input type="date" value={t.entranceTest} onChange={setText('entranceTest')} /></Field>
          </div>
          <Field label="Points forts du bandeau" hint="Un par ligne."><Textarea value={t.highlights} onChange={setText('highlights')} rows={3} maxLength={600} /></Field>
          <Field label="Pourquoi nous choisir" hint="Une raison par ligne. Laissez vide pour masquer la rubrique."><Textarea value={t.reasons} onChange={setText('reasons')} rows={4} maxLength={1000} /></Field>
          <Field label="Pièces à fournir pour l’inscription" hint="Une par ligne. Affichées sur la page de pré-inscription."><Textarea value={t.requiredDocuments} onChange={setText('requiredDocuments')} rows={4} maxLength={2000} /></Field>
          <Field label="Phrase de conclusion"><Input value={t.motto} onChange={setText('motto')} maxLength={160} /></Field>
          <Button type="submit" loading={busy}>Enregistrer</Button>
        </form>
      </Section>
    </div>
  );
}
