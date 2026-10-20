'use client';

import { useEffect, useState } from 'react';
import { publicGet, TENANT } from './api';

export type PublicSchool = {
  name: string;
  public: { slogan?: string; tagline?: string; phone?: string; rentree?: string; highlights?: string[]; reasons?: string[]; motto?: string };
  sites: { id: string; name: string; address: string | null; phone: string | null }[];
  tracks: { code: string; name: string; cycle: string }[];
};

let cache: Promise<PublicSchool> | null = null;

/** Fiche publique de l'école (sites actifs, filières, textes d'accueil), lue une seule fois par page. */
export function usePublicSchool() {
  const [data, setData] = useState<PublicSchool | null>(null);
  useEffect(() => {
    cache ??= publicGet<PublicSchool>(`/public/${TENANT}`).catch((e) => { cache = null; throw e; });
    cache.then(setData).catch(() => {});
  }, []);
  return data;
}

/** « Hêdomey et Togbin », « A, B et C » : liste lisible des noms de sites. */
export function siteList(names: string[]) {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} et ${names[names.length - 1]}`;
}
