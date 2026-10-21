'use client';

import Link from 'next/link';
import { Phone } from 'lucide-react';
import { telHref, usePublicSchool } from '@/lib/public-school';
import { BrandStyle, SchoolLogo } from './brand';

export function SiteHeader() {
  const school = usePublicSchool();
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur no-print">
      <BrandStyle color={school?.branding.primaryColor} />
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-2.5">
        <Link href="/" className="flex min-w-0 items-center gap-2.5">
          <SchoolLogo url={school?.branding.logoUrl} name={school?.shortName ?? school?.name} size={44} />
          <span className="min-w-0 leading-tight">
            <span className="block min-h-6 truncate font-display text-lg font-bold text-brand">{school?.shortName ?? school?.name}</span>
            <span className="block min-h-4 truncate text-xs text-muted">{school?.sites.map((s) => s.name).join(' · ')}</span>
          </span>
        </Link>
        <nav className="flex items-center gap-1.5 text-sm font-bold">
          {school?.tracks.length ? <Link href="/#filieres" className="hidden rounded-lg px-3 py-2 hover:bg-sunk md:block">Filières</Link> : null}
          {school?.honors?.length ? <Link href="/#honneur" className="hidden rounded-lg px-3 py-2 hover:bg-sunk lg:block">Nos lauréats</Link> : null}
          <Link href="/#admission" className="hidden rounded-lg px-3 py-2 hover:bg-sunk lg:block">Admission</Link>
          <Link href="/#sites" className="hidden rounded-lg px-3 py-2 hover:bg-sunk md:block">{school?.sites.length === 1 ? 'Notre site' : 'Nos sites'}</Link>
          <Link href="/preinscription" className="hidden rounded-lg px-3 py-2 hover:bg-sunk sm:block">Pré-inscription</Link>
          <Link href="/connexion" className="inline-flex min-h-11 items-center rounded-lg bg-brand px-4 text-brand-ink hover:bg-brand-strong">Se connecter</Link>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  const school = usePublicSchool();
  const phone = school?.public.phone;
  return (
    <footer className="mt-16 bg-brand-strong text-white no-print dark:bg-sunk">
      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-10 sm:grid-cols-3">
        <div>
          <p className="font-display text-xl font-bold">{school?.name}</p>
          {school?.public.slogan && <p className="mt-1 text-sm opacity-80">{school.public.slogan}</p>}
        </div>
        <div className="text-sm">
          {phone && (
            <>
              <p className="font-bold">Nous joindre</p>
              <a href={telHref(phone, school?.country)} className="mt-1 inline-flex items-center gap-2 opacity-90 hover:underline">
                <Phone className="size-4" /> {phone}
              </a>
            </>
          )}
        </div>
        <div className="grid content-start gap-1 text-sm">
          <Link href="/preinscription" className="opacity-90 hover:underline">Pré-inscription en ligne</Link>
          <Link href="/connexion" className="opacity-90 hover:underline">Espace parents, élèves et personnel</Link>
          <Link href="/verifier" className="opacity-90 hover:underline">Vérifier un document</Link>
        </div>
      </div>
      <p className="border-t border-white/15 px-4 py-4 text-center text-xs opacity-70">© {new Date().getFullYear()} {school?.name}</p>
    </footer>
  );
}
