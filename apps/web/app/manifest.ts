import type { MetadataRoute } from 'next';

/** Application installable sur l'écran d'accueil Android (décision D4 : PWA d'abord). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Espace école',
    short_name: 'Espace école',
    description: 'Notes, absences, emploi du temps, frais scolaires et paiement Mobile Money.',
    start_url: '/espace',
    display: 'standalone',
    background_color: '#f4f6fb',
    theme_color: '#1b3a8c',
    lang: 'fr',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
