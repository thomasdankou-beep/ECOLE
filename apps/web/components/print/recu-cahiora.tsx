/**
 * Reçu provisoire d'un paiement de l'abonnement Cahiora (lot G5d-2), à imprimer : la même page pour la direction de
 * l'établissement et pour le Super Admin. Jamais une facture ni un reçu fiscal (§16 du cahier des charges G5) : la
 * mention « Reçu provisoire, sans valeur fiscale. » est imprimée, et l'émetteur reste « Cahiora » tant que son identité
 * légale n'est pas fixée (INFORMATION MANQUANTE). Une saisie annulée reste lisible, marquée ANNULÉ.
 */
export type CahioraReceiptView = {
  receiptNumber: string;
  title: string;
  issuer: string;
  mention: string;
  lines: [string, string][];
  cancelled: string | null;
};

export function CahioraReceipt({ r }: { r: CahioraReceiptView }) {
  return (
    <article className="relative mx-auto grid w-full max-w-[148mm] gap-4 overflow-hidden bg-white p-6 text-black shadow-sm print:shadow-none" aria-label={r.title}>
      {r.cancelled && <p className="absolute right-[-40px] top-10 rotate-[30deg] bg-bad px-16 py-1 text-lg font-extrabold text-white">ANNULÉ</p>}
      <header className="grid gap-0.5 border-b-2 border-black pb-3">
        <p className="font-display text-2xl font-bold">{r.issuer}</p>
        <p className="text-xs text-black/70">Identité légale de l’émetteur : INFORMATION MANQUANTE (en attente de la validation juridique et fiscale de Cahiora).</p>
      </header>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-display text-xl font-bold uppercase">Reçu provisoire</h1>
        <p className="font-mono font-bold">N° {r.receiptNumber}</p>
      </div>
      <p className="rounded border-2 border-black p-2 text-center text-sm font-bold">{r.mention} Ce n’est pas une facture.</p>
      <dl className="grid grid-cols-[minmax(0,150px)_1fr] gap-x-3 gap-y-1.5 text-sm">
        {r.lines.map(([k, v], i) => (
          <div key={`${k}-${i}`} className="contents">
            <dt>{k}</dt>
            <dd className="font-bold">{v}</dd>
          </div>
        ))}
      </dl>
      {r.cancelled && <p className="rounded bg-bad-soft p-2 text-sm text-bad">{r.cancelled}</p>}
      <p className="text-center text-[11px] text-black/60">{r.mention} Les documents de Cahiora restent provisoires tant que sa situation juridique et fiscale n’est pas validée.</p>
    </article>
  );
}
