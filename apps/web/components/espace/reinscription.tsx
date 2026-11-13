'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, RotateCcw, Search } from 'lucide-react';
import { Loader, StatusBadge } from '@/components/espace/bits';
import { Badge, Button, Card, Dialog, DialogContent, Empty, Field, Input, Select, Table, Textarea, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { date, fcfa } from '@/lib/format';
import { can } from '@/lib/perm';
import type { ClassRow } from '@/lib/types';
import { qs, useAction, useApi } from '@/lib/use-api';

/** Classe proposée par le serveur (corrections du lot G4) : à confirmer ou changer avant de valider. */
export type Proposal = { basis: 'ADMIS' | 'NON_ADMIS' | 'RETOUR' | 'SANS_DECISION'; levelName: string | null; classId: string | null; className: string | null; note: string };
type Candidate = {
  id: string; matricule: string; firstName: string; lastName: string; status: string; outcome: 'ADMIS' | 'NON_ADMIS' | null;
  fromClass: { id: string; name: string; level: string; site: { id: string; name: string } };
  proposal: Proposal; unpaid: boolean; balance?: number; overdue?: number;
};
type Candidates = { toYear: { id: string; label: string }; fromYear: { id: string; label: string } | null; years: { id: string; label: string }[]; items: Candidate[] };
/**
 * Élève à réinscrire : classe proposée et frais impayés (montants seulement pour qui voit les finances). `chosenClassId` :
 * classe déjà choisie par la personne (formulaire d'inscription) ; elle reste choisie, la classe proposée s'affiche à côté.
 */
export type Pupil = {
  id: string; firstName: string; lastName: string; matricule: string; proposal?: Proposal | null; unpaid?: boolean; balance?: number; overdue?: number;
  chosenClassId?: string;
};
/** Réinscription faite. */
export type Done = { id: string; matricule: string; name: string; className: string; year: string; reinstated: boolean; invoices: number };

const OUTCOME: Record<string, [string, 'good' | 'warn']> = { ADMIS: ['Admis', 'good'], NON_ADMIS: ['Non admis', 'warn'] };

/** Avertissement d'impayé : jamais bloquant ; le montant n'apparaît que pour qui voit les finances. */
function Unpaid({ p, compact }: { p: Pupil; compact?: boolean }) {
  if (!p.unpaid) return null;
  const amount = p.balance !== undefined ? ` : ${fcfa(p.balance)}${p.overdue ? ` (dont ${fcfa(p.overdue)} échus)` : ''}` : '';
  return compact
    ? <Badge tone="bad"><AlertTriangle className="size-3.5" /> Impayé{amount}</Badge>
    : <p className="flex items-start gap-1.5 text-sm font-bold text-bad"><AlertTriangle className="mt-0.5 size-4 flex-none" /> Frais impayés{amount}</p>;
}

/** Classe proposée, en clair. */
function Proposed({ p }: { p: Proposal }) {
  return p.classId
    ? <span className="text-sm">Proposée : <b>{p.className}</b></span>
    : <span className="text-sm text-muted">À choisir</span>;
}

/**
 * Réinscription pour l'année en cours (lot G4) : chaque élève garde son dossier et son matricule ; ses notes,
 * bulletins, paiements et absences des années passées ne changent pas. Au téléphone, une carte par élève (pas de
 * tableau à faire défiler de côté).
 */
export function Reinscriptions() {
  const { role } = useAuth();
  const [fromYearId, setFromYearId] = useState('');
  const q = useApi<Candidates>(`/students/reenrollment${qs({ fromYearId })}`);
  const classes = useApi<ClassRow[]>('/classes');
  const [fromClass, setFromClass] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [pupils, setPupils] = useState<Pupil[] | null>(null);
  const showBalance = can(role, 'finance.read');

  const rows = useMemo(() => {
    const words = search.trim().toLowerCase();
    return (q.data?.items ?? []).filter((c) => (!fromClass || c.fromClass.id === fromClass)
      && (!words || `${c.lastName} ${c.firstName} ${c.matricule}`.toLowerCase().includes(words)));
  }, [q.data, fromClass, search]);
  const pastClasses = useMemo(() => [...new Map((q.data?.items ?? []).map((c) => [c.fromClass.id, c.fromClass])).values()].sort((a, b) => a.name.localeCompare(b.name)), [q.data]);
  const allChecked = rows.length > 0 && rows.every((r) => selected.includes(r.id));
  const toggle = (id: string, on: boolean) => setSelected(on ? [...selected, id] : selected.filter((x) => x !== id));
  const unpaidCount = rows.filter((r) => r.unpaid).length;

  return (
    <Loader {...q}>
      {(d) => (
        <div className="grid gap-4">
          <Card className="grid gap-3">
            <p className="text-lg font-bold">Réinscriptions pour {d.toYear.label}</p>
            <p className="text-sm text-muted">
              Élèves de {d.fromYear?.label ?? 'l’année précédente'} qui n’ont pas encore d’inscription pour {d.toYear.label}. Chacun garde son dossier et son matricule ;
              ses notes, bulletins, paiements et absences des années passées restent tels quels.
            </p>
            {classes.data && classes.data.length === 0 && (
              <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm font-bold text-warn">Aucune classe pour {d.toYear.label} : créez d’abord les classes (Paramètres › Classes et matières).</p>
            )}
            <div className="grid gap-3 sm:grid-cols-3">
              {d.years.length > 1 && (
                <Select aria-label="Année d’origine" value={fromYearId || d.fromYear?.id || ''} onChange={(e) => { setFromYearId(e.target.value); setSelected([]); setFromClass(''); }}>
                  {d.years.map((y) => <option key={y.id} value={y.id}>Élèves de {y.label}</option>)}
                </Select>
              )}
              <Select aria-label="Classe d’origine" value={fromClass} onChange={(e) => { setFromClass(e.target.value); setSelected([]); }}>
                <option value="">Toutes les classes ({d.items.length} élèves)</option>
                {pastClasses.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.site.name}</option>)}
              </Select>
              <label className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted" />
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Nom ou matricule" className="pl-10" aria-label="Rechercher un élève à réinscrire" />
              </label>
            </div>
          </Card>
          {!d.fromYear ? (
            <Empty title="Aucune année précédente">
              Les réinscriptions concernent les élèves d’une année passée. Créez et activez la nouvelle année (Paramètres › Année et périodes), créez ses classes, puis revenez ici.
            </Empty>
          ) : d.items.length === 0 ? (
            <Empty title={`Tous les élèves de ${d.fromYear.label} sont réinscrits ou partis`} />
          ) : (
            <Card className="grid gap-3">
              {unpaidCount > 0 && (
                <p className="flex items-start gap-2 rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">
                  <AlertTriangle className="mt-0.5 size-4 flex-none" />
                  <span><b>{unpaidCount} élève(s) ont des frais impayés.</b> La réinscription n’est pas bloquée : appliquez les règles financières de votre établissement.</span>
                </p>
              )}
              {selected.length > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-brand-soft px-3 py-2">
                  <span className="font-bold">{selected.length} élève(s) sélectionné(s)</span>
                  <Button size="sm" onClick={() => setPupils(d.items.filter((c) => selected.includes(c.id)))}><RotateCcw className="size-4" /> Réinscrire la sélection</Button>
                </div>
              )}
              {/* Téléphone : une carte par élève. */}
              <div className="grid gap-2 sm:hidden">
                <label className="flex min-h-11 items-center gap-3 text-sm font-bold">
                  <input type="checkbox" className="size-5" checked={allChecked} onChange={(e) => setSelected(e.target.checked ? rows.map((r) => r.id) : [])} /> Tout sélectionner
                </label>
                <ul className="grid gap-2" aria-label="Élèves à réinscrire">
                  {rows.map((c) => (
                    <li key={c.id} className="rounded-lg border border-line p-3" data-matricule={c.matricule}>
                      <div className="flex items-start gap-3">
                        <input type="checkbox" className="mt-1 size-5 flex-none" aria-label={`Sélectionner ${c.lastName} ${c.firstName}`} checked={selected.includes(c.id)} onChange={(e) => toggle(c.id, e.target.checked)} />
                        <div className="grid min-w-0 flex-1 gap-1">
                          <p><Link href={`/espace/eleves/${c.id}`} className="font-bold text-brand hover:underline">{c.lastName} {c.firstName}</Link> <span className="font-mono text-xs text-muted">{c.matricule}</span></p>
                          <p className="flex flex-wrap items-center gap-1.5 text-sm">
                            {c.fromClass.name} · {c.fromClass.site.name}
                            {c.outcome ? <Badge tone={OUTCOME[c.outcome][1]}>{OUTCOME[c.outcome][0]}</Badge> : <span className="text-muted">Résultat non saisi</span>}
                          </p>
                          <Proposed p={c.proposal} />
                          <Unpaid p={c} />
                        </div>
                      </div>
                      <Button size="sm" variant="outline" className="mt-2 w-full" onClick={() => setPupils([c])}>Réinscrire</Button>
                    </li>
                  ))}
                </ul>
              </div>
              {/* Bureau et tablette : le tableau. */}
              <div className="hidden sm:block">
                <Table>
                  <thead>
                    <tr>
                      <th className="w-10"><input type="checkbox" className="size-5" aria-label="Tout sélectionner" checked={allChecked} onChange={(e) => setSelected(e.target.checked ? rows.map((r) => r.id) : [])} /></th>
                      <th>Élève</th><th>Classe {d.fromYear.label}</th><th>Résultat</th><th>Classe proposée</th>{showBalance && <th className="text-right">Reste à payer</th>}<th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((c) => (
                      <tr key={c.id}>
                        <td><input type="checkbox" className="size-5" aria-label={`Sélectionner ${c.lastName} ${c.firstName}`} checked={selected.includes(c.id)} onChange={(e) => toggle(c.id, e.target.checked)} /></td>
                        <td>
                          <Link href={`/espace/eleves/${c.id}`} className="font-bold text-brand hover:underline">{c.lastName} {c.firstName}</Link>
                          <span className="block font-mono text-xs text-muted">{c.matricule}</span>
                          {!showBalance && c.unpaid && <Unpaid p={c} compact />}
                        </td>
                        <td>{c.fromClass.name} · {c.fromClass.site.name}</td>
                        <td>{c.outcome ? <Badge tone={OUTCOME[c.outcome][1]}>{OUTCOME[c.outcome][0]}</Badge> : <span className="text-sm text-muted">Non saisi</span>}</td>
                        <td>{c.proposal.classId ? <b>{c.proposal.className}</b> : <span className="text-sm text-muted">À choisir</span>}</td>
                        {showBalance && (
                          <td className={`text-right font-bold ${c.unpaid ? 'text-bad' : 'text-good'}`}>
                            {fcfa(c.balance ?? 0)}
                            {!!c.overdue && <span className="block text-xs font-normal">dont {fcfa(c.overdue)} échus</span>}
                          </td>
                        )}
                        <td className="text-right"><Button size="sm" variant="outline" onClick={() => setPupils([c])}>Réinscrire</Button></td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
              <p className="text-xs text-muted">
                La classe proposée suit le résultat de fin d’année et le passage défini dans Paramètres › Niveaux ; vous la confirmez ou la changez avant de valider.
                {showBalance ? ' Le reste à payer est affiché pour information : il ne bloque pas la réinscription.' : ''}
              </p>
            </Card>
          )}
          <ReenrollDialog
            pupils={pupils}
            year={d.toYear.label}
            classes={classes.data ?? []}
            onClose={(done) => { setPupils(null); if (done) { setSelected([]); q.reload(); classes.reload(); } }}
          />
        </div>
      )}
    </Loader>
  );
}

