'use client';

import Link from 'next/link';
import { useState } from 'react';
import { AlertTriangle, ArrowRight, BookOpen, ClipboardCheck, Inbox, UserPlus, Wallet } from 'lucide-react';
import { Badge, Button, Card, Chips, Empty, PageHeader, Stat } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { date, fcfa, hhmm, note, today } from '@/lib/format';
import { qs, useApi } from '@/lib/use-api';
import { Bars, LinkRow, Loader, Section, StatusBadge } from './bits';

type DirectionDash = {
  date: string; term: { name: string } | null; students: number; classes: number;
  byTrack: { label: string; count: number }[]; bySite: { label: string; count: number }[];
  attendance: { absentToday: number; presenceRate: number | null };
  finance: { monthCollected: number; expected: number; paid: number; unpaid: number; unpaidRate: number };
  results: { classId: string; className: string; average: number | null }[];
  alerts: { kind: string; text: string }[];
};

export function DirectionDashboard() {
  const { me } = useAuth();
  const [site, setSite] = useState('');
  const q = useApi<DirectionDash>(`/dashboard${qs({ siteId: site })}`);
  return (
    <>
      <PageHeader title="Tableau de bord" subtitle={`${me?.tenant.name} · ${date(today(), { weekday: 'long', day: 'numeric', month: 'long' })}`} />
      <Chips label="Site" value={site} onChange={setSite} options={[{ value: '', label: 'Tous les sites' }, ...(me?.sites ?? []).map((s) => ({ value: s.id, label: s.name }))]} />
      <Loader {...q}>
        {(d) => (
          <>
            {d.alerts.length > 0 && (
              <div className="grid gap-2">
                {d.alerts.map((a) => (
                  <p key={a.text} className="flex items-center gap-2 rounded-xl bg-warn-soft px-4 py-3 font-bold text-warn"><AlertTriangle className="size-5 flex-none" /> {a.text}</p>
                ))}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Élèves inscrits" value={d.students} detail={`${d.classes} classes`} />
              <Stat label="Absents aujourd’hui" value={d.attendance.absentToday} detail={d.attendance.presenceRate === null ? 'Appel pas encore fait' : `Présence ${note(d.attendance.presenceRate)} %`} tone={d.attendance.absentToday ? 'warn' : undefined} />
              <Stat label="Encaissé ce mois" value={fcfa(d.finance.monthCollected)} />
              <Stat label="Reste à recouvrer" value={fcfa(d.finance.unpaid)} detail={`${note(d.finance.unpaidRate)} % du total attendu`} tone="bad" />
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <Section title={`Moyennes par classe${d.term ? ` · ${d.term.name}` : ''}`} action={<Link href="/espace/bulletins" className="text-sm font-bold text-brand">Bulletins</Link>}>
                {d.results.some((r) => r.average !== null) ? <Bars items={d.results.filter((r) => r.average !== null).map((r) => ({ label: r.className, value: r.average ?? 0, tone: (r.average ?? 0) < 10 ? 'bad' : 'good' }))} max={20} format={(n) => `${note(n)} / 20`} /> : <Empty title="Pas encore de notes" />}
              </Section>
              <Section title="Recouvrement" action={<Link href="/espace/finances" className="text-sm font-bold text-brand">Détail</Link>}>
                <Bars items={[{ label: 'Attendu', value: d.finance.expected }, { label: 'Encaissé', value: d.finance.paid, tone: 'good' }, { label: 'Reste dû', value: d.finance.unpaid, tone: 'bad' }]} format={fcfa} />
              </Section>
              <Section title="Effectifs par filière"><Bars items={d.byTrack.map((t) => ({ label: t.label, value: t.count, tone: 'orange' }))} /></Section>
              <Section title="Effectifs par site"><Bars items={d.bySite.map((t) => ({ label: t.label, value: t.count }))} /></Section>
            </div>
          </>
        )}
      </Loader>
    </>
  );
}

export function SecretariatDashboard() {
  const apps = useApi<{ funnel: Record<string, number> }>('/applications');
  const students = useApi<unknown[]>('/students');
  return (
    <>
      <PageHeader title="Secrétariat" subtitle="Inscriptions, dossiers élèves et documents officiels." />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Élèves inscrits" value={students.data?.length ?? '…'} />
        <Stat label="Pré-inscriptions reçues" value={apps.data?.funnel.RECU ?? 0} tone={apps.data?.funnel.RECU ? 'warn' : undefined} />
        <Stat label="En test" value={apps.data?.funnel.EN_TEST ?? 0} />
        <Stat label="Acceptées à inscrire" value={apps.data?.funnel.ACCEPTE ?? 0} />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { href: '/espace/inscription', icon: UserPlus, t: 'Inscrire un élève', d: 'Fiche, parents, classe, compte et factures en une fois.' },
          { href: '/espace/preinscriptions', icon: Inbox, t: 'Traiter les pré-inscriptions', d: 'Demandes envoyées depuis le site de l’école.' },
          { href: '/espace/documents', icon: BookOpen, t: 'Délivrer un document', d: 'Certificat, attestation ou carte scolaire avec QR code.' },
        ].map(({ href, icon: I, t, d }) => (
          <Link key={href} href={href} className="rounded-xl border border-line bg-surface p-5 hover:border-brand">
            <I className="size-8 text-orange" />
            <p className="mt-2 text-xl font-bold">{t}</p>
            <p className="text-sm text-muted">{d}</p>
          </Link>
        ))}
      </div>
    </>
  );
}

