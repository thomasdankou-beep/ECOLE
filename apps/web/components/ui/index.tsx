'use client';

/**
 * Composants d'interface, sur le modèle de shadcn/ui (Radix + Tailwind + cva),
 * adaptés au terrain : zones tactiles d'au moins 44 px, libellés toujours visibles.
 */
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2, X } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils';

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-lg font-bold transition-colors disabled:pointer-events-none disabled:opacity-50 cursor-pointer whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'bg-brand text-brand-ink hover:bg-brand-strong',
        accent: 'bg-orange text-[#1b1206] hover:brightness-95',
        outline: 'border border-line bg-surface text-ink hover:bg-sunk',
        ghost: 'text-brand hover:bg-brand-soft',
        danger: 'bg-bad text-white hover:brightness-95',
        success: 'bg-good text-white hover:brightness-95',
      },
      size: { default: 'min-h-11 px-4 text-[15px]', sm: 'min-h-9 px-3 text-sm', lg: 'min-h-14 px-6 text-base', icon: 'size-11' },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild, loading, children, disabled, ...props }, ref) => {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} {...props}>
      {asChild ? children : <>{loading && <Loader2 className="size-4 animate-spin" aria-hidden />}{children}</>}
    </Comp>
  );
});
Button.displayName = 'Button';

export function Card({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('min-w-0 rounded-xl border border-line bg-surface p-4 sm:p-5', className)} {...p} />;
}

export function CardTitle({ className, ...p }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('mb-3 text-[21px] font-bold leading-tight', className)} {...p} />;
}

const field = 'w-full min-h-11 rounded-lg border border-line bg-surface px-3 py-2 text-[15px] text-ink placeholder:text-muted/70 disabled:opacity-60';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) => (
  <input ref={ref} className={cn(field, className)} {...p} />
));
Input.displayName = 'Input';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...p }, ref) => (
  <textarea ref={ref} className={cn(field, 'min-h-24', className)} {...p} />
));
Textarea.displayName = 'Textarea';

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...p }, ref) => (
  <select ref={ref} className={cn(field, 'pr-8', className)} {...p} />
));
Select.displayName = 'Select';

/** Champ avec libellé visible, aide et erreur. */
export function Field({ label, hint, error, children, className }: { label: string; hint?: string; error?: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn('grid gap-1.5', className)}>
      <span className="text-[13px] font-bold text-muted">{label}</span>
      {children}
      {hint && !error && <span className="text-xs text-muted">{hint}</span>}
      {error && <span className="text-xs font-bold text-bad">{error}</span>}
    </label>
  );
}

const badge = cva('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-extrabold', {
  variants: {
    tone: {
      info: 'bg-sunk text-muted',
      brand: 'bg-brand-soft text-brand',
      good: 'bg-good-soft text-good',
      warn: 'bg-warn-soft text-warn',
      bad: 'bg-bad-soft text-bad',
      accent: 'bg-orange-soft text-orange',
    },
  },
  defaultVariants: { tone: 'info' },
});
export function Badge({ tone, className, ...p }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badge>) {
  return <span className={cn(badge({ tone }), className)} {...p} />;
}

export function Table({ className, ...p }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <table className={cn('tabular w-full border-collapse text-left text-[14.5px] [&_td]:border-b [&_td]:border-line [&_td]:px-2 [&_td]:py-2.5 [&_td]:align-middle [&_th]:border-b [&_th]:border-line [&_th]:px-2 [&_th]:py-2 [&_th]:text-xs [&_th]:font-bold [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted', className)} {...p} />
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-lg bg-sunk', className)} />;
}

export function Empty({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="grid place-items-center gap-2 rounded-xl border border-dashed border-line px-4 py-10 text-center">
      <p className="font-bold">{title}</p>
      {children && <p className="max-w-md text-sm text-muted">{children}</p>}
      {action}
    </div>
  );
}

