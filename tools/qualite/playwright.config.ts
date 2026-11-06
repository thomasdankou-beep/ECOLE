import { defineConfig, devices } from '@playwright/test';

/**
 * Tests de navigateur (SEC-043) sur l'application lancée avec la base de test erp_test et le jeu de
 * démonstration (données fictives). L'API et le site doivent déjà tourner : voir le workflow
 * .github/workflows/tests.yml, ou en local `npm run e2e` après avoir démarré l'API (4000) et le site (3000).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 240_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'rapport-e2e' }]] : 'list',
  globalSetup: './e2e/preparation.ts',
  use: {
    baseURL: process.env.WEB_URL ?? 'http://localhost:3000',
    locale: 'fr-FR',
    trace: 'off',
    screenshot: 'only-on-failure',
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
  projects: [
    { name: 'bureau', use: { ...devices['Desktop Chrome'] } },
    { name: 'telephone', use: { ...devices['Pixel 7'] } },
  ],
});
