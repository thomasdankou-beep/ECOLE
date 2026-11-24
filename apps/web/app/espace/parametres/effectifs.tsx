'use client';

import { useMemo, useState } from 'react';
import { ArrowLeft, FileText, Paperclip, Search, Users } from 'lucide-react';
import { Loader, Section } from '@/components/espace/bits';
import { Badge, Button, Card, Chips, Dialog, DialogContent, Empty, ErrorNote, Field, Input, Missing, Stat, Textarea, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useAction, useApi } from '@/lib/use-api';

/**
 * Effectifs facturables (lot G5b), pour la direction : les comptages des élèves faits par Cahiora (fin de la période
 * gratuite, comptage initial, régularisations), la liste nominative de chacun et les demandes de correction : pendant la
 * vérification, exclusion d'une inscription annulée par erreur de saisie et date d'un départ enregistré avant
 * l'historique des inscriptions (D-G5-16 A) ; après un comptage figé, exclusion seulement, jusqu'à 30 jours après le
 * document de Cahiora qui compte l'élève (D-G5-14 A, lot G5c). La direction décide tant qu'aucun document émis n'est
 * touché, Cahiora ensuite (D-G5-13 B). Aucun montant ici.
 * G5b-2 (Dankou, 20 novembre 2026) : un élève parti sans date de départ connue est « À vérifier » et reste compté, jamais
 * exclu d'office. La direction fixe sa date ou confirme qu'elle est introuvable, à tout moment (liste « À vérifier » de
 * cette page) ou pendant la vérification d'un comptage.
 * Précisions du 24 novembre 2026 : les élèves confirmés comme facturables se distinguent des élèves encore « À vérifier »
 * (comptés sous réserve) ; aucun élève parti n'est facturé définitivement sans contestation possible : sur un comptage
 * figé, un élève parti le jour du premier comptage qui le compte ou avant se conteste, comme une exclusion (décision,
 * avoir provisoire, 30 jours après le document de Cahiora). Un départ après ce jour ne se conteste pas.
 */

type Kind = 'TRIAL_END' | 'PILOT_END' | 'INITIAL' | 'FIRST_REGULARIZATION' | 'FINAL_REGULARIZATION';
type Basis = 'ACTIVE' | 'DEPARTURE_AUDIT' | 'DEPARTURE_UNKNOWN' | 'DEPARTURE_DIRECTION' | 'DEPARTURE_CONFIRMED' | 'EXCLUDED';
type Count = {
  id: string; yearLabel: string; kind: Kind; kindLabel: string; referenceDate: string; stage: 'PROVISIONAL' | 'FROZEN'; stageLabel: string;
  pupils: number; cumulative: number; toCheck: number; excluded: number; listHash: string; at: string; knownAt: string; reviewUntil: string | null;
  reviewOpen: boolean; frozen: boolean; timeZone: string; pendingRequests?: number;
};
type Item = {
  enrollmentId: string; matricule: string; name: string; className: string; siteName: string | null; counted: boolean; basis: Basis; basisLabel: string;
  departureDate: string | null; enrollmentStatus: string | null; cancelReason: string | null; duplicate: 'SAME' | 'PENDING' | null;
  /**
   * Exclusion ou contestation de départ (`contest`, avec la date du départ) demandée, ou validée et qui retire l'élève de
   * ce comptage ; lecture 3 (24 novembre 2026) : `returnedOn`, jour du retour de l'élève, compté de nouveau ensuite.
   */
  exclusion: { id: string; status: 'PENDING' | 'VALIDATED'; contest: boolean; departureDate: string | null; returnedOn: string | null } | null;
  canExclude: boolean; canDate: boolean; auditDay: string | null; stillCounted: boolean | null;
  /**
   * Élève parti (transféré ou retiré), compté dans un comptage figé : premier comptage qui le compte, date de sa sortie
   * enregistrée (sinon bornes d'une date à donner), et départ après ce comptage (aucune contestation).
   */
  contest: { firstCounted: string; exitDay: string | null; since: string | null; max: string; afterCount: boolean } | null;
  canContest: boolean;
  /** Dernier jour pour demander l'exclusion (null : aucune limite tant qu'aucun document ne compte l'élève). */
  exclusionUntil: string | null;
  /** Lecture 1 (24 novembre 2026) : délai de 30 jours passé, rouvert exceptionnellement par Cahiora jusqu'au `until`. */
  derogation: { until: string; grantedOn: string; documentDate: string } | null;
  /** Dernier document de Cahiora qui compte l'élève, et qui décide d'une exclusion (D-G5-13 B). */
  documentDate: string | null; decider: 'PLATFORM' | 'SCHOOL';
  /** G5b-2 : « À vérifier » (départ sans date connue, compté) ; la direction peut confirmer la date introuvable. */
  toCheck: boolean; canConfirm: boolean;
};
type Correction = {
  id: string; kind: 'EXCLUSION' | 'DEPARTURE_DATE' | 'DEPARTURE_CONFIRMED'; enrollmentId: string; matricule: string; name: string;
  /** Exclusion qui porte une date de départ : contestation d'un élève parti avant le comptage (24 novembre 2026). */
  contest: boolean;
  /** Demande faite après le délai de 30 jours, sous une dérogation de Cahiora (lecture 1). */
  derogation: boolean;
  /** null : date fixée ou confirmée introuvable hors de tout comptage (liste « À vérifier »). */
  countId: string | null; status: 'PENDING' | 'VALIDATED' | 'REFUSED';
  departureDate: string | null; justification: string; fileUrl: string | null; requestedByName: string; requestedAt: string;
  decidedByName: string | null; decidedAt: string | null; decisionNote: string | null;
  decidedByKind: 'school' | 'platform' | null; decider: 'PLATFORM' | 'SCHOOL' | null;
};
type Detail = { today: string; count: Count; items: Item[]; live: { pupils: number; added: Item[]; removed: number } | null; corrections: Correction[] };
/** G5b-2 : élève « À vérifier » (ou date confirmée introuvable) d'une année en cours ou à venir, hors de tout comptage. */
type CheckPupil = {
  enrollmentId: string; matricule: string; name: string; className: string; siteName: string | null; enrollmentStatus: string | null; basis: Basis; basisLabel: string;
  toCheck: boolean; since: string | null; auditDay: string | null; canDate: boolean; canConfirm: boolean;
};
type Checks = { today: string; note: string; years: { academicYearId: string; yearLabel: string; date: string; toCheck: number; pupils: CheckPupil[] }[] };
/** Élève dont on fixe la date de départ, ou confirme qu'elle est introuvable. */
type Departure = { enrollmentId: string; name: string; matricule: string; className: string; auditDay: string | null; since?: string | null };
const CHECKS_URL = '/settings/billing-counts/checks';
/** Lecture 1 (24 novembre 2026) : passé le délai, seul Cahiora peut le rouvrir, exceptionnellement. */
const LATE_TEXT = 'Seul Cahiora peut rouvrir ce délai, exceptionnellement, pour cet élève (dérogation motivée) : contactez Cahiora.';

