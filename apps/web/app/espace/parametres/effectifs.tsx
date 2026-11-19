'use client';

import { useMemo, useState } from 'react';
import { ArrowLeft, FileText, Paperclip, Search, Users } from 'lucide-react';
import { Loader, Section } from '@/components/espace/bits';
import { Badge, Button, Card, Chips, Dialog, DialogContent, Empty, ErrorNote, Field, Input, Stat, Textarea, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useAction, useApi } from '@/lib/use-api';

/**
 * Effectifs facturables (lot G5b), pour la direction : les comptages des élèves faits par Cahiora (fin de la période
 * gratuite, comptage initial, régularisations), la liste nominative de chacun et, pendant la vérification, les demandes
 * de correction : exclusion d'une inscription annulée par erreur de saisie (décision de la direction, D-G5-13 B et
 * D-G5-14 A) et date d'un départ enregistré avant l'historique des inscriptions (D-G5-16 A). Aucun montant ici.
 */

type Kind = 'TRIAL_END' | 'PILOT_END' | 'INITIAL' | 'FIRST_REGULARIZATION' | 'FINAL_REGULARIZATION';
type Basis = 'ACTIVE' | 'DEPARTURE_AUDIT' | 'DEPARTURE_UNKNOWN' | 'DEPARTURE_DIRECTION' | 'EXCLUDED';
type Count = {
  id: string; yearLabel: string; kind: Kind; kindLabel: string; referenceDate: string; stage: 'PROVISIONAL' | 'FROZEN'; stageLabel: string;
  pupils: number; cumulative: number; toCheck: number; excluded: number; listHash: string; at: string; knownAt: string; reviewUntil: string | null;
  reviewOpen: boolean; frozen: boolean; timeZone: string; pendingRequests?: number;
};
type Item = {
  enrollmentId: string; matricule: string; name: string; className: string; siteName: string | null; counted: boolean; basis: Basis; basisLabel: string;
  departureDate: string | null; enrollmentStatus: string | null; cancelReason: string | null; duplicate: 'SAME' | 'PENDING' | null;
  exclusion: { id: string; status: 'PENDING' | 'VALIDATED' } | null; canExclude: boolean; canDate: boolean; auditDay: string | null; stillCounted: boolean | null;
};
type Correction = {
  id: string; kind: 'EXCLUSION' | 'DEPARTURE_DATE'; enrollmentId: string; matricule: string; name: string; countId: string; status: 'PENDING' | 'VALIDATED' | 'REFUSED';
  departureDate: string | null; justification: string; fileUrl: string | null; requestedByName: string; requestedAt: string;
  decidedByName: string | null; decidedAt: string | null; decisionNote: string | null;
};
type Detail = { today: string; count: Count; items: Item[]; live: { pupils: number; added: Item[]; removed: number } | null; corrections: Correction[] };

const frDate = (d: string | null | undefined) => (d ? new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '—');
const pupils = (n: number) => `${n} élève${n > 1 ? 's' : ''}`;
const STATUS: Record<Correction['status'], [string, 'warn' | 'good' | 'bad']> = { PENDING: ['En attente de décision', 'warn'], VALIDATED: ['Validée', 'good'], REFUSED: ['Refusée', 'bad'] };
type Filter = 'all' | 'check' | 'cancelled' | 'excluded';

