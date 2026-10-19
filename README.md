# ERP scolaire · Lycée privé Saint Kisito-GESA

Application de gestion scolaire multi-établissements (SaaS), pilotée avec le **Lycée privé Saint Kisito-GESA** (Bénin, sites de Hêdomey et Togbin) : collège général de la 6e à la 3e et lycée technique par filières (F3, F4, OG, HR, MMV, G2, IMI).

Pensée pour le terrain : téléphone Android d’abord, réseau 3G/4G instable, Mobile Money, SMS, utilisateurs non techniciens.

## Ce que contient la version 0.1 (MVP)

| Espace | Écrans |
| --- | --- |
| Site public | Accueil de l’école (contenu des affiches), filières, sites, pré-inscription en ligne, vérification d’un document par QR code |
| Direction | Tableau de bord par site, élèves, pré-inscriptions, emploi du temps (ajout, déplacement, annulation avec contrôle des conflits et notification), bulletins (validation et publication), assiduité, discipline (validation), finances, documents, personnel et rôles, paramètres, journal d’audit |
| Secrétariat | Inscription complète en une fois (élève, parents, comptes, factures), pré-inscriptions, dossiers élèves, documents officiels en lot |
| Enseignant | Cours du jour, appel en quelques touches, saisie des notes et appréciations, publication aux familles, cahier de texte et devoirs, conseil de classe (professeur principal), proposition de sanction |
| Vie scolaire | Absences du jour, justificatifs à examiner, appel, sanctions |
| Comptable | Tableau de bord, guichet avec reçu numéroté, factures (unitaires et en lot), paiements et export Excel (CSV), impayés et relances SMS, tarifs, clôture de caisse |
| Parent | Enfant suivi (plusieurs enfants), notes, bulletins, absences et justification avec photo, devoirs, emploi du temps, frais et **paiement Mobile Money**, reçus, documents |
| Élève | Notes, bulletins, emploi du temps, devoirs, absences, documents |

Documents imprimables (format A4, QR code vérifiable) : bulletin, reçu, certificat de scolarité, attestations d’inscription et de paiement, carte scolaire.

Sécurité : isolation des écoles par Row Level Security PostgreSQL, mots de passe argon2id, session courte avec renouvellement par cookie httpOnly, verrouillage après 5 échecs, double authentification (TOTP), droits par rôle et par site, notes et paiements jamais supprimés, journal d’audit en ajout seul.

## Essayer en ligne avec GitHub Codespaces (sans rien installer)

Sur la page du dépôt : bouton vert **Code** → onglet **Codespaces** → **Create codespace on main**. Le site se construit tout seul au démarrage (plusieurs minutes la première fois). Pour suivre l’avancement ou relancer, tapez `./demarrer.sh` dans le terminal du codespace ; quand il affiche « Site prêt », ouvrez l’onglet **Ports** et cliquez sur l’adresse du port 8080.

## Démarrer en 5 minutes avec Docker

Prérequis : Docker Desktop (Windows, Mac) ou Docker Engine (Linux), et Git.

```bash
git clone https://github.com/thomasdankou-beep/ecole.git
cd ecole
./demarrer.sh
```

Au premier lancement, le script crée le fichier `.env` avec des secrets générés, démarre les services et charge les données de démonstration. Sous Windows, lancez-le depuis « Git Bash ».

Lancement manuel, si vous préférez :

```bash
cp .env.docker.example .env      # puis remplir les secrets (openssl rand -base64 48)
docker compose up -d --build
docker compose exec api npm run db:seed   # données de démonstration (facultatif)
```

Pour arrêter : `docker compose down` (les données sont conservées).

Le site est sur http://localhost:8080. La documentation de l’API (OpenAPI) est sur http://localhost:8080/api/docs.

Pour la production : renseignez `SITE_ADDRESS` avec le nom de domaine (HTTPS automatique par Caddy), `WEB_ORIGIN` avec l’adresse publique, `COOKIE_SECURE=true` et `SHOW_DEMO_ACCOUNTS=false`, et ne lancez pas le jeu de démonstration.

### Comptes de démonstration (données fictives)

Mot de passe de tous les comptes : `Kisito2026`

| Rôle | Identifiant |
| --- | --- |
| Direction | +2290190000010 |
| Secrétariat | +2290190000011 |
| Enseignant (Codjo ZINSOU, professeur principal de 1re année F3) | +2290190000001 |
| Vie scolaire | +2290190000012 |
| Comptable | +2290190000013 |
| Parent (Afi DOSSOU, deux enfants) | +2290197000001 |
| Élève (Koffi DOSSOU) | SKG-26-0001 |

Le paiement Mobile Money fonctionne en **mode test** : une page de simulation remplace celle de l’opérateur, aucun argent réel n’est débité.

## Développement

Prérequis : Node 22, PostgreSQL 16, Redis 7 (facultatif : sans Redis, les relances SMS passent par une minuterie en mémoire).

