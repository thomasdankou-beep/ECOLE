'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { CalendarClock, CheckCircle2, FileText, Printer, Send, Wallet } from 'lucide-react';
import { Loader, Section } from '@/components/espace/bits';
import { Badge, Button, Empty, ErrorNote, Field, Input, Textarea, useToast } from '@/components/ui';
import { accessChanged, accessCounter, LIMITED_KEEPS, LIMITED_WILL_KEEP, type AccessPhase } from '@/lib/access';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/use-api';

/**
 * Abonnement Cahiora vu par la direction (lot G5a) : état, période gratuite, tarif en vigueur, calendrier de facturation,
 * historique, et acceptation des conditions commerciales à la fin de l'essai ou du pilote ; documents provisoires de
 * Cahiora (lot G5c), jamais une facture fiscale, pour une école indépendante (D-G5-19) ; accès selon le paiement et
 * « Régulariser mon abonnement » (lot G5d-1, D-G5-30 A) : montant demandé, échéance, état du paiement, moyens de
 * paiement activés et demande de régularisation à Cahiora. Lot G5d-2 : état du paiement de chaque document, reçus
 * provisoires à imprimer (sans valeur fiscale), crédit de l'établissement et demande de remboursement ; les moyens de
 * paiement n'apparaissent qu'une fois activés par Cahiora. Aucun paiement en ligne ici : Cahiora enregistre ce qu'il reçoit.
 * Ajustements du 20 novembre 2026 : un établissement de test le lit en tête de page (rien ne lui est facturé ni limité) ;
 * un document à payer sans échéance porte « Échéance à fixer » (G5c-1) ; une demande de remboursement reste possible
 * pendant l'accès limité, dès que Cahiora ouvre les remboursements (G5d2-7).
 */

type Status = 'TRIAL' | 'PILOT' | 'AWAITING_ACCEPTANCE' | 'AWAITING_PAYMENT' | 'ACTIVE' | 'LIMITED';
type Data = {
  today: string; currency: string;
  /** Établissement de test (ajustements du 20 novembre 2026) : jamais facturé ni limité ; testNotice le dit à la direction. */
  commercialStatus: 'TEST' | 'CLIENT'; testNotice: string | null;
  tariff: { pricePerPupil: number | null; minimum: number | null };
  subscription: {
    status: Status; statusLabel: string; statusSince: string; trialStart: string | null; trialEnd: string | null; trialDays: number | null;
    pilotStart: string | null; pilotEnd: string | null; pilotMonths: number | null; freeDaysLeft: number | null;
    acceptedAt: string | null; acceptedByName: string | null; acceptedTermsVersion: number | null;
    acceptedTariff: { currency: string; pricePerPupil: number; minimum: number; day: string } | null;
  } | null;
  terms: { id: string; version: number; title: string; body: string; effectiveFrom: string } | null;
  calendars: { yearLabel: string; version: number; startDate: string; endDate: string; preparationFrom: string | null; initialCountDate: string; firstRegularizationDate: string; finalRegularizationDate: string; renewalDate: string | null; formula: string }[];
  history: { kind: string; label: string; actorName: string; createdAt: string }[];
  access: Access | null;
  requests: RegularizationRequest[];
  regularization: Regularization | null;
};
/** Accès selon le paiement (lot G5d-1), calculé par l'API au jour de l'établissement. */
type Access = {
  today: string; status: Status; statusLabel: string; phase: AccessPhase; until: string | null; daysLeft: number | null; limitedFrom: string | null;
  limitedAt: string | null; limitedAtLabel: string | null; hoursLeft: number | null;
  graceStart: string | null; graceEnd: string | null; extendedUntil: string | null; limitedSince: string | null; termsAccepted: boolean; pendingRequest: boolean; paymentMeansActive: boolean;
};
type RegularizationRequest = { id: string; status: 'PENDING' | 'ANSWERED'; message: string | null; requestedByName: string; requestedAt: string; answeredAt: string | null; answer: string | null };
/** État du paiement d'un document (lot G5d-2) : avoirs, paiements et crédits imputés. */
type DocPayment = { status: 'NOTHING_DUE' | 'PENDING' | 'PARTIAL' | 'PAID' | 'CANCELLED'; label: string; overdue: boolean; due: number; paid: number; balance: number };
type CahioraReceipt = {
  id: string; receiptNumber: string; documentReference: string; currency: string; amount: number; paidOn: string; meansName: string; transactionRef: string;
  creditAmount: number; recordedAt: string; cancelled: boolean; statusLabel: string; allocations: { reference: string; amount: number }[];
};
type CreditEntry = { id: string; kind: string; label: string; amount: number; createdAt: string; receiptNumber: string | null; documentReference: string | null };
type Refund = {
  id: string; amount: number; currency: string; status: 'PENDING' | 'REFUNDED' | 'REFUSED'; statusLabel: string; message: string | null; requestedByName: string; requestedAt: string;
  decidedAt: string | null; decisionNote: string | null; refundedOn: string | null; refundMeans: string | null; refundRef: string | null;
};
type Regularization = {
  currency: string; groupPending: string | null; documents: number; requested: number | null; mention: string; payment: string;
  /** Lot G5d-2 : payé et reste à payer sur les documents de l'abonnement (null : rien à montrer). */
  paid: number | null; balance: number | null;
  /** Échéance la plus proche des documents à payer (celle du premier document, lot G5c) ; dueDatePending : un document à payer n'en a pas encore. */
  dueDate: string | null; dueDatePending: boolean;
  /** G5c-1 : ce que dit un document à payer sans échéance (délai proposé, en attente des conditions commerciales). */
  dueDateNote: string | null;
  /** Documents d'abonnement et avoirs pris en compte, dans l'ordre d'émission ; un avoir est en négatif. */
  lines: { kind: 'SUBSCRIPTION' | 'CREDIT_NOTE'; label: string; reference: string; yearLabel: string | null; issueDate: string; dueDate: string | null; amount: number; relatedReference: string | null; payment: DocPayment | null }[];
  /** Moyens activés par Cahiora pour l'établissement, avec leurs coordonnées ; aucun tant que le verrou du serveur est fermé. */
  paymentMeans: { code: string; name: string; instructions: string }[]; paymentMeansNote: string;
  paymentsOpen: boolean; receiptMention: string; receipts: CahioraReceipt[];
  credit: { balance: number; reserved: number; available: number; entries: CreditEntry[] } | null;
  refunds: Refund[]; refundOpen: boolean; refundNote: string | null;
};
type DocKind = 'SUBSCRIPTION' | 'CREDIT_NOTE' | 'SERVICE_QUOTE' | 'SERVICE_PROFORMA';
type DocLine = {
  id: string; position: number; label: string; amount: number; countKind: string | null; referenceDate: string | null; pupils: number | null; pupilsChange: number | null;
  pricePerPupil: number | null; minimum: number | null; minimumApplied: boolean | null; shareMonths: number | null; shareOf: number | null; yearAmount: number | null;
  alreadyBilled: number | null; serviceName: string | null; quantity: number | null; unitPrice: number | null;
};
type Doc = {
  id: string; kind: DocKind; label: string; reference: string; currency: string; issueDate: string; dueDate: string | null; total: number; yearLabel: string | null;
  relatedDocumentId: string | null; data: Record<string, unknown> | null; lines: DocLine[];
};
type Docs = { mention: string; groupPending: string | null; documents: Doc[] };

