/**
 * Tests de bout en bout sur une base PostgreSQL réelle (erp_test), avec les données de démonstration.
 * Couvre les critères de recette du CDC §7.3 : isolation entre établissements, périmètre par rôle,
 * paiement Mobile Money confirmé → facture + reçu, absence → notification, calculs et verrouillage.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { consoleSms } from '../src/modules/notifications/sms.provider';

const PASSWORD = 'Kisito2026';
const PHONES = { direction: '+2290190000010', secretariat: '+2290190000011', teacher: '+2290190000001', vieScolaire: '+2290190000012', comptable: '+2290190000013', parent: '+2290197000001' };

let app: INestApplication;
let http: ReturnType<typeof request>;
const admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_ADMIN_URL } } });
const app_ = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
const tokens: Record<string, string> = {};
let otherTenantStudentId: string;

async function login(identifier: string, tenant = 'saint-kisito') {
  const r = await http.post('/api/v1/auth/login').send({ tenant, identifier, password: PASSWORD });
  expect(r.status).toBe(200);
  return r.body.accessToken as string;
}
const as = (who: string) => ({
  get: (url: string) => http.get(`/api/v1${url}`).set('Authorization', `Bearer ${tokens[who]}`),
  post: (url: string, body?: object) => http.post(`/api/v1${url}`).set('Authorization', `Bearer ${tokens[who]}`).send(body ?? {}),
  put: (url: string, body?: object) => http.put(`/api/v1${url}`).set('Authorization', `Bearer ${tokens[who]}`).send(body ?? {}),
  patch: (url: string, body?: object) => http.patch(`/api/v1${url}`).set('Authorization', `Bearer ${tokens[who]}`).send(body ?? {}),
  del: (url: string) => http.delete(`/api/v1${url}`).set('Authorization', `Bearer ${tokens[who]}`),
});

/** Second établissement, pour vérifier l'étanchéité entre clients. */
async function createOtherTenant() {
  await admin.$executeRaw`DELETE FROM tenants WHERE slug = 'autre-ecole' AND NOT EXISTS (SELECT 1 FROM students s WHERE s.tenant_id = tenants.id)`;
  let t = await admin.tenant.findUnique({ where: { slug: 'autre-ecole' } });
  if (!t) t = await admin.tenant.create({ data: { slug: 'autre-ecole', name: 'Autre école' } });
  const tid = t.id;
  return admin.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tid}, true)`;
    const existing = await tx.student.findFirst();
    if (existing) return existing.id;
    const s = await tx.student.create({ data: { tenantId: tid, matricule: 'AUT-26-0001', firstName: 'Élève', lastName: 'AILLEURS' } });
    return s.id;
  });
}

beforeAll(async () => {
  execSync('npx ts-node --transpile-only prisma/seed.ts', { env: process.env, stdio: 'ignore', cwd: `${__dirname}/..` });
  otherTenantStudentId = await createOtherTenant();
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  configureApp(app);
  await app.init();
  app.get(NotificationsService).fallbackDelayMs = 50;
  http = request(app.getHttpServer());
  for (const [k, phone] of Object.entries(PHONES)) tokens[k] = await login(phone);
  tokens.student = await login('SKG-26-0001');
}, 120000);

afterAll(async () => {
  await app?.close();
  await admin.$disconnect();
  await app_.$disconnect();
});

describe('Isolation entre établissements (Row Level Security)', () => {
  it('le rôle applicatif ne voit aucune ligne sans établissement fixé', async () => {
    const rows = await app_.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM students`;
    expect(Number(rows[0].n)).toBe(0);
  });

  it("un établissement ne voit jamais les élèves d'un autre, même par requête directe", async () => {
    const t = await admin.tenant.findUniqueOrThrow({ where: { slug: 'saint-kisito' } });
    const visible = await app_.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${t.id}, true)`;
      return tx.student.findMany({ select: { id: true, tenantId: true } });
    });
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.every((s) => s.tenantId === t.id)).toBe(true);
    expect(visible.find((s) => s.id === otherTenantStudentId)).toBeUndefined();
  });

  it("refuse l'écriture d'une ligne pour un autre établissement", async () => {
    const t = await admin.tenant.findUniqueOrThrow({ where: { slug: 'saint-kisito' } });
    const other = await admin.tenant.findUniqueOrThrow({ where: { slug: 'autre-ecole' } });
    await expect(
      app_.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${t.id}, true)`;
        await tx.site.create({ data: { tenantId: other.id, name: 'Intrus' } });
      }),
    ).rejects.toThrow();
  });

  it("la direction obtient 404 sur l'élève d'un autre établissement", async () => {
    const r = await as('direction').get(`/students/${otherTenantStudentId}`);
    expect(r.status).toBe(404);
  });
});

