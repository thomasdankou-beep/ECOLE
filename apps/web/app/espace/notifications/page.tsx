'use client';

import { CheckCheck } from 'lucide-react';
import { Loader } from '@/components/espace/bits';
import { Button, Card, Empty, PageHeader, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useAction, useApi } from '@/lib/use-api';
import { cn } from '@/lib/utils';

export default function Notifications() {
  const q = useApi<{ items: { id: string; title: string; body: string; kind: string; readAt: string | null; createdAt: string }[]; unreadCount: number }>('/notifications');
  const toast = useToast();
  const { busy, run } = useAction();
  return (
    <>
      <PageHeader title="Notifications" actions={!!q.data?.unreadCount && <Button variant="outline" loading={busy} onClick={async () => { if (await run(() => api.post('/notifications/read-all'), toast)) q.reload(); }}><CheckCheck className="size-4" /> Tout marquer comme lu</Button>} />
      <Loader {...q}>
        {(d) => d.items.length === 0 ? <Empty title="Aucune notification" /> : (
          <div className="grid gap-2">
            {d.items.map((n) => (
              <Card key={n.id} className={cn('cursor-pointer p-4 sm:p-4', !n.readAt && 'border-brand bg-brand-soft')} onClick={async () => { if (!n.readAt) { await api.post(`/notifications/${n.id}/read`).catch(() => {}); q.reload(); } }}>
                <div className="flex items-start justify-between gap-2">
                  <p className="font-bold">{n.title}</p>
                  <span className="flex-none text-xs text-muted">{dateTime(n.createdAt)}</span>
                </div>
                <p className="text-sm">{n.body}</p>
              </Card>
            ))}
          </div>
        )}
      </Loader>
    </>
  );
}
