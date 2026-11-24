'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { BadgeCheck, Bell, CalendarDays, FlaskConical, History, Play, Plus, Users } from 'lucide-react';
import { Badge, Button, Card, Chips, Dialog, DialogContent, Empty, ErrorNote, Field, Input, Missing, Select, Stat, Table, Textarea, useToast } from '@/components/ui';
import { pf } from '@/lib/platform';
import { Acces } from './acces';
import { Documents } from './documents';
import { CodeField, frDate, money, need, ready, useSubmit } from './facturation-outils';
import { AvoirsCredits, moneyRows, Paiements, Rapports } from './paiements';
import { Prestations } from './prestations';

/**
 * Commercial et facturation (lot G5a) : vue d'ensemble, abonnements, établissements clients et leurs calendriers,
 * paramètres tarifaires datés et conditions commerciales ; prestations complémentaires (lot G5g, ./prestations.tsx) ;
 * comptages des élèves de chaque établissement, en nombres seulement (lot G5b) ; documents provisoires, exclusions à
 * décider, devis et proformas de prestations (lot G5c, ./documents.tsx) ; accès des clients selon le paiement, demandes de
 * régularisation et prolongations (lot G5d-1, ./acces.tsx) ; paiements, avoirs et crédits, rapports financiers (lot
 * G5d-2, ./paiements.tsx, verrou du serveur fermé par défaut). Les autres rubriques arrivent avec les lots G5e à G5h.
 * Chaque opération financière demande un code actuel de l'application d'authentification.
 * Statut commercial (ajustements du 20 novembre 2026) : un établissement de test n'est jamais facturé ni limité ; seul le
 * Super Admin le passe en client réel, tant qu'aucun abonnement ni document n'existe pour lui.
 */

type Status = 'TRIAL' | 'PILOT' | 'AWAITING_ACCEPTANCE' | 'AWAITING_PAYMENT' | 'ACTIVE' | 'LIMITED';
type Sub = {
  id: string; status: Status; statusLabel: string; statusSince: string; trialStart: string | null; trialEnd: string | null; trialDays: number | null;
  pilotStart: string | null; pilotEnd: string | null; pilotMonths: number | null; freeDaysLeft: number | null; acceptedAt: string | null; acceptedByName: string | null;
  acceptedTariff: { currency: string; pricePerPupil: number; minimum: number } | null;
};
type Calendar = {
  id: string; yearLabel: string; version: number; startDate: string; endDate: string; preparationFrom: string | null; initialCountDate: string;
  firstRegularizationDate: string; finalRegularizationDate: string; renewalDate: string | null; formula: string; adjusted: boolean; reason: string; createdByName: string; createdAt: string;
};
/** « dates saisies », « formule B, provisoire » ou, après un changement à la main, « formule B, provisoire, ajustée ». */
const formulaLabel = (c: Pick<Calendar, 'formula' | 'adjusted'>) => (c.formula === 'MANUEL' ? 'dates saisies' : `formule ${c.formula}, provisoire${c.adjusted ? ', ajustée' : ''}`);
/** Un comptage des élèves (lot G5b) : des nombres et l'empreinte de la liste, jamais un nom. */
type PupilCount = {
  id: string; yearLabel: string; kind: string; kindLabel: string; referenceDate: string; stage: 'PROVISIONAL' | 'FROZEN'; stageLabel: string; pupils: number; cumulative: number;
  toCheck: number; excluded: number; listHash: string; knownAt: string; reviewUntil: string | null; reviewOpen: boolean; frozen: boolean;
};
type Commercial = 'TEST' | 'CLIENT';
type Establishment = {
  id: string; slug: string; name: string; status: 'ACTIVE' | 'SUSPENDED'; country: string; currency: string; timezone: string; today: string; createdOn: string; demo: boolean;
  group: { id: string; name: string }; subscription: Sub | null; calendars: Calendar[]; counts: PupilCount[];
  /** Statut commercial : « Établissement de test » (jamais facturé ni limité) ou « Client réel » ; figé dès qu'un abonnement ou un document existe. */
  commercialStatus: Commercial; commercialStatusLabel: string; commercialStatusAt: string | null; commercialStatusNote: string | null; canChangeCommercialStatus: boolean;
};
type Overview = {
  /** `none` et les états d'abonnement ne comptent que les clients réels ; les établissements de test sont comptés à part. */
  counts: { establishments: number; none: number; testEstablishments: number; clientEstablishments: number } & Record<Status, number>;
  soon: { tenantId: string; tenantName: string; group: string; kind: 'TRIAL' | 'PILOT'; lastDay: string; daysLeft: number }[];
  unreadAlerts: number;
  /** Par monnaie (lot G5d-2) ; null tant que le lot qui les apporte n'est pas là (amountsFrom). */
  amounts: Record<string, { currency: string; amount: number }[] | null>;
  amountsFrom: Record<string, string>;
  /** 24 novembre 2026 : indicateurs réels, clients réels seulement. */
  amountsScope: string;
};
type Alert = { id: string; tenantName: string | null; kind: string; message: string; dueDate: string | null; readAt: string | null; createdAt: string };
type Param = { key: string; currency: string | null; label: string; unit: 'money' | 'hours' | 'days' | 'months' | 'percent'; usedFrom: string; provisional?: string; value: number | null; since: string | null; next: { value: number; effectiveFrom: string } | null };
type Params = {
  today: string; currencies: string[];
  definitions: { key: string; label: string; unit: Param['unit']; min: number; max: number; usedFrom: string; provisional?: string }[];
  current: Param[];
  /** Délais proposés par Cahiora (G5c-1), sans aucun effet tant qu'aucune valeur n'est saisie. */
  proposals: { key: string; label: string; unit: Param['unit']; usedFrom: string; provisional?: string; proposed: number }[];
  history: { id: string; key: string; label: string; currency: string | null; value: number; effectiveFrom: string; reason: string; createdByName: string; createdAt: string }[];
};
type Terms = { id: string; version: number; title: string; body: string; effectiveFrom: string; createdByName: string; createdAt: string };
type Event = { id: string; kind: string; label: string; createdAt: string; actorName: string; actorKind: string; reason: string | null; data: Record<string, unknown> | null };

