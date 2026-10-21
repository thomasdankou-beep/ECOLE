# ERP scolaire · Lycée privé Saint Kisito-GESA

Application de gestion scolaire multi-établissements (SaaS), pilotée avec le **Lycée privé Saint Kisito-GESA** (Bénin, sites de Hêdomey et Togbin) : collège général de la 6e à la 3e et lycée technique par filières (F3, F4, OG, HR, MMV, G2, IMI).

Pensée pour le terrain : téléphone Android d’abord, réseau 3G/4G instable, Mobile Money, SMS, utilisateurs non techniciens.

## Ce que contient la version 0.1 (MVP)

| Espace | Écrans |
| --- | --- |
| Site public | Accueil de l’école (nom, logo, couleur et textes saisis par l’école), filières, sites, pré-inscription en ligne, vérification d’un document par QR code |
| Direction | Tableau de bord par site, élèves, pré-inscriptions, emploi du temps (ajout, déplacement, annulation avec contrôle des conflits et notification), bulletins (validation et publication), assiduité, discipline (validation), finances, frais et tarifs (grille par niveau et filière), stages en entreprise et travaux d’atelier, documents, personnel et rôles, paramètres (identité officielle, signature et cachet, logo, couleur et textes du site public, classes, coefficients, salles et ateliers, mentions), journal d’audit |
| Secrétariat | Inscription complète en une fois (élève, parents, comptes, factures), pré-inscriptions, dossiers élèves, documents officiels en lot |
| Enseignant | Cours du jour, appel en quelques touches, saisie des notes et appréciations, publication aux familles, cahier de texte et devoirs, conseil de classe (professeur principal), proposition de sanction |
| Vie scolaire | Absences du jour, justificatifs à examiner, appel, sanctions |
| Comptable | Tableau de bord, guichet avec reçu numéroté, factures (unitaires et en lot), paiements et export Excel (CSV), impayés et relances SMS, tarifs, clôture de caisse |
| Parent | Enfant suivi (plusieurs enfants), notes, bulletins, absences et justification avec photo, devoirs, emploi du temps, frais et **paiement Mobile Money**, reçus, documents |
| Élève | Notes, bulletins, emploi du temps, devoirs, absences, documents |

| Plateforme (Super Admin) | Création d’une école avec son adresse et son premier compte Direction, liste des écoles avec leur activité, suspension et réactivation, nouveau mot de passe Direction, journal des actions |

Documents imprimables (format A4, QR code vérifiable) : bulletin, reçu, certificat de scolarité, attestations d’inscription et de paiement, carte scolaire.

Sécurité : isolation des écoles par Row Level Security PostgreSQL, mots de passe argon2id, session courte avec renouvellement par cookie httpOnly, verrouillage après 5 échecs, double authentification (TOTP), droits par rôle et par site, notes et paiements jamais supprimés, journal d’audit en ajout seul.

## Charger les données d’une école depuis un fichier

Chaque école peut tout saisir à l’écran. Pour aller plus vite, ses niveaux, filières, frais, coordonnées et textes publics peuvent aussi être décrits dans un fichier JSON et chargés dans son espace, sans rien effacer ; tout reste modifiable ensuite dans l’application :

`npm run school:import -w apps/api -- <identifiant-ecole> apps/api/data/ecoles/<fichier>.json`

Exemple : `apps/api/data/ecoles/saint-kisito-2026-2027.json`, recopié de la fiche de renseignement 2026-2027 de Saint Kisito (le jeu de démonstration le charge aussi). Les points à préciser par l’école sont listés à la fin du fichier et affichés au chargement.

## Vendre le logiciel à d’autres écoles (plateforme multi-écoles)

Un seul serveur sert toutes les écoles clientes. Chaque école a sa propre adresse (`<identifiant>.<domaine de la plateforme>`, ou son propre nom de domaine), ses données séparées par la Row Level Security, et saisit elle-même son nom, son logo, sa couleur et les textes de son site.

