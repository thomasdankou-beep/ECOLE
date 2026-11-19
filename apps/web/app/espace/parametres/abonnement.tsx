'use client';

import { useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Loader, Section } from '@/components/espace/bits';
import { Badge, Button, Empty, ErrorNote, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useApi } from '@/lib/use-api';

/**
 * Abonnement Cahiora vu par la direction (lot G5a) : état, période gratuite, tarif en vigueur, calendrier de facturation,
 * historique, et acceptation des conditions commerciales à la fin de l'essai ou du pilote. Aucun paiement ici.
 */

type Status = 'TRIAL' | 'PILOT' | 'AWAITING_ACCEPTANCE' | 'AWAITING_PAYMENT' | 'ACTIVE' | 'LIMITED';
type Data = {
  today: string; currency: string;
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
};

const TONE: Record<Status, 'info' | 'good' | 'warn' | 'bad' | 'accent'> = {
  TRIAL: 'info', PILOT: 'accent', AWAITING_ACCEPTANCE: 'warn', AWAITING_PAYMENT: 'warn', ACTIVE: 'good', LIMITED: 'bad',
};
const frDate = (d: string | null | undefined) => (d ? new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '—');
const money = (n: number, currency: string) => `${new Intl.NumberFormat('fr-FR').format(n).replace(/[  ]/g, ' ')} ${currency === 'XOF' || currency === 'XAF' ? 'FCFA' : currency}`;
const daysText = (n: number) => `${n} jour${n > 1 ? 's' : ''}`;

export function Abonnement({ openCounts }: { openCounts?: () => void }) {
  const q = useApi<Data>('/settings/subscription');
  return (
    <Loader {...q}>
      {(d) => (
        <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
          <div className="grid content-start gap-4">
            <Etat d={d} />
            {d.subscription?.status === 'AWAITING_ACCEPTANCE' && <Acceptation d={d} reload={q.reload} />}
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
        <Empty title="Aucun abonnement ouvert">Cahiora ouvre l’abonnement de votre établissement avec vous : essai gratuit ou statut d’école pilote partenaire.</Empty>
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
        {s.status === 'AWAITING_PAYMENT' && (
          <>
            <p className="flex items-start gap-2"><CheckCircle2 className="mt-0.5 size-5 flex-none text-good" /> <span>Conditions commerciales acceptées le <b>{s.acceptedAt ? new Date(s.acceptedAt).toLocaleDateString('fr-FR') : '—'}</b> par {s.acceptedByName}{s.acceptedTermsVersion ? ` (version ${s.acceptedTermsVersion})` : ''}.</span></p>
            <p className="text-sm text-muted">Prochaine étape : Cahiora prépare votre demande de paiement.</p>
          </>
        )}
        {(s.status === 'ACTIVE' || s.status === 'LIMITED') && <p>{s.statusLabel} depuis le {new Date(s.statusSince).toLocaleDateString('fr-FR')}.</p>}
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
      await api.post('/settings/subscription/accept', { termsId: t!.id, accepted: true });
      toast('Conditions acceptées : Cahiora prépare votre demande de paiement');
      reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section title="Conditions commerciales">
      <div className="grid gap-3">
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
