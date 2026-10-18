'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

/** Lecture d'une ressource de l'API avec états de chargement et d'erreur. `path` nul = rien à charger. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!path) {
      setData(undefined);
      setLoading(false);
      return;
    }
    const n = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const d = await api.get<T>(path);
      if (n === seq.current) setData(d);
    } catch (e) {
      if (n === seq.current) setError(e);
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    load();
  }, [load]);

  return { data, error, loading, reload: load, setData };
}

/** Action d'écriture : état d'envoi, message de succès ou d'erreur. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <R,>(fn: () => Promise<R>, toast?: (t: string, tone?: 'good' | 'bad') => void, ok?: string) => {
    setBusy(true);
    try {
      const r = await fn();
      if (ok && toast) toast(ok);
      return r;
    } catch (e) {
      toast?.(e instanceof Error ? e.message : 'Une erreur est survenue', 'bad');
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, run };
}

export const qs = (o: Record<string, string | number | undefined | null | false>) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false) as [string, string][];
  return p.length ? `?${new URLSearchParams(p.map(([k, v]) => [k, String(v)])).toString()}` : '';
};
