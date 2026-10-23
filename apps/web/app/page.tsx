'use client';

import Link from 'next/link';
import { ArrowRight, Award, BadgeCheck, CalendarDays, ClipboardCheck, CreditCard, FileText, GraduationCap, MapPin, MessageSquareText, Phone, PencilLine, Sparkles, Star } from 'lucide-react';
import { PlatformHome, SuspendedSchool } from '@/components/site/platform-home';
import { SiteFooter, SiteHeader } from '@/components/site/chrome';
import { siteList, telHref, useSchoolState } from '@/lib/public-school';
import { date } from '@/lib/format';

const COUNT = ['', 'un', 'deux', 'trois', 'quatre', 'cinq'];

/** Illustrations générées avec Canva, communes à toutes les écoles (aucune donnée propre à une école). */
const ILLUSTRATIONS = {
  hero: '/illustrations/accueil.webp',
  classe: '/illustrations/classe.webp',
  inscription: '/illustrations/inscription.webp',
  parents: '/illustrations/espace-parents.webp',
};

/** Offre de l'école décrite d'après ses niveaux réels : « Collège général de la 6e à la 3e et lycée technique ». */
function offer(levels: { name: string; cycle: string }[]) {
  const by = (c: string) => levels.filter((l) => l.cycle === c).map((l) => l.name);
  const span = (names: string[]) => (names.length > 1 ? ` de la ${names[0]} à la ${names[names.length - 1]}` : '');
  const parts = [
    by('MATERNELLE').length && 'Maternelle',
    by('PRIMAIRE').length && `Primaire${by('PRIMAIRE').length > 1 ? ` du ${by('PRIMAIRE')[0]} au ${by('PRIMAIRE').at(-1)}` : ''}`,
    by('COLLEGE').length && `Collège général${span(by('COLLEGE'))}`,
    by('LYCEE_GENERAL').length && 'lycée général',
    by('LYCEE_TECHNIQUE').length && 'lycée technique',
  ].filter(Boolean) as string[];
  const text = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} et ${parts.at(-1)}` : parts[0] ?? '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function Eyebrow({ children, light = false }: { children: React.ReactNode; light?: boolean }) {
  return (
    <p className={`flex items-center gap-2 text-sm font-extrabold uppercase tracking-[0.14em] ${light ? 'text-yellow' : 'text-orange'}`}>
      <span className={`h-0.5 w-6 rounded-full ${light ? 'bg-yellow' : 'bg-orange'}`} /> {children}
    </p>
  );
}

/** Illustration encadrée, posée sur des formes aux couleurs de l'école. */
function Illustration({ src, alt, priority = false, flip = false }: { src: string; alt: string; priority?: boolean; flip?: boolean }) {
  return (
    <div className="relative mx-auto w-full max-w-xl">
      <span aria-hidden className={`absolute -top-5 size-28 rounded-full bg-yellow/70 sm:size-36 ${flip ? '-left-4' : '-right-4'}`} />
      <span aria-hidden className={`absolute -bottom-5 size-20 rounded-[1.75rem] bg-brand/90 sm:size-24 ${flip ? '-right-3 rotate-12' : '-left-3 -rotate-12'}`} />
      <img
        src={src}
        alt={alt}
        width={1200}
        height={900}
        loading={priority ? 'eager' : 'lazy'}
        decoding="async"
        className="relative aspect-[4/3] w-full rounded-[2rem] object-cover shadow-[0_24px_60px_-24px_rgba(19,41,106,0.45)] ring-1 ring-black/5"
      />
    </div>
  );
}

export default function Home() {
  const state = useSchoolState();
  if (state.status === 'none') return <PlatformHome />;
  if (state.status === 'ready' && state.school.suspended) return <SuspendedSchool name={state.school.name} />;
  const s = state.status === 'ready' ? state.school : null;
  const p = s?.public ?? {};
  const sites = s?.sites ?? [];
  const images = p.trackImages ?? {};
  const tracks = [...(s?.tracks ?? []).filter((t) => t.cycle === 'LYCEE_TECHNIQUE')].sort((a, b) => Number(!images[a.code]) - Number(!images[b.code]));
  const hasCollege = !!s?.levels.some((l) => l.cycle === 'COLLEGE');
  const where = sites.length > 1 ? ` sur ${COUNT[sites.length] ?? sites.length} sites, ${siteList(sites.map((x) => x.name))}` : sites.length === 1 ? ` à ${sites[0].name}` : '';
  const description = s ? offer(s.levels) : '';
  const honors = s?.honors ?? [];
  const docs = p.requiredDocuments ?? [];
  const year = p.rentree ? new Date(p.rentree).getFullYear() : null;
  // Chiffres tirés des données réelles de l'école, jamais saisis à la main.
  const figures = s ? [
    { value: s.levels.length, label: s.levels.length > 1 ? 'niveaux d’études' : 'niveau d’études' },
    tracks.length ? { value: tracks.length, label: tracks.length > 1 ? 'filières techniques' : 'filière technique' } : null,
    sites.length ? { value: sites.length, label: sites.length > 1 ? 'sites' : 'site' } : null,
  ].filter((x): x is { value: number; label: string } => !!x && x.value > 0) : [];

  return (
    <>
      <SiteHeader />
      <main className="overflow-x-clip">
        {/* Bandeau d'accueil */}
        <section className="relative overflow-hidden bg-cream">
          <span aria-hidden className="absolute -left-24 -top-24 size-72 rounded-full bg-brand-soft blur-2xl" />
          <span aria-hidden className="absolute -right-16 bottom-0 size-80 rounded-full bg-orange-soft blur-3xl" />
          <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-4 pb-20 pt-10 sm:pt-14 md:grid-cols-[1.05fr_1fr] md:pb-24">
            <div className="fade-up">
              {p.rentree && (
                <span className="mb-5 inline-flex items-center gap-2 rounded-full border border-orange/30 bg-surface px-3.5 py-1.5 text-sm font-extrabold text-orange shadow-sm">
                  <CalendarDays className="size-4" /> Rentrée le {date(p.rentree, { day: 'numeric', month: 'long', year: 'numeric' })}
                </span>
              )}
              <h1 className="min-h-[1em] text-[42px] font-bold uppercase leading-[0.95] text-brand-strong dark:text-ink sm:text-6xl">{s?.name}</h1>
              {p.tagline && <p className="mt-4 text-xl font-bold text-orange sm:text-2xl">{p.tagline}</p>}
              {(description || where) && <p className="mt-3 max-w-xl text-lg text-muted">{description}{where}.</p>}
              <div className="mt-7 flex flex-wrap gap-3">
                <Link href="/preinscription" className="inline-flex min-h-12 items-center gap-2 rounded-full bg-orange px-6 font-extrabold text-[#1b1206] shadow-[0_10px_24px_-10px_rgba(238,125,23,0.8)] transition hover:-translate-y-0.5 hover:brightness-95">
                  Pré-inscrire mon enfant <ArrowRight className="size-5" />
                </Link>
                {p.phone && (
                  <a href={telHref(p.phone, s?.country)} className="inline-flex min-h-12 items-center gap-2 rounded-full border border-line bg-surface px-6 font-bold text-ink transition hover:border-brand">
                    <Phone className="size-5 text-brand" /> {p.phone}
                  </a>
                )}
              </div>
              {(p.highlights?.length ?? 0) > 0 && (
                <ul className="mt-8 flex flex-wrap gap-2">
                  {(p.highlights ?? []).map((h) => (
                    <li key={h} className="inline-flex items-center gap-1.5 rounded-full bg-surface px-3 py-1.5 text-sm font-bold text-ink ring-1 ring-line">
                      <BadgeCheck className="size-4 flex-none text-good" /> {h}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="relative">
              <Illustration src={ILLUSTRATIONS.hero} alt="Élèves en uniforme devant leur école" priority />
              {p.entranceTest && (
                <div className="absolute -bottom-6 left-2 flex items-center gap-3 rounded-2xl bg-surface px-4 py-3 shadow-xl ring-1 ring-line sm:left-6">
                  <span className="grid size-11 place-items-center rounded-xl bg-orange-soft text-orange"><ClipboardCheck className="size-6" /></span>
                  <span className="leading-tight">
                    <span className="block text-xs font-bold uppercase tracking-wide text-muted">Test d’entrée</span>
                    <span className="block font-display text-xl font-bold">{date(p.entranceTest, { day: 'numeric', month: 'long' })}</span>
                  </span>
                </div>
              )}
              {honors[0] && (
                <a href="#honneur" className="absolute -top-4 right-2 hidden items-center gap-2 rounded-2xl bg-surface px-3 py-2 shadow-xl ring-1 ring-line sm:flex">
                  <span className="grid size-9 place-items-center rounded-full bg-yellow/30 text-[#8a5a00] dark:text-yellow"><Star className="size-5 fill-current" /></span>
                  <span className="text-sm font-bold leading-tight">Nos lauréats<br /><span className="font-normal text-muted">à l’honneur</span></span>
                </a>
              )}
            </div>
          </div>
        </section>

        {/* Chiffres clés */}
        {figures.length > 0 && (
          <section className="relative mx-auto -mt-10 max-w-5xl px-4">
            <div className="grid auto-cols-fr grid-flow-col divide-x divide-line rounded-3xl bg-surface p-2 shadow-[0_20px_50px_-28px_rgba(19,41,106,0.5)] ring-1 ring-line">
              {figures.map((f) => (
                <div key={f.label} className="px-2 py-4 text-center sm:px-4 sm:py-5">
                  <p className="tabular font-display text-4xl font-bold text-brand sm:text-5xl">{f.value}</p>
                  <p className="mt-1 text-xs font-bold text-muted sm:text-sm">{f.label}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Élèves à l'honneur, choisis par la direction */}
        {honors.length > 0 && (
          <section id="honneur" className="mx-auto max-w-6xl scroll-mt-20 px-4 pt-20">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <Eyebrow>Tableau d’honneur</Eyebrow>
                <h2 className="mt-2 text-4xl font-bold sm:text-5xl">Nos élèves à l’honneur</h2>
              </div>
              <p className="max-w-sm text-muted">Bravo à nos meilleurs élèves pour leur travail et leurs résultats.</p>
            </div>
            <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {honors.map((h, i) => (
                <article key={h.id} className={`relative overflow-hidden rounded-3xl bg-surface p-6 ring-1 transition hover:-translate-y-1 hover:shadow-xl ${i === 0 ? 'ring-2 ring-yellow' : 'ring-line'}`}>
                  <span aria-hidden className="absolute inset-x-0 top-0 h-20 bg-gradient-to-br from-brand-soft to-orange-soft" />
                  {i === 0 && <span className="absolute right-4 top-4 inline-flex items-center gap-1 rounded-full bg-yellow px-2.5 py-1 text-xs font-extrabold text-[#1b1206]"><Sparkles className="size-3.5" /> Major</span>}
                  <div className="relative flex flex-col items-center text-center">
                    {h.photoUrl ? (
                      <img src={h.photoUrl} alt={h.displayName} className="size-24 rounded-full border-4 border-surface object-cover shadow-md" />
                    ) : (
                      <div className="grid size-24 place-items-center rounded-full border-4 border-surface bg-brand font-display text-4xl font-bold text-brand-ink shadow-md">{h.displayName.charAt(0)}</div>
                    )}
                    <h3 className="mt-3 text-2xl font-bold leading-tight">{h.displayName}</h3>
                    <p className="font-bold text-brand">{h.className}</p>
                    <p className="text-sm text-muted">{h.term}</p>
                    {(h.average !== null || h.distinction) && (
                      <div className="mt-4 flex flex-wrap justify-center gap-2">
                        {h.average !== null && <span className="tabular rounded-full bg-brand-soft px-3.5 py-1 font-display text-xl font-bold text-brand">{h.average.toLocaleString('fr-FR')} / 20</span>}
                        {h.distinction && <span className="inline-flex items-center gap-1 rounded-full bg-yellow/25 px-3.5 py-1 font-bold"><Award className="size-4" /> {h.distinction}</span>}
                      </div>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}

        {/* Filières */}
        {(tracks.length > 0 || hasCollege) && <section id="filieres" className="mx-auto max-w-6xl scroll-mt-20 px-4 pt-20">
          <Eyebrow>{tracks.length > 0 ? 'Enseignement technique' : 'Enseignement'}</Eyebrow>
          <h2 className="mt-2 text-4xl font-bold sm:text-5xl">{tracks.length > 0 ? 'Nos filières' : 'Nos classes'}</h2>
          <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {tracks.map((t) => (
              <article key={t.code} className="group relative overflow-hidden rounded-3xl bg-surface ring-1 ring-line transition hover:-translate-y-1 hover:shadow-xl">
                {images[t.code] ? (
                  <div className="relative overflow-hidden">
                    <img src={images[t.code]} alt="" loading="lazy" className="aspect-[16/10] w-full object-cover transition-transform duration-500 group-hover:scale-105" />
                    <span aria-hidden className="absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-transparent" />
                  </div>
                ) : (
                  <div className="relative grid aspect-[16/10] place-items-center overflow-hidden bg-gradient-to-br from-brand to-brand-strong text-white">
                    <span aria-hidden className="absolute -right-8 -top-8 size-32 rounded-full bg-white/10" />
                    <span aria-hidden className="absolute -bottom-8 -left-8 size-24 rounded-full bg-orange" />
                    <span className="relative font-display text-6xl font-bold opacity-95">{t.code}</span>
                  </div>
                )}
                <div className="p-5">
                  <span className="rounded-full bg-brand-soft px-2.5 py-0.5 text-xs font-extrabold text-brand">{t.code}</span>
                  <h3 className="mt-2 text-xl font-bold">{t.name.replace(/\s*\([^)]*\)$/, '')}</h3>
                </div>
              </article>
            ))}
            {hasCollege && <article className="relative flex flex-col justify-between overflow-hidden rounded-3xl bg-brand-strong p-6 text-white dark:bg-brand-soft dark:text-ink">
              <span aria-hidden className="absolute -right-10 -top-10 size-40 rounded-full bg-white/10" />
              <div className="relative">
                <span className="grid size-12 place-items-center rounded-2xl bg-white/15"><GraduationCap className="size-7" /></span>
                <h3 className="mt-4 text-2xl font-bold">Collège général</h3>
                <p className="mt-1 opacity-85">De la 6e à la 3e, préparation au BEPC.</p>
              </div>
              <Link href="/preinscription" className="relative mt-6 inline-flex items-center gap-1 font-bold text-yellow">Demander une place <ArrowRight className="size-4" /></Link>
            </article>}
          </div>
        </section>}

        {/* Pourquoi nous choisir */}
        {(p.reasons?.length ?? 0) > 0 && <section className="mx-auto max-w-6xl px-4 pt-24">
          <div className="grid items-center gap-12 md:grid-cols-2">
            <Illustration src={ILLUSTRATIONS.classe} alt="Un professeur fait cours à des élèves attentifs" />
            <div>
              <Eyebrow>Notre engagement</Eyebrow>
              <h2 className="mt-2 text-4xl font-bold sm:text-5xl">Pourquoi nous choisir ?</h2>
              {p.motto && <p className="mt-3 border-l-4 border-red pl-3 text-xl font-bold italic text-red">« {p.motto} »</p>}
              <ul className="mt-6 grid gap-3">
                {(p.reasons ?? []).map((r) => (
                  <li key={r} className="flex items-start gap-3 rounded-2xl bg-surface px-4 py-3 font-bold ring-1 ring-line">
                    <span className="grid size-7 flex-none place-items-center rounded-full bg-good-soft text-good"><BadgeCheck className="size-4" /></span> {r}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>}

        {/* Admission */}
        <section id="admission" className="mx-auto max-w-6xl scroll-mt-20 px-4 pt-24">
          <div className="grid items-center gap-12 md:grid-cols-2">
            <div className="md:order-2">
              <Illustration src={ILLUSTRATIONS.inscription} alt="Une maman pré-inscrit son enfant depuis son téléphone" flip />
            </div>
            <div>
              <Eyebrow>Admission {year ? `${year}-${year + 1}` : ''}</Eyebrow>
              <h2 className="mt-2 text-4xl font-bold sm:text-5xl">Inscrire votre enfant</h2>
              <ol className="relative mt-7 grid gap-6 before:absolute before:bottom-6 before:left-5 before:top-6 before:w-0.5 before:bg-line">
                <li className="relative flex gap-4">
                  <span className="relative grid size-10 flex-none place-items-center rounded-full bg-brand font-display text-xl font-bold text-brand-ink ring-4 ring-bg">1</span>
                  <div>
                    <h3 className="flex items-center gap-2 text-xl font-bold"><PencilLine className="size-5 text-orange" /> Pré-inscription en ligne</h3>
                    <p className="mt-0.5 text-muted">Remplissez le formulaire depuis votre téléphone : l’école vous rappelle.</p>
                    <Link href="/preinscription" className="mt-1.5 inline-flex items-center gap-1 font-bold text-brand">Commencer <ArrowRight className="size-4" /></Link>
                  </div>
                </li>
                <li className="relative flex gap-4">
                  <span className="relative grid size-10 flex-none place-items-center rounded-full bg-brand font-display text-xl font-bold text-brand-ink ring-4 ring-bg">2</span>
                  <div>
                    <h3 className="flex items-center gap-2 text-xl font-bold"><ClipboardCheck className="size-5 text-orange" /> {p.entranceTest ? 'Test d’entrée' : 'Rendez-vous à l’école'}</h3>
                    <p className="mt-0.5 text-muted">{p.entranceTest ? `Le ${date(p.entranceTest, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, sur le site choisi.` : 'L’école vous indique la date de votre rendez-vous.'}</p>
                  </div>
                </li>
                <li className="relative flex gap-4">
                  <span className="relative grid size-10 flex-none place-items-center rounded-full bg-brand font-display text-xl font-bold text-brand-ink ring-4 ring-bg">3</span>
                  <div>
                    <h3 className="flex items-center gap-2 text-xl font-bold"><FileText className="size-5 text-orange" /> Dossier d’inscription</h3>
                    {docs.length > 0 ? (
                      <ul className="mt-1 grid gap-0.5 text-muted">
                        {docs.slice(0, 4).map((d) => <li key={d} className="flex gap-1.5"><BadgeCheck className="mt-0.5 size-4 flex-none text-good" /> {d}</li>)}
                        {docs.length > 4 && <li><Link href="/preinscription" className="font-bold text-brand">et {docs.length - 4} autre{docs.length - 4 > 1 ? 's' : ''} pièce{docs.length - 4 > 1 ? 's' : ''}</Link></li>}
                      </ul>
                    ) : <p className="mt-0.5 text-muted">Déposez le dossier complet au secrétariat pour confirmer l’inscription.</p>}
                  </div>
                </li>
              </ol>
            </div>
          </div>
        </section>

        {/* L'espace numérique */}
        <section className="mx-auto max-w-6xl px-4 pt-24">
          <div className="relative overflow-hidden rounded-[2.5rem] bg-brand-strong text-white dark:bg-surface dark:text-ink dark:ring-1 dark:ring-line">
            <span aria-hidden className="absolute -right-20 -top-20 size-72 rounded-full bg-white/5" />
            <span aria-hidden className="absolute -bottom-24 left-1/3 size-72 rounded-full bg-orange/20 blur-2xl" />
            <div className="relative grid items-center gap-10 p-6 sm:p-10 md:grid-cols-[1.1fr_1fr]">
              <div>
                <Eyebrow light>Espace parents et élèves</Eyebrow>
                <h2 className="mt-2 text-4xl font-bold sm:text-5xl">Suivez la scolarité depuis votre téléphone</h2>
                <div className="mt-7 grid gap-3">
                  {[
                    { icon: GraduationCap, t: 'Notes et bulletins', d: 'Les notes dès leur publication et le bulletin officiel avec QR code.' },
                    { icon: MessageSquareText, t: 'Absences et messages', d: 'Un message le jour même en cas d’absence, justification par photo.' },
                    { icon: CreditCard, t: 'Frais scolaires', d: 'Solde à jour, paiement Mobile Money et reçu immédiat.' },
                  ].map(({ icon: I, t, d }) => (
                    <div key={t} className="flex gap-4 rounded-2xl bg-white/8 p-4 ring-1 ring-white/10 dark:bg-sunk dark:ring-line">
                      <span className="grid size-11 flex-none place-items-center rounded-xl bg-orange text-[#1b1206]"><I className="size-6" /></span>
                      <div>
                        <h3 className="text-lg font-bold">{t}</h3>
                        <p className="opacity-80">{d}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <Link href="/connexion" className="mt-7 inline-flex min-h-12 items-center gap-2 rounded-full bg-yellow px-6 font-extrabold text-[#1b1206] transition hover:-translate-y-0.5">
                  Accéder à mon espace <ArrowRight className="size-5" />
                </Link>
              </div>
              <img src={ILLUSTRATIONS.parents} alt="Un papa consulte les notes et les paiements sur son téléphone" width={1200} height={900} loading="lazy" decoding="async" className="aspect-[4/3] w-full rounded-[2rem] object-cover ring-4 ring-white/10" />
            </div>
          </div>
        </section>

        {/* Sites */}
        <section id="sites" className="mx-auto max-w-6xl scroll-mt-20 px-4 pt-24">
          <Eyebrow>Nous trouver</Eyebrow>
          <h2 className="mt-2 text-4xl font-bold sm:text-5xl">{sites.length === 1 ? 'Notre site' : 'Nos sites'}</h2>
          <div className="mt-8 grid gap-5 sm:grid-cols-2">
            {sites.map((site) => (
              <div key={site.id} className="flex gap-4 rounded-3xl bg-surface p-6 ring-1 ring-line">
                <span className="grid size-12 flex-none place-items-center rounded-2xl bg-brand-soft text-brand"><MapPin className="size-6" /></span>
                <div className="min-w-0">
                  <h3 className="text-2xl font-bold text-brand">{site.name}</h3>
                  {site.address && <p className="mt-1 text-muted">{site.address}</p>}
                  {site.phone && (
                    <a href={telHref(site.phone, s?.country)} className="mt-2 inline-flex items-center gap-2 font-bold hover:underline"><Phone className="size-4 text-good" /> {site.phone}</a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Appel final */}
        <section className="mx-auto max-w-6xl px-4 pb-4 pt-20">
          <div className="relative overflow-hidden rounded-[2.5rem] bg-gradient-to-br from-orange to-red p-8 text-white sm:p-12">
            <span aria-hidden className="absolute -right-16 -top-16 size-64 rounded-full bg-yellow/30" />
            <span aria-hidden className="absolute -bottom-24 left-1/3 size-56 rounded-full bg-white/10" />
            <div className="relative grid gap-6 md:grid-cols-[1fr_auto] md:items-center">
              <div>
                <h2 className="text-3xl font-bold sm:text-4xl">Une place pour votre enfant{year ? ` à la rentrée ${year}` : ''} ?</h2>
                <p className="mt-2 text-lg opacity-95">Pré-inscrivez-le en quelques minutes ou appelez-nous.</p>
              </div>
              <div className="flex flex-wrap gap-3">
                <Link href="/preinscription" className="inline-flex min-h-12 items-center gap-2 rounded-full bg-white px-6 font-extrabold text-[#7a2a0a] transition hover:-translate-y-0.5">Pré-inscrire mon enfant <ArrowRight className="size-5" /></Link>
                {p.phone && <a href={telHref(p.phone, s?.country)} className="inline-flex min-h-12 items-center gap-2 rounded-full border border-white/60 px-6 font-bold hover:bg-white/10"><Phone className="size-5" /> {p.phone}</a>}
              </div>
            </div>
          </div>
        </section>
      </main>
      {/* Bouton toujours visible sur téléphone */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface/95 p-3 backdrop-blur sm:hidden no-print">
        <Link href="/preinscription" className="flex min-h-12 items-center justify-center gap-2 rounded-full bg-orange font-extrabold text-[#1b1206]">Pré-inscrire mon enfant <ArrowRight className="size-5" /></Link>
      </div>
      <SiteFooter />
      <div className="h-[72px] sm:hidden" />
    </>
  );
}