type Section = 'ensemble' | 'abonnements' | 'acces' | 'etablissements' | 'documents' | 'paiements' | 'avoirs' | 'prestations' | 'parrainage' | 'partenaires' | 'sms' | 'rapports' | 'parametres';
const LATER: Partial<Record<Section, [string, string]>> = {
  parrainage: ['G5h', 'Codes de parrainage, écoles filleules et crédits de 5 000 FCFA après le premier paiement confirmé.'],
  partenaires: ['G5h', 'Apporteurs d’affaires et partenaires premium, commissions et versements.'],
  sms: ['G5e', 'Crédits SMS prépayés par établissement (prix et forfaits : INFORMATION MANQUANTE).'],
};

const UNIT_SUFFIX = { hours: 'heures', days: 'jours', months: 'mois' } as const;
function paramValue(unit: Param['unit'], value: number | null, currency: string | null) {
  if (value === null) return 'INFORMATION MANQUANTE';
  if (unit === 'money') return money(value, currency);
  if (unit === 'percent') return `${(value / 100).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} %`;
  return `${value} ${UNIT_SUFFIX[unit]}`;
}
const STATUS_TONE: Record<Status, 'info' | 'good' | 'warn' | 'bad' | 'accent'> = {
  TRIAL: 'info', PILOT: 'accent', AWAITING_ACCEPTANCE: 'warn', AWAITING_PAYMENT: 'warn', ACTIVE: 'good', LIMITED: 'bad',
};
/**
 * Confirmation cochée pour passer un établissement en client réel : même texte que CLIENT_ATTESTATION dans l'API
 * (apps/api/src/modules/billing/billing.ts), qui l'inscrit dans les journaux.
 */
const CLIENT_ATTESTATION =
  'Je confirme que cet établissement est un client commercial réel de Cahiora : il pourra recevoir un essai, un pilote, des documents provisoires et des demandes de paiement.';
const COMMERCIAL_FILTER: { value: '' | Commercial; label: string }[] = [
  { value: '', label: 'Tous les statuts' }, { value: 'TEST', label: 'Établissements de test' }, { value: 'CLIENT', label: 'Clients réels' },
];
/**
 * Statut commercial, bien distinct de l'état de l'abonnement (24 novembre 2026) : « Établissement de test » en contour
 * pointillé orange avec une fiole, « Client réel » en plein avec une coche.
 */