type Report = { ok: Done[]; failed: { name: string; message: string }[] };

/**
 * Confirmation des classes, puis réinscription élève par élève (un échec n'arrête pas les autres). Chaque élève part
 * avec la classe proposée (ou celle que la personne a déjà choisie), qu'elle confirme ou change ; les impayés sont
 * signalés sans bloquer. Toutes les réinscriptions passent par cette fenêtre : onglet Réinscriptions, dossier de
 * l'élève, et dossier retrouvé pendant une inscription (`applicationId` : la pré-inscription d'où elle vient).
 * `closeOnSuccess` : quand tout a réussi, la fenêtre se ferme et `onClose` reçoit les réinscriptions faites.
 */
export function ReenrollDialog({ pupils, year, classes, onClose, applicationId, createInvoices: invoicesByDefault = true, closeOnSuccess }: {
  pupils: Pupil[] | null; year: string; classes: ClassRow[]; onClose: (done: boolean, ok?: Done[]) => void;
  applicationId?: string | null; createInvoices?: boolean; closeOnSuccess?: boolean;
}) {
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [createInvoices, setInvoices] = useState(invoicesByDefault);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  // Chaque élève part avec la classe proposée (s'il y en a une), à confirmer. Remis à zéro quand la liste change
  // (et pas à chaque affichage : le dossier passe un nouveau tableau à chaque rendu).
  const key = (pupils ?? []).map((p) => `${p.id}:${p.chosenClassId ?? ''}:${p.proposal?.classId ?? ''}`).join(',');
  const [seen, setSeen] = useState('');
  if (key !== seen) {
    setSeen(key);
    setChoice(Object.fromEntries((pupils ?? []).map((p) => [p.id, p.chosenClassId || p.proposal?.classId || ''])));
    setConfirmed(false);
    setInvoices(invoicesByDefault);
  }
  const close = () => { const ok = report?.ok ?? []; setReport(null); onClose(ok.length > 0, ok); };
  const className = (id: string) => classes.find((c) => c.id === id)?.name ?? '';
  const options = classes.map((c) => <option key={c.id} value={c.id} disabled={!!c.capacity && c.studentCount >= c.capacity}>{c.name} · {c.site.name} ({c.studentCount}{c.capacity ? `/${c.capacity}` : ''})</option>);
  const owing = (pupils ?? []).filter((p) => p.unpaid);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!pupils) return;
    setBusy(true);
    const out: Report = { ok: [], failed: [] };
    for (const p of pupils) {
      const name = `${p.lastName} ${p.firstName}`;
      try {
        const r = await api.post<Omit<Done, 'name'>>(`/students/${p.id}/reenroll`, { classId: choice[p.id], createInvoices, ...(applicationId ? { applicationId } : {}) });
        out.ok.push({ id: r.id, matricule: r.matricule, name, className: r.className, year: r.year, reinstated: r.reinstated, invoices: r.invoices });
      } catch (err) {
        out.failed.push({ name, message: err instanceof Error ? err.message : 'Erreur' });
      }
    }
    setBusy(false);
    if (closeOnSuccess && out.ok.length && !out.failed.length) onClose(true, out.ok);
    else setReport(out);
  }

  const same = report ? [...new Set(report.ok.map((r) => r.className))] : [];
  return (
    <Dialog open={!!pupils} onOpenChange={(o) => !o && close()}>
      {pupils && (
        <DialogContent
          className="max-w-2xl"
          title={pupils.length === 1 ? `Réinscrire ${pupils[0].lastName} ${pupils[0].firstName}` : `Réinscrire ${pupils.length} élèves`}
          description={`Pour ${year}, sur le dossier existant : même matricule, historique conservé.`}
        >
          {report ? (
            <div className="grid gap-3">
              {report.ok.length > 0 && (
                <div className="grid gap-1">
                  <p className="flex items-start gap-2 font-bold text-good">
                    <CheckCircle2 className="mt-0.5 size-5 flex-none" />
                    {report.ok.length} élève(s) réinscrit(s){same.length === 1 ? ` en ${same[0]}` : ''}.
                    {report.ok.some((r) => r.reinstated) ? ' Une inscription annulée ou terminée a été rétablie (aucune nouvelle facture).' : ''}
                    {report.ok.reduce((n, r) => n + r.invoices, 0) ? ` ${report.ok.reduce((n, r) => n + r.invoices, 0)} facture(s) créée(s).` : ''}
                  </p>
                  {same.length > 1 && <ul className="text-sm">{report.ok.map((r) => <li key={r.name}>{r.name} : {r.className}</li>)}</ul>}
                </div>
              )}
              {report.failed.length > 0 && (
                <ul className="grid gap-1 rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">
                  {report.failed.map((f) => <li key={f.name}><b>{f.name}</b> : {f.message}</li>)}
                </ul>
              )}
              <Button onClick={close}>Fermer</Button>
            </div>
          ) : (
            <form className="grid gap-3" onSubmit={submit}>
              {owing.length > 0 && (
                <p className="flex items-start gap-2 rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">
                  <AlertTriangle className="mt-0.5 size-4 flex-none" />
                  <span>
                    <b>{pupils.length === 1 ? 'Cet élève a des frais impayés.' : `${owing.length} élève(s) ont des frais impayés.`}</b> La réinscription n’est pas bloquée :
                    appliquez les règles financières de votre établissement.
                  </span>
                </p>
              )}
              {pupils.length > 1 && (
                <Field label="Même classe pour toute la sélection (facultatif)">
                  <Select value="" onChange={(e) => e.target.value && setChoice(Object.fromEntries(pupils.map((p) => [p.id, e.target.value])))}>
                    <option value="">Garder les classes proposées</option>
                    {options}
                  </Select>
                </Field>
              )}
              <ul className="grid gap-2">
                {pupils.map((p) => (
                  <li key={p.id} className={`grid gap-1.5 ${pupils.length > 1 ? 'rounded-lg border border-line p-3' : ''}`}>
                    {pupils.length > 1 && <p className="font-bold">{p.lastName} {p.firstName} <span className="font-mono text-xs font-normal text-muted">{p.matricule}</span></p>}
                    {p.proposal && <p className={`text-sm ${p.proposal.classId ? 'text-brand' : 'text-muted'}`}>{p.proposal.note}</p>}
                    <Unpaid p={p} />
                    <Field label={pupils.length > 1 ? `Classe ${year} · ${p.lastName} ${p.firstName}` : `Classe ${year}`}>
                      <Select value={choice[p.id] ?? ''} onChange={(e) => setChoice({ ...choice, [p.id]: e.target.value })} required>
                        <option value="">Choisir la classe</option>
                        {options}
                      </Select>
                    </Field>
                    {p.proposal?.classId && choice[p.id] && choice[p.id] !== p.proposal.classId && (
                      <p className="text-xs font-bold text-warn">Vous avez choisi {className(choice[p.id])} au lieu de la classe proposée ({p.proposal.className}).</p>
                    )}
                  </li>
                ))}
              </ul>
              <label className="flex min-h-11 items-center gap-3 font-bold"><input type="checkbox" className="size-5" checked={createInvoices} onChange={(e) => setInvoices(e.target.checked)} /> Créer les factures des frais « anciens élèves » de la classe</label>
              <label className="flex min-h-11 items-center gap-3 rounded-lg bg-sunk px-3 font-bold">
                <input type="checkbox" className="size-5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} required />
                {pupils.length === 1 ? 'Je confirme la classe choisie' : 'Je confirme la classe de chaque élève'}
              </label>
              <Button type="submit" loading={busy} disabled={!confirmed}>Réinscrire</Button>
            </form>
          )}
        </DialogContent>
      )}
    </Dialog>
  );
}

