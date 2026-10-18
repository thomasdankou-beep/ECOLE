'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Printer } from 'lucide-react';
import { Loader } from '@/components/espace/bits';
import { Button, Card, Empty, Field, PageHeader, Select, Table, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { date } from '@/lib/format';
import { can } from '@/lib/perm';
import { DOC_KINDS, type ClassRow } from '@/lib/types';
import { useAction, useApi } from '@/lib/use-api';

export default function Documents() {
  const { role, child } = useAuth();
  const family = role === 'PARENT' || role === 'ELEVE';
  const q = useApi<any[]>(family ? `/documents?studentId=${child?.id}` : '/documents');
  const issue = can(role, 'documents.issue');
  return (
    <>
      <PageHeader title="Documents officiels" subtitle="Chaque document porte un QR code vérifiable par toute personne sur la page publique de l’école." />
      {issue && <BatchIssue />}
      <Card>
        <Loader {...q}>
          {(rows) => rows.length === 0 ? <Empty title="Aucun document">{issue ? 'Délivrez un document depuis la fiche d’un élève ou en lot pour une classe.' : 'Les documents délivrés par l’école apparaîtront ici.'}</Empty> : (
            <Table>
              <thead><tr><th>Document</th><th>Élève</th><th>Numéro</th><th>Délivré le</th><th /></tr></thead>
              <tbody>{rows.map((d) => (
                <tr key={d.id}>
                  <td className="font-bold">{DOC_KINDS[d.kind]}</td>
                  <td>{d.student.lastName} {d.student.firstName}</td>
                  <td className="font-mono text-sm">{d.number}</td>
                  <td>{date(d.issuedAt)}</td>
                  <td className="text-right"><Button asChild variant="outline" size="sm"><Link href={`/espace/documents/imprimer?ids=${d.id}`}><Printer className="size-4" /> Imprimer</Link></Button></td>
                </tr>
              ))}</tbody>
            </Table>
          )}
        </Loader>
      </Card>
    </>
  );
}

function BatchIssue() {
  const classes = useApi<ClassRow[]>('/classes');
  const [kind, setKind] = useState('CARTE_SCOLAIRE');
  const [classId, setClassId] = useState('');
  const toast = useToast();
  const { busy, run } = useAction();
  const router = useRouter();
  return (
    <Card className="flex flex-wrap items-end gap-3">
      <Field label="Document" className="min-w-52 flex-1"><Select value={kind} onChange={(e) => setKind(e.target.value)}>{Object.entries(DOC_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
      <Field label="Pour toute la classe" className="min-w-52 flex-1"><Select value={classId} onChange={(e) => setClassId(e.target.value)}><option value="">Choisir</option>{classes.data?.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.site.name} ({c.studentCount})</option>)}</Select></Field>
      <Button disabled={!classId} loading={busy} onClick={async () => {
        const r = await run(() => api.post<{ count: number; ids: string[] }>('/documents/batch', { kind, classId }), toast);
        if (r) { toast(`${r.count} document(s) délivré(s)`); if (r.count) router.push(`/espace/documents/imprimer?ids=${r.ids.join(',')}`); }
      }}>Délivrer en lot</Button>
    </Card>
  );
}