export function Stat({ label, value, detail, tone }: { label: string; value: React.ReactNode; detail?: React.ReactNode; tone?: 'bad' | 'good' | 'warn' }) {
  return (
    <Card className="grid gap-1">
      <span className="text-xs font-bold uppercase tracking-wider text-muted">{label}</span>
      <span className={cn('tabular font-display text-[28px] font-bold leading-none sm:text-[34px]', tone === 'bad' && 'text-bad', tone === 'good' && 'text-good', tone === 'warn' && 'text-warn')}>{value}</span>
      {detail && <span className="text-[13px] text-muted">{detail}</span>}
    </Card>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[30px] font-bold leading-[1.05] sm:text-[34px]">{title}</h1>
        {subtitle && <p className="mt-1 text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/**
 * Onglets en pastilles. Vérifiés le 24 novembre 2026 sur ordinateur, tablette et téléphone : à partir de la tablette, ils
 * passent à la ligne et restent tous visibles ; au téléphone, ils défilent de côté, un fondu signale ceux qui dépassent et
 * l'onglet choisi est ramené dans la vue (sans faire défiler la page).
 */
export function Chips<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [edges, setEdges] = React.useState({ left: false, right: false });
  const measure = React.useCallback(() => {
    const box = ref.current;
    if (!box) return;
    const next = { left: box.scrollLeft > 1, right: box.scrollLeft + box.clientWidth < box.scrollWidth - 1 };
    setEdges((e) => (e.left === next.left && e.right === next.right ? e : next));
  }, []);
  React.useEffect(() => {
    measure();
    if (typeof ResizeObserver === 'undefined' || !ref.current) return;
    const ro = new ResizeObserver(measure);
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [measure, options.length]);
  React.useEffect(() => {
    const box = ref.current;
    const chip = box?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!box || !chip || box.scrollWidth <= box.clientWidth) return;
    const b = box.getBoundingClientRect();
    const c = chip.getBoundingClientRect();
    if (c.left < b.left) box.scrollLeft -= b.left - c.left + 24;
    else if (c.right > b.right) box.scrollLeft += c.right - b.right + 24;
    measure();
  }, [value, measure]);
  const mask = edges.left || edges.right
    ? `linear-gradient(to right, ${edges.left ? 'transparent, #000 24px' : '#000, #000'}, ${edges.right ? '#000 calc(100% - 24px), transparent' : '#000'})`
    : undefined;
  return (
    <div ref={ref} role="group" aria-label={label} onScroll={measure} style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
      className="flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] md:flex-wrap md:overflow-visible">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className="min-h-9 flex-none cursor-pointer rounded-full border border-line bg-surface px-3.5 text-[13.5px] font-bold aria-pressed:border-brand aria-pressed:bg-brand aria-pressed:text-brand-ink"
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-sm font-bold text-bad">{error instanceof Error ? error.message : String(error)}</p>;
}

/**
 * Ce qui manque encore avant de valider un formulaire, sous son bouton désactivé (24 novembre 2026 : le bouton de
 * validation reste désactivé tant que les informations obligatoires ne sont pas renseignées). Rien quand tout est là.
 */
export function Missing({ items }: { items: (string | false | null | undefined)[] }) {
  const left = items.filter((x): x is string => !!x);
  if (!left.length) return null;
  return <p className="text-xs text-muted" aria-live="polite" data-testid="a-completer">À compléter : {left.join(', ')}.</p>;
}

// ---------------------------------------------------------------- Dialogue

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({ title, description, children, className }: { title: string; description?: string; children: React.ReactNode; className?: string }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-[rgb(10_14_30/0.55)]" />
      <DialogPrimitive.Content
        className={cn('fixed left-1/2 top-1/2 z-50 max-h-[92dvh] w-[calc(100%-32px)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl bg-surface p-5 shadow-2xl', className)}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <DialogPrimitive.Title className="font-display text-2xl font-bold leading-tight">{title}</DialogPrimitive.Title>
            {description ? <DialogPrimitive.Description className="mt-1 text-sm text-muted">{description}</DialogPrimitive.Description> : <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>}
          </div>
          <DialogPrimitive.Close className="grid size-10 flex-none cursor-pointer place-items-center rounded-lg hover:bg-sunk" aria-label="Fermer">
            <X className="size-5" />
          </DialogPrimitive.Close>
        </div>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

// ---------------------------------------------------------------- Messages éphémères

type Toast = { id: number; text: string; tone: 'good' | 'bad' };
const ToastCtx = React.createContext<(text: string, tone?: 'good' | 'bad') => void>(() => {});
export const useToast = () => React.useContext(ToastCtx);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<Toast[]>([]);
  const push = React.useCallback((text: string, tone: 'good' | 'bad' = 'good') => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, text, tone }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-[max(16px,env(safe-area-inset-bottom))] z-[60] grid justify-items-center gap-2 px-4">
        {items.map((t) => (
          <div key={t.id} className={cn('fade-up max-w-[560px] rounded-xl px-4 py-3 font-bold shadow-xl', t.tone === 'good' ? 'bg-ink text-bg' : 'bg-bad text-white')}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
