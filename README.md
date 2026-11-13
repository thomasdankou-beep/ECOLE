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

## Nouvelle année scolaire et réinscriptions (lot G4)

Chaque élève a un seul dossier et un seul matricule pour toute sa scolarité, et au plus une inscription par année scolaire (la base de données le garantit).

1. **Préparer l’année** (Direction) : Paramètres > Année et périodes, créer l’année suivante et ses périodes, puis l’activer ; créer ses classes (Paramètres > Classes et matières) et ses frais (Frais et tarifs ; les frais « anciens élèves » s’appliquent aux réinscriptions).
2. **Réinscrire** (Direction, Secrétariat) : Élèves > onglet « Réinscriptions » liste les élèves de l’année précédente qui n’ont pas encore d’inscription, avec leur classe, leur résultat de fin d’année et, pour qui voit les finances, leur solde dû. On en choisit un ou plusieurs, puis la classe. Le dossier, le matricule, les notes, bulletins, paiements, absences et décisions des années passées ne changent pas. Le solde dû est affiché pour information et ne bloque pas la réinscription (aucune règle de blocage n’a été donnée). Un élève parti peut aussi être réinscrit depuis son dossier.
3. **Saisie d’un « nouvel » élève qui a déjà un dossier** : l’inscription s’arrête quand un dossier porte le même nom (accents, majuscules, tirets, apostrophes et ordre des mots ignorés) avec la même date de naissance, ou un parent au même numéro. On réinscrit alors l’élève sur ce dossier ; si ce n’est pas le même élève, on l’inscrit en donnant un motif, et la direction est prévenue. Un secrétariat limité à un site apprend qu’un dossier existe sur l’autre site, sans en voir le détail.
4. **Doublons possibles** (Direction) : Élèves > onglet « Doublons possibles » montre les cas signalés à l’inscription et ceux repérés parmi les dossiers existants. La direction décide « élèves différents » ou « même élève » ; rien n’est jamais fusionné ni supprimé automatiquement. Pour un même élève, elle annule elle-même l’inscription du dossier en trop.
5. **Départ et annulation** : un départ (transfert, abandon) porte une date de sortie, ni avant la rentrée ni dans le futur ; une inscription saisie par erreur est annulée par la direction, avec un motif. Rien n’est supprimé : le parcours de l’élève garde chaque étape (date, auteur, motif), visible de la direction et du secrétariat seulement. Une inscription annulée ou terminée par un départ peut être rétablie (jamais une seconde inscription la même année, jamais de nouvelle facture).
6. **Pré-inscriptions par site** (GRP-003) : la famille choisit le site, ou « indifférent ». Un secrétariat limité à un site ne voit, ne reçoit et ne traite que les demandes de son site ; une demande sans site va au personnel de tout l’établissement, qui peut lui attribuer un site. Une pré-inscription ne sert qu’à une seule inscription.
7. **Base de données** : la migration `20261113140000_reinscription_g4` ajoute le type d’inscription, la date et le motif de sortie, l’annulation datée, le site des pré-inscriptions, le journal des inscriptions (en ajout seul) et les doublons à décider, sous la Row Level Security. Elle ajoute aussi des protections : élèves, inscriptions et factures ne se suppriment plus ; un bulletin publié ne se supprime plus ; une annulation exige une date et un motif. Elle ne modifie aucune ligne existante.
8. **Préparation de la facturation** : le code sait compter, pour une année et une date de référence, les élèves ayant une inscription active à la fin de ce jour (fuseau horaire de l’école), un élève n’étant jamais compté deux fois. Aucune facture d’abonnement n’est produite (lot de facturation à venir).

## Vendre le logiciel à d’autres écoles (plateforme multi-écoles)

Un seul serveur sert toutes les écoles clientes. Chaque école a sa propre adresse (`<identifiant>.<domaine de la plateforme>`, ou son propre nom de domaine), ses données séparées par la Row Level Security, et saisit elle-même son nom, son logo, sa couleur et les textes de son site.

