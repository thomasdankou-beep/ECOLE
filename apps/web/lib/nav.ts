import {
  Banknote, BarChart3, Briefcase, Bell, BookOpen, CalendarDays, ClipboardCheck, ClipboardList, CreditCard, FileBadge, FileText, Gavel, GraduationCap,
  Home, Inbox, KeyRound, LayoutDashboard, Megaphone, NotebookPen, Receipt, ScrollText, Settings, ShieldCheck, Tags, UserPlus, Users, Wallet,
  type LucideIcon,
} from 'lucide-react';
import type { Role } from './auth';

export type NavItem = { href: string; label: string; icon: LucideIcon; mobile?: boolean };

const common: NavItem[] = [
  { href: '/espace/annonces', label: 'Annonces', icon: Megaphone },
  { href: '/espace/notifications', label: 'Notifications', icon: Bell },
  { href: '/espace/compte', label: 'Mon compte', icon: KeyRound },
];

/** Menu par rôle : chaque profil ne voit que ses écrans (CDC §2, matrice des droits). */
export const NAV: Record<Role, NavItem[]> = {
  DIRECTION: [
    { href: '/espace', label: 'Tableau de bord', icon: LayoutDashboard, mobile: true },
    { href: '/espace/eleves', label: 'Élèves', icon: Users, mobile: true },
    { href: '/espace/preinscriptions', label: 'Pré-inscriptions', icon: Inbox },
    { href: '/espace/emploi-du-temps', label: 'Emploi du temps', icon: CalendarDays, mobile: true },
    { href: '/espace/bulletins', label: 'Bulletins', icon: GraduationCap, mobile: true },
    { href: '/espace/assiduite', label: 'Assiduité', icon: ClipboardCheck },
    { href: '/espace/sanctions', label: 'Discipline', icon: Gavel },
    { href: '/espace/finances', label: 'Finances', icon: BarChart3 },
    { href: '/espace/tarifs', label: 'Frais et tarifs', icon: Tags },
    { href: '/espace/stages', label: 'Stages et ateliers', icon: Briefcase },
    { href: '/espace/documents', label: 'Documents', icon: FileBadge },
    { href: '/espace/personnel', label: 'Personnel', icon: ShieldCheck },
    { href: '/espace/parametres', label: 'Paramètres', icon: Settings },
    { href: '/espace/audit', label: 'Journal d’audit', icon: ScrollText },
    ...common,
  ],
  SECRETARIAT: [
    { href: '/espace', label: 'Accueil', icon: Home, mobile: true },
    { href: '/espace/eleves', label: 'Élèves', icon: Users, mobile: true },
    { href: '/espace/inscription', label: 'Nouvelle inscription', icon: UserPlus, mobile: true },
    { href: '/espace/preinscriptions', label: 'Pré-inscriptions', icon: Inbox, mobile: true },
    { href: '/espace/documents', label: 'Documents', icon: FileBadge },
    { href: '/espace/emploi-du-temps', label: 'Emploi du temps', icon: CalendarDays },
    ...common,
  ],
  ENSEIGNANT: [
    { href: '/espace', label: 'Mes cours du jour', icon: Home, mobile: true },
    { href: '/espace/appel', label: 'Faire l’appel', icon: ClipboardCheck, mobile: true },
    { href: '/espace/notes', label: 'Notes', icon: NotebookPen, mobile: true },
    { href: '/espace/cahier-de-texte', label: 'Cahier de texte', icon: BookOpen, mobile: true },
    { href: '/espace/emploi-du-temps', label: 'Emploi du temps', icon: CalendarDays },
    { href: '/espace/bulletins', label: 'Conseils de classe', icon: GraduationCap },
    { href: '/espace/sanctions', label: 'Discipline', icon: Gavel },
    ...common,
  ],
  VIE_SCOLAIRE: [
    { href: '/espace', label: 'Aujourd’hui', icon: Home, mobile: true },
    { href: '/espace/appel', label: 'Faire l’appel', icon: ClipboardCheck, mobile: true },
    { href: '/espace/assiduite', label: 'Absences et retards', icon: ClipboardList, mobile: true },
    { href: '/espace/sanctions', label: 'Discipline', icon: Gavel, mobile: true },
    { href: '/espace/emploi-du-temps', label: 'Emploi du temps', icon: CalendarDays },
    ...common,
  ],
  COMPTABLE: [
    { href: '/espace', label: 'Tableau de bord', icon: LayoutDashboard, mobile: true },
    { href: '/espace/guichet', label: 'Guichet', icon: Banknote, mobile: true },
    { href: '/espace/factures', label: 'Factures', icon: FileText },
    { href: '/espace/paiements', label: 'Paiements', icon: Receipt, mobile: true },
    { href: '/espace/impayes', label: 'Impayés et relances', icon: Wallet, mobile: true },
    { href: '/espace/tarifs', label: 'Frais et tarifs', icon: Tags },
    { href: '/espace/caisse', label: 'Clôture de caisse', icon: CreditCard },
    ...common,
  ],
  PARENT: [
    { href: '/espace', label: 'Accueil', icon: Home, mobile: true },
    { href: '/espace/resultats', label: 'Notes', icon: GraduationCap, mobile: true },
    { href: '/espace/frais', label: 'Frais', icon: Wallet, mobile: true },
    { href: '/espace/absences', label: 'Absences', icon: ClipboardCheck, mobile: true },
    { href: '/espace/bulletins', label: 'Bulletins', icon: FileBadge },
    { href: '/espace/devoirs', label: 'Devoirs', icon: BookOpen },
    { href: '/espace/emploi-du-temps', label: 'Emploi du temps', icon: CalendarDays },
    { href: '/espace/documents', label: 'Documents', icon: FileText },
    ...common,
  ],
  ELEVE: [
    { href: '/espace', label: 'Accueil', icon: Home, mobile: true },
    { href: '/espace/resultats', label: 'Mes notes', icon: GraduationCap, mobile: true },
    { href: '/espace/emploi-du-temps', label: 'Emploi du temps', icon: CalendarDays, mobile: true },
    { href: '/espace/devoirs', label: 'Devoirs', icon: BookOpen, mobile: true },
    { href: '/espace/bulletins', label: 'Bulletins', icon: FileBadge },
    { href: '/espace/absences', label: 'Absences', icon: ClipboardCheck },
    { href: '/espace/documents', label: 'Documents', icon: FileText },
    ...common,
  ],
};

export const isFamily = (r: Role | null) => r === 'PARENT' || r === 'ELEVE';
