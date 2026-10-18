'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowRight, BadgeCheck, CalendarDays, CreditCard, GraduationCap, MapPin, MessageSquareText, Phone, Wrench } from 'lucide-react';
import { SiteFooter, SiteHeader, SCHOOL } from '@/components/site/chrome';
import { publicGet, TENANT } from '@/lib/api';
import { date } from '@/lib/format';

type School = {
  name: string;
  public: { slogan?: string; tagline?: string; phone?: string; rentree?: string; highlights?: string[]; reasons?: string[]; motto?: string };
  sites: { id: string; name: string; address: string | null; phone: string | null }[];
  tracks: { code: string; name: string; cycle: string }[];
};

/* Contenu repris des affiches de l'école ; remplacé par les réglages publics de l'API dès qu'ils sont chargés. */
const FALLBACK: School = {
  name: SCHOOL.name,
  public: {
    slogan: 'Éduquer · Former · Réussir',
    tagline: 'La référence de l’excellence professionnelle',
    phone: SCHOOL.phone,
    rentree: '2026-09-14',
    highlights: ['100 % pratique', 'Garantie de stage', 'Obtention de CQM, CAP et DT'],
    reasons: ['Enseignants qualifiés', 'Formation pratique et professionnelle', 'Stages en entreprise garantis', 'Obtention du CQP, CAP et DT', 'Matériels modernes et ateliers équipés'],
    motto: 'Oser, apprendre, garantir son avenir !',
  },
  sites: [
    { id: 'h', name: 'Hêdomey', address: 'Hêdomey Carrefour, 2e von à gauche après le carrefour', phone: SCHOOL.phone },
    { id: 't', name: 'Togbin', address: 'Togbin Kpèvi, immeuble Kpondjou', phone: SCHOOL.phone },
  ],
  tracks: [],
};

const TRACK_IMG: Record<string, string> = { F3: '/img/electrotechnique.jpg', F4: '/img/genie-civil.jpg', OG: '/img/geometre.jpg', HR: '/img/hotellerie.jpg', MMV: '/img/mode.jpg' };
const TRACKS_FALLBACK = [
  { code: 'F3', name: 'Électrotechnique (F3)' },
  { code: 'F4', name: 'Génie civil (F4)' },
  { code: 'OG', name: 'Opérateur géomètre (OG)' },
  { code: 'HR', name: 'Hôtellerie restauration (HR)' },
  { code: 'MMV', name: 'Mode et vêtement (MMV)' },
  { code: 'G2', name: 'Comptabilité gestion (G2)' },
  { code: 'IMI', name: 'Installation et maintenance informatique (IMI)' },
];