describe('Droits par rôle (matrice CDC §2.9)', () => {
  it('un enseignant ne voit jamais les finances', async () => {
    expect((await as('teacher').get('/finance/invoices')).status).toBe(403);
    const students = await as('teacher').get('/students');
    expect(students.status).toBe(200);
    expect(students.body[0]).not.toHaveProperty('balance');
  });

  it('un comptable ne voit jamais les notes', async () => {
    const r = await as('comptable').get('/evaluation/students/00000000-0000-0000-0000-000000000000');
    expect(r.status).toBe(403);
  });

  it('un parent ne voit que ses enfants', async () => {
    const mine = await as('parent').get('/students');
    expect(mine.body.map((s: any) => s.firstName).sort()).toEqual(['Koffi', 'Sèna']);
    const all = await as('direction').get('/students');
    const stranger = all.body.find((s: any) => s.firstName === 'Rachidatou');
    expect((await as('parent').get(`/students/${stranger.id}`)).status).toBe(403);
  });

  it("un élève ne voit que ses propres notes et n'accède pas au paramétrage", async () => {
    const me = await as('student').get('/students');
    expect(me.body).toHaveLength(1);
    expect((await as('student').get('/staff')).status).toBe(403);
  });

  it("refuse un rôle qui n'est pas attribué au compte", async () => {
    const r = await http.get('/api/v1/students').set('Authorization', `Bearer ${tokens.parent}`).set('X-Active-Role', 'DIRECTION');
    expect(r.status).toBe(403);
  });
});

describe('Authentification', () => {
  it('bloque le compte après 5 échecs', async () => {
    for (let i = 0; i < 5; i++) {
      await http.post('/api/v1/auth/login').send({ tenant: 'saint-kisito', identifier: PHONES.secretariat, password: 'mauvais1' });
    }
    const r = await http.post('/api/v1/auth/login').send({ tenant: 'saint-kisito', identifier: PHONES.secretariat, password: PASSWORD });
    expect(r.status).toBe(403);
    expect(r.body.message).toMatch(/bloqué/);
  });

  it('réinitialise le mot de passe par code SMS', async () => {
    await http.post('/api/v1/auth/forgot').send({ tenant: 'saint-kisito', identifier: PHONES.vieScolaire }).expect(200);
    const sms = consoleSms.sent.filter((m) => m.to === PHONES.vieScolaire).pop()!;
    const code = sms.text.match(/(\d{6})/)![1];
    await http.post('/api/v1/auth/reset').send({ tenant: 'saint-kisito', identifier: PHONES.vieScolaire, code, password: 'NouveauMdp9' }).expect(200);
    const r = await http.post('/api/v1/auth/login').send({ tenant: 'saint-kisito', identifier: PHONES.vieScolaire, password: 'NouveauMdp9' });
    expect(r.status).toBe(200);
    tokens.vieScolaire = r.body.accessToken;
  });

  it('fait tourner le jeton de renouvellement et rejette sa réutilisation', async () => {
    const agent = request.agent(app.getHttpServer());
    const l = await agent.post('/api/v1/auth/login').send({ tenant: 'saint-kisito', identifier: PHONES.comptable, password: PASSWORD });
    const oldCookie = l.headers['set-cookie'][0].split(';')[0];
    await agent.post('/api/v1/auth/refresh').expect(200);
    const replay = await request(app.getHttpServer()).post('/api/v1/auth/refresh').set('Cookie', oldCookie);
    expect(replay.status).toBe(401);
  });
});

describe('Appel et absences (CDC §4.3)', () => {
  it("l'absence saisie par l'enseignant notifie le parent, qui justifie, la vie scolaire valide", async () => {
    const all = await as('direction').get('/students');
    const koffi = all.body.find((s: any) => s.firstName === 'Koffi');
    const cls = koffi.class.id;
    const sheet = await as('teacher').get(`/attendance/sheet?classId=${cls}&date=2026-10-19&startMinute=480`);
    expect(sheet.status).toBe(200);
    const records = sheet.body.students.map((s: any) => ({ studentId: s.id, status: s.id === koffi.id ? 'ABSENT' : 'PRESENT' }));
    const cs = (await as('teacher').get('/evaluation/class-subjects')).body.classSubjects.find((c: any) => c.class.id === cls && c.subject.code === 'ELEC');
    const r = await as('teacher').post('/attendance', { classId: cls, classSubjectId: cs.id, date: '2026-10-19', startMinute: 480, records });
    expect(r.status).toBe(201);
    expect(r.body.notified).toBe(1);

    const notifs = await as('parent').get('/notifications');
    expect(notifs.body.items[0].body).toMatch(/Koffi est absent/);

    // Non lue : le SMS de repli part.
    await new Promise((res) => setTimeout(res, 400));
    expect(consoleSms.sent.some((m) => m.to === PHONES.parent && /Koffi est absent/.test(m.text))).toBe(true);

    const abs = await as('parent').get(`/attendance/absences?studentId=${koffi.id}`);
    const rec = abs.body.find((a: any) => a.status === 'ABSENT');
    await as('parent').post(`/attendance/records/${rec.id}/justify`, { reason: 'Rendez-vous médical' }).expect(201);
    await as('vieScolaire').post(`/attendance/records/${rec.id}/review`, { accept: true }).expect(201);
    const after = await as('parent').get(`/attendance/absences?studentId=${koffi.id}`);
    expect(after.body.find((a: any) => a.id === rec.id).justification).toBe('ACCEPTED');
  });

  it("un enseignant ne fait pas l'appel d'une classe qui n'est pas la sienne", async () => {
    const classes = await as('direction').get('/classes');
    const hr = classes.body.find((c: any) => c.name === '1re année HR');
    const r = await as('teacher').get(`/attendance/sheet?classId=${hr.id}&date=2026-10-19&startMinute=480`);
    expect(r.status).toBe(403);
  });
});

