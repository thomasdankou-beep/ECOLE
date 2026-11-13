/**
 * Tests de bout en bout sur une base PostgreSQL réelle (erp_test), avec les données de démonstration.
 * Couvre les critères de recette du CDC §7.3 : isolation entre établissements, périmètre par rôle,
 * paiement Mobile Money confirmé → facture + reçu, absence → notification, calculs et verrouillage.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { consoleSms } from '../src/modules/notifications/sms.provider';
import { PlatformDb } from '../src/modules/platform/platform';
import { directionIds } from '../src/modules/auth/recovery';
import { ModulesContainer } from '@nestjs/core';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ALLOW_PENDING_PASSWORD, IS_PUBLIC } from '../src/common/auth';
import { hashPassword } from '../src/modules/auth/auth.service';
import { JwtService } from '@nestjs/jwt';
import { config } from '../src/config';

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
  await admin.$executeRaw`DELETE FROM school_groups g WHERE g.name = 'Autre école' AND NOT EXISTS (SELECT 1 FROM tenants t WHERE t.group_id = g.id)`;
  let t = await admin.tenant.findUnique({ where: { slug: 'autre-ecole' } });
  if (!t) t = await admin.tenant.create({ data: { slug: 'autre-ecole', name: 'Autre école', group: { create: { name: 'Autre école' } } } });
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
  // SEC-042 : dossier de fichiers neuf à chaque lancement (voir setup-env.ts), effacé à la fin.
  const dir = process.env.STORAGE_DIR ?? '';
  if (dir.startsWith(join(tmpdir(), 'erp-test-storage-'))) rmSync(dir, { recursive: true, force: true });
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
    // SEC-024 : même réponse qu'un compte inconnu, le bon mot de passe ne passe pas pendant le blocage.
    expect(r.status).toBe(401);
    const unknown = await http.post('/api/v1/auth/login').send({ tenant: 'saint-kisito', identifier: '+2290199999999', password: PASSWORD });
    expect(unknown.status).toBe(401);
    expect(r.body.message).toBe(unknown.body.message);
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

    // SMS au parent, au format des écoles : élève, classe, matière et créneau du cours.
    await new Promise((res) => setTimeout(res, 900));
    const absSms = consoleSms.sent.filter((m) => m.to === PHONES.parent && /votre enfant/.test(m.text) && /KOFFI/.test(m.text)).pop();
    expect(absSms?.text).toMatch(/^Saint Kisito-GESA : Ce lundi 19\/10\/2026, votre enfant .*KOFFI en classe de .+ est absent pendant le cours de .+ de 8h00/);
    const log = await as('direction').get('/notifications/sms?month=2026-' + new Date().toISOString().slice(5, 7));
    expect(log.status).toBe(200);
    expect(log.body.items.some((i: any) => i.kind === 'absence' && i.phone === PHONES.parent && i.status === 'SENT' && i.segments === 1)).toBe(true);
    expect((await as('teacher').get('/notifications/sms')).status).toBe(403);

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

    // SEC-005 : la simulation est réservée au parent connecté ; sans connexion, rien n'est lu ni validé.
    expect((await http.get(`/api/v1/payments/sandbox/${init.body.transactionId}`)).status).toBe(401);
    expect((await http.post(`/api/v1/payments/sandbox/${init.body.transactionId}/decision`).send({ success: true })).status).toBe(401);
    const ok = await as('parent').post(`/payments/sandbox/${init.body.transactionId}/decision`, { success: true });
    expect(ok.body.status).toBe('SUCCESS');
    const replay = await as('parent').post(`/payments/sandbox/${init.body.transactionId}/decision`, { success: true });
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
    // SMS de paiement au responsable, même sans compte Cahiora : net à payer, payé, reste.
    await new Promise((res) => setTimeout(res, 900));
    const paySms = consoleSms.sent.filter((m) => /un paiement de 10 000 a été effectué pour/.test(m.text)).pop();
    expect(paySms?.text).toMatch(/en classe de .+\. NAP: [\d ]+, PAYE: [\d ]+, RESTE: [\d ]+$/);
    // SEC-015 : le comptable demande, le reçu reste valide ; il n'est annulé qu'à la validation de la direction.
    await as('comptable').post(`/finance/receipts/${a.body.receipt.id}/cancel`, { reason: 'Erreur de saisie' }).expect(201);
    expect((await http.get(`/api/v1/public/verify/${a.body.receipt.verifyCode}`)).body).toMatchObject({ valid: true });
    await as('direction').post(`/finance/receipts/${a.body.receipt.id}/cancel/decision`, { approve: true }).expect(201);
    const verify = await http.get(`/api/v1/public/verify/${a.body.receipt.verifyCode}`);
    expect(verify.body).toMatchObject({ valid: false, revoked: true });
  });

  it("l'annulation d'un reçu attend la direction : le comptable ne peut ni la valider ni la forcer (SEC-015)", async () => {
    const invoices = await as('comptable').get('/finance/invoices?status=OPEN');
    const inv = invoices.body.find((i: any) => i.total - i.paid >= 2000);
    const pay = await as('comptable').post('/finance/payments/desk', { invoiceId: inv.id, amount: 1000, method: 'CASH' });
    expect(pay.status).toBe(201);
    const rid = pay.body.receipt.id;
    const paidBefore = (await as('comptable').get(`/finance/invoices?studentId=${inv.studentId}`)).body.find((i: any) => i.id === inv.id).paid;
    expect((await as('comptable').post(`/finance/receipts/${rid}/cancel`, { reason: 'Doublon' })).status).toBe(201);
    // Une seconde demande, ou la validation par le comptable lui-même, sont refusées.
    expect((await as('comptable').post(`/finance/receipts/${rid}/cancel`, { reason: 'Doublon' })).status).toBe(409);
    expect((await as('comptable').post(`/finance/receipts/${rid}/cancel/decision`, { approve: true })).status).toBe(403);
    expect((await as('secretariat').post(`/finance/receipts/${rid}/cancel/decision`, { approve: true })).status).toBe(403);
    // Le reçu et la facture ne changent pas tant que la direction n'a pas validé.
    const r1 = await as('comptable').get(`/finance/receipts/${rid}`);
    expect(r1.body.cancelledAt).toBeNull();
    expect(r1.body.cancelRequestReason).toBe('Doublon');
    expect((await as('comptable').get(`/finance/invoices?studentId=${inv.studentId}`)).body.find((i: any) => i.id === inv.id).paid).toBe(paidBefore);
    // La direction est prévenue, puis refuse : la demande disparaît, le reçu reste valide.
    const notes = await as('direction').get('/notifications');
    expect(JSON.stringify(notes.body)).toContain(pay.body.receipt.number);
    expect((await as('direction').post(`/finance/receipts/${rid}/cancel/decision`, { approve: false, comment: 'Paiement réel' })).status).toBe(201);
    const r2 = await as('comptable').get(`/finance/receipts/${rid}`);
    expect(r2.body.cancelledAt).toBeNull();
    expect(r2.body.cancelRequestedAt).toBeNull();
    // Nouvelle demande, validée cette fois : le reçu est annulé et le montant redevient dû.
    await as('comptable').post(`/finance/receipts/${rid}/cancel`, { reason: 'Doublon confirmé' }).expect(201);
    expect((await as('direction').post(`/finance/receipts/${rid}/cancel/decision`, { approve: true })).status).toBe(201);
    const r3 = await as('comptable').get(`/finance/receipts/${rid}`);
    expect(r3.body.cancelledAt).not.toBeNull();
    expect(r3.body.cancelReason).toBe('Doublon confirmé');
    expect((await as('comptable').get(`/finance/invoices?studentId=${inv.studentId}`)).body.find((i: any) => i.id === inv.id).paid).toBe(paidBefore - 1000);
    expect((await as('direction').post(`/finance/receipts/${rid}/cancel/decision`, { approve: true })).status).toBe(409);
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
    execSync(`npx ts-node --transpile-only prisma/platform-admin.ts ${email} "Super Admin Test" --operateur "Tests automatiques" --motif "Remise à zéro du compte de test"`, { env: process.env, cwd: `${__dirname}/..` });
    // Mot de passe connu pour le test, sans passer par la sortie de la commande.
    const argon2 = await import('argon2');
    await admin.platformAdmin.update({ where: { email }, data: { passwordHash: await argon2.hash('Plateforme-Test-2026'), mustChangePassword: false, mustSetupTwoFactor: false } });
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
    // SEC-023 : tant que le mot de passe provisoire n'est pas changé, seules les routes du compte répondent.
    expect((await http.get('/api/v1/students').set('Authorization', `Bearer ${r.body.accessToken}`)).status).toBe(403);
    expect((await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${r.body.accessToken}`)).status).toBe(200);
    await http.post('/api/v1/auth/change-password').set('Authorization', `Bearer ${r.body.accessToken}`)
      .send({ current: director.temporaryPassword, next: 'Nouveau2026x' }).expect(200);
    director.temporaryPassword = 'Nouveau2026x';
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

  it("le nom d'expéditeur SMS de l'école se règle par le Super Admin seulement", async () => {
    expect((await http.patch(`/api/v1/platform/tenants/${tenantId}`).set('Cookie', cookie).send({ smsSender: 'Nom bien trop long' })).status).toBe(400);
    expect((await http.patch(`/api/v1/platform/tenants/${tenantId}`).set('Cookie', cookie).send({ smsSender: 'ST KISITO' })).status).toBe(200);
    const row = (await http.get('/api/v1/platform/tenants').set('Cookie', cookie)).body.find((t: any) => t.id === tenantId);
    expect(row.smsSender).toBe('ST KISITO');
    // La direction de l'école ne peut pas le remplacer par ses propres paramètres.
    await as('direction').patch('/settings', { settings: { smsSender: 'PIRATE' } }).expect(200);
    const own = await admin.tenant.findUniqueOrThrow({ where: { slug: 'saint-kisito' } });
    expect((own.settings as any).smsSender).toBeUndefined();
    expect((await http.patch(`/api/v1/platform/tenants/${tenantId}`).set('Cookie', cookie).send({ smsSender: '' })).status).toBe(200);
  });

  it("trouve l'école d'après l'adresse : domaine propre, sinon école par défaut", async () => {
    await http.patch(`/api/v1/platform/tenants/${tenantId}`).set('Cookie', cookie).send({ domain: `${slug}.example.org` });
    expect((await http.get(`/api/v1/platform/resolve?host=${slug}.example.org`)).body.slug).toBe(slug);
    expect((await http.get('/api/v1/platform/resolve?host=localhost:3000')).body.slug).toBe('saint-kisito');
  });

  it("le Super Admin travaille avec un rôle de base dédié, sans droits de propriétaire (SEC-009)", async () => {
    const pdb = app.get(PlatformDb);
    const who = await pdb.$queryRaw<{ u: string; owner: boolean; bypass: boolean }[]>`
      SELECT current_user AS u, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass,
             EXISTS (SELECT 1 FROM pg_tables WHERE tableowner = current_user) AS owner`;
    expect(who[0]).toEqual({ u: 'erp_platform', owner: false, bypass: false });
    await expect(pdb.$executeRawUnsafe('ALTER TABLE students DISABLE ROW LEVEL SECURITY')).rejects.toThrow();
    await expect(pdb.$queryRaw`SELECT count(*) FROM grades`).rejects.toThrow(/permission denied/);
    // Hors transaction d'une école, il ne voit aucun élève.
    expect(Number((await pdb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM students`)[0].n)).toBe(0);
  });

  it("la direction voit dans son journal la réinitialisation et la suspension faites par la plateforme (SEC-010)", async () => {
    const reset = await http.post(`/api/v1/platform/tenants/${tenantId}/reset-director`).set('Cookie', cookie);
    expect(reset.status).toBe(201);
    await http.patch(`/api/v1/platform/tenants/${tenantId}`).set('Cookie', cookie).send({ status: 'SUSPENDED', platformNotes: 'Note interne fictive' }).expect(200);
    await http.patch(`/api/v1/platform/tenants/${tenantId}`).set('Cookie', cookie).send({ status: 'ACTIVE' }).expect(200);
    const r = await http.post('/api/v1/auth/login').send({ tenant: slug, identifier: reset.body.identifier, password: reset.body.temporaryPassword });
    await http.post('/api/v1/auth/change-password').set('Authorization', `Bearer ${r.body.accessToken}`)
      .send({ current: reset.body.temporaryPassword, next: 'Nouveau2027x' }).expect(200);
    const log = await http.get('/api/v1/audit?action=platform').set('Authorization', `Bearer ${r.body.accessToken}`);
    expect(log.status).toBe(200);
    const actions = log.body.map((e: any) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['platform.tenant.created', 'platform.director_reset', 'platform.tenant.suspended', 'platform.tenant.reactivated']));
    expect(log.body.every((e: any) => e.userName.startsWith('Super Admin de la plateforme'))).toBe(true);
    // Les notes internes de la plateforme ne sont jamais recopiées chez l'école.
    expect(JSON.stringify(log.body)).not.toContain('Note interne fictive');
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

describe("Élèves à l'honneur sur le site public", () => {
  // PNG 1×1 transparent.
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

  /** SEC-042 : le groupe prépare lui-même un bulletin publié s'il n'y en a pas encore (lancé seul ou après les autres). */
  async function ensurePublishedCards() {
    if ((await as('direction').get('/honors')).body.suggestions.length) return;
    const mine = (await as('teacher').get('/evaluation/class-subjects')).body;
    const cls = mine.classSubjects.find((c: any) => c.subject.code === 'ELEC').class.id;
    const term = mine.terms[0].id;
    for (let i = 0; i < 5; i++) {
      const run = (await as('direction').get(`/report-cards/runs/${cls}/${term}`)).body;
      if (run.status === 'PUBLIE') return;
      if (run.status === 'CONSEIL') {
        await as('direction').put(`/report-cards/runs/${cls}/${term}/council`, { entries: run.students.map((s: any) => ({ studentId: s.id, appreciation: 'Bon trimestre', councilDecision: 'Passage' })) }).expect(200);
      }
      await as('direction').post(`/report-cards/runs/${cls}/${term}/advance`).expect(201);
    }
  }

  it("rien n'est public sans choix de la direction ; publié avec l'accord des parents, sans la moyenne si elle le décide", async () => {
    expect((await http.get('/api/v1/public/saint-kisito')).body.honors).toEqual([]);
    await ensurePublishedCards();
    const o = (await as('direction').get('/honors')).body;
    const best = o.suggestions[0];
    expect(best).toBeTruthy();
    expect((await as('direction').post('/honors', { reportCardId: best.reportCardId, displayName: best.suggestedName, showAverage: false, consent: false })).status).toBe(400);
    const h = await as('direction').post('/honors', { reportCardId: best.reportCardId, displayName: best.suggestedName, showAverage: false, consent: true });
    expect(h.status).toBe(201);
    expect((await as('direction').post('/honors', { reportCardId: best.reportCardId, displayName: 'X Y', showAverage: true, consent: true })).status).toBe(409);
    const pub = (await http.get('/api/v1/public/saint-kisito')).body.honors;
    expect(pub).toHaveLength(1);
    expect(pub[0]).toMatchObject({ displayName: best.suggestedName, className: best.className, average: null, hasPhoto: false });
    expect(JSON.stringify(pub)).not.toContain(best.studentId);
    const up = await http.post(`/api/v1/honors/${h.body.id}/photo`).set('Authorization', `Bearer ${tokens.direction}`).attach('file', PNG, { filename: 'p.png', contentType: 'image/png' });
    expect(up.status).toBe(201);
    const photo = await http.get(`/api/v1/public/saint-kisito/honors/${h.body.id}/photo`);
    expect(photo.status).toBe(200);
    expect((await as('secretariat').post('/honors', { reportCardId: best.reportCardId, displayName: 'X', showAverage: true, consent: true })).status).toBe(403);
    await as('direction').del(`/honors/${h.body.id}`).expect(200);
    expect((await http.get('/api/v1/public/saint-kisito')).body.honors).toEqual([]);
  });
});

describe("Photo de chaque site sur la page d'accueil", () => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

  it("la direction envoie, remplace et retire la photo d'un site ; l'accueil public l'affiche", async () => {
    const site = (await http.get('/api/v1/public/saint-kisito')).body.sites[0];
    expect(site.photoUrl).toBeNull();
    expect(JSON.stringify(site)).not.toContain('photoKey');
    const send = (role: 'direction' | 'secretariat', type = 'image/png') =>
      http.post(`/api/v1/sites/${site.id}/photo`).set('Authorization', `Bearer ${tokens[role]}`).attach('file', PNG, { filename: 'site.png', contentType: type });
    expect((await send('secretariat')).status).toBe(403);
    expect((await send('direction', 'application/pdf')).status).toBe(400);
    expect((await send('direction')).status).toBe(201);
    const url = (await http.get('/api/v1/public/saint-kisito')).body.sites.find((x: { id: string }) => x.id === site.id).photoUrl;
    expect(url).toMatch(new RegExp(`^/api/v1/public/saint-kisito/sites/${site.id}/photo\\?v=`));
    const photo = await http.get(url);
    expect(photo.status).toBe(200);
    expect(photo.headers['content-type']).toContain('image/png');
    expect((await as('direction').get('/settings')).body.sites.find((x: { id: string }) => x.id === site.id).photoUrl).toBe(url);
    await as('direction').del(`/sites/${site.id}/photo`).expect(200);
    expect((await http.get('/api/v1/public/saint-kisito')).body.sites.find((x: { id: string }) => x.id === site.id).photoUrl).toBeNull();
    expect((await http.get(`/api/v1/public/saint-kisito/sites/${site.id}/photo`)).status).toBe(404);
  });
});

describe("Photo et pièces du dossier de l'élève", () => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const PDF = Buffer.from('%PDF-1.4\n%test\n');
  const post = (path: string) => http.post(`/api/v1${path}`).set('Authorization', `Bearer ${tokens.direction}`);

  it("enregistre la photo et les pièces, les remplace, les retire ; seuls la direction et le secrétariat voient les pièces", async () => {
    const student = (await as('direction').get('/students')).body[0];
    const photo = await post(`/students/${student.id}/photo`).attach('file', PNG, { filename: 'photo.png', contentType: 'image/png' });
    expect(photo.status).toBe(201);
    expect(photo.body.photoUrl).toMatch(/^\/api\/v1\/files\?key=/);
    expect((await post(`/students/${student.id}/photo`).attach('file', PDF, { filename: 'x.pdf', contentType: 'application/pdf' })).status).toBe(400);

    const f = await post(`/students/${student.id}/files`).field('label', 'Extrait de naissance').attach('file', PDF, { filename: 'extrait.pdf', contentType: 'application/pdf' });
    expect(f.status).toBe(201);
    expect((await post(`/students/${student.id}/files`).attach('file', PDF, { filename: 'a.pdf', contentType: 'application/pdf' })).status).toBe(400);
    let dossier = (await as('direction').get(`/students/${student.id}`)).body;
    expect(dossier.photoUrl).toBeTruthy();
    expect(dossier.files).toEqual([expect.objectContaining({ label: 'Extrait de naissance', mime: 'application/pdf' })]);
    expect((await http.get(dossier.files[0].url)).status).toBe(200);

    const replaced = await http.patch(`/api/v1/students/${student.id}/files/${f.body.id}`).set('Authorization', `Bearer ${tokens.direction}`).field('label', 'Acte de naissance légalisé').attach('file', PNG, { filename: 'acte.png', contentType: 'image/png' });
    expect(replaced.status).toBe(200);
    expect(replaced.body).toMatchObject({ label: 'Acte de naissance légalisé', mime: 'image/png' });

    const teacherView = await as('teacher').get(`/students/${student.id}`);
    if (teacherView.status === 200) expect(teacherView.body.files).toBeUndefined();
    expect((await http.post(`/api/v1/students/${student.id}/files`).set('Authorization', `Bearer ${tokens.teacher}`).field('label', 'x').attach('file', PDF, { filename: 'a.pdf', contentType: 'application/pdf' })).status).toBe(403);

    await as('secretariat').del(`/students/${student.id}/files/${f.body.id}`).expect(200);
    await as('direction').del(`/students/${student.id}/photo`).expect(200);
    dossier = (await as('direction').get(`/students/${student.id}`)).body;
    expect(dossier.files).toEqual([]);
    expect(dossier.photoUrl).toBeNull();
  });
});

/**
 * Audit de sécurité v1.1, étape 1 (SEC-001 à SEC-005) : une école ne doit ni lire, ni référencer,
 * ni bloquer les fiches d'une autre ; une suspension ou une déconnexion coupe l'accès tout de suite.
 */
