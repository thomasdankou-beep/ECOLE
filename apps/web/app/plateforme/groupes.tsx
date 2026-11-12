'use client';

import { useEffect, useState } from 'react';
import { Network, Pencil, ScrollText, Trash2 } from 'lucide-react';
import { Button, Card, Dialog, DialogContent, Empty, ErrorNote, Field, Input, Select, Table, Textarea, useToast } from '@/components/ui';
import { pf } from '@/lib/platform';

/**
 * Groupes scolaires du Super Admin (lot G1, D-G1) : chaque école appartient à un groupe, le compte client ;
 * une école indépendante forme un groupe à elle seule, à son nom. Seul le Super Admin rattache ou détache
 * une école, avec un motif inscrit au journal de la plateforme.
 */

export type GroupRef = { id: string; name: string };
export type GroupSchool = { id: string; name: string; slug: string; status: 'ACTIVE' | 'SUSPENDED'; groupJoinedAt: string };
export type Group = {
  id: string; name: string; legalName: string | null; promoter: string | null; phone: string | null; email: string | null; address: string | null;
  country: string; taxId: string | null; status: 'ACTIVE' | 'SUSPENDED'; notes: string | null; createdAt: string; schools: GroupSchool[];
};
type CountryOption = { code: string; name: string };
type GroupLog = { id: string; action: string; actorName: string | null; data: Record<string, unknown> | null; createdAt: string };

const when = (d: string) => new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
const day = (d: string) => new Date(d).toLocaleDateString('fr-FR');
const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;

/** Libellés du journal de la plateforme pour les groupes. */
export const PLATFORM_GROUP_ACTIONS: Record<string, string> = {
  'platform.group.created': 'Groupe créé',
  'platform.group.updated': 'Groupe modifié',
  'platform.group.deleted': 'Groupe vide supprimé',
  'platform.group.school_attached': 'École rattachée à un groupe',
  'platform.group.school_detached': 'École détachée de son groupe',
  'platform.group.created_for_school': 'Groupe créé au nom d’une école (mise à jour)',
};

const GROUP_ACTIONS: Record<string, string> = {
  'group.created': 'Groupe créé',
  'group.created_for_school': 'Groupe créé au nom de l’école',
  'group.updated': 'Fiche du groupe modifiée',
  'group.school_created': 'Nouvelle école créée dans le groupe',
  'group.school_joined': 'École rattachée au groupe',
  'group.school_left': 'École retirée du groupe',
  'group.deleted': 'Groupe supprimé',
};
const FIELD_LABELS: Record<string, string> = {
  name: 'nom', legalName: 'raison sociale', promoter: 'promoteur', phone: 'téléphone', email: 'e-mail', address: 'adresse', country: 'pays', taxId: 'identifiant fiscal',
};

/** Détail lisible d'une ligne du journal de la plateforme qui concerne un groupe. */
export function platformGroupDetail(action: string, data: unknown) {
  const d = (data ?? {}) as Record<string, unknown>;
  if (action === 'platform.group.school_attached' || action === 'platform.group.school_detached') return `${d.fromGroupName} → ${d.toGroupName} · motif : ${d.motif}`;
  if (action.startsWith('platform.group.')) return (d.groupName ?? d.name ?? null) as string | null;
  return null;
}

function groupLogDetail(r: GroupLog) {
  const d = r.data ?? {};
  if (typeof d.tenantName === 'string') return d.tenantName;
  if (r.action === 'group.updated') return `Modifié : ${Object.keys(d).map((k) => FIELD_LABELS[k] ?? k).join(', ')}`;
  return typeof d.name === 'string' ? d.name : null;
}

