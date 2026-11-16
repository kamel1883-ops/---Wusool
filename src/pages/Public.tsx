import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, useApi, type Me } from '../lib/api';
import { useSession } from '../lib/session';
import { errorKey, formatSAR } from '../lib/i18n';
import { LEGAL } from '../lib/legal';
import {
  Alert,
  Button,
  Card,
  CopyValue,
  Field,
  Input,
  Loading,
  Select,
  StatusBadge,
  Table,
} from '../components/ui';
import { FullPageLoading } from '../components/Shell';

type BrandingPayload = {
  branding: {
    nameAr: string;
    nameEn: string;
    taglineAr: string;
    taglineEn: string;
    logoUrl: string;
    primaryColor: string;
    inkColor: string;
    website: string;
  };
  support: { email: string; whatsapp: string };
  platform: { setupCompleted: boolean; defaultLocale: 'ar' | 'en'; supportedLocales: string[] };
};

/** Redirect target after a successful sign-in. */
export function landingRouteFor(me: Me) {
  if (me.user.mustChangePassword) return '/change-password';
  if (me.companies.length > 0) return `/app/${me.companies[0].id}`;
  if (me.user.platformRole === 'super_admin') return '/admin';
  return '/app';
}

/**
 * Brand mark that never renders a broken image: if the URL configured in the
 * admin settings points at a missing file, we fall back to the shipped mark.
 */
function BrandLogo({ className }: { className?: string }) {
  const { me } = useSession();
  const configured = me?.branding.logoUrl?.trim();
  const [src, setSrc] = useState(configured || '/brand/logo.svg');

  useEffect(() => {
    setSrc(configured || '/brand/logo.svg');
  }, [configured]);

  return (
    <img
      src={src}
      alt=""
      className={className}
      onError={() => {
        if (src !== '/brand/logo.svg') setSrc('/brand/logo.svg');
      }}
    />
  );
}

/** Scroll to `#anchor` links, including when arriving from another page. */
function useHashScroll() {
  const location = useLocation();
  useEffect(() => {
    if (!location.hash) return;
    const id = decodeURIComponent(location.hash.slice(1));
    const target = document.getElementById(id);
    if (!target) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  }, [location.hash, location.pathname]);
}

function PublicLayout({ children }: { children: ReactNode }) {
  const { me, locale, setLocale, t } = useSession();
  const brandName = me?.branding.nameAr ?? 'وصول';
  const brandLatin = me?.branding.nameEn ?? 'Wusool';
  const supportEmail = me?.support.email ?? '';
  const supportWhatsapp = me?.support.whatsapp ?? '';
  useHashScroll();

  return (
    <div className="public">
      <header className="public-head">
        <Link to="/" className="public-brand">
          <BrandLogo className="logo-tile" />
          <div>
            <strong>{locale === 'ar' ? brandName : me?.branding.nameEn ?? 'Wusool'}</strong>
            <span>{locale === 'ar' ? me?.branding.taglineEn ?? 'Wusool' : brandName}</span>
          </div>
        </Link>
        <nav className="public-nav">
          <Link to="/#journey">{t('lp.nav.journey')}</Link>
          <Link to="/#features">{t('lp.nav.features')}</Link>
          <Link to="/#plans">{t('lp.nav.plans')}</Link>
          <Link to="/#faq">{t('lp.nav.faq')}</Link>
          <div className="lang-switch" role="group" aria-label="language">
            <button
              type="button"
              className={locale === 'ar' ? 'lang-active' : undefined}
              onClick={() => void setLocale('ar')}
            >
              ع
            </button>
            <button
              type="button"
              className={locale === 'en' ? 'lang-active' : undefined}
              onClick={() => void setLocale('en')}
            >
              EN
            </button>
          </div>
          <Link to={me ? landingRouteFor(me) : '/login'} className="btn btn-secondary btn-sm">
            {me ? t('nav.dashboard') : t('auth.signIn')}
          </Link>
        </nav>
      </header>
      {children}
      <footer className="lp-footer">
        <div className="lp-footer-main">
          <div className="lp-footer-brand">
            <div className="lp-footer-logo">
              <BrandLogo />
              <div>
                <strong>{brandName}</strong>
                <span dir={locale === 'ar' ? 'ltr' : 'rtl'}>{brandLatin}</span>
              </div>
            </div>
            <p>{t('lp.footer.tagline')}</p>
          </div>

          <div className="lp-footer-col">
            <h4>{t('lp.footer.product')}</h4>
            <Link to="/#journey">{t('lp.nav.journey')}</Link>
            <Link to="/#features">{t('lp.nav.features')}</Link>
            <Link to="/#plans">{t('lp.nav.plans')}</Link>
            <Link to="/#faq">{t('lp.nav.faq')}</Link>
          </div>

          <div className="lp-footer-col">
            <h4>{t('lp.footer.legal')}</h4>
            <Link to="/terms">{t('landing.terms')}</Link>
            <Link to="/privacy">{t('landing.privacy')}</Link>
            <Link to="/support">{t('legal.supportTitle')}</Link>
          </div>

          <div className="lp-footer-col">
            <h4>{t('lp.footer.contact')}</h4>
            {/* Real, admin-managed contact data only — no placeholders. */}
            <a href={`mailto:${supportEmail || 'info@jadara-hr.com'}`} dir="ltr">
              {supportEmail || 'info@jadara-hr.com'}
            </a>
            {supportWhatsapp ? <span dir="ltr">{supportWhatsapp}</span> : null}
            <Link to="/order" className="lp-footer-cta">
              {t('lp.hero.ctaPrimary')}
            </Link>
            <span className="lp-footer-note">{t('lp.footer.payNote')}</span>
          </div>
        </div>
        <div className="lp-footer-bottom">
          <span>
            © {new Date().getFullYear()} {brandName} · {t('lp.footer.rights')}
          </span>
          <span className="lp-footer-bottom-links">
            <Link to="/login">{t('auth.signIn')}</Link>
            <Link to="/order">{t('lp.hero.ctaPrimary')}</Link>
          </span>
        </div>
      </footer>
    </div>
  );
}

