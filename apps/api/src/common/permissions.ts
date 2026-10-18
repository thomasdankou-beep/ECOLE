import { RoleCode } from '@prisma/client';

/**
 * Matrice des droits (CDC §2.9, master prompt §9-10).
 * Les permissions sont vérifiées par PermissionsGuard sur chaque route ;
 * le périmètre (ses classes, ses enfants, soi) est appliqué ensuite par ScopeService.
 * Règle clé : un enseignant ne voit jamais les finances, un comptable ne voit jamais les notes.
 */
export const PERMISSIONS = [
  'settings.manage',
  'users.manage',
  'students.read',
  'students.write',
  'admissions.manage',
  'documents.issue',
  'documents.read',
  'timetable.read',
  'timetable.manage',
  'lessons.read',
  'lessons.write',
  'attendance.read',
  'attendance.take',
  'attendance.justify',
  'attendance.review',
  'sanctions.read',
  'sanctions.propose',
  'sanctions.manage',
  'sanctions.validate',
  'grades.read',
  'grades.write',
  'reportcards.read',
  'reportcards.appreciate',
  'reportcards.control',
  'reportcards.validate',
  'finance.read',
  'finance.write',
  'finance.pay',
  'announcements.read',
  'announcements.write',
  'dashboard.read',
  'audit.read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<RoleCode, Permission[]> = {
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

export function can(role: RoleCode, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
