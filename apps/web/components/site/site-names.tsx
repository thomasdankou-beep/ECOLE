'use client';

import { usePublicSchool } from '@/lib/public-school';

/** Sites actifs de l'école, tels que la direction les a saisis. */
export function SiteNames() {
  const school = usePublicSchool();
  return <>{school?.sites.map((s) => s.name).join(' · ')}</>;
}