/* ==========================================================================
   Landing page (B2B SaaS)
   The journey below mirrors what the platform actually does, and each stage
   carries its real delivery status instead of presenting the roadmap as done.
   ========================================================================== */

type StageStatus = 'live' | 'partial' | 'planned';
type GlyphName =
  | 'link'
  | 'scan'
  | 'strategy'
  | 'audience'
  | 'campaign'
  | 'design'
  | 'check'
  | 'follow'
  | 'chart';

const JOURNEY_STAGES: Array<{ n: number; icon: GlyphName; status: StageStatus; anchor: string }> = [
  { n: 1, icon: 'link', status: 'live', anchor: '#analysis' },
  { n: 2, icon: 'scan', status: 'live', anchor: '#analysis' },
  { n: 3, icon: 'strategy', status: 'partial', anchor: '#analysis' },
  { n: 4, icon: 'audience', status: 'partial', anchor: '#analysis' },
  { n: 5, icon: 'campaign', status: 'partial', anchor: '#content' },
  { n: 6, icon: 'design', status: 'planned', anchor: '#content' },
  { n: 7, icon: 'check', status: 'live', anchor: '#approval' },
  { n: 8, icon: 'follow', status: 'planned', anchor: '#leads' },
  { n: 9, icon: 'chart', status: 'planned', anchor: '#reports' },
];

const STATUS_LABEL: Record<StageStatus, string> = {
  live: 'lp.journey.statusLive',
  partial: 'lp.journey.statusPartial',
  planned: 'lp.journey.statusPlanned',
};

function Glyph({ name, size = 22 }: { name: GlyphName; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (name) {
    case 'link':
      return (
        <svg {...common}>
          <path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7l-1 1" />
          <path d="M13.5 10.5a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 0 0 5.7 5.7l1-1" />
        </svg>
      );
    case 'scan':
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="6" />
          <path d="M20 20l-4.6-4.6" />
          <path d="M8.6 11h4.8" />
        </svg>
      );
    case 'strategy':
      return (
        <svg {...common}>
          <path d="M4 18l5-6 4 3 7-9" />
          <circle cx="20" cy="6" r="1.6" />
          <path d="M4 21h16" />
        </svg>
      );
    case 'audience':
      return (
        <svg {...common}>
          <circle cx="9" cy="8" r="3" />
          <path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" />
          <circle cx="17" cy="9" r="2.4" />
          <path d="M14.6 20c0-2.5 1.6-4.2 3.4-4.2s3.4 1.7 3.4 4.2" />
        </svg>
      );
    case 'campaign':
      return (
        <svg {...common}>
          <path d="M4 10v4l3 1 9 4V5L7 9H4z" />
          <path d="M7 15v4" />
          <path d="M19 9.5v5" />
        </svg>
      );
    case 'design':
      return (
        <svg {...common}>
          <rect x="3.5" y="4.5" width="17" height="14" rx="2.5" />
          <circle cx="9" cy="10" r="1.6" />
          <path d="M5 16l4.5-4 3.5 3 3-3.4 4 4.4" />
        </svg>
      );
    case 'check':
      return (
        <svg {...common}>
          <path d="M12 3l7 3v6c0 4.4-3 7.4-7 9-4-1.6-7-4.6-7-9V6l7-3z" />
          <path d="M8.7 12l2.4 2.4 4.3-4.3" />
        </svg>
      );
    case 'follow':
      return (
        <svg {...common}>
          <path d="M20 15a2 2 0 0 1-2 2H8l-4 3V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" />
          <path d="M8 9h8M8 13h5" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="M4 20V11" />
          <path d="M10 20V5" />
          <path d="M16 20v-6" />
          <path d="M22 20H2" />
        </svg>
      );
  }
}

