import { endOfSchoolDay, nameKey } from './enrollments';

describe('Lot G4 · comparaison des noms pour les doublons possibles', () => {
  it('accents, majuscules, apostrophes, tirets et ordre des mots ne comptent pas', () => {
    expect(nameKey('Aya-Marie', "N'GUESSAN")).toBe('aya marie nguessan');
    expect(nameKey('NGUESSAN', 'aya marie')).toBe(nameKey('Aya-Marie', 'N’Guessan'));
    expect(nameKey('Brice', 'DÉGBÉ')).toBe(nameKey('degbe', 'BRICE'));
    expect(nameKey('Ifèoluwa', 'ADJOVI')).toBe('adjovi ifeoluwa');
  });

  it('deux prénoms différents ne se confondent pas (frères et sœurs)', () => {
    expect(nameKey('Koffi', 'DOSSOU')).not.toBe(nameKey('Sèna', 'DOSSOU'));
    expect(nameKey('Marie', 'AYA')).not.toBe(nameKey('Aya-Marie', 'KONE'));
    expect(nameKey(' ', '-')).toBe('');
  });
});

describe('Lot G4 · fin du jour de référence dans le fuseau de l’école', () => {
  it('Bénin (UTC+1) et Côte d’Ivoire (UTC+0)', () => {
    expect(endOfSchoolDay('2027-03-31', 'Africa/Porto-Novo').toISOString()).toBe('2027-03-31T22:59:59.999Z');
    expect(endOfSchoolDay('2027-06-30', 'Africa/Porto-Novo').toISOString()).toBe('2027-06-30T22:59:59.999Z');
    expect(endOfSchoolDay('2027-03-31', 'Africa/Abidjan').toISOString()).toBe('2027-03-31T23:59:59.999Z');
    expect(endOfSchoolDay('2028-02-29', 'Africa/Abidjan').toISOString()).toBe('2028-02-29T23:59:59.999Z');
  });

  it("un fuseau à heure d'été reste juste le jour du changement d'heure", () => {
    // Paris passe à l'heure d'été le dimanche 28 mars 2027 : minuit local du 29 mars = 22 h UTC le 28.
    expect(endOfSchoolDay('2027-03-27', 'Europe/Paris').toISOString()).toBe('2027-03-27T22:59:59.999Z');
    expect(endOfSchoolDay('2027-03-28', 'Europe/Paris').toISOString()).toBe('2027-03-28T21:59:59.999Z');
  });
});