describe('Étanchéité entre écoles : références, blocages et sessions (SEC-001 à SEC-005)', () => {
  const slugB = `etanche-${Date.now().toString(36)}`;
  const phoneB = '+2290166000001';
  let tidB = '';
  let tokenB = '';
  let classB = '';
  let studentB = '';
  let A: { tenant: string; site: string; level: string; klass: string; term: string; student: string; subject: string };

  const asB = (role?: string) => {
    const h = (r: request.Test) => (role ? r.set('X-Active-Role', role) : r).set('Authorization', `Bearer ${tokenB}`);
    return {
      get: (url: string) => h(http.get(`/api/v1${url}`)),
      post: (url: string, body?: object) => h(http.post(`/api/v1${url}`)).send(body ?? {}),
      put: (url: string, body?: object) => h(http.put(`/api/v1${url}`)).send(body ?? {}),
      patch: (url: string, body?: object) => h(http.patch(`/api/v1${url}`)).send(body ?? {}),
    };
  };
  const inTenant = <T>(tid: string, fn: (tx: any) => Promise<T>) =>
    admin.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tid}, true)`;
      return fn(tx);
    });

  beforeAll(async () => {
    const argon2 = await import('argon2');
    const t = await admin.tenant.create({ data: { slug: slugB, name: 'École B (test)', settings: { matriculePrefix: 'ETB' }, group: { create: { name: 'École B (test)' } } } });
    tidB = t.id;
    const ids = await inTenant(tidB, async (tx) => {
      const site = await tx.site.create({ data: { tenantId: tidB, name: 'Site B' } });
      const year = await tx.academicYear.create({ data: { tenantId: tidB, label: '2026-2027', startDate: new Date('2026-09-01'), endDate: new Date('2027-07-31'), isCurrent: true } });
      await tx.term.create({ data: { tenantId: tidB, academicYearId: year.id, name: 'T1', position: 1, startDate: new Date('2026-09-01'), endDate: new Date('2026-12-20') } });
      const level = await tx.level.create({ data: { tenantId: tidB, name: '6e', cycle: 'COLLEGE', position: 1 } });
      const klass = await tx.class.create({ data: { tenantId: tidB, siteId: site.id, academicYearId: year.id, levelId: level.id, name: '6e B' } });
      const student = await tx.student.create({ data: { tenantId: tidB, matricule: 'ETB-26-0001', firstName: 'Élève', lastName: 'BÉ' } });
      await tx.enrollment.create({ data: { tenantId: tidB, studentId: student.id, classId: klass.id, academicYearId: year.id } });
      await tx.user.create({
        data: {
          tenantId: tidB, firstName: 'Direction', lastName: 'B', phone: phoneB, passwordHash: await argon2.hash(PASSWORD), mustChangePassword: false,
          roles: { create: ['DIRECTION', 'VIE_SCOLAIRE', 'COMPTABLE', 'SECRETARIAT'].map((role) => ({ tenantId: tidB, role: role as any })) },
        },
      });
      return { klass: klass.id, student: student.id };
    });
    classB = ids.klass;
    studentB = ids.student;
    tokenB = await login(phoneB, slugB);

    const ta = await admin.tenant.findUniqueOrThrow({ where: { slug: 'saint-kisito' } });
    A = await inTenant(ta.id, async (tx) => {
      const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
      const klass = await tx.class.findFirstOrThrow({ where: { academicYearId: year.id, enrollments: { some: {} } } });
      const used = await tx.reportCardRun.findMany({ where: { classId: klass.id }, select: { termId: true } });
      const term = await tx.term.findFirstOrThrow({ where: { academicYearId: year.id, id: { notIn: used.map((u: any) => u.termId) } } });
      const enr = await tx.enrollment.findFirstOrThrow({ where: { classId: klass.id } });
      const subject = await tx.subject.findFirstOrThrow({});
      return { tenant: ta.id, site: klass.siteId, level: klass.levelId, klass: klass.id, term: term.id, student: enr.studentId, subject: subject.id };
    });
  });

  it("refuse les fiches d'une autre école dans les créations et modifications, avec la même réponse qu'un identifiant inventé", async () => {
    const unknown = '11111111-1111-4111-8111-111111111111';
    const attempts: [string, () => request.Test][] = [
      ['salle sur un site de A', () => asB().post('/rooms', { siteId: A.site, name: 'Salle B' })],
      ['classe sur un site et un niveau de A', () => asB().post('/classes', { name: '6e X', siteId: A.site, levelId: A.level })],
      ['matière de A dans une classe de B', () => asB().put(`/classes/${classB}/subjects`, { subjectId: A.subject, coefficient: 1 })],
      ['élève de B dans une classe de A', () => asB().post(`/students/${studentB}/class`, { classId: A.klass })],
      ['responsable ajouté à un élève de A', () => asB().post(`/students/${A.student}/guardians`, { firstName: 'P', lastName: 'X', phone: '0197555555', relation: 'Père' })],
      ['sanction sur un élève de A', () => asB('VIE_SCOLAIRE').post('/sanctions', { studentId: A.student, kind: 'Avertissement', reason: 'test', date: '2026-11-06' })],
      ['facture pour un élève de A', () => asB('COMPTABLE').post('/finance/invoices', { studentId: A.student, label: 'x', dueDate: '2026-12-01', items: [{ label: 'x', amount: 1 }] })],
      ['frais sur un niveau de A', () => asB().post('/finance/fee-types', { name: 'x', amount: 1, levelId: A.level })],
      ['annonce à une classe de A', () => asB().post('/announcements', { title: 'x', body: 'x', audience: 'CLASS', classId: A.klass })],
      ['stage sur un niveau de A', () => asB().post('/internships/periods', { label: 'x', levelId: A.level, startDate: '2026-11-06', endDate: '2026-12-01' })],
      ['bulletins d’une classe de A', () => asB().post(`/report-cards/runs/${A.klass}/${A.term}/advance`)],
    ];
    for (const [what, req] of attempts) {
      const r = await req();
      expect([what, r.status]).toEqual([what, 404]);
    }
    expect((await asB().post('/rooms', { siteId: unknown, name: 'Salle B' })).status).toBe(404);
    // Rien n'a été écrit chez B qui pointe vers A.
    const leaks = await inTenant(tidB, async (tx) => ({
      rooms: await tx.room.count({ where: { siteId: A.site } }),
      sanctions: await tx.sanction.count({ where: { studentId: A.student } }),
      runs: await tx.reportCardRun.count({ where: { classId: A.klass } }),
      invoices: await tx.invoice.count({ where: { studentId: A.student } }),
    }));
    expect(leaks).toEqual({ rooms: 0, sanctions: 0, runs: 0, invoices: 0 });
  });

  it("A garde la main sur ses propres salles et sur ses bulletins (pas de blocage par B)", async () => {
    const room = await as('direction').post('/rooms', { siteId: A.site, name: `Salle B-${slugB}` });
    expect(room.status).toBe(201);
    const run = await as('direction').post(`/report-cards/runs/${A.klass}/${A.term}/advance`);
    expect(run.status).toBe(201);
  });

  it('les opérations légitimes de B sur ses propres fiches restent possibles', async () => {
    const site = (await asB().get('/settings')).body.sites[0].id;
    expect((await asB().post('/rooms', { siteId: site, name: 'Salle 1' })).status).toBe(201);
    expect((await asB('VIE_SCOLAIRE').post('/sanctions', { studentId: studentB, kind: 'Avertissement', reason: 'test', date: '2026-11-06' })).status).toBe(201);
  });

  it("la même clé anti-doublon d'encaissement peut servir dans deux écoles (SEC-008)", async () => {
    const key = `cle-commune-${slugB}`;
    const invA = (await as('comptable').get('/finance/invoices?status=OPEN')).body;
    const a = (invA.items ?? invA).find((i: any) => i.total - i.paid >= 2);
    expect((await as('comptable').post('/finance/payments/desk', { invoiceId: a.id, amount: 1, method: 'CASH', idempotencyKey: key })).status).toBe(201);
    const inv = await asB('COMPTABLE').post('/finance/invoices', { studentId: studentB, label: 'Scolarité', dueDate: '2026-12-01', items: [{ label: 'Scolarité', amount: 5000 }] });
    expect(inv.status).toBe(201);
    const b = await asB('COMPTABLE').post('/finance/payments/desk', { invoiceId: inv.body.id, amount: 1000, method: 'CASH', idempotencyKey: key });
    expect(b.status).toBe(201);
    expect(b.body.duplicate).toBeFalsy();
    // Dans une même école, la clé protège toujours contre le double encaissement.
    const again = await asB('COMPTABLE').post('/finance/payments/desk', { invoiceId: inv.body.id, amount: 1000, method: 'CASH', idempotencyKey: key });
    expect(again.body.duplicate).toBe(true);
  });

  it("« déconnecter tous les appareils » coupe aussitôt le jeton d'accès", async () => {
    const t = await login(phoneB, slugB);
    expect((await http.get('/api/v1/students').set('Authorization', `Bearer ${t}`)).status).toBe(200);
    await http.post('/api/v1/auth/logout-all').set('Authorization', `Bearer ${t}`).expect(200);
    expect((await http.get('/api/v1/students').set('Authorization', `Bearer ${t}`)).status).toBe(401);
  });

  it("une école suspendue perd l'accès même avec un jeton déjà délivré", async () => {
    const t = await login(phoneB, slugB);
    expect((await http.get('/api/v1/students').set('Authorization', `Bearer ${t}`)).status).toBe(200);
    await admin.tenant.update({ where: { id: tidB }, data: { status: 'SUSPENDED' } });
    // Suspension faite directement en base, sans passer par la plateforme : le cache de 30 s s'applique.
    require('../src/common/auth').forgetSessions({ tenantId: tidB });
    expect((await http.get('/api/v1/students').set('Authorization', `Bearer ${t}`)).status).toBe(401);
    await admin.tenant.update({ where: { id: tidB }, data: { status: 'ACTIVE' } });
  });

  it("en production, le bac à sable des paiements n'est jamais actif sans autorisation explicite", () => {
    const { paymentProvider } = require('../src/config');
    expect(paymentProvider({ NODE_ENV: 'production' })).toBe('disabled');
    expect(paymentProvider({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'sandbox' })).toBe('disabled');
    expect(paymentProvider({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'sandbox', ALLOW_SANDBOX_PAYMENTS: 'true' })).toBe('sandbox');
    expect(paymentProvider({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'cinetpay' })).toBe('cinetpay');
    expect(paymentProvider({ NODE_ENV: 'development' })).toBe('sandbox');
  });
});

describe('Cloisonnement dans la base elle-même (SEC-006, SEC-007, SEC-001 option B)', () => {
  let A = '';
  let O = '';
  const inApp = <T>(tid: string, fn: (tx: any) => Promise<T>) =>
    app_.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tid}, true)`;
      return fn(tx);
    });

  beforeAll(async () => {
    A = (await admin.tenant.findUniqueOrThrow({ where: { slug: 'saint-kisito' } })).id;
    O = (await admin.tenant.findUniqueOrThrow({ where: { slug: 'autre-ecole' } })).id;
  });

  it("une école ne lit que sa propre fiche d'établissement, jamais les notes de la plateforme (SEC-006)", async () => {
    const seen = await inApp(A, (tx) => tx.$queryRaw`SELECT id::text AS id FROM tenants`);
    expect((seen as { id: string }[]).map((r) => r.id)).toEqual([A]);
    await expect(inApp(A, (tx) => tx.$queryRaw`SELECT "platformNotes" FROM tenants`)).rejects.toThrow(/permission denied/);
    await expect(app_.$queryRaw`SELECT "platformNotes" FROM tenants`).rejects.toThrow(/permission denied/);
    // Hors transaction d'école, la recherche d'une école par son identifiant reste possible (connexion, adresse du site).
    const bySlug = await app_.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM tenants WHERE slug = 'autre-ecole'`;
    expect(Number(bySlug[0].n)).toBe(1);
    // La plateforme garde ses notes.
    await admin.tenant.update({ where: { id: O }, data: { platformNotes: 'Contrat fictif' } });
    expect((await admin.tenant.findUniqueOrThrow({ where: { id: O } })).platformNotes).toBe('Contrat fictif');
  });

  it("codes de vérification et routage des paiements : chaque école ne voit et n'écrit que les siens (SEC-007)", async () => {
    const code = `TST${Date.now().toString(36)}`.toUpperCase();
    const entry = { kind: 'Document de test', summary: 'Donnée fictive', issuedAt: new Date() };
    await inApp(O, (tx) => tx.verificationEntry.create({ data: { code, tenantId: O, ...entry } }));
    expect(await inApp(A, (tx) => tx.verificationEntry.findUnique({ where: { code } }))).toBeNull();
    await expect(inApp(A, (tx) => tx.verificationEntry.create({ data: { code: `${code}X`, tenantId: O, ...entry } }))).rejects.toThrow();
    await expect(inApp(A, (tx) => tx.$executeRaw`INSERT INTO payment_routes (transaction_id, tenant_id) VALUES (${code}, ${O}::uuid)`)).rejects.toThrow();
    // La vérification publique d'un document, sans connexion, fonctionne toujours.
    const pub = await http.get(`/api/v1/public/verify/${code}`);
    expect(pub.status).toBe(200);
  });

  // Le refus vient du contrôle check_same_tenant (message « Référence vers un autre établissement »),
  // que Prisma remonte comme une clé étrangère invalide (P2003, réponse 400 de l'API).
  it("la base refuse une fiche qui pointe vers celle d'une autre école, même sans passer par l'API (SEC-001)", async () => {
    const siteO = await admin.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${O}, true)`;
      return (await tx.site.findFirst()) ?? tx.site.create({ data: { tenantId: O, name: 'Site autre' } });
    });
    await expect(inApp(A, (tx) => tx.room.create({ data: { tenantId: A, siteId: siteO.id, name: 'Intrus' } }))).rejects.toMatchObject({ code: 'P2003' });
    const userA: any = await inApp(A, (tx) => tx.user.findFirstOrThrow());
    await expect(
      inApp(A, (tx) => tx.sanction.create({ data: { tenantId: A, studentId: otherTenantStudentId, proposedById: userA.id, kind: 'Avertissement', reason: 'test', date: new Date() } })),
    ).rejects.toMatchObject({ code: 'P2003' });
    // Une référence à sa propre école passe toujours.
    const siteA: any = await inApp(A, (tx) => tx.site.findFirstOrThrow());
    const room: any = await inApp(A, (tx) => tx.room.create({ data: { tenantId: A, siteId: siteA.id, name: `Salle contrôle ${Date.now()}` } }));
    expect(room.siteId).toBe(siteA.id);
  });

  it('le contrôle couvre toutes les clés étrangères entre tables des écoles', async () => {
    const missing = await admin.$queryRaw<{ fk: string }[]>`
      SELECT con.conrelid::regclass::text || '.' || ca.attname AS fk
      FROM pg_constraint con
      JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = con.conkey[1]
      WHERE con.contype = 'f' AND con.connamespace = 'public'::regnamespace AND ca.attname <> 'tenant_id'
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = con.conrelid AND a.attname = 'tenant_id')
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = con.confrelid AND a.attname = 'tenant_id')
        AND NOT EXISTS (
          SELECT 1 FROM pg_trigger t WHERE t.tgrelid = con.conrelid AND t.tgname = 'same_tenant_refs'
            AND position(ca.attname || '\\000' IN encode(t.tgargs, 'escape')) > 0)`;
    expect(missing).toEqual([]);
  });
});

describe("Jetons et adresses (SEC-011, SEC-012)", () => {
  it("le jeton d'une école est refusé sur l'adresse d'une autre école, en mode plateforme (SEC-011)", async () => {
    const before = config.platformDomain;
    (config as any).platformDomain = 'cahiora.test';
    try {
      const other = await admin.tenant.findUniqueOrThrow({ where: { slug: 'saint-kisito' } });
      const ok = await http.get('/api/v1/students').set('Host', 'saint-kisito.cahiora.test').set('Authorization', `Bearer ${tokens.direction}`);
      expect(ok.status).toBe(200);
      const wrong = await http.get('/api/v1/students').set('Host', 'autre-ecole.cahiora.test').set('Authorization', `Bearer ${tokens.direction}`);
      expect(wrong.status).toBe(403);
      const foreignDomain = await http.get('/api/v1/students').set('Host', 'ecole-inconnue.example.org').set('Authorization', `Bearer ${tokens.direction}`);
      expect(foreignDomain.status).toBe(403);
      // Adresse interne (appel entre services) : pas de contrôle d'adresse.
      expect((await http.get('/api/v1/students').set('Host', 'api:4000').set('Authorization', `Bearer ${tokens.direction}`)).status).toBe(200);
      expect(other.slug).toBe('saint-kisito');
    } finally {
      (config as any).platformDomain = before;
    }
  });

  it("seul un jeton d'accès d'école est accepté par l'API des écoles (SEC-012)", async () => {
    const jwt = app.get(JwtService);
    const t = await admin.tenant.findUniqueOrThrow({ where: { slug: 'saint-kisito' } });
    const u = await admin.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${t.id}, true)`;
      return tx.user.findFirstOrThrow({ where: { phone: PHONES.direction }, include: { roles: true } });
    });
    const real: any = jwt.decode(tokens.direction);
    const base = { sub: u.id, tid: t.id, sid: real.sid, name: 'x', roles: u.roles.map((r) => ({ role: r.role, siteId: r.siteId })) };
    const secret = config.jwt.accessSecret;
    const noAudience = jwt.sign(base, { secret, expiresIn: 300 });
    const platform = jwt.sign(base, { secret, audience: 'platform', expiresIn: 300 });
    const challenge = jwt.sign({ ...base, purpose: '2fa' }, { secret, audience: '2fa', expiresIn: 300 });
    const school = jwt.sign(base, { secret, audience: 'school', expiresIn: 300 });
    const get = (tok: string) => http.get('/api/v1/students').set('Authorization', `Bearer ${tok}`);
    expect((await get(noAudience)).status).toBe(401);
    expect((await get(platform)).status).toBe(401);
    expect((await get(challenge)).status).toBe(401);
    expect((await get(school)).status).toBe(200);
  });

  it('les liens de fichiers sont signés avec une clé propre, distincte du bac à sable des paiements (SEC-012)', () => {
    const { derivedKey } = require('../src/config');
    expect(derivedKey('files').equals(derivedKey('sandbox-payments'))).toBe(false);
    expect(derivedKey('files').toString('hex')).not.toContain(Buffer.from(config.jwt.refreshSecret).toString('hex'));
  });
});

describe('Rôles et périmètre (SEC-013 à SEC-018)', () => {
  let T = '';
  let siteA = '';
  let inStudent = '';
  let outStudent = '';
  let outClass = '';
  let outReceipt = '';
  let feeType = '';
  const limited: Record<string, string> = {};
  const inTenant = <X>(fn: (tx: any) => Promise<X>) =>
    admin.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${T}, true)`;
      return fn(tx);
    });
  const asLimited = (who: string) => ({
    get: (url: string) => http.get(`/api/v1${url}`).set('Authorization', `Bearer ${limited[who]}`),
    post: (url: string, body?: object) => http.post(`/api/v1${url}`).set('Authorization', `Bearer ${limited[who]}`).send(body ?? {}),
    patch: (url: string, body?: object) => http.patch(`/api/v1${url}`).set('Authorization', `Bearer ${limited[who]}`).send(body ?? {}),
  });
  const ROLES = [['SECRETARIAT', PHONES.secretariat], ['COMPTABLE', PHONES.comptable]] as const;

  beforeAll(async () => {
    T = (await admin.tenant.findUniqueOrThrow({ where: { slug: 'saint-kisito' } })).id;
    await inTenant(async (tx) => {
      const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
      const enr = await tx.enrollment.findMany({ where: { academicYearId: year.id, status: 'ACTIVE' }, include: { class: true } });
      const sites = [...new Set(enr.map((e: any) => e.class.siteId))] as string[];
      expect(sites.length).toBeGreaterThan(1);
      siteA = sites[0];
      const inn = enr.find((e: any) => e.class.siteId === siteA)!;
      // Élève hors site A qui a un reçu valide, pour tenter de l'annuler.
      const outs = enr.filter((e: any) => e.class.siteId !== siteA);
      const rc = await tx.receipt.findFirst({ where: { cancelledAt: null, payment: { studentId: { in: outs.map((e: any) => e.studentId) } } }, include: { payment: true } });
      const out = rc ? outs.find((e: any) => e.studentId === rc.payment.studentId)! : outs[0];
      inStudent = inn.studentId;
      outStudent = out.studentId;
      outClass = out.classId;
      outReceipt = rc?.id ?? '';
      feeType = (await tx.feeType.findFirstOrThrow({ where: { academicYearId: year.id } })).id;
      for (const [role, phone] of ROLES) {
        const u = await tx.user.findFirstOrThrow({ where: { phone } });
        await tx.userRole.updateMany({ where: { userId: u.id, role }, data: { siteId: siteA } });
        // Le test de blocage après 5 échecs a verrouillé le secrétariat : on le déverrouille pour se reconnecter.
        await tx.user.update({ where: { id: u.id }, data: { failedLogins: 0, lockedUntil: null } });
      }
    });
    for (const [role, phone] of ROLES) limited[role] = await login(phone);
  });

  afterAll(async () => {
    await inTenant(async (tx) => {
      for (const [role, phone] of ROLES) {
        const u = await tx.user.findFirstOrThrow({ where: { phone } });
        await tx.userRole.updateMany({ where: { userId: u.id, role }, data: { siteId: null } });
      }
    });
  });

  it("un secrétariat limité à un site ne modifie, ne retire ni ne déplace un élève d'un autre site (SEC-013)", async () => {
    const s = asLimited('SECRETARIAT');
    expect((await s.patch(`/students/${outStudent}`, { birthPlace: 'Cotonou' })).status).toBe(403);
    expect((await s.post(`/students/${outStudent}/guardians`, { firstName: 'P', lastName: 'X', phone: '0197999990', relation: 'Oncle' })).status).toBe(403);
    expect((await s.post(`/students/${outStudent}/class`, { classId: outClass })).status).toBe(403);
    expect((await s.post(`/students/${outStudent}/withdraw`, { status: 'WITHDRAWN', reason: 'test' })).status).toBe(403);
    expect((await s.post(`/students/${inStudent}/class`, { classId: outClass })).status).toBe(403);
    expect((await s.post('/documents', { kind: 'CERTIFICAT_SCOLARITE', studentId: outStudent })).status).toBe(403);
    expect((await s.post('/documents/batch', { kind: 'CARTE_SCOLAIRE', classId: outClass })).status).toBe(403);
    expect((await s.post('/announcements', { title: 't', body: 't', audience: 'CLASS', classId: outClass })).status).toBe(403);
    // Son propre site reste modifiable.
    expect((await s.patch(`/students/${inStudent}`, { birthPlace: 'Cotonou' })).status).toBe(200);
    const st: any = await inTenant((tx) => tx.student.findUniqueOrThrow({ where: { id: outStudent } }));
    expect(st.status).toBe('ACTIVE');
  });

  it("un comptable limité à un site ne voit ni ne touche les paiements d'un autre site (SEC-013)", async () => {
    const c = asLimited('COMPTABLE');
    const pay = await c.get('/finance/payments');
    expect(pay.status).toBe(200);
    expect(JSON.stringify(pay.body)).not.toContain(outStudent);
    const unpaid = await c.get('/finance/unpaid');
    expect(unpaid.status).toBe(200);
    expect(unpaid.body.every((r: any) => r.student.id !== outStudent)).toBe(true);
    expect((await c.post('/finance/invoices', { studentId: outStudent, label: 'test', dueDate: '2026-12-01', items: [{ label: 'x', amount: 1, feeTypeId: feeType }] })).status).toBe(403);
    if (outReceipt) {
      expect((await c.post(`/finance/receipts/${outReceipt}/cancel`, { reason: 'test' })).status).toBe(403);
      const r: any = await inTenant((tx) => tx.receipt.findUniqueOrThrow({ where: { id: outReceipt } }));
      expect(r.cancelledAt).toBeNull();
    }
    // Sans limite de site, le comptable voit toujours toute l'école.
    const all = await as('comptable').get('/finance/payments');
    expect(all.body.length).toBeGreaterThanOrEqual(pay.body.length);
  });

  it("les allergies ne sont visibles ni du comptable ni de l'élève (SEC-014)", async () => {
    const me = await as('student').get('/students');
    const own = await as('student').get(`/students/${me.body[0].id}`);
    expect(own.status).toBe(200);
    expect(own.body).not.toHaveProperty('allergies');
    expect((await as('comptable').get(`/students/${me.body[0].id}`)).body).not.toHaveProperty('allergies');
    expect((await as('vieScolaire').get(`/students/${me.body[0].id}`)).body).toHaveProperty('allergies');
  });

  it('la direction lit les paiements, les impayés et les clôtures sans pouvoir encaisser (SEC-016)', async () => {
    for (const url of ['/finance/payments', '/finance/payments/export.csv', '/finance/unpaid', '/finance/cash-closings']) {
      expect((await as('direction').get(url)).status).toBe(200);
      expect((await as('secretariat').get(url)).status).toBe(403);
    }
    expect((await as('direction').post('/finance/cash-closings', { counted: 0 })).status).toBe(403);
    expect((await as('direction').post('/finance/payments/desk', { invoiceId: '00000000-0000-4000-8000-000000000000', amount: 1, method: 'CASH' })).status).toBe(403);
  });

  it('la signature et le cachet ne sont envoyés qu’à la direction (SEC-017)', async () => {
    for (const who of ['parent', 'teacher', 'student', 'comptable']) {
      const r = await as(who).get('/settings');
      expect(r.status).toBe(200);
      expect(r.body.tenant.identity.signatureUrl).toBeNull();
      expect(r.body.tenant.identity.stampUrl).toBeNull();
      expect(r.body.tenant.settings.identity.signatureKey).toBeNull();
      expect(r.body.tenant.settings.identity.stampKey).toBeNull();
    }
    const d = await as('direction').get('/settings');
    expect(d.body.tenant.identity).toHaveProperty('signatureUrl');
  });

  it("l'enseignant ne voit que les sanctions qu'il a proposées (SEC-018)", async () => {
    const me = await as('teacher').get('/auth/me');
    const pupils = await as('teacher').get('/students');
    const other = await as('vieScolaire').post('/sanctions', { studentId: pupils.body[0].id, kind: 'Avertissement', reason: 'Saisie de la vie scolaire (test)', date: '2026-11-06' });
    expect(other.status).toBe(201);
    const mine = await as('teacher').get('/sanctions');
    expect(mine.body.some((x: any) => x.id === other.body.id)).toBe(false);
    expect(mine.status).toBe(200);
    expect(mine.body.every((x: any) => x.proposedById === me.body.user.id)).toBe(true);
    const all = await as('vieScolaire').get('/sanctions');
    expect(all.body.some((x: any) => x.proposedById !== me.body.user.id)).toBe(true);
  });
});

