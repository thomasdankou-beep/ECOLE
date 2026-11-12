import { expect, test } from '@playwright/test';
import { COMPTES, SUPER_ADMIN } from './comptes';
import { connexion } from './connexion';

/** Lot G1 : les groupes scolaires à l'écran, au bureau et au téléphone (données fictives de la base de test). */

test('Super Admin : colonne Groupe, rubrique Groupes, nouveau groupe et son journal, aucun groupe choisi d’avance', async ({ page }, info) => {
  const nom = `Groupe fictif E2E ${info.project.name} ${Date.now().toString(36)}`;
  await page.goto('/plateforme/connexion');
  await page.getByLabel('Adresse e-mail').fill(SUPER_ADMIN.email);
  await page.getByLabel('Mot de passe').fill(SUPER_ADMIN.motDePasse);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await page.waitForURL(/\/plateforme$/);

  // L'école de démonstration forme un groupe à elle seule, à son nom.
  const demo = page.locator('tr', { hasText: 'saint-kisito' });
  await expect(demo.getByText('indépendante')).toBeVisible();

  // Changer le groupe : aucune destination n'est choisie d'avance, le bouton reste inactif tant qu'on n'a pas choisi.
  await demo.getByRole('button', { name: /^Changer le groupe de / }).click();
  const move = page.getByRole('dialog');
  await expect(move.getByLabel('Nouveau groupe')).toHaveValue('');
  await expect(move.getByRole('button', { name: 'Rattacher l’école' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(move).toBeHidden();

  // Rubrique Groupes : un nouveau groupe, sans école ; son journal ne montre pas les notes internes.
  await page.getByRole('group', { name: 'Rubrique' }).getByRole('button', { name: 'Groupes', exact: true }).click();
  await page.getByRole('button', { name: 'Nouveau groupe' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Nom du groupe').fill(nom);
  await dlg.getByLabel('Promoteur').fill('Promoteur FICTIF');
  await dlg.getByLabel('Notes internes').fill('Note interne fictive E2E');
  await dlg.getByRole('button', { name: 'Créer le groupe' }).click();
  await expect(dlg).toBeHidden();
  const ligne = page.locator('tr', { hasText: nom });
  await expect(ligne.getByText('Aucune école')).toBeVisible();
  await ligne.getByRole('button', { name: `Journal du groupe ${nom}` }).click();
  const journal = page.getByRole('dialog');
  await expect(journal.getByText('Groupe créé', { exact: true })).toBeVisible();
  await expect(journal.getByText('Note interne fictive E2E')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Un groupe sans école peut être supprimé.
  await ligne.getByRole('button', { name: `Supprimer le groupe ${nom}` }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Supprimer', exact: true }).click();
  await expect(page.locator('tr', { hasText: nom })).toHaveCount(0);
});

test('Direction : la carte « Groupe scolaire » montre seulement le nom du groupe', async ({ page }) => {
  await connexion(page, COMPTES.direction);
  await page.goto('/espace/parametres');
  // La carte entière : le titre est dans l'en-tête de la carte, le texte juste en dessous.
  const carte = page.getByRole('heading', { name: 'Groupe scolaire', exact: true }).locator('xpath=../..');
  const phrase = carte.locator('p', { hasText: 'Votre établissement appartient au groupe' });
  await expect(phrase).toBeVisible();
  await expect(phrase.getByText('Lycée privé Saint Kisito-GESA', { exact: true })).toBeVisible();
  await expect(carte.getByText(/jamais de nom d’élève ni de liste nominative/)).toBeVisible();
});
