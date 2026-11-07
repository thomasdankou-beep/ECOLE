import type { Metadata } from "next";
import { CahioraDemo } from "@/components/site/cahiora-demo";

export const metadata: Metadata = {
  title: { absolute: "Démonstration interactive · CAHIORA" },
  description:
    "Explorez un parcours illustratif de CAHIORA : direction, caisse, notes et espace parent, avec des données entièrement fictives.",
  robots: { index: false, follow: false },
};

export default function DemoPage() {
  return <CahioraDemo />;
}
