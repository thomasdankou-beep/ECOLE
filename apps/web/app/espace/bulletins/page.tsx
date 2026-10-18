'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Loader, StatusBadge } from '@/components/espace/bits';
import { Card, Chips, Empty, ErrorNote, PageHeader, Table } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { date, note, today } from '@/lib/format';
import type { Term } from '@/lib/types';
import { useApi } from '@/lib/use-api';

export default function Bulletins() {
  const { role } = useAuth();
  return role === 'PARENT' || role === 'ELEVE' ? <FamilyCards /> : <Runs />;
}

function Runs() {
  const settings = useApi<{ currentYear: { terms: Term[] } | null }>('/settings');
  const terms = settings.data?.currentYear?.terms ?? [];
  const [term, setTerm] = useState('');
  useEffect(() => {
    if (!term && terms.length) setTerm((terms.find((t) => t.startDate.slice(0, 10) <= today() && t.endDate.slice(0, 10) >= today()) ?? terms[0]).id);
  }, [terms, term]);
  const runs = useApi<{ classId: string; className: string; site: string; students: number; status: string }[]>(term ? `/report-cards/runs?termId=${term}` : null);
  return (
    <>
      <PageHeader title="Bulletins" subtitle="Saisie, contrôle, conseil de classe, validation puis publication aux familles." />
      <ErrorNote error={settings.error} />
      {terms.length > 0 && <Chips label="Période" value={term} onChange={setTerm} options={terms.map((t) => ({ value: t.id, label: t.name }))} />}
      <Card>
        <Loader {...runs}>
          {(rows) => rows.length === 0 ? <Empty title="Aucune classe">Seuls le professeur principal et la direction préparent les bulletins d’une classe.</Empty> : (
            <Table>
              <thead><tr><th>Classe</th><th>Site</th><th>Élèves</th><th>Étape</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.classId} className="hover:bg-sunk/50">
                  <td><Link className="font-bold text-brand hover:underline" href={`/espace/bulletins/conseil?classId=${r.classId}&termId=${term}`}>{r.className}</Link></td>
                  <td>{r.site}</td>
                  <td>{r.students}</td>
                  <td><StatusBadge status={r.status} /></td>
                </tr>
              ))}</tbody>
            </Table>
          )}
        </Loader>
      </Card>
    </>
  );
}

function FamilyCards() {
  const { child } = useAuth();
  const q = useApi<{ blocked: boolean; cards: { id: string; term: string; className: string; average: string | null; rank: number | null; classSize: number; distinction: string | null; publishedAt: string | null }[] }>(`/report-cards/students/${child!.id}`);
  return (
    <>
      <PageHeader title="Bulletins" subtitle={`${child!.firstName} · bulletins officiels publiés par l’école`} />
      <Loader {...q}>
        {(d) => (
          <>
            {d.blocked && <p className="rounded-xl bg-warn-soft p-4 font-bold text-warn">L’accès au bulletin en ligne est suspendu jusqu’au règlement des frais. Rapprochez-vous de l’économat.</p>}
            {d.cards.length === 0 ? <Empty title="Aucun bulletin publié pour le moment">Vous recevrez une notification dès la publication.</Empty> : (
              <div className="grid gap-3 sm:grid-cols-2">
                {d.cards.map((c) => (
                  <Link key={c.id} href={`/espace/bulletins/${c.id}`} className="rounded-xl border border-line bg-surface p-5 hover:border-brand">
                    <p className="text-xl font-bold">{c.term} · {c.className}</p>
                    <p className="tabular mt-1 font-display text-4xl font-bold">{note(c.average)}<span className="text-lg text-muted"> / 20</span></p>
                    <p className="text-sm text-muted">Rang {c.rank ?? '—'} sur {c.classSize}{c.distinction ? ` · ${c.distinction}` : ''} · publié le {date(c.publishedAt)}</p>
                  </Link>
                ))}
              </div>
            )}
          </>
        )}
      </Loader>
    </>
  );
}
