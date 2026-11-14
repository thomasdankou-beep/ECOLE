'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bell, CalendarDays, History, Play, Plus } from 'lucide-react';
import { Badge, Button, Card, Chips, Dialog, DialogContent, Empty, ErrorNote, Field, Input, Select, Stat, Table, Textarea, useToast } from '@/components/ui';
import { pf } from '@/lib/platform';
import { CodeField, frDate, money, useSubmit } from './facturation-outils';
import { Prestations } from './prestations';

/**
 * Commercial et facturation (lot G5a) : vue d'ensemble, abonnements, établissements clients et leurs calendriers,
 * paramètres tarifaires datés et conditions commerciales ; prestations complémentaires (lot G5g, ./prestations.tsx).
 * Les autres rubriques arrivent avec les lots G5b à G5h.
 * Chaque opération financière demande un code actuel de l'application d'authentification.
 */

type Status = 'TRIAL' | 'PILOT' | 'AWAITING_ACCEPTANCE' | 'AWAITING_PAYMENT' | 'ACTIVE' | 'LIMITED';
type Sub = {
  id: string; status: Status; statusLabel: string; statusSince: string; trialStart: string | null; trialEnd: string | null; trialDays: number | null;
  pilotStart: string | null; pilotEnd: string | null; pilotMonths: number | null; freeDaysLeft: number | null; acceptedAt: string | null; acceptedByName: string | null;
  acceptedTariff: { currency: string; pricePerPupil: number; minimum: number } | null;
};
type Calendar = {
  id: string; yearLabel: string; version: number; startDate: string; endDate: string; preparationFrom: string | null; initialCountDate: string;
  firstRegularizationDate: string; finalRegularizationDate: string; renewalDate: string | null; formula: string; reason: string; createdByName: string; createdAt: string;
};
type Establishment = {
  id: string; slug: string; name: string; status: 'ACTIVE' | 'SUSPENDED'; country: string; currency: string; timezone: string; today: string; createdOn: string; demo: boolean;
  group: { id: string; name: string }; subscription: Sub | null; calendars: Calendar[];
};
type Overview = {
  counts: { establishments: number; none: number } & Record<Status, number>;
  soon: { tenantId: string; tenantName: string; group: string; kind: 'TRIAL' | 'PILOT'; lastDay: string; daysLeft: number }[];
  unreadAlerts: number;
  amountsFrom: Record<string, string>;
};
type Alert = { id: string; tenantName: string | null; kind: string; message: string; dueDate: string | null; readAt: string | null; createdAt: string };
type Param = { key: string; currency: string | null; label: string; unit: 'money' | 'days' | 'months' | 'percent'; usedFrom: string; provisional?: string; value: number | null; since: string | null; next: { value: number; effectiveFrom: string } | null };
type Params = {
  today: string; currencies: string[];
  definitions: { key: string; label: string; unit: Param['unit']; min: number; max: number; usedFrom: string; provisional?: string }[];
  current: Param[];
  history: { id: string; key: string; label: string; currency: string | null; value: number; effectiveFrom: string; reason: string; createdByName: string; createdAt: string }[];
};
type Terms = { id: string; version: number; title: string; body: string; effectiveFrom: string; createdByName: string; createdAt: string };
type Event = { id: string; kind: string; label: string; createdAt: string; actorName: string; actorKind: string; reason: string | null; data: Record<string, unknown> | null };

type Section = 'ensemble' | 'abonnements' | 'etablissements' | 'documents' | 'paiements' | 'avoirs' | 'prestations' | 'parrainage' | 'partenaires' | 'sms' | 'rapports' | 'parametres';
const LATER: Partial<Record<Section, [string, string]>> = {
  documents: ['G5c', 'Proformas, documents de régularisation et avoirs, toujours provisoires tant que les informations fiscales manquent (G5f pour les factures fiscales).'],
  paiements: ['G5d', 'Saisie et vérification des paiements, statuts, reçus provisoires.'],
  avoirs: ['G5d', 'Trop-perçus en crédits, utilisation, demandes de remboursement.'],
  parrainage: ['G5h', 'Codes de parrainage, écoles filleules et crédits de 5 000 FCFA après le premier paiement confirmé.'],
  partenaires: ['G5h', 'Apporteurs d’affaires et partenaires premium, commissions et versements.'],
  sms: ['G5e', 'Crédits SMS prépayés par établissement (prix et forfaits : INFORMATION MANQUANTE).'],
  rapports: ['G5c et G5d', 'Facturé, encaissé et impayés par période, établissement, groupe et état.'],
};