describe('Paiement Mobile Money (CDC §4.4, recette 7.3)', () => {
  it('confirmation opérateur → facture mise à jour, reçu unique, solde à jour', async () => {
    const invoices = await as('parent').get('/finance/invoices');
    const open = invoices.body.find((i: any) => i.remaining > 0);
    const init = await as('parent').post('/payments/mobile-money', { invoiceId: open.id, amount: open.remaining, operator: 'MTN MoMo', phone: '01 97 00 00 01' });
    expect(init.status).toBe(201);
    expect(init.body.status).toBe('PENDING');

    // Rien n'est réglé tant que l'opérateur n'a pas confirmé.
    const before = await as('parent').get('/finance/invoices');
    expect(before.body.find((i: any) => i.id === open.id).paid).toBe(open.paid);

    const ok = await http.post(`/api/v1/payments/sandbox/${init.body.transactionId}/decision`).send({ success: true });
    expect(ok.body.status).toBe('SUCCESS');
    const replay = await http.post(`/api/v1/payments/sandbox/${init.body.transactionId}/decision`).send({ success: true });
    expect(replay.body.alreadyProcessed).toBe(true);

    const p = await as('parent').get(`/payments/${init.body.paymentId}`);
    expect(p.body.status).toBe('SUCCESS');
    expect(p.body.receipt.number).toMatch(/^REC-\d{4}-\d{5}$/);
    const after = await as('parent').get('/finance/invoices');
    expect(after.body.find((i: any) => i.id === open.id).status).toBe('PAID');

    const receipt = await as('parent').get(`/finance/receipts/${p.body.receipt.id}`);
    const verify = await http.get(`/api/v1/public/verify/${receipt.body.verifyCode}`);
    expect(verify.body.valid).toBe(true);
  });

  it('rejette un webhook à la signature falsifiée', async () => {
    const r = await http.post('/api/v1/payments/webhook/sandbox').set('x-sandbox-signature', 'faux').send({ transactionId: 'X' });
    expect(r.status).toBe(400);
  });

  it("encaissement au guichet idempotent, puis annulation par avoir", async () => {
    const invoices = await as('comptable').get('/finance/invoices?status=OPEN');
    const inv = invoices.body[0];
    const body = { invoiceId: inv.id, amount: 10000, method: 'CASH', idempotencyKey: `test-${inv.id}` };
    const a = await as('comptable').post('/finance/payments/desk', body);
    const b = await as('comptable').post('/finance/payments/desk', body);
    expect(a.status).toBe(201);
    expect(b.body.duplicate).toBe(true);
    expect(b.body.receipt.id).toBe(a.body.receipt.id);
    expect((await as('comptable').post('/finance/payments/desk', { ...body, idempotencyKey: undefined, amount: 10 ** 9 })).status).toBe(400);
    await as('comptable').post(`/finance/receipts/${a.body.receipt.id}/cancel`, { reason: 'Erreur de saisie' }).expect(201);
    const verify = await http.get(`/api/v1/public/verify/${a.body.receipt.verifyCode}`);
    expect(verify.body).toMatchObject({ valid: false, revoked: true });
  });
});

describe('Emploi du temps', () => {
  it('refuse un créneau où la classe est déjà occupée', async () => {
    const classes = await as('direction').get('/classes');
    const f3 = classes.body.find((c: any) => c.name === '1re année F3');
    const fr = f3.subjects.find((s: any) => s.subject.code === 'FR');
    const r = await as('direction').post('/timetable/slots', { classSubjectId: fr.id, dayOfWeek: 1, startMinute: 480, endMinute: 600 });
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/La classe a déjà/);
  });
});