describe('Authentification renforcée (SEC-019 à SEC-025)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { authenticator } = require('otplib');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const argon2 = require('argon2');
  const phone = '+2290190009019';
  let tid: string;
  let userId: string;
  let secret: string;

  const signIn = () => http.post('/api/v1/auth/login').send({ tenant: 'saint-kisito', identifier: phone, password: PASSWORD });
  const inTenant = (fn: (tx: any) => Promise<any>): Promise<any> => admin.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tid}, true)`;
    return fn(tx);
  });

  beforeAll(async () => {
    tid = (await admin.tenant.findUniqueOrThrow({ where: { slug: 'saint-kisito' } })).id;
    userId = await inTenant(async (tx) => {
      await tx.user.deleteMany({ where: { phone } });
      const u = await tx.user.create({
        data: { tenantId: tid, firstName: 'Fictif', lastName: 'Deuxfacteurs', phone, passwordHash: await argon2.hash(PASSWORD), mustChangePassword: false, roles: { create: [{ tenantId: tid, role: 'COMPTABLE' }] } },
      });
      return u.id;
    });
  });

  it("SEC-019 : configurer la 2FA ne change rien au compte tant qu'un code n'a pas été validé, et la reconfigurer exige le code actuel", async () => {
    const t = (await signIn()).body.accessToken;
    const auth = (r: any) => r.set('Authorization', `Bearer ${t}`);
    const setup = await auth(http.post('/api/v1/auth/2fa/setup')).send({});
    expect(setup.status).toBe(200);
    expect(setup.body.setupToken).toBeTruthy();
    expect((await inTenant((tx) => tx.user.findUniqueOrThrow({ where: { id: userId } }))).totpSecret).toBeNull();
    // Sans le jeton de configuration, ou avec un faux code, rien n'est activé.
    expect((await auth(http.post('/api/v1/auth/2fa/enable')).send({ code: authenticator.generate(setup.body.secret) })).status).toBe(400);
    expect((await auth(http.post('/api/v1/auth/2fa/enable')).send({ code: '000000', setupToken: setup.body.setupToken })).status).toBe(400);
    expect((await auth(http.post('/api/v1/auth/2fa/enable')).send({ code: authenticator.generate(setup.body.secret), setupToken: setup.body.setupToken })).status).toBe(200);
    secret = setup.body.secret;
    // Déjà active : sans code ou avec un faux code, refus, et la connexion demande toujours le code.
    expect((await auth(http.post('/api/v1/auth/2fa/setup')).send({})).status).toBe(403);
    expect((await auth(http.post('/api/v1/auth/2fa/setup')).send({ code: '000000' })).status).toBe(403);
    const again = await signIn();
    expect(again.body.twoFactorRequired).toBe(true);
    expect(again.body.accessToken).toBeUndefined();
    await inTenant((tx) => tx.user.update({ where: { id: userId }, data: { failedLogins: 0 } }));
  });

  it('SEC-022 : un code déjà utilisé est refusé, et 5 codes faux bloquent le compte', async () => {
    // Le code de l'activation vient de servir : le rejouer est refusé.
    const c1 = (await signIn()).body.challenge;
    expect((await http.post('/api/v1/auth/2fa/verify').send({ challenge: c1, code: authenticator.generate(secret) })).status).toBe(401);
    // Comme si 30 secondes étaient passées : un nouveau code est accepté, une seule fois.
    await inTenant((tx) => tx.user.update({ where: { id: userId }, data: { totpLastStep: null, failedLogins: 0 } }));
    const ok = await http.post('/api/v1/auth/2fa/verify').send({ challenge: c1, code: authenticator.generate(secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();
    const c2 = (await signIn()).body.challenge;
    expect((await http.post('/api/v1/auth/2fa/verify').send({ challenge: c2, code: authenticator.generate(secret) })).status).toBe(401);
    // 5 codes faux : compte bloqué, même le bon code et le bon mot de passe ne passent plus.
    await inTenant((tx) => tx.user.update({ where: { id: userId }, data: { totpLastStep: null, failedLogins: 0 } }));
    for (let i = 0; i < 4; i++) await http.post('/api/v1/auth/2fa/verify').send({ challenge: c2, code: '000000' });
    expect((await http.post('/api/v1/auth/2fa/verify').send({ challenge: c2, code: '000001' })).status).toBe(401);
    const u = await inTenant((tx) => tx.user.findUniqueOrThrow({ where: { id: userId } }));
    expect(u.lockedUntil && u.lockedUntil > new Date()).toBe(true);
    expect((await http.post('/api/v1/auth/2fa/verify').send({ challenge: c2, code: authenticator.generate(secret) })).status).toBe(401);
    expect((await signIn()).status).toBe(401);
    await inTenant((tx) => tx.user.update({ where: { id: userId }, data: { lockedUntil: null, failedLogins: 0, totpEnabled: false, totpSecret: null, totpLastStep: null } }));
  });

  it('SEC-023 : les mots de passe provisoires sont longs et aléatoires', async () => {
    const { temporaryPassword } = await import('../src/modules/settings/settings.service');
    const all = new Set(Array.from({ length: 200 }, () => temporaryPassword()));
    expect(all.size).toBe(200);
    for (const pw of all) expect(pw).toMatch(/^(?=.*[a-zA-Z])(?=.*\d)[A-HJ-NP-Za-km-z2-9]{10}$/);
  });

  it('SEC-025 : la déconnexion ne coupe pas une session avec un faux jeton', async () => {
    const l = await signIn();
    const cookie = (l.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('erp_rt='))!.split(';')[0];
    const [tenantPart, sessionPart] = cookie.slice('erp_rt='.length).split('.');
    await http.post('/api/v1/auth/logout').set('Cookie', `erp_rt=${tenantPart}.${sessionPart}.faux`).expect(204);
    expect((await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${l.body.accessToken}`)).status).toBe(200);
    await http.post('/api/v1/auth/logout').set('Cookie', cookie).expect(204);
    expect((await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${l.body.accessToken}`)).status).toBe(401);
  });

  it('SEC-021 : Super Admin, la déconnexion coupe la session et la double authentification est demandée une fois activée', async () => {
    const email = 'sec021@exemple.test';
    const pw = 'MotDePasseFictif2026';
    await admin.platformAdmin.deleteMany({ where: { email } });
    await admin.platformAdmin.create({ data: { email, name: 'Super Admin fictif', passwordHash: await argon2.hash(pw), mustChangePassword: false } });
    const pcookie = (r: any) => (r.headers['set-cookie'] as unknown as string[]).find((c: string) => c.startsWith('erp_pt='))!.split(';')[0];
    const l = await http.post('/api/v1/platform/auth/login').send({ email, password: pw });
    expect(l.status).toBe(201);
    const c = pcookie(l);
    await http.post('/api/v1/platform/auth/logout').set('Cookie', c).expect(201);
    expect((await http.get('/api/v1/platform/me').set('Cookie', c)).status).toBe(401);
    // Activation de la 2FA, puis connexion en deux temps.
    const c2 = pcookie(await http.post('/api/v1/platform/auth/login').send({ email, password: pw }));
    const setup = await http.post('/api/v1/platform/auth/2fa/setup').set('Cookie', c2).send({});
    expect(setup.status).toBe(201);
    await http.post('/api/v1/platform/auth/2fa/enable').set('Cookie', c2).send({ code: authenticator.generate(setup.body.secret), setupToken: setup.body.setupToken }).expect(201);
    expect((await http.post('/api/v1/platform/auth/2fa/setup').set('Cookie', c2).send({})).status).toBe(403);
    const step1 = await http.post('/api/v1/platform/auth/login').send({ email, password: pw });
    expect(step1.body.twoFactorRequired).toBe(true);
    expect((step1.headers['set-cookie'] as unknown as string[] | undefined)?.some((x) => x.startsWith('erp_pt=') && !x.startsWith('erp_pt=;'))).toBeFalsy();
    // Code de l'activation rejoué : refusé ; nouveau code : accepté.
    expect((await http.post('/api/v1/platform/auth/2fa/verify').send({ challenge: step1.body.challenge, code: authenticator.generate(setup.body.secret) })).status).toBe(401);
    await admin.platformAdmin.update({ where: { email }, data: { totpLastStep: null, failedLogins: 0 } });
    const step2 = await http.post('/api/v1/platform/auth/2fa/verify').send({ challenge: step1.body.challenge, code: authenticator.generate(setup.body.secret) });
    expect(step2.status).toBe(201);
    expect((await http.get('/api/v1/platform/me').set('Cookie', pcookie(step2))).body.totpEnabled).toBe(true);
    await admin.platformAdmin.deleteMany({ where: { email } });
  });

  it('SEC-023 : Super Admin avec mot de passe provisoire, seules les routes du compte répondent', async () => {
    const email = 'sec023@exemple.test';
    await admin.platformAdmin.deleteMany({ where: { email } });
    await admin.platformAdmin.create({ data: { email, name: 'Provisoire fictif', passwordHash: await argon2.hash('Provisoire2026x') } });
    const l = await http.post('/api/v1/platform/auth/login').send({ email, password: 'Provisoire2026x' });
    const c = (l.headers['set-cookie'] as unknown as string[]).find((x) => x.startsWith('erp_pt='))!.split(';')[0];
    expect((await http.get('/api/v1/platform/tenants').set('Cookie', c)).status).toBe(403);
    expect((await http.get('/api/v1/platform/me').set('Cookie', c)).status).toBe(200);
    await admin.platformAdmin.deleteMany({ where: { email } });
  });
});

describe('Fichiers : contenu, métadonnées, effacement, antivirus (SEC-026 à SEC-030)', () => {
  // Photo fictive 64 x 64 portant une position GPS et le nom d'appareil « TelephoneFictif ».
  const GPS_JPG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/4QCkRXhpZgAATU0AKgAAAAgAAgEPAAIAAAAQAAAAJoglAAQAAAABAAAANgAAAABUZWxlcGhvbmVGaWN0aWYAAAQAAQACAAAAAk4AAAAAAgAFAAAAAwAAAGwAAwACAAAAAkUAAAAABAAFAAAAAwAAAIQAAAAAAAAABgAAAAEAAAAVAAAAAQAAAB4AAAABAAAAAgAAAAEAAAATAAAAAQAAAA8AAAAB/9sAQwAIBgYHBgUIBwcHCQkICgwUDQwLCwwZEhMPFB0aHx4dGhwcICQuJyAiLCMcHCg3KSwwMTQ0NB8nOT04MjwuMzQy/9sAQwEJCQkMCwwYDQ0YMiEcITIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy/8AAEQgAQABAAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/aAAwDAQACEQMRAD8A5CiiivFP0wKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooA//2Q==', 'base64');
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const PLAIN_PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsx = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathx = require('path') as typeof import('path');
  let tid: string;
  const count = (folder: string): number => {
    const dir = pathx.join(process.env.STORAGE_DIR!, tid, folder);
    try { return fsx.readdirSync(dir).length; } catch { return 0; }
  };
  const bytes = (r: any) => r.buffer(true).parse((res: any, cb: any) => { const c: Buffer[] = []; res.on('data', (x: Buffer) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); });

  beforeAll(async () => {
    tid = (await admin.tenant.findUniqueOrThrow({ where: { slug: 'saint-kisito' } })).id;
  });

  it('SEC-027 : une photo publique est servie sans sa position GPS ni le nom de l’appareil', async () => {
    const site = (await http.get('/api/v1/public/saint-kisito')).body.sites[0];
    await http.post(`/api/v1/sites/${site.id}/photo`).set('Authorization', `Bearer ${tokens.direction}`).attach('file', GPS_JPG, { filename: 's.jpg', contentType: 'image/jpeg' }).expect(201);
    const pub = await bytes(http.get(`/api/v1/public/saint-kisito/sites/${site.id}/photo`));
    expect(pub.status).toBe(200);
    const body: Buffer = pub.body;
    expect(body.subarray(0, 3).toString('hex')).toBe('ffd8ff');
    expect(body.includes(Buffer.from('Exif'))).toBe(false);
    expect(body.includes(Buffer.from('TelephoneFictif'))).toBe(false);
  });

  it('SEC-028 : une photo remplacée ou retirée et une pièce supprimée sont effacées du disque', async () => {
    const site = (await http.get('/api/v1/public/saint-kisito')).body.sites[0];
    // Le site a déjà une photo (test précédent) : chaque remplacement efface la précédente.
    const s0 = count('sites');
    for (let i = 0; i < 3; i++) await http.post(`/api/v1/sites/${site.id}/photo`).set('Authorization', `Bearer ${tokens.direction}`).attach('file', PNG, { filename: 's.png', contentType: 'image/png' }).expect(201);
    expect(count('sites')).toBe(s0);
    await as('direction').del(`/sites/${site.id}/photo`).expect(200);
    expect(count('sites')).toBe(s0 - 1);
    // Site inconnu : refus, et aucun fichier laissé.
    expect((await http.post('/api/v1/sites/00000000-0000-4000-8000-000000000000/photo').set('Authorization', `Bearer ${tokens.direction}`).attach('file', PNG, { filename: 's.png', contentType: 'image/png' })).status).toBe(404);
    expect(count('sites')).toBe(s0 - 1);
    const st = (await as('direction').get('/students')).body[0];
    const before = count('eleves/pieces');
    const piece = await http.post(`/api/v1/students/${st.id}/files`).set('Authorization', `Bearer ${tokens.direction}`).field('label', 'Pièce fictive').attach('file', PLAIN_PDF, { filename: 'p.pdf', contentType: 'application/pdf' });
    expect(piece.status).toBe(201);
    expect(count('eleves/pieces')).toBe(before + 1);
    const dl = await http.get(piece.body.url);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toBe('inline; filename="document.pdf"');
    await as('direction').del(`/students/${st.id}/files/${piece.body.id}`).expect(200);
    expect(count('eleves/pieces')).toBe(before);
    expect((await http.get(piece.body.url)).status).toBe(404);
  });

  it('SEC-029 : un justificatif renvoyé plusieurs fois ne laisse que le dernier fichier', async () => {
    const all = (await as('direction').get('/students')).body;
    const koffi = all.find((s: any) => s.firstName === 'Koffi');
    const cls = koffi.class.id;
    const sheet = await as('teacher').get(`/attendance/sheet?classId=${cls}&date=2026-10-21&startMinute=480`);
    const cs = (await as('teacher').get('/evaluation/class-subjects')).body.classSubjects.find((c: any) => c.class.id === cls && c.subject.code === 'ELEC');
    await as('teacher').post('/attendance', { classId: cls, classSubjectId: cs.id, date: '2026-10-21', startMinute: 480, records: sheet.body.students.map((s: any) => ({ studentId: s.id, status: s.id === koffi.id ? 'ABSENT' : 'PRESENT' })) }).expect(201);
    const rec = (await as('parent').get(`/attendance/absences?studentId=${koffi.id}`)).body.find((a: any) => a.status === 'ABSENT' && a.justification !== 'ACCEPTED');
    const before = count('justificatifs');
    for (let i = 0; i < 5; i++) {
      await http.post(`/api/v1/attendance/records/${rec.id}/justify`).set('Authorization', `Bearer ${tokens.parent}`).field('reason', 'Motif fictif').attach('file', PNG, { filename: 'c.png', contentType: 'image/png' }).expect(201);
    }
    expect(count('justificatifs')).toBe(before + 1);
  });

  it('SEC-026 et SEC-030 : faux JPEG, PDF avec JavaScript (même écrit en hexadécimal) refusés ; PDF ordinaire accepté', async () => {
    const st = (await as('direction').get('/students')).body[0];
    const add = (buf: Buffer, type: string) => http.post(`/api/v1/students/${st.id}/files`).set('Authorization', `Bearer ${tokens.direction}`).field('label', 'Test fictif').attach('file', buf, { filename: 'f', contentType: type });
    const before = count('eleves/pieces');
    expect((await add(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('<html><script>alert(1)</script></html>')]), 'image/jpeg')).status).toBe(400);
    expect((await add(Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/OpenAction<</S/JavaScript/JS(app.alert(1))>>>>endobj\n%%EOF'), 'application/pdf')).status).toBe(400);
    expect((await add(Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/OpenAction<</S/J#61vaScript/J#53(x)>>>>endobj\n%%EOF'), 'application/pdf')).status).toBe(400);
    expect((await add(Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Names<</EmbeddedFiles 2 0 R>>>>endobj\n%%EOF'), 'application/pdf')).status).toBe(400);
    expect(count('eleves/pieces')).toBe(before);
    const ok = await add(PLAIN_PDF, 'application/pdf');
    expect(ok.status).toBe(201);
    await as('direction').del(`/students/${st.id}/files/${ok.body.id}`).expect(200);
  });

  it("SEC-026 : avec l'antivirus, un fichier infecté est refusé et un antivirus injoignable bloque l'envoi", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const net = require('net') as typeof import('net');
    const { AntivirusService } = await import('../src/modules/files/antivirus.service');
    const { FilesService } = await import('../src/modules/files/files.service');
    // Faux service clamd : répond comme ClamAV selon le contenu reçu.
    const server = net.createServer((sock) => {
      const chunks: Buffer[] = [];
      sock.on('data', (d) => {
        chunks.push(d);
        const all = Buffer.concat(chunks);
        if (all.subarray(-4).equals(Buffer.alloc(4))) sock.end(all.includes(Buffer.from('EICAR')) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as import('net').AddressInfo).port;
    const saved = { host: process.env.CLAMAV_HOST, port: process.env.CLAMAV_PORT };
    try {
      process.env.CLAMAV_HOST = '127.0.0.1';
      process.env.CLAMAV_PORT = String(port);
      const files = new FilesService(new AntivirusService());
      const eicar = Buffer.from('%PDF-1.4\nX5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*\n%%EOF');
      await expect(files.save(tid, 'test-antivirus', { buffer: eicar, mimetype: 'application/pdf', size: eicar.length })).rejects.toThrow(/antivirus/);
      const key = await files.save(tid, 'test-antivirus', { buffer: PLAIN_PDF, mimetype: 'application/pdf', size: PLAIN_PDF.length });
      expect(key).toMatch(/\.pdf$/);
      await files.remove(key);
      process.env.CLAMAV_PORT = '1';
      const down = new FilesService(new AntivirusService());
      await expect(down.save(tid, 'test-antivirus', { buffer: PLAIN_PDF, mimetype: 'application/pdf', size: PLAIN_PDF.length })).rejects.toThrow(/indisponible/);
      expect(count('test-antivirus')).toBe(0);
    } finally {
      if (saved.host === undefined) delete process.env.CLAMAV_HOST; else process.env.CLAMAV_HOST = saved.host;
      if (saved.port === undefined) delete process.env.CLAMAV_PORT; else process.env.CLAMAV_PORT = saved.port;
      server.close();
    }
  });
});

describe("Sécurité v1.1, étape 5 : journal d'audit (SEC-031 à SEC-034, SEC-037)", () => {
  const inTenant = (fn: (tx: any) => Promise<any>): Promise<any> => admin.$transaction(async (tx) => {
    const t = await tx.tenant.findUniqueOrThrow({ where: { slug: 'saint-kisito' } });
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${t.id}, true)`;
    return fn(tx);
  });
  const since = new Date();
  const rows = (action: string): Promise<any[]> => inTenant((tx) => tx.auditLog.findMany({ where: { action, createdAt: { gte: since } }, orderBy: { createdAt: 'asc' } }));
  const loginFrom = (identifier: string, password = PASSWORD) =>
    http.post('/api/v1/auth/login').set('X-Forwarded-For', '203.0.113.7').send({ tenant: 'saint-kisito', identifier, password });

  it('SEC-031 : connexion, échec et identifiant inconnu portent le compte concerné et son adresse IP', async () => {
    await loginFrom(PHONES.direction).expect(200);
    await loginFrom(PHONES.comptable, 'mauvais-mot-de-passe').expect(401);
    await loginFrom('+2290199999999', 'mauvais-mot-de-passe').expect(401);
    const direction = await inTenant((tx) => tx.user.findFirstOrThrow({ where: { phone: PHONES.direction } }));
    const ok = (await rows('auth.login')).pop();
    expect(ok).toMatchObject({ userId: direction.id, userName: 'Bernard DOSSA', ip: '203.0.113.7' });
    expect((await rows('auth.failed')).pop()).toMatchObject({ userName: 'Lucie AGBANGLA', ip: '203.0.113.7' });
    const unknown = (await rows('auth.unknown_identifier')).pop();
    expect(unknown.data.identifier).toBe('+229019•••99');
    expect(JSON.stringify(unknown)).not.toContain('mauvais');
    // Le filtre par personne retrouve ses connexions.
    const mine = await as('direction').get(`/audit?userId=${direction.id}&action=auth.login`).expect(200);
    expect(mine.body.length).toBeGreaterThan(0);
  });

  it('SEC-032 : appréciation, absent/dispensé, séance modifiée, session fermée et déconnexion sont tracés', async () => {
    const mine = (await as('teacher').get('/evaluation/class-subjects')).body;
    const elec = mine.classSubjects.find((c: any) => c.subject.code === 'ELEC');
    const term = mine.terms[mine.terms.length - 1]; // le 1er trimestre est verrouillé par un test précédent
    const book = (await as('teacher').get(`/evaluation/gradebook?classSubjectId=${elec.id}&termId=${term.id}`)).body;
    const koffi = book.students.find((s: any) => s.firstName === 'Koffi');
    const created = await as('teacher').post('/evaluation/assessments', { classSubjectId: elec.id, termId: term.id, title: 'Devoir journal', kind: 'DEVOIR', weight: 1, date: String(term.startDate).slice(0, 10) });
    expect([created.status, created.body.message]).toEqual([201, undefined]);
    const a = created.body;
    await as('teacher').put(`/evaluation/assessments/${a.id}/grades`, { grades: [{ studentId: koffi.id, score: null }] }).expect(200);
    await as('teacher').put(`/evaluation/assessments/${a.id}/grades`, { grades: [{ studentId: koffi.id, score: null, absent: true }] }).expect(200);
    const g = (await rows('grades.saved')).filter((r) => r.entityId === a.id).pop();
    expect(g.data.modified[0]).toMatchObject({ studentId: koffi.id, absent: { avant: false, après: true } });

    const ap = { studentId: koffi.id, classSubjectId: elec.id, termId: term.id };
    await as('teacher').put('/evaluation/appreciations', { ...ap, text: 'Bon trimestre (fictif)' }).expect(200);
    await as('teacher').put('/evaluation/appreciations', { ...ap, text: 'Peut mieux faire (fictif)' }).expect(200);
    const apps = (await rows('appreciation.saved')).slice(-2);
    expect(apps[1].data).toMatchObject({ avant: 'Bon trimestre (fictif)', après: 'Peut mieux faire (fictif)' });

    const lesson = await as('teacher').post('/lessons', { classSubjectId: elec.id, date: '2026-10-16', title: 'Séance journal', content: 'Avant' });
    expect(lesson.status).toBe(201);
    await as('teacher').patch(`/lessons/${lesson.body.id}`, { content: 'Après' }).expect(200);
    expect((await rows('lesson.updated')).pop().data).toMatchObject({ content: { avant: 'Avant', après: 'Après' } });

    const l2 = await http.post('/api/v1/auth/login').send({ tenant: 'saint-kisito', identifier: PHONES.secretariat, password: PASSWORD }).expect(200);
    const cookie = (l2.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
    const sessions = (await as('secretariat').get('/auth/sessions')).body as any[];
    const other = sessions.find((s) => s.id === decodeURIComponent(cookie.split('=')[1]).split('.')[1])!;
    await as('secretariat').del(`/auth/sessions/${other.id}`).expect(200);
    expect((await rows('auth.session_revoked')).pop()).toMatchObject({ entityId: other.id, userName: 'Mireille ADJOVI' });
    const logouts = (await rows('auth.logout')).length;
    await http.post('/api/v1/auth/logout').set('Cookie', cookie).expect(204);
    expect((await rows('auth.logout')).length).toBe(logouts); // session déjà fermée : rien à tracer
    const l3 = await http.post('/api/v1/auth/login').send({ tenant: 'saint-kisito', identifier: PHONES.secretariat, password: PASSWORD }).expect(200);
    await http.post('/api/v1/auth/logout').set('Cookie', (l3.headers['set-cookie'] as unknown as string[])[0].split(';')[0]).expect(204);
    expect((await rows('auth.logout')).pop()).toMatchObject({ userName: 'Mireille ADJOVI' });
  });

  it("SEC-033 et SEC-037 : l'ancienne valeur est gardée, sans allergies ni téléphone en clair", async () => {
    const created = await as('direction').post('/staff', { firstName: 'Agent', lastName: 'JOURNAL', phone: '+2290190008801', roles: [{ role: 'SECRETARIAT' }] }).expect(201);
    const id = created.body.id ?? created.body.user?.id ?? (await inTenant((tx) => tx.user.findFirstOrThrow({ where: { phone: '+2290190008801' } }))).id;
    await as('direction').patch(`/staff/${id}`, { roles: [{ role: 'COMPTABLE' }], phone: '+2290190008802' }).expect(200);
    const changed = (await rows('user.roles_changed')).pop();
    expect(changed.data.roles).toEqual({ avant: ['SECRETARIAT'], après: ['COMPTABLE'] });
    expect(changed.data.phone).toEqual({ avant: '+229019•••01', après: '+229019•••02' });

    const fee = await inTenant((tx) => tx.feeType.findFirstOrThrow({ where: { active: true } }));
    await as('direction').patch(`/finance/fee-types/${fee.id}`, { name: fee.name, amount: fee.amount + 500 }).expect(200);
    expect((await rows('fee_type.updated')).pop().data.amount).toEqual({ avant: fee.amount, après: fee.amount + 500 });
    await as('direction').patch(`/finance/fee-types/${fee.id}`, { name: fee.name, amount: fee.amount }).expect(200);

    const st = (await as('direction').get('/students')).body[0];
    await as('direction').patch(`/students/${st.id}`, { allergies: 'Arachide (fictif)', birthPlace: 'Cotonou (fictif)' }).expect(200);
    const upd = (await rows('student.updated')).pop();
    expect(upd.data.allergies).toBe('modifié');
    expect(upd.data.birthPlace).toMatchObject({ après: 'Cotonou (fictif)' });
    expect(JSON.stringify(upd.data)).not.toContain('Arachide');
  });

  it("SEC-034 : un accès refusé est tracé une seule fois par fenêtre de 10 minutes", async () => {
    const before = (await rows('access.denied')).length;
    for (let i = 0; i < 3; i++) await as('teacher').get('/audit').expect(403);
    const after = await rows('access.denied');
    expect(after.length - before).toBe(1);
    expect(after.pop()).toMatchObject({ userName: 'Codjo ZINSOU', data: { route: 'GET /api/v1/audit', role: 'ENSEIGNANT' } });
  });
});

