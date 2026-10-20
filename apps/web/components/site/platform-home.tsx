import Link from 'next/link';
import { Building2, Lock } from 'lucide-react';

/** Adresse de la plateforme elle-même : aucune école n'y est servie. */
export function PlatformHome() {
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-md text-center">
        <Building2 className="mx-auto size-12 text-brand" />
        <h1 className="mt-3 text-4xl font-bold">Gestion scolaire</h1>
        <p className="mt-2 text-muted">Chaque école a sa propre adresse. Utilisez le lien communiqué par votre établissement pour vous connecter.</p>
        <Link href="/plateforme/connexion" className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-lg border border-line px-4 font-bold hover:bg-sunk">
          <Lock className="size-4" /> Administration de la plateforme
        </Link>
      </div>
    </main>
  );
}

export function SuspendedSchool({ name }: { name: string }) {
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-md text-center">
        <Lock className="mx-auto size-12 text-warn" />
        <h1 className="mt-3 text-3xl font-bold">{name}</h1>
        <p className="mt-2 text-muted">L’espace en ligne de cet établissement est momentanément indisponible. Pour toute question, contactez directement l’établissement.</p>
      </div>
    </main>
  );
}