```bash
npm install
# Rôles et base (une fois) : voir infra/postgres/init-roles.sh, avec les mots de passe de apps/api/.env
cp apps/api/.env.example apps/api/.env      # puis générer les secrets
cp apps/web/.env.example apps/web/.env.local
npm run db:migrate
npm run db:seed
npm run dev:api     # http://localhost:4000/api/v1
npm run dev:web     # http://localhost:3000
npm test            # 30 tests (calcul des moyennes, sécurité, isolation des écoles, paiements, bulletins)
```

Les tests de bout en bout utilisent une base séparée `erp_test` (voir `apps/api/test/setup-env.ts`).

## Architecture

Monolithe modulaire, un dépôt, deux applications :

```
apps/api   NestJS 11 · REST /api/v1 · OpenAPI · Prisma 6 · PostgreSQL 16 (RLS) · Redis + BullMQ
apps/web   Next.js 15 · React 19 · TypeScript · Tailwind 4 · composants façon shadcn/ui (Radix) · PWA
infra      Caddy (point d’entrée HTTPS), script des rôles PostgreSQL
```

- **Une école = un établissement (tenant)** avec ses sites. Chaque table métier porte `tenant_id` ; l’application se connecte avec un rôle sans privilège (`erp_app`) soumis à la Row Level Security, la variable `app.tenant_id` étant fixée à chaque transaction. Les migrations utilisent le rôle propriétaire `erp_owner`.
- **Le navigateur ne parle qu’à une seule origine** : Caddy envoie `/api/*` à l’API et le reste au site. En développement, Next.js relaie `/api/v1` vers l’API.
- **Paiement** : couche d’abstraction des prestataires (`apps/api/src/modules/payments/providers.ts`) avec un bac à sable signé HMAC, un adaptateur CinetPay à valider et un emplacement PayDunya. Le rapprochement est idempotent.
- **Notifications** : dans l’application d’abord ; SMS si non lu après 10 minutes (ou immédiatement pour une alerte urgente).
- **Bulletins** : saisie → contrôle → conseil de classe → validation (notes verrouillées) → publication (familles prévenues, QR code actif).

## Décisions appliquées par défaut

Ces choix suivent les recommandations de l’analyse (phase 1). Ils restent modifiables : dites lesquels changer.

| | Décision | Choix appliqué |
| --- | --- | --- |
| D1 | Périmètre d’un établissement | Un groupe scolaire avec ses sites (Hêdomey et Togbin dans le même espace) |
| D2 | Périmètre du MVP | MVP resserré : inscriptions, vie scolaire, notes et bulletins, finances, communication |
| D3 | Administration de la plateforme | Plateforme Super Admin séparée, **non construite dans cette version** |
| D4 | Mobile | Application web installable (PWA) d’abord ; application Expo plus tard |
| D5 | Authentification | Interne à l’API NestJS (pas de service externe) |
| D6 | Hors ligne | Prévu en V1.1 (le service worker met déjà en cache l’enveloppe du site) |
| D7 | Pays | Bénin d’abord (+229, FCFA, BEPC, CAP, DT ; e-MECeF à raccorder) |

## INFORMATION MANQUANTE

Rien de ce qui suit n’a été inventé. Ces points sont signalés dans le code et à l’écran.

1. **Prestataire Mobile Money** : contrat et identifiants (CinetPay, PayDunya ou autre). En attendant : mode test.
2. **Fournisseur SMS** et nom d’expéditeur. En attendant : les SMS sont écrits dans le journal de l’API.
3. **Montants réels des frais** de scolarité par niveau et filière (ceux de la démonstration sont fictifs).
4. **Coefficients réels** par matière et par filière, et la règle « note manquante » (ignorée ou comptée 0).
5. **Seuils des mentions** (16, 14, 12 sont des exemples) et libellés des décisions du conseil.
6. **Numéro d’autorisation d’ouverture** et mentions légales à imprimer sur les documents.
7. **Nom et signature du chef d’établissement** pour les documents officiels.
8. **Facturation normalisée e-MECeF** (DGI Bénin) : identifiants et raccordement ; les reçus actuels sont non fiscaux.
9. **Liste réelle** des classes, matières, enseignants, salles et emploi du temps (la démonstration en contient une partie fictive).
10. Stages en entreprise et travaux pratiques d’atelier (présents sur les affiches, absents du cahier des charges).
11. Nom de domaine et hébergement de production.

## Prochaines étapes proposées

- Validation des écrans par l’école sur des téléphones réels, puis saisie des vraies données.
- Branchement du prestataire de paiement et du fournisseur SMS dès que les contrats existent.
- V1.1 : mode hors ligne (appel et notes), plateforme Super Admin, PDF serveur, e-MECeF, application mobile.

## Conventions

Branches : `main` (production), `develop` (intégration), `feature/*`, `fix/*`, une fonctionnalité par branche.