function CommercialBadge({ e, className = '' }: { e: Pick<Establishment, 'commercialStatus' | 'commercialStatusLabel'>; className?: string }) {
  return e.commercialStatus === 'TEST'
    ? <Badge tone="accent" className={`border border-dashed border-orange ${className}`} title="Jamais facturé ni limité"><FlaskConical className="size-3.5" aria-hidden /> Établissement de test</Badge>
    : <Badge className={`bg-brand text-brand-ink ${className}`}><BadgeCheck className="size-3.5" aria-hidden /> {e.commercialStatusLabel}</Badge>;
}
const STATUS_FILTER: { value: string; label: string }[] = [
  { value: '', label: 'Tous les états' }, { value: 'none', label: 'Sans abonnement' }, { value: 'TRIAL', label: 'Essai gratuit' }, { value: 'PILOT', label: 'École pilote' },
  { value: 'AWAITING_ACCEPTANCE', label: 'Conditions à accepter' }, { value: 'AWAITING_PAYMENT', label: 'En attente de paiement' }, { value: 'ACTIVE', label: 'Abonnement actif' },
  { value: 'LIMITED', label: 'Accès limité' },
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
        { value: 'ensemble', label: 'Vue d’ensemble' }, { value: 'abonnements', label: 'Abonnements' }, { value: 'acces', label: 'Accès des clients' },
        { value: 'etablissements', label: 'Établissements clients' },
        { value: 'documents', label: 'Factures et documents' }, { value: 'paiements', label: 'Paiements' }, { value: 'avoirs', label: 'Avoirs et crédits' },
        { value: 'prestations', label: 'Prestations complémentaires' }, { value: 'parrainage', label: 'Parrainage' }, { value: 'partenaires', label: 'Partenaires et commissions' },
        { value: 'sms', label: 'SMS et crédits' }, { value: 'rapports', label: 'Rapports financiers' }, { value: 'parametres', label: 'Paramètres tarifaires' },
      ]} />
      {section === 'ensemble' && <Ensemble />}
      {section === 'abonnements' && <Abonnements />}
      {section === 'acces' && <Acces />}
      {section === 'etablissements' && <Etablissements />}
      {section === 'documents' && <Documents />}
      {section === 'paiements' && <Paiements />}
      {section === 'avoirs' && <AvoirsCredits />}
      {section === 'rapports' && <Rapports />}
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
        <Stat label="Établissements" value={c.establishments} detail={`${c.testEstablishments} de test · ${c.clientEstablishments} client${c.clientEstablishments > 1 ? 's' : ''} réel${c.clientEstablishments > 1 ? 's' : ''}`} />
        <Stat label="En essai" value={c.TRIAL} />
        <Stat label="Écoles pilotes" value={c.PILOT} />
        <Stat label="Abonnés actifs" value={c.ACTIVE} detail="Document de la fin de la gratuité payé" />
        <Stat label="Conditions à accepter" value={c.AWAITING_ACCEPTANCE} tone={c.AWAITING_ACCEPTANCE ? 'warn' : undefined} />
        <Stat label="En attente de paiement" value={c.AWAITING_PAYMENT} tone={c.AWAITING_PAYMENT ? 'warn' : undefined} />
        <Stat label="Accès limité" value={c.LIMITED} detail="Abonnement non régularisé (lot G5d-1)" tone={c.LIMITED ? 'bad' : undefined} />
        <Stat label="Alertes non lues" value={o.unreadAlerts} tone={o.unreadAlerts ? 'warn' : undefined} />
      </div>
      <p className="rounded-lg bg-sunk p-3 text-sm" aria-label="Établissements de test">
        {c.testEstablishments
          ? `${c.testEstablishments === 1 ? 'L’établissement de test n’est' : `Les ${c.testEstablishments} établissements de test ne sont`} jamais facturé${c.testEstablishments > 1 ? 's' : ''} ni limité${c.testEstablishments > 1 ? 's' : ''} : ${c.testEstablishments === 1 ? 'il ne compte' : 'ils ne comptent'} que dans le total des établissements. `
          : 'Aucun établissement de test. '}
        Clients réels sans abonnement : {c.none}.
      </p>
      <Card className="grid gap-2">
        <h3 className="font-bold">Montants</h3>
        <p className="text-sm text-muted">Facturé et encaissé ne se confondent jamais : chaque montant est donné par monnaie, documents provisoires d’un côté, paiements validés par Cahiora de l’autre. Le détail est dans Rapports financiers.</p>
        <p className="text-sm font-bold" data-testid="portee-indicateurs">{o.amountsScope}</p>
        <ul className="grid gap-1 text-sm sm:grid-cols-2" aria-label="Montants">
          {([['billed', 'Facturé'], ['credited', 'Avoirs'], ['collected', 'Encaissé'], ['refunded', 'Remboursé'], ['unpaid', 'Impayés'], ['groupPending', 'Documents de groupe en attente'], ['clientCredits', 'Crédits des clients'], ['servicesRevenue', 'Prestations'], ['commissionsDue', 'Commissions dues'], ['commissionsPaid', 'Commissions payées']] as const).map(([k, label]) => {
            const rows = o.amounts[k];
            return (
              <li key={k} className="flex justify-between gap-2 rounded bg-sunk px-3 py-1.5">
                <span>{label}</span>{rows ? <b className="tabular text-right">{moneyRows(rows)}</b> : <span className="text-muted">— (lot {o.amountsFrom[k]})</span>}
              </li>
            );
          })}
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
        <p className="text-xs text-muted">Les tâches passent seules toutes les heures : rappels et fin d’essai, alertes avant la fin d’un pilote, fin de pilote, rappels pendant le délai de grâce ou une prolongation, accès limité quand le délai est passé, comptages des élèves, documents provisoires.</p>
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
  const [commercial, setCommercial] = useState<'' | Commercial>('');
  const [status, setStatus] = useState('');
  const [dialog, setDialog] = useState<{ kind: 'trial' | 'pilot' | 'pilotEnd' | 'history' | 'commercial'; e: Establishment } | null>(null);
  const groups = useMemo(() => [...new Map((list ?? []).map((e) => [e.group.id, e.group.name])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [list]);
  if (error) return <ErrorNote error={error} />;
  if (!list) return null;
  const shown = list.filter((e) => (!group || e.group.id === group) && (!commercial || e.commercialStatus === commercial)
    && (!status || (status === 'none' ? !e.subscription : e.subscription?.status === status)));
  const testNote = list.find((e) => e.commercialStatusNote)?.commercialStatusNote;
  return (
    <div className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Groupe"><Select value={group} onChange={(e) => setGroup(e.target.value)}><option value="">Tous les groupes</option>{groups.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</Select></Field>
        <Field label="Statut commercial"><Select value={commercial} onChange={(e) => setCommercial(e.target.value as '' | Commercial)}>{COMMERCIAL_FILTER.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</Select></Field>
        <Field label="État"><Select value={status} onChange={(e) => setStatus(e.target.value)}>{STATUS_FILTER.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</Select></Field>
      </div>
      {testNote && (
        <p className="rounded-lg bg-sunk p-3 text-sm">
          {testNote} Le statut se change seulement tant qu’aucun abonnement ni document n’existe pour l’établissement, avec un motif et votre code.
        </p>
      )}
      {shown.length === 0 ? <Empty title="Aucun établissement">Aucun établissement ne correspond à ces filtres.</Empty> : (
        <Card className="overflow-x-auto p-0">
          <Table>
            <thead><tr><th>Établissement</th><th>Groupe</th><th>État</th><th>Gratuité ou acceptation</th><th /></tr></thead>
            <tbody>
              {shown.map((e) => (
                <tr key={e.id}>
                  <td className="font-bold">{e.name}<CommercialBadge e={e} className="ml-2" />{e.demo && <Badge tone="info" className="ml-2">Démo</Badge>}<span className="block text-xs font-normal text-muted">{e.slug} · {e.currency}</span></td>
                  <td className="text-sm">{e.group.name}</td>
                  <td>
                    {e.commercialStatus === 'TEST' ? (
                      e.subscription ? (
                        <span className="flex flex-col items-start gap-1"><Badge tone="info">{e.subscription.statusLabel}</Badge><span className="text-xs text-muted">Abonnement de test figé : jamais facturé ni limité</span></span>
                      ) : <span className="text-sm text-muted">Jamais facturé ni limité</span>
                    ) : e.subscription ? <Badge tone={STATUS_TONE[e.subscription.status]}>{e.subscription.statusLabel}</Badge> : <Badge tone="warn">Aucun abonnement</Badge>}
                  </td>
                  <td className="text-sm">{e.subscription ? <Freedom s={e.subscription} /> : <span className="text-muted">—</span>}</td>
                  <td>
                    <div className="flex flex-wrap justify-end gap-1">
                      {e.canChangeCommercialStatus && (
                        <Button size="sm" variant={e.commercialStatus === 'TEST' ? 'outline' : 'ghost'} onClick={() => setDialog({ kind: 'commercial', e })}>
                          {e.commercialStatus === 'TEST' ? 'Passer en client réel' : 'Repasser en test'}
                        </Button>
                      )}
                      {e.commercialStatus === 'CLIENT' && !e.subscription && <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'trial', e })}>Ouvrir l’essai</Button>}
                      {e.commercialStatus === 'CLIENT' && (!e.subscription || e.subscription.status === 'TRIAL') && <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'pilot', e })}>École pilote</Button>}
                      {e.commercialStatus === 'CLIENT' && e.subscription?.status === 'PILOT' && <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'pilotEnd', e })}>Fin du pilote</Button>}
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
        {dialog?.kind === 'commercial' && <CommercialStatusDialog e={dialog.e} done={() => { setDialog(null); load(); }} />}
      </Dialog>
    </div>
  );
}