describe("Sécurité v1.1, étape 5 : page du journal et journal Super Admin (SEC-035, SEC-036)", () => {
  const inTenant = (fn: (tx: any) => Promise<any>): Promise<any> => admin.$transaction(async (tx) => {
    const t = await tx.tenant.findUniqueOrThrow({ where: { slug: 'saint-kisito' } });
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${t.id}, true)`;
    return fn(tx);
  });

  it('SEC-035 : toutes les lignes se lisent page par page, avec un libellé en français', async () => {
    const total = await inTenant((tx) => tx.auditLog.count());
    const seen = new Set<string>();
    let before: string | undefined;
    for (;;) {
      const r = await as('direction').get(`/audit?limit=500${before ? `&before=${before}` : ''}`).expect(200);
      for (const row of r.body) seen.add(row.id);
      if (r.body.length < 500) break;
      before = r.body.at(-1).id;
    }
    expect(seen.size).toBe(total);
    const first = (await as('direction').get('/audit?action=auth.login&limit=1')).body[0];
    expect(first.label).toBe('Connexion');
    expect((await as('direction').get('/audit?before=pas-un-id')).status).toBe(400);
  });

  it("SEC-035 : l'export CSV contient les lignes filtrées, neutralise les formules et est lui-même tracé", async () => {
    const st = (await as('direction').get('/students')).body[0];
    await as('direction').patch(`/students/${st.id}`, { birthPlace: '=HYPERLINK("http://exemple.invalid")' }).expect(200);
    const r = await as('direction').get('/audit/export.csv?action=student.updated').expect(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.text.split('\r\n')[0]).toContain('date;utilisateur;action;libelle');
    expect(r.text).toContain('Fiche élève modifiée');
    expect(r.text).not.toMatch(/;"=HYPERLINK/);
    expect(r.text).not.toContain('auth.login');
    const exp = await inTenant((tx) => tx.auditLog.findFirst({ where: { action: 'audit.exported' }, orderBy: { createdAt: 'desc' } }));
    expect(exp).toMatchObject({ userName: 'Bernard DOSSA' });
    expect((await as('teacher').get('/audit/export.csv')).status).toBe(403);
  });

  it("SEC-036 : le journal Super Admin garde l'adresse IP et le nom de l'administrateur", async () => {
    const email = 'journal-plateforme@test.local';
    execSync(`npx ts-node --transpile-only prisma/platform-admin.ts ${email} "Admin Journal" --operateur "Tests automatiques" --motif "Remise à zéro du compte de test"`, { env: process.env, cwd: `${__dirname}/..`, stdio: 'ignore' });
    const argon2 = await import('argon2');
    await admin.platformAdmin.update({ where: { email }, data: { passwordHash: await argon2.hash('Plateforme-Journal-2026'), mustChangePassword: false, mustSetupTwoFactor: false } });
    await http.post('/api/v1/platform/auth/login').set('X-Forwarded-For', '198.51.100.9').send({ email, password: 'mauvais' }).expect(401);
    await http.post('/api/v1/platform/auth/login').set('X-Forwarded-For', '198.51.100.9').send({ email: 'inconnu@test.local', password: 'mauvais' }).expect(401);
    const r = await http.post('/api/v1/platform/auth/login').set('X-Forwarded-For', '198.51.100.9').send({ email, password: 'Plateforme-Journal-2026' }).expect(201);
    const cookie = (r.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('erp_pt='))!.split(';')[0];
    const audit = (await http.get('/api/v1/platform/audit').set('Cookie', cookie).expect(200)).body as any[];
    expect(audit.find((a) => a.action === 'platform.auth.login')).toMatchObject({ adminName: 'Admin Journal', ip: '198.51.100.9' });
    expect(audit.find((a) => a.action === 'platform.auth.failed')).toMatchObject({ adminName: 'Admin Journal', ip: '198.51.100.9' });
    const unknown = audit.find((a) => a.action === 'platform.auth.unknown_identifier');
    expect(unknown).toMatchObject({ ip: '198.51.100.9', data: { identifier: 'in•••@test.local' } });
  });
});

describe("Sécurité v1.1, étape 6 : le jeu de démonstration n'efface jamais une vraie école (SEC-038)", () => {
  const seed = (env: Record<string, string> = {}) => {
    try {
      execSync('npx ts-node --transpile-only prisma/seed.ts', { env: { ...process.env, ...env }, stdio: 'pipe', cwd: `${__dirname}/..` });
      return { code: 0, err: '' };
    } catch (e: any) {
      return { code: e.status as number, err: String(e.stderr ?? '') };
    }
  };
  const snapshot = async (tenantId: string) =>
    admin.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      const [students, audit, receipts, grades] = await Promise.all([tx.student.count(), tx.auditLog.count(), tx.receipt.count(), tx.grade.count()]);
      return { students, audit, receipts, grades };
    });

  it("refuse d'effacer une école sans la marque « démonstration », même avec ALLOW_DEMO_RESET=1", async () => {
    const t = await admin.tenant.findUniqueOrThrow({ where: { slug: 'saint-kisito' } });
    const before = await snapshot(t.id);
    expect(before.students).toBeGreaterThan(0);
    await admin.tenant.update({ where: { id: t.id }, data: { settings: { ...(t.settings as object), demo: false } } });
    try {
      const r = seed({ ALLOW_DEMO_RESET: '1' });
      expect(r.code).toBe(2);
      expect(r.err).toContain("n'est pas une école de démonstration");
      expect(await snapshot(t.id)).toEqual(before);
      expect((await admin.tenant.findUniqueOrThrow({ where: { id: t.id } })).settings).toMatchObject({ demo: false });
    } finally {
      await admin.tenant.update({ where: { id: t.id }, data: { settings: t.settings as object } });
    }
  }, 120000);

  it('refuse de tourner sur un serveur de production (PRODUCTION_SERVER=true) sans autorisation écrite', async () => {
    const t = await admin.tenant.findUniqueOrThrow({ where: { slug: 'saint-kisito' } });
    const before = await snapshot(t.id);
    const r = seed({ PRODUCTION_SERVER: 'true' });
    expect(r.code).toBe(2);
    expect(r.err).toContain('Serveur de production');
    expect(await snapshot(t.id)).toEqual(before);
  }, 120000);
});

/** Requêtes du propriétaire dans l'espace d'une école (FORCE RLS : même le propriétaire doit choisir l'école). */
async function inTenant<T>(slug: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const t = await admin.tenant.findUniqueOrThrow({ where: { slug } });
  return admin.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${t.id}, true)`;
    return fn(tx);
  });
}

describe('Sécurité v1.1, étape 6 : parties exposées sans test (SEC-040)', () => {
  const application = (over: object = {}) => ({
    studentFirstName: 'Afi', studentLastName: 'Test', wantedLevel: '6e', guardianName: 'Parent Test', guardianPhone: '+2290196000099', ...over,
  });

  it("pré-inscription publique : école inconnue refusée, champs contrôlés, secrétariat prévenu, SMS envoyé au parent", async () => {
    expect((await http.post('/api/v1/public/ecole-inexistante/applications').send(application())).status).toBe(404);
    expect((await http.post('/api/v1/public/saint-kisito/applications').send(application({ guardianPhone: '12' }))).status).toBe(400);
    expect((await http.post('/api/v1/public/saint-kisito/applications').send(application({ tenantId: '00000000-0000-0000-0000-000000000000' }))).status).toBe(400);
    const r = await http.post('/api/v1/public/saint-kisito/applications').send(application({ studentFirstName: 'Pré', studentLastName: 'inscrite' }));
    expect(r.status).toBe(201);
    expect(Object.keys(r.body)).toEqual(['reference']);
    expect(r.body.reference).toMatch(/^PRE-\d{4}-\d{4}$/);
    const saved = await inTenant('saint-kisito', (tx) => tx.application.findFirst({ where: { reference: r.body.reference } }));
    expect(saved).toMatchObject({ studentLastName: 'INSCRITE', status: 'RECU', guardianPhone: '+2290196000099' });
    const notes = (await as('secretariat').get('/notifications')).body;
    expect(JSON.stringify(notes)).toContain('Pré inscrite · 6e');
    expect(consoleSms.sent.some((m) => m.to === '+2290196000099' && m.text.includes(r.body.reference))).toBe(true);
    // Rien n'arrive dans l'autre école.
    expect(await inTenant('autre-ecole', (tx) => tx.application.count({ where: { reference: r.body.reference } }))).toBe(0);
    // Le formulaire public ne donne pas accès à la liste.
    expect((await http.get('/api/v1/applications')).status).toBe(401);
    expect((await as('teacher').get('/applications')).status).toBe(403);
  });

  it('pré-inscription publique : au plus 5 envois par adresse en 10 minutes', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'e2e-limite'; // le limiteur est coupé en NODE_ENV=test : on le rallume le temps de ce test
    try {
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) {
        const r = await http.post('/api/v1/public/saint-kisito/applications').set('X-Forwarded-For', '192.0.2.55').send(application({ studentFirstName: `Limite${i}` }));
        codes.push(r.status);
      }
      expect(codes).toEqual([201, 201, 201, 201, 201, 429]);
      // Une autre adresse n'est pas bloquée.
      expect((await http.post('/api/v1/public/saint-kisito/applications').set('X-Forwarded-For', '192.0.2.56').send(application())).status).toBe(201);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('pré-inscription : le secrétariat filtre, convoque (SMS au parent) et chaque décision est tracée', async () => {
    const r = await http.post('/api/v1/public/saint-kisito/applications').send(application({ studentFirstName: 'Suivi', birthDate: '2014-03-02', wantedTrack: 'F3', sex: 'F' }));
    expect(r.status).toBe(201);
    const recu = (await as('secretariat').get('/applications?status=RECU')).body;
    const a = recu.items.find((x: any) => x.reference === r.body.reference);
    expect(a).toMatchObject({ wantedTrack: 'F3', sex: 'F' });
    expect(recu.items.every((x: any) => x.status === 'RECU')).toBe(true);
    expect(recu.funnel.RECU).toBeGreaterThan(0);
    const sent = consoleSms.sent.length;
    expect((await as('secretariat').patch(`/applications/${a.id}`, { status: 'EN_TEST', testResult: 'Convoqué le 5 août' })).status).toBe(200);
    expect(consoleSms.sent.slice(sent).some((m) => m.to === '+2290196000099' && /convoquée au test/.test(m.text))).toBe(true);
    const sent2 = consoleSms.sent.length;
    expect((await as('secretariat').patch(`/applications/${a.id}`, { status: 'INSCRIT' })).status).toBe(200);
    expect(consoleSms.sent.length).toBe(sent2); // l'inscription elle-même envoie ses propres messages
    expect((await as('secretariat').patch(`/applications/${a.id}`, { status: 'PERDU' })).status).toBe(400);
    expect(await inTenant('saint-kisito', (tx) => tx.auditLog.count({ where: { action: 'application.reviewed', entityId: a.id } }))).toBe(2);
  });

  it("emploi du temps : conflits de classe, d'enseignant et de salle ; créneaux qui se suivent acceptés", async () => {
    const classes = (await as('direction').get('/classes')).body;
    const f3 = classes.find((c: any) => c.name === '1re année F3');
    const c4 = classes.find((c: any) => c.name === '4e A');
    const cs = (c: any, code: string) => c.subjects.find((s: any) => s.subject.code === code).id;
    const rooms = (await as('direction').get('/settings')).body.rooms;
    const room = rooms[0].id;
    const slot = (classSubjectId: string, startMinute: number, endMinute: number, roomId?: string) =>
      as('direction').post('/timetable/slots', { classSubjectId, dayOfWeek: 6, startMinute, endMinute, roomId });
    const created: string[] = [];
    try {
      const a = await slot(cs(f3, 'MATH'), 480, 600, room); // samedi 8h-10h
      expect(a.status).toBe(201);
      created.push(a.body.id);
      const sameClass = await slot(cs(f3, 'DT'), 540, 660);
      expect(sameClass.status).toBe(409);
      expect(sameClass.body.message).toMatch(/La classe a déjà/);
      const sameTeacher = await slot(cs(c4, 'MATH'), 540, 660); // même enseignant de mathématiques, autre classe
      expect(sameTeacher.status).toBe(409);
      expect(sameTeacher.body.message).toMatch(/enseigne déjà/);
      const sameRoom = await slot(cs(c4, 'FR'), 540, 660, room);
      expect(sameRoom.status).toBe(409);
      expect(sameRoom.body.message).toMatch(/La salle .* est prise/);
      const next = await slot(cs(c4, 'FR'), 600, 720, room); // commence quand l'autre finit
      expect(next.status).toBe(201);
      created.push(next.body.id);
      expect((await slot(cs(c4, 'ANG'), 700, 700)).status).toBe(400);
      // Un créneau ne se gêne pas lui-même ; le rallonger sur le suivant est refusé.
      expect((await as('direction').patch(`/timetable/slots/${a.body.id}`, { endMinute: 590 })).status).toBe(200);
      const longer = await as('direction').patch(`/timetable/slots/${a.body.id}`, { endMinute: 630 });
      expect(longer.status).toBe(409);
      expect(longer.body.message).toMatch(/La salle .* est prise/);
      // Changement ponctuel : le bon jour seulement, et sans conflit au nouvel horaire.
      expect((await as('direction').post(`/timetable/slots/${a.body.id}/changes`, { date: '2026-11-13', kind: 'CANCELLED' })).status).toBe(400); // vendredi
      const moved = await as('direction').post(`/timetable/slots/${a.body.id}/changes`, { date: '2026-11-14', kind: 'MOVED', newDate: '2026-11-21', newStartMinute: 600, newEndMinute: 720 });
      expect(moved.status).toBe(409);
      expect((await as('direction').post(`/timetable/slots/${a.body.id}/changes`, { date: '2026-11-14', kind: 'MOVED' })).status).toBe(400);
      // Seule la direction gère l'emploi du temps.
      expect((await as('teacher').post('/timetable/slots', { classSubjectId: cs(f3, 'MATH'), dayOfWeek: 6, startMinute: 900, endMinute: 960 })).status).toBe(403);
    } finally {
      for (const id of created) await as('direction').del(`/timetable/slots/${id}`);
    }
  });

  it("emploi du temps : vues par enseignant et par salle, cours annulé, changé de salle ou déplacé, avec avis à l'enseignant", async () => {
    const classes = (await as('direction').get('/classes')).body;
    const f3 = classes.find((c: any) => c.name === '1re année F3');
    const math = f3.subjects.find((s: any) => s.subject.code === 'MATH').id;
    const rooms = (await as('direction').get('/settings')).body.rooms;
    const a = await as('direction').post('/timetable/slots', { classSubjectId: math, dayOfWeek: 6, startMinute: 780, endMinute: 840, roomId: rooms[0].id });
    expect(a.status).toBe(201);
    try {
      expect((await as('direction').get('/timetable')).status).toBe(400);
      const mine = (await as('teacher').get('/timetable?week=2026-11-14')).body;
      expect(mine.week).toBe('2026-11-09');
      const teacherId = mine.slots[0].teachers[0].id;
      expect(mine.slots.every((x: any) => x.teachers.some((t: any) => t.id === teacherId))).toBe(true);
      expect(mine.slots.some((x: any) => x.id === a.body.id)).toBe(true);
      expect((await as('parent').get(`/timetable?teacherId=${teacherId}`)).status).toBe(403);
      const byRoom = (await as('direction').get(`/timetable?roomId=${rooms[0].id}`)).body;
      expect(byRoom.slots.every((x: any) => x.room?.id === rooms[0].id)).toBe(true);

      const change = (body: object) => as('direction').post(`/timetable/slots/${a.body.id}/changes`, { date: '2026-11-14', ...body });
      const before = (await as('teacher').get('/notifications')).body;
      const c1 = await change({ kind: 'CANCELLED', reason: 'Conseil des professeurs' });
      expect(c1.status).toBe(201);
      const notes = (await as('teacher').get('/notifications')).body;
      expect(JSON.stringify(notes)).toContain('est annulé. Motif : Conseil des professeurs.');
      expect(JSON.stringify(notes).length).toBeGreaterThan(JSON.stringify(before).length);
      expect((await change({ kind: 'ROOM_CHANGED' })).status).toBe(400);
      const c2 = await change({ kind: 'ROOM_CHANGED', newRoomId: rooms[1].id });
      expect(c2.status).toBe(201);
      expect(c2.body.id).toBe(c1.body.id); // une seule modification par cours et par date
      const week = (await as('direction').get(`/timetable?classId=${f3.id}&week=2026-11-14`)).body;
      expect(week.slots.find((x: any) => x.id === a.body.id).changes[0]).toMatchObject({ kind: 'ROOM_CHANGED', newRoomName: rooms[1].name });
      const c3 = await change({ kind: 'MOVED', newDate: '2026-11-21', newStartMinute: 900, newEndMinute: 960 });
      expect(c3.status).toBe(201);
      expect(JSON.stringify((await as('teacher').get('/notifications')).body)).toContain('est déplacé au samedi 21 novembre');
      expect((await as('teacher').del(`/timetable/changes/${c3.body.id}`)).status).toBe(403);
      expect((await as('direction').del(`/timetable/changes/${c3.body.id}`)).status).toBe(200);
      expect(await inTenant('saint-kisito', (tx) => tx.auditLog.count({ where: { action: 'timetable.change_removed', entityId: c3.body.id } }))).toBe(1);
    } finally {
      await as('direction').del(`/timetable/slots/${a.body.id}`);
    }
  });

  it('documents officiels : numéro, QR public limité au résumé, lot par classe, cloisonnement du parent', async () => {
    const parentUser = await inTenant('saint-kisito', (tx) => tx.user.findFirstOrThrow({ where: { phone: PHONES.parent } }));
    const children = await inTenant('saint-kisito', (tx) => tx.studentGuardian.findMany({ where: { guardian: { userId: parentUser.id } }, select: { studentId: true } }));
    const child = children[0].studentId;
    const other = await inTenant('saint-kisito', (tx) =>
      tx.student.findFirstOrThrow({ where: { id: { notIn: children.map((c: any) => c.studentId) }, enrollments: { some: { status: 'ACTIVE' } } } }));

    const doc = await as('secretariat').post('/documents', { kind: 'ATTESTATION_PAIEMENT', studentId: child });
    expect(doc.status).toBe(201);
    expect(doc.body.number).toMatch(/^AP-\d{4}-\d+$/);
    expect(doc.body.data.payments).toBeDefined();
    const pub = (await http.get(`/api/v1/public/verify/${doc.body.verifyCode.toLowerCase()}`)).body;
    expect(pub).toMatchObject({ valid: true, kind: 'Attestation de paiement' });
    expect(Object.keys(pub).sort()).toEqual(['issuedAt', 'issuer', 'kind', 'revoked', 'summary', 'valid']);
    expect(JSON.stringify(pub)).not.toMatch(/birthDate|matricule|photo/);
    expect((await http.get('/api/v1/public/verify/CODE-INCONNU')).body).toEqual({ valid: false });

    // Le parent lit le document de son enfant, pas celui d'un autre élève ; il ne peut pas en délivrer.
    expect((await as('parent').get(`/documents/print?ids=${doc.body.id}`)).status).toBe(200);
    const foreign = await as('secretariat').post('/documents', { kind: 'CERTIFICAT_SCOLARITE', studentId: other.id });
    expect(foreign.status).toBe(201);
    expect([403, 404]).toContain((await as('parent').get(`/documents/print?ids=${foreign.body.id}`)).status);
    expect((await as('parent').get('/documents')).body.every((d: any) => children.some((c: any) => c.studentId === d.student.id))).toBe(true);
    expect((await as('parent').post('/documents', { kind: 'CERTIFICAT_SCOLARITE', studentId: child })).status).toBe(403);
    // Un élève d'une autre école est invisible.
    expect([403, 404]).toContain((await as('secretariat').post('/documents', { kind: 'CERTIFICAT_SCOLARITE', studentId: otherTenantStudentId })).status);

    // Lot : une carte par élève inscrit dans la classe.
    const enr = await inTenant('saint-kisito', (tx) => tx.enrollment.findFirstOrThrow({ where: { studentId: child, status: 'ACTIVE' } }));
    const active = await inTenant('saint-kisito', (tx) => tx.enrollment.count({ where: { classId: enr.classId, status: 'ACTIVE' } }));
    const batch = await as('secretariat').post('/documents/batch', { kind: 'CARTE_SCOLAIRE', classId: enr.classId });
    expect(batch.status).toBe(201);
    expect(batch.body.count).toBe(active);

    // Élève sans inscription cette année : aucun document ; impression sans document : refus.
    const t = await admin.tenant.findUniqueOrThrow({ where: { slug: 'saint-kisito' } });
    const loose = await inTenant('saint-kisito', (tx) => tx.student.create({ data: { tenantId: t.id, matricule: `SKG-TEST-${Date.now()}`, firstName: 'Sans', lastName: 'INSCRIPTION' } }));
    const none = await as('secretariat').post('/documents', { kind: 'CERTIFICAT_SCOLARITE', studentId: loose.id });
    expect(none.status).toBe(404);
    expect(none.body.message).toContain("n'est pas inscrit");
    expect((await as('secretariat').get('/documents/print?ids=')).status).toBe(404);
    const list = (await as('parent').get(`/documents?studentId=${child}`)).body;
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((d: any) => d.student.id === child)).toBe(true);
  });

  it("import de la fiche d'une école : deux fois de suite sans doublon ni perte de ce que l'école a saisi", async () => {
    const run = (slug: string) => {
      try {
        return { code: 0, out: execSync(`npx ts-node --transpile-only prisma/school-import.ts ${slug} data/ecoles/saint-kisito-2026-2027.json`, { env: process.env, stdio: 'pipe', cwd: `${__dirname}/..` }).toString(), err: '' };
      } catch (e: any) {
        return { code: e.status as number, out: '', err: String(e.stderr ?? '') };
      }
    };
    const count = () => inTenant('saint-kisito', async (tx) => ({
      levels: await tx.level.count(), tracks: await tx.track.count(), sites: await tx.site.count(), fees: await tx.feeType.count(),
      students: await tx.student.count(), invoices: await tx.invoice.count(), receipts: await tx.receipt.count(),
    }));
    // Ce que l'école a saisi elle-même, absent du fichier.
    const year = await inTenant('saint-kisito', (tx) => tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } }));
    const own = await inTenant('saint-kisito', async (tx) => tx.feeType.create({ data: { tenantId: year.tenantId, academicYearId: year.id, name: 'Frais saisi par l’école', amount: 1234 } }));
    const first = run('saint-kisito');
    expect(first.code).toBe(0);
    const after1 = await count();
    const second = run('saint-kisito');
    expect(second.code).toBe(0);
    expect(second.out).toBe(first.out);
    expect(await count()).toEqual(after1);
    expect(await inTenant('saint-kisito', (tx) => tx.feeType.findUnique({ where: { id: own.id } }))).toMatchObject({ amount: expect.anything(), active: true });
    expect(await inTenant('saint-kisito', (tx) => tx.auditLog.count({ where: { action: 'school_data.imported' } }))).toBeGreaterThanOrEqual(2);
    // Une école sans l'année visée : refus clair, rien n'est créé.
    const before = await inTenant('autre-ecole', (tx) => tx.level.count());
    const refused = run('autre-ecole');
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("n'existe pas encore");
    expect(await inTenant('autre-ecole', (tx) => tx.level.count())).toBe(before);
    expect(run('ecole-inexistante').err).toContain('Aucune école');
  }, 180000);
});

