'use client';

import { useEffect, useState } from 'react';
import { publicGet } from './api';
import { resolveTenant } from './tenant';

export type Branding = { logoUrl: string | null; primaryColor: string | null };

export type PublicSchool = {
  slug: string;
  name: string;
  shortName: string | null;
  country?: string;
  suspended: boolean;
  demo?: boolean;
  branding: Branding;
  public: {
    slogan?: string; tagline?: string; phone?: string; rentree?: string; highlights?: string[]; reasons?: string[]; motto?: string;
    /// Photo du bandeau d'accueil et photos par code de filière, fournies avec l'installation de l'école.
    heroImage?: string; trackImages?: Record<string, string>;
  };
  sites: { id: string; name: string; address: string | null; phone: string | null }[];
  tracks: { code: string; name: string; cycle: string }[];
  levels: { name: string; cycle: string }[];
};

/** 'none' : aucune école à cette adresse (accueil de la plateforme). */
export type SchoolState = { status: 'loading' } | { status: 'none' } | { status: 'ready'; school: PublicSchool };

let cache: Promise<PublicSchool | null> | null = null;

function load() {
  cache ??= resolveTenant()
    .then(async (slug) => (slug ? { ...(await publicGet<Omit<PublicSchool, 'slug'>>(`/public/${slug}`)), slug } : null))
    .catch((e) => {
      cache = null;
      throw e;
    });
  return cache;
}

/** Fiche publique de l'école servie à cette adresse, lue une seule fois par page. */
export function useSchoolState(): SchoolState {
  const [state, setState] = useState<SchoolState>({ status: 'loading' });
  useEffect(() => {
    load().then((school) => setState(school ? { status: 'ready', school } : { status: 'none' })).catch(() => setState({ status: 'none' }));
  }, []);
  return state;
}

export function usePublicSchool() {
  const s = useSchoolState();
  return s.status === 'ready' ? s.school : null;
}

/** « Hêdomey et Togbin », « A, B et C » : liste lisible des noms de sites. */
export function siteList(names: string[]) {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} et ${names[names.length - 1]}`;
}

const DIAL: Record<string, string> = { BJ: '229', CI: '225', SN: '221', TG: '228', BF: '226', ML: '223', NE: '227', GN: '224', CM: '237' };

/** Lien d'appel : indicatif du pays de l'école ajouté aux numéros locaux. */
export function telHref(phone: string, country = 'BJ') {
  const digits = phone.replace(/[^\d+]/g, '');
  return `tel:${digits.startsWith('+') || !DIAL[country] ? digits : `+${DIAL[country]}${digits}`}`;
}
