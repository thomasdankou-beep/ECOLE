'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AlertTriangle, CalendarClock, Lock, X } from 'lucide-react';
import { Button, Card } from '@/components/ui';
import { accessText, type AccessPhase, counterText, loginAlert, REGULARIZE_HREF, type SchoolAccess, showsAccess } from '@/lib/access';
import { currentSessionId } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

/**
 * Accès selon l'abonnement Cahiora (lot G5d-1, D-G5-30 A), sans jamais bloquer le travail pendant l'accès complet :
 * - bandeau permanent avec le compteur des jours : la direction pendant le délai de grâce, une prolongation, une demande
 *   en attente ou après la fin de la gratuité ; tout le personnel pendant l'accès limité ; jamais les familles ;
 * - alerte à chaque connexion de la direction, posée dans un coin de l'écran sans couvrir la page : on peut travailler
 *   sans la fermer (les alertes ne bloquent pas le travail pendant l'accès complet) ;
 * - carte du tableau de bord de la direction (le bandeau n'y est pas répété) ;
 * - bouton « Régulariser mon abonnement » pour la direction de tout l'établissement : il ouvre la page de l'abonnement.
 */

/** Bouton « Régulariser mon abonnement » : passe au rôle Direction si besoin (la page de l'abonnement est la sienne). */
function RegularizeButton({ onClick, className }: { onClick?: () => void; className?: string }) {
  const auth = useAuth();
  return (
    <Button asChild size="sm" variant="default" className={className}>
      <Link href={REGULARIZE_HREF} onClick={() => { if (auth.role !== 'DIRECTION') auth.switchRole('DIRECTION'); onClick?.(); }}>Régulariser mon abonnement</Link>
    </Button>
  );
}

/** Compteur des jours d'accès complet (délai de grâce ou prolongation). */
function Counter({ a, big, className }: { a: SchoolAccess; big?: boolean; className?: string }) {
  if (a.daysLeft === null || (a.phase !== 'GRACE' && a.phase !== 'EXTENDED')) return null;
  return (
    <span className={cn('inline-flex w-fit items-center gap-1.5 rounded-full bg-surface/70 px-2.5 py-0.5 font-extrabold tabular', big ? 'text-base' : 'text-sm', className)} data-testid="compteur-acces">
      <CalendarClock className="size-4 flex-none" aria-hidden /> {counterText(a.daysLeft)}
    </span>
  );
}

function useAccess() {
  const auth = useAuth();
  const a = auth.me?.access;
  // Le personnel qui n'est pas de la direction ne lit que l'accès limité, avec ce qu'il lui reste à faire.
  return { auth, a: showsAccess(a) ? a : null, staffOnly: !!a && !a.direction };
}

/** Bandeau du haut de chaque page (sauf le tableau de bord de la direction, qui a sa carte). */
export function AccessBanner() {
  const { auth, a, staffOnly } = useAccess();
  const path = usePathname();
  if (!a || (path === '/espace' && auth.role === 'DIRECTION')) return null;
  const t = accessText(a, staffOnly);
  const Icon = a.phase === 'LIMITED' ? Lock : AlertTriangle;
  return (
    <section aria-label="Abonnement Cahiora" className={cn('no-print grid gap-2 rounded-xl p-3 sm:flex sm:items-center sm:gap-3 sm:p-4', t.tone === 'bad' ? 'bg-bad-soft text-bad' : 'bg-warn-soft text-warn')}>
      <Icon className="hidden size-6 flex-none sm:block" aria-hidden />
      <div className="grid min-w-0 flex-1 gap-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-bold"><span>{t.title}</span><Counter a={a} /></p>
        <p className="text-sm text-ink/85">{t.body}</p>
      </div>
      {a.canRegularize && <RegularizeButton className="justify-self-start" />}
    </section>
  );
}

/** Carte du tableau de bord de la direction. */
export function AccessCard() {
  const { a } = useAccess();
  if (!a || !a.direction) return null;
  const t = accessText(a);
  return (
    <Card className={cn('grid gap-2 border-0', t.tone === 'bad' ? 'bg-bad-soft text-bad' : 'bg-warn-soft text-warn')} aria-label="Abonnement Cahiora" role="region">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-lg font-bold"><span>{t.title}</span><Counter a={a} big /></p>
      <p className="text-ink/85">{t.body}</p>
      {a.canRegularize ? <RegularizeButton className="justify-self-start" /> : <p className="text-sm text-ink/85">Seule la direction de tout l’établissement régularise l’abonnement.</p>}
    </Card>
  );
}

/**
 * Phases de l'alerte de connexion : délai de grâce, prolongation, demande en attente, délai passé, accès limité. Une
 * gratuité finie avant le lot G5d, sans délai connu, n'a que le bandeau.
 */
const LOGIN_ALERT_PHASES: AccessPhase[] = ['GRACE', 'EXTENDED', 'HELD', 'DUE', 'LIMITED'];

/**
 * Alerte à chaque connexion de la direction, une seule fois par connexion même avec plusieurs onglets (lecture 3,
 * ajustée le 20 novembre 2026), jamais pendant un mot de passe provisoire. Elle ne couvre pas la page : on peut
 * travailler sans la fermer.
 */
export function AccessLoginAlert() {
  const { auth, a } = useAccess();
  const userId = auth.me?.user.id ?? '';
  const due = !!a && a.direction && LOGIN_ALERT_PHASES.includes(a.phase) && !auth.me?.user.mustChangePassword;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (due && loginAlert.take(userId, currentSessionId())) setOpen(true);
  }, [due, userId]);
  useEffect(() => {
    if (!open) return;
    return loginAlert.onShownElsewhere(userId, currentSessionId(), () => setOpen(false));
  }, [open, userId]);
  if (!a || !due || !open) return null;
  const close = () => setOpen(false);
  const t = accessText(a);
  return (
    <div
      role="alertdialog" aria-modal="false" aria-labelledby="alerte-abonnement-titre" aria-describedby="alerte-abonnement-texte"
      className="no-print fade-up fixed inset-x-3 bottom-[calc(76px+env(safe-area-inset-bottom))] z-40 grid gap-3 rounded-2xl border border-line bg-surface p-4 shadow-2xl lg:bottom-6 lg:left-auto lg:right-6 lg:w-[440px]"
    >
      <div className="flex items-start justify-between gap-3">
        <p id="alerte-abonnement-titre" className={cn('font-display text-lg font-bold leading-tight sm:text-xl', t.tone === 'bad' ? 'text-bad' : 'text-warn')}>{t.title}</p>
        <button type="button" onClick={close} className="grid size-10 flex-none cursor-pointer place-items-center rounded-lg hover:bg-sunk" aria-label="Fermer l’alerte">
          <X className="size-5" />
        </button>
      </div>
      <Counter a={a} big className={t.tone === 'bad' ? 'bg-bad-soft text-bad' : 'bg-warn-soft text-warn'} />
      <p id="alerte-abonnement-texte" className="text-sm">{t.body}</p>
      {!a.canRegularize && <p className="text-sm text-muted">Seule la direction de tout l’établissement régularise l’abonnement.</p>}
      <div className="flex flex-wrap gap-2">
        {a.canRegularize && <RegularizeButton onClick={close} />}
        <Button size="sm" variant="outline" onClick={close}>Plus tard</Button>
      </div>
    </div>
  );
}