/**
 * Statut commercial d'un établissement (ajustements du 20 novembre 2026) : vers « client réel » avec la confirmation
 * cochée, un motif et le code ; retour « test » seulement tant qu'aucun abonnement ni document n'existe.
 */
function CommercialStatusDialog({ e, done }: { e: Establishment; done: () => void }) {
  const to: Commercial = e.commercialStatus === 'TEST' ? 'CLIENT' : 'TEST';
  // Case de confirmation toujours décochée à l'ouverture ; bouton désactivé tant que le motif, la case ou le code manque
  // (24 novembre 2026).
  const [f, setF] = useState({ reason: '', confirmed: false, code: '' });
  const { busy, error, submit } = useSubmit(done, to === 'CLIENT' ? `${e.name} est maintenant un client réel` : `${e.name} est de nouveau un établissement de test`);
  const missing = [need.text(f.reason, 'le motif'), to === 'CLIENT' && !f.confirmed && 'la case de confirmation', need.code(f.code)];
  return (
    <DialogContent
      title={to === 'CLIENT' ? `Passer en client réel : ${e.name}` : `Repasser en établissement de test : ${e.name}`}
      description={to === 'CLIENT'
        ? 'Seul un client commercial réel de Cahiora passe en « client réel » : il pourra recevoir un essai gratuit, une période pilote, des documents provisoires et des demandes de paiement. Le statut ne change plus dès qu’un abonnement ou un document existe.'
        : 'Un établissement de test n’est jamais facturé ni limité. Ce retour est possible tant qu’aucun abonnement ni document n’existe pour lui.'}>
      <form className="grid gap-3" onSubmit={(ev) => {
        ev.preventDefault();
        submit(() => pf('POST', `/billing/establishments/${e.id}/commercial-status`, { status: to, reason: f.reason, ...(to === 'CLIENT' ? { confirmed: f.confirmed } : {}), code: f.code }));
      }}>
        <Field label="Motif">
          <Input value={f.reason} minLength={5} maxLength={300} onChange={(x) => setF({ ...f, reason: x.target.value })} required
            placeholder={to === 'CLIENT' ? 'Par exemple : accord de la direction pour un abonnement, et sa date' : 'Par exemple : établissement créé pour des essais'} />
        </Field>
        {to === 'CLIENT' && (
          <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-line p-3 text-sm">
            <input type="checkbox" className="mt-1 size-5 flex-none accent-[var(--brand)]" checked={f.confirmed} onChange={(x) => setF({ ...f, confirmed: x.target.checked })} required />
            <span>{CLIENT_ATTESTATION}</span>
          </label>
        )}
        <CodeField value={f.code} onChange={(code) => setF({ ...f, code })} />
        <ErrorNote error={error} />
        <Button type="submit" loading={busy} disabled={!ready(missing)}>{to === 'CLIENT' ? 'Passer en client réel' : 'Repasser en test'}</Button>
        <Missing items={missing} />
      </form>
    </DialogContent>
  );
}

function TrialDialog({ e, done }: { e: Establishment; done: () => void }) {
  const [f, setF] = useState({ startDate: e.today, reason: '', code: '' });
  const { busy, error, submit } = useSubmit(done, `Essai gratuit ouvert pour ${e.name}`);
  const missing = [need.value(f.startDate, 'le premier jour de l’essai'), need.code(f.code)];
  return (
    <DialogContent title={`Ouvrir l’essai gratuit : ${e.name}`} description="La durée est celle du paramètre en vigueur (14 jours) ; le jour d’ouverture compte comme le jour 1.">
      <form className="grid gap-3" onSubmit={(ev) => { ev.preventDefault(); submit(() => pf('POST', `/billing/establishments/${e.id}/trial`, { startDate: f.startDate, reason: f.reason || undefined, code: f.code })); }}>
        <Field label="Premier jour de l’essai" hint={`Aujourd’hui pour l’établissement : ${frDate(e.today)}.`}><Input type="date" value={f.startDate} onChange={(x) => setF({ ...f, startDate: x.target.value })} required /></Field>
        <Field label="Motif (facultatif)"><Input value={f.reason} maxLength={300} onChange={(x) => setF({ ...f, reason: x.target.value })} /></Field>
        <CodeField value={f.code} onChange={(code) => setF({ ...f, code })} />
        <ErrorNote error={error} />
        <Button type="submit" loading={busy} disabled={!ready(missing)}>Ouvrir l’essai</Button>
        <Missing items={missing} />
      </form>
    </DialogContent>
  );
}

function PilotDialog({ e, done }: { e: Establishment; done: () => void }) {
  const [f, setF] = useState({ startDate: '', months: '', reason: '', code: '' });
  const { busy, error, submit } = useSubmit(done, `${e.name} est école pilote partenaire`);
  const preview = pilotEndPreview(f.startDate, Number(f.months) || 3);
  const missing = [need.value(f.startDate, 'la date d’activation effective du pilote'), need.text(f.reason, 'le motif'), need.code(f.code)];
  return (
    <DialogContent title={`École pilote partenaire CAHIORA : ${e.name}`} description="Gratuité à partir de l’activation effective du pilote, que vous saisissez. Rien n’est facturé pour la période pilote, ni rétroactivement après elle.">
      <form className="grid gap-3" onSubmit={(ev) => { ev.preventDefault(); submit(() => pf('POST', `/billing/establishments/${e.id}/pilot`, { startDate: f.startDate, months: f.months ? Number(f.months) : undefined, reason: f.reason, code: f.code })); }}>
        <Field label="Date d’activation effective du pilote" hint="Aucune date n’est proposée : c’est votre accord avec l’école."><Input type="date" value={f.startDate} onChange={(x) => setF({ ...f, startDate: x.target.value })} required /></Field>
        <Field label="Durée de la gratuité, en mois" hint="Vide : le paramètre en vigueur (3 mois)."><Input type="number" min={1} max={24} value={f.months} onChange={(x) => setF({ ...f, months: x.target.value })} /></Field>
        {preview && <p className="rounded bg-sunk p-2 text-sm">Dernier jour gratuit : <b>{frDate(preview)}</b>{!f.months && ' (avec 3 mois)'}.</p>}
        <Field label="Motif"><Input value={f.reason} minLength={5} maxLength={300} onChange={(x) => setF({ ...f, reason: x.target.value })} required placeholder="Par exemple : accord écrit avec la direction, et sa date" /></Field>
        <CodeField value={f.code} onChange={(code) => setF({ ...f, code })} />
        <ErrorNote error={error} />
        <Button type="submit" loading={busy} disabled={!ready(missing)}>Activer le pilote</Button>
        <Missing items={missing} />
      </form>
    </DialogContent>
  );
}

