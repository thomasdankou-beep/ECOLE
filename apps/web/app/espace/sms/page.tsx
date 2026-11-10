'use client';

import { useState } from 'react';
import { Badge, Card, Empty, Field, Input, PageHeader, Stat, Table } from '@/components/ui';
import { Loader } from '@/components/espace/bits';
import { dateTime } from '@/lib/format';
import { useApi } from '@/lib/use-api';

type Sms = { id: string; kind: string; phone: string; body: string; segments: number; status: 'QUEUED' | 'SENT' | 'FAILED'; error: string | null; student: string | null; createdAt: string };
type Log = { month: string; sent: number; failed: number; queued: number; billed: number; items: Sms[] };

const KIND: Record<string, string> = {
  payment: 'Paiement', absence: 'Absence', reminder: 'Rappel de paiement', report_card: 'Bulletin', sanction: 'Discipline', announcement: 'Annonce', urgent: 'Annonce urgente', securite: 'Sécurité du compte',
};
const STATUS = { SENT: { label: 'Envoyé', tone: 'good' }, FAILED: { label: 'Échec', tone: 'bad' }, QUEUED: { label: 'En attente', tone: 'warn' } } as const;

/** SMS envoyés aux familles (paiements, absences, rappels...) : ce qui est parti, ce qui a échoué, et le nombre de SMS du mois. */
export default function SmsPage() {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const q = useApi<Log>(`/notifications/sms?month=${month}`);
  return (
    <>
      <PageHeader title="SMS envoyés" subtitle="Les SMS partis vers les parents : paiements, absences, rappels. Les réglages sont dans Paramètres > Mentions et règles." />
      <Card className="max-w-xs">
        <Field label="Mois"><Input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></Field>
      </Card>
      <Loader {...q}>
        {(log) => (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Stat label="SMS envoyés" value={log.sent} detail={`${log.billed} SMS facturés par l’opérateur`} tone="good" />
              <Stat label="Échecs" value={log.failed} tone={log.failed ? 'bad' : undefined} detail="Numéro absent ou refusé" />
              <Stat label="En attente" value={log.queued} />
            </div>
            <Card>
              {log.items.length === 0 ? <Empty title="Aucun SMS ce mois-ci" /> : (
                <Table>
                  <thead><tr><th>Date</th><th>Type</th><th>Élève</th><th>Numéro</th><th>Message</th><th>État</th></tr></thead>
                  <tbody>{log.items.map((s) => (
                    <tr key={s.id}>
                      <td className="whitespace-nowrap text-sm">{dateTime(s.createdAt)}</td>
                      <td className="text-sm">{KIND[s.kind] ?? s.kind}</td>
                      <td className="font-bold">{s.student ?? ''}</td>
                      <td className="whitespace-nowrap font-mono text-xs">{s.phone}</td>
                      <td className="max-w-md whitespace-normal break-words text-xs text-muted">{s.body}{s.segments > 1 ? ` (${s.segments} SMS)` : ''}</td>
                      <td><Badge tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Badge>{s.error && <div className="text-xs text-muted">{s.error}</div>}</td>
                    </tr>
                  ))}</tbody>
                </Table>
              )}
            </Card>
          </>
        )}
      </Loader>
    </>
  );
}