type Course = { slotId: string; classId: string; className: string; site: string; classSubjectId: string; subject: string; room: string | null; startMinute: number; endMinute: number; cancelled: boolean; taken: string | null };

export function TeacherDashboard() {
  const { me } = useAuth();
  const [day, setDay] = useState(today());
  const q = useApi<Course[]>(`/attendance/my-courses?date=${day}`);
  return (
    <>
      <PageHeader title={`Bonjour ${me?.user.firstName}`} subtitle={date(day, { weekday: 'long', day: 'numeric', month: 'long' })} actions={<input type="date" value={day} onChange={(e) => setDay(e.target.value || today())} className="min-h-11 rounded-lg border border-line bg-surface px-3" aria-label="Jour" />} />
      <Loader {...q}>
        {(courses) =>
          courses.length === 0 ? (
            <Empty title="Aucun cours ce jour-là">Choisissez une autre date pour voir vos cours.</Empty>
          ) : (
            <div className="grid gap-3">
              {courses.map((c) => (
                <Card key={c.slotId} className="flex flex-wrap items-center gap-3">
                  <div className="tabular w-20 flex-none font-display text-2xl font-bold leading-none">{hhmm(c.startMinute)}<span className="block text-sm font-semibold text-muted">→ {hhmm(c.endMinute)}</span></div>
                  <div className="min-w-0 flex-1">
                    <p className="text-lg font-bold">{c.subject} · {c.className}</p>
                    <p className="text-sm text-muted">{c.site}{c.room ? ` · ${c.room}` : ''}</p>
                  </div>
                  {c.cancelled ? <Badge tone="bad">Annulé</Badge> : c.taken ? <Badge tone="good">Appel fait</Badge> : null}
                  {!c.cancelled && (
                    <div className="flex gap-2">
                      <Button asChild variant={c.taken ? 'outline' : 'default'}><Link href={`/espace/appel${qs({ classId: c.classId, date: day, start: c.startMinute, cs: c.classSubjectId })}`}><ClipboardCheck className="size-4" /> {c.taken ? 'Revoir l’appel' : 'Faire l’appel'}</Link></Button>
                      <Button asChild variant="outline"><Link href={`/espace/cahier-de-texte${qs({ cs: c.classSubjectId, date: day })}`}><BookOpen className="size-4" /> Cahier</Link></Button>
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )
        }
      </Loader>
    </>
  );
}

type Today = { date: string; absent: number; late: number; presenceRate: number | null; pendingJustifications: number; unjustified: number; sessionsTaken: number };

export function VieScolaireDashboard() {
  const t = useApi<Today>('/attendance/today');
  const pending = useApi<any[]>('/attendance/absences?justification=PENDING');
  return (
    <>
      <PageHeader title="Vie scolaire" subtitle={date(today(), { weekday: 'long', day: 'numeric', month: 'long' })} />
      <Loader {...t}>
        {(d) => (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Absents aujourd’hui" value={d.absent} tone={d.absent ? 'warn' : undefined} />
            <Stat label="Retards" value={d.late} />
            <Stat label="Justificatifs à examiner" value={d.pendingJustifications} tone={d.pendingJustifications ? 'warn' : undefined} />
            <Stat label="Appels faits" value={d.sessionsTaken} detail={d.presenceRate === null ? undefined : `Présence ${note(d.presenceRate)} %`} />
          </div>
        )}
      </Loader>
      <Section title="Justificatifs à examiner" action={<Link href="/espace/assiduite?f=PENDING" className="text-sm font-bold text-brand">Tout voir</Link>}>
        <Loader {...pending}>
          {(rows) => rows.length === 0 ? <Empty title="Rien à examiner" /> : (
            <div>{rows.slice(0, 6).map((r) => (
              <LinkRow key={r.id} href="/espace/assiduite?f=PENDING" right={<StatusBadge status="PENDING" justification />}>
                <p className="font-bold">{r.student.firstName} {r.student.lastName} · {r.class.name}</p>
                <p className="truncate text-sm text-muted">{date(r.date)} · {r.justificationReason}</p>
              </LinkRow>
            ))}</div>
          )}
        </Loader>
      </Section>
    </>
  );
}

type FinanceDash = {
  today: { amount: number; count: number }; month: { amount: number; count: number }; expected: number; collected: number; remaining: number; recoveryRate: number; pendingOnline: number;
  byMethod: { method: string; label: string; amount: number }[]; aging: { label: string; amount: number; count: number }[];
};

export function FinanceDashboard({ title = 'Économat' }: { title?: string }) {
  const q = useApi<FinanceDash>('/finance/dashboard');
  return (
    <>
      <PageHeader title={title} subtitle="Situation des frais scolaires de l’année en cours." actions={title === 'Économat' && <Button asChild variant="accent"><Link href="/espace/guichet">Encaisser un paiement <ArrowRight className="size-4" /></Link></Button>} />
      <Loader {...q}>
        {(d) => (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Encaissé aujourd’hui" value={fcfa(d.today.amount)} detail={`${d.today.count} paiement(s)`} />
              <Stat label="Encaissé ce mois" value={fcfa(d.month.amount)} detail={`${d.month.count} paiement(s)`} />
              <Stat label="Taux de recouvrement" value={`${note(d.recoveryRate)} %`} detail={`${fcfa(d.collected)} sur ${fcfa(d.expected)}`} tone={d.recoveryRate < 50 ? 'warn' : 'good'} />
              <Stat label="Reste à recouvrer" value={fcfa(d.remaining)} tone="bad" detail={d.pendingOnline ? `${d.pendingOnline} paiement(s) en ligne en attente` : undefined} />
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <Section title="Ancienneté des impayés" action={<Link href="/espace/impayes" className="text-sm font-bold text-brand">Relancer</Link>}>
                <Bars items={d.aging.map((a) => ({ label: `${a.label} (${a.count})`, value: a.amount, tone: 'bad' }))} format={fcfa} />
              </Section>
              <Section title="Encaissements par moyen de paiement">
                {d.byMethod.length ? <Bars items={d.byMethod.map((m) => ({ label: m.label, value: m.amount, tone: 'good' }))} format={fcfa} /> : <Empty title="Aucun encaissement" />}
              </Section>
            </div>
          </>
        )}
      </Loader>
    </>
  );
}

type StudentGrades = { term: { name: string } | null; subjects: { subject: string; average: number | null }[]; average: number | null; classAverage: number | null };

export function FamilyDashboard() {
  const { child, role, me } = useAuth();
  const id = child!.id;
  const grades = useApi<StudentGrades>(`/evaluation/students/${id}`);
  const invoices = useApi<{ remaining: number; status: string }[]>(role === 'PARENT' ? `/finance/invoices?studentId=${id}` : null);
  const absences = useApi<any[]>(`/attendance/absences?studentId=${id}`);
  const homework = useApi<any[]>(`/lessons/homework/${id}`);
  const balance = invoices.data?.filter((i) => i.status !== 'CANCELLED').reduce((s, i) => s + i.remaining, 0);
  const unjustified = absences.data?.filter((a) => a.justification === 'NONE').length ?? 0;

  return (
    <>
      <PageHeader title={role === 'ELEVE' ? `Bonjour ${child!.firstName}` : `${child!.firstName} ${child!.lastName}`} subtitle={`${child!.className ?? ''} · ${me?.year?.label ?? ''}`} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Link href="/espace/resultats"><Stat label={`Moyenne${grades.data?.term ? ` · ${grades.data.term.name}` : ''}`} value={grades.data ? (grades.data.average === null ? '—' : `${note(grades.data.average)}`) : '…'} detail={grades.data?.classAverage != null ? `Classe : ${note(grades.data.classAverage)}` : undefined} /></Link>
        <Link href="/espace/absences"><Stat label="Absences non justifiées" value={absences.data ? unjustified : '…'} tone={unjustified ? 'bad' : undefined} detail={absences.data ? `${absences.data.length} absence(s) ou retard(s)` : undefined} /></Link>
        {role === 'PARENT' && (
          <Link href="/espace/frais"><Stat label="Reste à payer" value={balance === undefined ? '…' : fcfa(balance)} tone={balance ? 'bad' : 'good'} detail={balance ? 'Payer par Mobile Money' : 'À jour'} /></Link>
        )}
        <Link href="/espace/devoirs"><Stat label="Devoirs à venir" value={homework.data ? homework.data.filter((h) => h.homeworkDue && h.homeworkDue.slice(0, 10) >= today()).length : '…'} /></Link>
      </div>
      {role === 'PARENT' && !!balance && (
        <Card className="flex flex-wrap items-center gap-3 border-orange bg-orange-soft">
          <Wallet className="size-8 text-orange" />
          <p className="min-w-0 flex-1 font-bold">Il reste {fcfa(balance)} à régler pour {child!.firstName}.</p>
          <Button asChild variant="accent"><Link href="/espace/frais">Payer maintenant</Link></Button>
        </Card>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Dernières moyennes" action={<Link href="/espace/resultats" className="text-sm font-bold text-brand">Détail</Link>}>
          <Loader {...grades}>
            {(g) => g.subjects.length === 0 ? <Empty title="Pas encore de notes publiées" /> : <Bars items={g.subjects.map((s) => ({ label: s.subject, value: s.average ?? 0, tone: (s.average ?? 0) < 10 ? 'bad' : 'good' }))} max={20} format={(n) => `${note(n)} / 20`} />}
          </Loader>
        </Section>
        <Section title="Devoirs" action={<Link href="/espace/devoirs" className="text-sm font-bold text-brand">Tout voir</Link>}>
          <Loader {...homework}>
            {(rows) => rows.length === 0 ? <Empty title="Aucun devoir" /> : (
              <ul className="grid gap-2">
                {rows.slice(0, 4).map((h) => (
                  <li key={h.id} className="rounded-lg bg-sunk px-3 py-2">
                    <p className="font-bold">{h.classSubject.subject.name} <span className="font-semibold text-muted">· pour le {date(h.homeworkDue, { weekday: 'short', day: 'numeric', month: 'short' })}</span></p>
                    <p className="text-sm">{h.homework}</p>
                  </li>
                ))}
              </ul>
            )}
          </Loader>
        </Section>
      </div>
    </>
  );
}

