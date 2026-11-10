import { absenceSms, amount, paymentSms, smsSegments, toGsm } from './sms-text';

describe('SMS aux familles', () => {
  it('SMS de paiement au format des reçus : date, montant, élève, classe, net à payer, payé, reste', () => {
    const text = paymentSms({
      date: new Date('2026-09-28T09:00:00Z'), timeZone: 'Africa/Porto-Novo', amount: 70000,
      pupil: { firstName: 'Kader', lastName: 'Timite' }, className: '6ème 6', total: 140000, paid: 70000,
    });
    expect(text).toBe('Le 28/09/2026 un paiement de 70 000 a été effectué pour TIMITE KADER en classe de 6ème 6. NAP: 140 000, PAYE: 70 000, RESTE: 70 000');
    expect(smsSegments(text)).toBe(1);
  });

  it("SMS d'absence avec la matière et le créneau du cours", () => {
    const text = absenceSms({
      date: new Date('2026-11-05T00:00:00Z'), pupil: { firstName: 'Kader', lastName: 'Timite', sex: 'M' }, className: '6ème 6',
      subject: 'Physique-Chimie', startMinute: 630, endMinute: 740,
    });
    expect(text).toBe('Ce jeudi 05/11/2026, votre enfant TIMITE KADER en classe de 6ème 6 est absent pendant le cours de PHYSIQUE-CHIMIE de 10h30-12h20.');
    expect(smsSegments(text)).toBe(1);
  });

  it('accorde « absente » et se passe de la fin du cours si elle est inconnue', () => {
    const text = absenceSms({ date: new Date('2026-11-05T00:00:00Z'), pupil: { firstName: 'Awa', lastName: 'Kora', sex: 'F' }, className: null, subject: null, startMinute: 480, endMinute: null });
    expect(text).toBe('Ce jeudi 05/11/2026, votre enfant KORA AWA est absente au cours de 8h00.');
  });

  it("reste dans l'alphabet GSM pour ne payer qu'un SMS", () => {
    expect(toGsm('Français, fête, l’élève « Noël » !')).toBe('Francais, fete, l\'élève " Noel " !');
    expect(amount(1234567)).toBe('1 234 567');
    expect(smsSegments('a'.repeat(160))).toBe(1);
    expect(smsSegments('a'.repeat(161))).toBe(2);
  });
});
