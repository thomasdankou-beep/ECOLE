'use client';

/** Image de chaque école : logo envoyé par la direction (sinon ses initiales) et couleur principale. */

function mix(hex: string, target: number, amount: number) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [n >> 16, (n >> 8) & 255, n & 255].map((c) => Math.round(c + (target - c) * amount));
  return `#${ch.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** Remplace la couleur principale du thème clair par celle de l'école ; le thème sombre garde ses teintes lisibles. */
export function BrandStyle({ color }: { color?: string | null }) {
  if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) return null;
  const vars = `--brand:${color};--brand-strong:${mix(color, 0, 0.3)};--brand-soft:${mix(color, 255, 0.86)};`;
  return <style>{`@media (prefers-color-scheme: light){:root:not([data-theme='dark']){${vars}}}:root[data-theme='light']{${vars}}`}</style>;
}

function initials(name: string) {
  const words = name.replace(/[^\p{L}\s-]/gu, ' ').split(/[\s-]+/).filter((w) => w.length > 2 || /^[A-Z]/.test(w));
  return (words.slice(-2).map((w) => w[0]).join('') || name.slice(0, 2)).toUpperCase();
}

export function SchoolLogo({ url, name, size = 44, className = '' }: { url?: string | null; name?: string | null; size?: number; className?: string }) {
  if (url) return <img src={url} alt="" width={size} height={size} style={{ width: size, height: size }} className={`flex-none rounded-full object-contain ${className}`} />;
  return (
    <span aria-hidden style={{ width: size, height: size, fontSize: size * 0.38 }} className={`grid flex-none place-items-center rounded-full bg-brand font-display font-bold text-brand-ink ${className}`}>
      {name ? initials(name) : ''}
    </span>
  );
}