const frDate = (d: string | null | undefined) => (d ? new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '—');
const pupils = (n: number) => `${n} élève${n > 1 ? 's' : ''}`;
const waiting = (n: number) => `${n} demande${n > 1 ? 's' : ''} d’exclusion ou de contestation en attente de décision.`;
const STATUS: Record<Correction['status'], [string, 'warn' | 'good' | 'bad']> = { PENDING: ['En attente de décision', 'warn'], VALIDATED: ['Validée', 'good'], REFUSED: ['Refusée', 'bad'] };
const correctionTitle = (k: Correction) => (k.kind === 'EXCLUSION'
  ? (k.contest ? `Contestation : départ le ${frDate(k.departureDate)}, avant le comptage` : 'Exclusion')
  : k.kind === 'DEPARTURE_DATE' ? `Date de départ : ${frDate(k.departureDate)}` : 'Date de départ introuvable, confirmée (élève compté)');
type Filter = 'all' | 'confirmed' | 'check' | 'departed' | 'cancelled' | 'excluded';
/** Justification d'une demande : 5 caractères au moins (contrôlé aussi par le serveur). */
const filled = (text: string) => text.trim().length >= 5;
/**
 * G5b-2 : dernière réponse validée de la direction pour un départ sans date (la liste d'un comptage reste telle
 * qu'enregistrée ; la réponse vaut pour la suite de la vérification et pour les comptages à venir).
 */
const answerOf = (d: Detail, i: Item) =>
  d.corrections.find((k) => k.enrollmentId === i.enrollmentId && k.status === 'VALIDATED' && (k.kind === 'DEPARTURE_DATE' || k.kind === 'DEPARTURE_CONFIRMED')) ?? null;
/**
 * Compté, puis retiré des élèves facturés par une exclusion ou une contestation validée (le comptage figé reste tel quel),
 * ou, pendant la vérification, qui ne serait plus compté si elle se terminait maintenant (exclusion validée, départ daté
 * avant le jour du comptage).
 */
const removed = (i: Item) => i.counted && (i.exclusion?.status === 'VALIDATED' || i.stillCounted === false);
/**
 * 24 novembre 2026 : encore « À vérifier », c'est-à-dire compté sous réserve : départ sans date sûre, sans réponse de la
 * direction qui le confirme (date introuvable confirmée, ou départ daté après le jour du comptage), ni décision.
 */