describe('Notes et bulletins (CDC §3.3)', () => {
  it('recalcule, fait suivre le circuit, puis verrouille les notes', async () => {
    const mine = await as('teacher').get('/evaluation/class-subjects');
    const elec = mine.body.classSubjects.find((c: any) => c.subject.code === 'ELEC');
    const term = mine.body.terms[0];
    const book = await as('teacher').get(`/evaluation/gradebook?classSubjectId=${elec.id}&termId=${term.id}`);
    const koffi = book.body.students.find((s: any) => s.firstName === 'Koffi');
    expect(koffi.average).toBe(13.5); // (14 + 13) / 2

    const a = await as('teacher').post('/evaluation/assessments', { classSubjectId: elec.id, termId: term.id, title: 'Devoir 2', kind: 'DEVOIR', weight: 1, date: '2026-10-16' });
    expect(a.status).toBe(201);
    await as('teacher').put(`/evaluation/assessments/${a.body.id}/grades`, { grades: [{ studentId: koffi.id, score: 16 }] }).expect(200);
    const book2 = await as('teacher').get(`/evaluation/gradebook?classSubjectId=${elec.id}&termId=${term.id}`);
    expect(book2.body.students.find((s: any) => s.id === koffi.id).average).toBe(14.33);

    const cls = elec.class.id;
    // Le professeur principal (même enseignant) contrôle, la direction valide.
    await as('teacher').post(`/report-cards/runs/${cls}/${term.id}/advance`).expect(201); // → contrôle
    await as('teacher').post(`/report-cards/runs/${cls}/${term.id}/advance`).expect(201); // → conseil
    expect((await as('teacher').post(`/report-cards/runs/${cls}/${term.id}/advance`)).status).toBe(403); // validation : direction seulement
    const preview = await as('direction').get(`/report-cards/runs/${cls}/${term.id}`);
    await as('direction').put(`/report-cards/runs/${cls}/${term.id}/council`, { entries: preview.body.students.map((s: any) => ({ studentId: s.id, appreciation: 'Bon trimestre', councilDecision: 'Passage' })) }).expect(200);
    await as('direction').post(`/report-cards/runs/${cls}/${term.id}/advance`).expect(201); // → validé

    const locked = await as('teacher').put(`/evaluation/assessments/${a.body.id}/grades`, { grades: [{ studentId: koffi.id, score: 20 }] });
    expect(locked.status).toBe(409);

    // Pas encore publié : invisible du parent.
    expect((await as('parent').get(`/report-cards/students/${koffi.id}`)).body.cards).toHaveLength(0);
    await as('direction').post(`/report-cards/runs/${cls}/${term.id}/advance`).expect(201); // → publié
    const cards = await as('parent').get(`/report-cards/students/${koffi.id}`);
    expect(cards.body.cards).toHaveLength(1);
    const card = await as('parent').get(`/report-cards/${cards.body.cards[0].id}`);
    expect(card.body.items.find((i: any) => i.subjectName === 'Électrotechnique').average).toBe('14.33');
    expect(card.body.appreciation).toBe('Bon trimestre');
  });
});

