'use client';

import { useParams, useSearchParams } from 'next/navigation';
import { Printer } from 'lucide-react';
import { Loader } from '@/components/espace/bits';
import { LegalFooter, Letterhead, PrintBar, Signatory, type SchoolIdentity } from '@/components/print/letterhead';
import { VerifyQr } from '@/components/qr';
import { Button } from '@/components/ui';
import { date, note } from '@/lib/format';
import { useApi } from '@/lib/use-api';

type Card = {
  id: string; average: string | null; rank: number | null; classSize: number; distinction: string | null; appreciation: string | null; councilDecision: string | null; absencesCount: number; verifyCode: string; publishedAt: string | null; createdAt: string;
  items: { id: string; subjectName: string; coefficient: string; average: string | null; classAverage: string | null; minAverage: string | null; maxAverage: string | null; rank: number | null; teacherName: string | null; appreciation: string | null }[];
  student: { firstName: string; lastName: string; matricule: string; birthDate: string | null; sex: string | null };
  class: { name: string; site: { name: string }; level: { name: string }; track: { name: string } | null; headTeacher: { firstName: string; lastName: string } | null };
  term: { name: string; year: string }; tenant: { name: string }; identity: SchoolIdentity;
};

export default function Bulletin() {
  const { id } = useParams<{ id: string }>();
  const all = useSearchParams().get('tous');
  const ids = all ? all.split(',') : [id];
  return (
    <>
      <PrintBar><Button onClick={() => window.print()}><Printer className="size-4" /> Imprimer</Button></PrintBar>
      <div className="grid gap-6 print:block">{ids.map((x) => <OneCard key={x} id={x} />)}</div>
    </>
  );
}

function OneCard({ id }: { id: string }) {
  const q = useApi<Card>(`/report-cards/${id}`);
  return (
    <Loader {...q}>
      {(c) => (
        <article className="mx-auto grid w-full max-w-[210mm] gap-4 bg-white p-6 text-[13px] text-black shadow-sm print:break-after-page print:p-0 print:shadow-none">
          <Letterhead identity={c.identity} site={c.class.site.name} />
          <div className="text-center">
            <h1 className="font-display text-2xl font-bold uppercase">Bulletin de notes · {c.term.name}</h1>
            <p>Année scolaire {c.term.year}</p>
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 rounded border border-black/30 p-3">
            <p>Élève : <b>{c.student.lastName} {c.student.firstName}</b></p>
            <p>Matricule : <b className="font-mono">{c.student.matricule}</b></p>
            <p>Classe : <b>{c.class.name}</b>{c.class.track ? ` · ${c.class.track.name}` : ''}</p>
            <p>Effectif : {c.classSize}</p>
            {c.student.birthDate && <p>Né(e) le {date(c.student.birthDate)}</p>}
            <p>Professeur principal : {c.class.headTeacher ? `${c.class.headTeacher.firstName} ${c.class.headTeacher.lastName}` : '—'}</p>
          </div>
          <table className="w-full border-collapse text-[12.5px] [&_td]:border [&_td]:border-black/40 [&_td]:px-1.5 [&_td]:py-1 [&_th]:border [&_th]:border-black/40 [&_th]:bg-[#e3e9f8] [&_th]:px-1.5 [&_th]:py-1">
            <thead><tr><th className="text-left">Matière</th><th>Coef.</th><th>Moy.</th><th>Moy. × coef.</th><th>Rang</th><th>Classe</th><th>Min / Max</th><th className="text-left">Appréciation</th><th className="text-left">Professeur</th></tr></thead>
            <tbody>
              {c.items.map((i) => (
                <tr key={i.id}>
                  <td className="font-bold">{i.subjectName}</td>
                  <td className="text-center">{note(i.coefficient)}</td>
                  <td className="text-center font-bold">{note(i.average)}</td>
                  <td className="text-center">{i.average === null ? '—' : note(Number(i.average) * Number(i.coefficient))}</td>
                  <td className="text-center">{i.rank ?? '—'}</td>
                  <td className="text-center">{note(i.classAverage)}</td>
                  <td className="text-center">{note(i.minAverage)} / {note(i.maxAverage)}</td>
                  <td>{i.appreciation}</td>
                  <td>{i.teacherName}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="rounded border border-black/40 p-2"><p className="text-xs uppercase">Moyenne générale</p><p className="font-display text-3xl font-bold">{note(c.average)}<span className="text-base"> / 20</span></p></div>
            <div className="rounded border border-black/40 p-2"><p className="text-xs uppercase">Rang</p><p className="font-display text-3xl font-bold">{c.rank ?? '—'}<span className="text-base"> / {c.classSize}</span></p></div>
            <div className="rounded border border-black/40 p-2"><p className="text-xs uppercase">Absences</p><p className="font-display text-3xl font-bold">{c.absencesCount}</p></div>
          </div>
          <div className="grid grid-cols-[1fr_auto] gap-4">
            <div className="grid gap-1 rounded border border-black/40 p-3">
              <p><b>Mention :</b> {c.distinction ?? '—'}</p>
              <p><b>Appréciation du conseil :</b> {c.appreciation || '—'}</p>
              <p><b>Décision :</b> {c.councilDecision || '—'}</p>
              <div className="mt-4 flex items-start justify-between gap-4 text-xs">
                <span className="pt-1 font-bold">Le professeur principal</span>
                <Signatory identity={c.identity} className="text-xs" />
              </div>
            </div>
            <VerifyQr code={c.verifyCode} />
          </div>
          <LegalFooter identity={c.identity} />
          <p className="text-center text-[11px] text-black/60">Document authentifiable par QR code · {c.publishedAt ? `publié le ${date(c.publishedAt)}` : 'non encore publié'}</p>
        </article>
      )}
    </Loader>
  );
}
