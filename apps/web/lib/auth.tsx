'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { api, onSessionLost, refreshSession, setActiveRole, setSession } from './api';

export type Role = 'DIRECTION' | 'SECRETARIAT' | 'ENSEIGNANT' | 'VIE_SCOLAIRE' | 'COMPTABLE' | 'PARENT' | 'ELEVE';
export type Child = { id: string; firstName: string; lastName: string; className: string | null };
export type Me = {
  user: { id: string; firstName: string; lastName: string; phone: string; email: string | null; totpEnabled: boolean; mustChangePassword: boolean; roles: { role: Role; siteId: string | null }[] };
  tenant: { id: string; slug: string; name: string; shortName: string | null; country: string; currency: string; logoUrl: string | null; primaryColor: string | null };
  sites: { id: string; name: string }[];
  year: { id: string; label: string } | null;
  children: Child[];
  self: Child | null;
};

type Ctx = {
  me: Me | null;
  ready: boolean;
  role: Role | null;
  roles: Role[];
  switchRole: (r: Role) => void;
  /** Enfant suivi (parent) ou soi-même (élève). */
  child: Child | null;
  kids: Child[];
  selectChild: (id: string) => void;
  reload: () => Promise<Me | null>;
  logout: () => Promise<void>;
};

const AuthCtx = React.createContext<Ctx | null>(null);
const ROLE_KEY = 'erp.role';
const CHILD_KEY = 'erp.child';

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* stockage indisponible : préférence non mémorisée */
    }
  },
};

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = React.useState<Me | null>(null);
  const [ready, setReady] = React.useState(false);
  const [role, setRole] = React.useState<Role | null>(null);
  const [childId, setChildId] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const m = await api.get<Me>('/auth/me');
      const roles = [...new Set(m.user.roles.map((r) => r.role))];
      const saved = store.get(ROLE_KEY) as Role | null;
      const r = saved && roles.includes(saved) ? saved : roles[0];
      setActiveRole(r);
      setRole(r);
      setMe(m);
      const kids = m.self ? [m.self] : m.children;
      const savedChild = store.get(CHILD_KEY);
      setChildId(kids.find((k) => k.id === savedChild)?.id ?? kids[0]?.id ?? null);
      return m;
    } catch {
      setMe(null);
      return null;
    }
  }, []);

  React.useEffect(() => {
    (async () => {
      if (await refreshSession()) await load();
      setReady(true);
    })();
    return onSessionLost(() => setMe(null));
  }, [load]);

  const value = React.useMemo<Ctx>(() => {
    const roles = me ? [...new Set(me.user.roles.map((r) => r.role))] : [];
    const kids = me ? (me.self ? [me.self] : me.children) : [];
    return {
      me,
      ready,
      role,
      roles,
      kids,
      child: kids.find((k) => k.id === childId) ?? kids[0] ?? null,
      switchRole: (r) => {
        store.set(ROLE_KEY, r);
        setActiveRole(r);
        setRole(r);
      },
      selectChild: (id) => {
        store.set(CHILD_KEY, id);
        setChildId(id);
      },
      reload: load,
      logout: async () => {
        await fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
        setSession(null);
        setActiveRole(null);
        setMe(null);
      },
    };
  }, [me, ready, role, childId, load]);

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  const c = React.useContext(AuthCtx);
  if (!c) throw new Error('AuthProvider manquant');
  return c;
}

/** Redirige vers la connexion si la session est absente. */
export function useRequireAuth() {
  const auth = useAuth();
  const router = useRouter();
  React.useEffect(() => {
    if (auth.ready && !auth.me) router.replace('/connexion');
  }, [auth.ready, auth.me, router]);
  return auth;
}