export function Groups({ groups, countries, reload }: { groups: Group[]; countries: CountryOption[]; reload: () => void }) {
  const toast = useToast();
  const [edit, setEdit] = useState<Group | null>(null);
  const [log, setLog] = useState<Group | null>(null);
  const [remove, setRemove] = useState<Group | null>(null);
  const [busy, setBusy] = useState(false);
  const countryName = (c: string) => countries.find((x) => x.code === c)?.name ?? c;
  return (
    <>
      <p className="mb-3 text-sm text-muted">
        Chaque école appartient à un groupe ; une école indépendante forme un groupe à elle seule, à son nom. Pour rattacher ou détacher une école,
        utilisez le bouton <Network className="inline size-4 align-text-bottom" aria-hidden /> sur sa ligne, dans la rubrique Écoles.
      </p>
      {groups.length === 0 ? <Empty title="Aucun groupe" /> : (
        <Card className="overflow-x-auto p-0">
          <Table>
            <thead><tr><th>Groupe</th><th>Promoteur</th><th>Contact</th><th>Écoles</th><th>Créé le</th><th /></tr></thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.id}>
                  <td>
                    <span className="font-bold">{g.name}</span>
                    {g.legalName && <span className="block text-xs text-muted">{g.legalName}</span>}
                    <span className="block text-xs text-muted">{countryName(g.country)}</span>
                  </td>
                  <td className="text-sm">{g.promoter ?? '—'}</td>
                  <td className="text-sm">{[g.phone, g.email].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="text-sm">
                    {g.schools.length === 0 ? <span className="text-muted">Aucune école</span> : (
                      <>
                        <span className="font-bold">{plural(g.schools.length, 'école')}</span>
                        <span className="block">{g.schools.map((s) => s.name).join(', ')}</span>
                      </>
                    )}
                  </td>
                  <td className="text-sm">{day(g.createdAt)}</td>
                  <td>
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" aria-label={`Modifier le groupe ${g.name}`} onClick={() => setEdit(g)}><Pencil className="size-4" /></Button>
                      <Button variant="ghost" size="icon" aria-label={`Journal du groupe ${g.name}`} onClick={() => setLog(g)}><ScrollText className="size-4" /></Button>
                      {g.schools.length === 0 && <Button variant="ghost" size="icon" aria-label={`Supprimer le groupe ${g.name}`} onClick={() => setRemove(g)}><Trash2 className="size-4" /></Button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        {edit && <GroupDialog g={edit} countries={countries} done={() => { setEdit(null); reload(); }} />}
      </Dialog>
      <Dialog open={!!log} onOpenChange={(o) => !o && setLog(null)}>
        {log && <GroupLogDialog g={log} />}
      </Dialog>
      <Dialog open={!!remove} onOpenChange={(o) => !o && setRemove(null)}>
        {remove && (
          <DialogContent title={`Supprimer le groupe ${remove.name} ?`} description="Il n’a aucune école. Son journal est conservé.">
            <div className="flex flex-wrap gap-2">
              <Button variant="danger" loading={busy} onClick={async () => {
                setBusy(true);
                try {
                  await pf('DELETE', `/groups/${remove.id}`);
                  toast(`Groupe ${remove.name} supprimé`);
                  setRemove(null);
                  reload();
                } catch (e) {
                  toast(e instanceof Error ? e.message : 'Erreur', 'bad');
                } finally {
                  setBusy(false);
                }
              }}>Supprimer</Button>
              <Button variant="outline" onClick={() => setRemove(null)}>Annuler</Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}

/** Création ou modification d'un groupe. */
export function GroupDialog({ g, countries, done }: { g: Group | null; countries: CountryOption[]; done: () => void }) {
  const [f, setF] = useState({
    name: g?.name ?? '', legalName: g?.legalName ?? '', promoter: g?.promoter ?? '', phone: g?.phone ?? '', email: g?.email ?? '',
    address: g?.address ?? '', country: g?.country ?? 'BJ', taxId: g?.taxId ?? '', notes: g?.notes ?? '',
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <DialogContent
      title={g ? `Modifier le groupe ${g.name}` : 'Nouveau groupe scolaire'}
      description={g ? undefined : 'Le compte client qui regroupe une ou plusieurs écoles. Rattachez-y ensuite ses écoles depuis la rubrique Écoles.'}
    >
      <form className="grid gap-3" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          if (g) await pf('PATCH', `/groups/${g.id}`, f);
          else await pf('POST', '/groups', f);
          done();
        } catch (err) {
          setError(err);
        } finally {
          setBusy(false);
        }
      }}>
        <Field label="Nom du groupe"><Input value={f.name} onChange={set('name')} required minLength={3} maxLength={160} /></Field>
        <Field label="Raison sociale (facultative)"><Input value={f.legalName} onChange={set('legalName')} maxLength={200} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Promoteur"><Input value={f.promoter} onChange={set('promoter')} maxLength={160} /></Field>
          <Field label="Pays">
            <Select value={f.country} onChange={set('country')}>
              {!countries.some((c) => c.code === f.country) && <option value={f.country}>{f.country}</option>}
              {countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label="Téléphone"><Input type="tel" value={f.phone} onChange={set('phone')} maxLength={30} /></Field>
          <Field label="E-mail"><Input type="email" value={f.email} onChange={set('email')} maxLength={120} /></Field>
        </div>
        <Field label="Adresse"><Input value={f.address} onChange={set('address')} maxLength={300} /></Field>
        <Field label="Identifiant fiscal (facultatif)" hint="IFU ou équivalent, s’il est connu."><Input value={f.taxId} onChange={set('taxId')} maxLength={60} /></Field>
        <Field label="Notes internes" hint="Visibles seulement ici, jamais par le groupe ni par ses écoles."><Textarea value={f.notes} onChange={set('notes')} rows={3} maxLength={4000} /></Field>
        <ErrorNote error={error} />
        <Button type="submit" loading={busy}>{g ? 'Enregistrer' : 'Créer le groupe'}</Button>
      </form>
    </DialogContent>
  );
}

/** Rattacher une école à un autre groupe, ou l'en détacher : motif obligatoire, effet immédiat. */
export function MoveDialog({ t, groups, done }: { t: { id: string; name: string; group: GroupRef }; groups: Group[]; done: (message: string) => void }) {
  const current = groups.find((g) => g.id === t.group.id);
  const alone = (current?.schools.length ?? 1) <= 1;
  const others = groups.filter((g) => g.id !== t.group.id);
  // Aucun groupe présélectionné : le Super Admin choisit lui-même la destination.
  const [target, setTarget] = useState('');
  const [motif, setMotif] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <DialogContent title={`Changer le groupe de ${t.name}`}>
      <div className="grid gap-3">
        <p>Groupe actuel : <b>{t.group.name}</b>{alone ? ' (seule école de ce groupe)' : current ? ` (${plural(current.schools.length, 'école')})` : ''}</p>
        {alone && others.length === 0 ? (
          <Empty title="Aucun autre groupe">Créez d’abord le groupe dans la rubrique Groupes.</Empty>
        ) : (
          <form className="grid gap-3" onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              if (target === 'detach') {
                await pf('POST', `/tenants/${t.id}/detach`, { motif });
                done(`${t.name} forme désormais un groupe à elle seule`);
              } else {
                await pf('POST', `/tenants/${t.id}/attach`, { groupId: target, motif });
                done(`${t.name} est rattachée au groupe ${others.find((g) => g.id === target)?.name ?? ''}`);
              }
            } catch (err) {
              setError(err);
            } finally {
              setBusy(false);
            }
          }}>
            <Field label="Nouveau groupe">
              <Select value={target} onChange={(e) => setTarget(e.target.value)} required>
                <option value="" disabled>Choisir…</option>
                {!alone &&<option value="detach">Détacher : l’école forme un groupe à elle seule, à son nom</option>}
                {others.map((g) => <option key={g.id} value={g.id}>{g.name} ({plural(g.schools.length, 'école')})</option>)}
              </Select>
            </Field>
            <Field label="Motif" hint="Obligatoire. Inscrit au journal de la plateforme seulement. Ex. demande écrite du promoteur du 12/11/2026.">
              <Textarea value={motif} onChange={(e) => setMotif(e.target.value)} required minLength={5} maxLength={300} rows={2} />
            </Field>
            <p className="text-sm text-muted">
              Le changement prend effet aussitôt. Il est inscrit dans le journal de la plateforme, dans celui de chaque groupe concerné et dans celui de l’école.
              Les écoles d’un même groupe comptent toutes dans la même monnaie.
            </p>
            <ErrorNote error={error} />
            <Button type="submit" loading={busy} disabled={!target}>{target === 'detach' ? 'Détacher l’école' : 'Rattacher l’école'}</Button>
          </form>
        )}
      </div>
    </DialogContent>
  );
}

function GroupLogDialog({ g }: { g: Group }) {
  const [rows, setRows] = useState<GroupLog[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    pf<GroupLog[]>('GET', `/groups/${g.id}/audit`).then(setRows).catch(setError);
  }, [g.id]);
  return (
    <DialogContent title={`Journal du groupe ${g.name}`} description="Ce que Cahiora a fait sur ce groupe. Les motifs et les notes internes restent dans le journal de la plateforme.">
      <ErrorNote error={error} />
      {rows && (rows.length === 0 ? <Empty title="Aucune ligne" /> : (
        <ul className="grid gap-2">
          {rows.map((r) => (
            <li key={r.id} className="rounded-lg border border-line p-2.5 text-sm">
              <div className="flex flex-wrap justify-between gap-2"><b>{GROUP_ACTIONS[r.action] ?? r.action}</b><span className="text-muted">{when(r.createdAt)}</span></div>
              {groupLogDetail(r) && <p>{groupLogDetail(r)}</p>}
              <p className="text-xs text-muted">{r.actorName ?? '—'}</p>
            </li>
          ))}
        </ul>
      ))}
    </DialogContent>
  );
}