describe('Sécurité v1.1, étape 6 : garde-fous de structure de la base (SEC-041)', () => {
  it('toute table qui porte une école a son cloisonnement activé, forcé, et une politique', async () => {
    const rows = await admin.$queryRaw<{ table: string; rls: boolean; forced: boolean; policies: number }[]>`
      SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname IN ('tenant_id', 'tenantId') AND NOT a.attisdropped)
      ORDER BY 1`;
    expect(rows.length).toBeGreaterThanOrEqual(50);
    // Tables du seul Super Admin : sans cloisonnement par école, mais totalement fermées à l'application.
    const PLATFORM_ONLY = ['platform_audit_logs'];
    const weak = rows.filter((r) => !PLATFORM_ONLY.includes(r.table) && (!r.rls || !r.forced || r.policies === 0)).map((r) => r.table);
    expect(weak).toEqual([]);
    const grants = await admin.$queryRaw<{ table: string }[]>`
      SELECT table_name AS table FROM information_schema.role_table_grants WHERE grantee = 'erp_app' AND table_name = ANY(${[...PLATFORM_ONLY, 'platform_recovery_codes', 'platform_admins']})`;
    expect(grants).toEqual([]);
  });

  it("le rôle de l'application n'est ni propriétaire des tables ni exempté du cloisonnement", async () => {
    const [role] = await admin.$queryRaw<{ super: boolean; bypass: boolean }[]>`SELECT rolsuper AS super, rolbypassrls AS bypass FROM pg_roles WHERE rolname = 'erp_app'`;
    expect(role).toEqual({ super: false, bypass: false });
    const owned = await admin.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tableowner = 'erp_app'`;
    expect(owned[0].n).toBe(0);
  });

  it("journal, reçus, paiements et notes : l'application ne peut pas les effacer (et le journal ne se modifie pas)", async () => {
    const triggers = await admin.$queryRaw<{ table: string; name: string }[]>`
      SELECT c.relname AS table, t.tgname AS name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND t.tgenabled <> 'D' AND t.tgfoid = 'forbid_change'::regproc ORDER BY 1`;
    expect(triggers.map((t) => t.table).sort()).toEqual(expect.arrayContaining(['audit_logs', 'grades', 'payments', 'platform_audit_logs', 'receipts']));
    const t = await admin.tenant.findUniqueOrThrow({ where: { slug: 'saint-kisito' } });
    const attempt = (sql: string) =>
      app_.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${t.id}, true)`;
        await tx.$executeRawUnsafe(sql);
      }).then(() => 'accepté', (e) => String(e.message ?? e));
    const present = await inTenant('saint-kisito', async (tx) => [await tx.auditLog.count(), await tx.receipt.count(), await tx.payment.count(), await tx.grade.count()]);
    expect(present.every((n) => n > 0)).toBe(true); // sinon un DELETE sans ligne ne prouverait rien
    for (const sql of [
      'DELETE FROM audit_logs', "UPDATE audit_logs SET action = 'x'", 'DELETE FROM receipts', 'DELETE FROM payments', 'DELETE FROM grades',
    ]) expect(await attempt(sql)).not.toBe('accepté');
  });
});

