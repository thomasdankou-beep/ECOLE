"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronRight,
  CirclePlay,
  FileText,
  GraduationCap,
  LayoutDashboard,
  MessageCircle,
  School,
  ShieldCheck,
  Users,
  Wallet,
} from "lucide-react";
import {
  annualPrice,
  formatNumber,
  MAX_STUDENTS,
  parseEnrollment,
  salesLink,
} from "./cahiora-offer";
import styles from "./cahiora.module.css";

export function CahioraWordmark() {
  return (
    <Link
      href="/cahiora"
      className={styles.wordmark}
      aria-label="CAHIORA, accueil"
    >
      <span className={styles.logoIcon}>
        <BookOpen size={23} aria-hidden="true" />
      </span>
      <span>
        CAHIORA<span className={styles.logoDot}>.</span>
      </span>
    </Link>
  );
}

export function CahioraMarketing() {
  const [enrollment, setEnrollment] = useState("300");
  const [school, setSchool] = useState("");
  const [name, setName] = useState("");
  const [prepared, setPrepared] = useState(false);
  const count = parseEnrollment(enrollment);
  const message = `Bonjour, je souhaite découvrir CAHIORA pour ${school.trim()}. Je suis ${name.trim()}. Effectif prévu : ${count ?? ""} élèves. Offre de lancement estimée : ${count ? formatNumber(annualPrice(count)) : ""} F CFA par année scolaire, hors SMS et frais de paiement. Pouvons-nous organiser une démonstration et préciser les conditions de démarrage ?`;

  return (
    <div className={styles.site}>
      <a className={styles.skipLink} href="#contenu">
        Aller au contenu
      </a>
      <header className={styles.header}>
        <div className={styles.nav}>
          <CahioraWordmark />
          <nav aria-label="Navigation principale" className={styles.navLinks}>
            <a href="#benefices">Pourquoi CAHIORA</a>
            <a href="#tarifs">Tarif</a>
            <a href="#questions">Questions</a>
          </nav>
          <Link className={styles.navCta} href="/cahiora/demo">
            Voir la démo <ArrowUpRight size={16} aria-hidden="true" />
          </Link>
        </div>
      </header>
      <main id="contenu">
        <section className={`${styles.container} ${styles.hero}`}>
          <div>
            <p className={styles.eyebrow}>
              <span /> La gestion scolaire, en toute clarté
            </p>
            <h1>
              Votre école.
              <br />
              Vos décisions.
              <br />
              <em>L’esprit tranquille.</em>
            </h1>
            <p className={styles.heroLead}>
              Gardez le contrôle, même loin du bureau. Inscriptions, scolarité,
              bulletins et suivi des familles se retrouvent dans un seul espace.
            </p>
            <div className={styles.actions}>
              <Link href="/cahiora/demo" className={styles.primary}>
                <CirclePlay size={20} aria-hidden="true" /> Explorer la
                démonstration
              </Link>
              <a href="#tarifs" className={styles.textLink}>
                Calculer mon tarif <ArrowRight size={18} aria-hidden="true" />
              </a>
            </div>
            <p className={styles.heroNote}>
              <Check size={16} aria-hidden="true" /> Démo sans compte{" "}
              <span>·</span> Offre de lancement : 500 F / élève / an
            </p>
          </div>
          <DashboardPreview />
        </section>

        <div className={styles.strip}>
          <div className={styles.container}>
            <span>
              <School size={20} aria-hidden="true" /> Un espace pour votre école
            </span>
            <span>
              <Users size={20} aria-hidden="true" /> Une vue pour chaque rôle
            </span>
            <span>
              <GraduationCap size={20} aria-hidden="true" /> Un lien avec les
              familles
            </span>
          </div>
        </div>

        <section
          id="benefices"
          className={`${styles.container} ${styles.section}`}
        >
          <div className={styles.sectionHeading}>
            <div>
              <p className={styles.eyebrow}>
                Moins de recherches. Plus de visibilité.
              </p>
              <h2>
                Les bonnes informations.
                <br />
                Au bon moment.
              </h2>
            </div>
            <p>
              Votre journée est déjà bien remplie. Retrouvez ce qui demande
              votre attention sans multiplier les registres et les fichiers.
            </p>
          </div>
          <div className={styles.benefitGrid}>
            {[
              {
                icon: Wallet,
                title: "Où en sont les paiements ?",
                text: "Consultez les versements, les soldes et les échéances. Retrouvez le reçu lié à chaque encaissement.",
                tag: "Scolarité & caisse",
              },
              {
                icon: FileText,
                title: "Les bulletins sont-ils prêts ?",
                text: "Suivez la saisie des notes, le contrôle et la validation avant la publication aux familles.",
                tag: "Notes & bulletins",
              },
              {
                icon: Users,
                title: "Que voient les parents ?",
                text: "Un espace personnel pour consulter la scolarité de leurs enfants, leurs bulletins et leur situation financière.",
                tag: "Relation avec les familles",
              },
            ].map(({ icon: Icon, title, text, tag }, i) => (
              <article className={styles.benefit} key={title}>
                <span className={styles.benefitNumber}>0{i + 1}</span>
                <Icon size={28} aria-hidden="true" />
                <p className={styles.cardTag}>{tag}</p>
                <h3>{title}</h3>
                <p>{text}</p>
              </article>
            ))}
          </div>
        </section>

        <section className={styles.demoBand}>
          <div className={`${styles.container} ${styles.demoBandInner}`}>
            <div>
              <p className={styles.eyebrow}>Touchez, essayez, comprenez</p>
              <h2>
                Un versement.
                <br />
                Un reçu. Un parent informé.
              </h2>
              <p>
                Explorez un même exemple du bureau de la direction à l’espace
                parent. Simulez un encaissement et retrouvez son effet sur le
                solde.
              </p>
              <Link href="/cahiora/demo" className={styles.primary}>
                Essayer ce parcours <ArrowRight size={18} aria-hidden="true" />
              </Link>
              <small>
                Parcours illustratif · données fictives · aucun paiement réel
              </small>
            </div>
            <div className={styles.receiptPreview}>
              <span className={styles.receiptTop}>
                <CheckCircle2 size={22} aria-hidden="true" /> Versement
                illustratif
              </span>
              <p>Scolarité · Aïcha Koné</p>
              <strong>
                25 000 <small>F CFA</small>
              </strong>
              <div className={styles.receiptLine}>
                <span>Montant dû</span>
                <b>100 000 F</b>
              </div>
              <div className={styles.receiptLine}>
                <span>Reste à régler</span>
                <b>75 000 F</b>
              </div>
              <div className={styles.progress}>
                <span style={{ width: "25%" }} />
              </div>
              <span className={styles.specimen}>
                SPÉCIMEN · SANS VALEUR COMPTABLE
              </span>
            </div>
          </div>
        </section>

        <section
          className={`${styles.container} ${styles.section} ${styles.schoolSection}`}
        >
          <div className={styles.schoolIllustration}>
            <span className={styles.browserBar}>
              <i />
              <i />
              <i />
              <span>La vitrine de votre établissement</span>
            </span>
            <div>
              <span className={styles.smallLabel}>
                Votre identité. Votre école.
              </span>
              <School size={44} aria-hidden="true" />
              <h3>
                Bienvenue dans
                <br />
                notre établissement.
              </h3>
              <p>Nos classes · Nos sites · Nos admissions</p>
              <span className={styles.mockButton}>
                Pré-inscrire mon enfant{" "}
                <ArrowRight size={16} aria-hidden="true" />
              </span>
              <small>Aperçu illustratif d’une vitrine scolaire</small>
            </div>
          </div>
          <div>
            <p className={styles.eyebrow}>
              Bien avant le premier jour de classe
            </p>
            <h2>
              Votre école se présente.
              <br />
              Les familles font le premier pas.
            </h2>
            <p>
              CAHIORA prévoit aussi une page publique aux couleurs de votre
              établissement : présentation, informations pratiques et formulaire
              de préinscription.
            </p>
            <ul className={styles.checkList}>
              <li>
                <Check size={18} /> Votre logo et vos informations
              </li>
              <li>
                <Check size={18} /> Les demandes regroupées pour le secrétariat
              </li>
              <li>
                <Check size={18} /> Un espace école accessible sur téléphone
              </li>
            </ul>
            <a href="#contact" className={styles.textLink}>
              Parlons de mon établissement{" "}
              <ArrowRight size={18} aria-hidden="true" />
            </a>
          </div>
        </section>

        <section id="tarifs" className={styles.pricingSection}>
          <div className={`${styles.container} ${styles.pricingGrid}`}>
            <div>
              <p className={styles.eyebrow}>Un tarif qui se comprend</p>
              <h2>
                500 F CFA.
                <br />
                Par élève.
                <br />
                <em>Pour l’année scolaire.</em>
              </h2>
              <p>
                Une offre de lancement facturée à l’établissement. Calculez
                votre budget, puis échangeons sur votre démarrage.
              </p>
              <ul className={styles.checkList}>
                <li>
                  <Check size={18} /> Inscriptions, classes et dossiers élèves
                </li>
                <li>
                  <Check size={18} /> Suivi de la scolarité et reçus
                </li>
                <li>
                  <Check size={18} /> Notes, bulletins et espace parents
                </li>
                <li>
                  <Check size={18} /> Présentation publique de votre école
                </li>
              </ul>
              <p className={styles.finePrint}>
                SMS et éventuels frais des prestataires de paiement en
                supplément. Mise en place, reprise des fichiers et besoins
                particuliers précisés dans la proposition commerciale.
              </p>
            </div>
            <div className={styles.priceCard}>
              <span className={styles.cardTag}>Votre estimation annuelle</span>
              <label htmlFor="effectif">
                Combien d’élèves dans votre école ?
              </label>
              <div className={styles.numberInput}>
                <input
                  id="effectif"
                  inputMode="numeric"
                  type="number"
                  min="1"
                  max={MAX_STUDENTS}
                  step="1"
                  value={enrollment}
                  onChange={(e) => {
                    setEnrollment(e.target.value);
                    setPrepared(false);
                  }}
                  aria-describedby="effectif-aide"
                />
                <span>élèves</span>
              </div>
              <div className={styles.presets}>
                {[100, 300, 500, 1000].map((n) => (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={count === n}
                    onClick={() => {
                      setEnrollment(String(n));
                      setPrepared(false);
                    }}
                  >
                    {formatNumber(n)}
                  </button>
                ))}
              </div>
              <div
                className={styles.priceOutput}
                aria-live="polite"
                aria-atomic="true"
              >
                {count ? (
                  <>
                    <strong>{formatNumber(annualPrice(count))}</strong>
                    <span>F CFA / année scolaire</span>
                    <small>{formatNumber(count)} élèves × 500 F CFA</small>
                  </>
                ) : (
                  <p>
                    Indiquez un nombre entier entre 1 et{" "}
                    {formatNumber(MAX_STUDENTS)} élèves.
                  </p>
                )}
              </div>
              <p id="effectif-aide" className={styles.finePrint}>
                L’effectif facturable et les modalités de règlement sont
                confirmés dans votre devis. Pour plusieurs sites, indiquez
                l’effectif total ; l’accompagnement est précisé selon le
                périmètre.
              </p>
              <a href="#contact" className={styles.primary}>
                Préparer mon démarrage{" "}
                <ArrowRight size={18} aria-hidden="true" />
              </a>
            </div>
          </div>
        </section>

        <section className={`${styles.container} ${styles.section}`}>
          <p className={styles.eyebrow}>Passons du projet au quotidien</p>
          <h2>Un démarrage préparé avec vous.</h2>
          <p className={styles.sectionIntro}>
            Avant de souscrire, nous précisons ensemble les données à reprendre,
            la configuration et la formation nécessaires.
          </p>
          <div className={styles.steps}>
            {[
              {
                title: "On découvre votre école",
                text: "Vos effectifs, vos sites, vos frais scolaires et vos habitudes de travail.",
              },
              {
                title: "On prépare votre espace",
                text: "Les classes, les accès et les informations de l’établissement ; la reprise des fichiers est étudiée avec vous.",
              },
              {
                title: "Votre équipe prend la main",
                text: "Une prise en main guidée et des conditions d’assistance définies dans votre offre.",
              },
            ].map((step, i) => (
              <article key={step.title}>
                <span>0{i + 1}</span>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section
          id="questions"
          className={`${styles.container} ${styles.faqSection}`}
        >
          <div>
            <p className={styles.eyebrow}>Avant de vous lancer</p>
            <h2>
              Vos questions
              <br />
              méritent des réponses.
            </h2>
            <ShieldCheck size={42} aria-hidden="true" />
          </div>
          <div className={styles.faqList}>
            {[
              [
                "Les parents doivent-ils payer un abonnement ?",
                "Dans cette offre, l’abonnement CAHIORA est facturé à l’établissement selon son effectif. Les SMS et les éventuels frais de paiement en ligne sont séparés et doivent être précisés dans votre proposition.",
              ],
              [
                "Puis-je commencer sans paiement en ligne ?",
                "Oui. Le suivi des versements et des reçus au guichet peut être utilisé indépendamment d’un prestataire de paiement en ligne. Les moyens de paiement disponibles sont confirmés lors du paramétrage.",
              ],
              [
                "Mes fichiers Excel peuvent-ils être repris ?",
                "Nous examinons vos fichiers avant de vous proposer une reprise. Le format, le volume, les corrections nécessaires, le coût et le délai sont précisés avant le démarrage. L’import automatique en libre-service n’est pas proposé ici.",
              ],
              [
                "CAHIORA fonctionne-t-il sans connexion ?",
                "Une connexion internet est nécessaire pour les fonctions de gestion présentées. La possibilité d’installer le site sur le téléphone ne signifie pas que les saisies fonctionnent hors ligne.",
              ],
              [
                "Puis-je gérer un groupe scolaire ?",
                "CAHIORA prévoit un espace avec plusieurs sites. Nous précisons avec vous le périmètre du groupe, les accès et les besoins d’accompagnement avant de chiffrer la mise en place.",
              ],
              [
                "Comment démarrer et récupérer mes données ?",
                "La démonstration permet d’abord de découvrir les usages. Avant la souscription, demandez la proposition détaillant les conditions d’accès, d’hébergement, de sauvegarde, d’assistance et de restitution des données.",
              ],
            ].map(([q, a]) => (
              <details key={q}>
                <summary>
                  {q}
                  <ChevronRight size={18} aria-hidden="true" />
                </summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </section>

        <section
          id="contact"
          className={`${styles.container} ${styles.contactSection}`}
        >
          <div>
            <p className={styles.eyebrow}>
              Votre prochaine rentrée se prépare ici
            </p>
            <h2>
              Et si on parlait
              <br />
              de votre école ?
            </h2>
            <p>
              Présentez-nous votre établissement. Nous pourrons vous proposer
              une démonstration et préciser votre offre.
            </p>
            <span className={styles.contactLabel}>
              <MessageCircle size={19} aria-hidden="true" /> Échange avec DST
              TECHNOLOGIE sur WhatsApp
            </span>
          </div>
          <form
            className={styles.contactForm}
            onSubmit={(event) => {
              event.preventDefault();
              if (count && school.trim() && name.trim()) setPrepared(true);
            }}
          >
            <label htmlFor="ecole">
              Nom de votre établissement
              <input
                id="ecole"
                autoComplete="organization"
                required
                maxLength={120}
                value={school}
                onChange={(e) => {
                  setSchool(e.target.value);
                  setPrepared(false);
                }}
              />
            </label>
            <label htmlFor="responsable">
              Votre nom
              <input
                id="responsable"
                autoComplete="name"
                required
                maxLength={100}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setPrepared(false);
                }}
              />
            </label>
            <p>
              {count
                ? `${formatNumber(count)} élèves · ${formatNumber(annualPrice(count))} F CFA / année scolaire`
                : "Renseignez un effectif valide dans le calculateur."}{" "}
              <a href="#tarifs">Modifier l’effectif</a>
            </p>
            <button className={styles.primary} type="submit" disabled={!count}>
              Préparer ma demande <ArrowRight size={18} aria-hidden="true" />
            </button>
            <small>
              Ces informations restent sur cette page jusqu’à l’ouverture de
              WhatsApp. Aucun compte ni abonnement n’est créé.
            </small>
            {prepared && (
              <div className={styles.requestReady} role="status">
                <strong>Votre demande est prête.</strong>
                <p>
                  WhatsApp s’ouvrira avec votre message. Vous pourrez le
                  modifier avant de l’envoyer.
                </p>
                <a
                  href={salesLink(message)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.textLink}
                >
                  Ouvrir WhatsApp <ArrowUpRight size={18} aria-hidden="true" />
                </a>
              </div>
            )}
          </form>
        </section>
      </main>
      <footer className={`${styles.container} ${styles.footer}`}>
        <div>
          <CahioraWordmark />
          <p>La gestion scolaire, en toute clarté.</p>
        </div>
        <div>
          <Link href="/cahiora/demo">Démonstration</Link>
          <a href="#contact">Contact</a>
          <Link href="/connexion">Espace école</Link>
          <Link href="/plateforme/connexion">Administration</Link>
        </div>
        <small>CAHIORA · Une solution proposée par DST TECHNOLOGIE</small>
      </footer>
      <div className={styles.mobileCta}>
        <a href="#tarifs">500 F / élève / an</a>
        <Link href="/cahiora/demo">
          Voir la démo <ArrowRight size={17} aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}

function DashboardPreview() {
  return (
    <div className={styles.heroVisual}>
      <div className={styles.dashboard}>
        <div className={styles.dashboardHeader}>
          <span>
            <LayoutDashboard size={17} aria-hidden="true" /> Mon établissement
          </span>
          <span className={styles.demoBadge}>APERÇU FICTIF</span>
        </div>
        <div className={styles.dashboardBody}>
          <div className={styles.dashboardTitle}>
            <div>
              <small>VUE DIRECTION</small>
              <h2>Bonjour, Madame la Directrice.</h2>
              <p>Voici l’essentiel de votre établissement.</p>
            </div>
            <span className={styles.avatar}>MD</span>
          </div>
          <div className={styles.metricGrid}>
            <div>
              <Users size={19} aria-hidden="true" />
              <strong>300</strong>
              <span>élèves inscrits</span>
            </div>
            <div>
              <Wallet size={19} aria-hidden="true" />
              <strong>
                125 000 <small>F</small>
              </strong>
              <span>encaissés ce jour</span>
            </div>
          </div>
          <div className={styles.activity}>
            <div>
              <b>Derniers versements</b>
              <span>Ce jour</span>
            </div>
            {[
              ["AK", "Aïcha Koné", "25 000 F"],
              ["YD", "Yao Diabaté", "50 000 F"],
              ["FT", "Fatou Traoré", "50 000 F"],
            ].map(([initials, name, amount]) => (
              <div key={name}>
                <span className={styles.activityAvatar}>{initials}</span>
                <span>
                  {name}
                  <small>Scolarité</small>
                </span>
                <b>{amount}</b>
                <CheckCircle2 size={16} aria-hidden="true" />
              </div>
            ))}
          </div>
          <div className={styles.dashboardAlert}>
            <FileText size={20} aria-hidden="true" />
            <span>
              <b>Bulletins à préparer</b>
              <small>Retrouvez la progression de chaque classe.</small>
            </span>
            <ArrowRight size={17} aria-hidden="true" />
          </div>
        </div>
      </div>
      <div className={styles.floatingNote}>
        <CheckCircle2 size={25} aria-hidden="true" />
        <span>
          Chaque versement a sa trace.
          <small>Chaque famille retrouve son solde.</small>
        </span>
      </div>
    </div>
  );
}
