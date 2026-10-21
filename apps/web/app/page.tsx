'use client';

import Link from 'next/link';
import { ArrowRight, Award, BadgeCheck, CalendarDays, ClipboardCheck, CreditCard, FileText, GraduationCap, MapPin, MessageSquareText, Phone, PencilLine, Star } from 'lucide-react';
import { PlatformHome, SuspendedSchool } from '@/components/site/platform-home';
import { SiteFooter, SiteHeader } from '@/components/site/chrome';
import { siteList, telHref, useSchoolState } from '@/lib/public-school';
import { date } from '@/lib/format';

const COUNT = ['', 'un', 'deux', 'trois', 'quatre', 'cinq'];

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
  // Chiffres tirés des données réelles de l'école, jamais saisis à la main.
  const figures = s ? [
    { value: s.levels.length, label: s.levels.length > 1 ? 'niveaux d’études' : 'niveau d’études' },
    tracks.length ? { value: tracks.length, label: tracks.length > 1 ? 'filières techniques' : 'filière technique' } : null,
    sites.length ? { value: sites.length, label: sites.length > 1 ? 'sites' : 'site' } : null,
  ].filter((x): x is { value: number; label: string } => !!x && x.value > 0) : [];

  return (
    <>
      <SiteHeader />
      <main>
        {/* Bandeau d'accueil aux couleurs des affiches */}
        <section className="relative overflow-hidden bg-brand-strong text-white">
          {p.heroImage && (
            <div className="absolute inset-0 opacity-25">
              <img src={p.heroImage} alt="" className="size-full object-cover" />
            </div>
          )}
          <div className="absolute inset-0 bg-gradient-to-r from-[#0f2258] via-[#13296a]/90 to-transparent" />
          <div className="relative mx-auto grid max-w-6xl gap-6 px-4 py-14 sm:py-20 md:grid-cols-[1.4fr_1fr] md:items-center">
            <div>
              {p.rentree && (
                <span className="mb-4 inline-flex items-center gap-2 rounded-full bg-yellow px-3 py-1 text-sm font-extrabold text-[#1b1206]">
                  <CalendarDays className="size-4" /> Rentrée scolaire le {date(p.rentree, { day: 'numeric', month: 'long', year: 'numeric' })}
                </span>
              )}
              <h1 className="min-h-[1em] text-[44px] font-bold uppercase leading-[0.95] sm:text-6xl">{s?.name}</h1>
              {p.tagline && <p className="mt-3 text-xl font-bold text-orange">{p.tagline}</p>}
              {(description || where) && <p className="mt-2 max-w-xl text-lg opacity-90">{description}{where}.</p>}
              <div className="mt-6 flex flex-wrap gap-3">
                <Link href="/preinscription" className="inline-flex min-h-12 items-center gap-2 rounded-lg bg-orange px-5 font-extrabold text-[#1b1206] hover:brightness-95">
                  Pré-inscrire mon enfant <ArrowRight className="size-5" />
                </Link>
                {p.phone && (
                  <a href={telHref(p.phone, s?.country)} className="inline-flex min-h-12 items-center gap-2 rounded-lg border border-white/50 px-5 font-bold hover:bg-white/10">
                    <Phone className="size-5" /> {p.phone}
                  </a>
                )}
              </div>
            </div>
            <ul className="grid gap-2.5">
              {(p.highlights ?? []).map((h) => (
                <li key={h} className="flex items-center gap-3 rounded-xl bg-white/10 px-4 py-3 text-lg font-bold backdrop-blur">
                  <BadgeCheck className="size-6 flex-none text-yellow" /> {h}
                </li>
              ))}
            </ul>
          </div>
          <div className="relative flex h-2">
            <span className="flex-1 bg-red" />
            <span className="flex-1 bg-orange" />
            <span className="flex-1 bg-yellow" />
          </div>
        </section>

        {/* Chiffres clés */}
        {figures.length > 0 && (
          <section className="mx-auto max-w-6xl px-4">
            <div className="-mt-px grid grid-cols-2 gap-px overflow-hidden rounded-b-2xl bg-line sm:grid-cols-4">
              {figures.map((f) => (
                <div key={f.label} className="bg-surface px-4 py-5 text-center">
                  <p className="tabular font-display text-4xl font-bold text-brand">{f.value}</p>
                  <p className="text-sm font-bold text-muted">{f.label}</p>
                </div>
              ))}
              {p.entranceTest && (
                <div className="bg-surface px-4 py-5 text-center">
                  <p className="font-display text-2xl font-bold text-orange">{date(p.entranceTest, { day: 'numeric', month: 'long' })}</p>
                  <p className="text-sm font-bold text-muted">test d’entrée</p>
                </div>
              )}
            </div>
          </section>
        )}

        {/* Élèves à l'honneur, choisis par la direction */}
        {honors.length > 0 && (
          <section id="honneur" className="mx-auto max-w-6xl scroll-mt-20 px-4 pt-14">
            <p className="flex items-center gap-2 font-bold uppercase tracking-wider text-orange"><Star className="size-4 fill-current" /> Tableau d’honneur</p>
            <h2 className="text-4xl font-bold">Nos élèves à l’honneur</h2>
            <p className="mt-1 max-w-2xl text-muted">Bravo à nos meilleurs élèves pour leur travail et leurs résultats.</p>
            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {honors.map((h, i) => (
                <article key={h.id} className={`relative overflow-hidden rounded-2xl border bg-surface p-5 ${i === 0 ? 'border-yellow shadow-[0_0_0_3px] shadow-yellow/30' : 'border-line'}`}>
                  <div className="flex items-center gap-4">
                    {h.photoUrl ? (
                      <img src={h.photoUrl} alt={h.displayName} className="size-20 flex-none rounded-full border-4 border-yellow object-cover" />
                    ) : (
                      <div className="grid size-20 flex-none place-items-center rounded-full border-4 border-yellow bg-brand font-display text-3xl font-bold text-brand-ink">{h.displayName.charAt(0)}</div>
                    )}
                    <div className="min-w-0">
                      <h3 className="text-2xl font-bold leading-tight">{h.displayName}</h3>
                      <p className="font-bold text-brand">{h.className}</p>
                      <p className="text-sm text-muted">{h.term}</p>
                    </div>
                  </div>
                  {(h.average !== null || h.distinction) && (
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      {h.average !== null && <span className="tabular rounded-lg bg-brand-soft px-3 py-1 font-display text-xl font-bold text-brand">{h.average.toLocaleString('fr-FR')} / 20</span>}
                      {h.distinction && <span className="inline-flex items-center gap-1 rounded-lg bg-yellow/25 px-3 py-1 font-bold"><Award className="size-4" /> {h.distinction}</span>}
                    </div>
                  )}
                </article>
              ))}
            </div>
          </section>
        )}

        {/* Filières */}
        {(tracks.length > 0 || hasCollege) && <section id="filieres" className="mx-auto max-w-6xl scroll-mt-20 px-4 pt-14">
          {tracks.length > 0 && <p className="font-bold uppercase tracking-wider text-orange">Enseignement technique</p>}
          <h2 className="text-4xl font-bold">{tracks.length > 0 ? 'Nos filières' : 'Nos classes'}</h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {tracks.map((t) => (
              <article key={t.code} className="group overflow-hidden rounded-xl border border-line bg-surface">
                {images[t.code] ? (
                  <img src={images[t.code]} alt="" className="aspect-[16/9] w-full object-cover transition-transform group-hover:scale-[1.03]" />
                ) : (
                  <div className="relative grid aspect-[16/9] place-items-center overflow-hidden bg-gradient-to-br from-brand to-brand-strong text-white">
                    <span className="font-display text-6xl font-bold opacity-90">{t.code}</span>
                    <span className="absolute inset-x-0 bottom-0 flex h-1.5"><span className="flex-1 bg-red" /><span className="flex-1 bg-orange" /><span className="flex-1 bg-yellow" /></span>
                  </div>
                )}
                <div className="p-4">
                  <span className="rounded-md bg-brand px-2 py-0.5 text-xs font-extrabold text-brand-ink">{t.code}</span>
                  <h3 className="mt-2 text-xl font-bold">{t.name.replace(/\s*\([^)]*\)$/, '')}</h3>
                </div>
              </article>
            ))}
            {hasCollege && <article className="flex flex-col justify-between rounded-xl border border-line bg-surface p-5">
              <div>
                <GraduationCap className="size-8 text-brand" />
                <h3 className="mt-2 text-xl font-bold">Collège général</h3>
                <p className="mt-1 text-muted">De la 6e à la 3e, préparation au BEPC.</p>
              </div>
              <Link href="/preinscription" className="mt-4 inline-flex items-center gap-1 font-bold text-brand">Demander une place <ArrowRight className="size-4" /></Link>
            </article>}
          </div>
        </section>}

        {/* Pourquoi nous choisir */}
        {(p.reasons?.length ?? 0) > 0 && <section className="mx-auto max-w-6xl px-4 pt-14">
          <div className="grid gap-6 rounded-2xl bg-surface p-6 sm:p-8 md:grid-cols-[1fr_1.3fr] md:items-center">
            <div>
              <h2 className="text-4xl font-bold">Pourquoi nous choisir ?</h2>
              {p.motto && <p className="mt-2 text-xl font-bold text-red">{p.motto}</p>}
            </div>
            <ul className="grid gap-2 sm:grid-cols-2">
              {(p.reasons ?? []).map((r) => (
                <li key={r} className="flex items-start gap-2 rounded-lg bg-sunk px-3 py-2.5 font-bold">
                  <BadgeCheck className="mt-0.5 size-5 flex-none text-good" /> {r}
                </li>
              ))}
            </ul>
          </div>
        </section>}

        {/* Admission */}
        <section id="admission" className="mx-auto max-w-6xl scroll-mt-20 px-4 pt-14">
          <p className="font-bold uppercase tracking-wider text-orange">Admission {p.rentree ? new Date(p.rentree).getFullYear() + '-' + (new Date(p.rentree).getFullYear() + 1) : ''}</p>
          <h2 className="text-4xl font-bold">Inscrire votre enfant</h2>
          <ol className="mt-6 grid gap-4 md:grid-cols-3">
            <li className="rounded-xl border border-line bg-surface p-5">
              <span className="grid size-10 place-items-center rounded-full bg-brand font-display text-xl font-bold text-brand-ink">1</span>
              <h3 className="mt-3 flex items-center gap-2 text-xl font-bold"><PencilLine className="size-5 text-orange" /> Pré-inscription en ligne</h3>
              <p className="mt-1 text-muted">Remplissez le formulaire depuis votre téléphone : l’école vous rappelle.</p>
              <Link href="/preinscription" className="mt-3 inline-flex items-center gap-1 font-bold text-brand">Commencer <ArrowRight className="size-4" /></Link>
            </li>
            <li className="rounded-xl border border-line bg-surface p-5">
              <span className="grid size-10 place-items-center rounded-full bg-brand font-display text-xl font-bold text-brand-ink">2</span>
              <h3 className="mt-3 flex items-center gap-2 text-xl font-bold"><ClipboardCheck className="size-5 text-orange" /> {p.entranceTest ? 'Test d’entrée' : 'Rendez-vous à l’école'}</h3>
              <p className="mt-1 text-muted">{p.entranceTest ? `Le ${date(p.entranceTest, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, sur le site choisi.` : 'L’école vous indique la date de votre rendez-vous.'}</p>
            </li>
            <li className="rounded-xl border border-line bg-surface p-5">
              <span className="grid size-10 place-items-center rounded-full bg-brand font-display text-xl font-bold text-brand-ink">3</span>
              <h3 className="mt-3 flex items-center gap-2 text-xl font-bold"><FileText className="size-5 text-orange" /> Dossier d’inscription</h3>
              {docs.length > 0 ? (
                <ul className="mt-1 grid gap-0.5 text-muted">
                  {docs.slice(0, 4).map((d) => <li key={d} className="flex gap-1.5"><BadgeCheck className="mt-0.5 size-4 flex-none text-good" /> {d}</li>)}
                  {docs.length > 4 && <li><Link href="/preinscription" className="font-bold text-brand">et {docs.length - 4} autre{docs.length - 4 > 1 ? 's' : ''} pièce{docs.length - 4 > 1 ? 's' : ''}</Link></li>}
                </ul>
              ) : <p className="mt-1 text-muted">Déposez le dossier complet au secrétariat pour confirmer l’inscription.</p>}
            </li>
          </ol>
        </section>

        {/* L'espace numérique */}
        <section className="mx-auto max-w-6xl px-4 pt-14">
          <h2 className="text-4xl font-bold">Suivez la scolarité depuis votre téléphone</h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            {[
              { icon: GraduationCap, t: 'Notes et bulletins', d: 'Les notes dès leur publication et le bulletin officiel avec QR code.' },
              { icon: MessageSquareText, t: 'Absences et messages', d: 'Un message le jour même en cas d’absence, justification par photo.' },
              { icon: CreditCard, t: 'Frais scolaires', d: 'Solde à jour, paiement Mobile Money et reçu immédiat.' },
            ].map(({ icon: I, t, d }) => (
              <div key={t} className="rounded-xl border border-line bg-surface p-5">
                <I className="size-8 text-orange" />
                <h3 className="mt-2 text-xl font-bold">{t}</h3>
                <p className="mt-1 text-muted">{d}</p>
              </div>
            ))}
          </div>
          <Link href="/connexion" className="mt-5 inline-flex min-h-12 items-center gap-2 rounded-lg bg-brand px-5 font-extrabold text-brand-ink hover:bg-brand-strong">
            Accéder à mon espace <ArrowRight className="size-5" />
          </Link>
        </section>

        {/* Sites */}
        <section id="sites" className="mx-auto max-w-6xl scroll-mt-20 px-4 pt-14">
          <h2 className="text-4xl font-bold">{sites.length === 1 ? 'Notre site' : 'Nos sites'}</h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {sites.map((site) => (
              <div key={site.id} className="rounded-xl border border-line bg-surface p-5">
                <h3 className="text-2xl font-bold text-brand">{site.name}</h3>
                {site.address && (
                  <p className="mt-2 flex items-start gap-2"><MapPin className="mt-0.5 size-5 flex-none text-red" /> {site.address}</p>
                )}
                {site.phone && (
                  <a href={telHref(site.phone, s?.country)} className="mt-2 flex items-center gap-2 font-bold hover:underline"><Phone className="size-5 text-good" /> {site.phone}</a>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* Appel final */}
        <section className="mx-auto max-w-6xl px-4 py-14">
          <div className="grid gap-4 rounded-2xl bg-brand-strong p-6 text-white sm:p-8 md:grid-cols-[1fr_auto] md:items-center">
            <div>
              <h2 className="text-3xl font-bold">Une place pour votre enfant{p.rentree ? ` à la rentrée ${new Date(p.rentree).getFullYear()}` : ''} ?</h2>
              <p className="mt-1 opacity-90">Pré-inscrivez-le en quelques minutes ou appelez-nous.</p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link href="/preinscription" className="inline-flex min-h-12 items-center gap-2 rounded-lg bg-orange px-5 font-extrabold text-[#1b1206] hover:brightness-95">Pré-inscrire mon enfant <ArrowRight className="size-5" /></Link>
              {p.phone && <a href={telHref(p.phone, s?.country)} className="inline-flex min-h-12 items-center gap-2 rounded-lg border border-white/50 px-5 font-bold hover:bg-white/10"><Phone className="size-5" /> {p.phone}</a>}
            </div>
          </div>
        </section>
      </main>
      {/* Bouton toujours visible sur téléphone */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface/95 p-3 backdrop-blur sm:hidden no-print">
        <Link href="/preinscription" className="flex min-h-12 items-center justify-center gap-2 rounded-lg bg-orange font-extrabold text-[#1b1206]">Pré-inscrire mon enfant <ArrowRight className="size-5" /></Link>
      </div>
      <SiteFooter />
      <div className="h-[72px] sm:hidden" />
    </>
  );
}
