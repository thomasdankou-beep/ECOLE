/** En-tête officiel des documents imprimés. Les mentions légales non fournies restent signalées. */
export function Letterhead({ name, site, authorization }: { name: string; site?: string | null; authorization?: string | null }) {
  return (
    <div className="flex items-center gap-4 border-b-4 border-double border-brand pb-3">
      <img src="/logo.png" alt="" width={72} height={72} className="size-[72px] rounded-full" />
      <div className="min-w-0 flex-1">
        <p className="font-display text-2xl font-bold uppercase leading-tight text-brand">{name}</p>
        <p className="text-sm">{site ? `Site de ${site} · ` : ''}Tél. 01 40 63 24 39</p>
        <p className="text-xs text-muted">{authorization ? `Autorisation : ${authorization}` : 'Autorisation d’ouverture : INFORMATION MANQUANTE'}</p>
      </div>
      <p className="hidden text-right text-xs font-bold italic text-muted sm:block">Éduquer · Former · Réussir</p>
    </div>
  );
}

export function PrintBar({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 no-print">
      {children}
    </div>
  );
}
