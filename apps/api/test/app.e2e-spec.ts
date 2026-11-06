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
import { PlatformDb } from '../src/modules/platform/platform';
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

  it("rien n'est public sans choix de la direction ; publié avec l'accord des parents, sans la moyenne si elle le décide", async () => {
    expect((await http.get('/api/v1/public/saint-kisito')).body.honors).toEqual([]);
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
    const t = await admin.tenant.create({ data: { slug: slugB, name: 'École B (test)', settings: { matriculePrefix: 'ETB' } } });
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