function PilotEndDialog({ e, done }: { e: Establishment; done: () => void }) {
  const [f, setF] = useState({ pilotEnd: e.subscription?.pilotEnd ?? '', reason: '', code: '' });
  const { busy, error, submit } = useSubmit(done, 'Fin du pilote enregistrée');
  const missing = [need.value(f.pilotEnd, 'le dernier jour gratuit'), need.text(f.reason, 'le motif'), need.code(f.code)];
  return (
    <DialogContent title={`Fin de la gratuité du pilote : ${e.name}`} description={`Fin actuelle : ${frDate(e.subscription?.pilotEnd)}. Jamais dans le passé ; les alertes suivent la nouvelle date.`}>
      <form className="grid gap-3" onSubmit={(ev) => { ev.preventDefault(); submit(() => pf('POST', `/billing/establishments/${e.id}/pilot-end`, f)); }}>
        <Field label="Dernier jour gratuit"><Input type="date" value={f.pilotEnd} min={e.today} onChange={(x) => setF({ ...f, pilotEnd: x.target.value })} required /></Field>
        <Field label="Motif"><Input value={f.reason} minLength={5} maxLength={300} onChange={(x) => setF({ ...f, reason: x.target.value })} required /></Field>
        <CodeField value={f.code} onChange={(code) => setF({ ...f, code })} />
        <ErrorNote error={error} />
        <Button type="submit" loading={busy} disabled={!ready(missing)}>Enregistrer</Button>
        <Missing items={missing} />
      </form>
    </DialogContent>
  );
}

/** Détails d'une ligne d'historique, en français : dates lisibles, rien de technique (identifiants, tarif brut). */
const EVENT_DETAILS: Record<string, string> = {
  trialStart: 'Début de l’essai', trialEnd: 'Dernier jour gratuit', trialDays: 'Jours d’essai',
  pilotStart: 'Début du pilote', pilotEnd: 'Dernier jour gratuit', pilotMonths: 'Mois gratuits',
  previousPilotEnd: 'Ancien dernier jour gratuit', lastFreeDay: 'Dernier jour gratuit', termsVersion: 'Version des conditions',
  graceDays: 'Jours de grâce', graceStart: 'Début du délai de grâce', graceEnd: 'Fin du délai de grâce', until: 'Accès complet jusqu’au',
  previousUntil: 'Prolongation précédente jusqu’au', extendedUntil: 'Prolongation jusqu’au', lastFullAccessDay: 'Dernier jour d’accès complet',
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
  const [counts, setCounts] = useState<Establishment | null>(null);
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
                  <span><b>{e.name}</b> <span className="text-muted">· {e.currency} · {e.timezone}</span> <CommercialBadge e={e} /> {e.commercialStatus === 'TEST' ? null : e.subscription ? <Badge tone={STATUS_TONE[e.subscription.status]}>{e.subscription.statusLabel}</Badge> : <Badge tone="warn">Aucun abonnement</Badge>}</span>
                  <div className="flex flex-wrap gap-1">
                    {/* Un établissement de test n'est jamais compté : le bouton ne sert qu'aux clients réels (ou à un ancien comptage). */}
                    {(e.commercialStatus === 'CLIENT' || e.counts.length > 0) && <Button size="sm" variant="outline" onClick={() => setCounts(e)} aria-label={`Comptages des élèves de ${e.name}`}><Users className="size-4" /> Comptages</Button>}
                    <Button size="sm" variant="outline" onClick={() => setOpen(e)} aria-label={`Calendrier de facturation de ${e.name}`}><CalendarDays className="size-4" /> Calendrier</Button>
                  </div>
                </div>
                {e.calendars.length === 0 ? <span className="text-muted">Aucun calendrier de facturation.</span> : e.calendars.map((c) => (
                  <span key={c.id}>
                    <b>{c.yearLabel}</b> (version {c.version}, {formulaLabel(c)}) : du {frDate(c.startDate)} au {frDate(c.endDate)} ; comptage initial le {frDate(c.initialCountDate)}, régularisations le {frDate(c.firstRegularizationDate)} et le {frDate(c.finalRegularizationDate)}{c.renewalDate ? ` ; renouvellement le ${frDate(c.renewalDate)}` : ''}.
                    {c.adjusted && <span className="text-muted"> Motif de l’ajustement : {c.reason}</span>}
                  </span>
                ))}
                {e.counts[0] && <LastCount c={e.counts[0]} />}
              </li>
            ))}
          </ul>
        </Card>
      ))}
      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        {open && <CalendarDialog e={open} done={() => { setOpen(null); load(); }} />}
      </Dialog>
      <Dialog open={!!counts} onOpenChange={(o) => !o && setCounts(null)}>
        {counts && <CountsDialog e={counts} />}
      </Dialog>
    </div>
  );
}

const pupilsText = (n: number) => `${n} élève${n > 1 ? 's' : ''}`;

function LastCount({ c }: { c: PupilCount }) {
  return (
    <span>
      Dernier comptage : {c.kindLabel.toLowerCase()} du {frDate(c.referenceDate)}, {c.stageLabel.toLowerCase()} : <b>{pupilsText(c.pupils)}</b>
      {c.reviewOpen ? ` (vérification par la direction jusqu’au ${frDate(c.reviewUntil)} inclus)` : ''}.
    </span>
  );
}