describe('Paramétrage par la direction', () => {
  // PNG 1×1 transparent.
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

  it("l'identité officielle saisie apparaît sur les documents, la signature n'est jamais écrasée par une saisie", async () => {
    const up = await http.post('/api/v1/settings/identity/signature').set('Authorization', `Bearer ${tokens.direction}`).attach('file', PNG, { filename: 's.png', contentType: 'image/png' });
    expect(up.status).toBe(201);
    expect(up.body.signatureUrl).toMatch(/^\/api\/v1\/files\?key=/);
    const r = await as('direction').patch('/settings', { settings: { identity: { authorization: 'ARRÊTÉ-TEST-001', headName: 'Nom Test', signatureKey: null } } });
    expect(r.status).toBe(200);
    expect(r.body.identity.signatureKey).toBeTruthy();
    const student = (await as('direction').get('/students')).body[0];
    const doc = await as('direction').post('/documents', { kind: 'CERTIFICAT_SCOLARITE', studentId: student.id });
    expect(doc.status).toBe(201);
    const print = await as('direction').get(`/documents/print?ids=${doc.body.id}`);
    expect(print.body.identity.authorization).toBe('ARRÊTÉ-TEST-001');
    expect(print.body.identity.headName).toBe('Nom Test');
    expect(print.body.identity.signatureUrl).toBeTruthy();
    expect((await as('secretariat').patch('/settings', { settings: { identity: { headName: 'Pirate' } } })).status).toBe(403);
  });

  it('un site modifié ou désactivé par la direction se reflète sur la page publique', async () => {
    const site = (await as('direction').get('/settings')).body.sites[0];
    const r = await as('direction').patch(`/sites/${site.id}`, { name: site.name, address: 'Adresse de test', active: false });
    expect(r.status).toBe(200);
    let pub = (await http.get('/api/v1/public/saint-kisito')).body;
    expect(pub.sites.find((x: any) => x.id === site.id)).toBeUndefined();
    await as('direction').patch(`/sites/${site.id}`, { name: site.name, address: site.address ?? undefined, active: true }).expect(200);
    pub = (await http.get('/api/v1/public/saint-kisito')).body;
    expect(pub.sites.find((x: any) => x.id === site.id)).toBeTruthy();
    expect((await as('secretariat').patch(`/sites/${site.id}`, { name: 'Pirate' })).status).toBe(403);
  });

  it('la grille des frais crée un frais par niveau et filière, puis le désactive', async () => {
    const s = await as('direction').get('/settings');
    const level = s.body.levels[0];
    const track = s.body.tracks[0];
    const save = (amount: number | null) => as('direction').put('/finance/fee-types/grid', { name: 'Frais de test grille', rows: [{ levelId: level.id, trackId: track.id, amount }] });
    expect((await save(12345)).status).toBe(200);
    expect((await save(23456)).body.saved).toBe(1);
    let fees = (await as('direction').get('/finance/fee-types')).body.filter((f: any) => f.name === 'Frais de test grille');
    expect(fees).toHaveLength(1);
    expect(fees[0].amount).toBe(23456);
    await save(null);
    fees = (await as('direction').get('/finance/fee-types')).body.filter((f: any) => f.name === 'Frais de test grille');
    expect(fees[0].active).toBe(false);
    expect((await as('teacher').put('/finance/fee-types/grid', { name: 'x', rows: [] })).status).toBe(403);
  });

  it('un coefficient appliqué à un niveau change toutes ses classes', async () => {
    const classes = (await as('direction').get('/classes')).body;
    const c = classes.find((x: any) => x.subjects.length > 0);
    const cs = c.subjects[0];
    const r = await as('direction').put('/class-subjects/bulk', { levelId: c.levelId, trackId: c.trackId, subjectId: cs.subject.id, coefficient: 3.5 });
    expect(r.status).toBe(200);
    const after = (await as('direction').get('/classes')).body.filter((x: any) => x.levelId === c.levelId && x.trackId === c.trackId);
    for (const k of after) expect(Number(k.subjects.find((y: any) => y.subject.id === cs.subject.id).coefficient)).toBe(3.5);
  });

  it('une salle peut devenir un atelier, une matière devient pratique', async () => {
    const s = (await as('direction').get('/settings')).body;
    const room = s.rooms[0];
    const r = await as('direction').patch(`/rooms/${room.id}`, { kind: 'WORKSHOP', capacity: 20 });
    expect(r.status).toBe(200);
    expect(r.body.kind).toBe('WORKSHOP');
    const sub = await as('direction').patch(`/subjects/${s.subjects[0].id}`, { practical: true });
    expect(sub.body.practical).toBe(true);
    const used = await as('direction').del(`/rooms/${s.rooms.find((x: any) => x.name === 'Atelier 1').id}`);
    expect(used.status).toBe(409);
  });

  it('un professeur enregistré avec deux matières, puis affecté à une troisième qui rejoint sa liste', async () => {
    const s = (await as('direction').get('/settings')).body;
    const [m1, m2] = s.subjects;
    const r = await as('direction').post('/staff', { firstName: 'Prof', lastName: 'DEUXMATIERES', phone: '0197770011', roles: [{ role: 'ENSEIGNANT' }], subjectIds: [m1.id, m2.id] });
    expect(r.status).toBe(201);
    const mine = async () => (await as('direction').get('/staff')).body.find((u: any) => u.id === r.body.id);
    expect((await mine()).teacherSubjects.map((t: any) => t.subject.id).sort()).toEqual([m1.id, m2.id].sort());
    const cs = (await as('direction').get('/classes')).body.flatMap((c: any) => c.subjects).find((x: any) => x.subject.id !== m1.id && x.subject.id !== m2.id);
    expect((await as('direction').post('/assignments', { teacherId: r.body.id, classSubjectId: cs.id })).status).toBe(201);
    expect((await mine()).teacherSubjects).toHaveLength(3);
    await as('direction').patch(`/staff/${r.body.id}`, { subjectIds: [m2.id] }).expect(200);
    expect((await mine()).teacherSubjects.map((t: any) => t.subject.id)).toEqual([m2.id]);
    const secretary = (await as('direction').get('/staff')).body.find((u: any) => u.roles.every((x: any) => x.role !== 'ENSEIGNANT'));
    expect((await as('direction').patch(`/staff/${secretary.id}`, { subjectIds: [m1.id] })).status).toBe(400);
  });

  it('organise une période de stage et place un élève, visible sur sa fiche', async () => {
    const s = (await as('direction').get('/settings')).body;
    const lycee = s.levels.find((l: any) => l.cycle === 'LYCEE_TECHNIQUE') ?? s.levels[0];
    const p = await as('direction').post('/internships/periods', { label: 'Stage test', levelId: lycee.id, startDate: '2027-03-01', endDate: '2027-03-31' });
    expect(p.status).toBe(201);
    const detail = await as('direction').get(`/internships/periods/${p.body.id}`);
    expect(detail.body.students.length).toBeGreaterThan(0);
    const student = detail.body.students[0];
    const placed = await as('direction').put(`/internships/periods/${p.body.id}/placements`, { studentId: student.id, company: 'Entreprise test', tutorName: 'Tuteur test', status: 'IN_PROGRESS' });
    expect(placed.status).toBe(200);
    const mine = await as('direction').get(`/students/${student.id}/internships`);
    expect(mine.body[0].company).toBe('Entreprise test');
    expect((await as('direction').del(`/internships/periods/${p.body.id}`)).status).toBe(409);
    expect((await as('teacher').post('/internships/periods', { label: 'x', startDate: '2027-01-01', endDate: '2027-01-02' })).status).toBe(403);
    const bad = await as('direction').post('/internships/periods', { label: 'x', startDate: '2027-02-01', endDate: '2027-01-01' });
    expect(bad.status).toBe(400);
  });
});