type Person = { id: string; matricule: string; firstName: string; lastName: string; birthDate: string | null; status: string; lastClass: string | null; lastYear: string | null; lastStatus: string | null };
type Pair = { id: string | null; reason: string; reasonLabel: string; student?: Person; other?: Person; note?: string | null; signalledAt?: string | null; status?: 'DIFFERENT' | 'SAME'; decisionNote?: string | null; decidedAt?: string };

/** Doublons possibles, tranchés par la direction (lot G4). Rien n'est fusionné ni annulé automatiquement. */
export function Doublons() {
  const q = useApi<{ pending: Pair[]; decided: Pair[] }>('/students/duplicates');
  const [decide, setDecide] = useState<{ pair: Pair; decision: 'DIFFERENT' | 'SAME' } | null>(null);
  const [note, setNote] = useState('');
  const toast = useToast();
  const { busy, run } = useAction();

  return (
    <Loader {...q}>
      {(d) => (
        <div className="grid gap-4">
          <Card className="text-sm text-muted">
            Deux dossiers se ressemblent quand ils portent le même nom (accents et ordre des prénoms ignorés) et ont la même date de naissance
            ou un parent au même numéro. Vous décidez : élèves différents, ou même élève. Rien n’est jamais fusionné ni supprimé ;
            pour un même élève, annulez vous-même l’inscription du dossier en trop depuis sa fiche.
          </Card>
          {d.pending.length === 0 ? <Empty title="Aucun doublon possible à vérifier" /> : (
            <div className="grid gap-3">
              {d.pending.map((p) => (
                <Card key={p.id ?? `${p.student?.id}-${p.other?.id}`} className="grid gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Badge tone="warn">{p.reasonLabel}</Badge>
                    <span className="text-xs text-muted">{p.id ? `Signalé à l’inscription le ${date(p.signalledAt ?? null)}` : 'Repéré parmi les dossiers existants'}</span>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <PersonCard title="Dossier le plus récent" p={p.student} />
                    <PersonCard title="Dossier le plus ancien" p={p.other} />
                  </div>
                  {p.note && <p className="rounded-lg bg-sunk px-3 py-2 text-sm"><b>Motif donné à l’inscription :</b> {p.note}</p>}
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => { setNote(''); setDecide({ pair: p, decision: 'DIFFERENT' }); }}>Élèves différents</Button>
                    <Button size="sm" variant="outline" onClick={() => { setNote(''); setDecide({ pair: p, decision: 'SAME' }); }}>Même élève</Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
          {d.decided.length > 0 && (
            <Card>
              <p className="mb-2 font-bold">Dernières décisions</p>
              {/* Téléphone : une carte par décision. */}
              <ul className="grid gap-2 sm:hidden">
                {d.decided.map((p) => (
                  <li key={p.id} className="grid gap-1 rounded-lg border border-line p-3 text-sm">
                    <p className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-muted">{date(p.decidedAt ?? null)}</span>
                      <Badge tone={p.status === 'SAME' ? 'warn' : 'good'}>{p.status === 'SAME' ? 'Même élève' : 'Élèves différents'}</Badge>
                    </p>
                    <p>{p.student?.lastName} {p.student?.firstName} · <span className="font-mono">{p.student?.matricule}</span> et <span className="font-mono">{p.other?.matricule}</span></p>
                    {p.decisionNote && <p className="text-muted">{p.decisionNote}</p>}
                  </li>
                ))}
              </ul>
              <div className="hidden sm:block">
                <Table>
                  <thead><tr><th>Date</th><th>Dossiers</th><th>Décision</th><th>Note</th></tr></thead>
                  <tbody>
                    {d.decided.map((p) => (
                      <tr key={p.id}>
                        <td>{date(p.decidedAt ?? null)}</td>
                        <td className="text-sm">{p.student?.lastName} {p.student?.firstName} · <span className="font-mono">{p.student?.matricule}</span> et <span className="font-mono">{p.other?.matricule}</span></td>
                        <td><Badge tone={p.status === 'SAME' ? 'warn' : 'good'}>{p.status === 'SAME' ? 'Même élève' : 'Élèves différents'}</Badge></td>
                        <td className="text-sm">{p.decisionNote ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            </Card>
          )}
          <Dialog open={!!decide} onOpenChange={(o) => !o && setDecide(null)}>
            {decide && (
              <DialogContent
                title={decide.decision === 'SAME' ? 'Même élève' : 'Élèves différents'}
                description={decide.decision === 'SAME'
                  ? 'Rien n’est fusionné : après cette décision, annulez l’inscription du dossier en trop depuis sa fiche (bouton « Annuler l’inscription »).'
                  : 'Les deux dossiers restent tels quels et ne seront plus proposés.'}
              >
                <form className="grid gap-3" onSubmit={async (e) => {
                  e.preventDefault();
                  const body = { studentId: decide.pair.student!.id, otherId: decide.pair.other!.id, decision: decide.decision, note: note.trim() || undefined };
                  if (await run(() => api.post('/students/duplicates/decision', body), toast, 'Décision enregistrée')) { setDecide(null); q.reload(); }
                }}>
                  <Field label="Note (facultatif)"><Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field>
                  {decide.decision === 'SAME' && decide.pair.student && (
                    <p className="text-sm">Dossier en trop probable : <Link className="font-bold text-brand" href={`/espace/eleves/${decide.pair.student.id}`}>{decide.pair.student.matricule}</Link> (le plus récent). À vérifier avant d’annuler.</p>
                  )}
                  <Button type="submit" loading={busy}>Enregistrer la décision</Button>
                </form>
              </DialogContent>
            )}
          </Dialog>
        </div>
      )}
    </Loader>
  );
}

function PersonCard({ title, p }: { title: string; p?: Person }) {
  const { me } = useAuth();
  if (!p) return null;
  // Une inscription d'une année passée restée active jusqu'au bout : l'année est terminée (pas « Actif »).
  const finished = p.lastStatus === 'ACTIVE' && !!p.lastYear && !!me?.year && p.lastYear !== me.year.label;
  return (
    <div className="rounded-lg border border-line p-3 text-sm">
      <p className="text-xs font-bold uppercase text-muted">{title}</p>
      <Link href={`/espace/eleves/${p.id}`} className="text-base font-bold text-brand hover:underline">{p.lastName} {p.firstName}</Link>
      <p className="font-mono text-xs">{p.matricule}</p>
      <p>Né(e) le {date(p.birthDate)}</p>
      <p>{p.lastClass ? `${p.lastClass} · ${p.lastYear}` : 'Sans classe'} {finished ? <Badge tone="info">Année terminée</Badge> : p.lastStatus && <StatusBadge status={p.lastStatus} />}</p>
    </div>
  );
}
