/**
 * Données de démonstration du pilote Saint Kisito-GESA.
 *
 * Réel : nom, sites, cycles, filières, téléphone, devise (affiches de l'école) ; niveaux, frais 2026-2027,
 * coordonnées et pièces à fournir (fiche de renseignement, chargée depuis data/ecoles/saint-kisito-2026-2027.json).
 * FICTIF : toutes les personnes, notes, absences, factures et paiements, coefficients (INFORMATION MANQUANTE).
 *
 * Usage : npm run db:seed (réinitialise l'établissement « saint-kisito »).
 */
import { AssessmentKind, Cycle, PrismaClient, RoleCode } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { applySchoolData, SchoolData } from '../src/modules/settings/school-data';

const SCHOOL_DATA = JSON.parse(readFileSync(join(__dirname, '..', 'data', 'ecoles', 'saint-kisito-2026-2027.json'), 'utf8')) as SchoolData;

const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_ADMIN_URL } } });
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'Kisito2026';
const SLUG = 'saint-kisito';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const code = () => randomBytes(9).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 12);
const today = d(new Date().toISOString().slice(0, 10));
const addDays = (n: number) => new Date(today.getTime() + n * 86400000);

async function main() {
  const existing = await db.tenant.findUnique({ where: { slug: SLUG } });
  if (existing && process.env.SEED_IF_EMPTY === '1') {
    console.log('Données déjà présentes, jeu de démonstration non rechargé.');
    return;
  }
  if (existing) {
    await wipe(existing.id);
  }
  const tenant = existing
    ? await db.tenant.update({ where: { id: existing.id }, data: { settings: settings() } })
    : await db.tenant.create({
        data: { slug: SLUG, name: 'Lycée privé Saint Kisito-GESA', shortName: 'Saint Kisito-GESA', country: 'BJ', currency: 'XOF', timezone: 'Africa/Porto-Novo', settings: settings() },
      });
  const T = tenant.id;
  const hash = await argon2.hash(DEMO_PASSWORD, { type: argon2.argon2id });

  await db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${T}, true)`;

      // ---------------------------------------------------------------- Structure (réelle, d'après les affiches)
      const hed = await tx.site.create({ data: { tenantId: T, name: 'Hêdomey', address: 'Hêdomey Carrefour, 2e von à gauche après le carrefour', phone: '01 40 63 24 39' } });
      const tog = await tx.site.create({ data: { tenantId: T, name: 'Togbin', address: 'Togbin Kpèvi, immeuble Kpondjou', phone: '01 40 63 24 39' } });
      // Dates de fin de période : exemples à confirmer avec le calendrier officiel.
      const year = await tx.academicYear.create({
        data: {
          tenantId: T, label: '2026-2027', startDate: d('2026-09-14'), endDate: d('2027-07-09'), isCurrent: true,
          terms: {
            create: [
              { tenantId: T, name: 'Trimestre 1', position: 1, startDate: d('2026-09-14'), endDate: d('2026-12-18') },
              { tenantId: T, name: 'Trimestre 2', position: 2, startDate: d('2027-01-04'), endDate: d('2027-04-02') },
              { tenantId: T, name: 'Trimestre 3', position: 3, startDate: d('2027-04-12'), endDate: d('2027-07-09') },
            ],
          },
        },
        include: { terms: { orderBy: { position: 'asc' } } },
      });
      const term1 = year.terms[0];

      const lv = async (name: string, cycle: Cycle, position: number) => tx.level.create({ data: { tenantId: T, name, cycle, position } });
      const L = {
        s6: await lv('6e', 'COLLEGE', 1), s5: await lv('5e', 'COLLEGE', 2), s4: await lv('4e', 'COLLEGE', 3), s3: await lv('3e', 'COLLEGE', 4),
        a1: await lv('1re année', 'LYCEE_TECHNIQUE', 5), a2: await lv('2e année', 'LYCEE_TECHNIQUE', 6), tle: await lv('Terminale', 'LYCEE_TECHNIQUE', 7),
      };
      const tr = async (codeTr: string, name: string, cycle: Cycle) => tx.track.create({ data: { tenantId: T, code: codeTr, name, cycle } });
      const TR = {
        gen: await tr('GEN', 'Enseignement général', 'COLLEGE'),
        f3: await tr('F3', 'Électrotechnique (F3)', 'LYCEE_TECHNIQUE'),
        f4: await tr('F4', 'Génie civil (F4)', 'LYCEE_TECHNIQUE'),
        og: await tr('OG', 'Opérateur géomètre (OG)', 'LYCEE_TECHNIQUE'),
        hr: await tr('HR', 'Hôtellerie restauration (HR)', 'LYCEE_TECHNIQUE'),
        mmv: await tr('MMV', 'Mode et vêtement (MMV)', 'LYCEE_TECHNIQUE'),
        g2: await tr('G2', 'Comptabilité gestion (G2)', 'LYCEE_TECHNIQUE'),
        imi: await tr('IMI', 'Installation et maintenance informatique (IMI)', 'LYCEE_TECHNIQUE'),
      };
      // Fiche de renseignement 2026-2027 de l'école : niveaux, filières, frais réels, coordonnées (données de l'école, pas du code).
      await applySchoolData(tx, T, SCHOOL_DATA);

      const room = async (siteId: string, name: string) => tx.room.create({ data: { tenantId: T, siteId, name, kind: name.startsWith('Atelier') ? 'WORKSHOP' : 'CLASSROOM' } });
      const R = { at1: await room(hed.id, 'Atelier 1'), at2: await room(hed.id, 'Atelier 2'), s3: await room(hed.id, 'Salle 3'), s5: await room(hed.id, 'Salle 5'), s4: await room(tog.id, 'Salle 4'), s6: await room(tog.id, 'Salle 6'), cout: await room(tog.id, 'Atelier couture') };
      const sub = async (c: string, name: string, practical = false) => tx.subject.create({ data: { tenantId: T, code: c, name, practical } });
      const S = {
        fr: await sub('FR', 'Français'), ang: await sub('ANG', 'Anglais'), math: await sub('MATH', 'Mathématiques'), pc: await sub('PC', 'Physique-chimie'),
        svt: await sub('SVT', 'SVT'), hg: await sub('HG', 'Histoire-géographie'), eps: await sub('EPS', 'EPS'), elec: await sub('ELEC', 'Électrotechnique', true), dt: await sub('DT', 'Dessin technique'),
      };

      // ---------------------------------------------------------------- Comptes (FICTIFS)
      const user = async (firstName: string, lastName: string, phone: string, roles: RoleCode[], email?: string) =>
        tx.user.create({ data: { tenantId: T, firstName, lastName, phone, email, passwordHash: hash, mustChangePassword: false, roles: { create: roles.map((role) => ({ tenantId: T, role })) } } });
      await user('Bernard', 'DOSSA', '+2290190000010', ['DIRECTION'], 'direction@demo.saint-kisito.bj');
      await user('Mireille', 'ADJOVI', '+2290190000011', ['SECRETARIAT']);
      const zinsou = await user('Codjo', 'ZINSOU', '+2290190000001', ['ENSEIGNANT']);
      const akakpo = await user('Rosine', 'AKAKPO', '+2290190000002', ['ENSEIGNANT']);
      const houessou = await user('Serge', 'HOUESSOU', '+2290190000003', ['ENSEIGNANT']);
      await user('Fiacre', 'AHOYO', '+2290190000012', ['VIE_SCOLAIRE']);
      const compta = await user('Lucie', 'AGBANGLA', '+2290190000013', ['COMPTABLE']);

      // ---------------------------------------------------------------- Classes et matières (coefficients d'exemple)
      const klass = async (name: string, siteId: string, levelId: string, trackId: string, capacity: number, headTeacherId?: string) =>
        tx.class.create({ data: { tenantId: T, name, siteId, levelId, trackId, capacity, academicYearId: year.id, headTeacherId } });
      const F3 = await klass('1re année F3', hed.id, L.a1.id, TR.f3.id, 40, zinsou.id);
      const A4 = await klass('4e A', tog.id, L.s4.id, TR.gen.id, 50, akakpo.id);
      await klass('6e A', tog.id, L.s6.id, TR.gen.id, 50);
      await klass('2e année F4', hed.id, L.a2.id, TR.f4.id, 40);
      await klass('1re année HR', tog.id, L.a1.id, TR.hr.id, 35);

      const cs = async (classId: string, subjectId: string, coefficient: number, teacherId?: string) => {
        const row = await tx.classSubject.create({ data: { tenantId: T, classId, subjectId, coefficient } });
        if (teacherId) {
          await tx.teacherAssignment.create({ data: { tenantId: T, teacherId, classSubjectId: row.id } });
          await tx.teacherSubject.upsert({ where: { teacherId_subjectId: { teacherId, subjectId } }, update: {}, create: { tenantId: T, teacherId, subjectId } });
        }
        return row;
      };
      const F3cs = {
        elec: await cs(F3.id, S.elec.id, 5, zinsou.id), math: await cs(F3.id, S.math.id, 4, zinsou.id), dt: await cs(F3.id, S.dt.id, 3, houessou.id),
        fr: await cs(F3.id, S.fr.id, 2, akakpo.id), ang: await cs(F3.id, S.ang.id, 1, akakpo.id),
      };
      const A4cs = {
        math: await cs(A4.id, S.math.id, 3, zinsou.id), fr: await cs(A4.id, S.fr.id, 3, akakpo.id), ang: await cs(A4.id, S.ang.id, 2, akakpo.id),
        pc: await cs(A4.id, S.pc.id, 2), svt: await cs(A4.id, S.svt.id, 2), hg: await cs(A4.id, S.hg.id, 2), eps: await cs(A4.id, S.eps.id, 1),
      };

      // ---------------------------------------------------------------- Emploi du temps (repris de la démo)
      const H = [[480, 600], [600, 720], [900, 1020]];
      const slot = async (classSubjectId: string, dayOfWeek: number, h: number, roomId: string) =>
        tx.timetableSlot.create({ data: { tenantId: T, classSubjectId, dayOfWeek, startMinute: H[h][0], endMinute: H[h][1], roomId } });
      const f3grid: [keyof typeof F3cs | null, string][][] = [
        [['elec', R.at2.id], ['math', R.s5.id], ['dt', R.s3.id], ['fr', R.s5.id], ['elec', R.at2.id]],
        [['math', R.s5.id], ['ang', R.s5.id], ['elec', R.at2.id], [null, ''], ['fr', R.s5.id]],
        [['dt', R.s3.id], ['elec', R.at1.id], ['math', R.s5.id], ['ang', R.s5.id], [null, '']],
      ];
      for (const [h, row] of f3grid.entries()) for (const [i, [k, r]] of row.entries()) if (k) await slot(F3cs[k].id, i + 1, h, r);
      const a4grid: [keyof typeof A4cs | null][][] = [
        [['fr'], ['math'], ['hg'], ['math'], ['ang']],
        [['math'], ['fr'], ['svt'], ['pc'], ['fr']],
        [['ang'], ['eps'], [null], ['svt'], ['pc']],
      ];
      // Le professeur de maths enseigne à Hêdomey le matin : les créneaux de 4e A sont décalés pour éviter les conflits.
      for (const [h, row] of a4grid.entries()) for (const [i, [k]] of row.entries()) {
        if (!k) continue;
        const clash = k === 'math' && f3grid[h][i][0] && ['elec', 'math'].includes(f3grid[h][i][0] as string);
        const clashFr = (k === 'fr' || k === 'ang') && f3grid[h][i][0] && ['fr', 'ang'].includes(f3grid[h][i][0] as string);
        if (clash || clashFr) continue;
        await slot(A4cs[k].id, i + 1, h, R.s4.id);
      }

      // ---------------------------------------------------------------- Familles et élèves (FICTIFS)
      const parent = await user('Afi', 'DOSSOU', '+2290197000001', ['PARENT']);
      const guardianDossou = await tx.guardian.create({ data: { tenantId: T, firstName: 'Afi', lastName: 'DOSSOU', phone: '+2290197000001', userId: parent.id } });
      let n = 0;
      const mat = () => `SKG-26-${String(++n).padStart(4, '0')}`;
      const enroll = async (full: string, classId: string, sex: 'M' | 'F', guardianId?: string) => {
        const [firstName, ...rest] = full.split(' ');
        const s = await tx.student.create({ data: { tenantId: T, matricule: mat(), firstName, lastName: rest.join(' ').toUpperCase(), sex, birthDate: d(classId === F3.id ? '2010-03-12' : '2012-06-20') } });
        await tx.enrollment.create({ data: { tenantId: T, studentId: s.id, classId, academicYearId: year.id, enrolledAt: d('2026-09-14') } });
        let gid = guardianId;
        if (!gid) {
          const phone = `+22901970${String(100 + n).padStart(5, '0')}`;
          const g = await tx.guardian.create({ data: { tenantId: T, firstName: 'Parent', lastName: rest.join(' ').toUpperCase(), phone } });
          gid = g.id;
        }
        await tx.studentGuardian.create({ data: { tenantId: T, studentId: s.id, guardianId: gid, relation: guardianId ? 'Mère' : 'Responsable', isPrimary: true } });
        return s;
      };
      const f3Names: [string, 'M' | 'F'][] = [['Koffi Dossou', 'M'], ['Rachidatou Bio', 'F'], ['Mawulé Ahouansou', 'M'], ['Ifèoluwa Adjovi', 'F'], ['Romaric Gbaguidi', 'M'], ['Nadège Akpovi', 'F'], ['Fiacre Tossou', 'M'], ['Prisca Hounkpè', 'F'], ['Jérôme Kpadonou', 'M'], ['Bénédicte Sossou', 'F']];
      const a4Names: [string, 'M' | 'F'][] = [['Sèna Dossou', 'F'], ['Ange Hounsa', 'M'], ['Gildas Agbo', 'M'], ['Faïzath Moussa', 'F'], ['Brice Dégbé', 'M'], ['Carine Hessou', 'F'], ['Luc Amoussou', 'M'], ['Yasmine Soglo', 'F']];
      const f3: { id: string; firstName: string; lastName: string }[] = [];
      for (const [nm, sx] of f3Names) f3.push(await enroll(nm, F3.id, sx, nm === 'Koffi Dossou' ? guardianDossou.id : undefined));
      const a4: { id: string; firstName: string; lastName: string }[] = [];
      for (const [nm, sx] of a4Names) a4.push(await enroll(nm, A4.id, sx, nm === 'Sèna Dossou' ? guardianDossou.id : undefined));
      const koffi = f3[0];
      const sena = a4[0];
      const koffiUser = await tx.user.create({ data: { tenantId: T, firstName: 'Koffi', lastName: 'DOSSOU', passwordHash: hash, mustChangePassword: false, roles: { create: [{ tenantId: T, role: 'ELEVE' }] } } });
      await tx.student.update({ where: { id: koffi.id }, data: { userId: koffiUser.id } });
      await tx.counter.create({ data: { tenantId: T, key: 'matricule-26', value: n } });

      // ---------------------------------------------------------------- Notes du trimestre 1 (FICTIVES)
      const assess = async (classSubjectId: string, title: string, kind: AssessmentKind, date: string, scores: (number | null)[], students: { id: string }[], teacherId: string) => {
        const a = await tx.assessment.create({ data: { tenantId: T, classSubjectId, termId: term1.id, title, kind, weight: kind === 'COMPOSITION' ? 2 : 1, date: d(date), published: true, createdById: teacherId } });
        for (const [i, s] of students.entries()) {
          if (scores[i] === undefined) continue;
          await tx.grade.create({ data: { tenantId: T, assessmentId: a.id, studentId: s.id, score: scores[i], absent: scores[i] === null, updatedById: teacherId } });
        }
      };
      await assess(F3cs.elec.id, 'Interrogation 1', 'INTERROGATION', '2026-10-02', [14, 11, 9, 16, 12.5, 8, 13, 15, 10, 17], f3, zinsou.id);
      await assess(F3cs.elec.id, 'Devoir 1', 'DEVOIR', '2026-10-09', [13, 12, 10, 15, 11, 9.5, 14, 16, 8, 15.5], f3, zinsou.id);
      await assess(F3cs.math.id, 'Devoir 1', 'DEVOIR', '2026-10-07', [12.5, 10, 8.5, 15, 11, 9, 13.5, 14, 9.5, 16], f3, zinsou.id);
      await assess(F3cs.dt.id, 'Devoir 1', 'DEVOIR', '2026-10-06', [14, 12, 11, 13, 12, 10, 15, 13.5, 11, 14.5], f3, houessou.id);
      await assess(F3cs.fr.id, 'Devoir 1', 'DEVOIR', '2026-10-08', [11, 13, 10, 12, 9.5, 12, 11.5, 14, 10, 13], f3, akakpo.id);
      await assess(F3cs.ang.id, 'Interrogation 1', 'INTERROGATION', '2026-10-05', [12, 14, 9, 15, 10, 11, 12, 13, 9, 16], f3, akakpo.id);
      await assess(A4cs.math.id, 'Devoir 1', 'DEVOIR', '2026-10-07', [9.5, 12, 14, 11, 8, 15, 10.5, 13], a4, zinsou.id);
      await assess(A4cs.fr.id, 'Devoir 1', 'DEVOIR', '2026-10-08', [12, 11, 13.5, 14, 9, 16, 10, 12.5], a4, akakpo.id);

      // ---------------------------------------------------------------- Factures (FICTIVES) sur les frais réels de la fiche
      const feeOf = async (name: string, where: { levelId?: string; trackId?: string }) => {
        const f = await tx.feeType.findFirstOrThrow({ where: { academicYearId: year.id, name, ...where } });
        return { fee: f, name: f.name, amount: f.amount, due: f.dueDate?.toISOString().slice(0, 10) ?? '2026-10-10', students: where.trackId === TR.f3.id || where.levelId === L.a1.id ? f3 : a4 };
      };
      const fees = [
        await feeOf('Scolarité 1re tranche', { levelId: L.a1.id }), await feeOf('Scolarité 2e tranche', { levelId: L.a1.id }),
        await feeOf("Frais de TP (toute l'année)", { trackId: TR.f3.id }),
        await feeOf('Scolarité 1re tranche', { levelId: L.s4.id }), await feeOf('Scolarité 2e tranche', { levelId: L.s4.id }),
      ];
      let inv = 0;
      let rec = 0;
      for (const f of fees) {
        const { fee, students } = f;
        const tp = f.name.startsWith('Frais de TP');
        for (const [i, s] of students.entries()) {
          const first = f.name === 'Scolarité 1re tranche';
          const paidFull = first && i % 4 !== 3; // 1re tranche réglée sauf pour un élève sur quatre
          const paidPart = first && i % 8 === 3 ? Math.round(f.amount / 2) : 0;
          const paidTp = tp && i % 2 === 0;
          const paid = paidFull || paidTp ? f.amount : paidPart;
          const invoice = await tx.invoice.create({
            data: {
              tenantId: T, number: `FAC-2026-${String(++inv).padStart(5, '0')}`, studentId: s.id, label: f.name, total: f.amount, paid,
              status: paid >= f.amount ? 'PAID' : paid > 0 ? 'PARTIAL' : 'OPEN', dueDate: d(f.due), createdById: compta.id,
              items: { create: [{ tenantId: T, label: f.name, amount: f.amount, feeTypeId: fee.id }] },
            },
          });
          if (paid > 0) {
            const p = await tx.payment.create({
              data: {
                tenantId: T, invoiceId: invoice.id, studentId: s.id, amount: paid, method: i % 3 === 0 ? 'MOBILE_MONEY_DESK' : 'CASH', transactionId: `SEED-${invoice.number}`,
                status: 'SUCCESS', receivedById: compta.id, confirmedAt: d(tp ? '2026-10-08' : '2026-09-25'),
              },
            });
            const vc = code();
            const number = `REC-2026-${String(++rec).padStart(5, '0')}`;
            await tx.receipt.create({ data: { tenantId: T, number, paymentId: p.id, verifyCode: vc, issuedAt: p.confirmedAt! } });
            await tx.verificationEntry.create({ data: { code: vc, tenantId: T, kind: 'Reçu de paiement', issuedAt: p.confirmedAt!, summary: `Reçu ${number} · ${s.firstName} ${s.lastName.charAt(0)}. · ${paid} FCFA · ${f.name}` } });
          }
        }
      }
      await tx.counter.createMany({ data: [{ tenantId: T, key: 'invoice-2026', value: inv }, { tenantId: T, key: 'receipt-2026', value: rec }] });

      // ---------------------------------------------------------------- Vie scolaire (FICTIVE)
      const yesterday = addDays(-1);
      const sess = await tx.attendanceSession.create({ data: { tenantId: T, classId: A4.id, classSubjectId: A4cs.math.id, date: yesterday, startMinute: 600, takenById: zinsou.id } });
      for (const s of a4) await tx.attendanceRecord.create({ data: { tenantId: T, sessionId: sess.id, studentId: s.id, status: s.id === sena.id ? 'ABSENT' : 'PRESENT' } });
      await tx.notification.create({ data: { tenantId: T, userId: parent.id, channel: 'IN_APP', kind: 'absence', title: 'Absence', body: 'Sèna est absente en Mathématiques hier à 10 h. Vous pouvez justifier depuis votre espace parent.', status: 'SENT', sentAt: yesterday } });

      await tx.lesson.create({ data: { tenantId: T, classSubjectId: F3cs.elec.id, date: d('2026-10-14'), title: 'Loi d’Ohm, puissance électrique', content: 'Rappel de la loi d’Ohm, calcul de puissance, exercices guidés.', homework: 'Exercices 3 et 4 page 42', homeworkDue: addDays(3), authorId: zinsou.id } });
      await tx.announcement.create({ data: { tenantId: T, title: 'Réunion parents-professeurs', body: 'Les parents des élèves de 1re année sont invités à une réunion le samedi à 9 h sur le site de Hêdomey (exemple de démonstration).', audience: 'PARENTS', authorId: zinsou.id } });

      await tx.application.create({ data: { tenantId: T, reference: 'PRE-2026-0001', studentFirstName: 'Aurel', studentLastName: 'HOUNKANRIN', wantedLevel: '1re année', wantedTrack: 'Électrotechnique (F3)', wantedSite: 'Hêdomey', guardianName: 'Didier Hounkanrin', guardianPhone: '+2290197000099', status: 'RECU' } });
      await tx.application.create({ data: { tenantId: T, reference: 'PRE-2026-0002', studentFirstName: 'Grâce', studentLastName: 'AHOGNON', wantedLevel: '6e', wantedTrack: 'Enseignement général', wantedSite: 'Togbin', guardianName: 'Estelle Ahognon', guardianPhone: '+2290197000098', status: 'EN_TEST' } });
      await tx.counter.create({ data: { tenantId: T, key: `application-${new Date().getUTCFullYear()}`, value: 2 } });
    },
    { timeout: 120000 },
  );

  console.log(`Établissement « ${SLUG} » prêt. Mot de passe de tous les comptes de démonstration : ${DEMO_PASSWORD}`);
  console.log('Direction +2290190000010 · Secrétariat +2290190000011 · Enseignant +2290190000001 · Vie scolaire +2290190000012 · Comptable +2290190000013 · Parent +2290197000001 · Élève SKG-26-0001');
}

function settings() {
  return {
    demo: true,
    matriculePrefix: 'SKG',
    branding: { logoKey: null, logoUrl: '/logo.png', primaryColor: null },
    public: {
      slogan: 'Éduquer · Former · Réussir',
      tagline: 'La référence de l’excellence professionnelle',
      phone: '01 40 63 24 39',
      rentree: '2026-09-14',
      highlights: ['100 % pratique', 'Garantie de stage', 'Obtention de CQM, CAP et DT'],
      reasons: ['Enseignants qualifiés', 'Formation pratique et professionnelle', 'Stages en entreprise garantis', 'Obtention du CQP, CAP et DT', 'Matériels modernes et ateliers équipés'],
      motto: 'Oser, apprendre, garantir son avenir !',
      heroImage: '/img/electrotechnique.jpg',
      trackImages: { F3: '/img/electrotechnique.jpg', F4: '/img/genie-civil.jpg', OG: '/img/geometre.jpg', HR: '/img/hotellerie.jpg', MMV: '/img/mode.jpg' },
    },
  };
}

/** Supprime les données de l'établissement de démonstration avant de le recréer. */
async function wipe(tenantId: string) {
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    // Les déclencheurs « ajout seul » protègent reçus, paiements, notes et audit : suspendus le temps du nettoyage de la démo seulement.
    const guarded = ['audit_logs', 'receipts', 'payments', 'grades'];
    for (const t of guarded) await tx.$executeRawUnsafe(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
    const tables = [
      'notifications', 'announcements', 'documents', 'receipts', 'payments', 'invoice_items', 'invoices', 'fee_types', 'cash_closings',
      'report_card_items', 'report_cards', 'report_card_runs', 'appreciations', 'grades', 'assessments', 'attendance_records', 'attendance_sessions',
      'sanctions', 'lessons', 'timetable_changes', 'timetable_slots', 'annual_decisions', 'teacher_assignments', 'teacher_subjects', 'class_subjects', 'enrollments', 'student_guardians',
      'applications', 'guardians', 'students', 'otp_codes', 'sessions', 'user_roles', 'classes', 'users', 'rooms', 'subjects', 'tracks', 'levels',
      'terms', 'academic_years', 'sites', 'counters', 'audit_logs',
    ];
    for (const t of ['internship_placements', 'internship_periods']) await tx.$executeRawUnsafe(`DELETE FROM ${t} WHERE tenant_id = $1::uuid`, tenantId);
    for (const t of tables) await tx.$executeRawUnsafe(`DELETE FROM ${t} WHERE tenant_id = $1::uuid`, tenantId);
    await tx.$executeRawUnsafe(`DELETE FROM verification_entries WHERE tenant_id = $1::uuid`, tenantId);
    await tx.$executeRawUnsafe(`DELETE FROM payment_routes WHERE tenant_id = $1::uuid`, tenantId);
    for (const t of guarded) await tx.$executeRawUnsafe(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
  }, { timeout: 120000 });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