describe('Écoles de plusieurs pays (lot « Pays de l’école »)', () => {
  const email = 'pays-plateforme@test.local';
  const slug = `ci-${Date.now().toString(36)}`;
  let cookie: string;
  let tenantId: string;
  let token: string;

  beforeAll(async () => {
    execSync(`npx ts-node --transpile-only prisma/platform-admin.ts ${email} "Admin Pays" --operateur "Tests automatiques" --motif "Remise à zéro du compte de test"`, { env: process.env, cwd: `${__dirname}/..`, stdio: 'ignore' });
    const argon2 = await import('argon2');
    await admin.platformAdmin.update({ where: { email }, data: { passwordHash: await argon2.hash('Plateforme-Pays-2026'), mustChangePassword: false, mustSetupTwoFactor: false } });
    const r = await http.post('/api/v1/platform/auth/login').send({ email, password: 'Plateforme-Pays-2026' }).expect(201);
    cookie = (r.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('erp_pt='))!.split(';')[0];
  });

  it('liste les pays avec leur indicatif, leur monnaie et leur fuseau', async () => {
    const r = await http.get('/api/v1/platform/countries').set('Cookie', cookie).expect(200);
    expect(r.body.find((c: any) => c.code === 'CI')).toMatchObject({ dial: '225', currency: 'XOF', timezone: 'Africa/Abidjan', einvoice: 'FNE' });
    expect(r.body.find((c: any) => c.code === 'BJ')).toMatchObject({ dial: '229', einvoice: 'e-MECeF' });
    expect((await http.get('/api/v1/platform/countries')).status).toBe(401);
  });

  it("une école ivoirienne prend +225, la monnaie et l'heure d'Abidjan", async () => {
    const bad = await http.post('/api/v1/platform/tenants').set('Cookie', cookie)
      .send({ slug: `${slug}-x`, name: 'École Pays Inconnu', country: 'ZZ', matriculePrefix: 'EPI', siteName: 'Centre', director: { firstName: 'A', lastName: 'B', phone: '0707000001' } });
    expect(bad.status).toBe(400);
    const c = await http.post('/api/v1/platform/tenants').set('Cookie', cookie)
      .send({ slug, name: 'Groupe scolaire Test Abidjan', country: 'CI', matriculePrefix: 'GTA', siteName: 'Cocody', director: { firstName: 'Awa', lastName: 'Koné', phone: '07 07 00 00 01' } });
    expect(c.status).toBe(201);
    expect(c.body.director.identifier).toBe('+2250707000001');
    tenantId = c.body.tenant.id;
    const t = await admin.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect(t).toMatchObject({ country: 'CI', currency: 'XOF', timezone: 'Africa/Abidjan' });

    // Le directeur se connecte en tapant son numéro sans indicatif : +225 est ajouté, pas +229.
    const l = await http.post('/api/v1/auth/login').send({ tenant: slug, identifier: '0707000001', password: c.body.director.temporaryPassword });
    expect(l.status).toBe(200);
    await http.post('/api/v1/auth/change-password').set('Authorization', `Bearer ${l.body.accessToken}`)
      .send({ current: c.body.director.temporaryPassword, next: 'Abidjan2026xy' }).expect(200);
    token = (await http.post('/api/v1/auth/login').send({ tenant: slug, identifier: '0707000001', password: 'Abidjan2026xy' }).expect(200)).body.accessToken;
    const me = await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`).expect(200);
    expect(me.body.tenant).toMatchObject({ country: 'CI', currency: 'XOF', dial: '225', einvoice: 'FNE' });
  });

  it('le personnel enregistré sans indicatif reçoit celui de son école', async () => {
    const s = await http.post('/api/v1/staff').set('Authorization', `Bearer ${token}`)
      .send({ firstName: 'Yao', lastName: 'Comptable', phone: '05 05 00 00 02', roles: [{ role: 'COMPTABLE' }] });
    expect(s.status).toBe(201);
    const u = await inTenant(slug, (tx) => tx.user.findUniqueOrThrow({ where: { id: s.body.id } }));
    expect(u.phone).toBe('+2250505000002');
  });

  it("aucun opérateur Mobile Money n'est inventé hors du Bénin ; la direction saisit les siens", async () => {
    const before = await http.get('/api/v1/settings').set('Authorization', `Bearer ${token}`).expect(200);
    expect(before.body.tenant).toMatchObject({ country: 'CI', countryName: "Côte d'Ivoire", operators: [], einvoice: 'FNE' });
    await http.patch('/api/v1/settings').set('Authorization', `Bearer ${token}`)
      .send({ settings: { payments: { operators: [' Orange Money ', 'Wave', 'Wave', ''] } } }).expect(200);
    const after = await http.get('/api/v1/settings').set('Authorization', `Bearer ${token}`);
    expect(after.body.tenant.operators).toEqual(['Orange Money', 'Wave']);
    expect((await http.patch('/api/v1/settings').set('Authorization', `Bearer ${token}`).send({ settings: { payments: { operators: 'Wave' } } })).status).toBe(400);
    // Saint Kisito (Bénin) garde MTN MoMo et Moov Money tant que sa direction n'a rien saisi.
    expect((await as('parent').get('/payments/operators')).body.operators).toEqual(['MTN MoMo', 'Moov Money']);
  });

  it("le parent ne peut pas payer avec un opérateur que l'école ne propose pas", async () => {
    const invoices = await as('parent').get('/finance/invoices');
    const open = invoices.body.find((i: any) => i.remaining > 0);
    if (!open) return;
    const r = await as('parent').post('/payments/mobile-money', { invoiceId: open.id, amount: open.remaining, operator: 'Wave', phone: '0197000001' });
    expect(r.status).toBe(400);
  });

  it("le Super Admin change le pays : la monnaie et le fuseau suivent ; le texte d'examen se règle", async () => {
    const r = await http.patch(`/api/v1/platform/tenants/${tenantId}`).set('Cookie', cookie).send({ country: 'GN' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ country: 'GN', currency: 'GNF', timezone: 'Africa/Conakry' });
    expect((await http.patch(`/api/v1/platform/tenants/${tenantId}`).set('Cookie', cookie).send({ timezone: 'Pas/UnFuseau' })).status).toBe(400);
    await http.patch(`/api/v1/platform/tenants/${tenantId}`).set('Cookie', cookie).send({ country: 'CI' }).expect(200);
    await http.patch('/api/v1/settings').set('Authorization', `Bearer ${token}`).send({ settings: { public: { collegeExam: 'BEPC' } } }).expect(200);
    expect((await http.get(`/api/v1/public/${slug}`)).body).toMatchObject({ country: 'CI', public: { collegeExam: 'BEPC' } });
  });
});

describe('Récupération sécurisée des comptes 2FA (v1.1)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { authenticator } = require('otplib');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const argon2 = require('argon2');
  const PH = { compta: '+2290190009101', dir1: '+2290190009102', dir2: '+2290190009103' };
  const ids: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  /** Tout code affiché pendant ces tests : aucun ne doit se retrouver dans le journal, les notifications ou les SMS. */
  const shown: string[] = [];
  let tid: string;
  let dirAId: string;
  const ctx = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => inTenant('saint-kisito', fn);
  const signIn = (phone: string) => http.post('/api/v1/auth/login').send({ tenant: 'saint-kisito', identifier: phone, password: PASSWORD });
  const bearer = (t: string) => ({
    get: (url: string) => http.get(`/api/v1${url}`).set('Authorization', `Bearer ${t}`),
    post: (url: string, body: object = {}) => http.post(`/api/v1${url}`).set('Authorization', `Bearer ${t}`).send(body),
  });
  const fresh = (id: string) => ctx((tx) => tx.user.update({ where: { id }, data: { totpLastStep: null, failedLogins: 0, lockedUntil: null } }));
  const userRow = (id: string) => ctx((tx) => tx.user.findUniqueOrThrow({ where: { id } }));
  const codesOf = (id: string) => ctx((tx) => tx.recoveryCode.findMany({ where: { userId: id } }));
  const CODE = /^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/;

  async function enable2fa(key: keyof typeof PH) {
    const t = (await signIn(PH[key])).body.accessToken;
    const setup = await bearer(t).post('/auth/2fa/setup');
    const en = await bearer(t).post('/auth/2fa/enable', { code: authenticator.generate(setup.body.secret), setupToken: setup.body.setupToken });
    expect(en.status).toBe(200);
    secrets[key] = setup.body.secret;
    shown.push(...en.body.recoveryCodes);
    return en.body.recoveryCodes as string[];
  }
  async function fullLogin(key: keyof typeof PH) {
    await fresh(ids[key]);
    const c = (await signIn(PH[key])).body.challenge;
    const r = await http.post('/api/v1/auth/2fa/verify').send({ challenge: c, code: authenticator.generate(secrets[key]) });
    expect(r.status).toBe(200);
    return r.body.accessToken as string;
  }
  async function reenroll(key: keyof typeof PH, activationCode: string) {
    const l = await signIn(PH[key]);
    expect(l.status).toBe(200);
    expect(l.body.reenrollRequired).toBe(true);
    expect(l.body.accessToken).toBeUndefined();
    const start = await http.post('/api/v1/auth/2fa/reenroll/start').send({ challenge: l.body.challenge, activationCode });
    expect(start.status).toBe(200);
    const fin = await http.post('/api/v1/auth/2fa/reenroll/finish').send({ challenge: l.body.challenge, setupToken: start.body.setupToken, code: authenticator.generate(start.body.secret) });
    expect(fin.status).toBe(200);
    secrets[key] = start.body.secret;
    shown.push(...fin.body.recoveryCodes);
    return fin.body;
  }

  // Super Admin fictifs (deux, pour le contrôle à deux), créés directement dans la base de test.
  const PA = { a: 'recup-a@exemple.test', b: 'recup-b@exemple.test' };
  const PA_PW = 'Recuperation-Test-2026';
  const pcookie = (r: any) => (r.headers['set-cookie'] as unknown as string[]).find((c: string) => c.startsWith('erp_pt='))!.split(';')[0];
  const pa: Record<string, string> = {};

  beforeAll(async () => {
    tid = (await admin.tenant.findUniqueOrThrow({ where: { slug: 'saint-kisito' } })).id;
    const hash = await argon2.hash(PASSWORD);
    for (const [key, role] of [['compta', 'COMPTABLE'], ['dir1', 'DIRECTION'], ['dir2', 'DIRECTION']] as const) {
      ids[key] = await ctx(async (tx) => {
        await tx.user.deleteMany({ where: { phone: PH[key] } });
        const u = await tx.user.create({
          data: { tenantId: tid, firstName: 'Fictif', lastName: `Recup-${key}`, phone: PH[key], passwordHash: hash, mustChangePassword: false, roles: { create: [{ tenantId: tid, role }] } },
        });
        return u.id;
      });
    }
    dirAId = (await as('direction').get('/auth/me')).body.user.id;
    for (const [k, email] of Object.entries(PA)) {
      await admin.platformAdmin.deleteMany({ where: { email } });
      await admin.platformAdmin.create({ data: { email, name: `Super Admin fictif ${k}`, passwordHash: await argon2.hash(PA_PW), mustChangePassword: false } });
      pa[k] = pcookie(await http.post('/api/v1/platform/auth/login').send({ email, password: PA_PW }));
    }
  });

  afterAll(async () => {
    await admin.platformAdmin.deleteMany({ where: { email: { in: Object.values(PA) } } });
  });

  it('1. connexion normale avec Google Authenticator : inchangée, 10 codes créés à l’activation, jamais en clair', async () => {
    const codes = await enable2fa('compta');
    expect(codes).toHaveLength(10);
    for (const c of codes) expect(c).toMatch(CODE);
    expect(new Set(codes).size).toBe(10);
    const rows = await codesOf(ids.compta);
    expect(rows).toHaveLength(10);
    for (const r of rows) {
      expect(r.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(codes.some((c) => r.codeHash.includes(c.replace('-', '')))).toBe(false);
    }
    const l = await signIn(PH.compta);
    expect(l.body.twoFactorRequired).toBe(true);
    expect(l.body.accessToken).toBeUndefined();
    expect(await fullLogin('compta')).toBeTruthy();
  });

  it('un compte qui avait déjà Google Authenticator obtient ses codes sans désactiver la 2FA ni changer son secret', async () => {
    // Comme un compte activé avant cette version : aucun code enregistré.
    await ctx((tx) => tx.recoveryCode.deleteMany({ where: { userId: ids.compta } }));
    const before = await userRow(ids.compta);
    const t = await fullLogin('compta');
    expect((await bearer(t).get('/auth/2fa/recovery-codes')).body).toMatchObject({ twoFactorEnabled: true, total: 0, remaining: 0 });
    expect((await bearer(t).post('/auth/2fa/recovery-codes', { code: '000000' })).status).toBe(403);
    await fresh(ids.compta);
    const g = await bearer(t).post('/auth/2fa/recovery-codes', { code: authenticator.generate(secrets.compta) });
    expect(g.status).toBe(200);
    expect(g.headers['cache-control']).toMatch(/no-store/);
    expect(g.body.recoveryCodes).toHaveLength(10);
    shown.push(...g.body.recoveryCodes);
    const after = await userRow(ids.compta);
    expect(after.totpEnabled).toBe(true);
    expect(after.totpSecret).toBe(before.totpSecret);
    expect((await bearer(t).get('/auth/2fa/recovery-codes')).body).toMatchObject({ total: 10, remaining: 10 });
    secrets.comptaCodes = JSON.stringify(g.body.recoveryCodes);
  });

  it('2-3. connexion avec un code de récupération, puis refus du même code ; deux essais simultanés, un seul passe', async () => {
    const codes: string[] = JSON.parse(secrets.comptaCodes);
    const secretBefore = (await userRow(ids.compta)).totpSecret;
    const c1 = (await signIn(PH.compta)).body.challenge;
    const ok = await http.post('/api/v1/auth/2fa/recovery').send({ challenge: c1, code: codes[0] });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();
    expect(ok.body.recoveryCodesRemaining).toBe(9);
    expect(ok.body.reconfigureToken).toBeTruthy();
    // Le même code, rejoué : refusé.
    const c2 = (await signIn(PH.compta)).body.challenge;
    expect((await http.post('/api/v1/auth/2fa/recovery').send({ challenge: c2, code: codes[0] })).status).toBe(401);
    // Saisie tolérante : minuscules, sans tiret.
    const low = await http.post('/api/v1/auth/2fa/recovery').send({ challenge: c2, code: codes[1].toLowerCase().replace('-', ' ') });
    expect(low.status).toBe(200);
    // Deux connexions simultanées avec le même code : une seule réussit.
    await fresh(ids.compta);
    const c3 = (await signIn(PH.compta)).body.challenge;
    const both = await Promise.all([0, 1].map(() => http.post('/api/v1/auth/2fa/recovery').send({ challenge: c3, code: codes[2] })));
    expect(both.map((r) => r.status).sort()).toEqual([200, 401]);
    // La 2FA reste active, le secret n'a pas changé.
    const u = await userRow(ids.compta);
    expect(u.totpEnabled).toBe(true);
    expect(u.totpSecret).toBe(secretBefore);
    expect((await codesOf(ids.compta)).filter((r) => !r.usedAt)).toHaveLength(7);
    // Un code de récupération ne remplace pas le mot de passe : sans le défi de connexion, rien.
    expect((await http.post('/api/v1/auth/2fa/recovery').send({ challenge: 'faux', code: codes[3] })).status).toBe(401);
    await fresh(ids.compta);
  });

  it('après un code de récupération, le nouveau téléphone se configure sans l’ancien, et les autres sessions sont coupées', async () => {
    const codes: string[] = JSON.parse(secrets.comptaCodes);
    const other = await fullLogin('compta');
    const c = (await signIn(PH.compta)).body.challenge;
    const r = await http.post('/api/v1/auth/2fa/recovery').send({ challenge: c, code: codes[3] });
    const t = r.body.accessToken;
    // Sans le jeton de récupération, il faudrait le code de l'ancien téléphone.
    expect((await bearer(t).post('/auth/2fa/setup')).status).toBe(403);
    expect((await bearer(t).post('/auth/2fa/setup', { reconfigureToken: 'faux' })).status).toBe(403);
    const setup = await bearer(t).post('/auth/2fa/setup', { reconfigureToken: r.body.reconfigureToken });
    expect(setup.status).toBe(200);
    const en = await bearer(t).post('/auth/2fa/enable', { code: authenticator.generate(setup.body.secret), setupToken: setup.body.setupToken });
    expect(en.status).toBe(200);
    expect(en.body.recoveryCodes).toHaveLength(10);
    shown.push(...en.body.recoveryCodes);
    secrets.compta = setup.body.secret;
    secrets.comptaCodes = JSON.stringify(en.body.recoveryCodes);
    expect((await bearer(other).get('/auth/me')).status).toBe(401);
    expect((await bearer(t).get('/auth/me')).status).toBe(200);
    // Les anciens codes ne servent plus.
    const c2 = (await signIn(PH.compta)).body.challenge;
    expect((await http.post('/api/v1/auth/2fa/recovery').send({ challenge: c2, code: codes[4] })).status).toBe(401);
    await fresh(ids.compta);
  });

  it('4. régénération : exige le code actuel, remplace tous les codes', async () => {
    const old: string[] = JSON.parse(secrets.comptaCodes);
    const t = await fullLogin('compta');
    await fresh(ids.compta);
    const g = await bearer(t).post('/auth/2fa/recovery-codes', { code: authenticator.generate(secrets.compta) });
    expect(g.status).toBe(200);
    shown.push(...g.body.recoveryCodes);
    expect(g.body.recoveryCodes.some((c: string) => old.includes(c))).toBe(false);
    const c = (await signIn(PH.compta)).body.challenge;
    expect((await http.post('/api/v1/auth/2fa/recovery').send({ challenge: c, code: old[0] })).status).toBe(401);
    expect((await http.post('/api/v1/auth/2fa/recovery').send({ challenge: c, code: g.body.recoveryCodes[0] })).status).toBe(200);
    await fresh(ids.compta);
  });

  it('6. demandes refusées : sans le droit, pour soi-même, en double, ou validée par le demandeur', async () => {
    expect((await as('teacher').get('/recovery-requests')).status).toBe(403);
    expect((await as('secretariat').post('/recovery-requests', { userId: ids.compta, reason: 'Téléphone perdu', identityCheck: 'PIECE_IDENTITE' })).status).toBe(403);
    expect((await as('comptable').post('/recovery-requests', { userId: ids.dir1, reason: 'Téléphone perdu', identityCheck: 'PIECE_IDENTITE' })).status).toBe(403);
    expect((await as('direction').post('/recovery-requests', { userId: dirAId, reason: 'Mon téléphone', identityCheck: 'AUTRE' })).status).toBe(403);
    expect((await as('direction').post('/recovery-requests', { userId: ids.compta, reason: 'x', identityCheck: 'PIECE_IDENTITE' })).status).toBe(400);
    expect((await as('direction').post('/recovery-requests', { userId: ids.compta, reason: 'Téléphone perdu', identityCheck: 'RIEN' })).status).toBe(400);
    // Compte sans double authentification : rien à récupérer.
    expect((await as('direction').post('/recovery-requests', { userId: ids.dir2, reason: 'Téléphone perdu', identityCheck: 'PIECE_IDENTITE' })).status).toBe(400);
  });

  it('5. récupération d’un comptable : demandée par une direction, validée par une autre, après vérification d’identité', async () => {
    const t = await fullLogin('compta');
    const r = await as('direction').post('/recovery-requests', { userId: ids.compta, reason: 'Téléphone volé le 8/11', identityCheck: 'PIECE_IDENTITE', identityNote: 'CNI vue au bureau' });
    expect(r.status).toBe(201);
    expect(r.body.requiresPlatform).toBe(false);
    expect((await as('direction').post('/recovery-requests', { userId: ids.compta, reason: 'Encore une fois', identityCheck: 'PIECE_IDENTITE' })).status).toBe(409);
    // Le demandeur ne valide pas sa propre demande ; la personne concernée non plus.
    expect((await as('direction').post(`/recovery-requests/${r.body.id}/approve`, { note: 'Vu, ok' })).status).toBe(403);
    expect((await bearer(t).post(`/recovery-requests/${r.body.id}/approve`, { note: 'Vu, ok' })).status).toBe(403);
    const dir2 = (await signIn(PH.dir2)).body.accessToken;
    expect((await bearer(dir2).post(`/recovery-requests/${r.body.id}/approve`, { note: '' })).status).toBe(400);
    const ok = await bearer(dir2).post(`/recovery-requests/${r.body.id}/approve`, { note: 'Identité vérifiée, CNI' });
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toMatch(/no-store/);
    expect(ok.body.activationCode).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    shown.push(ok.body.activationCode);
    secrets.comptaActivation = ok.body.activationCode;
    expect((await bearer(dir2).post(`/recovery-requests/${r.body.id}/approve`, { note: 'Deux fois' })).status).toBe(409);
    // Ancienne 2FA retirée, codes effacés, sessions coupées, réactivation imposée.
    const u = await userRow(ids.compta);
    expect(u).toMatchObject({ totpEnabled: false, totpSecret: null, twoFactorReenroll: true });
    expect(await codesOf(ids.compta)).toHaveLength(0);
    expect((await bearer(t).get('/auth/me')).status).toBe(401);
    const row = await ctx((tx) => tx.twoFactorRecoveryRequest.findUniqueOrThrow({ where: { id: r.body.id } }));
    expect(row.status).toBe('APPROVED');
    expect(row.activationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.decidedById).toBe(ids.dir2);
    // La liste ne montre jamais l'empreinte du code.
    const list = await bearer(dir2).get('/recovery-requests');
    expect(JSON.stringify(list.body)).not.toContain(row.activationHash!);
  });

  it('8. réactivation obligatoire : aucun accès avant le nouveau téléphone, code de réactivation à usage unique', async () => {
    const l = await signIn(PH.compta);
    expect(l.body.reenrollRequired).toBe(true);
    expect(l.body.accessToken).toBeUndefined();
    // Ce défi ne sert pas à la connexion ordinaire.
    expect((await http.post('/api/v1/auth/2fa/verify').send({ challenge: l.body.challenge, code: '123456' })).status).toBe(401);
    expect((await http.post('/api/v1/auth/2fa/recovery').send({ challenge: l.body.challenge, code: 'AAAAA-BBBBB' })).status).toBe(401);
    expect((await http.post('/api/v1/auth/2fa/reenroll/start').send({ challenge: l.body.challenge, activationCode: 'AAAA-BBBB' })).status).toBe(401);
    await fresh(ids.compta);
    const done = await reenroll('compta', secrets.comptaActivation);
    expect(done.accessToken).toBeTruthy();
    expect(done.recoveryCodes).toHaveLength(10);
    const u = await userRow(ids.compta);
    expect(u).toMatchObject({ totpEnabled: true, twoFactorReenroll: false });
    const req = await ctx((tx) => tx.twoFactorRecoveryRequest.findFirstOrThrow({ where: { userId: ids.compta }, orderBy: { createdAt: 'desc' } }));
    expect(req.status).toBe('COMPLETED');
    expect(req.activationHash).toBeNull();
    // Le code de réactivation ne resservira pas ; la connexion redemande le code du nouveau téléphone.
    const again = await signIn(PH.compta);
    expect(again.body.twoFactorRequired).toBe(true);
    expect((await http.post('/api/v1/auth/2fa/reenroll/start').send({ challenge: again.body.challenge, activationCode: secrets.comptaActivation })).status).toBe(401);
    expect(await fullLogin('compta')).toBeTruthy();
  });

  it('5 codes de réactivation faux épuisent le code : même le bon ne passe plus', async () => {
    await enable2fa('dir2');
    const r = await as('direction').post('/recovery-requests', { userId: ids.dir2, reason: 'Téléphone tombé dans l’eau', identityCheck: 'RAPPEL_NUMERO_CONNU' });
    expect(r.body.requiresPlatform).toBe(true); // compte Direction : Super Admin
    const ok = await http.post(`/api/v1/platform/tenants/${tid}/recovery-requests/${r.body.id}/approve`).set('Cookie', pa.a).send({ note: 'Rappel au numéro connu' });
    expect(ok.status).toBe(201);
    shown.push(ok.body.activationCode);
    for (let i = 0; i < 5; i++) {
      await ctx((tx) => tx.user.update({ where: { id: ids.dir2 }, data: { lockedUntil: null } }));
      const l = await signIn(PH.dir2);
      expect((await http.post('/api/v1/auth/2fa/reenroll/start').send({ challenge: l.body.challenge, activationCode: 'AAAA-BBBB' })).status).toBe(401);
    }
    // Chaque erreur est comptée sur la demande : au 5e essai faux, le code de réactivation est épuisé.
    expect((await ctx((tx) => tx.twoFactorRecoveryRequest.findUniqueOrThrow({ where: { id: r.body.id } }))).activationAttempts).toBe(5);
    await fresh(ids.dir2);
    const l = await signIn(PH.dir2);
    expect((await http.post('/api/v1/auth/2fa/reenroll/start').send({ challenge: l.body.challenge, activationCode: ok.body.activationCode })).status).toBe(401);
    // Un nouveau code est nécessaire : la demande épuisée ne bloque pas une nouvelle demande… une fois expirée.
    await ctx((tx) => tx.twoFactorRecoveryRequest.update({ where: { id: r.body.id }, data: { activationExpiresAt: new Date(Date.now() - 1000) } }));
  });

  it('5 bis. compte Direction : seule la plateforme valide, et pas le Super Admin qui a ouvert la demande quand ils sont deux', async () => {
    await enable2fa('dir1');
    const r = await as('direction').post('/recovery-requests', { userId: ids.dir1, reason: 'Téléphone perdu en mission', identityCheck: 'CONNAISSANCE_PERSONNELLE' });
    expect(r.status).toBe(201);
    expect(r.body.requiresPlatform).toBe(true);
    // Une autre direction de l'école ne peut pas valider la récupération d'un compte Direction.
    expect((await as('direction').post(`/recovery-requests/${r.body.id}/approve`, { note: 'Vu, ok' })).status).toBe(403);
    const queue = await http.get('/api/v1/platform/recovery-requests').set('Cookie', pa.a);
    expect(queue.status).toBe(200);
    expect(queue.body.some((q: any) => q.id === r.body.id && q.tenantSlug === 'saint-kisito')).toBe(true);
    expect(JSON.stringify(queue.body)).not.toMatch(/activationHash/);
    // Demande ouverte par le Super Admin A : A ne peut pas la valider lui-même, B si.
    expect((await http.post(`/api/v1/platform/tenants/${tid}/recovery-requests/${r.body.id}/reject`).set('Cookie', pa.a).send({ note: 'Refaite par la plateforme' })).status).toBe(201);
    const accounts = await http.get(`/api/v1/platform/tenants/${tid}/recovery-accounts`).set('Cookie', pa.a);
    const acc = accounts.body.find((x: any) => x.id === ids.dir1);
    expect(acc.identifier).not.toBe(PH.dir1);
    const p = await http.post(`/api/v1/platform/tenants/${tid}/recovery-requests`).set('Cookie', pa.a).send({ userId: ids.dir1, reason: 'Appel du directeur au numéro connu', identityCheck: 'RAPPEL_NUMERO_CONNU' });
    expect(p.status).toBe(201);
    expect((await http.post(`/api/v1/platform/tenants/${tid}/recovery-requests/${p.body.id}/approve`).set('Cookie', pa.a).send({ note: 'Moi-même' })).status).toBe(403);
    const ok = await http.post(`/api/v1/platform/tenants/${tid}/recovery-requests/${p.body.id}/approve`).set('Cookie', pa.b).send({ note: 'Validé par le second Super Admin' });
    expect(ok.status).toBe(201);
    shown.push(ok.body.activationCode);
    await fresh(ids.dir1);
    expect((await reenroll('dir1', ok.body.activationCode)).accessToken).toBeTruthy();
    const logs = await admin.platformAuditLog.findMany({ where: { action: { startsWith: 'platform.recovery.' }, tenantId: tid } });
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(['platform.recovery.requested', 'platform.recovery.approved', 'platform.recovery.rejected']));
  });

  it('9. isolation entre écoles : ni demande ni validation sur le compte d’une autre école', async () => {
    const other = await admin.tenant.findUniqueOrThrow({ where: { slug: 'autre-ecole' } });
    const foreignId = await inTenant('autre-ecole', async (tx) => {
      await tx.user.deleteMany({ where: { phone: '+2290190009199' } });
      return (await tx.user.create({ data: { tenantId: other.id, firstName: 'Ailleurs', lastName: 'Recup', phone: '+2290190009199', passwordHash: 'x', totpEnabled: true, totpSecret: 'chiffré-fictif' } })).id;
    });
    const fr = await http.post(`/api/v1/platform/tenants/${other.id}/recovery-requests`).set('Cookie', pa.a).send({ userId: foreignId, reason: 'Test isolation', identityCheck: 'AUTRE' });
    expect(fr.status).toBe(201);
    // Depuis Saint Kisito : le compte et la demande de l'autre école sont introuvables.
    expect((await as('direction').post('/recovery-requests', { userId: foreignId, reason: 'Pas mon école', identityCheck: 'PIECE_IDENTITE' })).status).toBe(404);
    expect((await as('direction').post(`/recovery-requests/${fr.body.id}/approve`, { note: 'Intrusion' })).status).toBe(404);
    expect((await as('direction').post(`/recovery-requests/${fr.body.id}/reject`, { note: 'Intrusion' })).status).toBe(404);
    expect((await as('direction').get('/recovery-requests')).body.some((x: any) => x.id === fr.body.id)).toBe(false);
    // Le Super Admin non plus ne peut pas viser la demande d'une école par l'adresse d'une autre.
    expect((await http.post(`/api/v1/platform/tenants/${tid}/recovery-requests/${fr.body.id}/approve`).set('Cookie', pa.b).send({ note: 'Mauvaise école' })).status).toBe(404);
    expect((await http.get(`/api/v1/platform/tenants/${tid}/recovery-accounts`).set('Cookie', pa.a)).body.some((x: any) => x.id === foreignId)).toBe(false);
    // Dans la base : pas de code d'une école rattaché au compte d'une autre, et rien de visible d'une école à l'autre.
    await expect(app_.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tid}, true)`;
      await tx.recoveryCode.create({ data: { tenantId: tid, userId: foreignId, codeHash: 'f'.repeat(64) } });
    })).rejects.toBeTruthy();
    const seen = await app_.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tid}, true)`;
      return tx.twoFactorRecoveryRequest.findMany({ where: { id: fr.body.id } });
    });
    expect(seen).toHaveLength(0);
    await expect(app_.$queryRaw`SELECT count(*) FROM platform_recovery_codes`).rejects.toThrow();
    await http.post(`/api/v1/platform/tenants/${other.id}/recovery-requests/${fr.body.id}/reject`).set('Cookie', pa.b).send({ note: 'Fin du test' }).expect(201);
  });

  it('7. Super Admin : code de récupération, puis procédure exceptionnelle (téléphone et codes perdus)', async () => {
    const email = PA.a;
    const setup = await http.post('/api/v1/platform/auth/2fa/setup').set('Cookie', pa.a).send({});
    const en = await http.post('/api/v1/platform/auth/2fa/enable').set('Cookie', pa.a).send({ code: authenticator.generate(setup.body.secret), setupToken: setup.body.setupToken });
    expect(en.status).toBe(201);
    expect(en.body.recoveryCodes).toHaveLength(10);
    shown.push(...en.body.recoveryCodes);
    const step1 = await http.post('/api/v1/platform/auth/login').send({ email, password: PA_PW });
    expect(step1.body.twoFactorRequired).toBe(true);
    const rc = await http.post('/api/v1/platform/auth/2fa/recovery').send({ challenge: step1.body.challenge, code: en.body.recoveryCodes[0] });
    expect(rc.status).toBe(201);
    expect(rc.body.recoveryCodesRemaining).toBe(9);
    const live = pcookie(rc);
    expect((await http.post('/api/v1/platform/auth/2fa/recovery').send({ challenge: step1.body.challenge, code: en.body.recoveryCodes[0] })).status).toBe(401);
    const before = await admin.platformAdmin.findUniqueOrThrow({ where: { email } });
    // Sans opérateur ni motif, la commande refuse de toucher au compte.
    expect(() => execSync(`npx ts-node --transpile-only prisma/platform-admin.ts ${email}`, { env: process.env, cwd: `${__dirname}/..`, stdio: 'pipe' })).toThrow();
    expect((await admin.platformAdmin.findUniqueOrThrow({ where: { email } })).passwordHash).toBe(before.passwordHash);
    const out = execSync(`npx ts-node --transpile-only prisma/platform-admin.ts ${email} --operateur "Opérateur fictif" --motif "Téléphone et codes perdus (test)"`, { env: process.env, cwd: `${__dirname}/..` }).toString();
    const temp = out.match(/une seule fois\) : (\S+)/)![1];
    const after = await admin.platformAdmin.findUniqueOrThrow({ where: { email } });
    expect(after).toMatchObject({ totpEnabled: false, totpSecret: null, mustSetupTwoFactor: true, mustChangePassword: true });
    expect(await admin.platformRecoveryCode.count({ where: { adminId: after.id } })).toBe(0);
    expect((await http.get('/api/v1/platform/me').set('Cookie', live)).status).toBe(401);
    const log = await admin.platformAuditLog.findFirstOrThrow({ where: { adminId: after.id, action: 'platform.admin.reset_cli' }, orderBy: { createdAt: 'desc' } });
    expect(log.data).toMatchObject({ operator: 'Opérateur fictif', reason: 'Téléphone et codes perdus (test)' });
    expect(JSON.stringify(log.data)).not.toContain(temp);
    // Connexion avec le mot de passe provisoire : seul le compte répond tant que la 2FA n'est pas refaite.
    await admin.platformAdmin.update({ where: { email }, data: { passwordHash: await argon2.hash(PA_PW), mustChangePassword: false } });
    const c = pcookie(await http.post('/api/v1/platform/auth/login').send({ email, password: PA_PW }));
    expect((await http.get('/api/v1/platform/tenants').set('Cookie', c)).status).toBe(403);
    expect((await http.get('/api/v1/platform/me').set('Cookie', c)).body.mustSetupTwoFactor).toBe(true);
    const s2 = await http.post('/api/v1/platform/auth/2fa/setup').set('Cookie', c).send({});
    expect(s2.status).toBe(201);
    const e2 = await http.post('/api/v1/platform/auth/2fa/enable').set('Cookie', c).send({ code: authenticator.generate(s2.body.secret), setupToken: s2.body.setupToken });
    expect(e2.status).toBe(201);
    shown.push(...e2.body.recoveryCodes);
    expect((await http.get('/api/v1/platform/tenants').set('Cookie', c)).status).toBe(200);
    pa.a = c;
  });

  it('aucun code ni secret dans le journal, les notifications ou les SMS', async () => {
    expect(shown.length).toBeGreaterThan(50);
    const bare = shown.map((s) => s.replace('-', ''));
    const school = await ctx(async (tx) => [
      ...(await tx.auditLog.findMany({ where: { createdAt: { gt: new Date(Date.now() - 3600000) } } })).map((r) => JSON.stringify(r)),
      ...(await tx.notification.findMany({ where: { kind: 'securite' } })).map((r) => `${r.title} ${r.body}`),
    ]);
    const platform = (await admin.platformAuditLog.findMany({ where: { createdAt: { gt: new Date(Date.now() - 3600000) } } })).map((r) => JSON.stringify(r));
    const sms = consoleSms.sent.map((m) => m.text);
    const haystack = [...school, ...platform, ...sms].join('\n').toUpperCase();
    for (const c of [...shown, ...bare]) expect(haystack.includes(c)).toBe(false);
    for (const s of Object.values(secrets)) expect(haystack.includes(s.toUpperCase())).toBe(false);
    // Les opérations sensibles sont bien journalisées.
    const actions = await ctx((tx) => tx.auditLog.findMany({ where: { action: { in: ['auth.recovery_code_used', 'auth.recovery_codes_generated', 'security.recovery_requested', 'security.recovery_approved', 'auth.2fa_reenrolled'] } }, select: { action: true } }));
    expect(new Set(actions.map((a) => a.action)).size).toBe(5);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Lot G0 : GRP-001 (une direction couvre toujours tout l'établissement) et GRP-002 (grille des frais commune).
// Comptes fictifs seulement. Chaque bloc remet l'école dans son état de départ ; le dernier bloc le vérifie.
// ---------------------------------------------------------------------------------------------------------------

/** Ce que touchent les tests du lot G0 : comptes, rôles et grille des frais de l'école de démonstration. */
async function g0State() {
  return inTenant('saint-kisito', async (tx) => {
    const users = await tx.user.findMany({ select: { id: true, phone: true, status: true }, orderBy: { id: 'asc' } });
    const roles = (await tx.userRole.findMany({ select: { userId: true, role: true, siteId: true } })).map((r) => `${r.userId}|${r.role}|${r.siteId ?? ''}`).sort();
    const fees = await tx.feeType.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, name: true, amount: true, active: true, dueDate: true, audience: true, optional: true, levelId: true, trackId: true },
    });
    return { users, roles, fees };
  });
}
let g0Before: Awaited<ReturnType<typeof g0State>> | null = null;

/** Numéros fictifs réservés aux comptes du lot G0. */
const G0 = {
  directionTeacher: '+2290190009301', twoDirections: '+2290190009302', comptableDirection: '+2290190009303',
  staffProbe: '+2290190009304', limitedProbe: '+2290190009305', scriptA: '+2290190009311', scriptB: '+2290190009312',
};
async function g0Sites() {
  return inTenant('saint-kisito', async (tx) => {
    const sites = await tx.site.findMany({ where: { active: true }, orderBy: { name: 'asc' } });
    expect(sites.length).toBeGreaterThan(1);
    return { T: sites[0].tenantId, siteA: sites[0].id, siteB: sites[1].id };
  });
}
/** Compte fictif créé directement en base (mot de passe des tests), éventuellement limité à un site. */
async function g0Account(phone: string, firstName: string, roles: { role: 'DIRECTION' | 'ENSEIGNANT' | 'COMPTABLE' | 'SECRETARIAT'; siteId: string | null }[]) {
  const passwordHash = await hashPassword(PASSWORD);
  return inTenant('saint-kisito', async (tx) => {
    const t = await tx.site.findFirstOrThrow();
    await tx.user.deleteMany({ where: { phone } });
    const u = await tx.user.create({
      data: { tenantId: t.tenantId, firstName, lastName: 'FICTIF', phone, passwordHash, mustChangePassword: false, roles: { create: roles.map((r) => ({ tenantId: t.tenantId, ...r })) } },
    });
    return u.id;
  });
}
const g0Forget = (phones: string[]) => inTenant('saint-kisito', (tx) => tx.user.deleteMany({ where: { phone: { in: phones } } }));
const g0Roles = async (phone: string) =>
  (await inTenant('saint-kisito', (tx) => tx.userRole.findMany({ where: { user: { phone } }, select: { role: true, siteId: true } }))).map((r) => `${r.role}${r.siteId ? '@site' : ''}`).sort();
/** Appels avec un jeton donné et, si besoin, un rôle actif choisi (en-tête X-Active-Role, comme le site). */
const g0As = (token: string, role?: string) => {
  const h = (r: request.Test) => {
    r.set('Authorization', `Bearer ${token}`);
    if (role) r.set('X-Active-Role', role);
    return r;
  };
  return {
    get: (url: string) => h(http.get(`/api/v1${url}`)),
    post: (url: string, body: object = {}) => h(http.post(`/api/v1${url}`)).send(body),
    put: (url: string, body: object = {}) => h(http.put(`/api/v1${url}`)).send(body),
    patch: (url: string, body: object = {}) => h(http.patch(`/api/v1${url}`)).send(body),
  };
};

/** Toutes les routes de l'API, lues dans les contrôleurs : méthode, chemin, publique ou non, route du compte ou non. */
function g0Routes() {
  const join = (...parts: string[]) => `/${parts.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`;
  const out: { method: string; path: string; isPublic: boolean; account: boolean }[] = [];
  for (const mod of app.get(ModulesContainer).values()) {
    for (const wrapper of mod.controllers.values()) {
      const ctrl = wrapper.metatype as any;
      if (!ctrl?.prototype) continue;
      const bases: string[] = [].concat(Reflect.getMetadata(PATH_METADATA, ctrl) ?? '');
      for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
        const handler = ctrl.prototype[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const sub = Reflect.getMetadata(PATH_METADATA, handler);
        if (sub === undefined) continue;
        const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number];
        const meta = (key: string) => !!(Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, ctrl));
        for (const base of bases) for (const p of [].concat(sub) as string[]) {
          out.push({ method, path: join(base, p), isPublic: meta(IS_PUBLIC), account: meta(ALLOW_PENDING_PASSWORD) });
        }
      }
    }
  }
  return out;
}

describe("Lot G0 · GRP-001 : une direction couvre toujours tout l'établissement", () => {
  let siteA = '';
  let siteB = '';
  let classB = '';
  let termId = '';
  let directionId = '';
  let limited = '';

  beforeAll(async () => {
    g0Before = await g0State();
    ({ siteA, siteB } = await g0Sites());
    await inTenant('saint-kisito', async (tx) => {
      const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
      classB = (await tx.class.findFirstOrThrow({ where: { siteId: siteB, academicYearId: year.id } })).id;
      termId = (await tx.term.findFirstOrThrow({ where: { academicYearId: year.id }, orderBy: { position: 'asc' } })).id;
      const u = await tx.user.findFirstOrThrow({ where: { phone: PHONES.direction } });
      directionId = u.id;
      // Ancien compte Direction limité à un site, tel qu'on pouvait le créer avant la correction (sondes A1 à A7 de l'audit).
      await tx.userRole.updateMany({ where: { userId: u.id, role: 'DIRECTION' }, data: { siteId: siteA } });
      await tx.user.update({ where: { id: u.id }, data: { failedLogins: 0, lockedUntil: null } });
    });
    limited = await login(PHONES.direction);
  });

  afterAll(async () => {
    // Remise en état, même si un test a échoué en cours de route.
    await inTenant('saint-kisito', (tx) => tx.userRole.updateMany({ where: { userId: directionId, role: 'DIRECTION' }, data: { siteId: null } }));
    await g0Forget([G0.directionTeacher, G0.twoDirections, G0.staffProbe, G0.limitedProbe]);
  });

  it("un ancien compte Direction limité à un site est refusé sur toutes les routes de l'école, sauf celles de son propre compte", async () => {
    const routes = g0Routes();
    const guarded = routes.filter((r) => !r.isPublic && !r.account);
    // Les seules routes encore ouvertes à ce compte : son profil, ses sessions, son mot de passe, sa double authentification.
    expect(routes.filter((r) => !r.isPublic && r.account).map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'DELETE /auth/sessions/:id', 'GET /auth/me', 'GET /auth/sessions', 'POST /auth/2fa/enable', 'POST /auth/2fa/setup', 'POST /auth/change-password', 'POST /auth/logout-all',
    ]);
    expect(guarded.length).toBeGreaterThan(100);
    const open: string[] = [];
    for (const r of guarded) {
      const url = `/api/v1${r.path.replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000')}`;
      const res = await (http as any)[r.method.toLowerCase()](url).set('Authorization', `Bearer ${limited}`).send({});
      if (res.status !== 403 || !JSON.stringify(res.body).includes('ne peut pas être limité à un site')) open.push(`${r.method} ${r.path} → ${res.status}`);
    }
    expect(open).toEqual([]);
    // Ses routes de compte ne renvoient que ses propres informations.
    const me = await g0As(limited).get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(directionId);
    expect(Object.keys(me.body).sort()).toEqual(['children', 'self', 'sites', 'tenant', 'user', 'year']);
    const sessions = await g0As(limited).get('/auth/sessions');
    expect(sessions.status).toBe(200);
    const own = await inTenant('saint-kisito', (tx) => tx.session.findMany({ where: { userId: directionId }, select: { id: true } }));
    expect(sessions.body.every((x: any) => own.some((o) => o.id === x.id))).toBe(true);
    // Chaque refus est tracé dans le journal de l'école.
    const log: any = await inTenant('saint-kisito', (tx) => tx.auditLog.findFirst({ where: { action: 'access.denied', userId: directionId }, orderBy: { createdAt: 'desc' } }));
    expect(JSON.stringify(log?.data)).toContain('GRP-001');
  });

  it("sondes A1 à A7 de l'audit : ni tableau de bord d'un autre site, ni compte Direction complet créé", async () => {
    const d = g0As(limited);
    expect((await d.get('/dashboard')).status).toBe(403);
    expect((await d.get(`/dashboard?siteId=${siteB}`)).status).toBe(403);
    for (const url of ['/students', '/staff', '/audit?limit=5', '/finance/dashboard', `/report-cards/runs/${classB}/${termId}`]) {
      expect([url, (await d.get(url)).status]).toEqual([url, 403]);
    }
    const probe = await d.post('/staff', { firstName: 'Sonde', lastName: 'GRP', phone: G0.limitedProbe, roles: [{ role: 'DIRECTION', siteId: null }] });
    expect(probe.status).toBe(403);
    expect(await g0Roles(G0.limitedProbe)).toEqual([]);
  });

  it('comptes à plusieurs rôles : seul le rôle Direction limité est bloqué', async () => {
    await g0Account(G0.directionTeacher, 'Directeur-enseignant', [{ role: 'DIRECTION', siteId: siteA }, { role: 'ENSEIGNANT', siteId: null }]);
    await g0Account(G0.twoDirections, 'Deux-directions', [{ role: 'DIRECTION', siteId: siteA }, { role: 'DIRECTION', siteId: null }]);
    const dt = await login(G0.directionTeacher);
    // Rôle Enseignant choisi : il travaille normalement ; rôle Direction choisi : refusé.
    expect((await g0As(dt, 'ENSEIGNANT').get('/students')).status).toBe(200);
    expect((await g0As(dt, 'ENSEIGNANT').get('/classes')).status).toBe(200);
    const asDirection = await g0As(dt, 'DIRECTION').get('/students');
    expect(asDirection.status).toBe(403);
    expect(JSON.stringify(asDirection.body)).toContain('ne peut pas être limité à un site');
    // Un rôle Direction de tout l'établissement en plus d'un ancien rôle limité : le compte couvre tout l'établissement.
    const two = await login(G0.twoDirections);
    const all = await as('direction').get('/dashboard');
    const mine = await g0As(two, 'DIRECTION').get('/dashboard');
    expect(mine.status).toBe(200);
    expect(mine.body.students).toBe(all.body.students);
  });

  it('la direction ne peut plus être limitée à un site, ni à la création ni à la modification ; les autres rôles le peuvent', async () => {
    const bad = await as('direction').post('/staff', { firstName: 'Sonde', lastName: 'GRP', phone: G0.staffProbe, roles: [{ role: 'DIRECTION', siteId: siteA }] });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain('ne peut pas être limité à un site');
    expect(await g0Roles(G0.staffProbe)).toEqual([]);
    const ok = await as('direction').post('/staff', { firstName: 'Sonde', lastName: 'GRP', phone: G0.staffProbe, roles: [{ role: 'SECRETARIAT', siteId: siteA }] });
    expect(ok.status).toBe(201);
    expect(await g0Roles(G0.staffProbe)).toEqual(['SECRETARIAT@site']);
    expect((await as('direction').patch(`/staff/${ok.body.id}`, { roles: [{ role: 'DIRECTION', siteId: siteA }] })).status).toBe(400);
    expect(await g0Roles(G0.staffProbe)).toEqual(['SECRETARIAT@site']);
    expect((await as('direction').patch(`/staff/${ok.body.id}`, { roles: [{ role: 'DIRECTION', siteId: null }] })).status).toBe(200);
    expect(await g0Roles(G0.staffProbe)).toEqual(['DIRECTION']);
  });

  it("la direction de tout l'établissement voit toujours tous les sites, ou un seul si elle le choisit", async () => {
    const all = await as('direction').get('/dashboard');
    expect(all.status).toBe(200);
    expect(all.body.bySite.length).toBeGreaterThan(1);
    expect(all.body.students).toBe(all.body.bySite.reduce((a: number, s: any) => a + s.count, 0));
    const one = await as('direction').get(`/dashboard?siteId=${siteB}`);
    expect(one.status).toBe(200);
    expect(one.body.students).toBeGreaterThan(0);
    expect(one.body.students).toBeLessThan(all.body.students);
  });

  it("un ancien rôle Direction limité à un site ne compte pas parmi les validateurs d'une récupération de compte", async () => {
    expect(await inTenant('saint-kisito', (tx) => directionIds(tx))).not.toContain(directionId);
    await inTenant('saint-kisito', (tx) => tx.userRole.updateMany({ where: { userId: directionId, role: 'DIRECTION' }, data: { siteId: null } }));
    expect(await inTenant('saint-kisito', (tx) => directionIds(tx))).toContain(directionId);
  });
});

