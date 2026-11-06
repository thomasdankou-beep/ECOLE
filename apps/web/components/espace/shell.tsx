'use client';

import { BrandStyle, SchoolLogo } from '@/components/site/brand';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Bell, LogOut, Menu, X } from 'lucide-react';
import { Select, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { useRequireAuth, type Role } from '@/lib/auth';
import { ROLE_LABEL } from '@/lib/format';
import { NAV, isFamily } from '@/lib/nav';
import { cn } from '@/lib/utils';

export function EspaceShell({ children }: { children: React.ReactNode }) {
  const auth = useRequireAuth();
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);

  useEffect(() => setOpen(false), [path]);
  // Mot de passe provisoire : rien d'autre n'est accessible tant qu'il n'a pas été changé.
  useEffect(() => {
    if (auth.me?.user.mustChangePassword && !path.startsWith('/espace/compte')) router.replace('/espace/compte?premiere=1');
  }, [auth.me, path, router]);
  useEffect(() => {
    if (!auth.me) return;
    const tick = () => api.get<{ unreadCount: number }>('/notifications?unread=true').then((r) => setUnread(r.unreadCount)).catch(() => {});
    tick();
    const t = setInterval(tick, 60000);
    return () => clearInterval(t);
  }, [auth.me, path]);

  if (!auth.ready || !auth.me || !auth.role) {
    return (
      <div className="mx-auto grid max-w-5xl gap-4 p-6">
        <Skeleton className="h-12" />
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  const nav = NAV[auth.role];
  const active = (href: string) => (href === '/espace' ? path === '/espace' : path.startsWith(href));
  const me = auth.me;

  const sidebar = (
    <nav className="grid gap-0.5" aria-label="Menu principal">
      {nav.map(({ href, label, icon: I }) => (
        <Link key={href} href={href} aria-current={active(href) ? 'page' : undefined} className={cn('flex min-h-11 items-center gap-3 rounded-lg px-3 font-bold text-ink/85 hover:bg-sunk', active(href) && 'bg-brand-soft text-brand')}>
          <I className="size-5 flex-none" /> <span className="truncate">{label}</span>
          {href === '/espace/notifications' && unread > 0 && <span className="ml-auto rounded-full bg-red px-2 text-xs font-extrabold text-white">{unread}</span>}
        </Link>
      ))}
    </nav>
  );

  const roleSwitch = auth.roles.length > 1 && (
    <Select aria-label="Rôle actif" value={auth.role} onChange={(e) => { auth.switchRole(e.target.value as Role); router.push('/espace'); }} className="min-h-10 text-sm font-bold">
      {auth.roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
    </Select>
  );

  const childSwitch = auth.role === 'PARENT' && auth.kids.length > 0 && (
    <div className="flex gap-1.5 overflow-x-auto [scrollbar-width:none]" role="group" aria-label="Enfant suivi">
      {auth.kids.map((k) => (
        <button key={k.id} type="button" aria-pressed={auth.child?.id === k.id} onClick={() => auth.selectChild(k.id)} className="min-h-10 flex-none cursor-pointer rounded-full border border-line bg-surface px-3.5 text-left text-sm font-bold aria-pressed:border-brand aria-pressed:bg-brand aria-pressed:text-brand-ink">
          {k.firstName} <span className="font-semibold opacity-75">· {k.className ?? 'sans classe'}</span>
        </button>
      ))}
    </div>
  );

  const mobileNav = nav.filter((n) => n.mobile).slice(0, 4);

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[264px_1fr]">
      <BrandStyle color={me.tenant.primaryColor} />
      {/* Barre latérale (ordinateur) */}
      <aside className="sticky top-0 hidden h-dvh flex-col gap-4 overflow-y-auto border-r border-line bg-surface p-4 lg:flex no-print">
        <Link href="/espace" className="flex items-center gap-2.5">
          <SchoolLogo url={me.tenant.logoUrl} name={me.tenant.shortName ?? me.tenant.name} size={40} />
          <span className="leading-tight">
            <span className="block font-display text-lg font-bold text-brand">{me.tenant.shortName ?? me.tenant.name}</span>
            <span className="block text-xs text-muted">Année {me.year?.label ?? '—'}</span>
          </span>
        </Link>
        {roleSwitch}
        {sidebar}
        <div className="mt-auto grid gap-2 border-t border-line pt-3 text-sm">
          <p className="font-bold">{me.user.firstName} {me.user.lastName}</p>
          <p className="text-muted">{ROLE_LABEL[auth.role]}</p>
          <button type="button" onClick={async () => { await auth.logout(); router.replace('/connexion'); }} className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg px-2 font-bold text-bad hover:bg-bad-soft">
            <LogOut className="size-4" /> Se déconnecter
          </button>
        </div>
      </aside>

      <div className="min-w-0 pb-24 lg:pb-10">
        {/* En-tête (téléphone) */}
        <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-line bg-surface/95 px-3 py-2 backdrop-blur lg:hidden no-print">
          <button type="button" onClick={() => setOpen(true)} className="grid size-11 cursor-pointer place-items-center rounded-lg hover:bg-sunk" aria-label="Ouvrir le menu">
            <Menu className="size-6" />
          </button>
          <Link href="/espace" className="flex min-w-0 flex-1 items-center gap-2">
            <SchoolLogo url={me.tenant.logoUrl} name={me.tenant.shortName ?? me.tenant.name} size={32} />
            <span className="truncate font-display text-lg font-bold text-brand">{me.tenant.shortName ?? me.tenant.name}</span>
          </Link>
          <Link href="/espace/notifications" className="relative grid size-11 place-items-center rounded-lg hover:bg-sunk" aria-label={`Notifications, ${unread} non lues`}>
            <Bell className="size-6" />
            {unread > 0 && <span className="absolute right-1.5 top-1.5 grid min-w-5 place-items-center rounded-full bg-red px-1 text-[11px] font-extrabold text-white">{unread}</span>}
          </Link>
        </header>

        {open && (
          <div className="fixed inset-0 z-50 lg:hidden">
            <button type="button" className="absolute inset-0 bg-[rgb(10_14_30/0.55)]" aria-label="Fermer le menu" onClick={() => setOpen(false)} />
            <div className="fade-up absolute inset-y-0 left-0 flex w-[min(320px,86vw)] flex-col gap-4 overflow-y-auto bg-surface p-4">
              <div className="flex items-center justify-between">
                <span>
                  <span className="block font-bold">{me.user.firstName} {me.user.lastName}</span>
                  <span className="block text-sm text-muted">{ROLE_LABEL[auth.role]} · {me.year?.label}</span>
                </span>
                <button type="button" onClick={() => setOpen(false)} className="grid size-11 cursor-pointer place-items-center rounded-lg hover:bg-sunk" aria-label="Fermer le menu"><X className="size-6" /></button>
              </div>
              {roleSwitch}
              {sidebar}
              <button type="button" onClick={async () => { await auth.logout(); router.replace('/connexion'); }} className="mt-auto flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-3 font-bold text-bad hover:bg-bad-soft">
                <LogOut className="size-5" /> Se déconnecter
              </button>
            </div>
          </div>
        )}

        <main className="mx-auto grid max-w-6xl gap-5 px-4 pt-4 sm:pt-6">
          {childSwitch && <div className="no-print">{childSwitch}</div>}
          {!me.year && auth.role === 'DIRECTION' && !path.startsWith('/espace/parametres') && (
            <Link href="/espace/parametres?rubrique=annee" className="no-print rounded-xl bg-warn-soft p-4 font-bold text-warn hover:underline">
              Pour commencer, créez l’année scolaire et ses périodes dans Paramètres. Ajoutez ensuite vos classes, matières et frais.
            </Link>
          )}
          {isFamily(auth.role) && !auth.child ? (
            <p className="rounded-xl bg-warn-soft p-4 font-bold text-warn">Aucun élève n’est rattaché à ce compte. Contactez le secrétariat.</p>
          ) : (
            children
          )}
        </main>

        {/* Barre d'onglets (téléphone) */}
        <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden no-print" aria-label="Raccourcis">
          {mobileNav.map(({ href, label, icon: I }) => (
            <Link key={href} href={href} aria-current={active(href) ? 'page' : undefined} className={cn('grid min-h-16 place-items-center content-center gap-0.5 px-1 text-[11.5px] font-bold text-muted', active(href) && 'text-brand')}>
              <I className="size-6" />
              <span className="max-w-full truncate">{label}</span>
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}
