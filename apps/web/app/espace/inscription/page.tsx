'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CheckCircle2, Plus, Trash2 } from 'lucide-react';
import { Button, Card, ErrorNote, Field, Input, PageHeader, Select, Table } from '@/components/ui';
import { api } from '@/lib/api';
import type { ClassRow } from '@/lib/types';
import { useApi } from '@/lib/use-api';

type Guardian = { firstName: string; lastName: string; phone: string; email: string; relation: string };
type Result = { id: string; matricule: string; credentials: { name: string; identifier: string; temporaryPassword: string }[]; invoices: number };

const emptyGuardian = (): Guardian => ({ firstName: '', lastName: '', phone: '', email: '', relation: 'Mère' });

export default function Inscription() {
  const params = useSearchParams();
  const applicationId = params.get('dossier');
  const classes = useApi<ClassRow[]>('/classes');
  const apps = useApi<{ items: any[] }>(applicationId ? '/applications' : null);
  const [s, setS] = useState({ firstName: '', lastName: '', sex: '', birthDate: '', birthPlace: '', allergies: '', classId: '' });
  const [guardians, setGuardians] = useState<Guardian[]>([emptyGuardian()]);
  const [createStudentAccount, setAccount] = useState(true);
  const [createInvoices, setInvoices] = useState(true);
  const [returning, setReturning] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  // Pré-remplissage depuis une pré-inscription acceptée.
  useEffect(() => {
    const a = apps.data?.items.find((x) => x.id === applicationId);
    if (!a) return;
    setS((v) => ({ ...v, firstName: a.studentFirstName, lastName: a.studentLastName, sex: a.sex ?? '', birthDate: a.birthDate?.slice(0, 10) ?? '' }));
    const [last, ...first] = String(a.guardianName).split(' ');
    setGuardians([{ ...emptyGuardian(), lastName: last ?? '', firstName: first.join(' ') || last, phone: a.guardianPhone, email: a.guardianEmail ?? '' }]);
  }, [apps.data, applicationId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const clean = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== ''));
      const r = await api.post<Result>('/students', {
        ...clean(s),
        guardians: guardians.map((g, i) => ({ ...clean(g), isPrimary: i === 0 })),
        createStudentAccount,
        createInvoices,
        returning,
        ...(applicationId ? { applicationId } : {}),
      });
      setResult(r);
      window.scrollTo({ top: 0 });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (result)
    return (
      <Card className="grid gap-4">
        <p className="flex items-center gap-2 text-2xl font-bold text-good"><CheckCircle2 className="size-8" /> Inscription enregistrée</p>
        <p>Matricule attribué : <span className="font-mono text-lg font-bold">{result.matricule}</span>. {result.invoices ? `${result.invoices} facture(s) créée(s) d’après les frais de la classe.` : ''}</p>
        {result.credentials.length > 0 && (
          <div className="grid gap-2">
            <p className="font-bold">Identifiants à remettre (ils ne seront plus affichés) :</p>
            <Table>
              <thead><tr><th>Compte</th><th>Identifiant</th><th>Mot de passe provisoire</th></tr></thead>
              <tbody>{result.credentials.map((c) => <tr key={c.identifier}><td>{c.name}</td><td className="font-mono">{c.identifier}</td><td className="font-mono font-bold">{c.temporaryPassword}</td></tr>)}</tbody>
            </Table>
            <p className="text-sm text-muted">Le mot de passe devra être changé à la première connexion.</p>
          </div>
        )}
        <div className="flex flex-wrap gap-2 no-print">
          <Button asChild><Link href={`/espace/eleves/${result.id}`}>Ouvrir le dossier</Link></Button>
          <Button variant="outline" onClick={() => window.print()}>Imprimer</Button>
          <Button variant="outline" onClick={() => { setResult(null); setS({ firstName: '', lastName: '', sex: '', birthDate: '', birthPlace: '', allergies: '', classId: '' }); setGuardians([emptyGuardian()]); }}>Nouvelle inscription</Button>
        </div>
      </Card>
    );

  return (
    <>
      <PageHeader title="Nouvelle inscription" subtitle={applicationId ? 'À partir d’une pré-inscription acceptée.' : 'Élève, parents, classe : tout est créé en une seule fois.'} />
      <form onSubmit={submit} className="grid gap-4">
        <Card className="grid gap-4">
          <h2 className="text-2xl font-bold">L’élève</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nom"><Input value={s.lastName} onChange={(e) => setS({ ...s, lastName: e.target.value })} required /></Field>
            <Field label="Prénoms"><Input value={s.firstName} onChange={(e) => setS({ ...s, firstName: e.target.value })} required /></Field>
            <Field label="Sexe"><Select value={s.sex} onChange={(e) => setS({ ...s, sex: e.target.value })}><option value="">Non précisé</option><option value="F">Fille</option><option value="M">Garçon</option></Select></Field>
            <Field label="Date de naissance"><Input type="date" value={s.birthDate} onChange={(e) => setS({ ...s, birthDate: e.target.value })} /></Field>
            <Field label="Lieu de naissance"><Input value={s.birthPlace} onChange={(e) => setS({ ...s, birthPlace: e.target.value })} /></Field>
            <Field label="Santé, allergies (facultatif)"><Input value={s.allergies} onChange={(e) => setS({ ...s, allergies: e.target.value })} /></Field>
            <Field label="Classe" className="sm:col-span-2">
              <Select value={s.classId} onChange={(e) => setS({ ...s, classId: e.target.value })} required>
                <option value="">Choisir la classe</option>
                {classes.data?.map((c) => <option key={c.id} value={c.id} disabled={!!c.capacity && c.studentCount >= c.capacity}>{c.name} · {c.site.name} ({c.studentCount}{c.capacity ? `/${c.capacity}` : ''})</option>)}
              </Select>
            </Field>
          </div>
        </Card>
        <Card className="grid gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-bold">Parents et tuteurs</h2>
            <Button type="button" variant="ghost" size="sm" onClick={() => setGuardians([...guardians, emptyGuardian()])}><Plus className="size-4" /> Ajouter</Button>
          </div>
          {guardians.map((g, i) => {
            const set = (k: keyof Guardian, v: string) => setGuardians(guardians.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
            return (
              <div key={i} className="grid gap-3 rounded-lg border border-line p-3 sm:grid-cols-2">
                <p className="font-bold sm:col-span-2">{i === 0 ? 'Responsable principal' : `Responsable ${i + 1}`}</p>
                <Field label="Nom"><Input value={g.lastName} onChange={(e) => set('lastName', e.target.value)} required /></Field>
                <Field label="Prénoms"><Input value={g.firstName} onChange={(e) => set('firstName', e.target.value)} required /></Field>
                <Field label="Téléphone" hint="Sert d’identifiant au compte parent"><Input type="tel" value={g.phone} onChange={(e) => set('phone', e.target.value)} required /></Field>
                <Field label="Lien"><Select value={g.relation} onChange={(e) => set('relation', e.target.value)}>{['Mère', 'Père', 'Tuteur', 'Tutrice', 'Autre'].map((r) => <option key={r}>{r}</option>)}</Select></Field>
                <Field label="E-mail (facultatif)"><Input type="email" value={g.email} onChange={(e) => set('email', e.target.value)} /></Field>
                {i > 0 && <Button type="button" variant="ghost" className="self-end text-bad" onClick={() => setGuardians(guardians.filter((_, j) => j !== i))}><Trash2 className="size-4" /> Retirer</Button>}
              </div>
            );
          })}
        </Card>
        <Card className="grid gap-3">
          <label className="flex min-h-11 items-center gap-3 font-bold"><input type="checkbox" className="size-5" checked={createStudentAccount} onChange={(e) => setAccount(e.target.checked)} /> Créer le compte de l’élève (identifiant = matricule)</label>
          <label className="flex min-h-11 items-center gap-3 font-bold"><input type="checkbox" className="size-5" checked={createInvoices} onChange={(e) => setInvoices(e.target.checked)} /> Créer les factures selon les frais de la classe</label>
          {createInvoices && <label className="flex min-h-11 items-center gap-3 font-bold"><input type="checkbox" className="size-5" checked={returning} onChange={(e) => setReturning(e.target.checked)} /> Ancien élève : frais de réinscription au lieu de ceux d’inscription</label>}
        </Card>
        <ErrorNote error={error} />
        <Button type="submit" size="lg" loading={busy}>Enregistrer l’inscription</Button>
      </form>
    </>
  );
}