const UNIT_SUFFIX = { days: 'jours', months: 'mois' } as const;
function paramValue(unit: Param['unit'], value: number | null, currency: string | null) {
  if (value === null) return 'INFORMATION MANQUANTE';
  if (unit === 'money') return money(value, currency);
  if (unit === 'percent') return `${(value / 100).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} %`;
  return `${value} ${UNIT_SUFFIX[unit]}`;
}
const STATUS_TONE: Record<Status, 'info' | 'good' | 'warn' | 'bad' | 'accent'> = {
  TRIAL: 'info', PILOT: 'accent', AWAITING_ACCEPTANCE: 'warn', AWAITING_PAYMENT: 'warn', ACTIVE: 'good', LIMITED: 'bad',
};
const STATUS_FILTER: { value: string; label: string }[] = [
  { value: '', label: 'Tous les états' }, { value: 'none', label: 'Sans abonnement' }, { value: 'TRIAL', label: 'Essai gratuit' }, { value: 'PILOT', label: 'École pilote' },
  { value: 'AWAITING_ACCEPTANCE', label: 'Conditions à accepter' }, { value: 'AWAITING_PAYMENT', label: 'En attente de paiement' }, { value: 'ACTIVE', label: 'Abonnement actif' },
];

/** Dernier jour gratuit d'un pilote (même règle que le serveur) : la veille du même quantième N mois plus tard. */
function pilotEndPreview(start: string, months: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !months) return null;
  const [y, m, d] = start.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  if (d > last) return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), last)).toISOString().slice(0, 10);
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), d) - 86_400_000).toISOString().slice(0, 10);
}

export function Facturation() {
  const [section, setSection] = useState<Section>('ensemble');
  const later = LATER[section];
  return (
    <div className="grid gap-4">
      <Chips label="Commercial et facturation" value={section} onChange={setSection} options={[
        { value: 'ensemble', label: 'Vue d’ensemble' }, { value: 'abonnements', label: 'Abonnements' }, { value: 'etablissements', label: 'Établissements clients' },
        { value: 'documents', label: 'Factures et documents' }, { value: 'paiements', label: 'Paiements' }, { value: 'avoirs', label: 'Avoirs et crédits' },
        { value: 'prestations', label: 'Prestations complémentaires' }, { value: 'parrainage', label: 'Parrainage' }, { value: 'partenaires', label: 'Partenaires et commissions' },
        { value: 'sms', label: 'SMS et crédits' }, { value: 'rapports', label: 'Rapports financiers' }, { value: 'parametres', label: 'Paramètres tarifaires' },
      ]} />
      {section === 'ensemble' && <Ensemble />}
      {section === 'abonnements' && <Abonnements />}
      {section === 'etablissements' && <Etablissements />}
      {section === 'prestations' && <Prestations />}
      {section === 'parametres' && <Parametres open={setSection} />}
      {later && <Empty title={`Prévu au lot ${later[0]}`}>{later[1]}</Empty>}
    </div>
  );
}

// ---------------------------------------------------------------- Vue d'ensemble

