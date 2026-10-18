'use client';

import { useState } from 'react';
import { Loader } from '@/components/espace/bits';
import { Card, Empty, Field, Input, PageHeader, Table } from '@/components/ui';
import { dateTime } from '@/lib/format';
import { qs, useApi } from '@/lib/use-api';

export default function Audit() {
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const q = useApi<any[]>(`/audit${qs({ action, from, to })}`);
  return (
    <>
      <PageHeader title="Journal d’audit" subtitle="Toutes les actions sensibles : connexions, notes, paiements, annulations, droits. Ce journal ne peut être ni modifié ni effacé." />
      <Card className="grid gap-3 sm:grid-cols-3">
        <Field label="Action" hint="Ex. payment, grades, auth.login"><Input value={action} onChange={(e) => setAction(e.target.value)} /></Field>
        <Field label="Du"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="Au"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </Card>
      <Card>
        <Loader {...q}>
          {(rows) => rows.length === 0 ? <Empty title="Aucune entrée" /> : (
            <Table>
              <thead><tr><th>Date</th><th>Utilisateur</th><th>Action</th><th>Objet</th><th>Détails</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap text-sm">{dateTime(r.createdAt)}</td>
                  <td className="font-bold">{r.userName}</td>
                  <td className="font-mono text-sm">{r.action}</td>
                  <td className="text-sm">{r.entity}</td>
                  <td className="max-w-md truncate font-mono text-xs text-muted" title={JSON.stringify(r.data)}>{r.data ? JSON.stringify(r.data) : ''}</td>
                </tr>
              ))}</tbody>
            </Table>
          )}
        </Loader>
      </Card>
    </>
  );
}
