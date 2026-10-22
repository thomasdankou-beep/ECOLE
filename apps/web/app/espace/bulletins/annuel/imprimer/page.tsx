'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, Printer } from 'lucide-react';
import { Loader } from '@/components/espace/bits';
import { LegalFooter, Letterhead, PrintBar, Signatory, type SchoolIdentity } from '@/components/print/letterhead';
import { Button, Empty } from '@/components/ui';
import { date, note } from '@/lib/format';
import { useApi } from '@/lib/use-api';

type Annual = {
  identity: SchoolIdentity;
  class: { name: string; site: string; level: string; track: string | null; headTeacher: { firstName: string; lastName: string } | null };
  year: { label: string };
  terms: { id: string; name: string; weight: number; classAverage: number | null }[];
  classStats: { mean: number | null; min: number | null; max: number | null };
  classSize: number;
  cards: {
    student: { id: string; firstName: string; lastName: string; matricule: string; birthDate: string | null; photoUrl: string | null };
    subjects: { classSubjectId: string; name: string; coefficient: number; teacher: string | null; terms: Record<string, number | null>; average: number | null; classAverage: number | null }[];
    terms: Record<string, number | null>; average: number | null; rank: number | null; distinction: string | null; absences: number;
    outcomeLabel: string | null; note: string | null;
  }[];
};

/** Bulletin annuel : une classe entière (?classId=…, éventuellement &ids=…) ou un élève (?eleve=…). */
export default function BulletinAnnuel() {
  const p = useSearchParams();
  const classId = p.get('classId');
  const ids = p.get('ids');
  const student = p.get('eleve');
  const q = useApi<Annual>(student ? `/report-cards/students/${student}/annual` : `/report-cards/annual/${classId}/cards${ids ? `?ids=${ids}` : ''}`);
  return (
    <>
      <PrintBar>
        <Link href={student ? '/espace/bulletins' : '/espace/bulletins/annuel'} className="inline-flex items-center gap-1 text-sm font-bold text-brand"><ArrowLeft className="size-4" /> Retour</Link>
        <Button onClick={() => window.print()}><Printer className="size-4" /> Imprimer</Button>
      </PrintBar>
      <Loader {...q}>
        {(a) => a.cards.length === 0 ? <Empty title="Aucun élève dans cette classe" /> : (
          <div className="grid gap-6 print:block">{a.cards.map((c) => <Card key={c.student.id} a={a} c={c} />)}</div>
        )}
      </Loader>
    </>
  );
}

function Card({ a, c }: { a: Annual; c: Annual['cards'][number] }) {
  const coefs = c.subjects.filter((s) => s.average !== null).reduce((x, s) => x + s.coefficient, 0);
  return (
    <article className="mx-auto grid w-full max-w-[210mm] gap-4 bg-white p-6 text-[13px] text-black shadow-sm print:break-after-page print:last:break-after-auto print:p-0 print:shadow-none">
      <Letterhead identity={a.identity} site={a.class.site} />
      <div className="text-center">
        <h1 className="font-display text-2xl font-bold uppercase">Bulletin annuel</h1>
        <p>Année scolaire {a.year.label}</p>
      </div>
      <div className="flex gap-3 rounded border border-black/30 p-3">
            {c.student.photoUrl && <img src={c.student.photoUrl} alt="" className="h-[30mm] w-[24mm] flex-none rounded object-cover" />}
            <div className="grid flex-1 grid-cols-2 content-start gap-x-6 gap-y-1">
        <p>Élève : <b>{c.student.lastName} {c.student.firstName}</b></p>
        <p>Matricule : <b className="font-mono">{c.student.matricule}</b></p>
        <p>Classe : <b>{a.class.name}</b>{a.class.track ? ` · ${a.class.track}` : ''}</p>
        <p>Effectif : {a.classSize}</p>
        {c.student.birthDate && <p>Né(e) le {date(c.student.birthDate)}</p>}
        <p>Professeur principal : {a.class.headTeacher ? `${a.class.headTeacher.firstName} ${a.class.headTeacher.lastName}` : '—'}</p>
      </div>
          </div>
      <table className="w-full border-collapse text-[12.5px] [&_td]:border [&_td]:border-black/40 [&_td]:px-1.5 [&_td]:py-1 [&_th]:border [&_th]:border-black/40 [&_th]:bg-[#e3e9f8] [&_th]:px-1.5 [&_th]:py-1">
        <thead>
          <tr><th className="text-left">Matière</th><th>Coef.</th>{a.terms.map((t) => <th key={t.id}>{t.name}</th>)}<th>Moy. annuelle</th><th>Moy. × coef.</th><th>Classe</th><th className="text-left">Professeur</th></tr>
        </thead>
        <tbody>
          {c.subjects.map((s) => (
            <tr key={s.classSubjectId}>
              <td className="font-bold">{s.name}</td>
              <td className="text-center">{note(s.coefficient)}</td>
              {a.terms.map((t) => <td key={t.id} className="text-center">{note(s.terms[t.id])}</td>)}
              <td className="text-center font-bold">{note(s.average)}</td>
              <td className="text-center">{s.average === null ? '—' : note(s.average * s.coefficient)}</td>
              <td className="text-center">{note(s.classAverage)}</td>
              <td>{s.teacher ?? ''}</td>
            </tr>
          ))}
          <tr className="font-bold">
            <td>Moyenne générale</td>
            <td className="text-center">{note(coefs)}</td>
            {a.terms.map((t) => <td key={t.id} className="text-center">{note(c.terms[t.id])}</td>)}
            <td className="text-center">{note(c.average)}</td>
            <td colSpan={3} className="text-xs font-normal">Moyenne annuelle = {a.terms.map((t) => `${t.name} × ${note(t.weight)}`).join(' + ')}, divisé par {note(a.terms.reduce((x, t) => x + t.weight, 0))}</td>
          </tr>
        </tbody>
      </table>
      <div className="grid grid-cols-4 gap-3 text-center">
        <div className="rounded border-2 border-black/60 p-2"><p className="text-xs uppercase">Moyenne annuelle</p><p className="font-display text-3xl font-bold">{note(c.average)}<span className="text-base"> / 20</span></p></div>
        <div className="rounded border border-black/40 p-2"><p className="text-xs uppercase">Rang</p><p className="font-display text-3xl font-bold">{c.rank ?? '—'}<span className="text-base"> / {a.classSize}</span></p></div>
        <div className="rounded border border-black/40 p-2"><p className="text-xs uppercase">Absences de l’année</p><p className="font-display text-3xl font-bold">{c.absences}</p></div>
        <div className="rounded border border-black/40 p-2"><p className="text-xs uppercase">Classe</p><p className="text-sm">Moyenne {note(a.classStats.mean)}</p><p className="text-sm">de {note(a.classStats.min)} à {note(a.classStats.max)}</p></div>
      </div>
      <div className="grid gap-1 rounded border border-black/40 p-3">
        <p><b>Mention :</b> {c.distinction ?? '—'}</p>
        <p><b>Décision de fin d’année :</b> {c.outcomeLabel ?? '—'}{c.note ? ` · ${c.note}` : ''}</p>
        <div className="mt-4 flex items-start justify-between gap-4 text-xs">
          <span className="pt-1 font-bold">Le professeur principal</span>
          <Signatory identity={a.identity} className="text-xs" />
        </div>
      </div>
      <LegalFooter identity={a.identity} />
    </article>
  );
}
