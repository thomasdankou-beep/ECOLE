'use client';

import { date } from '@/lib/format';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { SiteFooter, SiteHeader } from '@/components/site/chrome';
import { Button, Card, ErrorNote, Field, Input, Select, Textarea } from '@/components/ui';
import { publicGet, publicPost } from '@/lib/api';
import { tenantOrThrow } from '@/lib/tenant';

type School = { sites: { name: string }[]; tracks: { name: string; cycle: string }[]; levels: { name: string; cycle: string }[]; public?: { entranceTest?: string; requiredDocuments?: string[] } };

export default function Preinscription() {
  const [school, setSchool] = useState<School | null>(null);
  const [f, setF] = useState({ studentFirstName: '', studentLastName: '', sex: '', birthDate: '', previousSchool: '', wantedLevel: '', wantedTrack: '', wantedSite: '', guardianName: '', guardianPhone: '', guardianEmail: '', message: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [reference, setReference] = useState<string | null>(null);

  useEffect(() => {
    tenantOrThrow().then((t) => publicGet<School>(`/public/${t}`)).then(setSchool).catch(setError);
  }, []);

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== ''));
      const r = await publicPost<{ reference: string }>(`/public/${await tenantOrThrow()}/applications`, body);
      setReference(r.reference);
      window.scrollTo({ top: 0 });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-3xl px-4 pt-8">
        <h1 className="text-4xl font-bold">Pré-inscription en ligne</h1>
        <p className="mt-1 text-muted">Remplissez ce formulaire : le secrétariat vous rappelle pour compléter le dossier.</p>
        {!reference && (school?.public?.entranceTest || (school?.public?.requiredDocuments?.length ?? 0) > 0) && (
          <Card className="mt-4 grid gap-2">
            {school?.public?.entranceTest && <p className="font-bold">Test d’entrée : {date(school.public.entranceTest, { day: 'numeric', month: 'long', year: 'numeric' })}</p>}
            {(school?.public?.requiredDocuments?.length ?? 0) > 0 && (
              <>
                <p className="font-bold">Pièces à fournir pour l’inscription</p>
                <ul className="grid list-disc gap-1 pl-5 text-sm">{school!.public!.requiredDocuments!.map((d) => <li key={d}>{d}</li>)}</ul>
              </>
            )}
          </Card>
        )}
        {reference ? (
          <Card className="mt-6 grid justify-items-center gap-3 py-10 text-center">
            <CheckCircle2 className="size-14 text-good" />
            <h2 className="text-3xl font-bold">Demande enregistrée</h2>
            <p>Votre numéro de dossier :</p>
            <p className="rounded-lg bg-sunk px-4 py-2 font-mono text-2xl font-bold">{reference}</p>
            <p className="max-w-md text-muted">Conservez ce numéro. Le secrétariat vous contactera au numéro indiqué.</p>
            <Button asChild variant="outline"><Link href="/">Retour à l’accueil</Link></Button>
          </Card>
        ) : (
          <form onSubmit={submit} className="mt-6 grid gap-5">
            <Card className="grid gap-4">
              <h2 className="text-2xl font-bold">L’élève</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Nom"><Input value={f.studentLastName} onChange={set('studentLastName')} required minLength={2} /></Field>
                <Field label="Prénoms"><Input value={f.studentFirstName} onChange={set('studentFirstName')} required minLength={2} /></Field>
                <Field label="Sexe">
                  <Select value={f.sex} onChange={set('sex')}>
                    <option value="">Non précisé</option>
                    <option value="F">Fille</option>
                    <option value="M">Garçon</option>
                  </Select>
                </Field>
                <Field label="Date de naissance"><Input type="date" value={f.birthDate} onChange={set('birthDate')} /></Field>
                <Field label="École fréquentée l’an dernier" className="sm:col-span-2"><Input value={f.previousSchool} onChange={set('previousSchool')} /></Field>
              </div>
            </Card>
            <Card className="grid gap-4">
              <h2 className="text-2xl font-bold">La formation souhaitée</h2>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Niveau">
                  <Select value={f.wantedLevel} onChange={set('wantedLevel')} required>
                    <option value="">Choisir</option>
                    {school?.levels.map((l) => <option key={l.name}>{l.name}</option>)}
                  </Select>
                </Field>
                <Field label="Filière">
                  <Select value={f.wantedTrack} onChange={set('wantedTrack')}>
                    <option value="">Choisir</option>
                    {school?.tracks.map((t) => <option key={t.name}>{t.name}</option>)}
                  </Select>
                </Field>
                <Field label="Site">
                  <Select value={f.wantedSite} onChange={set('wantedSite')}>
                    <option value="">Indifférent</option>
                    {school?.sites.map((s) => <option key={s.name}>{s.name}</option>)}
                  </Select>
                </Field>
              </div>
            </Card>
            <Card className="grid gap-4">
              <h2 className="text-2xl font-bold">Le parent ou tuteur</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Nom et prénoms"><Input value={f.guardianName} onChange={set('guardianName')} required minLength={3} /></Field>
                <Field label="Téléphone" hint="Numéro joignable par appel ou WhatsApp"><Input type="tel" inputMode="tel" value={f.guardianPhone} onChange={set('guardianPhone')} required minLength={8} /></Field>
                <Field label="E-mail (facultatif)" className="sm:col-span-2"><Input type="email" value={f.guardianEmail} onChange={set('guardianEmail')} /></Field>
                <Field label="Message (facultatif)" className="sm:col-span-2"><Textarea value={f.message} onChange={set('message')} maxLength={1000} /></Field>
              </div>
            </Card>
            <p className="text-sm text-muted">Les informations transmises servent uniquement au traitement de la demande d’inscription par l’école.</p>
            <ErrorNote error={error} />
            <Button type="submit" size="lg" variant="accent" loading={busy}>Envoyer la demande</Button>
          </form>
        )}
      </main>
      <SiteFooter />
    </>
  );
}
