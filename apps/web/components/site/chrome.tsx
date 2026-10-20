import Link from 'next/link';
import { Phone } from 'lucide-react';
import { SiteNames } from './site-names';

export const SCHOOL = {
  name: 'Lycée privé Saint Kisito-GESA',
  short: 'Saint Kisito-GESA',
  phone: '01 40 63 24 39',
};

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur no-print">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-2.5">
        <Link href="/" className="flex min-w-0 items-center gap-2.5">
          <img src="/logo.png" alt="" width={44} height={44} className="size-11 flex-none rounded-full" />
          <span className="min-w-0 leading-tight">
            <span className="block truncate font-display text-lg font-bold text-brand">{SCHOOL.short}</span>
            <span className="block min-h-4 truncate text-xs text-muted"><SiteNames /></span>
          </span>
        </Link>
        <nav className="flex items-center gap-1.5 text-sm font-bold">
          <Link href="/#filieres" className="hidden rounded-lg px-3 py-2 hover:bg-sunk md:block">Filières</Link>
          <Link href="/#sites" className="hidden rounded-lg px-3 py-2 hover:bg-sunk md:block">Nos sites</Link>
          <Link href="/preinscription" className="hidden rounded-lg px-3 py-2 hover:bg-sunk sm:block">Pré-inscription</Link>
          <Link href="/connexion" className="inline-flex min-h-11 items-center rounded-lg bg-brand px-4 text-brand-ink hover:bg-brand-strong">Se connecter</Link>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-16 bg-brand-strong text-white no-print dark:bg-sunk">
      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-10 sm:grid-cols-3">
        <div>
          <p className="font-display text-xl font-bold">{SCHOOL.name}</p>
          <p className="mt-1 text-sm opacity-80">Éduquer · Former · Réussir</p>
        </div>
        <div className="text-sm">
          <p className="font-bold">Nous joindre</p>
          <a href={`tel:+229${SCHOOL.phone.replace(/\s/g, '')}`} className="mt-1 inline-flex items-center gap-2 opacity-90 hover:underline">
            <Phone className="size-4" /> {SCHOOL.phone}
          </a>
        </div>
        <div className="grid content-start gap-1 text-sm">
          <Link href="/preinscription" className="opacity-90 hover:underline">Pré-inscription en ligne</Link>
          <Link href="/connexion" className="opacity-90 hover:underline">Espace parents, élèves et personnel</Link>
          <Link href="/verifier" className="opacity-90 hover:underline">Vérifier un document</Link>
        </div>
      </div>
      <p className="border-t border-white/15 px-4 py-4 text-center text-xs opacity-70">© {new Date().getFullYear()} {SCHOOL.name}</p>
    </footer>
  );
}