function Ensemble() {
  const toast = useToast();
  const [o, setO] = useState<Overview | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [running, setRunning] = useState(false);
  const load = useCallback(() => {
    pf<Overview>('GET', '/billing/overview').then(setO).catch(setError);
    pf<Alert[]>('GET', '/billing/alerts').then(setAlerts).catch(setError);
  }, []);
  useEffect(load, [load]);
  if (error) return <ErrorNote error={error} />;
  if (!o) return null;
  const c = o.counts;
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Établissements" value={c.establishments} detail={`${c.none} sans abonnement`} />
        <Stat label="En essai" value={c.TRIAL} />
        <Stat label="Écoles pilotes" value={c.PILOT} />
        <Stat label="Abonnés actifs" value={c.ACTIVE} detail="Paiement vérifié (lot G5d)" />
        <Stat label="Conditions à accepter" value={c.AWAITING_ACCEPTANCE} tone={c.AWAITING_ACCEPTANCE ? 'warn' : undefined} />
        <Stat label="En attente de paiement" value={c.AWAITING_PAYMENT} tone={c.AWAITING_PAYMENT ? 'warn' : undefined} />
        <Stat label="Alertes non lues" value={o.unreadAlerts} tone={o.unreadAlerts ? 'warn' : undefined} />
      </div>
      <Card className="grid gap-2">
        <h3 className="font-bold">Montants</h3>
        <p className="text-sm text-muted">Facturé et encaissé ne se confondent jamais. Ces montants arriveront avec les documents et les paiements :</p>
        <ul className="grid gap-1 text-sm sm:grid-cols-2">
          {([['billed', 'Facturé'], ['collected', 'Encaissé'], ['unpaid', 'Impayés'], ['clientCredits', 'Crédits des clients'], ['servicesRevenue', 'Prestations'], ['commissionsDue', 'Commissions dues'], ['commissionsPaid', 'Commissions payées']] as const).map(([k, label]) => (
            <li key={k} className="flex justify-between gap-2 rounded bg-sunk px-3 py-1.5"><span>{label}</span><span className="text-muted">— (lot {o.amountsFrom[k]})</span></li>
          ))}
        </ul>
      </Card>
      <Card className="grid gap-2">
        <h3 className="font-bold">Gratuités qui se terminent bientôt</h3>
        {o.soon.length === 0 ? <p className="text-sm text-muted">Aucun essai dans les 7 prochains jours, aucun pilote dans les 30 prochains jours.</p> : (
          <ul className="grid gap-1 text-sm">
            {o.soon.map((s) => (
              <li key={s.tenantId}><b>{s.tenantName}</b> ({s.group}) : {s.kind === 'TRIAL' ? 'essai' : 'pilote'} jusqu’au {frDate(s.lastDay)}, encore {s.daysLeft} jour{s.daysLeft > 1 ? 's' : ''}</li>
            ))}
          </ul>
        )}
      </Card>
      <Card className="grid gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 font-bold"><Bell className="size-4" /> Alertes</h3>
          <Button size="sm" variant="outline" loading={running} onClick={async () => {
            setRunning(true);
            try {
              const r = await pf<{ done: string[]; busy?: boolean }>('POST', '/billing/jobs/run');
              toast(r.busy ? 'Les tâches sont déjà en cours' : r.done.length ? `${r.done.length} tâche(s) exécutée(s)` : 'Rien à faire pour le moment');
              load();
            } catch (e) {
              toast(e instanceof Error ? e.message : 'Erreur', 'bad');
            } finally {
              setRunning(false);
            }
          }}><Play className="size-4" /> Passer les tâches maintenant</Button>
        </div>
        <p className="text-xs text-muted">Les tâches passent seules toutes les heures : fin d’essai, alertes avant la fin d’un pilote, fin de pilote.</p>
        {alerts.length === 0 ? <p className="text-sm text-muted">Aucune alerte.</p> : (
          <ul className="grid gap-2">
            {alerts.map((a) => (
              <li key={a.id} className={`flex flex-wrap items-start justify-between gap-2 rounded-lg p-2 text-sm ${a.readAt ? 'bg-sunk text-muted' : 'bg-warn-soft'}`}>
                <span>{a.message}<span className="block text-xs text-muted">{new Date(a.createdAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</span></span>
                {!a.readAt && <Button size="sm" variant="ghost" onClick={async () => { await pf('POST', `/billing/alerts/${a.id}/read`).catch(() => {}); load(); }}>Marquer comme lue</Button>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- Abonnements

function useEstablishments() {
  const [list, setList] = useState<Establishment[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    pf<Establishment[]>('GET', '/billing/establishments').then(setList).catch(setError);
  }, []);
  useEffect(load, [load]);
  return { list, error, load };
}

function Freedom({ s }: { s: Sub }) {
  if (s.status === 'TRIAL') return <span>Essai du {frDate(s.trialStart)} au {frDate(s.trialEnd)}{s.freeDaysLeft !== null && <span className="block text-xs text-muted">encore {s.freeDaysLeft} jour{s.freeDaysLeft > 1 ? 's' : ''}</span>}</span>;
  if (s.status === 'PILOT') return <span>Gratuit du {frDate(s.pilotStart)} au {frDate(s.pilotEnd)}{s.freeDaysLeft !== null && <span className="block text-xs text-muted">encore {s.freeDaysLeft} jour{s.freeDaysLeft > 1 ? 's' : ''}</span>}</span>;
  if (s.acceptedAt) return <span>Conditions acceptées le {new Date(s.acceptedAt).toLocaleDateString('fr-FR')} par {s.acceptedByName}{s.acceptedTariff && <span className="block text-xs text-muted">Tarif figé : {money(s.acceptedTariff.pricePerPupil, s.acceptedTariff.currency)} par élève, minimum {money(s.acceptedTariff.minimum, s.acceptedTariff.currency)}</span>}</span>;
  return <span className="text-muted">{s.trialEnd ? `Essai terminé le ${frDate(s.trialEnd)}` : s.pilotEnd ? `Pilote terminé le ${frDate(s.pilotEnd)}` : '—'}</span>;
}

function Abonnements() {
  const { list, error, load } = useEstablishments();
  const [group, setGroup] = useState('');
  const [status, setStatus] = useState('');
  const [dialog, setDialog] = useState<{ kind: 'trial' | 'pilot' | 'pilotEnd' | 'history'; e: Establishment } | null>(null);
  const groups = useMemo(() => [...new Map((list ?? []).map((e) => [e.group.id, e.group.name])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [list]);
  if (error) return <ErrorNote error={error} />;
  if (!list) return null;
  const shown = list.filter((e) => (!group || e.group.id === group) && (!status || (status === 'none' ? !e.subscription : e.subscription?.status === status)));
  return (
    <div className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Groupe"><Select value={group} onChange={(e) => setGroup(e.target.value)}><option value="">Tous les groupes</option>{groups.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</Select></Field>
        <Field label="État"><Select value={status} onChange={(e) => setStatus(e.target.value)}>{STATUS_FILTER.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</Select></Field>
      </div>
      {shown.length === 0 ? <Empty title="Aucun établissement">Aucun établissement ne correspond à ces filtres.</Empty> : (
        <Card className="overflow-x-auto p-0">
          <Table>
            <thead><tr><th>Établissement</th><th>Groupe</th><th>État</th><th>Gratuité ou acceptation</th><th /></tr></thead>
            <tbody>
              {shown.map((e) => (
                <tr key={e.id}>
                  <td className="font-bold">{e.name}{e.demo && <Badge tone="info" className="ml-2">Démo</Badge>}<span className="block text-xs font-normal text-muted">{e.slug} · {e.currency}</span></td>
                  <td className="text-sm">{e.group.name}</td>
                  <td>{e.subscription ? <Badge tone={STATUS_TONE[e.subscription.status]}>{e.subscription.statusLabel}</Badge> : <Badge tone="warn">Aucun abonnement</Badge>}</td>
                  <td className="text-sm">{e.subscription ? <Freedom s={e.subscription} /> : <span className="text-muted">—</span>}</td>
                  <td>
                    <div className="flex flex-wrap justify-end gap-1">
                      {!e.subscription && <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'trial', e })}>Ouvrir l’essai</Button>}
                      {(!e.subscription || e.subscription.status === 'TRIAL') && <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'pilot', e })}>École pilote</Button>}
                      {e.subscription?.status === 'PILOT' && <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'pilotEnd', e })}>Fin du pilote</Button>}
                      {e.subscription && <Button size="icon" variant="ghost" aria-label={`Historique de l’abonnement de ${e.name}`} onClick={() => setDialog({ kind: 'history', e })}><History className="size-4" /></Button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      <Dialog open={!!dialog} onOpenChange={(o) => !o && setDialog(null)}>
        {dialog?.kind === 'trial' && <TrialDialog e={dialog.e} done={() => { setDialog(null); load(); }} />}
        {dialog?.kind === 'pilot' && <PilotDialog e={dialog.e} done={() => { setDialog(null); load(); }} />}
        {dialog?.kind === 'pilotEnd' && <PilotEndDialog e={dialog.e} done={() => { setDialog(null); load(); }} />}
        {dialog?.kind === 'history' && <HistoryDialog e={dialog.e} />}
      </Dialog>
    </div>
  );
}

function TrialDialog({ e, done }: { e: Establishment; done: () => void }) {
  const [f, setF] = useState({ startDate: e.today, reason: '', code: '' });
  const { busy, error, submit } = useSubmit(done, `Essai gratuit ouvert pour ${e.name}`);
  return (
    <DialogContent title={`Ouvrir l’essai gratuit : ${e.name}`} description="La durée est celle du paramètre en vigueur (14 jours) ; le jour d’ouverture compte comme le jour 1.">
      <form className="grid gap-3" onSubmit={(ev) => { ev.preventDefault(); submit(() => pf('POST', `/billing/establishments/${e.id}/trial`, { startDate: f.startDate, reason: f.reason || undefined, code: f.code })); }}>
        <Field label="Premier jour de l’essai" hint={`Aujourd’hui pour l’établissement : ${frDate(e.today)}.`}><Input type="date" value={f.startDate} onChange={(x) => setF({ ...f, startDate: x.target.value })} required /></Field>
        <Field label="Motif (facultatif)"><Input value={f.reason} maxLength={300} onChange={(x) => setF({ ...f, reason: x.target.value })} /></Field>
        <CodeField value={f.code} onChange={(code) => setF({ ...f, code })} />
        <ErrorNote error={error} />
        <Button type="submit" loading={busy}>Ouvrir l’essai</Button>
      </form>
    </DialogContent>
  );
}

function PilotDialog({ e, done }: { e: Establishment; done: () => void }) {
  const [f, setF] = useState({ startDate: '', months: '', reason: '', code: '' });
  const { busy, error, submit } = useSubmit(done, `${e.name} est école pilote partenaire`);
  const preview = pilotEndPreview(f.startDate, Number(f.months) || 3);
  return (
    <DialogContent title={`École pilote partenaire CAHIORA : ${e.name}`} description="Gratuité à partir de l’activation effective du pilote, que vous saisissez. Rien n’est facturé pour la période pilote, ni rétroactivement après elle.">
      <form className="grid gap-3" onSubmit={(ev) => { ev.preventDefault(); submit(() => pf('POST', `/billing/establishments/${e.id}/pilot`, { startDate: f.startDate, months: f.months ? Number(f.months) : undefined, reason: f.reason, code: f.code })); }}>
        <Field label="Date d’activation effective du pilote" hint="Aucune date n’est proposée : c’est votre accord avec l’école."><Input type="date" value={f.startDate} onChange={(x) => setF({ ...f, startDate: x.target.value })} required /></Field>
        <Field label="Durée de la gratuité, en mois" hint="Vide : le paramètre en vigueur (3 mois)."><Input type="number" min={1} max={24} value={f.months} onChange={(x) => setF({ ...f, months: x.target.value })} /></Field>
        {preview && <p className="rounded bg-sunk p-2 text-sm">Dernier jour gratuit : <b>{frDate(preview)}</b>{!f.months && ' (avec 3 mois)'}.</p>}
        <Field label="Motif"><Input value={f.reason} minLength={5} maxLength={300} onChange={(x) => setF({ ...f, reason: x.target.value })} required placeholder="Par exemple : accord écrit avec la direction, et sa date" /></Field>
        <CodeField value={f.code} onChange={(code) => setF({ ...f, code })} />
        <ErrorNote error={error} />
        <Button type="submit" loading={busy}>Activer le pilote</Button>
      </form>
    </DialogContent>
  );
}

function PilotEndDialog({ e, done }: { e: Establishment; done: () => void }) {
  const [f, setF] = useState({ pilotEnd: e.subscription?.pilotEnd ?? '', reason: '', code: '' });
  const { busy, error, submit } = useSubmit(done, 'Fin du pilote enregistrée');
  return (
    <DialogContent title={`Fin de la gratuité du pilote : ${e.name}`} description={`Fin actuelle : ${frDate(e.subscription?.pilotEnd)}. Jamais dans le passé ; les alertes suivent la nouvelle date.`}>
      <form className="grid gap-3" onSubmit={(ev) => { ev.preventDefault(); submit(() => pf('POST', `/billing/establishments/${e.id}/pilot-end`, f)); }}>
        <Field label="Dernier jour gratuit"><Input type="date" value={f.pilotEnd} min={e.today} onChange={(x) => setF({ ...f, pilotEnd: x.target.value })} required /></Field>
        <Field label="Motif"><Input value={f.reason} minLength={5} maxLength={300} onChange={(x) => setF({ ...f, reason: x.target.value })} required /></Field>
        <CodeField value={f.code} onChange={(code) => setF({ ...f, code })} />
        <ErrorNote error={error} />
        <Button type="submit" loading={busy}>Enregistrer</Button>
      </form>
    </DialogContent>
  );
}

/** Détails d'une ligne d'historique, en français : dates lisibles, rien de technique (identifiants, tarif brut). */
const EVENT_DETAILS: Record<string, string> = {
  trialStart: 'Début de l’essai', trialEnd: 'Dernier jour gratuit', trialDays: 'Jours d’essai',
  pilotStart: 'Début du pilote', pilotEnd: 'Dernier jour gratuit', pilotMonths: 'Mois gratuits',
  previousPilotEnd: 'Ancien dernier jour gratuit', lastFreeDay: 'Dernier jour gratuit', termsVersion: 'Version des conditions',
};
function eventDetails(data: Record<string, unknown>) {
  return Object.entries(data)
    .filter(([k, v]) => k in EVENT_DETAILS && (typeof v === 'string' || typeof v === 'number'))
    .map(([k, v]) => `${EVENT_DETAILS[k]} : ${typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? frDate(v) : v}`)
    .join(' · ');
}

function HistoryDialog({ e }: { e: Establishment }) {
  const [events, setEvents] = useState<Event[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    pf<Event[]>('GET', `/billing/establishments/${e.id}/events`).then(setEvents).catch(setError);
  }, [e.id]);
  return (
    <DialogContent title={`Historique de l’abonnement : ${e.name}`} description="En ajout seul : rien ne s’efface ni ne se modifie.">
      <ErrorNote error={error} />
      {events && (events.length === 0 ? <p className="text-sm text-muted">Aucun événement.</p> : (
        <ul className="grid max-h-[60vh] gap-2 overflow-y-auto">
          {events.map((ev) => (
            <li key={ev.id} className="rounded-lg bg-sunk p-2 text-sm">
              <b>{ev.label}</b>
              <span className="block text-xs text-muted">{new Date(ev.createdAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })} · {ev.actorName}</span>
              {ev.data && eventDetails(ev.data) && <span className="block text-xs">{eventDetails(ev.data)}</span>}
              {ev.reason && <span className="block text-xs">Motif : {ev.reason}</span>}
            </li>
          ))}
        </ul>
      ))}
    </DialogContent>
  );
}

// ---------------------------------------------------------------- Établissements clients et calendriers

function Etablissements() {
  const { list, error, load } = useEstablishments();
  const [open, setOpen] = useState<Establishment | null>(null);
  if (error) return <ErrorNote error={error} />;
  if (!list) return null;
  const byGroup = new Map<string, { name: string; items: Establishment[] }>();
  for (const e of list) {
    const g = byGroup.get(e.group.id) ?? { name: e.group.name, items: [] };
    g.items.push(e);
    byGroup.set(e.group.id, g);
  }
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted">Chaque établissement a son propre calendrier de facturation, même dans un groupe : début et fin de l’année, préparation, comptage initial, régularisations, renouvellement.</p>
      {[...byGroup.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name)).map(([id, g]) => (
        <Card key={id} className="grid gap-2">
          <h3 className="font-bold">{g.name}<span className="ml-2 text-xs font-normal text-muted">{g.items.length > 1 ? `groupe de ${g.items.length} établissements` : 'établissement indépendant'}</span></h3>
          <ul className="grid gap-2">
            {g.items.map((e) => (
              <li key={e.id} className="grid gap-1 rounded-lg bg-sunk p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span><b>{e.name}</b> <span className="text-muted">· {e.currency} · {e.timezone}</span> {e.subscription ? <Badge tone={STATUS_TONE[e.subscription.status]}>{e.subscription.statusLabel}</Badge> : <Badge tone="warn">Aucun abonnement</Badge>}</span>
                  <Button size="sm" variant="outline" onClick={() => setOpen(e)} aria-label={`Calendrier de facturation de ${e.name}`}><CalendarDays className="size-4" /> Calendrier</Button>
                </div>
                {e.calendars.length === 0 ? <span className="text-muted">Aucun calendrier de facturation.</span> : e.calendars.map((c) => (
                  <span key={c.id}>
                    <b>{c.yearLabel}</b> (version {c.version}, {c.formula === 'MANUEL' ? 'dates saisies' : `formule ${c.formula}, provisoire`}) : du {frDate(c.startDate)} au {frDate(c.endDate)} ; comptage initial le {frDate(c.initialCountDate)}, régularisations le {frDate(c.firstRegularizationDate)} et le {frDate(c.finalRegularizationDate)}{c.renewalDate ? ` ; renouvellement le ${frDate(c.renewalDate)}` : ''}.
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </Card>
      ))}
      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        {open && <CalendarDialog e={open} done={() => { setOpen(null); load(); }} />}
      </Dialog>
    </div>
  );
}

type CalendarData = {
  tenant: { id: string; name: string; today: string };
  versions: Calendar[];
  schoolYears: { label: string; startDate: string; endDate: string; isCurrent: boolean; proposals: Record<'A' | 'B', { initialCountDate: string; firstRegularizationDate: string; finalRegularizationDate: string }> }[];
};
const EMPTY_CAL = { yearLabel: '', startDate: '', endDate: '', preparationFrom: '', initialCountDate: '', firstRegularizationDate: '', finalRegularizationDate: '', renewalDate: '', formula: 'B' as 'A' | 'B' | 'MANUEL', reason: '', code: '' };

function CalendarDialog({ e, done }: { e: Establishment; done: () => void }) {
  const [data, setData] = useState<CalendarData | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [f, setF] = useState(EMPTY_CAL);
  const { busy, error, submit } = useSubmit(done, 'Calendrier enregistré');
  useEffect(() => {
    pf<CalendarData>('GET', `/billing/establishments/${e.id}/calendars`).then(setData).catch(setLoadError);
  }, [e.id]);
  /** Remplit les dates depuis la dernière version de cette année, sinon depuis l'année scolaire de l'école et la formule. */
  const fill = (yearLabel: string, formula: 'A' | 'B' | 'MANUEL') => {
    const v = data?.versions.find((x) => x.yearLabel === yearLabel);
    const y = data?.schoolYears.find((x) => x.label === yearLabel);
    if (v && formula === 'MANUEL') {
      setF({ ...f, yearLabel, formula, startDate: v.startDate, endDate: v.endDate, preparationFrom: v.preparationFrom ?? '', initialCountDate: v.initialCountDate, firstRegularizationDate: v.firstRegularizationDate, finalRegularizationDate: v.finalRegularizationDate, renewalDate: v.renewalDate ?? '' });
      return;
    }
    const start = v?.startDate ?? y?.startDate ?? f.startDate;
    const end = v?.endDate ?? y?.endDate ?? f.endDate;
    const p = formula !== 'MANUEL' && y && start === y.startDate && end === y.endDate ? y.proposals[formula] : null;
    setF({ ...f, yearLabel, formula, startDate: start, endDate: end, ...(p ?? {}), preparationFrom: v?.preparationFrom ?? f.preparationFrom, renewalDate: v?.renewalDate ?? f.renewalDate });
  };
  const versions = data?.versions.filter((v) => !f.yearLabel || v.yearLabel === f.yearLabel) ?? [];
  return (
    <DialogContent title={`Calendrier de facturation : ${e.name}`} description="Chaque enregistrement ajoute une version ; une date passée ne change plus. Formules A et B : proposition provisoire, la formule définitive attend votre décision D-G5-28.">
      <ErrorNote error={loadError} />
      {data && (
        <form className="grid max-h-[70vh] gap-3 overflow-y-auto pr-1" onSubmit={(ev) => {
          ev.preventDefault();
          submit(() => pf('POST', `/billing/establishments/${e.id}/calendars`, { ...f, preparationFrom: f.preparationFrom || null, renewalDate: f.renewalDate || null }));
        }}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Année scolaire" hint={data.schoolYears.length ? 'Années de l’école, ou saisie libre (2027 pour une année civile).' : 'L’école n’a encore aucune année scolaire.'}>
              <Input list={`annees-${e.id}`} value={f.yearLabel} onChange={(x) => fill(x.target.value, f.formula)} required placeholder="2026-2027" />
              <datalist id={`annees-${e.id}`}>{data.schoolYears.map((y) => <option key={y.label} value={y.label} />)}</datalist>
            </Field>
            <Field label="Formule des dates proposées">
              <Select value={f.formula} onChange={(x) => fill(f.yearLabel, x.target.value as 'A' | 'B' | 'MANUEL')}>
                <option value="B">B : à distance fixe (provisoire)</option>
                <option value="A">A : en proportion de l’année (provisoire)</option>
                <option value="MANUEL">Dates saisies à la main</option>
              </Select>
            </Field>
            <Field label="Début de l’année scolaire"><Input type="date" value={f.startDate} onChange={(x) => setF({ ...f, startDate: x.target.value })} required /></Field>
            <Field label="Fin de l’année scolaire"><Input type="date" value={f.endDate} onChange={(x) => setF({ ...f, endDate: x.target.value })} required /></Field>
            <Field label="Début de la préparation (facultatif)"><Input type="date" value={f.preparationFrom} onChange={(x) => setF({ ...f, preparationFrom: x.target.value })} /></Field>
            <Field label="Comptage initial"><Input type="date" value={f.initialCountDate} onChange={(x) => setF({ ...f, initialCountDate: x.target.value })} required /></Field>
            <Field label="Première régularisation"><Input type="date" value={f.firstRegularizationDate} onChange={(x) => setF({ ...f, firstRegularizationDate: x.target.value })} required /></Field>
            <Field label="Régularisation finale"><Input type="date" value={f.finalRegularizationDate} onChange={(x) => setF({ ...f, finalRegularizationDate: x.target.value })} required /></Field>
            <Field label="Renouvellement (facultatif)" hint="Mode de renouvellement : décision D-G5-12 en attente."><Input type="date" value={f.renewalDate} onChange={(x) => setF({ ...f, renewalDate: x.target.value })} /></Field>
          </div>
          <Field label="Motif"><Input value={f.reason} minLength={5} maxLength={300} onChange={(x) => setF({ ...f, reason: x.target.value })} required placeholder="Par exemple : calendrier communiqué par la direction" /></Field>
          <CodeField value={f.code} onChange={(code) => setF({ ...f, code })} />
          <ErrorNote error={error} />
          <Button type="submit" loading={busy}>Enregistrer cette version</Button>
          {versions.length > 0 && (
            <div className="grid gap-1 text-xs">
              <p className="font-bold">Versions enregistrées</p>
              {versions.map((v) => (
                <p key={v.id} className="rounded bg-sunk p-2">{v.yearLabel} v{v.version} ({v.formula}) : {frDate(v.initialCountDate)}, {frDate(v.firstRegularizationDate)}, {frDate(v.finalRegularizationDate)} · {v.createdByName}, {new Date(v.createdAt).toLocaleDateString('fr-FR')} · {v.reason}</p>
              ))}
            </div>
          )}
        </form>
      )}
    </DialogContent>
  );
}

// ---------------------------------------------------------------- Paramètres tarifaires et conditions commerciales

function Parametres({ open }: { open: (s: Section) => void }) {
  const [p, setP] = useState<Params | null>(null);
  const [terms, setTerms] = useState<{ today: string; current: Terms | null; versions: Terms[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [dialog, setDialog] = useState<'param' | 'terms' | null>(null);
  const load = useCallback(() => {
    pf<Params>('GET', '/billing/parameters').then(setP).catch(setError);
    pf<{ today: string; current: Terms | null; versions: Terms[] }>('GET', '/billing/terms').then(setTerms).catch(setError);
  }, []);
  useEffect(load, [load]);
  if (error) return <ErrorNote error={error} />;
  if (!p || !terms) return null;
  return (
    <div className="grid gap-4">
      <Card className="grid gap-3 p-0 sm:p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4">
          <div>
            <h3 className="font-bold">Paramètres tarifaires</h3>
            <p className="text-sm text-muted">Chaque changement a une date d’effet, jamais passée, et ne modifie jamais un document ou un engagement déjà validé.</p>
          </div>
          <Button onClick={() => setDialog('param')}><Plus className="size-4" /> Nouvelle valeur</Button>
        </div>
        <Table>
          <thead><tr><th>Paramètre</th><th>Valeur en vigueur</th><th>Depuis</th><th>Prochaine valeur</th><th>Sert au lot</th></tr></thead>
          <tbody>
            {p.current.map((c) => (
              <tr key={`${c.key}-${c.currency ?? ''}`}>
                <td>{c.label}{c.provisional && <Badge tone="warn" className="ml-2">Provisoire ({c.provisional})</Badge>}</td>
                <td className="font-bold">{paramValue(c.unit, c.value, c.currency)}</td>
                <td className="text-sm">{frDate(c.since)}</td>
                <td className="text-sm">{c.next ? `${paramValue(c.unit, c.next.value, c.currency)} le ${frDate(c.next.effectiveFrom)}` : '—'}</td>
                <td className="text-sm">{c.usedFrom}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="px-4 pb-4 text-xs text-muted">Prix des SMS : lot G5e (INFORMATION MANQUANTE). Dates de régularisation : calendrier de chaque établissement.</p>
      </Card>
      <Card className="grid gap-2">
        <h3 className="font-bold">Tarification et prestations</h3>
        <p className="text-sm text-muted">Les prix des prestations complémentaires (formation, paramétrage, intervention sur site), leurs remises, tarifs particuliers et gratuités se règlent dans la rubrique « Prestations complémentaires ».</p>
        <Button variant="outline" className="justify-self-start" onClick={() => open('prestations')}>Ouvrir les prestations complémentaires</Button>
      </Card>
      <Card className="grid gap-2">
        <h3 className="font-bold">Historique des valeurs</h3>
        <ul className="grid max-h-80 gap-1 overflow-y-auto text-sm">
          {p.history.map((h) => {
            const unit = p.definitions.find((d) => d.key === h.key)?.unit ?? 'days';
            return <li key={h.id} className="rounded bg-sunk px-3 py-1.5"><b>{h.label}</b> : {paramValue(unit, h.value, h.currency)} à partir du {frDate(h.effectiveFrom)} <span className="text-muted">· {h.createdByName} · {h.reason}</span></li>;
          })}
        </ul>
      </Card>
      <Card className="grid gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-bold">Conditions commerciales</h3>
          <Button variant="outline" onClick={() => setDialog('terms')}><Plus className="size-4" /> Publier une version</Button>
        </div>
        {terms.current ? (
          <div className="grid gap-1 text-sm">
            <p>Version {terms.current.version} en vigueur depuis le {frDate(terms.current.effectiveFrom)} : <b>{terms.current.title}</b></p>
            <p className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-sunk p-2">{terms.current.body}</p>
          </div>
        ) : <p className="rounded bg-warn-soft p-2 text-sm">INFORMATION MANQUANTE : aucun texte de conditions commerciales n’est publié. Tant qu’il manque, aucune direction ne peut accepter les conditions à la fin de son essai.</p>}
        {terms.versions.length > 0 && <p className="text-xs text-muted">Versions : {terms.versions.map((t) => `v${t.version} (${frDate(t.effectiveFrom)})`).join(', ')}</p>}
      </Card>
      <Dialog open={!!dialog} onOpenChange={(o) => !o && setDialog(null)}>
        {dialog === 'param' && <ParamDialog p={p} done={() => { setDialog(null); load(); }} />}
        {dialog === 'terms' && <TermsDialog today={terms.today} done={() => { setDialog(null); load(); }} />}
      </Dialog>
    </div>
  );
}

function ParamDialog({ p, done }: { p: Params; done: () => void }) {
  const [f, setF] = useState({ key: p.definitions[0].key, currency: 'XOF', value: '', effectiveFrom: p.today, reason: '', code: '' });
  const def = p.definitions.find((d) => d.key === f.key)!;
  const { busy, error, submit } = useSubmit(done, 'Nouvelle valeur enregistrée');
  const toInt = () => (def.unit === 'percent' ? Math.round(Number(f.value.replace(',', '.')) * 100) : Number(f.value));
  return (
    <DialogContent title="Nouvelle valeur d’un paramètre" description="Elle s’applique à partir de sa date d’effet, jamais avant ; l’ancienne valeur reste dans l’historique.">
      <form className="grid gap-3" onSubmit={(ev) => { ev.preventDefault(); submit(() => pf('POST', '/billing/parameters', { key: f.key, currency: def.unit === 'money' ? f.currency : null, value: toInt(), effectiveFrom: f.effectiveFrom, reason: f.reason, code: f.code })); }}>
        <Field label="Paramètre">
          <Select value={f.key} onChange={(x) => setF({ ...f, key: x.target.value })}>{p.definitions.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}</Select>
        </Field>
        {def.unit === 'money' && <Field label="Monnaie"><Select value={f.currency} onChange={(x) => setF({ ...f, currency: x.target.value })}>{p.currencies.map((c) => <option key={c} value={c}>{c}</option>)}</Select></Field>}
        <Field label={def.unit === 'money' ? 'Montant' : def.unit === 'percent' ? 'Pourcentage' : def.unit === 'days' ? 'Nombre de jours' : 'Nombre de mois'} hint={def.unit === 'percent' ? 'Par exemple 15 pour 15 %.' : undefined}>
          <Input inputMode="decimal" value={f.value} onChange={(x) => setF({ ...f, value: x.target.value })} required />
        </Field>
        <Field label="Date d’effet" hint="Aujourd’hui au plus tôt."><Input type="date" min={p.today} value={f.effectiveFrom} onChange={(x) => setF({ ...f, effectiveFrom: x.target.value })} required /></Field>
        <Field label="Motif"><Input value={f.reason} minLength={5} maxLength={300} onChange={(x) => setF({ ...f, reason: x.target.value })} required /></Field>
        <CodeField value={f.code} onChange={(code) => setF({ ...f, code })} />
        <ErrorNote error={error} />
        <Button type="submit" loading={busy}>Enregistrer</Button>
      </form>
    </DialogContent>
  );
}

function TermsDialog({ today, done }: { today: string; done: () => void }) {
  const [f, setF] = useState({ title: '', body: '', effectiveFrom: today, code: '' });
  const { busy, error, submit } = useSubmit(done, 'Conditions commerciales publiées');
  return (
    <DialogContent title="Publier une version des conditions commerciales" description="Le texte vient de vous : Cahiora ne le rédige pas à votre place. La direction l’accepte à la fin de son essai ou de son pilote.">
      <form className="grid gap-3" onSubmit={(ev) => { ev.preventDefault(); submit(() => pf('POST', '/billing/terms', f)); }}>
        <Field label="Titre"><Input value={f.title} minLength={3} maxLength={160} onChange={(x) => setF({ ...f, title: x.target.value })} required /></Field>
        <Field label="Texte des conditions"><Textarea rows={10} value={f.body} minLength={20} maxLength={30000} onChange={(x) => setF({ ...f, body: x.target.value })} required /></Field>
        <Field label="Date d’effet"><Input type="date" min={today} value={f.effectiveFrom} onChange={(x) => setF({ ...f, effectiveFrom: x.target.value })} required /></Field>
        <CodeField value={f.code} onChange={(code) => setF({ ...f, code })} />
        <ErrorNote error={error} />
        <Button type="submit" loading={busy}>Publier</Button>
      </form>
    </DialogContent>
  );
}