describe('Lot G0 · GRP-002 : la grille des frais, commune à tous les sites, ne se modifie que pour tout l’établissement', () => {
  let comptableId = '';
  let limited = '';
  let fee: { id: string; name: string; amount: number; levelId: string | null } = { id: '', name: '', amount: 0, levelId: null };
  let levelId = '';

  beforeAll(async () => {
    const { siteA } = await g0Sites();
    await inTenant('saint-kisito', async (tx) => {
      const u = await tx.user.findFirstOrThrow({ where: { phone: PHONES.comptable } });
      comptableId = u.id;
      await tx.userRole.updateMany({ where: { userId: u.id, role: 'COMPTABLE' }, data: { siteId: siteA } });
      await tx.user.update({ where: { id: u.id }, data: { failedLogins: 0, lockedUntil: null } });
      const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
      const f = await tx.feeType.findFirstOrThrow({ where: { academicYearId: year.id, active: true }, orderBy: { name: 'asc' } });
      fee = { id: f.id, name: f.name, amount: f.amount, levelId: f.levelId };
      levelId = (await tx.level.findFirstOrThrow()).id;
    });
    limited = await login(PHONES.comptable);
    await g0Account(G0.comptableDirection, 'Comptable-directeur', [{ role: 'COMPTABLE', siteId: siteA }, { role: 'DIRECTION', siteId: null }]);
  });

  afterAll(async () => {
    await inTenant('saint-kisito', async (tx) => {
      await tx.userRole.updateMany({ where: { userId: comptableId, role: 'COMPTABLE' }, data: { siteId: null } });
      await tx.feeType.update({ where: { id: fee.id }, data: { amount: fee.amount } });
    });
    await g0Forget([G0.comptableDirection]);
  });

  const amountNow = async () => (await inTenant('saint-kisito', (tx) => tx.feeType.findUniqueOrThrow({ where: { id: fee.id } }))).amount;
  const feeCount = () => inTenant('saint-kisito', (tx) => tx.feeType.count());

  it('un comptable limité à un site consulte la grille mais ne peut ni la modifier, ni y ajouter un frais', async () => {
    const c = g0As(limited);
    const list = await c.get('/finance/fee-types');
    expect(list.status).toBe(200);
    expect(list.body.some((f: any) => f.id === fee.id)).toBe(true);
    const before = await feeCount();
    const attempts = [
      await c.patch(`/finance/fee-types/${fee.id}`, { name: fee.name, amount: fee.amount + 1 }),
      await c.put('/finance/fee-types/grid', { name: 'Sonde G0', rows: [{ levelId, amount: 1 }] }),
      await c.post('/finance/fee-types', { name: 'Sonde G0 bis', amount: 1 }),
    ];
    for (const r of attempts) {
      expect(r.status).toBe(403);
      expect(JSON.stringify(r.body)).toContain('commune à tous les sites');
    }
    expect(await amountNow()).toBe(fee.amount);
    expect(await feeCount()).toBe(before);
    const log: any = await inTenant('saint-kisito', (tx) => tx.auditLog.findFirst({ where: { action: 'access.denied', userId: comptableId }, orderBy: { createdAt: 'desc' } }));
    expect(JSON.stringify(log?.data)).toContain('GRP-002');
    // Il garde ses droits sur son site.
    expect((await c.get('/finance/dashboard')).status).toBe(200);
    expect((await c.get('/finance/payments')).status).toBe(200);
  });

  it('la direction et un comptable de tous les sites la modifient toujours', async () => {
    for (const who of ['comptable', 'direction']) {
      try {
        const r = await as(who).patch(`/finance/fee-types/${fee.id}`, { name: fee.name, amount: fee.amount + 1 });
        expect([who, r.status]).toEqual([who, 200]);
        expect(await amountNow()).toBe(fee.amount + 1);
      } finally {
        await as('direction').patch(`/finance/fee-types/${fee.id}`, { name: fee.name, amount: fee.amount });
      }
    }
    expect(await amountNow()).toBe(fee.amount);
  });

  it('compte à plusieurs rôles : refusé comme comptable limité, accepté comme direction', async () => {
    const t = await login(G0.comptableDirection);
    expect((await g0As(t, 'COMPTABLE').patch(`/finance/fee-types/${fee.id}`, { name: fee.name, amount: fee.amount + 2 })).status).toBe(403);
    expect(await amountNow()).toBe(fee.amount);
    try {
      expect((await g0As(t, 'DIRECTION').patch(`/finance/fee-types/${fee.id}`, { name: fee.name, amount: fee.amount + 2 })).status).toBe(200);
      expect(await amountNow()).toBe(fee.amount + 2);
    } finally {
      await as('direction').patch(`/finance/fee-types/${fee.id}`, { name: fee.name, amount: fee.amount });
    }
  });
});

describe('Lot G0 · régularisation des anciens comptes Direction limités à un site (npm run directions:sites)', () => {
  const run = (args = '') => execSync(`npx ts-node --transpile-only prisma/directions-par-site.ts ${args}`, { env: process.env, cwd: `${__dirname}/..`, stdio: 'pipe' }).toString();
  const fails = (args: string) => {
    try {
      run(args);
      return '';
    } catch (e: any) {
      return `${e.status} ${e.stderr?.toString() ?? ''}`;
    }
  };
  let a = '';
  let b = '';

  beforeAll(async () => {
    const { siteA } = await g0Sites();
    a = await g0Account(G0.scriptA, 'Seule-direction', [{ role: 'DIRECTION', siteId: siteA }]);
    b = await g0Account(G0.scriptB, 'Direction-secretariat', [{ role: 'DIRECTION', siteId: siteA }, { role: 'SECRETARIAT', siteId: null }]);
  });

  afterAll(() => g0Forget([G0.scriptA, G0.scriptB]));

  it('le contrôle liste les comptes bloqués, école par école, sans rien modifier', async () => {
    const before = await g0State();
    const out = run();
    expect(out).toContain("saint-kisito (");
    expect(out).toContain('2 compte(s) Direction limité(s) à un site');
    expect(out).toContain('Seule-direction FICTIF');
    expect(out).toContain('Direction-secretariat FICTIF');
    expect(out).toContain(a);
    expect(out).not.toContain(G0.scriptA); // téléphone masqué
    expect(out).toMatch(/autre-ecole \(.*\) : aucun compte Direction limité à un site/);
    expect(await g0State()).toEqual(before);
  });

  it("la régularisation exige l'opérateur et le motif, corrige un seul compte, coupe ses sessions et l'inscrit au journal", async () => {
    const before = await g0Roles(G0.scriptA);
    expect(fails(`--ecole saint-kisito --compte ${a} --tous-les-sites`)).toMatch(/^1 /);
    expect(fails(`--ecole saint-kisito --compte ${a} --tous-les-sites --retirer-direction --operateur "Opérateur fictif" --motif "Test G0 du 12/11"`)).toMatch(/^1 /);
    expect(await g0Roles(G0.scriptA)).toEqual(before);
    const old = await login(G0.scriptA);
    expect((await g0As(old).get('/dashboard')).status).toBe(403);
    const out = run(`--ecole saint-kisito --compte ${a} --tous-les-sites --operateur "Opérateur fictif" --motif "Test G0 du 12/11"`);
    expect(out).toContain('1 session(s) coupée(s)');
    expect(await g0Roles(G0.scriptA)).toEqual(['DIRECTION']);
    expect(await g0Roles(G0.scriptB)).toEqual(['DIRECTION@site', 'SECRETARIAT']);
    const log: any = await inTenant('saint-kisito', (tx) => tx.auditLog.findFirst({ where: { action: 'user.roles_changed', entityId: a }, orderBy: { createdAt: 'desc' } }));
    expect(log).toMatchObject({ userId: null, userName: 'Opérateur de la plateforme (Opérateur fictif)' });
    expect(log.data).toMatchObject({ decision: 'tous-les-sites', operateur: 'Opérateur fictif', motif: 'Test G0 du 12/11', sessionsCoupees: 1 });
    // L'ancienne session ne sert plus ; une nouvelle connexion couvre tout l'établissement.
    await new Promise((r) => setTimeout(r, 50));
    const fresh = await login(G0.scriptA);
    expect((await g0As(fresh).get('/dashboard')).status).toBe(200);
    // Retirer le rôle Direction et garder les autres ; jamais un compte sans aucun rôle.
    run(`--ecole saint-kisito --compte ${b} --retirer-direction --operateur "Opérateur fictif" --motif "Test G0 du 12/11"`);
    expect(await g0Roles(G0.scriptB)).toEqual(['SECRETARIAT']);
    expect(fails(`--ecole saint-kisito --compte ${b} --retirer-direction --operateur "Opérateur fictif" --motif "Test G0 du 12/11"`)).toContain('rien à régulariser');
    expect(run()).toMatch(/saint-kisito \(.*\) : aucun compte Direction limité à un site/);
  });
});