const stillToCheck = (d: Detail, i: Item) => {
  if (!i.toCheck || removed(i)) return false;
  const a = answerOf(d, i);
  return !(a?.kind === 'DEPARTURE_CONFIRMED' || (a?.kind === 'DEPARTURE_DATE' && !!a.departureDate && a.departureDate > d.count.referenceDate));
};
/** Confirmé comme facturable : compté, ni « À vérifier », ni retiré. */
const confirmed = (d: Detail, i: Item) => i.counted && !stillToCheck(d, i) && !removed(i);
const departed = (i: Item) => i.enrollmentStatus === 'TRANSFERRED' || i.enrollmentStatus === 'WITHDRAWN';

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
          <AVerifier />
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
                    <p className="text-[15px]"><b className="text-xl">{pupils(c.pupils)}</b> comptés : <b>{c.pupils - c.toCheck}</b> confirmés facturables{c.toCheck ? <>, <span className="font-bold text-warn">{c.toCheck} « À vérifier »</span> comptés sous réserve</> : null} · cumul de l’année : <b>{c.cumulative}</b>{c.excluded ? ` · ${c.excluded} exclu${c.excluded > 1 ? 's' : ''}` : ''}</p>
                    {c.reviewOpen && <p className="rounded-lg bg-warn-soft p-2 text-sm">Vérification ouverte jusqu’au <b>{frDate(c.reviewUntil)}</b> inclus.{c.pendingRequests ? ` ${waiting(c.pendingRequests)}` : ''}</p>}
                    {!c.reviewOpen && !!c.pendingRequests && <p className="rounded-lg bg-warn-soft p-2 text-sm">{waiting(c.pendingRequests)}</p>}
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

/**
 * G5b-2 : élèves « À vérifier » (départ enregistré sans date connue), à résoudre avant le comptage, période gratuite
 * comprise : la direction fixe la date ou confirme qu'elle est introuvable. Sans réponse, l'élève reste compté.
 */
function AVerifier() {
  const q = useApi<Checks>(CHECKS_URL);
  const [dialog, setDialog] = useState<{ kind: 'date' | 'confirm'; pupil: CheckPupil } | null>(null);
  const done = () => { setDialog(null); q.reload(); };
  const total = q.data?.years.reduce((n, y) => n + y.toCheck, 0) ?? 0;
  return (
    <Section title="Élèves « À vérifier »" action={total > 0 ? <Badge tone="warn">{total}</Badge> : undefined}>
      <Loader {...q}>
        {(d) => (
          <div className="grid gap-3">
            <p className="text-sm text-muted">{d.note}</p>
            {d.years.every((y) => y.pupils.length === 0) ? <p className="text-sm">Aucun élève à vérifier.</p> : d.years.filter((y) => y.pupils.length > 0).map((y) => (
              <div key={y.academicYearId} className="grid gap-2">
                <h3 className="font-bold">Année {y.yearLabel} <span className="text-sm font-normal text-muted">· {y.toCheck ? `${y.toCheck} à vérifier` : 'rien à vérifier'} au {frDate(y.date)}</span></h3>
                <ul className="grid gap-2" aria-label={`Élèves à vérifier, année ${y.yearLabel}`}>
                  {y.pupils.map((p) => (
                    <li key={p.enrollmentId} className="grid gap-1 rounded-lg bg-sunk p-3 text-sm">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <span className="min-w-0"><b className="text-[15px]">{p.name}</b> <span className="text-muted">· {p.matricule}</span><span className="block text-muted">{p.className}{p.siteName ? ` · ${p.siteName}` : ''}</span></span>
                        <Badge tone={p.toCheck ? 'warn' : 'info'}>{p.toCheck ? 'À vérifier' : 'Date introuvable confirmée'}</Badge>
                      </div>
                      <span>{p.basisLabel}{p.auditDay ? ` (journal : ${frDate(p.auditDay)})` : ''}</span>
                      <div className="flex flex-wrap gap-2 pt-1">
                        {p.canDate && <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'date', pupil: p })} aria-label={`Fixer la date de départ de ${p.name}`}>Fixer la date de départ</Button>}
                        {p.canConfirm && <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'confirm', pupil: p })} aria-label={`Date de départ introuvable pour ${p.name}`}>Date introuvable</Button>}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <Dialog open={!!dialog} onOpenChange={(o) => !o && setDialog(null)}>
              {dialog?.kind === 'date' && <DepartureDialog url={CHECKS_URL} item={dialog.pupil} today={d.today} done={done} outsideCount />}
              {dialog?.kind === 'confirm' && <ConfirmUnknownDialog url={CHECKS_URL} item={dialog.pupil} done={done} />}
            </Dialog>
          </div>
        )}
      </Loader>
    </Section>
  );
}