describe('Plateforme : plusieurs écoles sur un même serveur', () => {
  const email = 'superadmin@test.local';
  const slug = `pf-${Date.now().toString(36)}`;
  let cookie: string;
  let tenantId: string;
  let director: { identifier: string; temporaryPassword: string };

  beforeAll(async () => {
    execSync(`npx ts-node --transpile-only prisma/platform-admin.ts ${email} "Super Admin Test"`, { env: process.env, cwd: `${__dirname}/..` });
    // Mot de passe connu pour le test, sans passer par la sortie de la commande.
    const argon2 = await import('argon2');
    await admin.platformAdmin.update({ where: { email }, data: { passwordHash: await argon2.hash('Plateforme-Test-2026'), mustChangePassword: false } });
  });

  it('le rôle applicatif des écoles ne lit pas les comptes de la plateforme', async () => {
    await expect(app_.$queryRaw`SELECT count(*) FROM platform_admins`).rejects.toThrow();
  });

  it("refuse l'accès sans connexion Super Admin, et le jeton d'une école ne suffit pas", async () => {
    expect((await http.get('/api/v1/platform/tenants')).status).toBe(401);
    expect((await http.get('/api/v1/platform/tenants').set('Authorization', `Bearer ${tokens.direction}`)).status).toBe(401);
    expect((await http.post('/api/v1/platform/auth/login').send({ email, password: 'mauvais' })).status).toBe(401);
  });

  it('le Super Admin crée une école avec son premier compte Direction', async () => {
    const r = await http.post('/api/v1/platform/auth/login').send({ email, password: 'Plateforme-Test-2026' });
    expect(r.status).toBe(201);
    cookie = (r.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('erp_pt='))!.split(';')[0];
    const reserved = await http.post('/api/v1/platform/tenants').set('Cookie', cookie)
      .send({ slug: 'admin', name: 'École réservée', matriculePrefix: 'RES', siteName: 'Centre', director: { firstName: 'A', lastName: 'B', phone: '0190001111' } });
    expect(reserved.status).toBe(400);
    const c = await http.post('/api/v1/platform/tenants').set('Cookie', cookie)
      .send({ slug, name: 'Collège Plateforme Test', matriculePrefix: 'CPT', siteName: 'Centre', director: { firstName: 'Awa', lastName: 'Test', phone: '0190001111' } });
    expect(c.status).toBe(201);
    tenantId = c.body.tenant.id;
    director = c.body.director;
    const list = await http.get('/api/v1/platform/tenants').set('Cookie', cookie);
    expect(list.body.find((t: any) => t.slug === slug)).toMatchObject({ status: 'ACTIVE', sites: 1, students: 0 });
  });

  it('la nouvelle école est vide et étanche : elle ne voit rien de Saint Kisito', async () => {
    const r = await http.post('/api/v1/auth/login').send({ tenant: slug, identifier: director.identifier, password: director.temporaryPassword });
    expect(r.status).toBe(200);
    expect(r.body.mustChangePassword).toBe(true);
    const t = r.body.accessToken;
    const students = await http.get('/api/v1/students').set('Authorization', `Bearer ${t}`);
    expect(students.status === 404 || (students.status === 200 && (students.body.items ?? students.body).length === 0)).toBe(true);
    const settings = await http.get('/api/v1/settings').set('Authorization', `Bearer ${t}`);
    expect(settings.body.sites.map((s: any) => s.name)).toEqual(['Centre']);
    const year = await http.post('/api/v1/academic-years').set('Authorization', `Bearer ${t}`)
      .send({ label: '2026-2027', startDate: '2026-09-15', endDate: '2027-07-15', terms: [{ name: 'Trimestre 1', startDate: '2026-09-15', endDate: '2026-12-20' }] });
    expect(year.status).toBe(201);
    expect(year.body.isCurrent).toBe(true);
    // Le même identifiant ne permet pas d'entrer dans Saint Kisito.
    expect((await http.post('/api/v1/auth/login').send({ tenant: 'saint-kisito', identifier: director.identifier, password: director.temporaryPassword })).status).toBe(401);
  });

  it("la direction renomme son école et choisit sa couleur ; l'école publique les affiche", async () => {
    const r = await as('direction').patch('/settings', { name: 'Lycée privé Saint Kisito-GESA', settings: { branding: { primaryColor: '#1d4ed8', logoKey: '../../etc/passwd' } } });
    expect(r.status).toBe(200);
    const pub = await http.get('/api/v1/public/saint-kisito');
    expect(pub.body.branding.primaryColor).toBe('#1d4ed8');
    expect(pub.body.branding.logoUrl).toBe('/logo.png');
    // 1 pixel PNG : le logo envoyé remplace celui de l'installation et se lit sans connexion.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const up = await http.post('/api/v1/settings/identity/logo').set('Authorization', `Bearer ${tokens.direction}`).attach('file', png, { filename: 'logo.png', contentType: 'image/png' });
    expect(up.status).toBe(201);
    expect(up.body.logoUrl).toMatch(/^\/api\/v1\/public\/saint-kisito\/logo\?v=/);
    const img = await http.get(up.body.logoUrl);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    await http.delete('/api/v1/settings/identity/logo').set('Authorization', `Bearer ${tokens.direction}`);
    expect((await http.get('/api/v1/public/saint-kisito')).body.branding.logoUrl).toBe('/logo.png');
    const bad = await as('direction').patch('/settings', { settings: { branding: { primaryColor: 'red;background:url(x)' } } });
    expect(bad.status).toBe(200);
    expect((await http.get('/api/v1/public/saint-kisito')).body.branding.primaryColor).toBeNull();
  });

  it("une école suspendue ne peut plus se connecter, et la réactivation rétablit l'accès", async () => {
    expect((await http.patch(`/api/v1/platform/tenants/${tenantId}`).set('Cookie', cookie).send({ status: 'SUSPENDED' })).status).toBe(200);
    const blocked = await http.post('/api/v1/auth/login').send({ tenant: slug, identifier: director.identifier, password: director.temporaryPassword });
    expect(blocked.status).toBe(403);
    expect((await http.get(`/api/v1/public/${slug}`)).body.suspended).toBe(true);
    expect((await http.patch(`/api/v1/platform/tenants/${tenantId}`).set('Cookie', cookie).send({ status: 'ACTIVE' })).status).toBe(200);
    expect((await http.post('/api/v1/auth/login').send({ tenant: slug, identifier: director.identifier, password: director.temporaryPassword })).status).toBe(200);
    const audit = await http.get('/api/v1/platform/audit').set('Cookie', cookie);
    expect(audit.body.map((a: any) => a.action)).toEqual(expect.arrayContaining(['platform.tenant.created', 'platform.tenant.suspended', 'platform.tenant.reactivated']));
  });

  it("trouve l'école d'après l'adresse : domaine propre, sinon école par défaut", async () => {
    await http.patch(`/api/v1/platform/tenants/${tenantId}`).set('Cookie', cookie).send({ domain: `${slug}.example.org` });
    expect((await http.get(`/api/v1/platform/resolve?host=${slug}.example.org`)).body.slug).toBe(slug);
    expect((await http.get('/api/v1/platform/resolve?host=localhost:3000')).body.slug).toBe('saint-kisito');
  });
});