1. Dans `.env` : `PLATFORM_DOMAIN=` le domaine de la plateforme, `SITE_ADDRESS=https://`, `TENANT_SLUG=` vide, `SHOW_DEMO_ACCOUNTS=false`. Le DNS doit envoyer `*.<domaine>` vers le serveur ; Caddy obtient un certificat HTTPS pour chaque école réelle, et seulement pour elles.
2. Créer le premier compte Super Admin (le mot de passe provisoire s’affiche une seule fois) :
   `docker compose exec api npm run platform:admin -- vous@exemple.bj "Votre nom"`
3. Se connecter sur `https://<domaine>/plateforme/connexion`, choisir son mot de passe, puis « Nouvelle école ». Le chef d’établissement reçoit son mot de passe provisoire par SMS et l’écran l’affiche une fois. Tant qu’aucun fournisseur SMS n’est branché, aucun SMS ne part : notez le mot de passe affiché à l’écran. Les journaux du serveur n’écrivent jamais le texte des SMS, donc ni les mots de passe ni les codes (SEC-044).

Sans `PLATFORM_DOMAIN`, l’installation sert une seule école (`TENANT_SLUG`), comme avant. Le domaine de la plateforme et la tarification des abonnements restent à décider (voir INFORMATION MANQUANTE).

### Groupes scolaires (lot G1)

Toute école appartient à un groupe scolaire, le compte client : une école indépendante forme un groupe d’un seul établissement, à son nom. La mise à jour du lot G1 rattache ainsi chaque école existante à un groupe créé à son nom, sans rien changer d’autre.

- **Super Admin, rubrique « Groupes »** : créer un groupe (nom, raison sociale, promoteur, coordonnées, notes internes), le modifier, supprimer un groupe vide. Un groupe qui a des écoles ne peut pas être supprimé (la base le refuse aussi).
- **Rattacher ou détacher une école** (icône de groupe sur la ligne de l’école) : seul le Super Admin le fait, avec un motif obligatoire. Une école détachée forme de nouveau un groupe à son nom. Chaque changement est inscrit dans le journal de la plateforme (avec le motif), dans celui de chaque groupe concerné (sans le motif ni le nom de l’autre groupe) et dans celui de l’école. Toutes les écoles d’un groupe comptent dans la même monnaie.
- **Direction de l’école** : Paramètres > Établissement affiche le nom de son groupe et la date du rattachement ; le groupe ne reçoit encore aucune donnée de l’école.
- **Base de données** : deux rôles dédiés, créés par `infra/postgres/roles-groupes.sh` (appelé par `installer-serveur.sh` et `demarrer.sh`, mots de passe `ERP_GROUP_PASSWORD` et `ERP_STATS_PASSWORD` générés dans `.env`). `erp_group` (future console du groupe) ne lit que son propre groupe, sans les notes internes, et aucune table d’école ; `erp_stats` (futurs chiffres agrégés) n’a encore aucun droit. Le rôle des écoles (`erp_app`) n’a aucun droit sur les tables des groupes.

## Mettre en ligne sur un serveur (VPS Ubuntu)

En root sur le serveur :

```bash
git clone https://github.com/thomasdankou-beep/ecole.git
cd ecole
./installer-serveur.sh
```

Le script installe Docker si besoin, crée `.env` avec des secrets de production aléatoires (jamais remplacés ensuite), sert le site en http sur l’adresse IP du serveur (port 80) et ne charge aucune donnée de démonstration. Le relancer met le site à jour sans toucher aux données. Ensuite : créer le compte Super Admin (`docker compose exec api npm run platform:admin -- vous@exemple.bj "Votre nom"`). Dès que le DNS envoie le domaine et `*.domaine` vers le serveur : `./installer-serveur.sh --domaine exemple.com` passe en HTTPS, chaque école sur `<identifiant>.exemple.com`.

### Téléphone perdu : récupérer un compte à double authentification

