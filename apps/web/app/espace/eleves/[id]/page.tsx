'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ArrowLeft, FileBadge, Phone } from 'lucide-react';
import { Loader, Section, StatusBadge } from '@/components/espace/bits';
import { Badge, Button, Card, Chips, Dialog, DialogContent, DialogTrigger, Empty, Field, Input, PageHeader, Select, Table, Textarea, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { date, fcfa, hhmm, note } from '@/lib/format';
import { can } from '@/lib/perm';
import { DOC_KINDS, type ClassRow } from '@/lib/types';
import { useAction, useApi } from '@/lib/use-api';

type Student = {
  id: string; matricule: string; firstName: string; lastName: string; sex: string | null; birthDate: string | null; birthPlace: string | null; allergies: string | null; status: string;
  guardians: { id: string; relation: string; isPrimary: boolean; guardian: { firstName: string; lastName: string; phone: string; email: string | null } }[];
  enrollments: { id: string; status: string; class: { name: string; site: { name: string } }; academicYear: { label: string } }[];
  currentClass: { id: string; name: string; site: { name: string } } | null; balance: number; hasAccount: boolean;
};

export default function EleveFiche() {
  const { id } = useParams<{ id: string }>();
  const { role } = useAuth();
  const q = useApi<Student>(`/students/${id}`);
  const tabs = [
    { value: 'infos', label: 'Dossier' },
    ...(can(role, 'grades.read') ? [{ value: 'notes', label: 'Notes' }] : []),
    ...(can(role, 'attendance.read') ? [{ value: 'absences', label: 'Absences' }] : []),
    ...(can(role, 'finance.read') ? [{ value: 'finances', label: 'Finances' }] : []),
    ...(can(role, 'documents.read') ? [{ value: 'documents', label: 'Documents' }] : []),
  ];
  const [tab, setTab] = useState('infos');

  return (
    <>
      <Link href="/espace/eleves" className="inline-flex items-center gap-1 text-sm font-bold text-brand no-print"><ArrowLeft className="size-4" /> Élèves</Link>
      <Loader {...q}>
        {(s) => (
          <>
            <PageHeader
              title={`${s.lastName} ${s.firstName}`}
              subtitle={<>{s.matricule} · {s.currentClass ? `${s.currentClass.name} · ${s.currentClass.site.name}` : 'Sans classe'} · <StatusBadge status={s.status} /></>}
              actions={can(role, 'students.write') && s.status === 'ACTIVE' && <StudentActions s={s} onDone={q.reload} />}
            />
            <Chips label="Rubrique" value={tab} onChange={setTab} options={tabs} />
            {tab === 'infos' && <Infos s={s} />}
            {tab === 'notes' && <Notes id={s.id} />}
            {tab === 'absences' && <Absences id={s.id} />}
            {tab === 'finances' && <Finances id={s.id} />}
            {tab === 'documents' && <Documents id={s.id} canIssue={can(role, 'documents.issue')} />}
          </>
        )}
      </Loader>
    </>
  );
}

function Infos({ s }: { s: Student }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Section title="Identité">
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div><dt className="font-bold text-muted">Sexe</dt><dd>{s.sex === 'F' ? 'Fille' : s.sex === 'M' ? 'Garçon' : '—'}</dd></div>
          <div><dt className="font-bold text-muted">Né(e) le</dt><dd>{date(s.birthDate, { day: 'numeric', month: 'long', year: 'numeric' })}{s.birthPlace ? ` à ${s.birthPlace}` : ''}</dd></div>
          <div><dt className="font-bold text-muted">Compte élève</dt><dd>{s.hasAccount ? 'Oui, identifiant = matricule' : 'Non'}</dd></div>
          <div><dt className="font-bold text-muted">Santé, allergies</dt><dd>{s.allergies || '—'}</dd></div>
        </dl>
      </Section>
      <Section title="Parents et tuteurs">
        <ul className="grid gap-2">
          {s.guardians.map((g) => (
            <li key={g.id} className="flex items-center justify-between gap-2 rounded-lg bg-sunk px-3 py-2">
              <span>
                <span className="block font-bold">{g.guardian.firstName} {g.guardian.lastName} {g.isPrimary && <Badge tone="brand">Principal</Badge>}</span>
                <span className="text-sm text-muted">{g.relation}</span>
              </span>
              <a href={`tel:${g.guardian.phone}`} className="inline-flex min-h-10 items-center gap-1.5 font-bold text-brand"><Phone className="size-4" /> {g.guardian.phone}</a>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Parcours" className="lg:col-span-2">
        <ul className="grid gap-1 text-sm">
          {s.enrollments.map((e) => <li key={e.id}>{e.academicYear.label} · {e.class.name} ({e.class.site.name}) · <StatusBadge status={e.status} /></li>)}
        </ul>
      </Section>
      <Internships id={s.id} />
    </div>
  );
}

const INTERNSHIP_STATUS: Record<string, string> = { PLANNED: 'Prévu', IN_PROGRESS: 'En cours', DONE: 'Terminé', CANCELLED: 'Annulé' };

/** Stages en entreprise de l'élève (affiché seulement s'il en a). */
function Internships({ id }: { id: string }) {
  const q = useApi<{ id: string; company: string; tutorName: string | null; tutorPhone: string | null; status: string; period: { label: string; startDate: string; endDate: string } }[]>(`/students/${id}/internships`);
  if (!q.data?.length) return null;
  return (
    <Section title="Stages en entreprise" className="lg:col-span-2">
      <ul className="grid gap-1.5 text-sm">
        {q.data.map((x) => (
          <li key={x.id} className="rounded-lg bg-sunk px-3 py-2">
            <b>{x.period.label}</b> · du {date(x.period.startDate)} au {date(x.period.endDate)} · <Badge>{INTERNSHIP_STATUS[x.status] ?? x.status}</Badge>
            <span className="block">{x.company}{x.tutorName ? ` · tuteur : ${x.tutorName}` : ''}{x.tutorPhone ? ` (${x.tutorPhone})` : ''}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Notes({ id }: { id: string }) {
  const [term, setTerm] = useState('');
  const q = useApi<any>(`/evaluation/students/${id}${term ? `?termId=${term}` : ''}`);
  return (
    <Loader {...q}>
      {(g) => (
        <Card className="grid gap-3">
          <Chips label="Période" value={term || g.term?.id || ''} onChange={setTerm} options={g.terms.map((t: any) => ({ value: t.id, label: t.name }))} />
          <p className="text-lg font-bold">Moyenne générale : {g.average === null ? '—' : `${note(g.average)} / 20`} <span className="text-sm font-semibold text-muted">(classe : {note(g.classAverage)})</span></p>
          <Table>
            <thead><tr><th>Matière</th><th>Coef.</th><th>Notes</th><th className="text-right">Moyenne</th><th className="text-right">Classe</th></tr></thead>
            <tbody>
              {g.subjects.map((s: any) => (
                <tr key={s.classSubjectId}>
                  <td className="font-bold">{s.subject}</td>
                  <td>{note(s.coefficient)}</td>
                  <td className="text-sm">{s.assessments.map((a: any) => (a.absent ? 'Abs' : a.score === null ? '—' : `${note(a.score)}/${a.maxScore}`)).join(' · ') || '—'}</td>
                  <td className="text-right font-bold">{note(s.average)}</td>
                  <td className="text-right text-muted">{note(s.classAverage)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </Loader>
  );
}

function Absences({ id }: { id: string }) {
  const q = useApi<any[]>(`/attendance/absences?studentId=${id}`);
  return (
    <Card>
      <Loader {...q}>
        {(rows) => rows.length === 0 ? <Empty title="Aucune absence" /> : (
          <Table>
            <thead><tr><th>Date</th><th>Cours</th><th>Type</th><th>Justification</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}><td>{date(r.date)} · {hhmm(r.startMinute)}</td><td>{r.subject ?? '—'}</td><td><StatusBadge status={r.status} />{r.minutesLate ? ` ${r.minutesLate} min` : ''}</td><td><StatusBadge status={r.justification} justification /></td></tr>
            ))}</tbody>
          </Table>
        )}
      </Loader>
    </Card>
  );
}

function Finances({ id }: { id: string }) {
  const q = useApi<any[]>(`/finance/invoices?studentId=${id}`);
  return (
    <Card>
      <Loader {...q}>
        {(rows) => rows.length === 0 ? <Empty title="Aucune facture" /> : (
          <Table>
            <thead><tr><th>Facture</th><th>Échéance</th><th className="text-right">Montant</th><th className="text-right">Payé</th><th className="text-right">Reste</th><th>Statut</th><th>Reçus</th></tr></thead>
            <tbody>{rows.map((i) => (
              <tr key={i.id}>
                <td><span className="font-bold">{i.label}</span><span className="block font-mono text-xs text-muted">{i.number}</span></td>
                <td>{date(i.dueDate)}</td>
                <td className="text-right">{fcfa(i.total)}</td>
                <td className="text-right">{fcfa(i.paid)}</td>
                <td className="text-right font-bold">{fcfa(i.remaining)}</td>
                <td><StatusBadge status={i.status} /></td>
                <td className="text-sm">{i.payments.filter((p: any) => p.receipt).map((p: any) => <Link key={p.id} href={`/espace/recu/${p.receipt.id}`} className="mr-2 font-bold text-brand hover:underline">{p.receipt.number}</Link>)}</td>
              </tr>
            ))}</tbody>
          </Table>
        )}
      </Loader>
    </Card>
  );
}

function Documents({ id, canIssue }: { id: string; canIssue: boolean }) {
  const q = useApi<any[]>(`/documents?studentId=${id}`);
  const toast = useToast();
  const { busy, run } = useAction();
  const [kind, setKind] = useState('CERTIFICAT_SCOLARITE');
  const router = useRouter();
  return (
    <Card className="grid gap-4">
      {canIssue && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Nouveau document" className="min-w-60 flex-1">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>{Object.entries(DOC_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
          </Field>
          <Button loading={busy} onClick={async () => { const d = await run(() => api.post<{ id: string }>('/documents', { kind, studentId: id }), toast, 'Document délivré'); if (d) router.push(`/espace/documents/imprimer?ids=${d.id}`); }}>
            <FileBadge className="size-4" /> Délivrer et imprimer
          </Button>
        </div>
      )}
      <Loader {...q}>
        {(rows) => rows.length === 0 ? <Empty title="Aucun document délivré" /> : (
          <ul className="grid gap-2">{rows.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-2 rounded-lg bg-sunk px-3 py-2">
              <span><span className="block font-bold">{DOC_KINDS[d.kind]}</span><span className="font-mono text-xs text-muted">{d.number} · {date(d.issuedAt)}</span></span>
              <Button asChild variant="outline" size="sm"><Link href={`/espace/documents/imprimer?ids=${d.id}`}>Imprimer</Link></Button>
            </li>
          ))}</ul>
        )}
      </Loader>
    </Card>
  );
}

function StudentActions({ s, onDone }: { s: Student; onDone: () => void }) {
  const classes = useApi<ClassRow[]>('/classes');
  const toast = useToast();
  const { busy, run } = useAction();
  const [classId, setClassId] = useState('');
  const [withdraw, setWithdraw] = useState({ status: 'TRANSFERRED', reason: '' });
  const [g, setG] = useState({ firstName: '', lastName: '', phone: '', relation: 'Père' });
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <Dialog open={open === 'class'} onOpenChange={(o) => setOpen(o ? 'class' : null)}>
        <DialogTrigger asChild><Button variant="outline">Changer de classe</Button></DialogTrigger>
        <DialogContent title="Changer de classe">
          <form className="grid gap-4" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.post(`/students/${s.id}/class`, { classId }), toast, 'Classe modifiée')) { setOpen(null); onDone(); } }}>
            <Field label="Nouvelle classe"><Select value={classId} onChange={(e) => setClassId(e.target.value)} required><option value="">Choisir</option>{classes.data?.filter((c) => c.id !== s.currentClass?.id).map((c) => <option key={c.id} value={c.id}>{c.name} · {c.site.name}</option>)}</Select></Field>
            <Button type="submit" loading={busy}>Confirmer</Button>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={open === 'guardian'} onOpenChange={(o) => setOpen(o ? 'guardian' : null)}>
        <DialogTrigger asChild><Button variant="outline">Ajouter un parent</Button></DialogTrigger>
        <DialogContent title="Ajouter un parent ou tuteur" description="Un compte parent est créé si ce numéro n’en a pas encore.">
          <form className="grid gap-3" onSubmit={async (e) => {
            e.preventDefault();
            const r = await run(() => api.post<{ temporaryPassword?: string; phone: string }>(`/students/${s.id}/guardians`, g), toast, 'Parent ajouté');
            if (r) { setOpen(null); onDone(); if (r.temporaryPassword) toast(`Identifiant ${r.phone}, mot de passe provisoire ${r.temporaryPassword}`); }
          }}>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Nom"><Input value={g.lastName} onChange={(e) => setG({ ...g, lastName: e.target.value })} required /></Field>
              <Field label="Prénoms"><Input value={g.firstName} onChange={(e) => setG({ ...g, firstName: e.target.value })} required /></Field>
            </div>
            <Field label="Téléphone"><Input type="tel" value={g.phone} onChange={(e) => setG({ ...g, phone: e.target.value })} required /></Field>
            <Field label="Lien"><Select value={g.relation} onChange={(e) => setG({ ...g, relation: e.target.value })}>{['Père', 'Mère', 'Tuteur', 'Tutrice', 'Autre'].map((r) => <option key={r}>{r}</option>)}</Select></Field>
            <Button type="submit" loading={busy}>Ajouter</Button>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={open === 'withdraw'} onOpenChange={(o) => setOpen(o ? 'withdraw' : null)}>
        <DialogTrigger asChild><Button variant="danger">Départ</Button></DialogTrigger>
        <DialogContent title="Enregistrer un départ" description="L’élève est retiré de sa classe. Son dossier, ses notes et ses paiements sont conservés.">
          <form className="grid gap-3" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.post(`/students/${s.id}/withdraw`, withdraw), toast, 'Départ enregistré')) { setOpen(null); onDone(); } }}>
            <Field label="Motif du départ"><Select value={withdraw.status} onChange={(e) => setWithdraw({ ...withdraw, status: e.target.value })}><option value="TRANSFERRED">Transfert vers une autre école</option><option value="WITHDRAWN">Abandon ou retrait</option></Select></Field>
            <Field label="Précisions"><Textarea value={withdraw.reason} onChange={(e) => setWithdraw({ ...withdraw, reason: e.target.value })} required /></Field>
            <Button type="submit" variant="danger" loading={busy}>Confirmer le départ</Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