const TONE: Record<Status, 'info' | 'good' | 'warn' | 'bad' | 'accent'> = {
  TRIAL: 'info', PILOT: 'accent', AWAITING_ACCEPTANCE: 'warn', AWAITING_PAYMENT: 'warn', ACTIVE: 'good', LIMITED: 'bad',
};
const frDate = (d: string | null | undefined) => (d ? new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '—');
const money = (n: number, currency: string) => `${new Intl.NumberFormat('fr-FR').format(n).replace(/[  ]/g, ' ')} ${currency === 'XOF' || currency === 'XAF' ? 'FCFA' : currency}`;
const daysText = (n: number) => `${n} jour${n > 1 ? 's' : ''}`;
const pupilsText = (n: number) => `${n} élève${n > 1 ? 's' : ''}`;
const KIND_TONE: Record<DocKind, 'info' | 'good' | 'accent' | 'warn'> = { SUBSCRIPTION: 'info', CREDIT_NOTE: 'good', SERVICE_QUOTE: 'accent', SERVICE_PROFORMA: 'warn' };
const PAY_TONE: Record<DocPayment['status'], 'info' | 'good' | 'warn' | 'accent'> = { NOTHING_DUE: 'info', PENDING: 'warn', PARTIAL: 'accent', PAID: 'good', CANCELLED: 'info' };
const dateTime = (d: string | null) => (d ? new Date(d).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' }) : '—');

/** Abonnement à régulariser : en attente d'acceptation ou de paiement, ou en accès limité (D-G5-30 A). */
const toRegularize = (s: Data['subscription']) => !!s && (s.status === 'AWAITING_ACCEPTANCE' || s.status === 'AWAITING_PAYMENT' || s.status === 'LIMITED');
/** Conditions à accepter : à la fin de la gratuité, ou pendant un accès limité posé avant l'acceptation (lot G5d-1). */
const awaitsAcceptance = (s: Data['subscription']) => !!s && (s.status === 'AWAITING_ACCEPTANCE' || (s.status === 'LIMITED' && !s.acceptedAt));

export function Abonnement({ openCounts }: { openCounts?: () => void }) {
  const q = useApi<Data>('/settings/subscription');
  return (
    <Loader {...q}>
      {(d) => (
        <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
          <div className="grid content-start gap-4">
            {d.testNotice && <p className="rounded-lg bg-sunk p-3 text-sm font-bold" role="status" data-testid="etablissement-de-test">{d.testNotice}</p>}
            <Etat d={d} />
            {toRegularize(d.subscription) && <Regulariser d={d} reload={q.reload} />}
            {awaitsAcceptance(d.subscription) && <Acceptation d={d} reload={q.reload} />}
            {d.regularization && !d.regularization.groupPending && <PaiementsCahiora d={d} reload={q.reload} />}
            <Documents />
          </div>
          <div className="grid content-start gap-4">
            <Tarif d={d} />
            <Calendrier d={d} openCounts={openCounts} />
            <Historique d={d} />
          </div>
        </div>
      )}
    </Loader>
  );
}

function Etat({ d }: { d: Data }) {
  const s = d.subscription;
  if (!s) {
    return (
      <Section title="Votre abonnement Cahiora">
        {d.commercialStatus === 'TEST'
          ? <Empty title="Établissement de test">Aucun abonnement : rien n’est facturé et l’accès n’est jamais limité.</Empty>
          : <Empty title="Aucun abonnement ouvert">Cahiora ouvre l’abonnement de votre établissement avec vous : essai gratuit ou statut d’école pilote partenaire.</Empty>}
      </Section>
    );
  }
  return (
    <Section title="Votre abonnement Cahiora">
      <div className="grid gap-2 text-[15px]">
        {/* État sous le titre, pas à côté : sur téléphone, un long libellé écrasait le titre. */}
        <div><Badge tone={TONE[s.status]}>{s.statusLabel}</Badge></div>
        {s.status === 'TRIAL' && (
          <>
            <p>Essai gratuit du <b>{frDate(s.trialStart)}</b> au <b>{frDate(s.trialEnd)}</b>{s.freeDaysLeft !== null && <> : encore <b>{daysText(s.freeDaysLeft)}</b></>}.</p>
            <p className="text-sm text-muted">À la fin de l’essai, vous lirez et accepterez ici les conditions commerciales ; Cahiora préparera ensuite votre demande de paiement. Vos données sont conservées.</p>
          </>
        )}
        {s.status === 'PILOT' && (
          <>
            <p>École pilote partenaire CAHIORA : gratuité du <b>{frDate(s.pilotStart)}</b> au <b>{frDate(s.pilotEnd)}</b>{s.freeDaysLeft !== null && <> : encore <b>{daysText(s.freeDaysLeft)}</b></>}.</p>
            <p className="text-sm text-muted">Rien n’est facturé pour la période pilote. Ensuite, vous lirez et accepterez ici les conditions commerciales ; vos données sont conservées.</p>
          </>
        )}
        {s.status === 'AWAITING_ACCEPTANCE' && (
          <p>Votre période gratuite est terminée{s.pilotEnd ? ` (dernier jour : ${frDate(s.pilotEnd)})` : s.trialEnd ? ` (dernier jour : ${frDate(s.trialEnd)})` : ''}. Pour continuer, lisez et acceptez les conditions commerciales. Vos données sont conservées.</p>
        )}
        {(s.status === 'AWAITING_ACCEPTANCE' || s.status === 'AWAITING_PAYMENT') && d.access && <AccessLine a={d.access} />}
        {s.status === 'AWAITING_PAYMENT' && (
          <>
            <p className="flex items-start gap-2"><CheckCircle2 className="mt-0.5 size-5 flex-none text-good" /> <span>Conditions commerciales acceptées le <b>{s.acceptedAt ? new Date(s.acceptedAt).toLocaleDateString('fr-FR') : '—'}</b> par {s.acceptedByName}{s.acceptedTermsVersion ? ` (version ${s.acceptedTermsVersion})` : ''}.</span></p>
            <p className="text-sm text-muted">Prochaine étape : Cahiora prépare votre demande de paiement.</p>
          </>
        )}
        {s.status === 'ACTIVE' && <p>{s.statusLabel} depuis le {new Date(s.statusSince).toLocaleDateString('fr-FR')}.</p>}
        {s.status === 'LIMITED' && (
          <>
            <p>Accès limité depuis le <b>{new Date(d.access?.limitedSince ?? s.statusSince).toLocaleDateString('fr-FR')}</b> : l’abonnement n’est pas régularisé. {LIMITED_KEEPS.charAt(0).toUpperCase()}{LIMITED_KEEPS.slice(1)}.</p>
            <p className="text-sm text-muted">L’accès complet revient avec le paiement validé par Cahiora, ou avec une prolongation accordée par Cahiora.</p>
          </>
        )}
      </div>
    </Section>
  );
}

function Acceptation({ d, reload }: { d: Data; reload: () => void }) {
  const toast = useToast();
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const t = d.terms;
  if (!t) {
    return (
      <Section title="Conditions commerciales">
        <p className="rounded-lg bg-warn-soft p-3 text-sm">Les conditions commerciales de Cahiora ne sont pas encore disponibles. Revenez sur cette page ou contactez Cahiora.</p>
      </Section>
    );
  }
  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ status: Status }>('/settings/subscription/accept', { termsId: t!.id, accepted: true });
      toast(r.status === 'LIMITED' ? 'Conditions acceptées : l’accès reste limité jusqu’au paiement validé par Cahiora' : 'Conditions acceptées : Cahiora prépare votre demande de paiement');
      accessChanged();
      reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section title="Conditions commerciales">
      <div className="grid scroll-mt-24 gap-3" id="conditions">
        <p className="text-sm text-muted">Version {t.version}, en vigueur depuis le {frDate(t.effectiveFrom)}.</p>
        <h3 className="font-bold">{t.title}</h3>
        <div className="max-h-[45vh] overflow-y-auto whitespace-pre-wrap rounded-lg border border-line bg-sunk p-3 text-sm" tabIndex={0} aria-label="Texte des conditions commerciales">{t.body}</div>
        <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-line p-3">
          <input type="checkbox" className="mt-1 size-5 flex-none accent-[var(--brand)]" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          <span>J’ai lu et j’accepte les conditions commerciales de Cahiora (version {t.version}) au nom de l’établissement.</span>
        </label>
        <ErrorNote error={error} />
        <Button onClick={accept} disabled={!checked} loading={busy}>Accepter les conditions</Button>
        <p className="text-xs text-muted">Le tarif du jour est figé dans votre abonnement à l’acceptation. Votre nom, la date et l’heure sont inscrits dans l’historique.</p>
      </div>
    </Section>
  );
}

