/**
 * Mise en forme des SMS envoyés aux familles.
 * Un SMS tient en 160 caractères de l'alphabet GSM. Un seul caractère hors de cet alphabet (ê, ç, ’, espace fine...)
 * fait passer le message en Unicode : 70 caractères par SMS, donc deux ou trois SMS payés au lieu d'un.
 * Les textes sont donc ramenés à l'alphabet GSM avant l'envoi.
 */

const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXTENDED = '^{}\\[~]|€';
const GSM = new Set([...GSM_BASIC, ...GSM_EXTENDED]);

const REPLACE: Record<string, string> = {
  ' ': ' ', ' ': ' ', ' ': ' ', '’': "'", '‘': "'", '«': '"', '»': '"', '“': '"', '”': '"', '–': '-', '—': '-', '…': '...',
  â: 'a', á: 'a', ã: 'a', ê: 'e', ë: 'e', î: 'i', ï: 'i', í: 'i', ô: 'o', ó: 'o', õ: 'o', û: 'u', ú: 'u', ç: 'c', ÿ: 'y', œ: 'oe',
  À: 'A', Â: 'A', È: 'E', Ê: 'E', Ë: 'E', Î: 'I', Ï: 'I', Ô: 'O', Ù: 'U', Û: 'U', Œ: 'OE',
};

/** Texte ramené à l'alphabet GSM : accents rares retirés, apostrophes et espaces typographiques remplacées. */
export function toGsm(text: string): string {
  let out = '';
  for (const ch of text) {
    if (GSM.has(ch)) out += ch;
    else if (REPLACE[ch] !== undefined) out += REPLACE[ch];
    else {
      const plain = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
      out += [...plain].every((c) => GSM.has(c)) ? plain : '?';
    }
  }
  return out;
}

/** Nombre de SMS facturés : 160 caractères pour un SMS seul, 153 par SMS au-delà (les caractères étendus comptent double). */
export function smsSegments(text: string): number {
  const len = [...text].reduce((n, c) => n + (GSM_EXTENDED.includes(c) ? 2 : 1), 0);
  return len <= 160 ? 1 : Math.ceil(len / 153);
}

/** Montant sans devise, avec des espaces simples : 140 000. */
export const amount = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** Date au format 28/09/2026, dans le fuseau de l'école. */
export const dmy = (d: Date, timeZone = 'UTC') => new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone }).format(d);

/** Heure au format 10h30. */
export const hm = (minute: number) => `${Math.floor(minute / 60)}h${String(minute % 60).padStart(2, '0')}`;

/** Élève comme sur la liste de classe : NOM Prénoms en majuscules. */
export const pupilName = (s: { firstName: string; lastName: string }) => `${s.lastName} ${s.firstName}`.toUpperCase();

export function paymentSms(p: { date: Date; timeZone?: string; amount: number; pupil: { firstName: string; lastName: string }; className: string | null; total: number; paid: number }) {
  const left = Math.max(0, p.total - p.paid);
  return toGsm(
    `Le ${dmy(p.date, p.timeZone)} un paiement de ${amount(p.amount)} a été effectué pour ${pupilName(p.pupil)}${p.className ? ` en classe de ${p.className}` : ''}. ` +
      `NAP: ${amount(p.total)}, PAYE: ${amount(p.paid)}, RESTE: ${amount(left)}`,
  );
}

export function absenceSms(a: { date: Date; pupil: { firstName: string; lastName: string; sex?: 'M' | 'F' | null }; className: string | null; subject?: string | null; startMinute: number; endMinute: number | null }) {
  const day = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', timeZone: 'UTC' }).format(a.date);
  const absent = a.pupil.sex === 'F' ? 'absente' : a.pupil.sex === 'M' ? 'absent' : 'absent(e)';
  const slot = a.endMinute ? `de ${hm(a.startMinute)}-${hm(a.endMinute)}` : `de ${hm(a.startMinute)}`;
  const course = a.subject ? `pendant le cours de ${a.subject.toUpperCase()} ${slot}` : `au cours ${slot}`;
  return toGsm(`Ce ${day} ${dmy(a.date)}, votre enfant ${pupilName(a.pupil)}${a.className ? ` en classe de ${a.className}` : ''} est ${absent} ${course}.`);
}
