'use client';

import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { Badge, Card, ErrorNote, Skeleton } from '@/components/ui';
import { cn } from '@/lib/utils';

/** Affiche chargement, erreur ou contenu. */
export function Loader<T>({ data, error, loading, children, rows = 3 }: { data: T | undefined; error: unknown; loading: boolean; children: (d: T) => React.ReactNode; rows?: number }) {
  if (error) return <ErrorNote error={error} />;
  if (loading && data === undefined)
    return (
      <div className="grid gap-3">
        {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-16" />)}
      </div>
    );
  if (data === undefined) return null;
  return <>{children(data)}</>;
}

/** Barre horizontale simple pour les répartitions. */
export function Bars({ items, format = (n) => String(n), max }: { items: { label: string; value: number; tone?: 'brand' | 'orange' | 'bad' | 'good' }[]; format?: (n: number) => string; max?: number }) {
  const m = max ?? Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="grid gap-2.5">
      {items.map((i) => (
        <li key={i.label} className="grid gap-1">
          <div className="flex justify-between gap-2 text-sm">
            <span className="truncate font-bold">{i.label}</span>
            <span className="tabular flex-none text-muted">{format(i.value)}</span>
          </div>
          <div className="h-2.5 overflow-hidden rounded-full bg-sunk">
            <div className={cn('h-full rounded-full', { brand: 'bg-brand', orange: 'bg-orange', bad: 'bg-bad', good: 'bg-good' }[i.tone ?? 'brand'])} style={{ width: `${Math.max(2, (i.value / m) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function LinkRow({ href, children, right }: { href: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <Link href={href} className="flex min-h-14 items-center gap-3 border-b border-line px-1 py-2 last:border-0 hover:bg-sunk/60">
      <div className="min-w-0 flex-1">{children}</div>
      {right}
      <ChevronRight className="size-5 flex-none text-muted" />
    </Link>
  );
}

export function Section({ title, action, children, className }: { title: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <Card className={className}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-[21px] font-bold leading-tight">{title}</h2>
        {action}
      </div>
      {children}
    </Card>
  );
}

const STATUS: Record<string, [string, 'info' | 'brand' | 'good' | 'warn' | 'bad' | 'accent']> = {
  OPEN: ['À payer', 'warn'], PARTIAL: ['Partiel', 'accent'], PAID: ['Soldée', 'good'], CANCELLED: ['Annulée', 'info'],
  INITIATED: ['Initié', 'info'], PENDING: ['En attente', 'warn'], SUCCESS: ['Réussi', 'good'], FAILED: ['Échoué', 'bad'],
  NONE: ['Non justifiée', 'bad'], ACCEPTED: ['Justifiée', 'good'], REJECTED: ['Refusée', 'bad'],
  PROPOSED: ['Proposée', 'warn'], VALIDATED: ['Validée', 'good'],
  RECU: ['Reçue', 'brand'], INCOMPLET: ['Incomplète', 'warn'], EN_TEST: ['En test', 'accent'], ACCEPTE: ['Acceptée', 'good'], REFUSE: ['Refusée', 'bad'], LISTE_ATTENTE: ['Liste d’attente', 'info'], INSCRIT: ['Inscrit', 'good'],
  SAISIE: ['Saisie des notes', 'info'], CONTROLE: ['Contrôle', 'warn'], CONSEIL: ['Conseil de classe', 'accent'], VALIDE: ['Validé', 'brand'], PUBLIE: ['Publié', 'good'],
  ABSENT: ['Absent', 'bad'], LATE: ['Retard', 'warn'], PRESENT: ['Présent', 'good'],
  ACTIVE: ['Actif', 'good'], TRANSFERRED: ['Transféré', 'info'], WITHDRAWN: ['Retiré', 'info'], DISABLED: ['Désactivé', 'info'],
};
/** Pour les justificatifs, PENDING veut dire « à examiner ». */
export function StatusBadge({ status, justification }: { status: string; justification?: boolean }) {
  const [label, tone] = justification && status === 'PENDING' ? ['À examiner', 'warn' as const] : STATUS[status] ?? [status, 'info' as const];
  return <Badge tone={tone}>{label}</Badge>;
}
