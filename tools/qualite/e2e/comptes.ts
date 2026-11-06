/** Comptes fictifs du jeu de démonstration (prisma/seed.ts) et comptes créés par preparation.ts. */
export const MOT_DE_PASSE = 'Kisito2026';
export const COMPTES = {
  direction: '+2290190000010',
  secretariat: '+2290190000011',
  enseignant: '+2290190000001',
  vieScolaire: '+2290190000012',
  comptable: '+2290190000013',
  parent: '+2290197000001',
  eleve: 'SKG-26-0001',
} as const;
/** Compte qui doit changer son mot de passe à la première connexion. */
export const PROVISOIRE = { identifiant: '+2290190009901', motDePasse: 'Provisoire-E2E-2026', nouveau: 'Nouveau-E2E-2026' };
export const SUPER_ADMIN = { email: 'e2e-plateforme@test.local', motDePasse: 'Plateforme-E2E-2026' };