describe('Fiche de renseignement chargée et frais par public', () => {
  it("l'espace de Saint Kisito contient les niveaux et les frais réels de la fiche 2026-2027", async () => {
    const s = (await as('direction').get('/settings')).body;
    expect(s.levels.map((l: any) => l.name)).toEqual(expect.arrayContaining(['Maternelle 1', 'CI', 'CM2', '6e', '3e année', '2nde', 'Terminale']));
    const fees = (await as('direction').get('/finance/fee-types')).body;
    const sixieme = s.levels.find((l: any) => l.name === '6e').id;
    const of = (name: string) => fees.find((f: any) => f.name === name && f.levelId === sixieme);
    expect(of('Scolarité 1re tranche').amount).toBe(20000);
    expect(of('Inscription')).toMatchObject({ amount: 5000, audience: 'NEW' });
    expect(of('Réinscription')).toMatchObject({ amount: 3000, audience: 'RETURNING' });
    expect(of('Scolarité en une fois')).toMatchObject({ amount: 47000, optional: true });
    expect(s.tenant.identity.email).toBe('etp.saintkisito@gmail.com');
  });

  it("à l'inscription : frais de réinscription pour un ancien élève, jamais les frais facultatifs", async () => {
    const classes = (await as('direction').get('/classes')).body;
    const sixA = classes.find((c: any) => c.name === '6e A');
    const enroll = (returning: boolean) => as('secretariat').post('/students', {
      firstName: returning ? 'Ancien' : 'Nouveau', lastName: 'TESTFRAIS', classId: sixA.id, createInvoices: true, returning,
      guardians: [{ firstName: 'Parent', lastName: 'TESTFRAIS', phone: returning ? '0197555001' : '0197555002', relation: 'Mère', isPrimary: true }],
    });
    const labels = async (r: any) => {
      expect(r.status).toBe(201);
      const inv = (await as('direction').get(`/finance/invoices?studentId=${r.body.id ?? r.body.student?.id}`)).body;
      return inv.map((i: any) => i.label).sort();
    };
    const fresh = await labels(await enroll(false));
    expect(fresh).toContain('Inscription');
    expect(fresh).not.toContain('Réinscription');
    expect(fresh).not.toContain('Scolarité en une fois');
    expect(fresh).toEqual(expect.arrayContaining(['Frais généraux', 'Scolarité 1re tranche', 'Scolarité 2e tranche', 'Scolarité 3e tranche']));
    const back = await labels(await enroll(true));
    expect(back).toContain('Réinscription');
    expect(back).not.toContain('Inscription');
  });
});

