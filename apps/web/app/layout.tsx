import type { Metadata, Viewport } from 'next';
import { Barlow_Condensed, Nunito_Sans } from 'next/font/google';
import { ToastProvider } from '@/components/ui';
import { AuthProvider } from '@/lib/auth';
import { ServiceWorker } from '@/components/service-worker';
import './globals.css';

const barlow = Barlow_Condensed({ subsets: ['latin'], weight: ['500', '600', '700'], variable: '--font-barlow', display: 'swap' });
const nunito = Nunito_Sans({ subsets: ['latin'], variable: '--font-nunito', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Lycée privé Saint Kisito-GESA', template: '%s · Saint Kisito-GESA' },
  description: 'Lycée privé Saint Kisito-GESA : collège général et lycée technique. Éduquer · Former · Réussir.',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/favicon.png', apple: '/icon-192.png' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#1b3a8c' },
    { media: '(prefers-color-scheme: dark)', color: '#0c1222' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className={`${barlow.variable} ${nunito.variable}`}>
      <body className="min-h-dvh antialiased">
        <ToastProvider>
          <AuthProvider>{children}</AuthProvider>
        </ToastProvider>
        <ServiceWorker />
      </body>
    </html>
  );
}