/** Quiet scroll reveal; the animation is disabled by CSS for reduced motion. */
function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShown(true);
          observer.disconnect();
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -6% 0px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`reveal${shown ? ' reveal-in' : ''}${className ? ` ${className}` : ''}`}
      style={delay ? { animationDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const onChange = () => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

function StatusChip({ status, t }: { status: StageStatus; t: (key: string) => string }) {
  return <span className={`lp-status lp-status-${status}`}>{t(STATUS_LABEL[status])}</span>;
}

function SectionHead({ eyebrow, title, sub }: { eyebrow?: string; title: string; sub?: string }) {
  return (
    <header className="lp-head">
      {eyebrow ? <span className="lp-eyebrow">{eyebrow}</span> : null}
      <h2>{title}</h2>
      {sub ? <p>{sub}</p> : null}
    </header>
  );
}

function Hero() {
  const { t } = useSession();
  return (
    <section className="lp-hero">
      <div className="lp-hero-copy">
        <span className="lp-badge">{t('lp.hero.badge')}</span>
        <h1>
          {t('lp.hero.titleA')} <span className="lp-gradient">{t('lp.hero.titleB')}</span>
        </h1>
        <p className="lp-lead">{t('lp.hero.lead')}</p>
        <div className="lp-actions">
          <Link to="/order" className="btn btn-primary btn-lg">
            {t('lp.hero.ctaPrimary')}
          </Link>
          <a href="#journey" className="btn btn-secondary btn-lg">
            {t('lp.hero.ctaSecondary')}
          </a>
        </div>
        <p className="lp-cta-note">{t('lp.hero.ctaNote')}</p>
        <dl className="lp-stats">
          <div>
            <dt>{t('lp.stats.sections')}</dt>
            <dd>{t('lp.stats.sectionsLabel')}</dd>
          </div>
          <div>
            <dt>{t('lp.stats.sources')}</dt>
            <dd>{t('lp.stats.sourcesLabel')}</dd>
          </div>
          <div>
            <dt>{t('lp.stats.states')}</dt>
            <dd>{t('lp.stats.statesLabel')}</dd>
          </div>
        </dl>
      </div>

      <div className="lp-hero-visual" aria-label={t('lp.hero.demo')} role="img">
        <span className="lp-mock-badge">{t('lp.hero.demo')}</span>
        <div className="lp-mock">
          <div className="lp-mock-head">
            <img src="/brand/logo.svg" alt="" />
            <div>
              <strong>{t('lp.hero.panelTitle')}</strong>
              <span>{t('lp.hero.panelMeta')}</span>
            </div>
          </div>
          <div className="lp-chips">
            <span className="lp-chip lp-chip-site">{t('lp.hero.chipWebsite')}</span>
            <span className="lp-chip lp-chip-inf">{t('lp.hero.chipInference')}</span>
            <span className="lp-chip lp-chip-sug">{t('lp.hero.chipSuggestion')}</span>
            <span className="lp-chip lp-chip-miss">{t('lp.hero.chipMissing')}</span>
          </div>
          <ul className="lp-mock-lines">
            <li>
              <span className="lp-dot lp-dot-site" />
              {t('lp.hero.row1')}
            </li>
            <li>
              <span className="lp-dot lp-dot-inf" />
              {t('lp.hero.row2')}
            </li>
            <li>
              <span className="lp-dot lp-dot-sug" />
              {t('lp.hero.row3')}
            </li>
            <li className="lp-mock-missing">
              <span className="lp-dot lp-dot-miss" />
              <span className="lp-skeleton" />
            </li>
          </ul>
          <p className="lp-mock-foot">{t('lp.hero.panelFoot')}</p>
        </div>
      </div>
    </section>
  );
}

function MotionPreview() {
  const { t } = useSession();
  const reduced = usePrefersReducedMotion();
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(true);

  useEffect(() => {
    if (reduced) setPlaying(false);
  }, [reduced]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setStep((current) => (current + 1) % JOURNEY_STAGES.length);
    }, 1800);
    return () => window.clearInterval(timer);
  }, [playing]);

  const stage = JOURNEY_STAGES[step];

  return (
    <section className="lp-band" id="demo">
      <div className="lp-inner">
        <SectionHead eyebrow={t('lp.demo.eyebrow')} title={t('lp.demo.title')} sub={t('lp.demo.sub')} />
        <Reveal className="lp-demo">
          <div className="lp-demo-rail" aria-hidden>
            <span className="lp-demo-track" />
            <span
              className="lp-demo-progress"
              style={{ width: `${((step + 1) / JOURNEY_STAGES.length) * 100}%` }}
            />
            {JOURNEY_STAGES.map((item, index) => (
              <button
                key={item.n}
                type="button"
                className={index <= step ? 'lp-demo-node is-done' : 'lp-demo-node'}
                onClick={() => {
                  setStep(index);
                  setPlaying(false);
                }}
                aria-label={t(`lp.j${item.n}.name`)}
              >
                <Glyph name={item.icon} size={18} />
              </button>
            ))}
          </div>

          <div className="lp-demo-stage">
            <div className="lp-demo-icon">
              <Glyph name={stage.icon} size={26} />
            </div>
            <div>
              <strong>{t(`lp.j${stage.n}.name`)}</strong>
              <p>{t(`lp.j${stage.n}.desc`)}</p>
            </div>
            <StatusChip status={stage.status} t={t} />
          </div>

          <div className="lp-demo-foot">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPlaying(!playing)}>
              {playing ? t('lp.demo.pause') : t('lp.demo.play')}
            </button>
            <span className="lp-muted">{t('lp.demo.note')}</span>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function JourneyMap() {
  const { t } = useSession();
  const [active, setActive] = useState(1);
  const stage = JOURNEY_STAGES.find((item) => item.n === active) ?? JOURNEY_STAGES[0];

  return (
    <section className="lp-inner lp-section" id="journey">
      <SectionHead eyebrow={t('lp.journey.eyebrow')} title={t('lp.journey.title')} sub={t('lp.journey.sub')} />

      <Reveal>
        <div className="lp-journey">
          <div className="lp-journey-rail">
            <span className="lp-journey-line" aria-hidden />
            {JOURNEY_STAGES.map((item) => {
              const selected = item.n === active;
              return (
                <button
                  key={item.n}
                  type="button"
                  className={`lp-journey-node lp-journey-${item.status}${selected ? ' is-active' : ''}`}
                  onClick={() => setActive(item.n)}
                  aria-pressed={selected}
                >
                  <span className="lp-journey-index">{item.n}</span>
                  <span className="lp-journey-icon">
                    <Glyph name={item.icon} size={20} />
                  </span>
                  <span className="lp-journey-name">{t(`lp.j${item.n}.name`)}</span>
                </button>
              );
            })}
          </div>

          <div className="lp-journey-detail">
            <div className="lp-journey-detail-head">
              <span className="lp-journey-icon lg">
                <Glyph name={stage.icon} size={24} />
              </span>
              <div>
                <h3>{t(`lp.j${stage.n}.name`)}</h3>
                <StatusChip status={stage.status} t={t} />
              </div>
            </div>
            <p>{t(`lp.j${stage.n}.desc`)}</p>
            <a className="lp-link" href={stage.anchor}>
              {t('lp.journey.more')}
              <span aria-hidden> ←</span>
            </a>
          </div>
        </div>
        <p className="lp-note">{t('lp.journey.note')}</p>
      </Reveal>
    </section>
  );
}

