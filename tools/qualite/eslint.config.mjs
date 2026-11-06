// Contrôle de code minimal (SEC-043) : erreurs réelles seulement, pas de style.
// Lancé par le workflow GitHub (SEC-039) : cd tools/qualite && npm ci && npm run lint
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

// La configuration vit ici avec ses outils, mais s'applique à tout le dépôt (basePath).
export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/*.d.ts'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      // Le code existant utilise `any` aux frontières (Prisma JSON, réponses d'API) : toléré.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      '@typescript-eslint/no-empty-object-type': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Les tests chargent certains modules à la demande (require) pour les remplacer.
    files: ['**/apps/api/test/**'],
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['**/apps/web/**/*.tsx', '**/apps/web/**/*.ts'],
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'warn' },
  }
).map((c) => ({ basePath: '../..', ...c }));
