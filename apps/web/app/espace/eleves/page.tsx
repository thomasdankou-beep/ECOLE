'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Search, UserPlus } from 'lucide-react';
import { Loader, StatusBadge } from '@/components/espace/bits';
import { Button, Card, Empty, Input, PageHeader, Select, Table } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { fcfa } from '@/lib/format';
import { can } from '@/lib/perm';
import type { ClassRow, StudentRow } from '@/lib/types';
import { qs, useApi } from '@/lib/use-api';

export default function Eleves() {
  const { role } = useAuth();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [classId, setClassId] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const classes = useApi<ClassRow[]>('/classes');
  const list = useApi<StudentRow[]>(`/students${qs({ q: debounced, classId })}`);
  const showBalance = can(role, 'finance.read');

  return (
    <>
      <PageHeader title="Élèves" subtitle={list.data ? `${list.data.length} élève(s)` : undefined} actions={can(role, 'students.write') && <Button asChild><Link href="/espace/inscription"><UserPlus className="size-4" /> Inscrire</Link></Button>} />
      <Card className="grid gap-3 sm:grid-cols-[1fr_240px]">
        <label className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nom, prénom ou matricule" className="pl-10" aria-label="Rechercher un élève" />
        </label>
        <Select value={classId} onChange={(e) => setClassId(e.target.value)} aria-label="Classe">
          <option value="">Toutes les classes</option>
          {classes.data?.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.site.name}</option>)}
        </Select>
      </Card>
      <Card>
        <Loader {...list}>
          {(rows) => rows.length === 0 ? <Empty title="Aucun élève trouvé" /> : (
            <Table>
              <thead><tr><th>Élève</th><th>Matricule</th><th>Classe</th><th>Statut</th>{showBalance && <th className="text-right">Solde dû</th>}</tr></thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id} className="hover:bg-sunk/50">
                    <td><Link href={`/espace/eleves/${s.id}`} className="font-bold text-brand hover:underline">{s.lastName} {s.firstName}</Link></td>
                    <td className="font-mono text-sm">{s.matricule}</td>
                    <td>{s.class ? `${s.class.name} · ${s.class.site.name}` : '—'}</td>
                    <td><StatusBadge status={s.status} /></td>
                    {showBalance && <td className={`text-right font-bold ${s.balance ? 'text-bad' : 'text-good'}`}>{fcfa(s.balance ?? 0)}</td>}
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Loader>
      </Card>
    </>
  );
}
