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
