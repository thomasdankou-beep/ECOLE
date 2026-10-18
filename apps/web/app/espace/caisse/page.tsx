'use client';

import { useState } from 'react';
import { Loader } from '@/components/espace/bits';
import { Button, Card, Empty, Field, Input, PageHeader, Table, Textarea, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { date, fcfa } from '@/lib/format';
import { useAction, useApi } from '@/lib/use-api';
import { cn } from '@/lib/utils';

export default function Caisse() {
  const q = useApi<{ id: string; date: string; expected: number; counted: number; difference: number; comment: string | null }[]>('/finance/cash-closings');
  const [counted, setCounted] = useState('');
  const [comment, setComment] = useState('');
  const toast = useToast();
  const { busy, run } = useAction();
  return (
    <>
      <PageHeader title="Clôture de caisse" subtitle="En fin de journée, comptez les espèces : l’écart avec les encaissements enregistrés est calculé et tracé." />
      <Card className="sm:max-w-lg">
        <form className="grid gap-3" onSubmit={async (e) => {
          e.preventDefault();
          const r = await run(() => api.post<{ expected: number; difference: number }>('/finance/cash-closings', { counted: Number(counted), comment: comment || undefined }), toast);
          if (r) { toast(r.difference === 0 ? 'Caisse juste, clôture enregistrée' : `Clôture enregistrée, écart de ${fcfa(r.difference)}`, r.difference === 0 ? 'good' : 'bad'); setCounted(''); setComment(''); q.reload(); }
        }}>
          <Field label="Espèces comptées (FCFA)"><Input type="number" inputMode="numeric" min={0} value={counted} onChange={(e) => setCounted(e.target.value)} required className="text-2xl font-bold" /></Field>
          <Field label="Commentaire (facultatif)"><Textarea value={comment} onChange={(e) => setComment(e.target.value)} className="min-h-16" /></Field>
          <Button type="submit" loading={busy}>Clôturer la journée</Button>
        </form>
      </Card>
      <Card>
        <Loader {...q}>
          {(rows) => rows.length === 0 ? <Empty title="Aucune clôture" /> : (
            <Table>
              <thead><tr><th>Date</th><th className="text-right">Attendu</th><th className="text-right">Compté</th><th className="text-right">Écart</th><th>Commentaire</th></tr></thead>
              <tbody>{rows.map((c) => (
                <tr key={c.id}><td>{date(c.date)}</td><td className="text-right">{fcfa(c.expected)}</td><td className="text-right">{fcfa(c.counted)}</td><td className={cn('text-right font-bold', c.difference < 0 ? 'text-bad' : c.difference > 0 ? 'text-warn' : 'text-good')}>{fcfa(c.difference)}</td><td className="text-sm">{c.comment}</td></tr>
              ))}</tbody>
            </Table>
          )}
        </Loader>
      </Card>
    </>
  );
}
