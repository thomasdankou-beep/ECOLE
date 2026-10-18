/* Copie, pour l'affichage seulement, de la matrice des droits de l'API (apps/api/src/common/permissions.ts). L'API reste seule juge. */
import type { Role } from './auth';

export const ROLE_PERMISSIONS: Record<Role, string[]> = {
  DIRECTION: [
    'settings.manage', 'users.manage', 'students.read', 'students.write', 'admissions.manage',
    'documents.issue', 'documents.read', 'timetable.read', 'timetable.manage', 'lessons.read',
    'attendance.read', 'sanctions.read', 'sanctions.validate', 'grades.read', 'reportcards.read',
    'reportcards.control', 'reportcards.validate', 'finance.read', 'announcements.read',
    'announcements.write', 'dashboard.read', 'audit.read',
  ],
  SECRETARIAT: [
    'students.read', 'students.write', 'admissions.manage', 'documents.issue', 'documents.read',
    'timetable.read', 'attendance.read', 'grades.read', 'reportcards.read', 'finance.read',
    'announcements.read', 'announcements.write',
  ],
  ENSEIGNANT: [
    'students.read', 'timetable.read', 'lessons.read', 'lessons.write', 'attendance.read',
    'attendance.take', 'sanctions.read', 'sanctions.propose', 'grades.read', 'grades.write',
    'reportcards.read', 'reportcards.appreciate', 'announcements.read',
  ],
  VIE_SCOLAIRE: [
    'students.read', 'timetable.read', 'lessons.read', 'attendance.read', 'attendance.take',
    'attendance.review', 'sanctions.read', 'sanctions.manage', 'grades.read', 'reportcards.read',
    'announcements.read', 'announcements.write',
  ],
  COMPTABLE: ['students.read', 'finance.read', 'finance.write', 'announcements.read', 'dashboard.read'],
  PARENT: [
    'students.read', 'documents.read', 'timetable.read', 'lessons.read', 'attendance.read',
    'attendance.justify', 'sanctions.read', 'grades.read', 'reportcards.read', 'finance.read',
    'finance.pay', 'announcements.read',
  ],
  ELEVE: [
    'students.read', 'documents.read', 'timetable.read', 'lessons.read', 'attendance.read',
    'sanctions.read', 'grades.read', 'reportcards.read', 'announcements.read',
  ],
};

export const can = (role: Role | null, p: string) => !!role && ROLE_PERMISSIONS[role].includes(p);
