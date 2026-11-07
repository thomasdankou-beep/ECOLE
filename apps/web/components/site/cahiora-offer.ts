/** One source of truth for the launch offer; no subscription or payment is created here. */
export const PRICE_PER_STUDENT = 500;
export const MAX_STUDENTS = 100000;
export const SALES_PHONE =
  process.env.NEXT_PUBLIC_CAHIORA_SALES_PHONE || "2250503206666";

export function parseEnrollment(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 1 && n <= MAX_STUDENTS ? n : null;
}

export const formatNumber = (n: number) =>
  new Intl.NumberFormat("fr-FR").format(n);
export const annualPrice = (students: number) => students * PRICE_PER_STUDENT;
export function salesLink(message: string) {
  return `https://wa.me/${SALES_PHONE.replace(/\D/g, "")}?text=${encodeURIComponent(message)}`;
}
