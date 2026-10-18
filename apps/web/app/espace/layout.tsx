import { Suspense } from 'react';
import { EspaceShell } from '@/components/espace/shell';

export const metadata = { title: 'Mon espace' };

export default function EspaceLayout({ children }: { children: React.ReactNode }) {
  return (
    <EspaceShell>
      <Suspense>{children}</Suspense>
    </EspaceShell>
  );
}
