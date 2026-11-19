'use client';

import { useCallback, useEffect, useState } from 'react';
import { CalendarPlus, MessageSquareReply } from 'lucide-react';
import { Badge, Button, Card, Dialog, DialogContent, Empty, ErrorNote, Field, Input, Stat, Textarea } from '@/components/ui';
import { pf } from '@/lib/platform';
import { CodeField, frDate, useSubmit } from './facturation-outils';

/**
 * Accès des clients (lot G5d-1), décisions de Dankou du 19 novembre 2026 (D-G5-30 A, D-G5-42 A, D-G5-43 A) :
 * établissements en attente d'acceptation ou de paiement, ou en accès limité, avec leur délai d'accès complet ;
 * demandes de régularisation de leur direction, auxquelles Cahiora répond une fois ; prolongation exceptionnelle de
 * l'accès complet (date de fin obligatoire, motif interne jamais montré à l'école). Chaque réponse et chaque
 * prolongation demandent un code actuel de l'application d'authentification. Rien n'est payé ni encaissé ici.
 */

type Phase = 'FREE' | 'ACTIVE' | 'GRACE' | 'EXTENDED' | 'HELD' | 'DUE' | 'LIMITED' | 'WAITING';
type Status = 'TRIAL' | 'PILOT' | 'AWAITING_ACCEPTANCE' | 'AWAITING_PAYMENT' | 'ACTIVE' | 'LIMITED';
type Pending = { id: string; message: string | null; requestedByName: string; requestedAt: string };
type Client = {
  tenantId: string; tenantName: string; group: string; today: string; status: Status; statusLabel: string; statusSince: string;
  phase: Phase; until: string | null; daysLeft: number | null; limitedFrom: string | null;
  graceStart: string | null; graceEnd: string | null; extendedUntil: string | null; limitedSince: string | null; termsAccepted: boolean; pendingRequest: Pending | null;
};
type Request = {
  id: string; tenantId: string; tenantName: string; status: 'PENDING' | 'ANSWERED'; subscriptionStatus: Status; subscriptionStatusLabel: string;
  message: string | null; requestedByName: string; requestedAt: string; answeredByName: string | null; answeredAt: string | null; answer: string | null;
};
type Data = { paymentMeansActive: boolean; clients: Client[]; requests: Request[] };