/** Comptages des élèves d'un établissement (lot G5b) : nombres, dates et empreinte ; la liste nominative reste dans l'école. */
function CountsDialog({ e }: { e: Establishment }) {
  return (
    <DialogContent title={`Comptages des élèves : ${e.name}`} description="Des nombres seulement : la liste nominative reste dans l’espace de l’établissement. Les montants arrivent avec les documents (lot G5c).">
      {e.counts.length === 0 ? <p className="text-sm text-muted">Aucun comptage : le premier a lieu à la fin de la période gratuite, puis aux dates du calendrier de facturation.</p> : (
        <ul className="grid max-h-[60vh] gap-2 overflow-y-auto">
          {e.counts.map((c) => (
            <li key={c.id} className="grid gap-1 rounded-lg bg-sunk p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <b>{c.kindLabel} du {frDate(c.referenceDate)}</b>
                <Badge tone={c.stage === 'FROZEN' ? 'good' : 'warn'}>{c.stageLabel}</Badge>
              </div>
              <span>Année {c.yearLabel} · <b>{pupilsText(c.pupils)}</b> comptés : <b>{c.pupils - c.toCheck}</b> confirmés facturables{c.toCheck ? <>, <b className="text-warn">{c.toCheck} « À vérifier »</b> comptés sous réserve</> : ''} · cumul de l’année : {c.cumulative} · exclus : {c.excluded}</span>
              {c.reviewOpen && <span className="text-warn">Vérification par la direction jusqu’au {frDate(c.reviewUntil)} inclus.</span>}
              {c.stage === 'PROVISIONAL' && c.frozen && <span className="text-muted">Remplacé par le comptage définitif de la même date.</span>}
              <span className="text-xs text-muted">Historique lu le {new Date(c.knownAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })} · empreinte de la liste {c.listHash.slice(0, 12)}…</span>
            </li>
          ))}
        </ul>
      )}
    </DialogContent>
  );
}

type Formula = 'A' | 'B' | 'MANUEL';
type Proposal = { applies: boolean; message: string | null; initialCountDate: string | null; firstRegularizationDate: string | null; finalRegularizationDate: string | null };
type Proposals = Record<'A' | 'B', Proposal>;
type CalendarData = {
  tenant: { id: string; name: string; today: string };
  versions: Calendar[];
  schoolYears: { label: string; startDate: string; endDate: string; isCurrent: boolean }[];
};
const EMPTY_CAL = { yearLabel: '', startDate: '', endDate: '', preparationFrom: '', initialCountDate: '', firstRegularizationDate: '', finalRegularizationDate: '', renewalDate: '', formula: 'B' as Formula, reason: '', code: '' };
const IS_DAY = /^\d{4}-\d{2}-\d{2}$/;
const FORMULA_DATES = ['initialCountDate', 'firstRegularizationDate', 'finalRegularizationDate'] as const;

/**
 * Calendrier d'un établissement (correction C0) : les dates proposées existent pour toute rentrée et toute fin, et se
 * recalculent quand l'une change. Une date changée à la main garde la formule et marque la version « ajustée ». Pour
 * une année de 6 mois ou moins, la formule ne s'applique pas : dates saisies à la main, avec un motif (décision CAL-1).
 */