/** Délai d'accès complet en cours ou passé, sous l'état de l'abonnement (lot G5d-1). */
function AccessLine({ a }: { a: Access }) {
  const pending = a.pendingRequest ? 'Votre demande de régularisation attend la réponse de Cahiora : tant qu’elle attend, l’accès ne sera pas limité.' : null;
  const text = accessCounter(a);
  const counter = text && (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-warn-soft px-2.5 py-0.5 text-sm font-extrabold text-warn"><CalendarClock className="size-4" aria-hidden /> {text}</span>
  );
  if (a.phase === 'NOTICE') {
    return (
      <div className="grid gap-1 rounded-lg border border-line p-3">
        <p>Préavis après la réponse de Cahiora : accès complet jusqu’au <b>{a.limitedAtLabel}</b>.</p>
        <div>{counter}</div>
        <p className="text-sm text-muted">{pending ?? `Sans paiement validé, l’accès sera limité à partir de cette heure : ${LIMITED_WILL_KEEP}.`}</p>
      </div>
    );
  }
  if (a.phase === 'GRACE' || a.phase === 'EXTENDED') {
    return (
      <div className="grid gap-1 rounded-lg border border-line p-3">
        <p>{a.phase === 'GRACE' ? <>Délai de grâce en accès complet du <b>{frDate(a.graceStart)}</b> au <b>{frDate(a.until)}</b> inclus.</> : <>Accès complet prolongé par Cahiora jusqu’au <b>{frDate(a.until)}</b> inclus.</>}</p>
        <div>{counter}</div>
        <p className="text-sm text-muted">{pending ?? `Sans paiement validé, l’accès sera limité à partir du ${frDate(a.limitedFrom)} : ${LIMITED_WILL_KEEP}.`}</p>
      </div>
    );
  }
  if (a.phase === 'HELD') return <p className="rounded-lg border border-line p-3">Le délai d’accès complet est passé. Votre demande de régularisation attend la réponse de Cahiora : tant qu’elle attend, l’accès n’est pas limité.</p>;
  if (a.phase === 'DUE') return <p className="rounded-lg bg-bad-soft p-3 font-bold text-bad">Le délai d’accès complet est passé sans paiement validé : l’accès va être limité.</p>;
  return null;
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 rounded-lg bg-sunk p-3">
      <dt className="text-xs font-bold uppercase tracking-wider text-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/**
 * « Régulariser mon abonnement » (D-G5-30 A) : montant demandé par les documents provisoires de Cahiora, échéance, état
 * du paiement et moyens de paiement activés ; tant qu'aucun ne l'est, une demande de régularisation à Cahiora, datée,
 * qui retient la limitation automatique tant qu'elle attend sa réponse (D-G5-42 A). Les réponses de Cahiora restent ici.
 */
function Regulariser({ d, reload }: { d: Data; reload: () => void }) {
  const auth = useAuth();
  const toast = useToast();
  const ref = useRef<HTMLDivElement>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (window.location.hash === '#regulariser') ref.current?.scrollIntoView({ block: 'start' });
  }, []);
  const r = d.regularization;
  const a = d.access;
  if (!r || !a) return null;
  const pending = d.requests.find((x) => x.status === 'PENDING') ?? null;
  const can = !!auth.me?.access?.canRegularize;
  const limited = a.phase === 'LIMITED';
  async function send() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/settings/subscription/regularization-requests', { message: message.trim() || undefined });
      toast('Demande de régularisation envoyée à Cahiora');
      setMessage('');
      accessChanged();
      reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div id="regulariser" ref={ref} className="scroll-mt-20">
      <Section title="Régulariser mon abonnement">
        <div className="grid gap-3 text-[15px]">
          {!a.termsAccepted && (d.terms ? (
            <p className="rounded-lg bg-warn-soft p-3 text-sm"><b>Première étape :</b> lisez et acceptez les conditions commerciales, <a href="#conditions" className="font-bold text-brand underline">plus bas sur cette page</a>. Le tarif du jour est alors figé ; Cahiora prépare ensuite votre demande de paiement.</p>
          ) : (
            <p className="rounded-lg bg-warn-soft p-3 text-sm"><b>Première étape :</b> accepter les conditions commerciales de Cahiora, dès qu’elles seront publiées sur cette page. En attendant, vous pouvez envoyer une demande de régularisation.</p>
          ))}
          <dl className="grid gap-2 sm:grid-cols-2">
            <Item label="Montant demandé">
              {r.groupPending ? <span className="text-sm">{r.groupPending}</span> : r.requested !== null ? (
                <>
                  <b className="text-lg">{money(r.requested, r.currency)}</b>
                  <span className="block text-xs text-muted">D’après {r.documents > 1 ? `les ${r.documents} documents provisoires` : 'le document provisoire'} de Cahiora, avoirs déduits. {r.mention}</span>
                </>
              ) : <span className="text-sm">{a.termsAccepted ? 'Pas encore indiqué : Cahiora prépare votre document à partir du comptage de vos élèves.' : 'Indiqué après l’acceptation des conditions et le comptage de vos élèves.'}</span>}
            </Item>
            <Item label="Échéance">
              {r.dueDate ? (
                <>
                  <b>{frDate(r.dueDate)}</b>{r.dueDate < d.today ? <span className="text-sm text-bad"> (passée)</span> : null}
                  {r.dueDatePending && <span className="block text-xs text-muted">Celle du premier document. D’autres documents à payer n’ont pas encore d’échéance : {r.dueDateNote ? r.dueDateNote.charAt(0).toLowerCase() + r.dueDateNote.slice(1) : 'Cahiora la fixera'}.</span>}
                </>
              ) : <span className="text-sm">{r.dueDatePending ? (r.dueDateNote ?? 'À fixer par Cahiora') : 'Pas encore fixée'}</span>}
            </Item>
            <Item label="État du paiement"><span className="text-sm">{r.payment}</span></Item>
            <Item label="Moyens de paiement">
              {r.paymentMeans.length ? (
                <>
                  <span className="block text-xs text-muted">{r.paymentMeansNote}</span>
                  <ul className="mt-1 grid gap-1.5 text-sm" aria-label="Moyens de paiement activés par Cahiora">
                    {r.paymentMeans.map((m) => <li key={m.code}><b>{m.name}</b><span className="block whitespace-pre-wrap">{m.instructions}</span></li>)}
                  </ul>
                </>
              ) : <span className="text-sm">{r.paymentMeansNote}</span>}
            </Item>
          </dl>
          {r.lines.length > 0 && (
            <details className="rounded-lg border border-line p-3 text-sm">
              <summary className="cursor-pointer font-bold">Détail des documents provisoires ({r.lines.length})</summary>
              <ul className="mt-2 grid gap-1.5" aria-label="Documents provisoires pris en compte">
                {r.lines.map((l) => (
                  <li key={l.reference} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-t border-line pt-1.5 first:border-0 first:pt-0">
                    <span className="min-w-0">
                      <b>{l.label}</b> <span className="tabular text-muted">{l.reference}</span>
                      <span className="block text-xs text-muted">
                        Du {frDate(l.issueDate)}{l.kind === 'CREDIT_NOTE' ? (l.relatedReference ? `, sur le document ${l.relatedReference}` : '') : l.amount > 0 ? (l.dueDate ? `, échéance le ${frDate(l.dueDate)}` : ', échéance à fixer par Cahiora') : ''}
                      </span>
                    </span>
                    <span className="text-right">
                      <b className="tabular">{l.amount < 0 ? `− ${money(-l.amount, r.currency)}` : money(l.amount, r.currency)}</b>
                      {l.payment && l.amount > 0 && <span className="block"><Badge tone={l.payment.overdue ? 'bad' : PAY_TONE[l.payment.status]}>{l.payment.label}</Badge></span>}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <h3 className="font-bold">Demande de régularisation</h3>
          {pending ? (
            <p className="rounded-lg border border-line p-3 text-sm">Votre demande du <b>{dateTime(pending.requestedAt)}</b> attend la réponse de Cahiora.{limited ? '' : ' Tant qu’elle attend, l’accès ne sera pas limité.'}</p>
          ) : can ? (
            <>
              <p className="text-sm text-muted">La demande est datée, inscrite dans l’historique et transmise à Cahiora, qui vous répond ici{limited ? '' : ' ; tant qu’elle attend sa réponse, l’accès n’est pas limité'}.</p>
              <Field label="Message pour Cahiora (facultatif)" hint="1 000 caractères au plus.">
                <Textarea rows={3} maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Par exemple : mode de paiement souhaité, date prévue" />
              </Field>
              <ErrorNote error={error} />
              <Button onClick={send} loading={busy} className="justify-self-start"><Send className="size-4" /> Envoyer la demande à Cahiora</Button>
            </>
          ) : <p className="text-sm text-muted">Seule la direction de tout l’établissement envoie une demande de régularisation.</p>}
          {d.requests.length > 0 && (
            <ul className="grid gap-2" aria-label="Demandes de régularisation">
              {d.requests.map((x) => (
                <li key={x.id} className="grid gap-1 rounded-lg border border-line p-3 text-sm">
                  <span className="flex flex-wrap items-center justify-between gap-2"><b>Demande du {dateTime(x.requestedAt)}</b><Badge tone={x.status === 'PENDING' ? 'warn' : 'good'}>{x.status === 'PENDING' ? 'En attente de Cahiora' : 'Réponse reçue'}</Badge></span>
                  <span className="text-muted">Par {x.requestedByName}{x.message ? ` : « ${x.message} »` : ''}</span>
                  {x.answer && <p className="whitespace-pre-wrap rounded-lg bg-sunk p-2"><b>Réponse de Cahiora, le {dateTime(x.answeredAt)} :</b> {x.answer}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>
    </div>
  );
}

/**
 * Paiements de l'abonnement (lot G5d-2) : état du paiement de chaque document, reçus provisoires à imprimer (sans valeur
 * fiscale), crédit de l'établissement et ses mouvements, demandes de remboursement. La direction de tout
 * l'établissement demande le remboursement de son crédit disponible ; Cahiora décide avec sa preuve.
 */
function PaiementsCahiora({ d, reload }: { d: Data; reload: () => void }) {
  const auth = useAuth();
  const toast = useToast();
  const r = d.regularization!;
  const [f, setF] = useState({ amount: '', message: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const docs = r.lines.filter((l) => l.kind === 'SUBSCRIPTION' && l.amount > 0 && l.payment);
  const credit = r.credit;
  const can = !!auth.me?.access?.canRegularize;
  if (!docs.length && !r.receipts.length && !(credit && (credit.balance > 0 || credit.entries.length)) && !r.refunds.length) return null;
  async function ask() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/settings/subscription/refund-requests', { amount: Number(f.amount), message: f.message.trim() || undefined });
      toast('Demande de remboursement envoyée à Cahiora');
      setF({ amount: '', message: '' });
      reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div id="paiements-cahiora" className="scroll-mt-20">
      <Section title="Paiements et crédit">
        <div className="grid gap-3 text-[15px]">
          <p className="text-sm">{r.payment}</p>
          {docs.length > 0 && (
            <ul className="grid gap-1.5 text-sm" aria-label="État du paiement des documents">
              {docs.map((l) => (
                <li key={l.reference} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-sunk p-2">
                  <span className="min-w-0"><span className="font-mono text-xs">{l.reference}</span><span className="block text-xs text-muted">Payé {money(l.payment!.paid, r.currency)} sur {money(l.payment!.due, r.currency)}{l.payment!.balance > 0 ? `, reste ${money(l.payment!.balance, r.currency)}` : ''}</span></span>
                  <Badge tone={l.payment!.overdue ? 'bad' : PAY_TONE[l.payment!.status]}>{l.payment!.label}</Badge>
                </li>
              ))}
            </ul>
          )}
          <h3 className="font-bold">Reçus provisoires</h3>
          <p className="rounded-lg bg-warn-soft p-2 text-sm font-bold">{r.receiptMention} Ce n’est pas une facture.</p>
          {r.receipts.length === 0 ? <p className="text-sm text-muted">Aucun paiement enregistré par Cahiora pour le moment.</p> : (
            <ul className="grid gap-2" aria-label="Reçus provisoires">
              {r.receipts.map((x) => (
                <li key={x.id} className="grid gap-1 rounded-lg border border-line p-3 text-sm">
                  <span className="flex flex-wrap items-start justify-between gap-2">
                    <span className="min-w-0"><b className={`font-mono ${x.cancelled ? 'line-through' : ''}`}>{x.receiptNumber}</b><span className="block text-xs text-muted">{x.statusLabel} · paiement du {frDate(x.paidOn)}, {x.meansName}</span></span>
                    <b>{money(x.amount, x.currency)}</b>
                  </span>
                  <span className="text-muted">Document {x.documentReference}{x.allocations.length ? ` · imputé sur ${x.allocations.map((a) => `${a.reference} (${money(a.amount, x.currency)})`).join(', ')}` : ''}{x.creditAmount > 0 ? ` · ${money(x.creditAmount, x.currency)} en crédit` : ''}</span>
                  <Link href={`/espace/recu-cahiora/${x.id}`} className="inline-flex min-h-11 items-center gap-1.5 font-bold text-brand underline"><Printer className="size-4" /> Voir et imprimer le reçu {x.receiptNumber}</Link>
                </li>
              ))}
            </ul>
          )}
          {credit && (
            <>
              <h3 className="flex items-center gap-2 font-bold"><Wallet className="size-4" /> Crédit de l’établissement</h3>
              <p className="text-sm">Disponible : <b>{money(credit.available, r.currency)}</b>{credit.reserved > 0 ? ` (${money(credit.reserved, r.currency)} réservés par votre demande de remboursement)` : ''}. Un crédit se déduit automatiquement du document suivant.</p>
              {credit.entries.length > 0 && (
                <details className="rounded-lg border border-line p-3 text-sm">
                  <summary className="cursor-pointer font-bold">Mouvements du crédit ({credit.entries.length})</summary>
                  <ul className="mt-2 grid gap-1">
                    {credit.entries.map((x) => (
                      <li key={x.id} className="flex flex-wrap justify-between gap-2 border-t border-line pt-1 first:border-0 first:pt-0">
                        <span>{x.label}{x.receiptNumber ? ` · reçu ${x.receiptNumber}` : ''}{x.documentReference ? ` · ${x.documentReference}` : ''}<span className="block text-xs text-muted">{dateTime(x.createdAt)}</span></span>
                        <b>{x.amount < 0 ? '− ' : '+ '}{money(Math.abs(x.amount), r.currency)}</b>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <h3 className="font-bold">Remboursement du crédit</h3>
              {r.refundOpen && can ? (
                <div className="grid gap-3">
                  <p className="text-sm text-muted">Cahiora rembourse sur demande seulement, après vérification, avec sa preuve. Le montant demandé est réservé jusqu’à la décision.</p>
                  <Field label="Montant à rembourser" hint={`Au plus ${money(credit.available, r.currency)}.`}>
                    <Input inputMode="numeric" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/\D/g, '') })} className="max-w-48" />
                  </Field>
                  <Field label="Message pour Cahiora (facultatif)" hint="1 000 caractères au plus.">
                    <Textarea rows={2} maxLength={1000} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} placeholder="Par exemple : moyen de remboursement souhaité" />
                  </Field>
                  <ErrorNote error={error} />
                  <Button onClick={ask} loading={busy} disabled={!f.amount} className="justify-self-start"><Send className="size-4" /> Demander le remboursement</Button>
                </div>
              ) : <p className="text-sm text-muted">{r.refundNote ?? (r.refundOpen ? 'Seule la direction de tout l’établissement demande un remboursement.' : 'Aucun crédit disponible à rembourser.')}</p>}
            </>
          )}
          {r.refunds.length > 0 && (
            <ul className="grid gap-2" aria-label="Demandes de remboursement">
              {r.refunds.map((x) => (
                <li key={x.id} className="grid gap-1 rounded-lg border border-line p-3 text-sm">
                  <span className="flex flex-wrap items-center justify-between gap-2"><b>Demande de {money(x.amount, x.currency)} du {dateTime(x.requestedAt)}</b><Badge tone={x.status === 'PENDING' ? 'warn' : x.status === 'REFUNDED' ? 'good' : 'bad'}>{x.statusLabel}</Badge></span>
                  <span className="text-muted">Par {x.requestedByName}{x.message ? ` : « ${x.message} »` : ''}</span>
                  {x.status === 'REFUNDED' && <span>Remboursé par Cahiora le {frDate(x.refundedOn)} ({x.refundMeans}, référence {x.refundRef}).</span>}
                  {x.status === 'REFUSED' && <span>Refusé par Cahiora le {dateTime(x.decidedAt)} : {x.decisionNote} Le montant reste dans votre crédit.</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>
    </div>
  );
}

function Tarif({ d }: { d: Data }) {
  const frozen = d.subscription?.acceptedTariff;
  const price = frozen?.pricePerPupil ?? d.tariff.pricePerPupil;
  const minimum = frozen?.minimum ?? d.tariff.minimum;
  const currency = frozen?.currency ?? d.currency;
  return (
    <Section title={frozen ? 'Votre tarif' : 'Tarif de Cahiora'}>
      {price === null || minimum === null ? <p className="text-sm text-muted">Le tarif pour votre monnaie ({d.currency}) n’est pas encore fixé par Cahiora.</p> : (
        <div className="grid gap-1 text-[15px]">
          <p><b>{money(price, currency)}</b> par élève et par année scolaire, avec un minimum de <b>{money(minimum, currency)}</b> par établissement et par an.</p>
          <p className="text-sm text-muted">{frozen ? `Tarif figé le ${frDate(frozen.day)}, à l’acceptation des conditions.` : 'Tarif en vigueur ce jour ; il est figé dans votre abonnement quand vous acceptez les conditions commerciales.'} Les SMS et les frais de transaction sont facturés à part.</p>
        </div>
      )}
    </Section>
  );
}

function Calendrier({ d, openCounts }: { d: Data; openCounts?: () => void }) {
  return (
    <Section title="Calendrier de facturation">
      {d.calendars.length === 0 ? <p className="text-sm text-muted">Aucun calendrier de facturation n’est encore fixé pour votre établissement.</p> : (
        <ul className="grid gap-2 text-sm">
          {d.calendars.map((c) => (
            <li key={c.yearLabel} className="grid gap-0.5 rounded-lg bg-sunk p-3">
              <b>Année {c.yearLabel}</b>
              <span>Du {frDate(c.startDate)} au {frDate(c.endDate)}{c.preparationFrom ? ` (préparation à partir du ${frDate(c.preparationFrom)})` : ''}</span>
              <span>Comptage initial des élèves : {frDate(c.initialCountDate)}</span>
              <span>Régularisations : {frDate(c.firstRegularizationDate)} et {frDate(c.finalRegularizationDate)}</span>
              {c.renewalDate && <span>Renouvellement : {frDate(c.renewalDate)}</span>}
            </li>
          ))}
        </ul>
      )}
      {openCounts && <p className="mt-3 text-sm text-muted">Les comptages des élèves et leur liste sont dans la rubrique <button type="button" className="cursor-pointer font-bold text-brand underline" onClick={openCounts}>Effectifs facturables</button>.</p>}
    </Section>
  );
}

function Historique({ d }: { d: Data }) {
  return (
    <Section title="Historique">
      {d.history.length === 0 ? <p className="text-sm text-muted">Aucun événement.</p> : (
        <ul className="grid max-h-80 gap-2 overflow-y-auto text-sm">
          {d.history.map((h, i) => (
            <li key={`${h.createdAt}-${i}`} className="rounded-lg border border-line p-2">
              <b>{h.label}</b>
              <span className="block text-xs text-muted">{new Date(h.createdAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })} · {h.actorName}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** Documents provisoires de Cahiora (lot G5c) : proformas et relevés de l'abonnement, avoirs, devis et proformas de prestations. */
function Documents() {
  const q = useApi<Docs>('/settings/billing-documents');
  return (
    <Section title="Documents de Cahiora">
      <Loader {...q}>
        {(d) => (
          <div className="grid gap-3">
            <p className="rounded-lg bg-warn-soft p-2 text-sm font-bold">{d.mention}</p>
            {d.groupPending ? <p className="text-sm text-muted">{d.groupPending}</p> : d.documents.length === 0 ? (
              <p className="text-sm text-muted">Aucun document pour le moment. Cahiora prépare un document à partir de chaque comptage figé de vos élèves.</p>
            ) : (
              <ul className="grid gap-2" aria-label="Documents de Cahiora">
                {d.documents.map((doc) => <DocumentItem key={doc.id} doc={doc} related={d.documents.find((x) => x.id === doc.relatedDocumentId) ?? null} />)}
              </ul>
            )}
            <p className="text-xs text-muted">Un document émis ne change plus. L’état de son paiement est dans « Paiements et crédit ».</p>
          </div>
        )}
      </Loader>
    </Section>
  );
}

function DocumentItem({ doc, related }: { doc: Doc; related: Doc | null }) {
  const note = (k: string) => (typeof doc.data?.[k] === 'string' ? (doc.data[k] as string) : null);
  const sign = doc.kind === 'CREDIT_NOTE' ? '− ' : '';
  return (
    <li className="grid gap-1 rounded-lg border border-line p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="min-w-0"><Badge tone={KIND_TONE[doc.kind]}>{doc.label}</Badge><span className="mt-1 block font-mono text-xs">{doc.reference}</span></span>
        <b className="text-base">{sign}{money(doc.total, doc.currency)}</b>
      </div>
      <span className="text-muted">
        Le {frDate(doc.issueDate)}{doc.dueDate ? ` · échéance le ${frDate(doc.dueDate)}` : (doc.kind === 'SUBSCRIPTION' || doc.kind === 'SERVICE_PROFORMA') && doc.total > 0 ? ' · échéance à fixer' : ''}{doc.yearLabel ? ` · année ${doc.yearLabel}` : ''}
      </span>
      {related && <span>{doc.kind === 'CREDIT_NOTE' ? 'Sur' : 'Reprend'} {related.label.toLowerCase()} {related.reference}</span>}
      <details>
        <summary className="inline-flex cursor-pointer items-center gap-1 font-bold text-brand"><FileText className="size-4" /> Détail</summary>
        <ul className="mt-2 grid gap-2">
          {doc.lines.map((l) => (
            <li key={l.id} className="grid gap-0.5 rounded-lg bg-sunk p-2">
              <span className="flex flex-wrap justify-between gap-2"><b className="min-w-0">{l.label}</b><b>{sign}{money(l.amount, doc.currency)}</b></span>
              {l.quantity !== null && <span className="text-xs text-muted">{l.quantity} × {money(l.unitPrice ?? 0, doc.currency)}</span>}
              {l.pupils !== null && (
                <span className="text-xs text-muted">
                  {pupilsText(l.pupils)}{l.pupilsChange ? ` (${l.pupilsChange > 0 ? '+' : ''}${l.pupilsChange})` : ''}{l.referenceDate ? ` au ${frDate(l.referenceDate)}` : ''} × {money(l.pricePerPupil ?? 0, doc.currency)},
                  minimum {money(l.minimum ?? 0, doc.currency)}{l.minimumApplied ? ' (appliqué)' : ''}{l.shareMonths ? `, part ${l.shareMonths}/${l.shareOf}` : ''} : {money(l.yearAmount ?? 0, doc.currency)} pour l’année, {money(l.alreadyBilled ?? 0, doc.currency)} déjà demandés
                </span>
              )}
            </li>
          ))}
        </ul>
        {note('validity') && <p className="mt-2 text-warn">{note('validity')}</p>}
        {note('due') && <p className="mt-2 text-warn">{note('due')}</p>}
        {note('dueNote') && <p className="mt-2 text-warn">{note('dueNote')}</p>}
      </details>
    </li>
  );
}
