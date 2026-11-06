'use client';

import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { Loader } from '@/components/espace/bits';
import { Button, Card, Empty, Field, Input, PageHeader, Select, Table, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { qs, useApi } from '@/lib/use-api';

type Row = { id: string; createdAt: string; userName: string | null; action: string; label: string; entity: string; entityId: string | null; ip: string | null; data: unknown };
type Person = { id: string; firstName: string; lastName: string };

const PAGE = 100;

const FIELD: Record<string, string> = {
  firstName: 'prénom', lastName: 'nom', phone: 'téléphone', email: 'e-mail', status: 'statut', roles: 'rôles', amount: 'montant',
  name: 'nom', dueDate: 'échéance', coefficient: 'coefficient', birthDate: 'naissance', birthPlace: 'lieu de naissance', allergies: 'allergies',
  sex: 'sexe', content: 'contenu', title: 'titre', weight: 'poids', maxScore: 'barème', reason: 'motif', identifier: 'identifiant', route: 'page',
};

const show = (v: unknown) => (v === null || v === undefined || v === '' ? '∅' : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Détails lisibles (SEC-035) : « champ : avant → après » pour les modifications, sinon « champ : valeur ». */
function details(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  return Object.entries(data as Record<string, unknown>)
    .filter(([k]) => k !== 'tenantId')
    .map(([k, v]) => {
      const f = FIELD[k] ?? k;
      if (v === 'modifié') return `${f} modifié`;
      if (v && typeof v === 'object' && !Array.isArray(v) && 'avant' in v) return `${f} : ${show((v as any).avant)} → ${show((v as any).après)}`;
      if (k === 'modified' && Array.isArray(v)) return v.length ? `${v.length} note(s) modifiée(s) : ${v.map((c: any) => `${show(c.before)} → ${show(c.after)}${c.absent ? ` (absent : ${show(c.absent.avant)} → ${show(c.absent.après)})` : ''}${c.exempt ? ` (dispensé : ${show(c.exempt.avant)} → ${show(c.exempt.après)})` : ''}`).join(' ; ')}` : 'aucune note existante modifiée';
      return `${f} : ${show(v)}`;
    })
    .join(' · ');
}

export default function Audit() {
  const toast = useToast();
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [userId, setUserId] = useState('');
  const filters = qs({ action, from, to, userId });
  const q = useApi<Row[]>(`/audit${qs({ action, from, to, userId, limit: PAGE })}`);
  const people = useApi<Person[]>('/staff');
  const [more, setMore] = useState<Row[]>([]);
  const [end, setEnd] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => { setMore([]); setEnd(false); }, [filters]);

  const loadMore = async (rows: Row[]) => {
    const last = [...rows, ...more].at(-1);
    if (!last) return;
    setLoadingMore(true);
    try {
      const next = await api.get<Row[]>(`/audit${qs({ action, from, to, userId, limit: PAGE, before: last.id })}`);
      setMore((m) => [...m, ...next]);
      if (next.length < PAGE) setEnd(true);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Erreur', 'bad');
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Journal d’audit"
        subtitle="Toutes les actions sensibles : connexions, notes, paiements, annulations, droits, accès refusés. Ce journal ne peut être ni modifié ni effacé."
        actions={<Button variant="outline" onClick={() => api.download(`/audit/export.csv${filters}`, `journal-audit-${from || 'debut'}-${to || 'fin'}.csv`).catch((e) => toast(e.message, 'bad'))}><Download className="size-4" /> Export Excel (CSV)</Button>}
      />
      <Card className="grid gap-3 sm:grid-cols-4">
        <Field label="Personne">
          <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Tout le monde</option>
            {(people.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}
          </Select>
        </Field>
        <Field label="Action" hint="Ex. auth, grades, payment, access"><Input value={action} onChange={(e) => setAction(e.target.value)} /></Field>
        <Field label="Du"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="Au"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </Card>
      <Card>
        <Loader {...q}>
          {(rows) => {
            const all = [...rows, ...more];
            return all.length === 0 ? <Empty title="Aucune entrée" /> : (
              <>
                <Table>
                  <thead><tr><th>Date</th><th>Utilisateur</th><th>Action</th><th>Détails</th><th>Adresse IP</th></tr></thead>
                  <tbody>{all.map((r) => {
                    const d = details(r.data);
                    return (
                      <tr key={r.id}>
                        <td className="whitespace-nowrap text-sm">{dateTime(r.createdAt)}</td>
                        <td className="font-bold">{r.userName ?? 'Système'}</td>
                        <td className="text-sm">{r.label}<div className="font-mono text-xs text-muted">{r.action}</div></td>
                        <td className="max-w-md whitespace-normal break-words text-xs text-muted">{d}</td>
                        <td className="whitespace-nowrap font-mono text-xs">{r.ip ?? ''}</td>
                      </tr>
                    );
                  })}</tbody>
                </Table>
                {!end && rows.length === PAGE && (
                  <div className="mt-3 flex justify-center">
                    <Button variant="outline" disabled={loadingMore} onClick={() => loadMore(rows)}>{loadingMore ? 'Chargement…' : 'Afficher les suivantes'}</Button>
                  </div>
                )}
              </>
            );
          }}
        </Loader>
      </Card>
    </>
  );
}
