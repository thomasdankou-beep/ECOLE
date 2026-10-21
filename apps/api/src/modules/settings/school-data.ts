import { Cycle, FeeAudience, Prisma } from '@prisma/client';
import { tenantSettings } from './settings.service';

type Tx = Prisma.TransactionClient;

/**
 * Données d'une école décrites dans un fichier (niveaux, filières, frais, coordonnées, textes publics),
 * chargées dans son espace. Ce n'est qu'un raccourci de saisie : tout reste ensuite modifiable dans l'application,
 * et une école sans fichier saisit les mêmes informations à l'écran.
 */
export type SchoolData = {
  source?: string;
  /** Année scolaire visée (libellé), qui doit déjà exister dans l'espace de l'école. */
  year: string;
  identity?: { phone?: string; email?: string; address?: string };
  sites?: { name: string; address?: string; phone?: string }[];
  levels?: { name: string; cycle: Cycle }[];
  tracks?: { code: string; name: string; cycle: Cycle }[];
  fees?: {
    name: string;
    dueDate?: string;
    audience?: FeeAudience;
    optional?: boolean;
    /** Une ligne par groupe de niveaux, par filière (frais de TP) ou pour tous (« all »). */
    rows: { levels?: string[]; track?: string; all?: boolean; amount: number }[];
  }[];
  public?: Record<string, unknown>;
  unresolved?: string[];
};

/** Ajoute ou met à jour, sans jamais rien supprimer : ce que l'école a saisi elle-même et qui n'est pas dans le fichier reste en place. */
export async function applySchoolData(tx: Tx, tenantId: string, data: SchoolData) {
  const year = await tx.academicYear.findFirst({ where: { label: data.year } });
  if (!year) throw new Error(`L'année ${data.year} n'existe pas encore dans cet établissement : créez-la d'abord dans Paramètres.`);
  const counts = { levels: 0, tracks: 0, sites: 0, fees: 0 };

  for (const [i, l] of (data.levels ?? []).entries()) {
    await tx.level.upsert({
      where: { tenantId_name: { tenantId, name: l.name } },
      update: { cycle: l.cycle, position: i + 1 },
      create: { tenantId, name: l.name, cycle: l.cycle, position: i + 1 },
    });
    counts.levels++;
  }
  for (const t of data.tracks ?? []) {
    await tx.track.upsert({ where: { tenantId_code: { tenantId, code: t.code } }, update: { name: t.name, cycle: t.cycle }, create: { tenantId, ...t } });
    counts.tracks++;
  }
  for (const s of data.sites ?? []) {
    const existing = await tx.site.findFirst({ where: { name: s.name } });
    const fields = { ...(s.address ? { address: s.address } : {}), ...(s.phone ? { phone: s.phone } : {}) };
    if (existing) await tx.site.update({ where: { id: existing.id }, data: fields });
    else await tx.site.create({ data: { tenantId, name: s.name, ...fields } });
    counts.sites++;
  }

  const levels = new Map((await tx.level.findMany()).map((l) => [l.name, l.id]));
  const tracks = new Map((await tx.track.findMany()).map((t) => [t.code, t.id]));
  for (const f of data.fees ?? []) {
    for (const r of f.rows) {
      const targets: { levelId: string | null; trackId: string | null }[] = r.track
        ? [{ levelId: null, trackId: tracks.get(r.track) ?? missing('filière', r.track) }]
        : r.all
          ? [{ levelId: null, trackId: null }]
          : (r.levels ?? []).map((name) => ({ levelId: levels.get(name) ?? missing('niveau', name), trackId: null }));
      for (const t of targets) {
        const fields = {
          amount: r.amount, active: true, audience: f.audience ?? 'ALL', optional: !!f.optional,
          dueDate: f.dueDate ? new Date(`${f.dueDate}T00:00:00Z`) : null,
        };
        const existing = await tx.feeType.findFirst({ where: { academicYearId: year.id, name: f.name, ...t } });
        if (existing) await tx.feeType.update({ where: { id: existing.id }, data: fields });
        else await tx.feeType.create({ data: { tenantId, academicYearId: year.id, name: f.name, ...t, ...fields } });
        counts.fees++;
      }
    }
  }

  if (data.identity || data.public) {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const current = tenantSettings(tenant.settings) as Record<string, any>;
    const settings = {
      ...current,
      identity: { ...current.identity, ...(data.identity ?? {}) },
      public: { ...(current.public ?? {}), ...(data.public ?? {}) },
    };
    await tx.tenant.update({ where: { id: tenantId }, data: { settings } });
  }
  return counts;
}

function missing(kind: string, name: string): never {
  throw new Error(`Le fichier cite le ${kind} « ${name} », absent de l'établissement et du fichier.`);
}
