'use client';

import Link from 'next/link';
import { usePublicSchool } from '@/lib/public-school';
import { BrandStyle, SchoolLogo } from './brand';

/** Mise en page des écrans publics courts (connexion, mot de passe, vérification). */
export function AuthShell({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  const school = usePublicSchool();
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <BrandStyle color={school?.branding.primaryColor} />
      <div className="w-full max-w-md">
        <Link href="/" className="mb-6 flex min-h-14 items-center justify-center gap-3">
          {school && <SchoolLogo url={school.branding.logoUrl} name={school.shortName ?? school.name} size={56} />}
          <span className="font-display text-2xl font-bold leading-none text-brand">
            {school?.shortName ?? school?.name}
            {school?.public.slogan && <span className="block text-sm font-semibold tracking-wide text-muted">{school.public.slogan}</span>}
          </span>
        </Link>
        <div className="rounded-2xl border border-line bg-surface p-5 shadow-sm sm:p-6">
          <h1 className="text-3xl font-bold">{title}</h1>
          {subtitle && <p className="mt-1 text-muted">{subtitle}</p>}
          <div className="mt-5">{children}</div>
        </div>
        <div className="mt-3 flex h-1.5 overflow-hidden rounded-full">
          <span className="flex-1 bg-red" />
          <span className="flex-1 bg-orange" />
          <span className="flex-1 bg-yellow" />
        </div>
      </div>
    </main>
  );
}
