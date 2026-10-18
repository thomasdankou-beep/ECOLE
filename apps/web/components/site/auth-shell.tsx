import Link from 'next/link';

/** Mise en page des écrans publics courts (connexion, mot de passe, vérification). */
export function AuthShell({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-md">
        <Link href="/" className="mb-6 flex items-center justify-center gap-3">
          <img src="/logo.png" alt="" width={56} height={56} className="size-14 rounded-full" />
          <span className="font-display text-2xl font-bold leading-none text-brand">
            Saint Kisito-GESA
            <span className="block text-sm font-semibold tracking-wide text-muted">Éduquer · Former · Réussir</span>
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