export default function Home() {
  const [s, setS] = useState<School>(FALLBACK);
  useEffect(() => {
    publicGet<School>(`/public/${TENANT}`).then((d) => setS({ ...FALLBACK, ...d, public: { ...FALLBACK.public, ...d.public } })).catch(() => {});
  }, []);
  const p = s.public;
  const tech = s.tracks.filter((t) => t.cycle === 'LYCEE_TECHNIQUE');
  const tracks = [...(tech.length ? tech : TRACKS_FALLBACK)].sort((a, b) => Number(!TRACK_IMG[a.code]) - Number(!TRACK_IMG[b.code]));
  const tel = `tel:+229${(p.phone ?? SCHOOL.phone).replace(/\s/g, '')}`;

  return (
    <>
      <SiteHeader />
      <main>
        {/* Bandeau d'accueil aux couleurs des affiches */}
        <section className="relative overflow-hidden bg-brand-strong text-white">
          <div className="absolute inset-0 opacity-25">
            <img src="/img/electrotechnique.jpg" alt="" className="size-full object-cover" />
          </div>
          <div className="absolute inset-0 bg-gradient-to-r from-[#0f2258] via-[#13296a]/90 to-transparent" />
          <div className="relative mx-auto grid max-w-6xl gap-6 px-4 py-14 sm:py-20 md:grid-cols-[1.4fr_1fr] md:items-center">
            <div>
              <span className="inline-flex items-center gap-2 rounded-full bg-yellow px-3 py-1 text-sm font-extrabold text-[#1b1206]">
                <CalendarDays className="size-4" /> Rentrée scolaire le {date(p.rentree, { day: 'numeric', month: 'long', year: 'numeric' })}
              </span>
              <h1 className="mt-4 text-[44px] font-bold uppercase leading-[0.95] sm:text-6xl">
                Lycée privé <span className="text-yellow">Saint Kisito</span>-GESA
              </h1>
              <p className="mt-3 text-xl font-bold text-orange">{p.tagline}</p>
              <p className="mt-2 max-w-xl text-lg opacity-90">Collège général de la 6e à la 3e et lycée technique sur deux sites, Hêdomey et Togbin.</p>
              <div className="mt-6 flex flex-wrap gap-3">
                <Link href="/preinscription" className="inline-flex min-h-12 items-center gap-2 rounded-lg bg-orange px-5 font-extrabold text-[#1b1206] hover:brightness-95">
                  Pré-inscrire mon enfant <ArrowRight className="size-5" />
                </Link>
                <a href={tel} className="inline-flex min-h-12 items-center gap-2 rounded-lg border border-white/50 px-5 font-bold hover:bg-white/10">
                  <Phone className="size-5" /> {p.phone}
                </a>
              </div>
            </div>
            <ul className="grid gap-2.5">
              {(p.highlights ?? []).map((h) => (
                <li key={h} className="flex items-center gap-3 rounded-xl bg-white/10 px-4 py-3 text-lg font-bold backdrop-blur">
                  <BadgeCheck className="size-6 flex-none text-yellow" /> {h}
                </li>
              ))}
            </ul>
          </div>
          <div className="relative flex h-2">
            <span className="flex-1 bg-red" />
            <span className="flex-1 bg-orange" />
            <span className="flex-1 bg-yellow" />
          </div>
        </section>

        {/* Filières */}
        <section id="filieres" className="mx-auto max-w-6xl scroll-mt-20 px-4 pt-14">
          <p className="font-bold uppercase tracking-wider text-orange">Enseignement technique</p>
          <h2 className="text-4xl font-bold">Nos filières</h2>
          <p className="mt-2 max-w-2xl text-muted">Une formation pratique en ateliers, avec stages en entreprise, préparant aux examens professionnels.</p>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {tracks.map((t) => (
              <article key={t.code} className="group overflow-hidden rounded-xl border border-line bg-surface">
                {TRACK_IMG[t.code] ? (
                  <img src={TRACK_IMG[t.code]} alt="" className="aspect-[16/9] w-full object-cover transition-transform group-hover:scale-[1.03]" />
                ) : (
                  <div className="grid aspect-[16/9] place-items-center bg-brand-soft text-brand">
                    <Wrench className="size-10" />
                  </div>
                )}
                <div className="p-4">
                  <span className="rounded-md bg-brand px-2 py-0.5 text-xs font-extrabold text-brand-ink">{t.code}</span>
                  <h3 className="mt-2 text-xl font-bold">{t.name.replace(/\s*\([^)]*\)$/, '')}</h3>
                </div>
              </article>
            ))}
            <article className="flex flex-col justify-between rounded-xl border border-line bg-surface p-5">
              <div>
                <GraduationCap className="size-8 text-brand" />
                <h3 className="mt-2 text-xl font-bold">Collège général</h3>
                <p className="mt-1 text-muted">De la 6e à la 3e, préparation au BEPC.</p>
              </div>
              <Link href="/preinscription" className="mt-4 inline-flex items-center gap-1 font-bold text-brand">Demander une place <ArrowRight className="size-4" /></Link>
            </article>
          </div>
        </section>

        {/* Pourquoi nous choisir */}
        <section className="mx-auto max-w-6xl px-4 pt-14">
          <div className="grid gap-6 rounded-2xl bg-surface p-6 sm:p-8 md:grid-cols-[1fr_1.3fr] md:items-center">
            <div>
              <h2 className="text-4xl font-bold">Pourquoi nous choisir ?</h2>
              <p className="mt-2 text-xl font-bold text-red">{p.motto}</p>
            </div>
            <ul className="grid gap-2 sm:grid-cols-2">
              {(p.reasons ?? []).map((r) => (
                <li key={r} className="flex items-start gap-2 rounded-lg bg-sunk px-3 py-2.5 font-bold">
                  <BadgeCheck className="mt-0.5 size-5 flex-none text-good" /> {r}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* L'espace numérique */}
        <section className="mx-auto max-w-6xl px-4 pt-14">
          <h2 className="text-4xl font-bold">Suivez la scolarité depuis votre téléphone</h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            {[
              { icon: GraduationCap, t: 'Notes et bulletins', d: 'Les notes dès leur publication et le bulletin officiel avec QR code.' },
              { icon: MessageSquareText, t: 'Absences et messages', d: 'Un message le jour même en cas d’absence, justification par photo.' },
              { icon: CreditCard, t: 'Frais scolaires', d: 'Solde à jour, paiement Mobile Money et reçu immédiat.' },
            ].map(({ icon: I, t, d }) => (
              <div key={t} className="rounded-xl border border-line bg-surface p-5">
                <I className="size-8 text-orange" />
                <h3 className="mt-2 text-xl font-bold">{t}</h3>
                <p className="mt-1 text-muted">{d}</p>
              </div>
            ))}
          </div>
          <Link href="/connexion" className="mt-5 inline-flex min-h-12 items-center gap-2 rounded-lg bg-brand px-5 font-extrabold text-brand-ink hover:bg-brand-strong">
            Accéder à mon espace <ArrowRight className="size-5" />
          </Link>
        </section>

        {/* Sites */}
        <section id="sites" className="mx-auto max-w-6xl scroll-mt-20 px-4 pt-14">
          <h2 className="text-4xl font-bold">Nos deux sites</h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {s.sites.map((site) => (
              <div key={site.id} className="rounded-xl border border-line bg-surface p-5">
                <h3 className="text-2xl font-bold text-brand">{site.name}</h3>
                {site.address && (
                  <p className="mt-2 flex items-start gap-2"><MapPin className="mt-0.5 size-5 flex-none text-red" /> {site.address}</p>
                )}
                {site.phone && (
                  <a href={`tel:+229${site.phone.replace(/\s/g, '')}`} className="mt-2 flex items-center gap-2 font-bold hover:underline"><Phone className="size-5 text-good" /> {site.phone}</a>
                )}
              </div>
            ))}
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