function Comptage({ id, back }: { id: string; back: () => void }) {
  const q = useApi<Detail>(`/settings/billing-counts/${id}`);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<{ kind: 'exclude' | 'date' | 'confirm' | 'contest'; item: Item } | { kind: 'decide'; correction: Correction } | null>(null);
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
                <Bilan d={d} />
                {d.count.reviewOpen && (
                  <p className="rounded-lg bg-warn-soft p-3 text-sm">Vérification ouverte jusqu’au <b>{frDate(d.count.reviewUntil)}</b> inclus. Vous pouvez demander l’exclusion d’une inscription annulée par erreur de saisie, ou dater un départ enregistré avant l’historique des inscriptions. Le comptage sera ensuite figé.</p>
                )}
                {d.count.stage === 'FROZEN' && (
                  <p className="rounded-lg bg-sunk p-3 text-sm">Comptage figé : il ne change plus et sert au calcul de votre abonnement Cahiora. Deux corrections restent possibles : exclure une inscription annulée par erreur de saisie, et <b>contester un élève parti avant le jour du comptage</b> (sortie enregistrée tard, ou départ sans date). Vous décidez tant qu’aucun document de Cahiora ne compte l’élève ; ensuite, la demande se fait au plus tard 30 jours après ce document et Cahiora décide. Acceptée, elle retire l’élève des élèves facturés et peut donner un avoir provisoire. Un départ après le jour du comptage ne se conteste pas : la présence à cette date reste due.</p>
                )}
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
        {dialog && q.data && dialog.kind === 'contest' && <ContestDialog count={q.data.count} item={dialog.item} done={done} />}
        {dialog && q.data && dialog.kind === 'date' && <DepartureDialog url={`/settings/billing-counts/${q.data.count.id}/corrections`} item={dialog.item} today={q.data.today} done={done} />}
        {dialog && q.data && dialog.kind === 'confirm' && <ConfirmUnknownDialog url={`/settings/billing-counts/${q.data.count.id}/corrections`} item={dialog.item} done={done} />}
        {dialog && dialog.kind === 'decide' && <DecisionDialog correction={dialog.correction} done={done} />}
      </Dialog>
    </div>
  );
}

/**
 * 24 novembre 2026 : bilan d'un comptage, les élèves confirmés comme facturables à part des élèves encore « À vérifier »
 * (comptés sous réserve, contestables s'ils sont partis avant le jour du comptage).
 */
function Bilan({ d }: { d: Detail }) {
  const n = (f: (i: Item) => boolean) => d.items.filter(f).length;
  const sure = n((i) => confirmed(d, i));
  const check = n((i) => stillToCheck(d, i));
  const out = n(removed);
  return (
    <div className="grid gap-2" role="group" aria-label="Bilan du comptage">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Facturables confirmés" value={sure} tone="good" detail="Inscrits à la date, ou départ confirmé après elle" />
        <Stat label="À vérifier" value={check} tone={check ? 'warn' : undefined} detail="Comptés sous réserve : départ sans date sûre" />
        <Stat label="Cumul de l’année" value={d.count.cumulative} detail="Élèves comptés au moins une fois" />
        <Stat label="Exclus ou retirés" value={d.count.excluded + out} detail="Exclusions et contestations acceptées" />
      </div>
      <p className="text-sm">
        Comptés le {frDate(d.count.referenceDate)} : <b>{pupils(d.count.pupils)}</b> = <b className="text-good">{sure} confirmé{sure > 1 ? 's' : ''}</b>
        {' + '}<b className={check ? 'text-warn' : undefined}>{check} « À vérifier »</b>{out ? ` + ${out} retiré${out > 1 ? 's' : ''} après décision` : ''}.
        {check > 0 && ' Un élève « À vérifier » est compté sous réserve : datez son départ ou confirmez la date introuvable ; parti avant le jour du comptage, il se conteste.'}
      </p>
    </div>
  );
}

