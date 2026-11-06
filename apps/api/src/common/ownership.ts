import { NotFoundException } from '@nestjs/common';
import { Tx } from './prisma.service';

const LABEL = {
  student: 'Élève introuvable dans votre établissement',
  class: 'Classe introuvable dans votre établissement',
  site: 'Site introuvable dans votre établissement',
  level: 'Niveau introuvable dans votre établissement',
  track: 'Filière introuvable dans votre établissement',
  user: 'Personne introuvable dans votre établissement',
  subject: 'Matière introuvable dans votre établissement',
  term: 'Période introuvable dans votre établissement',
  room: 'Salle introuvable dans votre établissement',
  classSubject: 'Matière de classe introuvable dans votre établissement',
  feeType: 'Frais introuvable dans votre établissement',
  internshipPeriod: 'Période de stage introuvable dans votre établissement',
} as const;

export type Owned = keyof typeof LABEL;
type Ref = string | null | undefined;

/**
 * Vérifie que chaque identifiant reçu désigne une fiche de l'établissement courant (SEC-001).
 * PostgreSQL ne passe pas les clés étrangères par la Row Level Security : sans ce contrôle,
 * une école pourrait enregistrer chez elle un lien vers la fiche d'une autre école.
 * La lecture se fait dans la transaction de l'établissement (forTenant), donc sous RLS :
 * une fiche d'une autre école est introuvable, exactement comme un identifiant inventé.
 */
export async function assertOwned(tx: Tx, refs: Partial<Record<Owned, Ref | Ref[]>>) {
  for (const [model, value] of Object.entries(refs) as [Owned, Ref | Ref[]][]) {
    const ids = [...new Set((Array.isArray(value) ? value : [value]).filter((v): v is string => !!v))];
    if (!ids.length) continue;
    const found: number = await (tx as any)[model].count({ where: { id: { in: ids } } });
    if (found !== ids.length) throw new NotFoundException(LABEL[model]);
  }
}