- **Chaque personne** garde ses 10 codes de récupération (Mon compte > Double authentification). Un code permet de se connecter sans le téléphone, une seule fois, puis de configurer le nouveau téléphone.
- **Téléphone et codes perdus (personnel d’une école)** : la direction ouvre une demande (menu « Récupération des comptes ») après avoir vérifié l’identité ; une autre personne de la direction la valide et remet le code de réactivation (24 heures, une seule fois). Un compte Direction est validé par le Super Admin (rubrique « Récupération des comptes » de `/plateforme`).
- **Super Admin, téléphone et codes perdus** : procédure exceptionnelle, seulement sur le serveur (accès à l’hébergement) :
  `docker compose exec api npm run platform:admin -- vous@exemple.bj --operateur "Prénom Nom" --motif "Téléphone volé le 12/11, codes perdus"`
  Elle remet un mot de passe provisoire (affiché une fois), retire l’ancienne double authentification et les anciens codes, coupe les sessions, et impose une nouvelle double authentification avant tout autre écran. L’opérateur et le motif sont inscrits au journal de la plateforme. Conseil : créez un second compte Super Admin confié à une personne de confiance.

### Comptes Direction limités à un site (GRP-001)

Une direction couvre toujours tout l’établissement. Un ancien compte Direction limité à un site est refusé partout (sauf sur son propre compte) tant qu’il n’est pas régularisé ; Personnel le signale « à corriger ».

- **Contrôle, en lecture seule** (à lancer avant la mise en ligne de la correction) : `docker compose exec api npm run directions:sites`. Il liste, école par école, les comptes concernés et dit si une autre direction peut les corriger elle-même.
- **Correction par l’école** : une autre direction de tout l’établissement ouvre le compte dans Personnel et l’enregistre (il couvre alors tout l’établissement), ou lui donne un autre rôle.
- **Correction par l’éditeur**, sur décision de l’école, quand personne d’autre ne peut le faire :
  `docker compose exec api npm run directions:sites -- --ecole <identifiant> --compte <id> --tous-les-sites --operateur "Prénom Nom" --motif "Décision de l’école du 12/11"`
  (ou `--retirer-direction` pour retirer seulement ce rôle). Les sessions du compte sont coupées et le changement est inscrit au journal de l’école avec l’opérateur et le motif.

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
docker compose exec api npm run db:seed   # données de démonstration, poste de test uniquement (efface l'école de démonstration)
```

Pour arrêter : `docker compose down` (les données sont conservées).

Le site est sur http://localhost:8080. La documentation de l’API (OpenAPI) est sur http://localhost:8080/api/docs après avoir mis `API_DOCS=true` dans `.env` ; elle est fermée par défaut en production (SEC-045). En développement (`npm run dev:api`), elle est sur http://localhost:4000/api/docs.

Pour la production : renseignez `SITE_ADDRESS` avec le nom de domaine (HTTPS automatique par Caddy), `WEB_ORIGIN` avec l’adresse publique, `COOKIE_SECURE=true` `SHOW_DEMO_ACCOUNTS=false` et `PRODUCTION_SERVER=true` (posé par `installer-serveur.sh`). Ne lancez jamais le jeu de démonstration sur le serveur : il refuse d’effacer une école qui n’est pas marquée « démonstration », et refuse de tourner quand `PRODUCTION_SERVER=true` (SEC-038).

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
# Rôles et base (une fois) : voir infra/postgres/init-roles.sh (erp_owner, erp_app, erp_platform) et roles-groupes.sh (erp_group, erp_stats), avec les mots de passe de apps/api/.env
cp apps/api/.env.example apps/api/.env      # puis générer les secrets
cp apps/web/.env.example apps/web/.env.local
npm run db:migrate
npm run db:seed
npm run dev:api     # http://localhost:4000/api/v1
npm run dev:web     # http://localhost:3000
npm test            # 181 tests (calcul des moyennes, sécurité, isolation des écoles, droits par rôle et par site, paiements, bulletins, plateforme, groupes scolaires et leur migration)
```

Les tests de bout en bout utilisent une base séparée `erp_test` (voir `apps/api/test/setup-env.ts`), et le test de la migration des groupes une base jetable `erp_migration_test` qu’il vide à chaque lancement.

Contrôle automatique (SEC-039, SEC-043) : à chaque envoi sur GitHub, le workflow `.github/workflows/tests.yml` crée une base PostgreSQL neuve, applique toutes les migrations, lance ESLint, les tests de l’API, construit l’API et le site, puis lance les tests de navigateur (bureau et téléphone). Le résultat s’affiche sur GitHub (onglet « Actions »). Ne mettez en ligne qu’une version au résultat vert. En local :