function Liste({ d, filter, setFilter, search, setSearch, act }: {
  d: Detail; filter: Filter; setFilter: (f: Filter) => void; search: string; setSearch: (s: string) => void; act: (kind: 'exclude' | 'date' | 'confirm' | 'contest', item: Item) => void;
}) {
  const answer = (i: Item) => answerOf(d, i)?.kind ?? null;
  const matches = (i: Item, f: Filter) => f === 'all' || (f === 'confirmed' && confirmed(d, i)) || (f === 'check' && stillToCheck(d, i))
    || (f === 'departed' && departed(i)) || (f === 'cancelled' && i.enrollmentStatus === 'CANCELLED') || (f === 'excluded' && (!i.counted || removed(i)));
  const shown = useMemo(() => {
    const s = search.trim().toLowerCase();
    return d.items.filter((i) => matches(i, filter) && (!s || `${i.name} ${i.matricule} ${i.className} ${i.siteName ?? ''}`.toLowerCase().includes(s)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, filter, search]);
  const n = (f: Filter) => d.items.filter((i) => matches(i, f)).length;
  return (
    <Section title="Liste nominative">
      <div className="grid gap-3">
        <Chips label="Afficher" value={filter} onChange={setFilter} options={[
          { value: 'all', label: `Tous (${d.items.length})` }, { value: 'confirmed', label: `Facturables confirmés (${n('confirmed')})` },
          { value: 'check', label: `À vérifier (${n('check')})` }, { value: 'departed', label: `Partis (${n('departed')})` },
          { value: 'cancelled', label: `Inscriptions annulées (${n('cancelled')})` }, { value: 'excluded', label: `Exclus ou retirés (${n('excluded')})` },
        ]} />
        <label className="relative block">
          <span className="sr-only">Rechercher un élève</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <Input className="pl-9" placeholder="Nom, matricule, classe ou site" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        {shown.length === 0 ? <p className="text-sm text-muted">Aucun élève dans cette liste.</p> : (
          <ul className="grid gap-2" aria-label="Élèves du comptage">
            {shown.map((i) => {
              const check = stillToCheck(d, i);
              const what = i.exclusion?.contest ? 'Contestation acceptée' : 'Exclusion validée';
              return (
                <li key={i.enrollmentId} className={`grid gap-1 rounded-lg p-3 text-sm ${i.counted && !removed(i) ? 'bg-sunk' : 'border border-dashed border-line'}`}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span className="min-w-0"><b className="text-[15px]">{i.name}</b> <span className="text-muted">· {i.matricule}</span><span className="block text-muted">{i.className}{i.siteName ? ` · ${i.siteName}` : ''}</span></span>
                    <span className="flex flex-wrap gap-1">
                      {i.toCheck && answer(i) === 'DEPARTURE_CONFIRMED' && <Badge tone="info">Date introuvable confirmée</Badge>}
                      {!i.counted ? <Badge tone="info">Non compté</Badge>
                        : removed(i) ? <Badge tone="info">Retiré après décision</Badge>
                          : check ? <Badge tone="warn">À vérifier : compté sous réserve</Badge>
                            : <Badge tone="good">Facturable confirmé</Badge>}
                    </span>
                  </div>
                  <span>{i.basisLabel}{i.departureDate ? ` (${frDate(i.departureDate)})` : ''}</span>
                  {i.basis === 'DEPARTURE_UNKNOWN' && check && <span className="text-warn">Aucune date de départ connue : l’élève reste compté tant que vous ne fixez pas sa date ou ne confirmez pas qu’elle est introuvable. Il n’est jamais retiré sans votre décision.</span>}
                  {i.toCheck && answer(i) === 'DEPARTURE_CONFIRMED' && <span className="text-muted">Date de départ confirmée introuvable : l’élève reste compté. Vous pouvez encore dater son départ si vous la retrouvez.</span>}
                  {i.enrollmentStatus === 'CANCELLED' && <span className="text-muted">Inscription annulée depuis{i.cancelReason ? ` : « ${i.cancelReason} »` : ''}.</span>}
                  {i.duplicate && <span className="text-muted">{i.duplicate === 'SAME' ? 'Doublon confirmé par la direction (même élève).' : 'Doublon possible, pas encore tranché (Élèves › Doublons possibles).'}</span>}
                  {i.contest && !i.exclusion && <Depart i={i} />}
                  {i.exclusion && (
                    <span className="font-bold">{i.exclusion.status === 'PENDING'
                      ? `${i.exclusion.contest ? `Contestation demandée (départ le ${frDate(i.exclusion.departureDate)})` : 'Exclusion demandée'}, en attente ${i.decider === 'PLATFORM' ? 'de la décision de Cahiora' : 'de votre décision'}.`
                      : d.count.stage === 'FROZEN' && i.counted ? `${what} après le gel : retiré des élèves facturés ; le comptage figé reste tel quel.` : `${what}.`}</span>
                  )}
                  {i.exclusion?.returnedOn && (
                    <span className="text-muted">Revenu le {frDate(i.exclusion.returnedOn)} : il est compté de nouveau au premier comptage qui suit son retour, s’il est inscrit ce jour-là. L’année ne lui est jamais demandée deux fois : ce qui avait été demandé pour lui a été annulé.</span>
                  )}
                  {i.canExclude && d.count.stage === 'FROZEN' && (
                    <span className="text-muted">{i.derogation
                      ? `Délai rouvert exceptionnellement par Cahiora jusqu’au ${frDate(i.derogation.until)} inclus (dérogation du ${frDate(i.derogation.grantedOn)}) : une seule demande ; Cahiora décide.`
                      : i.exclusionUntil
                        ? `Exclusion possible jusqu’au ${frDate(i.exclusionUntil)} inclus, 30 jours après le document de Cahiora du ${frDate(i.documentDate)} : Cahiora décide.`
                        : 'Exclusion possible : aucun document de Cahiora ne compte encore cet élève, vous décidez.'}</span>
                  )}
                  {!i.canExclude && !i.exclusion && d.count.stage === 'FROZEN' && i.counted && i.enrollmentStatus === 'CANCELLED' && i.documentDate && (
                    <span className="text-muted">Délai d’exclusion passé : 30 jours après le document de Cahiora du {frDate(i.documentDate)}. {LATE_TEXT}</span>
                  )}
                  {i.stillCounted === false && i.counted && <span className="font-bold text-warn">Ne sera plus compté si la vérification se termine maintenant.</span>}
                  {(i.canExclude || i.canDate || i.canConfirm || i.canContest) && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      {i.canContest && <Button size="sm" variant="outline" onClick={() => act('contest', i)} aria-label={`Contester le comptage de ${i.name}`}>Contester : parti avant le comptage</Button>}
                      {i.canExclude && <Button size="sm" variant="outline" onClick={() => act('exclude', i)}>Demander l’exclusion</Button>}
                      {i.canDate && <Button size="sm" variant="outline" onClick={() => act('date', i)}>Dater le départ</Button>}
                      {i.canConfirm && <Button size="sm" variant="ghost" onClick={() => act('confirm', i)}>Date introuvable</Button>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Section>
  );
}

/** 24 novembre 2026 : élève parti, compté dans un comptage figé : contestable, ou départ après le comptage (présence due). */
function Depart({ i }: { i: Item }) {
  const c = i.contest!;
  if (c.afterCount) {
    return <span className="text-muted">Parti le {frDate(c.exitDay)}, après le comptage du {frDate(c.firstCounted)} qui le compte : sa présence à cette date reste due, ce départ ne se conteste pas.</span>;
  }
  const when = c.exitDay ? `Parti le ${frDate(c.exitDay)} (sortie enregistrée)` : 'Parti sans date enregistrée';
  if (!i.canContest) {
    return <span className="text-muted">{when}. Délai de contestation passé : 30 jours après le document de Cahiora du {frDate(i.documentDate)}. {LATE_TEXT}</span>;
  }
  return (
    <span className="text-[13.5px]">
      <b>{when}{c.exitDay ? `, avant la fin du jour du comptage du ${frDate(c.firstCounted)} qui le compte` : ''}</b> : vous pouvez contester son comptage
      {i.derogation
        ? ` jusqu’au ${frDate(i.derogation.until)} inclus : délai rouvert exceptionnellement par Cahiora (dérogation du ${frDate(i.derogation.grantedOn)}), une seule demande ; Cahiora décide.`
        : i.exclusionUntil ? ` jusqu’au ${frDate(i.exclusionUntil)} inclus (30 jours après le document de Cahiora du ${frDate(i.documentDate)}), Cahiora décide.` : '. Aucun document de Cahiora ne le compte encore : vous décidez.'}
      {!c.exitDay && ` Donnez la date du départ, justifiée, au plus tard le ${frDate(c.max)}.`}
    </span>
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
                  <span><b>{correctionTitle(k)}</b> · {k.name} <span className="text-muted">({k.matricule}){k.countId ? '' : ' · hors comptage'}</span></span>
                  <Badge tone={tone}>{k.status === 'PENDING' && k.decider === 'PLATFORM' ? 'Décision de Cahiora attendue' : label}</Badge>
                </div>
                <span>« {k.justification} »</span>
                {k.fileUrl && <a className="inline-flex items-center gap-1 font-bold text-brand underline" href={k.fileUrl} target="_blank" rel="noreferrer"><Paperclip className="size-4" /> Justificatif</a>}
                <span className="text-xs text-muted">Demandée le {dateTime(k.requestedAt)} par {k.requestedByName}{k.decidedAt && k.kind === 'EXCLUSION' ? ` · décision le ${dateTime(k.decidedAt)} par ${k.decidedByKind === 'platform' ? `Cahiora (${k.decidedByName})` : k.decidedByName}` : ''}</span>
                {k.decisionNote && <span className="text-xs">Motif de la décision : {k.decisionNote}</span>}
                {k.status === 'PENDING' && k.decider === 'PLATFORM' && <span className="text-xs">Cette inscription est déjà comptée dans un document de Cahiora : Cahiora décide ; {k.contest ? 'acceptée, la contestation' : 'validée, l’exclusion'} peut donner un avoir provisoire.</span>}
                {k.derogation && <span className="text-xs">Demande faite après le délai de 30 jours, sous la dérogation exceptionnelle accordée par Cahiora.</span>}
                {k.status === 'PENDING' && k.decider !== 'PLATFORM' && <div className="pt-1"><Button size="sm" onClick={() => decide(k)}>Décider</Button></div>}
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted">Une exclusion validée pendant la vérification vaut pour le comptage figé ensuite et pour les suivants ; une exclusion ou une contestation validée après le gel retire l’élève des élèves facturés, sans changer le comptage figé. Un élève revenu ensuite est compté de nouveau au premier comptage qui suit son retour, une seule fois dans l’année. Chaque demande et chaque décision sont datées et inscrites dans le journal.</p>
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
  const platform = item.decider === 'PLATFORM';
  return (
    <DialogContent title={`Exclure ${item.name} du comptage`} description="Seule une inscription annulée pour erreur de saisie (doublon, élève inscrit par erreur) peut être exclue. Un départ réel ne s’exclut jamais : l’élève compte jusqu’à son départ.">
      <form className="grid gap-3" onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData();
        fd.append('kind', 'EXCLUSION');
        fd.append('enrollmentId', item.enrollmentId);
        fd.append('justification', justification);
        if (file) fd.append('file', file);
        if (await run(() => api.post(`/settings/billing-counts/${count.id}/corrections`, fd), toast,
          platform ? 'Demande d’exclusion envoyée : Cahiora décide' : 'Demande d’exclusion enregistrée : elle attend votre décision')) done();
      }}>
        <p className="rounded-lg bg-sunk p-2 text-sm">{item.matricule} · {item.className}{item.cancelReason ? ` · annulée : « ${item.cancelReason} »` : ''}</p>
        <Field label="Justification" hint="5 caractères au moins : pourquoi cette inscription était une erreur de saisie.">
          <Textarea value={justification} onChange={(e) => setJustification(e.target.value)} required minLength={5} maxLength={500} />
        </Field>
        <FileField file={file} setFile={setFile} />
        {item.exclusionUntil && count.stage === 'FROZEN' && <p className="text-sm">Demande possible jusqu’au <b>{frDate(item.exclusionUntil)}</b> inclus.</p>}
        <Button type="submit" loading={busy} disabled={!filled(justification)}>Demander l’exclusion</Button>
        <Missing items={[!filled(justification) && 'la justification (5 caractères au moins)']} />
        <p className="text-xs text-muted">{platform
          ? `La demande est datée et inscrite au journal. Cet élève est compté dans le document de Cahiora du ${frDate(item.documentDate)} : Cahiora la valide ou la refuse ; validée, elle peut donner un avoir provisoire.`
          : 'La demande est datée et inscrite au journal ; la direction la valide ou la refuse ensuite dans « Demandes de correction ».'}</p>
      </form>
    </DialogContent>
  );
}

/**
 * 24 novembre 2026 : contestation d'un élève parti le jour du premier comptage figé qui le compte ou avant. Même
 * démarche qu'une exclusion : la direction décide tant qu'aucun document de Cahiora ne le compte, Cahiora ensuite.
 */
function ContestDialog({ count, item, done }: { count: Count; item: Item; done: () => void }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const c = item.contest!;
  const [day, setDay] = useState(c.exitDay ?? '');
  const [justification, setJustification] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const platform = item.decider === 'PLATFORM';
  const missing = [!day && 'la date du départ', !filled(justification) && 'la justification (5 caractères au moins)'];
  return (
    <DialogContent title={`Contester le comptage de ${item.name}`}
      description={`Départ avant la fin du ${frDate(c.firstCounted)}, jour du premier comptage qui compte l’élève : il n’aurait pas dû être compté. Acceptée, la contestation le retire des élèves facturés de l’année et peut donner un avoir provisoire.`}>
      <form className="grid gap-3" onSubmit={async (e) => {
        e.preventDefault();
        if (!day || !filled(justification)) return;
        const fd = new FormData();
        fd.append('kind', 'DEPARTURE_CONTEST');
        fd.append('enrollmentId', item.enrollmentId);
        fd.append('departureDate', day);
        fd.append('justification', justification);
        if (file) fd.append('file', file);
        if (await run(() => api.post(`/settings/billing-counts/${count.id}/corrections`, fd), toast,
          platform ? 'Contestation envoyée : Cahiora décide' : 'Contestation enregistrée : elle attend votre décision')) done();
      }}>
        <p className="rounded-lg bg-sunk p-2 text-sm">{item.matricule} · {item.className} · sortie : {item.enrollmentStatus === 'TRANSFERRED' ? 'transfert' : 'départ'}</p>
        {c.exitDay ? (
          <p className="text-sm">Date du départ : <b>{frDate(c.exitDay)}</b>, celle de la sortie enregistrée.</p>
        ) : (
          <Field label="Date du départ" hint={`Départ enregistré sans date : ${c.since ? `entre le ${frDate(c.since)} et le ${frDate(c.max)}` : `au plus tard le ${frDate(c.max)}`}. Le jour du départ n’est plus un jour de présence.`}>
            <Input type="date" value={day} min={c.since ?? undefined} max={c.max} onChange={(e) => setDay(e.target.value)} required />
          </Field>
        )}
        <Field label="Justification" hint="5 caractères au moins : ce qui établit le départ avant le comptage (registre, courrier des parents, certificat de radiation).">
          <Textarea value={justification} onChange={(e) => setJustification(e.target.value)} required minLength={5} maxLength={500} />
        </Field>
        <FileField file={file} setFile={setFile} />
        {item.exclusionUntil && <p className="text-sm">Contestation possible jusqu’au <b>{frDate(item.exclusionUntil)}</b> inclus.</p>}
        <Button type="submit" loading={busy} disabled={!day || !filled(justification)}>Envoyer la contestation</Button>
        <Missing items={missing} />
        <p className="text-xs text-muted">{platform
          ? `La contestation est datée et inscrite au journal. Cet élève est compté dans le document de Cahiora du ${frDate(item.documentDate)} : Cahiora l’accepte ou la refuse ; acceptée, elle peut donner un avoir provisoire.`
          : 'La contestation est datée et inscrite au journal ; la direction l’accepte ou la refuse ensuite dans « Demandes de correction ».'}</p>
      </form>
    </DialogContent>
  );
}

/** Date d'un départ fixée par la direction : pendant la vérification d'un comptage (`url` du comptage) ou hors comptage (G5b-2). */
function DepartureDialog({ url, item, today, done, outsideCount = false }: { url: string; item: Departure; today: string; done: () => void; outsideCount?: boolean }) {
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
        if (await run(() => api.post(url, fd), toast, 'Date de départ enregistrée')) done();
      }}>
        <Field label="Date du départ" hint={`${item.since ? `Entre le ${frDate(item.since)} et le ${frDate(max)}` : `Au plus tard le ${frDate(max)}`}. Le jour du départ n’est plus un jour de présence.`}>
          <Input type="date" value={day} min={item.since ?? undefined} max={max} onChange={(e) => setDay(e.target.value)} required />
        </Field>
        <Field label="Justification" hint="5 caractères au moins : d’où vient cette date.">
          <Textarea value={justification} onChange={(e) => setJustification(e.target.value)} required minLength={5} maxLength={500} />
        </Field>
        <FileField file={file} setFile={setFile} />
        <Button type="submit" loading={busy} disabled={!day || !filled(justification)}>Enregistrer la date</Button>
        <Missing items={[!day && 'la date du départ', !filled(justification) && 'la justification (5 caractères au moins)']} />
        <p className="text-xs text-muted">{outsideCount
          ? 'La date vaut pour les comptages à venir ; un comptage déjà figé ne change pas. Elle est datée et inscrite au journal.'
          : 'La date vaut aussitôt pour la suite de la vérification ; elle est datée et inscrite au journal.'}</p>
      </form>
    </DialogContent>
  );
}

/** G5b-2 : la direction confirme que la date de départ est introuvable ; l'élève reste compté, sans être « À vérifier ». */
function ConfirmUnknownDialog({ url, item, done }: { url: string; item: Departure; done: () => void }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const [justification, setJustification] = useState('');
  const [file, setFile] = useState<File | null>(null);
  return (
    <DialogContent title={`Date de départ introuvable : ${item.name}`} description="Vous confirmez qu’aucune date de départ ne peut être retrouvée. L’élève reste compté, comme sans réponse, mais n’est plus « À vérifier ». Vous pourrez encore fixer sa date si vous la retrouvez.">
      <form className="grid gap-3" onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData();
        fd.append('kind', 'DEPARTURE_CONFIRMED');
        fd.append('enrollmentId', item.enrollmentId);
        fd.append('justification', justification);
        if (file) fd.append('file', file);
        if (await run(() => api.post(url, fd), toast, 'Date introuvable confirmée : l’élève reste compté')) done();
      }}>
        <p className="rounded-lg bg-sunk p-2 text-sm">{item.matricule} · {item.className}</p>
        <Field label="Justification" hint="5 caractères au moins : ce qui a été cherché (registre, dossier, parents).">
          <Textarea value={justification} onChange={(e) => setJustification(e.target.value)} required minLength={5} maxLength={500} />
        </Field>
        <FileField file={file} setFile={setFile} />
        <Button type="submit" loading={busy} disabled={!filled(justification)}>Confirmer : date introuvable</Button>
        <Missing items={[!filled(justification) && 'la justification (5 caractères au moins)']} />
        <p className="text-xs text-muted">La confirmation est datée et inscrite au journal.</p>
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
    const what = correction.contest ? 'Contestation' : 'Exclusion';
    const ok = await run(() => api.post(`/settings/billing-counts/corrections/${correction.id}/decision`, { decision, note: note.trim() || undefined }), toast,
      decision === 'VALIDATED' ? `${what} ${correction.contest ? 'acceptée' : 'validée'}` : `${what} refusée`);
    if (ok) done();
  };
  return (
    <DialogContent title={correction.contest ? `Contestation pour ${correction.name}` : `Exclusion de ${correction.name}`}
      description={`Demandée le ${dateTime(correction.requestedAt)} par ${correction.requestedByName}.${correction.contest ? ` Départ le ${frDate(correction.departureDate)}, avant le comptage qui compte l’élève.` : ''}`}>
      <div className="grid gap-3">
        <p className="rounded-lg bg-sunk p-2 text-sm">« {correction.justification} »</p>
        {correction.fileUrl && <a className="inline-flex items-center gap-1 text-sm font-bold text-brand underline" href={correction.fileUrl} target="_blank" rel="noreferrer"><Paperclip className="size-4" /> Voir le justificatif</a>}
        <Field label="Motif de la décision" hint="Obligatoire pour un refus.">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </Field>
        <ErrorNote error={error} />
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => send('VALIDATED')} loading={busy}>{correction.contest ? 'Accepter la contestation' : 'Valider l’exclusion'}</Button>
          <Button variant="outline" onClick={() => send('REFUSED')} disabled={busy || !filled(note)}>Refuser</Button>
        </div>
        <Missing items={[!filled(note) && 'pour refuser, le motif de la décision (5 caractères au moins)']} />
        <p className="text-xs text-muted">La décision est définitive, datée et inscrite au journal.</p>
      </div>
    </DialogContent>
  );
}
