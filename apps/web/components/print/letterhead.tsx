import { SchoolLogo } from '@/components/site/brand';

/** Identité officielle saisie par la direction (Paramètres › Établissement). */
export type SchoolIdentity = {
  name: string;
  authorization: string | null;
  legalMentions: string | null;
  headName: string | null;
  headTitle: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  slogan: string | null;
  signatureUrl: string | null;
  stampUrl: string | null;
  logoUrl?: string | null;
  primaryColor?: string | null;
};

/** En-tête officiel des documents imprimés. Les mentions légales non renseignées restent signalées. */
export function Letterhead({ identity, name, site }: { identity?: SchoolIdentity | null; name?: string; site?: string | null }) {
  const contact = [identity?.address, identity?.phone ? `Tél. ${identity.phone}` : null, identity?.email].filter(Boolean).join(' · ');
  return (
    <div className="flex items-center gap-4 border-b-4 border-double border-brand pb-3">
      <SchoolLogo url={identity?.logoUrl} name={identity?.name ?? name} size={72} />
      <div className="min-w-0 flex-1">
        <p className="font-display text-2xl font-bold uppercase leading-tight text-brand">{identity?.name ?? name}</p>
        <p className="text-sm">{site ? `Site de ${site}` : ''}{site && contact ? ' · ' : ''}{contact}</p>
        <p className="text-xs text-muted">{identity?.authorization ? `Autorisation d’ouverture : ${identity.authorization}` : 'Autorisation d’ouverture : INFORMATION MANQUANTE'}</p>
      </div>
      {identity?.slogan && <p className="hidden text-right text-xs font-bold italic text-muted sm:block">{identity.slogan}</p>}
    </div>
  );
}

/** Bloc de signature du chef d'établissement : nom, signature et cachet enregistrés, sinon signalés. */
export function Signatory({ identity, className = '' }: { identity?: SchoolIdentity | null; className?: string }) {
  return (
    <div className={`text-center text-sm ${className}`}>
      <p className="font-bold">{identity?.headTitle ?? 'Le chef d’établissement'}</p>
      <div className="relative mx-auto flex h-20 w-48 items-center justify-center">
        {identity?.stampUrl && <img src={identity.stampUrl} alt="Cachet" className="absolute inset-0 m-auto max-h-20 opacity-80" />}
        {identity?.signatureUrl && <img src={identity.signatureUrl} alt="Signature" className="relative max-h-16" />}
      </div>
      <p>{identity?.headName ?? <span className="text-xs text-black/60">Nom et signature : INFORMATION MANQUANTE</span>}</p>
    </div>
  );
}

/** Mentions légales en pied de document, lorsqu'elles ont été saisies. */
export function LegalFooter({ identity }: { identity?: SchoolIdentity | null }) {
  if (!identity?.legalMentions) return null;
  return <p className="whitespace-pre-line text-center text-[10.5px] text-black/60">{identity.legalMentions}</p>;
}

export function PrintBar({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 no-print">
      {children}
    </div>
  );
}