```bash
cd tools/qualite && npm ci
npm run lint        # contrôle du code
npm run e2e         # tests de navigateur : API (4000) et site (3000) lancés sur la base erp_test
```

## Architecture

Monolithe modulaire, un dépôt, deux applications :

```
apps/api   NestJS 11 · REST /api/v1 · OpenAPI · Prisma 6 · PostgreSQL 16 (RLS) · Redis + BullMQ
apps/web   Next.js 15 · React 19 · TypeScript · Tailwind 4 · composants façon shadcn/ui (Radix) · PWA
infra      Caddy (point d’entrée HTTPS), script des rôles PostgreSQL
```

- **Une école = un établissement (tenant)** avec ses sites. Chaque table métier porte `tenant_id` ; l’application se connecte avec un rôle sans privilège (`erp_app`) soumis à la Row Level Security, la variable `app.tenant_id` étant fixée à chaque transaction. Les migrations utilisent le rôle propriétaire `erp_owner`.
- **Un groupe scolaire = le compte client**, qui regroupe une ou plusieurs écoles (tables `school_groups` et `group_audit_logs`, hors des écoles). Le Super Admin passe par le rôle `erp_platform` ; la future console du groupe passera par `erp_group`, cloisonné par `app.group_id`.
- **Le navigateur ne parle qu’à une seule origine** : Caddy envoie `/api/*` à l’API et le reste au site. En développement, Next.js relaie `/api/v1` vers l’API.
- **Paiement** : couche d’abstraction des prestataires (`apps/api/src/modules/payments/providers.ts`) avec un bac à sable signé HMAC, un adaptateur CinetPay à valider et un emplacement PayDunya. Le rapprochement est idempotent. En production, le bac à sable est fermé (paiement en ligne indisponible, encaissement au guichet seulement) sauf si `ALLOW_SANDBOX_PAYMENTS=true` ; la page de simulation est réservée au parent connecté.
- **Notifications** : dans l’application d’abord ; SMS si non lu après 10 minutes (ou immédiatement pour une alerte urgente).
- **SMS aux parents** : à chaque paiement (« Le 28/09/2026 un paiement de 70 000 a été effectué pour NOM Prénom en classe de 6ème 6. NAP: 140 000, PAYE: 70 000, RESTE: 70 000 ») et à chaque absence à l’appel (matière et créneau du cours, d’après l’emploi du temps). Le SMS part au numéro du responsable dans la fiche de l’élève, même sans compte Cahiora. Réglages dans Paramètres > Mentions et règles (paiement, absence, « même si la notification a été vue ») ; suivi dans le menu « SMS envoyés » de la direction. Les textes restent dans l’alphabet GSM pour tenir en un seul SMS. Les SMS de mot de passe et de code ne sont jamais écrits dans ce journal.
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
2. **Fournisseur SMS** : BulkGate est branché (Côte d’Ivoire, Bénin). Dans `.env` du serveur : `SMS_PROVIDER=bulkgate`, `BULKGATE_APPLICATION_ID`, `BULKGATE_APPLICATION_TOKEN` (portail BulkGate, Simple API), et `SMS_SENDER` une fois le nom d’expéditeur validé par les opérateurs. Le nom propre à chaque école se saisit dans le Super Admin (fiche de l’école). Sans ces réglages : fournisseur « console », aucun SMS ne part.
3. **Facturation normalisée e-MECeF** (DGI Bénin) : identifiants et raccordement ; les reçus actuels sont non fiscaux.
4. Nom de domaine de la plateforme (et des écoles qui ont le leur) et hébergement de production.
5. Tarifs et facturation des abonnements des écoles clientes : non construits, à définir avant la vente.

## Prochaines étapes proposées

- Validation des écrans par l’école sur des téléphones réels, puis saisie des vraies données.
- Branchement du prestataire de paiement et du fournisseur SMS dès que les contrats existent.
- V1.1 : mode hors ligne (appel et notes), facturation des abonnements, PDF serveur, e-MECeF, application mobile.

## Conventions

Branches : `main` (production), `develop` (intégration), `feature/*`, `fix/*`, une fonctionnalité par branche.
