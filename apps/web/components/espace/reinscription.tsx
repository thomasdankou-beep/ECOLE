'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { CheckCircle2, RotateCcw, Search } from 'lucide-react';
import { Loader, StatusBadge } from '@/components/espace/bits';
import { Badge, Button, Card, Dialog, DialogContent, Empty, Field, Input, Select, Table, Textarea, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { date, fcfa } from '@/lib/format';
import { can } from '@/lib/perm';
import type { ClassRow } from '@/lib/types';
import { qs, useAction, useApi } from '@/lib/use-api';

type Candidate = {
  id: string; matricule: string; firstName: string; lastName: string; status: string; outcome: 'ADMIS' | 'NON_ADMIS' | null;
  fromClass: { id: string; name: string; level: string; site: { id: string; name: string } }; balance?: number;
};
type Candidates = { toYear: { id: string; label: string }; fromYear: { id: string; label: string } | null; years: { id: string; label: string }[]; items: Candidate[] };
type Pupil = { id: string; firstName: string; lastName: string; matricule: string };

const OUTCOME: Record<string, [string, 'good' | 'warn']> = { ADMIS: ['Admis', 'good'], NON_ADMIS: ['Non admis', 'warn'] };

/**
 * Réinscription pour l'année en cours (lot G4) : chaque élève garde son dossier et son matricule ; ses notes,
 * bulletins, paiements et absences des années passées ne changent pas.
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
              {selected.length > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-brand-soft px-3 py-2">
                  <span className="font-bold">{selected.length} élève(s) sélectionné(s)</span>
                  <Button size="sm" onClick={() => setPupils(d.items.filter((c) => selected.includes(c.id)))}><RotateCcw className="size-4" /> Réinscrire la sélection</Button>
                </div>
              )}
              <Table>
                <thead>
                  <tr>
                    <th className="w-10"><input type="checkbox" className="size-5" aria-label="Tout sélectionner" checked={allChecked} onChange={(e) => setSelected(e.target.checked ? rows.map((r) => r.id) : [])} /></th>
                    <th>Élève</th><th>Classe {d.fromYear.label}</th><th>Résultat</th>{showBalance && <th className="text-right">Solde dû</th>}<th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id}>
                      <td><input type="checkbox" className="size-5" aria-label={`Sélectionner ${c.lastName} ${c.firstName}`} checked={selected.includes(c.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, c.id] : selected.filter((x) => x !== c.id))} /></td>
                      <td><Link href={`/espace/eleves/${c.id}`} className="font-bold text-brand hover:underline">{c.lastName} {c.firstName}</Link><span className="block font-mono text-xs text-muted">{c.matricule}</span></td>
                      <td>{c.fromClass.name} · {c.fromClass.site.name}</td>
                      <td>{c.outcome ? <Badge tone={OUTCOME[c.outcome][1]}>{OUTCOME[c.outcome][0]}</Badge> : <span className="text-sm text-muted">Non saisi</span>}</td>
                      {showBalance && <td className={`text-right font-bold ${c.balance ? 'text-bad' : 'text-good'}`}>{fcfa(c.balance ?? 0)}</td>}
                      <td className="text-right"><Button size="sm" variant="outline" onClick={() => setPupils([c])}>Réinscrire</Button></td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              {showBalance && <p className="text-xs text-muted">Le solde dû est affiché pour information : il ne bloque pas la réinscription.</p>}
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

/** Choix de la classe de l'année en cours, puis réinscription élève par élève (un échec n'arrête pas les autres). */
export function ReenrollDialog({ pupils, year, classes, onClose }: { pupils: Pupil[] | null; year: string; classes: ClassRow[]; onClose: (done: boolean) => void }) {
  const [classId, setClassId] = useState('');
  const [createInvoices, setInvoices] = useState(true);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<{ ok: { name: string; reinstated: boolean; invoices: number }[]; failed: { name: string; message: string }[]; className: string } | null>(null);
  const close = () => { const done = !!report?.ok.length; setReport(null); setClassId(''); onClose(done); };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!pupils) return;
    setBusy(true);
    const ok: { name: string; reinstated: boolean; invoices: number }[] = [];
    const failed: { name: string; message: string }[] = [];
    for (const p of pupils) {
      const name = `${p.lastName} ${p.firstName}`;
      try {
        const r = await api.post<{ reinstated: boolean; invoices: number }>(`/students/${p.id}/reenroll`, { classId, createInvoices });
        ok.push({ name, reinstated: r.reinstated, invoices: r.invoices });
      } catch (err) {
        failed.push({ name, message: err instanceof Error ? err.message : 'Erreur' });
      }
    }
    setBusy(false);
    setReport({ ok, failed, className: classes.find((c) => c.id === classId)?.name ?? '' });
  }

  return (
    <Dialog open={!!pupils} onOpenChange={(o) => !o && close()}>
      {pupils && (
        <DialogContent
          title={pupils.length === 1 ? `Réinscrire ${pupils[0].lastName} ${pupils[0].firstName}` : `Réinscrire ${pupils.length} élèves`}
          description={`Pour ${year}, sur le dossier existant : même matricule, historique conservé.`}
        >
          {report ? (
            <div className="grid gap-3">
              {report.ok.length > 0 && (
                <p className="flex items-start gap-2 font-bold text-good">
                  <CheckCircle2 className="mt-0.5 size-5 flex-none" />
                  {report.ok.length} élève(s) réinscrit(s) en {report.className}.
                  {report.ok.some((r) => r.reinstated) ? ' Une inscription annulée ou terminée a été rétablie (aucune nouvelle facture).' : ''}
                  {report.ok.reduce((n, r) => n + r.invoices, 0) ? ` ${report.ok.reduce((n, r) => n + r.invoices, 0)} facture(s) créée(s).` : ''}
                </p>
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
              {pupils.length > 1 && <p className="text-sm">{pupils.map((p) => `${p.lastName} ${p.firstName}`).join(', ')}</p>}
              <Field label={`Classe ${year}`}>
                <Select value={classId} onChange={(e) => setClassId(e.target.value)} required>
                  <option value="">Choisir la classe</option>
                  {classes.map((c) => <option key={c.id} value={c.id} disabled={!!c.capacity && c.studentCount >= c.capacity}>{c.name} · {c.site.name} ({c.studentCount}{c.capacity ? `/${c.capacity}` : ''})</option>)}
                </Select>
              </Field>
              <label className="flex min-h-11 items-center gap-3 font-bold"><input type="checkbox" className="size-5" checked={createInvoices} onChange={(e) => setInvoices(e.target.checked)} /> Créer les factures des frais « anciens élèves » de la classe</label>
              <Button type="submit" loading={busy}>Réinscrire</Button>
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
