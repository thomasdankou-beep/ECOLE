"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  FileText,
  GraduationCap,
  LayoutDashboard,
  RotateCcw,
  Users,
  Wallet,
} from "lucide-react";
import { CahioraWordmark } from "./cahiora-marketing";
import { formatNumber } from "./cahiora-offer";
import styles from "./cahiora.module.css";

const ROLES = [
  { id: "direction", label: "Direction", icon: LayoutDashboard },
  { id: "caisse", label: "Comptabilité", icon: Wallet },
  { id: "enseignant", label: "Enseignant", icon: GraduationCap },
  { id: "parent", label: "Parent", icon: Users },
] as const;
type Role = (typeof ROLES)[number]["id"];

/** Standalone browser-only illustration. Never calls the school or payment APIs. */
export function CahioraDemo() {
  const [role, setRole] = useState<Role>("direction");
  const [paid, setPaid] = useState(25000);
  const [amount, setAmount] = useState("25000");
  const [gradeInput, setGradeInput] = useState("15");
  const [grade, setGrade] = useState<number | null>(null);
  const [notice, setNotice] = useState("");
  const [receipt, setReceipt] = useState<number | null>(null);
  const [payments, setPayments] = useState(1);
  const remaining = 100000 - paid;

  function reset() {
    setPaid(25000);
    setAmount("25000");
    setGradeInput("15");
    setGrade(null);
    setNotice("La démonstration a été réinitialisée.");
    setReceipt(null);
    setPayments(1);
    setRole("direction");
  }

  return (
    <div className={styles.site}>
      <a className={styles.skipLink} href="#demo-contenu">
        Aller à la démonstration
      </a>
      <header className={styles.header}>
        <div className={styles.nav}>
          <CahioraWordmark />
          <Link href="/cahiora" className={styles.textLink}>
            <ArrowLeft size={17} aria-hidden="true" /> Retour à l’offre
          </Link>
        </div>
      </header>
      <main
        id="demo-contenu"
        className={`${styles.container} ${styles.demoMain}`}
      >
        <p className={styles.eyebrow}>À vous de jouer</p>
        <h1>
          Une école.
          <br />
          <em>Quatre points de vue.</em>
        </h1>
        <p className={styles.demoIntro}>
          Explorez un parcours simplifié : enregistrez un versement, saisissez
          une note, puis consultez l’espace parent.
        </p>
        <div className={styles.demoDisclaimer}>
          <ShieldNote />
          <span>
            <b>Démonstration illustrative sur données fictives.</b> Aucun SMS
            envoyé, aucun paiement réel, aucune donnée d’établissement utilisée.
            Vos essais disparaissent au rechargement.
          </span>
        </div>
        <div className={styles.demoToolbar}>
          <div
            className={styles.roleButtons}
            aria-label="Choisir un point de vue"
          >
            {ROLES.map(({ id, label, icon: Icon }) => (
              <button
                type="button"
                key={id}
                aria-pressed={role === id}
                onClick={() => {
                  setRole(id);
                  setNotice("");
                }}
              >
                <Icon size={18} aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>
          <button className={styles.resetButton} type="button" onClick={reset}>
            <RotateCcw size={16} aria-hidden="true" /> Recommencer
          </button>
        </div>
        <section
          className={styles.demoWorkspace}
          aria-label={`Vue ${ROLES.find((r) => r.id === role)?.label}`}
        >
          <div className={styles.workspaceHeader}>
            <div>
              <span className={styles.smallLabel}>
                École Horizon · établissement fictif
              </span>
              <h2>
                {role === "direction"
                  ? "Votre école en un coup d’œil."
                  : role === "caisse"
                    ? "Un versement, un solde à jour."
                    : role === "enseignant"
                      ? "Une note saisie, un suivi partagé."
                      : "Toute la fratrie, dans un espace."}
              </h2>
            </div>
            <span className={styles.demoBadge}>SIMULATION</span>
          </div>
          {role === "direction" && (
            <>
              <div className={styles.demoMetrics}>
                <div>
                  <Users size={22} />
                  <strong>300</strong>
                  <span>élèves inscrits</span>
                </div>
                <div>
                  <Wallet size={22} />
                  <strong>{formatNumber(paid)} F</strong>
                  <span>encaissés dans cet exemple</span>
                </div>
                <div>
                  <FileText size={22} />
                  <strong>{formatNumber(remaining)} F</strong>
                  <span>solde d’Aïcha à régler</span>
                </div>
              </div>
              <div className={styles.demoTwoCol}>
                <div className={styles.demoPanel}>
                  <p className={styles.cardTag}>Votre prochain geste</p>
                  <h3>Suivez le même élève de la caisse au parent.</h3>
                  <p>
                    Dans cet exemple, la scolarité d’Aïcha est de 100 000 F CFA.
                    Un premier versement de 25 000 F est déjà enregistré.
                  </p>
                  <button
                    className={styles.primary}
                    type="button"
                    onClick={() => setRole("caisse")}
                  >
                    Simuler un versement <ArrowRight size={18} />
                  </button>
                </div>
                <div className={styles.demoPanel}>
                  <p className={styles.cardTag}>Suivi de l’exemple</p>
                  <ul className={styles.checkList}>
                    <li>
                      <CheckCircle2 size={18} /> {payments} versement
                      {payments > 1 ? "s" : ""} enregistré
                      {payments > 1 ? "s" : ""}
                    </li>
                    <li>
                      <CheckCircle2 size={18} /> Solde consultable dans la vue
                      parent
                    </li>
                    <li>
                      <GraduationCap size={18} />{" "}
                      {grade === null
                        ? "Une note à saisir pour Aïcha"
                        : `Note de français saisie : ${grade.toLocaleString("fr-FR")} / 20`}
                    </li>
                  </ul>
                </div>
              </div>
            </>
          )}
          {role === "caisse" && (
            <div className={styles.demoTwoCol}>
              <form
                className={styles.demoPanel}
                onSubmit={(event) => {
                  event.preventDefault();
                  const value = /^\d+$/.test(amount) ? Number(amount) : NaN;
                  if (
                    !Number.isSafeInteger(value) ||
                    value <= 0 ||
                    value > remaining
                  ) {
                    setNotice(
                      "Saisissez un montant entier supérieur à zéro, inférieur ou égal au reste à payer.",
                    );
                    return;
                  }
                  setPaid(paid + value);
                  setPayments(payments + 1);
                  setReceipt(value);
                  setNotice(
                    "Versement simulé enregistré. Le solde de la vue parent est mis à jour.",
                  );
                }}
              >
                <p className={styles.cardTag}>Aïcha Koné · 6e A</p>
                <h3>Enregistrer un versement fictif</h3>
                <div className={styles.receiptLine}>
                  <span>Scolarité totale</span>
                  <b>100 000 F</b>
                </div>
                <div className={styles.receiptLine}>
                  <span>Déjà réglé</span>
                  <b>{formatNumber(paid)} F</b>
                </div>
                <div className={styles.receiptLine}>
                  <span>Reste à payer</span>
                  <b>{formatNumber(remaining)} F</b>
                </div>
                <label className={styles.demoField} htmlFor="versement">
                  Montant en F CFA
                  <input
                    id="versement"
                    type="number"
                    inputMode="numeric"
                    min="1"
                    max={remaining || 1}
                    step="1"
                    required
                    disabled={remaining === 0}
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </label>
                <button
                  className={styles.primary}
                  disabled={remaining === 0}
                  type="submit"
                >
                  {remaining === 0
                    ? "Facture soldée dans la simulation"
                    : "Enregistrer la simulation"}
                </button>
              </form>
              <div className={`${styles.demoPanel} ${styles.receiptPanel}`}>
                <FileText size={34} aria-hidden="true" />
                <p className={styles.cardTag}>Reçu de démonstration</p>
                <h3>
                  {receipt === null
                    ? "Le reçu apparaîtra ici."
                    : `${formatNumber(receipt)} F CFA`}
                </h3>
                <p>
                  {receipt === null
                    ? "Enregistrez un versement fictif pour voir le résumé de l’opération."
                    : "Aïcha Koné · Scolarité · Versement simulé en espèces"}
                </p>
                {receipt !== null && (
                  <>
                    <span className={styles.specimen}>
                      SPÉCIMEN · SANS VALEUR COMPTABLE
                    </span>
                    <button
                      type="button"
                      className={styles.textLink}
                      onClick={() => setRole("parent")}
                    >
                      Voir le solde côté parent <ArrowRight size={17} />
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
          {role === "enseignant" && (
            <div className={styles.demoTwoCol}>
              <form
                className={styles.demoPanel}
                onSubmit={(event) => {
                  event.preventDefault();
                  const value =
                    gradeInput.trim() === "" ? NaN : Number(gradeInput);
                  if (!Number.isFinite(value) || value < 0 || value > 20) {
                    setNotice("Indiquez une note comprise entre 0 et 20.");
                    return;
                  }
                  setGrade(value);
                  setNotice(
                    "Note enregistrée dans la simulation et affichée dans la vue parent.",
                  );
                }}
              >
                <p className={styles.cardTag}>Français · Devoir 1 · 6e A</p>
                <h3>Saisir la note d’Aïcha</h3>
                <label className={styles.demoField} htmlFor="note">
                  Note sur 20
                  <input
                    id="note"
                    type="number"
                    min="0"
                    max="20"
                    step="0.01"
                    required
                    value={gradeInput}
                    onChange={(e) => setGradeInput(e.target.value)}
                  />
                </label>
                <button className={styles.primary} type="submit">
                  Enregistrer la note fictive
                </button>
              </form>
              <div className={styles.demoPanel}>
                <p className={styles.cardTag}>Le parcours dans CAHIORA</p>
                <h3>La validation garde sa place.</h3>
                <p>
                  Dans le logiciel, les bulletins suivent un circuit de
                  contrôle, de validation et de publication. Cette démonstration
                  simplifiée affiche directement votre note dans la vue parent ;
                  elle ne reproduit pas tout ce circuit.
                </p>
                <button
                  type="button"
                  className={styles.textLink}
                  onClick={() => setRole("parent")}
                >
                  Consulter la vue parent <ArrowRight size={17} />
                </button>
              </div>
            </div>
          )}
          {role === "parent" && (
            <>
              <div className={styles.childCard}>
                <span className={styles.avatar}>AK</span>
                <div>
                  <h3>Aïcha Koné</h3>
                  <p>6e A · votre enfant dans cet exemple</p>
                </div>
                <span className={styles.demoBadge}>
                  {remaining ? "PAIEMENT PARTIEL" : "SOLDÉ"}
                </span>
              </div>
              <div className={styles.demoTwoCol}>
                <div className={styles.demoPanel}>
                  <p className={styles.cardTag}>Situation financière</p>
                  <h3>
                    {formatNumber(remaining)} F CFA <small>à régler</small>
                  </h3>
                  <div className={styles.receiptLine}>
                    <span>Montant dû</span>
                    <b>100 000 F</b>
                  </div>
                  <div className={styles.receiptLine}>
                    <span>Déjà réglé</span>
                    <b>{formatNumber(paid)} F</b>
                  </div>
                  <div className={styles.progress}>
                    <span style={{ width: `${paid / 1000}%` }} />
                  </div>
                  <p>
                    Les versements simulés au guichet se retrouvent ici. Aucun
                    paiement en ligne ne peut être effectué dans cette
                    démonstration.
                  </p>
                </div>
                <div className={styles.demoPanel}>
                  <p className={styles.cardTag}>Suivi scolaire</p>
                  <h3>Les informations au même endroit.</h3>
                  <div className={styles.receiptLine}>
                    <span>Français · Devoir 1</span>
                    <b>
                      {grade === null
                        ? "À saisir dans la démo"
                        : `${grade.toLocaleString("fr-FR")} / 20`}
                    </b>
                  </div>
                  <p>
                    Dans CAHIORA, les parents peuvent suivre plusieurs enfants
                    depuis leur espace et consulter les bulletins après
                    publication.
                  </p>
                  {grade === null && (
                    <button
                      className={styles.textLink}
                      type="button"
                      onClick={() => setRole("enseignant")}
                    >
                      Essayer la saisie d’une note <ArrowRight size={17} />
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
          <p role="status" aria-live="polite" className={styles.demoNotice}>
            {notice}
          </p>
        </section>
        <div className={styles.demoBottom}>
          <div>
            <h2>Vous vous projetez dans CAHIORA ?</h2>
            <p>
              Estimez votre budget à 500 F CFA par élève et par année scolaire.
            </p>
          </div>
          <Link className={styles.primary} href="/cahiora#tarifs">
            Calculer mon offre <ArrowRight size={18} />
          </Link>
        </div>
      </main>
    </div>
  );
}

function ShieldNote() {
  return <CheckCircle2 size={23} aria-hidden="true" />;
}
