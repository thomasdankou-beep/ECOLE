export type ClassRow = {
  id: string; name: string; capacity: number | null; studentCount: number; siteId: string; levelId: string; trackId: string | null; headTeacherId: string | null;
  site: { id: string; name: string }; level: { id: string; name: string; position: number }; track: { id: string; code: string; name: string } | null;
  headTeacher: { id: string; firstName: string; lastName: string } | null;
  subjects: { id: string; coefficient: number | string; subject: { id: string; code: string; name: string }; assignments: { id: string; teacher: { id: string; firstName: string; lastName: string } }[] }[];
};
export type StudentRow = { id: string; matricule: string; firstName: string; lastName: string; sex: 'M' | 'F' | null; birthDate: string | null; status: string; class: { id: string; name: string; site: { name: string } } | null; balance?: number };
export type Term = { id: string; name: string; position: number; startDate: string; endDate: string; weight: string };

export const DOC_KINDS: Record<string, string> = {
  CERTIFICAT_SCOLARITE: 'Certificat de scolarité',
  ATTESTATION_INSCRIPTION: 'Attestation d’inscription',
  CARTE_SCOLAIRE: 'Carte scolaire',
  ATTESTATION_PAIEMENT: 'Attestation de paiement',
};
