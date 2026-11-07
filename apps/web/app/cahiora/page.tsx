import type { Metadata } from "next";
import { CahioraMarketing } from "@/components/site/cahiora-marketing";

export const metadata: Metadata = {
  title: { absolute: "CAHIORA — Votre école, sous contrôle" },
  description:
    "Inscriptions, paiements, bulletins et espace parents. Découvrez CAHIORA et calculez votre offre de lancement à 500 F CFA par élève et par année scolaire.",
};

/** Also available on school domains, without replacing their public school website. */
export default function CahioraPage() {
  return <CahioraMarketing />;
}