function CalendarDialog({ e, done }: { e: Establishment; done: () => void }) {
  const [data, setData] = useState<CalendarData | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [f, setF] = useState(EMPTY_CAL);
  /** Les trois dates de la formule suivent ses propositions ; faux dès qu'on en change une à la main. */
  const [follow, setFollow] = useState(true);
  /** Propositions des formules pour la rentrée et la fin `key` (« début|fin »), ou l'erreur de ces deux dates. */
  const [proposed, setProposed] = useState<{ key: string; proposals: Proposals | null; error: unknown } | null>(null);
  const { busy, error, submit } = useSubmit(done, 'Calendrier enregistré');
  useEffect(() => {
    pf<CalendarData>('GET', `/billing/establishments/${e.id}/calendars`).then(setData).catch(setLoadError);
  }, [e.id]);

  const key = `${f.startDate}|${f.endDate}`;
  useEffect(() => {
    const [start, end] = key.split('|');
    if (!IS_DAY.test(start) || !IS_DAY.test(end)) return;
    let live = true;
    const timer = setTimeout(() => {
      pf<{ proposals: Proposals }>('GET', `/billing/calendar-proposals?${new URLSearchParams({ startDate: start, endDate: end })}`)
        .then((r) => live && setProposed({ key, proposals: r.proposals, error: null }))
        .catch((err) => live && setProposed({ key, proposals: null, error: err }));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key]);
  const current = proposed?.key === key ? proposed : null;
  const proposal = f.formula !== 'MANUEL' && current?.proposals ? current.proposals[f.formula] : null;
  // Recalcul : tant que les dates suivent la formule, chaque proposition les remplace (aucune quand elle ne s'applique pas).
  useEffect(() => {
    if (!follow || !proposal) return;
    const next = { initialCountDate: proposal.initialCountDate ?? '', firstRegularizationDate: proposal.firstRegularizationDate ?? '', finalRegularizationDate: proposal.finalRegularizationDate ?? '' };
    setF((x) => (FORMULA_DATES.every((k) => x[k] === next[k]) ? x : { ...x, ...next }));
  }, [follow, proposal]);
  // Tant que les dates suivent la formule, l'effet ci-dessus les aligne : seule une date changée à la main rend la version « ajustée ».
  const adjusted = !follow && !!proposal?.applies && FORMULA_DATES.some((k) => f[k] !== proposal[k]);
  const notApplicable = proposal && !proposal.applies ? proposal.message : null;
  /** Propositions des nouvelles dates pas encore reçues : on attend avant d'enregistrer. */
  const waiting = f.formula !== 'MANUEL' && IS_DAY.test(f.startDate) && IS_DAY.test(f.endDate) && !current;
  const missing = [need.value(f.yearLabel.trim(), 'l’année scolaire'), need.value(f.startDate, 'le début de l’année'), need.value(f.endDate, 'la fin de l’année'),
    need.value(f.initialCountDate, 'le comptage initial'), need.value(f.firstRegularizationDate, 'la première régularisation'),
    need.value(f.finalRegularizationDate, 'la régularisation finale'), need.text(f.reason, 'le motif'), need.code(f.code)];

  /** Reprend la dernière version de cette année telle quelle ; sinon les dates de l'année scolaire de l'école, recalculées. */
  const pickYear = (yearLabel: string) => {
    const v = data?.versions.find((x) => x.yearLabel === yearLabel);
    if (v) {
      setF({ ...f, yearLabel, formula: v.formula as Formula, startDate: v.startDate, endDate: v.endDate, preparationFrom: v.preparationFrom ?? '', initialCountDate: v.initialCountDate, firstRegularizationDate: v.firstRegularizationDate, finalRegularizationDate: v.finalRegularizationDate, renewalDate: v.renewalDate ?? '' });
      setFollow(false);
      return;
    }
    const y = data?.schoolYears.find((x) => x.label === yearLabel);
    if (y && (y.startDate !== f.startDate || y.endDate !== f.endDate)) {
      setF({ ...f, yearLabel, startDate: y.startDate, endDate: y.endDate });
      setFollow(true);
    } else setF({ ...f, yearLabel });
  };
  const pickFormula = (formula: Formula) => {
    setF({ ...f, formula });
    setFollow(formula !== 'MANUEL');
  };
  const setYearDate = (k: 'startDate' | 'endDate', value: string) => {
    setF({ ...f, [k]: value });
    setFollow(true);
  };
  const setFormulaDate = (k: (typeof FORMULA_DATES)[number], value: string) => {
    setF({ ...f, [k]: value });
    setFollow(false);
  };
  const versions = data?.versions.filter((v) => !f.yearLabel || v.yearLabel === f.yearLabel) ?? [];
  return (
    <DialogContent title={`Calendrier de facturation : ${e.name}`} description="Chaque enregistrement ajoute une version ; une date passée ne change plus. Les dates proposées se recalculent quand la rentrée ou la fin change ; une date changée à la main rend la version « ajustée ». Formules A et B : proposition provisoire, la formule définitive attend votre décision D-G5-28.">
      <ErrorNote error={loadError} />
      {data && (
        <form className="grid max-h-[70vh] gap-3 overflow-y-auto pr-1" onSubmit={(ev) => {
          ev.preventDefault();
          submit(() => pf('POST', `/billing/establishments/${e.id}/calendars`, { ...f, preparationFrom: f.preparationFrom || null, renewalDate: f.renewalDate || null }));
        }}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Année scolaire" hint={data.schoolYears.length ? 'Années de l’école, ou saisie libre (2027 pour une année civile).' : 'L’école n’a encore aucune année scolaire.'}>
              <Input list={`annees-${e.id}`} value={f.yearLabel} onChange={(x) => pickYear(x.target.value)} required placeholder="2026-2027" />
              <datalist id={`annees-${e.id}`}>{data.schoolYears.map((y) => <option key={y.label} value={y.label} />)}</datalist>
            </Field>
            <Field label="Formule des dates proposées">
              <Select value={f.formula} onChange={(x) => pickFormula(x.target.value as Formula)}>
                <option value="B">B : à distance fixe (provisoire)</option>
                <option value="A">A : en proportion de l’année (provisoire)</option>
                <option value="MANUEL">Dates saisies à la main</option>
              </Select>
            </Field>
            <Field label="Début de l’année scolaire"><Input type="date" value={f.startDate} onChange={(x) => setYearDate('startDate', x.target.value)} required /></Field>
            <Field label="Fin de l’année scolaire"><Input type="date" value={f.endDate} onChange={(x) => setYearDate('endDate', x.target.value)} required /></Field>
          </div>
          <ErrorNote error={current?.error} />
          {notApplicable && (
            <div role="status" className="grid gap-2 rounded-lg bg-warn-soft p-3 text-sm">
              <p className="font-bold">{notApplicable}</p>
              <Button type="button" size="sm" variant="outline" className="justify-self-start" onClick={() => pickFormula('MANUEL')}>Saisir les dates à la main</Button>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Début de la préparation (facultatif)"><Input type="date" value={f.preparationFrom} onChange={(x) => setF({ ...f, preparationFrom: x.target.value })} /></Field>
            <Field label="Comptage initial"><Input type="date" value={f.initialCountDate} onChange={(x) => setFormulaDate('initialCountDate', x.target.value)} required /></Field>
            <Field label="Première régularisation"><Input type="date" value={f.firstRegularizationDate} onChange={(x) => setFormulaDate('firstRegularizationDate', x.target.value)} required /></Field>
            <Field label="Régularisation finale"><Input type="date" value={f.finalRegularizationDate} onChange={(x) => setFormulaDate('finalRegularizationDate', x.target.value)} required /></Field>
            <Field label="Renouvellement (facultatif)" hint="Mode de renouvellement : décision D-G5-12 en attente."><Input type="date" value={f.renewalDate} onChange={(x) => setF({ ...f, renewalDate: x.target.value })} /></Field>
          </div>
          {adjusted && (
            <div role="status" className="grid gap-2 rounded-lg bg-sunk p-3 text-sm">
              <p>Dates changées à la main : cette version sera enregistrée comme « formule {f.formula}, ajustée », avec votre motif.</p>
              <Button type="button" size="sm" variant="outline" className="justify-self-start" onClick={() => setFollow(true)}>Reprendre les dates de la formule {f.formula}</Button>
            </div>
          )}
          <Field label="Motif"><Input value={f.reason} minLength={5} maxLength={300} onChange={(x) => setF({ ...f, reason: x.target.value })} required placeholder="Par exemple : calendrier communiqué par la direction" /></Field>
          <CodeField value={f.code} onChange={(code) => setF({ ...f, code })} />
          <ErrorNote error={error} />
          <Button type="submit" loading={busy} disabled={!!notApplicable || waiting || !ready(missing)}>Enregistrer cette version</Button>
          <Missing items={missing} />
          {versions.length > 0 && (
            <div className="grid gap-1 text-xs">
              <p className="font-bold">Versions enregistrées</p>
              {versions.map((v) => (
                <p key={v.id} className="rounded bg-sunk p-2">{v.yearLabel} v{v.version} ({formulaLabel(v)}) : {frDate(v.initialCountDate)}, {frDate(v.firstRegularizationDate)}, {frDate(v.finalRegularizationDate)} · {v.createdByName}, {new Date(v.createdAt).toLocaleDateString('fr-FR')} · {v.reason}</p>
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
      {p.proposals.length > 0 && (
        <Card className="grid gap-2">
          <h3 className="font-bold">Délais d’échéance proposés, non activés</h3>
          <p className="text-sm text-muted">
            Chaque document qui porte un montant à payer a une échéance explicite. Tant qu’aucune valeur n’est saisie pour ces délais, un document complémentaire ou une proforma porte « Échéance à fixer » ;
            une échéance ne limite jamais l’accès (décision D-G5-18 en attente). Pour activer un délai, après la validation des conditions commerciales, saisissez une nouvelle valeur.
          </p>
          <ul className="grid gap-1 text-sm" aria-label="Délais proposés">
            {p.proposals.map((x) => (
              <li key={x.key} className="flex flex-wrap items-center justify-between gap-2 rounded bg-sunk px-3 py-1.5">
                <span>{x.label}</span>
                <span className="flex flex-wrap items-center gap-2"><b>{paramValue(x.unit, x.proposed, null)}</b><Badge tone="warn">Proposé, non activé{x.provisional ? ` (${x.provisional})` : ''}</Badge></span>
              </li>
            ))}
          </ul>
        </Card>
      )}
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
  const proposal = p.proposals.find((x) => x.key === f.key);
  const { busy, error, submit } = useSubmit(done, 'Nouvelle valeur enregistrée');
  const toInt = () => (def.unit === 'percent' ? Math.round(Number(f.value.replace(',', '.')) * 100) : Number(f.value));
  const missing = [need.value(f.value.trim(), 'la valeur'), need.value(f.effectiveFrom, 'la date d’effet'), need.text(f.reason, 'le motif'), need.code(f.code)];
  return (
    <DialogContent title="Nouvelle valeur d’un paramètre" description="Elle s’applique à partir de sa date d’effet, jamais avant ; l’ancienne valeur reste dans l’historique.">
      <form className="grid gap-3" onSubmit={(ev) => { ev.preventDefault(); submit(() => pf('POST', '/billing/parameters', { key: f.key, currency: def.unit === 'money' ? f.currency : null, value: toInt(), effectiveFrom: f.effectiveFrom, reason: f.reason, code: f.code })); }}>
        <Field label="Paramètre">
          <Select value={f.key} onChange={(x) => setF({ ...f, key: x.target.value })}>{p.definitions.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}</Select>
        </Field>
        {def.unit === 'money' && <Field label="Monnaie"><Select value={f.currency} onChange={(x) => setF({ ...f, currency: x.target.value })}>{p.currencies.map((c) => <option key={c} value={c}>{c}</option>)}</Select></Field>}
        <Field label={def.unit === 'money' ? 'Montant' : def.unit === 'percent' ? 'Pourcentage' : def.unit === 'hours' ? 'Nombre d’heures' : def.unit === 'days' ? 'Nombre de jours' : 'Nombre de mois'}
          hint={def.unit === 'percent' ? 'Par exemple 15 pour 15 %.' : proposal ? `Proposé par Cahiora : ${paramValue(proposal.unit, proposal.proposed, null)}, non activé. Saisir une valeur l’active à sa date d’effet.` : undefined}>
          <Input inputMode="decimal" value={f.value} onChange={(x) => setF({ ...f, value: x.target.value })} required />
        </Field>
        <Field label="Date d’effet" hint="Aujourd’hui au plus tôt."><Input type="date" min={p.today} value={f.effectiveFrom} onChange={(x) => setF({ ...f, effectiveFrom: x.target.value })} required /></Field>
        <Field label="Motif"><Input value={f.reason} minLength={5} maxLength={300} onChange={(x) => setF({ ...f, reason: x.target.value })} required /></Field>
        <CodeField value={f.code} onChange={(code) => setF({ ...f, code })} />
        <ErrorNote error={error} />
        <Button type="submit" loading={busy} disabled={!ready(missing)}>Enregistrer</Button>
        <Missing items={missing} />
      </form>
    </DialogContent>
  );
}

function TermsDialog({ today, done }: { today: string; done: () => void }) {
  const [f, setF] = useState({ title: '', body: '', effectiveFrom: today, definitive: false, code: '' });
  const { busy, error, submit } = useSubmit(done, 'Conditions commerciales publiées');
  const missing = [need.text(f.title, 'le titre', 3), need.text(f.body, 'le texte des conditions', 20), need.value(f.effectiveFrom, 'la date d’effet'),
    !f.definitive && 'la case de confirmation', need.code(f.code)];
  return (
    <DialogContent title="Publier une version des conditions commerciales" description="Le texte vient de vous : Cahiora ne le rédige pas à votre place. La direction l’accepte au nom de l’établissement, comme un contrat réel, à la fin de son essai ou de son pilote : ne publiez jamais un texte d’essai.">
      <form className="grid gap-3" onSubmit={(ev) => { ev.preventDefault(); submit(() => pf('POST', '/billing/terms', f)); }}>
        <Field label="Titre"><Input value={f.title} minLength={3} maxLength={160} onChange={(x) => setF({ ...f, title: x.target.value })} required /></Field>
        <Field label="Texte des conditions"><Textarea rows={10} value={f.body} minLength={20} maxLength={30000} onChange={(x) => setF({ ...f, body: x.target.value })} required /></Field>
        <Field label="Date d’effet"><Input type="date" min={today} value={f.effectiveFrom} onChange={(x) => setF({ ...f, effectiveFrom: x.target.value })} required /></Field>
        {/* Réserve de Dankou du 20 novembre 2026 : jamais de conditions d'essai présentées comme un contrat réel. */}
        <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-line p-3 text-sm">
          <input type="checkbox" className="mt-1 size-5 flex-none accent-[var(--brand)]" checked={f.definitive} onChange={(x) => setF({ ...f, definitive: x.target.checked })} required />
          <span>Je confirme que ce texte est la version définitive des conditions commerciales de Cahiora, validée pour être proposée aux établissements. Ce n’est ni un texte d’essai ni un exemple.</span>
        </label>
        <CodeField value={f.code} onChange={(code) => setF({ ...f, code })} />
        <ErrorNote error={error} />
        <Button type="submit" loading={busy} disabled={!ready(missing)}>Publier</Button>
        <Missing items={missing} />
      </form>
    </DialogContent>
  );
}
