'use client';

import { useRef, useState } from 'react';
import { Camera, CheckCircle2, Circle, FileText, ImageUp, Pencil, Trash2, Upload } from 'lucide-react';
import { Button, Dialog, DialogContent, Field, Input, Select, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useAction, useApi } from '@/lib/use-api';

export type StudentFile = { id: string; label: string; mime: string; size: number; createdAt: string; url: string };
export const ACCEPT_PHOTO = 'image/jpeg,image/png,image/webp';
export const ACCEPT_FILE = 'image/jpeg,image/png,image/webp,application/pdf';
/** Pièces courantes, complétées par celles que l'école demande (Paramètres › Logo et site public). */
const COMMON = ['Extrait de naissance', 'Pièce d’identité', 'Attestation', 'Certificat de scolarité', 'Bulletins de l’année précédente', 'Certificat médical'];

/** Pièces proposées : celles demandées par l'école d'abord, puis les pièces courantes. */
export function useDocumentLabels() {
  const s = useApi<{ tenant: { settings: { public?: { requiredDocuments?: string[] } } } }>('/settings');
  const required = s.data?.tenant.settings.public?.requiredDocuments ?? [];
  return { required, all: [...new Set([...required, ...COMMON])] };
}

export function size(n: number) {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`;
}

export function Avatar({ url, name, className = 'size-24' }: { url: string | null; name: string; className?: string }) {
  return url
    ? <img src={url} alt={`Photo de ${name}`} className={`${className} flex-none rounded-xl border border-line object-cover`} />
    : <div className={`${className} grid flex-none place-items-center rounded-xl bg-brand-soft font-display text-3xl font-bold text-brand`}>{name.charAt(0)}</div>;
}

/** Photo de l'élève avec envoi, remplacement et retrait (direction et secrétariat). */
export function StudentPhoto({ studentId, url, name, editable, onChange }: { studentId: string; url: string | null; name: string; editable: boolean; onChange: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const { busy, run } = useAction();
  return (
    <div className="flex items-center gap-4">
      <Avatar url={url} name={name} />
      {editable && (
        <div className="grid gap-1.5">
          <input ref={input} type="file" accept={ACCEPT_PHOTO} capture="user" className="hidden" onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            const body = new FormData();
            body.append('file', file);
            if (await run(() => api.post(`/students/${studentId}/photo`, body), toast, 'Photo enregistrée')) onChange();
          }} />
          <Button type="button" size="sm" variant="outline" loading={busy} onClick={() => input.current?.click()}><Camera className="size-4" /> {url ? 'Changer la photo' : 'Ajouter une photo'}</Button>
          {url && <Button type="button" size="sm" variant="ghost" loading={busy} onClick={async () => { if (await run(() => api.del(`/students/${studentId}/photo`), toast, 'Photo retirée')) onChange(); }}><Trash2 className="size-4" /> Retirer</Button>}
        </div>
      )}
    </div>
  );
}

/** Pièces du dossier : liste, pièces demandées par l'école manquantes, ajout, remplacement, renommage, retrait. */
export function StudentFiles({ studentId, files, onChange }: { studentId: string; files: StudentFile[]; onChange: () => void }) {
  const labels = useDocumentLabels();
  const toast = useToast();
  const { busy, run } = useAction();
  const [add, setAdd] = useState<{ label: string; custom: string; file: File | null } | null>(null);
  const [edit, setEdit] = useState<(StudentFile & { file: File | null }) | null>(null);
  const has = (l: string) => files.some((f) => f.label.toLowerCase() === l.toLowerCase());
  return (
    <div className="grid gap-3">
      {labels.required.length > 0 && (
        <ul className="grid gap-1 text-sm">
          {labels.required.map((l) => (
            <li key={l} className="flex items-center gap-2">
              {has(l) ? <CheckCircle2 className="size-4 flex-none text-good" /> : <Circle className="size-4 flex-none text-muted" />}
              <span className={has(l) ? '' : 'text-muted'}>{l}</span>
              {!has(l) && <button type="button" className="text-xs font-bold text-brand hover:underline" onClick={() => setAdd({ label: l, custom: '', file: null })}>Ajouter</button>}
            </li>
          ))}
        </ul>
      )}
      {files.length > 0 && (
        <ul className="grid gap-1.5">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-2 rounded-lg bg-sunk px-3 py-2">
              <FileText className="size-5 flex-none text-brand" />
              <a href={f.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 font-bold hover:underline">
                <span className="block truncate">{f.label}</span>
                <span className="block text-xs font-normal text-muted">{f.mime === 'application/pdf' ? 'PDF' : 'Photo'} · {size(f.size)} · {date(f.createdAt)}</span>
              </a>
              <Button type="button" size="icon" variant="ghost" aria-label={`Modifier ${f.label}`} onClick={() => setEdit({ ...f, file: null })}><Pencil className="size-4" /></Button>
              <Button type="button" size="icon" variant="ghost" aria-label={`Retirer ${f.label}`} loading={busy} onClick={async () => { if (await run(() => api.del(`/students/${studentId}/files/${f.id}`), toast, 'Pièce retirée')) onChange(); }}><Trash2 className="size-4" /></Button>
            </li>
          ))}
        </ul>
      )}
      <Button type="button" variant="outline" className="justify-self-start" onClick={() => setAdd({ label: labels.all.find((l) => !has(l)) ?? labels.all[0], custom: '', file: null })}><Upload className="size-4" /> Ajouter une pièce</Button>
      <p className="text-xs text-muted">Photo ou scan PDF, 5 Mo au plus. Visible seulement par la direction et le secrétariat.</p>

      <Dialog open={!!add} onOpenChange={(o) => !o && setAdd(null)}>
        {add && (
          <DialogContent title="Ajouter une pièce au dossier">
            <form className="grid gap-3" onSubmit={async (e) => {
              e.preventDefault();
              const body = new FormData();
              body.append('label', add.label === 'AUTRE' ? add.custom : add.label);
              if (add.file) body.append('file', add.file);
              if (await run(() => api.post(`/students/${studentId}/files`, body), toast, 'Pièce ajoutée')) { setAdd(null); onChange(); }
            }}>
              <Field label="Pièce">
                <Select value={add.label} onChange={(e) => setAdd({ ...add, label: e.target.value })}>
                  {labels.all.map((l) => <option key={l} value={l}>{l}</option>)}
                  <option value="AUTRE">Autre pièce…</option>
                </Select>
              </Field>
              {add.label === 'AUTRE' && <Field label="Nom de la pièce"><Input value={add.custom} onChange={(e) => setAdd({ ...add, custom: e.target.value })} maxLength={120} required /></Field>}
              <Field label="Fichier (photo ou PDF)"><Input type="file" accept={ACCEPT_FILE} onChange={(e) => setAdd({ ...add, file: e.target.files?.[0] ?? null })} required /></Field>
              <Button type="submit" loading={busy}>Enregistrer</Button>
            </form>
          </DialogContent>
        )}
      </Dialog>
      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        {edit && (
          <DialogContent title="Modifier la pièce" description="Renommez-la ou remplacez le fichier par une version plus récente.">
            <form className="grid gap-3" onSubmit={async (e) => {
              e.preventDefault();
              const body = new FormData();
              body.append('label', edit.label);
              if (edit.file) body.append('file', edit.file);
              if (await run(() => api.patch(`/students/${studentId}/files/${edit.id}`, body), toast, 'Pièce mise à jour')) { setEdit(null); onChange(); }
            }}>
              <Field label="Nom de la pièce"><Input value={edit.label} onChange={(e) => setEdit({ ...edit, label: e.target.value })} maxLength={120} required /></Field>
              <Field label="Nouveau fichier (facultatif)"><Input type="file" accept={ACCEPT_FILE} onChange={(e) => setEdit({ ...edit, file: e.target.files?.[0] ?? null })} /></Field>
              <Button type="submit" loading={busy}><ImageUp className="size-4" /> Enregistrer</Button>
            </form>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