const PHASE: Record<Phase, { label: string; tone: 'info' | 'good' | 'warn' | 'bad' | 'accent' }> = {
  GRACE: { label: 'Délai de grâce', tone: 'warn' },
  EXTENDED: { label: 'Prolongation de Cahiora', tone: 'accent' },
  HELD: { label: 'Délai passé, demande en attente', tone: 'warn' },
  DUE: { label: 'Délai passé : limitation au prochain passage', tone: 'bad' },
  LIMITED: { label: 'Accès limité', tone: 'bad' },
  WAITING: { label: 'En attente, sans délai connu', tone: 'info' },
  ACTIVE: { label: 'Abonnement actif', tone: 'good' },
  FREE: { label: 'Gratuité en cours', tone: 'info' },
};
const STATUS_TONE: Record<Status, 'info' | 'good' | 'warn' | 'bad' | 'accent'> = {
  TRIAL: 'info', PILOT: 'accent', AWAITING_ACCEPTANCE: 'warn', AWAITING_PAYMENT: 'warn', ACTIVE: 'good', LIMITED: 'bad',
};
const dateTime = (d: string | null) => (d ? new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const days = (n: number) => `${n} jour${n > 1 ? 's' : ''}`;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Détail de l'accès d'un client, en une phrase. */
function accessDetail(c: Client) {
  switch (c.phase) {
    case 'GRACE': return `Accès complet jusqu’au ${frDate(c.until)} (encore ${days(c.daysLeft ?? 0)}), délai de grâce depuis le ${frDate(c.graceStart)}.`;
    case 'EXTENDED': return `Accès complet prolongé jusqu’au ${frDate(c.until)} (encore ${days(c.daysLeft ?? 0)}).`;
    case 'HELD': return `Délai d’accès complet terminé le ${frDate(c.extendedUntil && (!c.graceEnd || c.extendedUntil > c.graceEnd) ? c.extendedUntil : c.graceEnd)} ; la demande en attente retient la limitation.`;
    case 'DUE': return 'Délai passé sans paiement validé ni demande en attente : la tâche planifiée pose l’accès limité à son prochain passage.';
    case 'LIMITED': return `Accès limité depuis le ${c.limitedSince ? new Date(c.limitedSince).toLocaleDateString('fr-FR') : '—'} : consultation, impression, export, caisse et régularisation seulement.`;
    case 'WAITING': return 'Gratuité terminée avant le lot G5d : aucun délai de grâce, jamais limité automatiquement.';
    default: return '';
  }
}

export function Acces() {
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [dialog, setDialog] = useState<{ kind: 'answer'; r: Request } | { kind: 'extend'; c: Client } | null>(null);
  const load = useCallback(() => {
    pf<Data>('GET', '/billing/access').then(setD).catch(setError);
  }, []);
  useEffect(load, [load]);
  if (error) return <ErrorNote error={error} />;
  if (!d) return null;
  const pending = d.requests.filter((r) => r.status === 'PENDING');
  const answered = d.requests.filter((r) => r.status === 'ANSWERED');
  const client = (tenantId: string) => d.clients.find((c) => c.tenantId === tenantId) ?? null;
  const done = () => { setDialog(null); load(); };
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Demandes en attente" value={pending.length} tone={pending.length ? 'warn' : undefined} />
        <Stat label="En délai de grâce" value={d.clients.filter((c) => c.phase === 'GRACE').length} />
        <Stat label="Prolongations" value={d.clients.filter((c) => c.phase === 'EXTENDED').length} />
        <Stat label="Accès limité" value={d.clients.filter((c) => c.phase === 'LIMITED' || c.phase === 'DUE').length} tone={d.clients.some((c) => c.phase === 'LIMITED' || c.phase === 'DUE') ? 'bad' : undefined} />
      </div>
      {!d.paymentMeansActive && (
        <p className="rounded-lg bg-sunk p-3 text-sm">
          Aucun moyen de paiement n’est activé (lot G5d-2) : une demande de régularisation qui attend votre réponse retient la limitation automatique (D-G5-42 A).
          Votre réponse met fin à cette retenue ; pour laisser l’accès complet après le délai, donnez une prolongation (D-G5-43 A).
        </p>
      )}

      <Card className="grid gap-3">
        <h3 className="font-bold">Demandes de régularisation en attente</h3>
        {pending.length === 0 ? <p className="text-sm text-muted">Aucune demande en attente.</p> : (
          <ul className="grid gap-2" aria-label="Demandes de régularisation en attente">
            {pending.map((r) => {
              const c = client(r.tenantId);
              return (
                <li key={r.id} className="grid gap-2 rounded-lg border border-line p-3 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span className="min-w-0"><b>{r.tenantName}</b><span className="block text-xs text-muted">Demande du {dateTime(r.requestedAt)} par {r.requestedByName} · {r.subscriptionStatusLabel}</span></span>
                    {c && <Badge tone={PHASE[c.phase].tone}>{PHASE[c.phase].label}</Badge>}
                  </div>
                  {r.message ? <p className="whitespace-pre-wrap rounded bg-sunk p-2">« {r.message} »</p> : <p className="text-muted">Sans message.</p>}
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => setDialog({ kind: 'answer', r })} aria-label={`Répondre à ${r.tenantName}`}><MessageSquareReply className="size-4" /> Répondre</Button>
                    {c && <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'extend', c })} aria-label={`Prolonger l’accès de ${c.tenantName}`}><CalendarPlus className="size-4" /> Prolonger l’accès</Button>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card className="grid gap-3">
        <h3 className="font-bold">Clients en attente ou en accès limité</h3>
        {d.clients.length === 0 ? <Empty title="Aucun client en attente">Aucun établissement n’attend l’acceptation de ses conditions ou son paiement.</Empty> : (
          <ul className="grid gap-2" aria-label="Clients en attente ou en accès limité">
            {d.clients.map((c) => (
              <li key={c.tenantId} className="grid gap-2 rounded-lg border border-line p-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="min-w-0"><b>{c.tenantName}</b><span className="block text-xs text-muted">{c.group}</span></span>
                  <span className="flex flex-wrap gap-1">
                    <Badge tone={STATUS_TONE[c.status]}>{c.statusLabel}</Badge>
                    {c.phase !== 'LIMITED' && <Badge tone={PHASE[c.phase].tone}>{PHASE[c.phase].label}</Badge>}
                  </span>
                </div>
                <p>{accessDetail(c)}</p>
                {c.pendingRequest && <p className="text-muted">Demande de régularisation du {dateTime(c.pendingRequest.requestedAt)} en attente de votre réponse.</p>}
                {!c.termsAccepted && <p className="text-muted">Conditions commerciales pas encore acceptées.</p>}
                <div><Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'extend', c })} aria-label={`Prolonger l’accès de ${c.tenantName}`}><CalendarPlus className="size-4" /> Prolonger l’accès</Button></div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {answered.length > 0 && (
        <Card className="grid gap-2">
          <details>
            <summary className="cursor-pointer font-bold">Demandes répondues ({answered.length})</summary>
            <ul className="mt-3 grid gap-2" aria-label="Demandes répondues">
              {answered.map((r) => (
                <li key={r.id} className="grid gap-1 rounded-lg bg-sunk p-3 text-sm">
                  <b>{r.tenantName}</b>
                  <span className="text-xs text-muted">Demande du {dateTime(r.requestedAt)} par {r.requestedByName}{r.message ? ` : « ${r.message} »` : ''}</span>
                  <span className="whitespace-pre-wrap">Réponse du {dateTime(r.answeredAt)} par {r.answeredByName} : {r.answer}</span>
                </li>
              ))}
            </ul>
          </details>
        </Card>
      )}

      <Dialog open={!!dialog} onOpenChange={(o) => !o && setDialog(null)}>
        {dialog?.kind === 'answer' && <AnswerDialog r={dialog.r} c={client(dialog.r.tenantId)} done={done} />}
        {dialog?.kind === 'extend' && <ExtensionDialog c={dialog.c} done={done} />}
      </Dialog>
    </div>
  );
}

function AnswerDialog({ r, c, done }: { r: Request; c: Client | null; done: () => void }) {
  const [f, setF] = useState({ answer: '', code: '' });
  const { busy, error, submit } = useSubmit(done, `Réponse envoyée à ${r.tenantName}`);
  const past = c && (c.phase === 'HELD' || c.phase === 'DUE');
  return (
    <DialogContent title={`Répondre à ${r.tenantName}`} description="La direction de l’établissement lit la réponse, signée « Cahiora », dans son abonnement et ses notifications. Elle ne se modifie plus.">
      <form className="grid gap-3" onSubmit={(ev) => { ev.preventDefault(); submit(() => pf('POST', `/billing/regularization-requests/${r.id}/answer`, f)); }}>
        <p className="rounded-lg bg-sunk p-3 text-sm">Demande du {dateTime(r.requestedAt)} par {r.requestedByName}{r.message ? ` : « ${r.message} »` : ', sans message.'}</p>
        <Field label="Réponse" hint="5 à 2 000 caractères.">
          <Textarea rows={5} value={f.answer} minLength={5} maxLength={2000} onChange={(x) => setF({ ...f, answer: x.target.value })} required />
        </Field>
        <p className={past ? 'rounded-lg bg-warn-soft p-3 text-sm font-bold text-warn' : 'text-sm text-muted'}>
          {past
            ? 'Le délai d’accès complet de cet établissement est passé : une fois la demande répondue, l’accès sera limité au prochain passage des tâches, sauf prolongation.'
            : 'Une demande répondue ne retient plus la limitation : à la fin du délai, sans paiement validé ni prolongation, l’accès sera limité.'}
        </p>
        <CodeField value={f.code} onChange={(code) => setF({ ...f, code })} />
        <ErrorNote error={error} />
        <Button type="submit" loading={busy}>Envoyer la réponse</Button>
      </form>
    </DialogContent>
  );
}

function ExtensionDialog({ c, done }: { c: Client; done: () => void }) {
  const [f, setF] = useState({ until: '', reason: '', code: '' });
  const { busy, error, submit } = useSubmit(done, `Accès complet prolongé pour ${c.tenantName}`);
  // Même règle que le serveur : à partir d'aujourd'hui, après le délai de grâce, au plus un an plus tard.
  const min = c.graceEnd && c.graceEnd >= c.today ? addDays(c.graceEnd, 1) : c.today;
  const max = addDays(c.today, 366);
  const now =
    c.phase === 'LIMITED' ? `Accès limité depuis le ${c.limitedSince ? new Date(c.limitedSince).toLocaleDateString('fr-FR') : '—'} : la limitation est levée dès l’enregistrement.`
      : c.extendedUntil ? `Prolongation actuelle jusqu’au ${frDate(c.extendedUntil)} : la nouvelle date la remplace.`
        : c.graceEnd ? `Délai de grâce jusqu’au ${frDate(c.graceEnd)}.` : 'Aucun délai de grâce connu (gratuité terminée avant le lot G5d).';
  return (
    <DialogContent title={`Prolonger l’accès complet : ${c.tenantName}`} description="Prolongation exceptionnelle (D-G5-43 A) : accès complet jusqu’à la date de fin incluse, puis accès limité sans paiement validé. Rien n’est payé ni encaissé.">
      <form className="grid gap-3" onSubmit={(ev) => { ev.preventDefault(); submit(() => pf('POST', `/billing/access/${c.tenantId}/extension`, f)); }}>
        <p className="rounded-lg bg-sunk p-3 text-sm">{now}{c.pendingRequest ? ' La demande de régularisation en attente reste à répondre.' : ''}</p>
        <Field label="Dernier jour d’accès complet" hint={`Du ${frDate(min)} au ${frDate(max)} au plus (un an).`}>
          <Input type="date" value={f.until} min={min} max={max} onChange={(x) => setF({ ...f, until: x.target.value })} required />
        </Field>
        <Field label="Motif" hint="Interne à Cahiora : jamais montré à l’établissement. Par exemple : paiement partiel reçu, et sa date.">
          <Input value={f.reason} minLength={5} maxLength={300} onChange={(x) => setF({ ...f, reason: x.target.value })} required />
        </Field>
        <CodeField value={f.code} onChange={(code) => setF({ ...f, code })} />
        <ErrorNote error={error} />
        <Button type="submit" loading={busy}>Prolonger l’accès</Button>
      </form>
    </DialogContent>
  );
}