describe('Lot G1 · groupes scolaires : rattachement des écoles et rôles de base dédiés (T-03, T-04, T-11, T-14)', () => {
  const email = 'groupes-g1@test.local';
  const stamp = Date.now().toString(36);
  const groupDb = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_GROUP_URL } } });
  const statsDb = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_STATS_URL } } });
  const NAME_A = `Groupe A (test G1 ${stamp})`;
  const NAME_B = `Groupe B (test G1 ${stamp})`;
  const school = (k: string) => `École ${k.toUpperCase()} (test G1 ${stamp})`;
  const ids = { groupA: '', groupB: '', a1: '', a2: '', b1: '' };
  let cookie = '';
  let directorA1 = { identifier: '', temporaryPassword: '' };
  const pf = (method: 'get' | 'post' | 'patch' | 'delete', url: string, body?: object) =>
    (http as any)[method](`/api/v1/platform${url}`).set('Cookie', cookie).send(body ?? {});
  const newSchool = async (k: string, extra: object = {}) => {
    const r = await pf('post', '/tenants', {
      slug: `g1-${k}-${stamp}`, name: school(k), matriculePrefix: 'GUN', siteName: 'Centre', director: { firstName: 'Test', lastName: 'Groupes', phone: '0190002222' }, ...extra,
    });
    expect([k, r.status]).toEqual([k, 201]);
    return r.body as { tenant: { id: string; group: { id: string; name: string } }; director: { identifier: string; temporaryPassword: string } };
  };
  const groupOf = async (tenantId: string) => (await admin.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { groupId: true } })).groupId;
  /** Lecture avec le rôle du groupe et le groupe de session donné, comme le fera la console du groupe (lot G2). */
  const asGroup = <T>(groupId: string | null, fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    groupDb.$transaction(async (tx) => {
      if (groupId) await tx.$executeRaw`SELECT set_config('app.group_id', ${groupId}, true)`;
      return fn(tx);
    });
  const schoolJournal = (tenantId: string, action: string) =>
    admin.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return tx.auditLog.findMany({ where: { action }, orderBy: { createdAt: 'asc' } });
    });
  const ALL = 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER';
  /** Tables (et vues) sur lesquelles un rôle a le moindre droit, sur la table ou sur une colonne. */
  const tablesOpenTo = async (role: string) =>
    (await admin.$queryRaw<{ table: string }[]>`
      SELECT c.relname AS table FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
        AND (has_table_privilege(${role}, c.oid, ${ALL}) OR has_any_column_privilege(${role}, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES'))
      ORDER BY 1`).map((r) => r.table);

  beforeAll(async () => {
    execSync(`npx ts-node --transpile-only prisma/platform-admin.ts ${email} "Super Admin Groupes" --operateur "Tests automatiques" --motif "Remise à zéro du compte de test"`, { env: process.env, cwd: `${__dirname}/..` });
    const argon2 = await import('argon2');
    await admin.platformAdmin.update({ where: { email }, data: { passwordHash: await argon2.hash('Plateforme-Test-2026'), mustChangePassword: false, mustSetupTwoFactor: false } });
    const r = await http.post('/api/v1/platform/auth/login').send({ email, password: 'Plateforme-Test-2026' });
    expect(r.status).toBe(201);
    cookie = (r.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('erp_pt='))!.split(';')[0];
  });

  afterAll(async () => {
    await groupDb.$disconnect();
    await statsDb.$disconnect();
  });

  it("D-G1 : le Super Admin crée des groupes ; une école créée sans groupe en forme un à son nom", async () => {
    expect((await pf('post', '/groups', { name: 'AB' })).status).toBe(400);
    expect((await pf('post', '/groups', { name: 'Groupe valide', email: 'pas-une-adresse' })).status).toBe(400);
    const a = await pf('post', '/groups', { name: NAME_A, promoter: 'Promoteur fictif A', phone: '0190000000', email: 'GroupeA@Test.local', country: 'BJ', notes: 'Note interne fictive G1' });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ name: NAME_A, email: 'groupea@test.local', status: 'ACTIVE', schools: [] });
    ids.groupA = a.body.id;
    ids.groupB = (await pf('post', '/groups', { name: NAME_B })).body.id;
    // École créée directement dans un groupe existant.
    const a1 = await newSchool('a1', { groupId: ids.groupA });
    expect(a1.tenant.group).toEqual({ id: ids.groupA, name: NAME_A });
    ids.a1 = a1.tenant.id;
    directorA1 = a1.director;
    // Sans groupe choisi : un groupe d'un seul établissement, à son nom.
    const a2 = await newSchool('a2');
    expect(a2.tenant.group.name).toBe(school('a2'));
    expect(a2.tenant.group.id).not.toBe(ids.groupA);
    ids.a2 = a2.tenant.id;
    ids.b1 = (await newSchool('b1', { groupId: ids.groupB })).tenant.id;
    expect((await pf('post', '/tenants', { slug: `g1-x-${stamp}`, name: school('x'), matriculePrefix: 'GUN', siteName: 'Centre', director: { firstName: 'T', lastName: 'G', phone: '0190002222' }, groupId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    // Une facture de groupe est dans une seule monnaie.
    const xaf = await pf('post', '/tenants', { slug: `g1-y-${stamp}`, name: school('y'), matriculePrefix: 'GUN', siteName: 'Centre', director: { firstName: 'T', lastName: 'G', phone: '0190002222' }, groupId: ids.groupA, country: 'CM' });
    expect(xaf.status).toBe(400);
    expect(xaf.body.message).toContain('une seule monnaie');
    expect(await admin.tenant.findUnique({ where: { slug: `g1-y-${stamp}` } })).toBeNull();
    const groups = (await pf('get', '/groups')).body as any[];
    expect(groups.find((g) => g.id === ids.groupA).schools.map((s: any) => s.id)).toEqual([ids.a1]);
    const tenants = (await pf('get', '/tenants')).body as any[];
    expect(tenants.find((t) => t.id === ids.a2).group).toEqual({ id: a2.tenant.group.id, name: school('a2') });
    // Toute école de la base appartient à un groupe (colonne obligatoire, clé étrangère).
    const [{ n }] = await admin.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM tenants WHERE group_id IS NULL OR NOT EXISTS (SELECT 1 FROM school_groups g WHERE g.id = tenants.group_id)`;
    expect(n).toBe(0);
    // Création tracée dans le journal du groupe et dans celui de la plateforme.
    const journal = (await pf('get', `/groups/${ids.groupA}/audit`)).body as any[];
    expect(journal.map((l) => l.action).sort()).toEqual(['group.created', 'group.school_created']);
    expect(journal.every((l) => l.actorName === 'Super Admin Cahiora (Super Admin Groupes)' && l.ip === null)).toBe(true);
  });

  it('T-14 : seul le Super Admin rattache une école à un groupe, avec un motif, tracé dans les trois journaux', async () => {
    const motif = 'Demande écrite fictive du promoteur A';
    // Sans connexion Super Admin, ou avec le jeton d'une école : refusé.
    expect((await http.post(`/api/v1/platform/tenants/${ids.a2}/attach`).send({ groupId: ids.groupA, motif })).status).toBe(401);
    expect((await http.post(`/api/v1/platform/tenants/${ids.a2}/attach`).set('Authorization', `Bearer ${tokens.direction}`).send({ groupId: ids.groupA, motif })).status).toBe(401);
    // La direction ne peut pas changer de groupe par ses paramètres.
    expect((await as('direction').patch('/settings', { groupId: ids.groupA })).status).toBe(400);
    // Même en base : ni le rôle des écoles ni celui du groupe ne peuvent changer le groupe d'une école.
    await expect(app_.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${ids.a2}, true)`;
      await tx.$executeRaw`UPDATE tenants SET group_id = ${ids.groupA}::uuid WHERE id = ${ids.a2}::uuid`;
    })).rejects.toThrow(/permission denied/);
    await expect(asGroup(ids.groupA, (tx) => tx.$executeRaw`UPDATE tenants SET group_id = ${ids.groupA}::uuid WHERE id = ${ids.a2}::uuid`)).rejects.toThrow(/permission denied/);
    // Motif obligatoire, groupe existant, pas de rattachement au groupe actuel.
    expect((await pf('post', `/tenants/${ids.a2}/attach`, { groupId: ids.groupA })).status).toBe(400);
    expect((await pf('post', `/tenants/${ids.a2}/attach`, { groupId: ids.groupA, motif: 'abc' })).status).toBe(400);
    expect((await pf('post', `/tenants/${ids.a2}/attach`, { groupId: '00000000-0000-4000-8000-000000000000', motif })).status).toBe(404);
    expect((await pf('post', `/tenants/${ids.a1}/attach`, { groupId: ids.groupA, motif })).status).toBe(400);
    const before = await groupOf(ids.a2);
    const r = await pf('post', `/tenants/${ids.a2}/attach`, { groupId: ids.groupA, motif });
    expect(r.status).toBe(201);
    expect(r.body.group).toEqual({ id: ids.groupA, name: NAME_A });
    expect(await groupOf(ids.a2)).toBe(ids.groupA);
    // 1. Journal de la plateforme : qui, d'où vers où, et pourquoi.
    const pl = await admin.platformAuditLog.findFirst({ where: { action: 'platform.group.school_attached', tenantId: ids.a2 }, orderBy: { createdAt: 'desc' } });
    expect(pl?.data).toEqual({ fromGroupId: before, fromGroupName: school('a2'), toGroupId: ids.groupA, toGroupName: NAME_A, motif });
    expect(pl?.adminId).toBeTruthy();
    // 2. Journaux des deux groupes : l'école qui part ou arrive, sans le motif.
    const gl = await admin.groupAuditLog.findMany({ where: { groupId: { in: [before, ids.groupA] }, action: { in: ['group.school_left', 'group.school_joined'] } } });
    expect(gl.map((l) => `${l.groupId === before ? 'ancien' : 'nouveau'} ${l.action} ${(l.data as any).tenantId === ids.a2}`).sort())
      .toEqual(['ancien group.school_left true', 'nouveau group.school_joined true']);
    expect(JSON.stringify(gl)).not.toContain(motif);
    // 3. Journal de l'école, lisible par sa direction.
    const sl = await schoolJournal(ids.a2, 'platform.group.attached');
    expect(sl).toHaveLength(1);
    expect(sl[0]).toMatchObject({ userName: 'Super Admin de la plateforme (Super Admin Groupes)', entity: 'Tenant', data: { from: school('a2'), to: NAME_A } });
  });

  it('T-14 : une école détachée forme un groupe à son nom et disparaît aussitôt du groupe', async () => {
    const seen = () => asGroup(ids.groupA, async (tx) => (await tx.$queryRaw<{ id: string }[]>`SELECT id FROM tenants`).map((x) => x.id).sort());
    expect(await seen()).toEqual([ids.a1, ids.a2].sort());
    expect((await pf('post', `/tenants/${ids.a2}/detach`, {})).status).toBe(400);
    expect((await http.post(`/api/v1/platform/tenants/${ids.a2}/detach`).set('Authorization', `Bearer ${tokens.direction}`).send({ motif: 'Essai avec une école' })).status).toBe(401);
    const d = await pf('post', `/tenants/${ids.a2}/detach`, { motif: 'Fin du rattachement fictif' });
    expect(d.status).toBe(201);
    expect(d.body.group.name).toBe(school('a2'));
    // Le groupe A ne la voit plus, dès la transaction suivante.
    expect(await seen()).toEqual([ids.a1]);
    const own = await groupOf(ids.a2);
    expect(own).toBe(d.body.group.id);
    expect(await asGroup(own, async (tx) => (await tx.$queryRaw<{ id: string }[]>`SELECT id FROM tenants`).map((x) => x.id))).toEqual([ids.a2]);
    // Déjà seule dans son groupe : rien à détacher.
    expect((await pf('post', `/tenants/${ids.a2}/detach`, { motif: 'Encore une fois' })).status).toBe(400);
    // Les trois journaux.
    expect(await admin.platformAuditLog.count({ where: { action: 'platform.group.school_detached', tenantId: ids.a2 } })).toBe(1);
    expect((await admin.groupAuditLog.findMany({ where: { groupId: own } })).map((l) => l.action).sort()).toEqual(['group.created_for_school', 'group.school_joined']);
    expect(await admin.groupAuditLog.count({ where: { groupId: ids.groupA, action: 'group.school_left' } })).toBe(1);
    expect((await schoolJournal(ids.a2, 'platform.group.detached'))[0]).toMatchObject({ data: { from: NAME_A, to: school('a2') } });
  });

  it("T-03 : le rôle du groupe ne lit aucune ligne d'un autre groupe, même par requête directe", async () => {
    // Sans groupe de session : rien du tout.
    const none = await asGroup(null, async (tx) => {
      const n: number[] = [];
      for (const t of ['school_groups', 'tenants', 'group_audit_logs', 'group_accounts', 'group_sessions', 'group_recovery_codes']) {
        n.push((await tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${t}`))[0].n);
      }
      return n;
    });
    expect(none).toEqual([0, 0, 0, 0, 0, 0]);
    // Groupe A : sa fiche, ses écoles et son journal ; rien du groupe B, même demandé par identifiant et avec l'école de B fixée en session.
    const seen = await asGroup(ids.groupA, async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${ids.b1}, true)`;
      return {
        groups: (await tx.$queryRaw<{ id: string }[]>`SELECT id FROM school_groups`).map((x) => x.id),
        groupB: await tx.$queryRaw`SELECT id FROM school_groups WHERE id = ${ids.groupB}::uuid`,
        schools: (await tx.$queryRaw<{ id: string }[]>`SELECT id FROM tenants`).map((x) => x.id),
        schoolB: await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${ids.b1}::uuid OR slug = ${`g1-b1-${stamp}`}`,
        journals: (await tx.$queryRaw<{ g: string }[]>`SELECT DISTINCT group_id AS g FROM group_audit_logs`).map((x) => x.g),
      };
    });
    expect(seen).toEqual({ groups: [ids.groupA], groupB: [], schools: [ids.a1], schoolB: [], journals: [ids.groupA] });
    // Ni les notes internes de la plateforme, ni les réglages ou notes des écoles (l'adresse d'une école, publique, est lisible depuis le lot G2).
    for (const sql of ['SELECT notes FROM school_groups', 'SELECT settings FROM tenants', 'SELECT "platformNotes" FROM tenants', 'SELECT timezone FROM tenants']) {
      await expect(asGroup(ids.groupA, (tx) => tx.$queryRawUnsafe(sql))).rejects.toThrow(/permission denied/);
    }
    // Aucune écriture sur la fiche du groupe ni sur ses écoles, même dans son propre groupe.
    for (const sql of [
      `UPDATE school_groups SET name = 'Piraté'`, `DELETE FROM school_groups`, `UPDATE tenants SET name = 'Piraté'`,
      `INSERT INTO school_groups (id, name, "updatedAt") VALUES (gen_random_uuid(), 'Faux groupe', now())`,
      `UPDATE group_audit_logs SET action = 'x'`, `DELETE FROM group_audit_logs`,
    ]) await expect(asGroup(ids.groupA, (tx) => tx.$executeRawUnsafe(sql))).rejects.toThrow(/permission denied/);
    // Journal : ajout seul (lot G2), dans son propre groupe et sous l'étiquette « group » seulement.
    for (const [gid, kind] of [[ids.groupB, 'group'], [ids.groupA, 'platform'], [ids.groupA, 'system']]) {
      await expect(asGroup(ids.groupA, (tx) => tx.$executeRawUnsafe(
        `INSERT INTO group_audit_logs (id, group_id, "actorKind", action) VALUES (gen_random_uuid(), '${gid}', '${kind}', 'x')`,
      ))).rejects.toThrow(/row-level security/);
    }
  });

  it("T-04 : les rôles erp_group et erp_stats n'ont aucun droit sur aucune table d'école, ni sur les comptes", async () => {
    const schoolTables = (await admin.$queryRaw<{ table: string }[]>`
      SELECT c.relname AS table FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname IN ('tenant_id', 'tenantId') AND NOT a.attisdropped)`).map((r) => r.table);
    expect(schoolTables.length).toBeGreaterThanOrEqual(50);
    expect(schoolTables).toEqual(expect.arrayContaining(['students', 'users', 'grades', 'payments', 'sessions', 'audit_logs']));
    // Contrôle automatique : toute table qui porte une école, présente ou future.
    const group = await tablesOpenTo('erp_group');
    const stats = await tablesOpenTo('erp_stats');
    expect(group.filter((t) => schoolTables.includes(t))).toEqual([]);
    expect(stats.filter((t) => schoolTables.includes(t))).toEqual([]);
    // Le rôle du groupe : la fiche du groupe et de ses écoles (lecture seule, colonnes choisies), son journal (lecture et
    // ajout) et, depuis le lot G2, les comptes, sessions et codes de la console ; celui des statistiques, aucune pour l'instant.
    expect(group).toEqual(['group_accounts', 'group_audit_logs', 'group_recovery_codes', 'group_sessions', 'school_groups', 'tenants']);
    expect(stats).toEqual([]);
    const cols = await admin.$queryRaw<{ table: string; column: string; privilege: string }[]>`
      SELECT table_name AS table, column_name AS column, privilege_type AS privilege FROM information_schema.column_privileges
      WHERE grantee = 'erp_group' AND table_name IN ('tenants', 'school_groups') ORDER BY 1, 2`;
    expect(cols.every((c) => c.privilege === 'SELECT')).toBe(true);
    expect(cols.filter((c) => c.table === 'tenants').map((c) => c.column).sort()).toEqual(['country', 'currency', 'domain', 'groupJoinedAt', 'group_id', 'id', 'name', 'shortName', 'slug', 'status']);
    expect(cols.filter((c) => c.table === 'school_groups').map((c) => c.column)).not.toContain('notes');
    // Ni super-utilisateur, ni exemption de la Row Level Security, ni propriétaire, ni création de rôle ou de base.
    const roles = await admin.$queryRaw<{ name: string; flags: string; owns: number }[]>`
      SELECT rolname AS name, concat_ws(',', NULLIF(rolsuper, false)::text, NULLIF(rolbypassrls, false)::text, NULLIF(rolcreaterole, false)::text, NULLIF(rolcreatedb, false)::text) AS flags,
             (SELECT count(*)::int FROM pg_class c WHERE c.relowner = r.oid) AS owns
      FROM pg_roles r WHERE rolname IN ('erp_group', 'erp_stats') ORDER BY 1`;
    expect(roles).toEqual([{ name: 'erp_group', flags: '', owns: 0 }, { name: 'erp_stats', flags: '', owns: 0 }]);
    // Par requête directe : élèves, comptes, mots de passe, comptes Super Admin.
    for (const db of [groupDb, statsDb]) {
      for (const t of ['students', 'users', 'sessions', 'recovery_codes', 'platform_admins', 'platform_recovery_codes', 'platform_audit_logs']) {
        await expect(db.$queryRawUnsafe(`SELECT count(*) FROM ${t}`)).rejects.toThrow(/permission denied/);
      }
    }
    await expect(statsDb.$queryRaw`SELECT count(*) FROM tenants`).rejects.toThrow(/permission denied/);
  });

  it("T-11 : le rôle des écoles ne lit aucune table du groupe ; la direction voit seulement le nom de son groupe", async () => {
    // Hors tables d'école, l'application n'a droit qu'à la fiche des écoles, sans les colonnes du groupe.
    const open = await tablesOpenTo('erp_app');
    const outside = (await admin.$queryRaw<{ table: string }[]>`
      SELECT c.relname AS table FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
        AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname IN ('tenant_id', 'tenantId') AND NOT a.attisdropped)`).map((r) => r.table);
    expect(open.filter((t) => outside.includes(t))).toEqual(['tenants']);
    const cols = (await admin.$queryRaw<{ column: string }[]>`
      SELECT column_name AS column FROM information_schema.column_privileges WHERE grantee = 'erp_app' AND table_name = 'tenants'`).map((c) => c.column);
    expect(cols).not.toContain('group_id');
    expect(cols).not.toContain('groupJoinedAt');
    for (const sql of [
      'SELECT count(*) FROM school_groups', 'SELECT count(*) FROM group_audit_logs', 'SELECT group_id FROM tenants',
      'SELECT count(*) FROM group_accounts', 'SELECT count(*) FROM group_sessions', 'SELECT count(*) FROM group_recovery_codes',
    ]) {
      await expect(app_.$queryRawUnsafe(sql)).rejects.toThrow(/permission denied/);
    }
    // La seule porte : current_tenant_group(), qui ne renvoie rien hors d'une école et seulement son propre groupe dans une école.
    expect(await app_.$queryRaw`SELECT * FROM current_tenant_group()`).toEqual([]);
    const own = await app_.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${ids.a1}, true)`;
      return tx.$queryRaw<{ name: string }[]>`SELECT name FROM current_tenant_group()`;
    });
    expect(own).toEqual([{ name: NAME_A }]);
    // Écran Paramètres : Direction seulement ; le groupe ne reçoit encore aucune donnée de l'école.
    const g = await as('direction').get('/settings/group');
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ name: 'Lycée privé Saint Kisito-GESA', sharedWithGroup: [] });
    expect(Object.keys(g.body).sort()).toEqual(['joinedAt', 'name', 'sharedWithGroup']);
    for (const who of ['secretariat', 'comptable', 'teacher', 'parent', 'student']) expect([who, (await as(who).get('/settings/group')).status]).toEqual([who, 403]);
    // La direction d'une école d'un groupe voit le nom du groupe, jamais les autres écoles.
    const login = await http.post('/api/v1/auth/login').send({ tenant: `g1-a1-${stamp}`, identifier: directorA1.identifier, password: directorA1.temporaryPassword });
    expect(login.status).toBe(200);
    await http.post('/api/v1/auth/change-password').set('Authorization', `Bearer ${login.body.accessToken}`).send({ current: directorA1.temporaryPassword, next: 'Groupes2026x' }).expect(200);
    const relog = await http.post('/api/v1/auth/login').send({ tenant: `g1-a1-${stamp}`, identifier: directorA1.identifier, password: 'Groupes2026x' });
    const mine = await http.get('/api/v1/settings/group').set('Authorization', `Bearer ${relog.body.accessToken}`);
    expect(mine.status).toBe(200);
    expect(mine.body).toEqual({ name: NAME_A, joinedAt: expect.any(String), sharedWithGroup: [] });
    expect(JSON.stringify(mine.body)).not.toContain(school('a2'));
    // Le journal de l'école montre sa création dans le groupe.
    const log = await http.get('/api/v1/audit?action=platform').set('Authorization', `Bearer ${relog.body.accessToken}`);
    expect(log.body.find((e: any) => e.action === 'platform.tenant.created')?.data).toMatchObject({ group: NAME_A });
  });

  it("un groupe qui a des écoles ne peut pas être supprimé ; un groupe vide oui, et son journal reste", async () => {
    expect((await pf('delete', `/groups/${ids.groupB}`)).status).toBe(409);
    // La base le refuse aussi, même au rôle de la plateforme.
    await expect(app.get(PlatformDb).schoolGroup.delete({ where: { id: ids.groupB } })).rejects.toThrow();
    // Fiche du groupe : les notes internes ne vont jamais dans le journal du groupe.
    const u = await pf('patch', `/groups/${ids.groupA}`, { promoter: 'Nouveau promoteur fictif', notes: 'Autre note interne fictive', email: '' });
    expect(u.status).toBe(200);
    expect(u.body).toMatchObject({ promoter: 'Nouveau promoteur fictif', email: null, notes: 'Autre note interne fictive' });
    expect((await pf('patch', `/groups/${ids.groupA}`, { name: '' })).status).toBe(400);
    // B1 rejoint le groupe A : aucun des deux groupes n'apprend le nom de l'autre, ni le motif, ni les notes.
    expect((await pf('post', `/tenants/${ids.b1}/attach`, { groupId: ids.groupA, motif: 'Regroupement fictif B vers A' })).status).toBe(201);
    const logs = await admin.groupAuditLog.findMany({ where: { groupId: { in: [ids.groupA, ids.groupB] } } });
    const ofA = JSON.stringify(logs.filter((l) => l.groupId === ids.groupA));
    const ofB = JSON.stringify(logs.filter((l) => l.groupId === ids.groupB));
    expect(ofA).not.toContain(NAME_B);
    expect(ofB).not.toContain(NAME_A);
    for (const secret of ['Regroupement fictif', 'Note interne fictive', 'Autre note interne fictive']) expect(ofA + ofB).not.toContain(secret);
    expect(ofA).toContain('Nouveau promoteur fictif');
    const pl = await admin.platformAuditLog.findFirst({ where: { action: 'platform.group.updated' }, orderBy: { createdAt: 'desc' } });
    expect(pl?.data).toMatchObject({ groupId: ids.groupA, promoter: 'Nouveau promoteur fictif', notes: 'modifiées' });
    // Groupe B vide : suppression permise, journal conservé et toujours en ajout seul.
    expect((await pf('delete', `/groups/${ids.groupB}`)).status).toBe(200);
    expect(await admin.schoolGroup.findUnique({ where: { id: ids.groupB } })).toBeNull();
    expect((await pf('get', `/groups/${ids.groupB}/audit`)).status).toBe(404);
    const kept = (await admin.groupAuditLog.findMany({ where: { groupId: ids.groupB }, orderBy: { createdAt: 'asc' } })).map((l) => l.action);
    expect(kept).toEqual(['group.created', 'group.school_created', 'group.school_left', 'group.deleted']);
    await expect(admin.$executeRaw`DELETE FROM group_audit_logs WHERE group_id = ${ids.groupB}::uuid`).rejects.toThrow(/ajout seul/);
    await expect(admin.$executeRaw`UPDATE group_audit_logs SET action = 'x' WHERE group_id = ${ids.groupB}::uuid`).rejects.toThrow(/ajout seul/);
    const actions = ((await pf('get', '/audit')).body as any[]).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['platform.group.created', 'platform.group.updated', 'platform.group.deleted', 'platform.group.school_attached', 'platform.group.school_detached']));
  });
});

describe("Lot G0 · les tests rendent l'école exactement dans son état de départ", () => {
  it('comptes, rôles et grille des frais identiques à ceux du début du lot G0', async () => {
    expect(g0Before).not.toBeNull();
    expect(await g0State()).toEqual(g0Before);
  });
});