1. Dans `.env` : `PLATFORM_DOMAIN=` le domaine de la plateforme, `SITE_ADDRESS=https://`, `TENANT_SLUG=` vide, `SHOW_DEMO_ACCOUNTS=false`. Le DNS doit envoyer `*.<domaine>` vers le serveur ; Caddy obtient un certificat HTTPS pour chaque école réelle, et seulement pour elles.
2. Créer le premier compte Super Admin (le mot de passe provisoire s’affiche une seule fois) :
   `docker compose exec api npm run platform:admin -- vous@exemple.bj "Votre nom"`
3. Se connecter sur `https://<domaine>/plateforme/connexion`, choisir son mot de passe, puis « Nouvelle école ». Le chef d’établissement reçoit son mot de passe provisoire par SMS et l’écran l’affiche une fois.

Sans `PLATFORM_DOMAIN`, l’installation sert une seule école (`TENANT_SLUG`), comme avant. Le domaine de la plateforme et la tarification des abonnements restent à décider (voir INFORMATION MANQUANTE).

## Essayer en ligne avec GitHub Codespaces (sans rien installer)

Sur la page du dépôt : bouton vert **Code** → onglet **Codespaces** → **Create codespace on main**. Une fois le codespace ouvert, tapez `./demarrer.sh` dans son terminal (plusieurs minutes la première fois) ; quand il affiche « Site prêt », ouvrez l’onglet **Ports** et cliquez sur l’adresse du port 8080.

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
npm test            # 45 tests (calcul des moyennes, sécurité, isolation des écoles, paiements, bulletins, plateforme)
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
| D3 | Administration de la plateforme | Plateforme unique avec espace Super Admin (`/plateforme`), une adresse par école |
| D4 | Mobile | Application web installable (PWA) d’abord ; application Expo plus tard |
| D5 | Authentification | Interne à l’API NestJS (pas de service externe) |
| D6 | Hors ligne | Prévu en V1.1 (le service worker met déjà en cache l’enveloppe du site) |
| D7 | Pays | Bénin d’abord (+229, FCFA, BEPC, CAP, DT ; e-MECeF à raccorder) |

## INFORMATION MANQUANTE

Rien de ce qui suit n’a été inventé. Ces points sont signalés dans le code et à l’écran.

**À saisir par l’école dans l’espace Direction** (les écrans existent, les valeurs réelles manquent) :

| Information | Où la saisir |
| --- | --- |
| Frais par niveau : inscription et réinscription, tranches, frais généraux, TP, frais facultatifs | Frais et tarifs (grille par niveau, ou par niveau et filière) ; chargés pour Saint Kisito depuis sa fiche 2026-2027 |
| Coefficients par matière et par classe, règle « note manquante » | Paramètres › Coefficients (par niveau) ou Classes et matières (par classe) |
| Seuils des mentions et libellés | Paramètres › Mentions et règles |
| Classes, enseignants, salles et ateliers, emploi du temps | Paramètres › Classes et matières, Sites, salles, matières ; Personnel ; Emploi du temps |
| Numéro d’autorisation, mentions légales, nom, signature et cachet du chef d’établissement | Paramètres › Établissement (imprimés sur bulletins, reçus et attestations) |
| Nom de l’école, logo, couleur, textes du site public | Paramètres › Logo et site public |
| Organisation des stages en entreprise et des travaux d’atelier | Stages et ateliers |

**À fournir pour brancher les services externes** :

1. **Prestataire Mobile Money** : contrat et identifiants (CinetPay, PayDunya ou autre). En attendant : mode test.
2. **Fournisseur SMS** et nom d’expéditeur. En attendant : les SMS sont écrits dans le journal de l’API.
3. **Facturation normalisée e-MECeF** (DGI Bénin) : identifiants et raccordement ; les reçus actuels sont non fiscaux.
4. Nom de domaine de la plateforme (et des écoles qui ont le leur) et hébergement de production.
5. Tarifs et facturation des abonnements des écoles clientes : non construits, à définir avant la vente.

## Prochaines étapes proposées

- Validation des écrans par l’école sur des téléphones réels, puis saisie des vraies données.
- Branchement du prestataire de paiement et du fournisseur SMS dès que les contrats existent.
- V1.1 : mode hors ligne (appel et notes), facturation des abonnements, PDF serveur, e-MECeF, application mobile.

## Conventions

Branches : `main` (production), `develop` (intégration), `feature/*`, `fix/*`, une fonctionnalité par branche.