export function Effectifs() {
  const q = useApi<{ today: string; counts: Count[] }>('/settings/billing-counts');
  const [open, setOpen] = useState<string | null>(null);
  if (open) return <Comptage id={open} back={() => { setOpen(null); q.reload(); }} />;
  return (
    <Loader {...q}>
      {(d) => (
        <div className="grid gap-4">
          <Section title="Effectifs facturables">
            <div className="grid gap-2 text-[15px]">
              <p>Cahiora compte les élèves inscrits à la fin de votre période gratuite, puis à chaque date de votre calendrier de facturation (rubrique « Abonnement Cahiora »).</p>
              <p className="text-sm text-muted">Après un comptage provisoire, vous vérifiez la liste jusqu’à la date indiquée ; le comptage est ensuite figé et sert au calcul de votre abonnement. Un comptage figé ne change plus. Aucun montant n’est calculé ici.</p>
            </div>
          </Section>
          {d.counts.length === 0 ? (
            <Empty title="Aucun comptage pour le moment">Le premier comptage aura lieu à la fin de votre période gratuite, ou à la date du comptage initial de votre calendrier de facturation.</Empty>
          ) : (
            <ul className="grid gap-3">
              {d.counts.map((c) => (
                <li key={c.id}>
                  <Card className="grid gap-2">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="font-bold">{c.kindLabel} du {frDate(c.referenceDate)}</h3>
                        <p className="text-sm text-muted">Année {c.yearLabel}</p>
                      </div>
                      <Badge tone={c.stage === 'FROZEN' ? 'good' : 'warn'}>{c.stageLabel}</Badge>
                    </div>
                    <p className="text-[15px]"><b className="text-xl">{pupils(c.pupils)}</b> comptés · cumul de l’année : <b>{c.cumulative}</b>{c.toCheck ? <> · <span className="text-warn">{c.toCheck} à vérifier</span></> : null}{c.excluded ? ` · ${c.excluded} exclu${c.excluded > 1 ? 's' : ''}` : ''}</p>
                    {c.reviewOpen && <p className="rounded-lg bg-warn-soft p-2 text-sm">Vérification ouverte jusqu’au <b>{frDate(c.reviewUntil)}</b> inclus.{c.pendingRequests ? ` ${c.pendingRequests} demande${c.pendingRequests > 1 ? 's' : ''} en attente de votre décision.` : ''}</p>}
                    {c.stage === 'PROVISIONAL' && !c.reviewOpen && <p className="text-sm text-muted">{c.frozen ? 'Vérification terminée : le comptage définitif de cette date le remplace.' : 'Vérification terminée : le comptage définitif sera fait au prochain passage de Cahiora.'}</p>}
                    <div><Button size="sm" variant="outline" onClick={() => setOpen(c.id)} aria-label={`Voir la liste : ${c.kindLabel} du ${frDate(c.referenceDate)}, ${c.stageLabel.toLowerCase()}`}><Users className="size-4" /> Voir la liste</Button></div>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Loader>
  );
}

function Comptage({ id, back }: { id: string; back: () => void }) {
  const q = useApi<Detail>(`/settings/billing-counts/${id}`);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<{ kind: 'exclude' | 'date'; item: Item } | { kind: 'decide'; correction: Correction } | null>(null);
  const done = () => { setDialog(null); q.reload(); };
  return (
    <div className="grid gap-4">
      <div><Button variant="ghost" size="sm" onClick={back}><ArrowLeft className="size-4" /> Tous les comptages</Button></div>
      <Loader {...q}>
        {(d) => (
          <>
            <Section title={`${d.count.kindLabel} du ${frDate(d.count.referenceDate)}`} action={<Badge tone={d.count.stage === 'FROZEN' ? 'good' : 'warn'}>{d.count.stageLabel}</Badge>}>
              <div className="grid gap-3">
                <p className="text-sm text-muted">Année {d.count.yearLabel}. Élèves inscrits à la fin du {frDate(d.count.referenceDate)}, d’après l’historique des inscriptions enregistré le {dateTime(d.count.knownAt)}.</p>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Stat label="Comptés" value={d.count.pupils} />
                  <Stat label="Cumul de l’année" value={d.count.cumulative} detail="Élèves comptés au moins une fois" />
                  <Stat label="À vérifier" value={d.count.toCheck} tone={d.count.toCheck ? 'warn' : undefined} detail="Départ sans date sûre" />
                  <Stat label="Exclus" value={d.count.excluded} detail="Annulés par erreur" />
                </div>
                {d.count.reviewOpen && (
                  <p className="rounded-lg bg-warn-soft p-3 text-sm">Vérification ouverte jusqu’au <b>{frDate(d.count.reviewUntil)}</b> inclus. Vous pouvez demander l’exclusion d’une inscription annulée par erreur de saisie, ou dater un départ enregistré avant l’historique des inscriptions. Le comptage sera ensuite figé.</p>
                )}
                {d.count.stage === 'FROZEN' && <p className="rounded-lg bg-sunk p-3 text-sm">Comptage figé : il ne change plus et sert au calcul de votre abonnement Cahiora.</p>}
                {d.live && (
                  <div className="grid gap-2 rounded-lg border border-line p-3 text-sm">
                    <p>Si la vérification se terminait maintenant : <b>{pupils(d.live.pupils)}</b>.{' '}
                      {d.live.added.length ? `${d.live.added.length} ajouté${d.live.added.length > 1 ? 's' : ''} (inscription saisie après le comptage provisoire)` : 'Aucun ajout'}
                      {', '}{d.live.removed ? `${d.live.removed} retiré${d.live.removed > 1 ? 's' : ''} (exclusion validée ou départ daté)` : 'aucun retrait'}.</p>
                    {d.live.added.length > 0 && (
                      <ul className="grid gap-1">
                        {d.live.added.map((i) => <li key={i.enrollmentId} className="rounded bg-sunk px-2 py-1"><b>{i.name}</b> <span className="text-muted">· {i.matricule} · {i.className}{i.siteName ? ` · ${i.siteName}` : ''}</span></li>)}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            </Section>
            <Liste d={d} filter={filter} setFilter={setFilter} search={search} setSearch={setSearch} act={(kind, item) => setDialog({ kind, item })} />
            <Corrections d={d} decide={(correction) => setDialog({ kind: 'decide', correction })} />
          </>
        )}
      </Loader>
      <Dialog open={!!dialog} onOpenChange={(o) => !o && setDialog(null)}>
        {dialog && q.data && dialog.kind === 'exclude' && <ExclusionDialog count={q.data.count} item={dialog.item} done={done} />}
        {dialog && q.data && dialog.kind === 'date' && <DepartureDialog count={q.data.count} item={dialog.item} today={q.data.today} done={done} />}
        {dialog && dialog.kind === 'decide' && <DecisionDialog correction={dialog.correction} done={done} />}
      </Dialog>
    </div>
  );
}

function Liste({ d, filter, setFilter, search, setSearch, act }: {
  d: Detail; filter: Filter; setFilter: (f: Filter) => void; search: string; setSearch: (s: string) => void; act: (kind: 'exclude' | 'date', item: Item) => void;
}) {
  const checks = (i: Item) => i.counted && (i.basis === 'DEPARTURE_AUDIT' || i.basis === 'DEPARTURE_UNKNOWN');
  const shown = useMemo(() => {
    const s = search.trim().toLowerCase();
    return d.items.filter((i) => (filter === 'all' || (filter === 'check' && checks(i)) || (filter === 'cancelled' && i.enrollmentStatus === 'CANCELLED') || (filter === 'excluded' && !i.counted))
      && (!s || `${i.name} ${i.matricule} ${i.className} ${i.siteName ?? ''}`.toLowerCase().includes(s)));
  }, [d.items, filter, search]);
  const n = (f: (i: Item) => boolean) => d.items.filter(f).length;
  return (
    <Section title="Liste nominative">
      <div className="grid gap-3">
        <Chips label="Afficher" value={filter} onChange={setFilter} options={[
          { value: 'all', label: `Tous (${d.items.length})` }, { value: 'check', label: `À vérifier (${n(checks)})` },
          { value: 'cancelled', label: `Inscriptions annulées (${n((i) => i.enrollmentStatus === 'CANCELLED')})` }, { value: 'excluded', label: `Exclus (${n((i) => !i.counted)})` },
        ]} />
        <label className="relative block">
          <span className="sr-only">Rechercher un élève</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <Input className="pl-9" placeholder="Nom, matricule, classe ou site" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        {shown.length === 0 ? <p className="text-sm text-muted">Aucun élève dans cette liste.</p> : (
          <ul className="grid gap-2">
            {shown.map((i) => (
              <li key={i.enrollmentId} className={`grid gap-1 rounded-lg p-3 text-sm ${i.counted ? 'bg-sunk' : 'border border-dashed border-line'}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="min-w-0"><b className="text-[15px]">{i.name}</b> <span className="text-muted">· {i.matricule}</span><span className="block text-muted">{i.className}{i.siteName ? ` · ${i.siteName}` : ''}</span></span>
                  <Badge tone={i.counted ? 'good' : 'info'}>{i.counted ? 'Compté' : 'Non compté'}</Badge>
                </div>
                <span>{i.basisLabel}{i.departureDate ? ` (${frDate(i.departureDate)})` : ''}</span>
                {i.basis === 'DEPARTURE_UNKNOWN' && <span className="text-warn">Aucune date de départ connue : l’élève reste compté tant qu’aucune date n’est fixée.</span>}
                {i.enrollmentStatus === 'CANCELLED' && <span className="text-muted">Inscription annulée depuis{i.cancelReason ? ` : « ${i.cancelReason} »` : ''}.</span>}
                {i.duplicate && <span className="text-muted">{i.duplicate === 'SAME' ? 'Doublon confirmé par la direction (même élève).' : 'Doublon possible, pas encore tranché (Élèves › Doublons possibles).'}</span>}
                {i.exclusion && <span className="font-bold">{i.exclusion.status === 'PENDING' ? 'Exclusion demandée, en attente de décision.' : 'Exclusion validée.'}</span>}
                {i.stillCounted === false && i.counted && <span className="font-bold text-warn">Ne sera plus compté si la vérification se termine maintenant.</span>}
                {(i.canExclude || i.canDate) && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {i.canExclude && <Button size="sm" variant="outline" onClick={() => act('exclude', i)}>Demander l’exclusion</Button>}
                    {i.canDate && <Button size="sm" variant="outline" onClick={() => act('date', i)}>Dater le départ</Button>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}

function Corrections({ d, decide }: { d: Detail; decide: (c: Correction) => void }) {
  return (
    <Section title="Demandes de correction">
      {d.corrections.length === 0 ? <p className="text-sm text-muted">Aucune demande pour cette année scolaire.</p> : (
        <ul className="grid gap-2">
          {d.corrections.map((k) => {
            const [label, tone] = STATUS[k.status];
            return (
              <li key={k.id} className="grid gap-1 rounded-lg border border-line p-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span><b>{k.kind === 'EXCLUSION' ? 'Exclusion' : `Date de départ : ${frDate(k.departureDate)}`}</b> · {k.name} <span className="text-muted">({k.matricule})</span></span>
                  <Badge tone={tone}>{label}</Badge>
                </div>
                <span>« {k.justification} »</span>
                {k.fileUrl && <a className="inline-flex items-center gap-1 font-bold text-brand underline" href={k.fileUrl} target="_blank" rel="noreferrer"><Paperclip className="size-4" /> Justificatif</a>}
                <span className="text-xs text-muted">Demandée le {dateTime(k.requestedAt)} par {k.requestedByName}{k.decidedAt && k.kind === 'EXCLUSION' ? ` · décision le ${dateTime(k.decidedAt)} par ${k.decidedByName}` : ''}</span>
                {k.decisionNote && <span className="text-xs">Motif de la décision : {k.decisionNote}</span>}
                {k.status === 'PENDING' && <div className="pt-1"><Button size="sm" onClick={() => decide(k)}>Décider</Button></div>}
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted">Une exclusion validée vaut pour le comptage figé à la fin de la vérification et pour les suivants ; un comptage déjà figé ne change jamais. Chaque demande et chaque décision sont datées et inscrites dans le journal.</p>
    </Section>
  );
}

/** Justificatif facultatif : photo ou PDF, 5 Mo au plus (contrôlé par le serveur). */
function FileField({ file, setFile }: { file: File | null; setFile: (f: File | null) => void }) {
  return (
    <>
      <label className="flex min-h-12 cursor-pointer items-center gap-2 rounded-lg border border-dashed border-line px-3 font-bold">
        <FileText className="size-5 text-brand" /> {file ? file.name : 'Justificatif (facultatif)'}
        <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      <p className="-mt-2 text-xs text-muted">Photo ou PDF, 5 Mo au plus : registre, courrier des parents, certificat.</p>
    </>
  );
}

function ExclusionDialog({ count, item, done }: { count: Count; item: Item; done: () => void }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const [justification, setJustification] = useState('');
  const [file, setFile] = useState<File | null>(null);
  return (
    <DialogContent title={`Exclure ${item.name} du comptage`} description="Seule une inscription annulée pour erreur de saisie (doublon, élève inscrit par erreur) peut être exclue. Un départ réel ne s’exclut jamais : l’élève compte jusqu’à son départ.">
      <form className="grid gap-3" onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData();
        fd.append('kind', 'EXCLUSION');
        fd.append('enrollmentId', item.enrollmentId);
        fd.append('justification', justification);
        if (file) fd.append('file', file);
        if (await run(() => api.post(`/settings/billing-counts/${count.id}/corrections`, fd), toast, 'Demande d’exclusion enregistrée : elle attend votre décision')) done();
      }}>
        <p className="rounded-lg bg-sunk p-2 text-sm">{item.matricule} · {item.className}{item.cancelReason ? ` · annulée : « ${item.cancelReason} »` : ''}</p>
        <Field label="Justification" hint="5 caractères au moins : pourquoi cette inscription était une erreur de saisie.">
          <Textarea value={justification} onChange={(e) => setJustification(e.target.value)} required minLength={5} maxLength={500} />
        </Field>
        <FileField file={file} setFile={setFile} />
        <Button type="submit" loading={busy}>Demander l’exclusion</Button>
        <p className="text-xs text-muted">La demande est datée et inscrite au journal ; la direction la valide ou la refuse ensuite dans « Demandes de correction ».</p>
      </form>
    </DialogContent>
  );
}

function DepartureDialog({ count, item, today, done }: { count: Count; item: Item; today: string; done: () => void }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const [day, setDay] = useState('');
  const [justification, setJustification] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const max = item.auditDay && item.auditDay < today ? item.auditDay : today;
  return (
    <DialogContent title={`Date du départ de ${item.name}`} description={item.auditDay
      ? `Départ enregistré avant l’historique des inscriptions. Le journal indique le ${frDate(item.auditDay)} : vous pouvez seulement avancer cette date.`
      : 'Départ enregistré avant l’historique des inscriptions, sans date dans le journal : l’élève reste compté tant qu’aucune date n’est fixée.'}>
      <form className="grid gap-3" onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData();
        fd.append('kind', 'DEPARTURE_DATE');
        fd.append('enrollmentId', item.enrollmentId);
        fd.append('departureDate', day);
        fd.append('justification', justification);
        if (file) fd.append('file', file);
        if (await run(() => api.post(`/settings/billing-counts/${count.id}/corrections`, fd), toast, 'Date de départ enregistrée')) done();
      }}>
        <Field label="Date du départ" hint={`Au plus tard le ${frDate(max)}. Le jour du départ n’est plus un jour de présence.`}>
          <Input type="date" value={day} max={max} onChange={(e) => setDay(e.target.value)} required />
        </Field>
        <Field label="Justification" hint="5 caractères au moins : d’où vient cette date.">
          <Textarea value={justification} onChange={(e) => setJustification(e.target.value)} required minLength={5} maxLength={500} />
        </Field>
        <FileField file={file} setFile={setFile} />
        <Button type="submit" loading={busy}>Enregistrer la date</Button>
        <p className="text-xs text-muted">La date vaut aussitôt pour la suite de la vérification ; elle est datée et inscrite au journal.</p>
      </form>
    </DialogContent>
  );
}

function DecisionDialog({ correction, done }: { correction: Correction; done: () => void }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const send = async (decision: 'VALIDATED' | 'REFUSED') => {
    if (decision === 'REFUSED' && note.trim().length < 5) return setError('Un refus exige un motif (5 caractères au moins).');
    setError(null);
    const ok = await run(() => api.post(`/settings/billing-counts/corrections/${correction.id}/decision`, { decision, note: note.trim() || undefined }), toast,
      decision === 'VALIDATED' ? 'Exclusion validée' : 'Exclusion refusée');
    if (ok) done();
  };
  return (
    <DialogContent title={`Exclusion de ${correction.name}`} description={`Demandée le ${dateTime(correction.requestedAt)} par ${correction.requestedByName}.`}>
      <div className="grid gap-3">
        <p className="rounded-lg bg-sunk p-2 text-sm">« {correction.justification} »</p>
        {correction.fileUrl && <a className="inline-flex items-center gap-1 text-sm font-bold text-brand underline" href={correction.fileUrl} target="_blank" rel="noreferrer"><Paperclip className="size-4" /> Voir le justificatif</a>}
        <Field label="Motif de la décision" hint="Obligatoire pour un refus.">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </Field>
        <ErrorNote error={error} />
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => send('VALIDATED')} loading={busy}>Valider l’exclusion</Button>
          <Button variant="outline" onClick={() => send('REFUSED')} disabled={busy}>Refuser</Button>
        </div>
        <p className="text-xs text-muted">La décision est définitive, datée et inscrite au journal.</p>
      </div>
    </DialogContent>
  );
}