describe("Fin d'année : dates, moyenne annuelle et décision", () => {
  it("la direction modifie la rentrée, la fin d'année et le poids des périodes, dans un ordre cohérent", async () => {
    const y = (await as('direction').get('/settings')).body.currentYear;
    const last = y.terms[y.terms.length - 1];
    const ok = await as('direction').patch(`/academic-years/${y.id}`, { endDate: '2027-07-16', terms: [{ id: last.id, endDate: '2027-07-16', weight: 2 }] });
    expect(ok.status).toBe(200);
    expect(ok.body.endDate.slice(0, 10)).toBe('2027-07-16');
    expect(Number(ok.body.terms[ok.body.terms.length - 1].weight)).toBe(2);
    expect((await as('direction').patch(`/academic-years/${y.id}`, { terms: [{ id: last.id, endDate: '2027-08-30' }] })).status).toBe(400);
    expect((await as('secretariat').patch(`/academic-years/${y.id}`, { endDate: '2027-07-01' })).status).toBe(403);
  });

  it("calcule la moyenne annuelle, propose admis ou non admis selon le seuil de l'école, et la direction arrête la décision", async () => {
    const classes = (await as('direction').get('/classes')).body;
    let annual: any;
    for (const c of classes) {
      annual = (await as('direction').get(`/report-cards/annual/${c.id}`)).body;
      if (annual.students?.some((s: any) => s.average !== null)) break;
    }
    expect(annual.passMark).toBeNull();
    const s = annual.students.find((x: any) => x.average !== null);
    expect(s.proposed).toBeNull();
    expect((await as('direction').patch('/settings', { settings: { grading: { passMark: 25 } } })).status).toBe(400);
    await as('direction').patch('/settings', { settings: { grading: { passMark: s.average } } }).expect(200);
    let again = (await as('direction').get(`/report-cards/annual/${annual.class.id}`)).body;
    expect(again.students.find((x: any) => x.id === s.id).proposed).toBe('ADMIS');
    expect(again.summary.admis).toBeGreaterThan(0);
    await as('direction').put(`/report-cards/annual/${annual.class.id}`, { entries: [{ studentId: s.id, outcome: 'NON_ADMIS', note: 'Décision du conseil' }] }).expect(200);
    again = (await as('direction').get(`/report-cards/annual/${annual.class.id}`)).body;
    expect(again.students.find((x: any) => x.id === s.id)).toMatchObject({ final: 'NON_ADMIS', note: 'Décision du conseil' });
    await as('direction').put(`/report-cards/annual/${annual.class.id}`, { entries: [{ studentId: s.id, outcome: null }] }).expect(200);
    again = (await as('direction').get(`/report-cards/annual/${annual.class.id}`)).body;
    expect(again.students.find((x: any) => x.id === s.id).final).toBe('ADMIS');
    expect((await as('teacher').put(`/report-cards/annual/${annual.class.id}`, { entries: [] })).status).toBe(403);
    await as('direction').patch('/settings', { settings: { grading: { passMark: null } } }).expect(200);
  });

  it('imprime le bulletin annuel : matières par trimestre et moyenne annuelle ; la famille attend la publication du dernier trimestre', async () => {
    const classes = (await as('direction').get('/classes')).body;
    let r: any;
    for (const c of classes) {
      r = await as('direction').get(`/report-cards/annual/${c.id}/cards`);
      if (r.body.cards?.some((x: any) => x.average !== null)) break;
    }
    expect(r.status).toBe(200);
    const card = r.body.cards.find((x: any) => x.average !== null);
    expect(card.subjects.length).toBeGreaterThan(0);
    expect(Object.keys(card.subjects[0].terms)).toHaveLength(r.body.terms.length);
    const one = await as('direction').get(`${r.req.path.replace('/api/v1', '')}?ids=${card.student.id}`);
    expect(one.body.cards).toHaveLength(1);
    const me = (await as('student').get('/auth/me')).body;
    expect(me.self?.id).toBeTruthy();
    expect((await as('student').get(`/report-cards/students/${me.self.id}/annual`)).status).toBe(404);
    expect((await as('comptable').get(`/report-cards/annual/${classes[0].id}/cards`)).status).toBe(403);
  });
});