function ProblemSection() {
  const { t } = useSession();
  const items: Array<[string, string]> = [
    ['lp.problem.1t', 'lp.problem.1x'],
    ['lp.problem.2t', 'lp.problem.2x'],
    ['lp.problem.3t', 'lp.problem.3x'],
    ['lp.problem.4t', 'lp.problem.4x'],
  ];
  return (
    <section className="lp-band" id="problem">
      <div className="lp-inner lp-section">
        <SectionHead title={t('lp.problem.title')} sub={t('lp.problem.sub')} />
        <div className="lp-grid-4">
          {items.map(([title, text], index) => (
            <Reveal key={title} delay={index * 60}>
              <article className="lp-card lp-problem-card">
                <span className="lp-problem-mark" aria-hidden />
                <h3>{t(title)}</h3>
                <p>{t(text)}</p>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  const { t } = useSession();
  const steps = [1, 2, 3, 4];
  return (
    <section className="lp-inner lp-section" id="how">
      <SectionHead title={t('lp.how.title')} sub={t('lp.how.sub')} />
      <ol className="lp-steps">
        {steps.map((step, index) => (
          <Reveal key={step} delay={index * 70}>
            <li className="lp-step">
              <span className="lp-step-index">{step}</span>
              <div>
                <h3>{t(`lp.how.${step}t`)}</h3>
                <p>{t(`lp.how.${step}x`)}</p>
              </div>
            </li>
          </Reveal>
        ))}
      </ol>
    </section>
  );
}

function FeatureSection() {
  const { t } = useSession();
  const items: Array<[string, string]> = [
    ['lp.features.1t', 'lp.features.1x'],
    ['lp.features.2t', 'lp.features.2x'],
    ['lp.features.3t', 'lp.features.3x'],
    ['lp.features.4t', 'lp.features.4x'],
    ['lp.features.5t', 'lp.features.5x'],
    ['lp.features.6t', 'lp.features.6x'],
  ];
  return (
    <section className="lp-inner lp-section" id="features">
      <SectionHead title={t('lp.features.title')} sub={t('lp.features.sub')} />
      <div className="lp-grid-3">
        {items.map(([title, text], index) => (
          <Reveal key={title} delay={index * 50}>
            <article className="lp-card lp-feature">
              <span className="lp-feature-icon">
                <Glyph
                  name={(['scan', 'strategy', 'check', 'design', 'audience', 'follow'] as GlyphName[])[index]}
                  size={20}
                />
              </span>
              <h3>{t(title)}</h3>
              <p>{t(text)}</p>
            </article>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

function SplitFeature({
  id,
  image,
  image2,
  title,
  sub,
  bullets,
  status,
  note,
  cta,
}: {
  id: string;
  image: string;
  image2?: string;
  title: string;
  sub: string;
  bullets: string[];
  status?: StageStatus;
  note?: string;
  cta?: string;
}) {
  const { t } = useSession();
  return (
    <section className="lp-inner lp-section" id={id}>
      <Reveal>
        {/* Copy first so RTL places it on the right, media opposite. */}
        <div className="lp-split">
          <div className="lp-split-copy">
            {status ? <StatusChip status={status} t={t} /> : null}
            <h2>{title}</h2>
            <p className="lp-sub">{sub}</p>
            <ul className="lp-bullets">
              {bullets.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            {note ? <p className="lp-note">{note}</p> : null}
            {cta ? (
              <Link to="/order" className="btn btn-primary">
                {cta}
              </Link>
            ) : null}
          </div>
          <div className={image2 ? 'lp-split-media lp-media-stack' : 'lp-split-media'}>
            <BrandImg src={image} alt={title} className="lp-figure-img" />
            {image2 ? <BrandImg src={image2} alt={title} className="lp-figure-img" /> : null}
          </div>
        </div>
      </Reveal>
    </section>
  );
}

function AnalysisSection() {
  const { t } = useSession();
  return (
    <SplitFeature
      id="analysis"
      image="/brand/scene-analysis.svg"
      title={t('lp.analysis.title')}
      sub={t('lp.analysis.sub')}
      bullets={[t('lp.analysis.b1'), t('lp.analysis.b2'), t('lp.analysis.b3')]}
      status="live"
      cta={t('lp.analysis.cta')}
    />
  );
}

function ContentSection() {
  const { t } = useSession();
  return (
    <SplitFeature
      id="content"
      image="/brand/scene-campaign.svg"
      image2="/brand/scene-content.svg"
      title={t('lp.content.title')}
      sub={t('lp.content.sub')}
      bullets={[t('lp.content.b1'), t('lp.content.b2'), t('lp.content.b3')]}
      status="planned"
      note={t('lp.content.note')}
    />
  );
}

function LeadsSection() {
  const { t } = useSession();
  return (
    <SplitFeature
      id="leads"
      image="/brand/scene-leads.svg"
      title={t('lp.leads.title')}
      sub={t('lp.leads.sub')}
      bullets={[t('lp.leads.b1'), t('lp.leads.b2'), t('lp.leads.b3')]}
      status="planned"
      note={t('lp.leads.note')}
    />
  );
}

function ApprovalSection() {
  const { t } = useSession();
  return (
    <SplitFeature
      id="approval"
      image="/brand/scene-flow.svg"
      title={t('lp.approval.title')}
      sub={t('lp.approval.sub')}
      bullets={[t('lp.approval.b1'), t('lp.approval.b2'), t('lp.approval.b3')]}
      status="live"
    />
  );
}

function ReportsSection() {
  const { t } = useSession();
  return (
    <SplitFeature
      id="reports"
      image="/brand/scene-reports.svg"
      title={t('lp.reports.title')}
      sub={t('lp.reports.sub')}
      bullets={[t('lp.reports.b1'), t('lp.reports.b2'), t('lp.reports.b3')]}
      status="partial"
      note={t('lp.reports.note')}
    />
  );
}

function PlansBlock() {
  const { t } = useSession();
  return (
    <section className="lp-band" id="plans">
      <div className="lp-inner lp-section">
        <SectionHead title={t('lp.plans.title')} sub={t('lp.plans.sub')} />
        <PlansSection />
        <p className="lp-note">{t('lp.plans.note')}</p>
      </div>
    </section>
  );
}

function TrustSection() {
  const { t } = useSession();
  const items: Array<[string, string]> = [
    ['lp.trust.1t', 'lp.trust.1x'],
    ['lp.trust.2t', 'lp.trust.2x'],
    ['lp.trust.3t', 'lp.trust.3x'],
    ['lp.trust.4t', 'lp.trust.4x'],
  ];
  return (
    <section className="lp-inner lp-section" id="trust">
      <SectionHead title={t('lp.trust.title')} sub={t('lp.trust.sub')} />
      <div className="lp-grid-4">
        {items.map(([title, text], index) => (
          <Reveal key={title} delay={index * 50}>
            <article className="lp-card lp-trust-card">
              <span className="lp-feature-icon">
                <Glyph name="check" size={20} />
              </span>
              <h3>{t(title)}</h3>
              <p>{t(text)}</p>
            </article>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

function FaqSection() {
  const { t } = useSession();
  const faqs = [1, 2, 3, 4, 5, 6];
  return (
    <section className="lp-inner lp-section" id="faq">
      <SectionHead title={t('lp.faq.title')} />
      <div className="lp-faq">
        {faqs.map((n) => (
          <details className="faq" key={n}>
            <summary>{t(`lp.faq.${n}q`)}</summary>
            <p>{t(`lp.faq.${n}a`)}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

function FinalCta() {
  const { t } = useSession();
  return (
    <section className="lp-inner lp-section">
      <Reveal>
        <div className="lp-final">
          <div>
            <h2>{t('lp.cta.title')}</h2>
            <p>{t('lp.cta.sub')}</p>
          </div>
          <div className="lp-actions">
            <Link to="/order" className="btn btn-primary btn-lg">
              {t('lp.cta.primary')}
            </Link>
            <Link to="/login" className="btn btn-secondary btn-lg">
              {t('lp.cta.secondary')}
            </Link>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

export function LandingPage() {
  const { me } = useSession();
  if (me) return <Navigate to={landingRouteFor(me)} replace />;

  return (
    <PublicLayout>
      <Hero />
      <MotionPreview />
      <JourneyMap />
      <ProblemSection />
      <HowItWorks />
      <FeatureSection />
      <AnalysisSection />
      <ContentSection />
      <LeadsSection />
      <ApprovalSection />
      <ReportsSection />
      <PlansBlock />
      <TrustSection />
      <FaqSection />
      <FinalCta />
    </PublicLayout>
  );
}

type PublicPlan = {
  id: string;
  nameAr: string;
  nameEn: string;
  priceSar: number;
  maxUsers: number | null;
  monthlyAnalyses?: number | null;
  maxConcurrent?: number | null;
  featuresAr: string[];
  featuresEn: string[];
  prices: Array<{ months: number; price: number }>;
};

/** Brand imagery with a graceful gradient fallback when the photo is absent. */
function BrandImg({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [missing, setMissing] = useState(false);
  if (missing) {
    // Never leave an empty rectangle: show the brand mark instead of a blank
    // block when a photo has not been uploaded yet.
    return (
      <div
        className={className ? `${className} img-fallback` : 'img-fallback'}
        role="img"
        aria-label={alt}
      >
        <img src="/brand/logo.svg" alt="" className="img-fallback-logo" />
      </div>
    );
  }
  return <img src={src} alt={alt} className={className} loading="lazy" onError={() => setMissing(true)} />;
}

const PLAN_PERIODS = [3, 6, 9, 12];

function PlansSection() {
  const { t, locale } = useSession();
  const { data, loading } = useApi<{ plans: PublicPlan[] }>('/api/public/plans');
  const [months, setMonths] = useState(12);

  if (loading) return <Loading />;
  if (!data || !data.plans.length) return null;

  return (
    <>
      <div className="period-switch" role="group" aria-label={t('order.period')}>
        {PLAN_PERIODS.map((period) => (
          <button
            key={period}
            type="button"
            className={months === period ? 'period-active' : undefined}
            onClick={() => setMonths(period)}
          >
            {t(`landing2.m${period}`)}
          </button>
        ))}
      </div>
      <div className="plans-grid">
        {data.plans.map((plan) => {
          const price = plan.prices.find((entry) => entry.months === months);
          const features = locale === 'ar' ? plan.featuresAr : plan.featuresEn;
          return (
            <article key={plan.id} className="price-card">
              <h3>{locale === 'ar' ? plan.nameAr : plan.nameEn}</h3>
              <p className="price">
                {price ? formatSAR(price.price, locale) : '—'}
                <small> / {t(`landing2.m${months}`)}</small>
              </p>
              {/* Limits come from the plan row, the same values the API enforces. */}
              <ul className="lp-plan-limits">
                <li>
                  <strong>{plan.maxUsers ?? '∞'}</strong>
                  <span>{t('lp.plan.seats')}</span>
                </li>
                <li>
                  <strong>{plan.monthlyAnalyses ?? '∞'}</strong>
                  <span>{t('lp.plan.analyses')}</span>
                </li>
                <li>
                  <strong>{plan.maxConcurrent ?? '—'}</strong>
                  <span>{t('lp.plan.concurrent')}</span>
                </li>
              </ul>
              {features.length ? (
                <ul className="price-features">
                  {features.slice(0, 6).map((feature) => (
                    <li key={feature}>{feature}</li>
                  ))}
                </ul>
              ) : null}
              <Link to={`/order?plan=${plan.id}&months=${months}`} className="btn btn-primary">
                {t('landing2.orderNow')}
              </Link>
            </article>
          );
        })}
      </div>
    </>
  );
}

export function OrderPage() {
  const { t, locale } = useSession();
  const [search] = useSearchParams();
  const { data } = useApi<{ plans: PublicPlan[] }>('/api/public/plans');
  const [form, setForm] = useState({
    companyName: '',
    contactName: '',
    email: '',
    phone: '',
    password: '',
  });
  const [planId, setPlanId] = useState(search.get('plan') ?? '');
  const [months, setMonths] = useState(Number(search.get('months')) || 12);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [lookupEmail, setLookupEmail] = useState('');
  const [lookup, setLookup] = useState<any[] | null>(null);

  useEffect(() => {
    if (!planId && data?.plans.length) setPlanId(data.plans[0].id);
  }, [data, planId]);

  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm({ ...form, [key]: event.target.value });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/public/purchase-requests', {
        method: 'POST',
        body: { ...form, planId, months },
      });
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'internal_error');
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    setLookup(null);
    setError(null);
    try {
      const result = await api<{ requests: any[] }>(
        `/api/public/purchase-requests?email=${encodeURIComponent(lookupEmail)}`
      );
      setLookup(result.requests);
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'internal_error');
    }
  };

  return (
    <PublicLayout>
      <section className="section narrow">
        <h1 className="section-title">{t('order.title')}</h1>
        <p className="section-sub">{t('order.sub')}</p>
        {error ? <Alert tone="danger">{t(errorKey(error))}</Alert> : null}
        {sent ? (
          <Card>
            <Alert tone="ok">{t('order.success')}</Alert>
            <Button variant="secondary" onClick={() => setSent(false)}>
              {t('order.newRequest')}
            </Button>
          </Card>
        ) : (
          <Card>
            <form onSubmit={submit} className="stack">
              <Field label={t('order.companyName')}>
                <Input required value={form.companyName} onChange={set('companyName')} />
              </Field>
              <Field label={t('order.contactName')}>
                <Input value={form.contactName} onChange={set('contactName')} />
              </Field>
              <div className="form-row">
                <Field label={t('order.email')}>
                  <Input required type="email" dir="ltr" value={form.email} onChange={set('email')} />
                </Field>
                <Field label={t('order.phone')}>
                  <Input dir="ltr" value={form.phone} onChange={set('phone')} />
                </Field>
              </div>
              <div className="form-row">
                <Field label={t('order.plan')}>
                  <Select value={planId} onChange={(event) => setPlanId(event.target.value)}>
                    {(data?.plans ?? []).map((plan) => (
                      <option key={plan.id} value={plan.id}>
                        {locale === 'ar' ? plan.nameAr : plan.nameEn}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('order.period')}>
                  <Select value={String(months)} onChange={(event) => setMonths(Number(event.target.value))}>
                    {PLAN_PERIODS.map((period) => (
                      <option key={period} value={period}>
                        {t(`landing2.m${period}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field label={t('order.password')} hint={t('order.passwordHint')}>
                <Input
                  required
                  type="password"
                  dir="ltr"
                  minLength={10}
                  value={form.password}
                  onChange={set('password')}
                />
              </Field>
              <Button type="submit" loading={busy}>
                {t('order.submit')}
              </Button>
            </form>
          </Card>
        )}
      </section>

      <section className="section narrow">
        <h2 className="section-title">{t('order.checkTitle')}</h2>
        <p className="section-sub">{t('order.checkHint')}</p>
        <Card>
          <div className="lookup-row">
            <Input
              type="email"
              dir="ltr"
              value={lookupEmail}
              onChange={(event) => setLookupEmail(event.target.value)}
            />
            <Button variant="secondary" onClick={() => void check()}>
              {t('order.check')}
            </Button>
          </div>
          {lookup ? (
            lookup.length === 0 ? (
              <p className="muted">{t('common.noData')}</p>
            ) : (
              <Table head={[t('order.companyName'), t('order.period'), t('common.status')] }>
                {lookup.map((row: any) => (
                  <tr key={row.id}>
                    <td>{row.companyName}</td>
                    <td>
                      {row.months} {t('admin.monthsUnit')} · {formatSAR(row.amountSar, locale)}
                    </td>
                    <td>
                      <StatusBadge status={row.status} />
                      <br />
                      <span className="muted small">{t(`order.status_${row.status}`, row.status)}</span>
                      {row.reviewNote ? (
                        <>
                          <br />
                          <span className="muted small">
                            {t('order.reviewNote')}: {row.reviewNote}
                          </span>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </Table>
            )
          ) : null}
        </Card>
      </section>
    </PublicLayout>
  );
}

function AuthPanel({ children }: { children: ReactNode }) {
  const { locale, t } = useSession();
  return (
    <div className="auth-page">
      <aside className="auth-aside">
        <div className="auth-aside-brand">
          <BrandLogo />
          <div>
            <strong>{locale === 'ar' ? 'وصول' : 'Wusool'}</strong>
            <span>{t('app.tagline')}</span>
          </div>
        </div>
        <ul className="auth-points">
          <li>{t('landing.f1Title')}</li>
          <li>{t('landing.f5Title')}</li>
          <li>{t('landing.f6Title')}</li>
        </ul>
        <small>{t('landing.phaseNote')}</small>
      </aside>
      <main className="auth-main">
        <Link to="/" className="auth-home">
          <span aria-hidden="true">{locale === 'ar' ? '→' : '←'}</span> {t('legal.back')}
        </Link>
        <div className="auth-card">{children}</div>
      </main>
    </div>
  );
}

export function LoginPage() {
  const { me, refresh, loading, t } = useSession();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!loading && me) return <Navigate to={landingRouteFor(me)} replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/login', { method: 'POST', body: { email, password } });
      const result = await refresh();
      if (result) navigate(landingRouteFor(result), { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'internal_error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthPanel>
      <h1>{t('auth.loginTitle')}</h1>
      <p className="muted">{t('auth.loginSubtitle')}</p>
      {error ? <Alert tone="danger">{t(errorKey(error))}</Alert> : null}
      <form onSubmit={submit} className="stack">
        <Field label={t('common.email')} htmlFor="login-email">
          <Input
            id="login-email"
            type="email"
            dir="ltr"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Field label={t('common.password')} htmlFor="login-password">
          <Input
            id="login-password"
            type="password"
            dir="ltr"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <Button type="submit" loading={busy}>
          {t('auth.signIn')}
        </Button>
        <div className="auth-links">
          <Link to="/forgot">{t('auth.forgot')}</Link>
        </div>
      </form>
    </AuthPanel>
  );
}

/**
 * Private owner entrance. Deliberately unlinked from every public page: the
 * company portal is /login, while the platform owner enters here (and creates
 * the first account here while the platform is still empty). Route-level and
 * API-level role checks keep the two portals apart.
 */
export function OwnerPortalPage() {
  const { me, refresh, loading, t, signOut } = useSession();
  const navigate = useNavigate();
  const branding = useApi<BrandingPayload>('/api/public/branding');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (loading || branding.loading) return <FullPageLoading />;
  if (branding.data && !branding.data.platform.setupCompleted) return <SetupPage />;
  if (me?.user.platformRole === 'super_admin') return <Navigate to="/admin" replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/login', { method: 'POST', body: { email, password } });
      const result = await refresh();
      if (!result || result.user.platformRole !== 'super_admin') {
        await signOut();
        setError('owner_portal_only');
        return;
      }
      navigate('/admin', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'internal_error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthPanel>
      <span className="owner-badge">{t('owner.badge')}</span>
      <h1>{t('owner.title')}</h1>
      <p className="muted">{t('owner.subtitle')}</p>
      {error ? <Alert tone="danger">{t(errorKey(error))}</Alert> : null}
      <form onSubmit={submit} className="stack">
        <Field label={t('common.email')} htmlFor="owner-email">
          <Input
            id="owner-email"
            type="email"
            dir="ltr"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Field label={t('common.password')} htmlFor="owner-password">
          <Input
            id="owner-password"
            type="password"
            dir="ltr"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <Button type="submit" loading={busy}>
          {t('auth.signIn')}
        </Button>
      </form>
      <div className="auth-links">
        <Link to="/login">{t('owner.companyPortal')}</Link>
      </div>
    </AuthPanel>
  );
}

export function SetupPage() {
  const { refresh, loading, t } = useSession();
  const navigate = useNavigate();
  const branding = useApi<BrandingPayload>('/api/public/branding');
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [shownCode, setShownCode] = useState<string | null>(null);
  const [setupToken, setSetupToken] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fresh hosted databases start empty — bootstrap the schema on arrival so
  // the very first visit can complete the setup without manual SQL.
  useEffect(() => {
    void api('/api/setup/init', { method: 'POST' }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (branding.data?.platform.setupCompleted) navigate('/login', { replace: true });
  }, [branding.data, navigate]);

  if (loading || branding.loading) return <FullPageLoading />;

  const fail = (err: unknown) => setError(err instanceof ApiError ? err.code : 'internal_error');

  const start = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ code?: string }>('/api/setup/start', {
        method: 'POST',
        body: { email },
      });
      setShownCode(result.code ?? null);
      setStep(2);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ setupToken: string }>('/api/setup/verify', {
        method: 'POST',
        body: { email, code },
      });
      setSetupToken(result.setupToken);
      setStep(3);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const finish = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/setup', { method: 'POST', body: { name, email, password, setupToken } });
      const result = await refresh();
      if (result) navigate(landingRouteFor(result), { replace: true });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthPanel>
      <h1>{t('auth.setupTitle')}</h1>
      <p className="muted">{t('auth.setupSubtitle')}</p>
      <Alert tone="warn">{t('auth.setupNote')}</Alert>
      {error ? <Alert tone="danger">{t(errorKey(error))}</Alert> : null}
      {step === 1 ? (
        <form onSubmit={start} className="stack">
          <h3>{t('auth.setupStep1')}</h3>
          <p className="muted">{t('auth.setupStep1Hint')}</p>
          <Field label={t('common.email')} htmlFor="setup-email">
            <Input
              id="setup-email"
              type="email"
              dir="ltr"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Button type="submit" loading={busy}>
            {t('auth.sendCode')}
          </Button>
        </form>
      ) : null}
      {step === 2 ? (
        <form onSubmit={verify} className="stack">
          <h3>{t('auth.setupStep2')}</h3>
          <p className="muted">{t('auth.setupStep2Hint')}</p>
          {shownCode ? (
            <Alert tone="info">
              <div>{t('auth.codeShownDev')}</div>
              <CopyValue value={shownCode} />
            </Alert>
          ) : null}
          <Field label={t('auth.codeLabel')} htmlFor="setup-code">
            <Input
              id="setup-code"
              dir="ltr"
              inputMode="numeric"
              maxLength={6}
              required
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            />
          </Field>
          <Button type="submit" loading={busy}>
            {t('auth.verifyCode')}
          </Button>
        </form>
      ) : null}
      {step === 3 ? (
        <form onSubmit={finish} className="stack">
          <h3>{t('auth.setupStep3')}</h3>
          <p className="muted">{t('auth.setupOwnerNote')}</p>
          <Field label={t('auth.fullName')} htmlFor="setup-name">
            <Input id="setup-name" required value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label={t('common.password')} hint={t('auth.passwordMin')} htmlFor="setup-password">
            <Input
              id="setup-password"
              type="password"
              dir="ltr"
              minLength={10}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <Button type="submit" loading={busy}>
            {t('auth.createAdmin')}
          </Button>
        </form>
      ) : null}
      <Link to="/login" className="auth-links">
        {t('auth.backToLogin')}
      </Link>
    </AuthPanel>
  );
}

export function ForgotPage() {
  const { t } = useSession();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [supportEmail, setSupportEmail] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api<{ supportEmail: string }>('/api/auth/forgot', {
        method: 'POST',
        body: { email },
      });
      setSupportEmail(result.supportEmail ?? '');
      setSent(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthPanel>
      <h1>{t('auth.resetTitle')}</h1>
      {sent ? (
        <>
          <Alert tone="info">{t('auth.resetNote')}</Alert>
          {supportEmail ? (
            <p className="muted" dir="ltr">
              {supportEmail}
            </p>
          ) : (
            <Alert tone="warn">{t('auth.resetUnavailable')}</Alert>
          )}
        </>
      ) : (
        <form onSubmit={submit} className="stack">
          <Field label={t('common.email')} htmlFor="forgot-email">
            <Input
              id="forgot-email"
              type="email"
              dir="ltr"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Button type="submit" loading={busy}>
            {t('auth.requestReset')}
          </Button>
        </form>
      )}
      <Link to="/login" className="auth-links">
        {t('auth.backToLogin')}
      </Link>
    </AuthPanel>
  );
}

export function ChangePasswordPage() {
  const { me, refresh, t } = useSession();
  const navigate = useNavigate();
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!me) return <Navigate to="/login" replace />;
  if (!me.user.mustChangePassword && done) return <Navigate to={landingRouteFor(me)} replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (form.newPassword !== form.confirm) {
      setError('mismatch');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/password', {
        method: 'POST',
        body: { currentPassword: form.currentPassword, newPassword: form.newPassword },
      });
      await refresh();
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'internal_error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthPanel>
      <h1>{t('auth.mustChangeTitle')}</h1>
      <p className="muted">{t('auth.mustChangeNote')}</p>
      {error ? (
        <Alert tone="danger">
          {error === 'mismatch' ? t('auth.passwordMismatch') : t(errorKey(error))}
        </Alert>
      ) : null}
      {done ? (
        <>
          <Alert tone="ok">{t('auth.passwordChanged')}</Alert>
          <Button onClick={() => navigate(landingRouteFor({ ...me, user: { ...me.user, mustChangePassword: false } }))}>
            {t('nav.dashboard')}
          </Button>
        </>
      ) : (
        <form onSubmit={submit} className="stack">
          <Field label={t('auth.currentPassword')} htmlFor="cp-current">
            <Input
              id="cp-current"
              type="password"
              dir="ltr"
              required
              value={form.currentPassword}
              onChange={(event) => setForm({ ...form, currentPassword: event.target.value })}
            />
          </Field>
          <Field
            label={t('auth.newPassword')}
            hint={t('auth.passwordMin')}
            htmlFor="cp-new"
          >
            <Input
              id="cp-new"
              type="password"
              dir="ltr"
              minLength={10}
              required
              value={form.newPassword}
              onChange={(event) => setForm({ ...form, newPassword: event.target.value })}
            />
          </Field>
          <Field label={t('auth.confirmPassword')} htmlFor="cp-confirm">
            <Input
              id="cp-confirm"
              type="password"
              dir="ltr"
              minLength={10}
              required
              value={form.confirm}
              onChange={(event) => setForm({ ...form, confirm: event.target.value })}
            />
          </Field>
          <Button type="submit" loading={busy}>
            {t('auth.changePassword')}
          </Button>
        </form>
      )}
    </AuthPanel>
  );
}

/**
 * Legal and support documents share one renderer. Content lives in
 * `lib/legal.ts` and is written against what the platform actually does.
 */
function LegalPage({ kind }: { kind: 'terms' | 'privacy' | 'support' }) {
  const { me, locale, t } = useSession();
  const doc = LEGAL[locale === 'en' ? 'en' : 'ar'][kind];
  const email = me?.support.email?.trim() || 'info@jadara-hr.com';
  const fill = (text: string) => text.replaceAll('{email}', email);

  return (
    <PublicLayout>
      <article className="legal">
        <Link to="/" className="legal-back">
          <span aria-hidden="true">{locale === 'ar' ? '→' : '←'}</span> {t('legal.back')}
        </Link>
        <header className="legal-head">
          <span className="legal-kicker">{doc.subtitle}</span>
          <h1>{doc.title}</h1>
          <p className="legal-updated">
            {t('legal.updated')} {doc.updated}
          </p>
          <p className="legal-intro">{doc.intro}</p>
        </header>
        <div className="legal-body">
          {doc.blocks.map((block) => (
            <section key={block.heading}>
              <h2>{block.heading}</h2>
              {block.paragraphs?.map((paragraph) => (
                <p key={paragraph}>{fill(paragraph)}</p>
              ))}
              {block.bullets ? (
                <ul>
                  {block.bullets.map((item) => (
                    <li key={item}>{fill(item)}</li>
                  ))}
                </ul>
              ) : null}
            </section>
          ))}
        </div>
        <aside className="legal-contact">
          <h2>{t('legal.contactTitle')}</h2>
          <p>{t('legal.contactBody')}</p>
          <div className="legal-contact-actions">
            <a className="btn btn-primary" href={`mailto:${email}`} dir="ltr">
              {email}
            </a>
            <Link className="btn btn-secondary" to="/support">
              {t('legal.supportTitle')}
            </Link>
            {kind === 'support' && me?.user.platformRole === 'super_admin' ? (
              <Link className="btn btn-secondary" to="/admin/settings">
                {t('nav.platformSettings')}
              </Link>
            ) : null}
          </div>
        </aside>
      </article>
    </PublicLayout>
  );
}

export function TermsPage() {
  return <LegalPage kind="terms" />;
}

export function PrivacyPage() {
  return <LegalPage kind="privacy" />;
}

export function SupportPage() {
  return <LegalPage kind="support" />;
}

export function AccessDeniedPage() {
  const { t } = useSession();
  return (
    <div className="center-page">
      <Card title={t('admin.noAccess')}>
        <Link className="btn btn-secondary" to="/">
          {t('common.back')}
        </Link>
      </Card>
    </div>
  );
}

export function NotFoundPage() {
  const { t, me } = useSession();
  return (
    <div className="center-page">
      <Card title="404">
        <p className="muted">{t('err.not_found')}</p>
        <Link className="btn btn-secondary" to={me ? landingRouteFor(me) : '/login'}>
          {t('common.back')}
        </Link>
      </Card>
    </div>
  );
}

export function OneTimePassword({ password }: { password: string }) {
  const { t } = useSession();
  return (
    <>
      <p>{t('team.tempNote')}</p>
      <CopyValue value={password} />
    </>
  );
}

export { Loading };
