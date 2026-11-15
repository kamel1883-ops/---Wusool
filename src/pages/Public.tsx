import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, useApi, type Me } from '../lib/api';
import { useSession } from '../lib/session';
import { errorKey, formatSAR } from '../lib/i18n';
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

function PublicLayout({ children }: { children: ReactNode }) {
  const { me, locale, setLocale, t } = useSession();
  const brandName = me?.branding.nameAr ?? 'وصول';

  return (
    <div className="public">
      <header className="public-head">
        <Link to="/" className="public-brand">
          <img src={me?.branding.logoUrl ?? '/brand/logo.jpg'} alt="" className="logo-tile" />
          <div>
            <strong>{locale === 'ar' ? brandName : me?.branding.nameEn ?? 'Wusool'}</strong>
            <span>{locale === 'ar' ? me?.branding.taglineEn ?? 'Wusool' : brandName}</span>
          </div>
        </Link>
        <nav className="public-nav">
          <Link to="/support">{t('landing.support')}</Link>
          <Link to="/terms">{t('landing.terms')}</Link>
          <Link to="/privacy">{t('landing.privacy')}</Link>
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
      <footer className="public-foot">
        <span>
          © {new Date().getFullYear()} {brandName} · {t('landing.footerRights')}
        </span>
        <span className="public-foot-links">
          <Link to="/terms">{t('landing.terms')}</Link>
          <Link to="/privacy">{t('landing.privacy')}</Link>
          <Link to="/support">{t('landing.support')}</Link>
        </span>
      </footer>
    </div>
  );
}

export function LandingPage() {
  const { me, t } = useSession();
  if (me) return <Navigate to={landingRouteFor(me)} replace />;

  const features: Array<[string, string]> = [
    ['module.siteAnalysis', 'landing2.feat1'],
    ['module.strategy', 'landing2.feat2'],
    ['module.content', 'landing2.feat3'],
    ['module.crm', 'landing2.feat4'],
    ['landing2.trust3t', 'landing2.feat5'],
  ];

  const flow = ['landing2.how1', 'landing2.how2', 'landing2.how3', 'landing2.how4'];

  const faqs: Array<[string, string]> = [
    ['landing2.faq1q', 'landing2.faq1a'],
    ['landing2.faq2q', 'landing2.faq2a'],
    ['landing2.faq3q', 'landing2.faq3a'],
    ['landing2.faq4q', 'landing2.faq4a'],
  ];

  return (
    <PublicLayout>
      <section className="hero hero-b2b">
        <div className="hero-text">
          <span className="pill">{t('landing2.badge')}</span>
          <h1>{t('landing2.heroTitle')}</h1>
          <p className="hero-lead">{t('landing2.heroLead')}</p>
          <div className="hero-actions">
            <Link to="/order" className="btn btn-primary">
              {t('landing2.ctaOrder')}
            </Link>
            <Link to="/login" className="btn btn-secondary">
              {t('landing2.ctaLogin')}
            </Link>
          </div>
          <ul className="trust-list">
            <li>
              <strong>{t('landing2.trust1t')}</strong>
              <span>{t('landing2.trust1x')}</span>
            </li>
            <li>
              <strong>{t('landing2.trust2t')}</strong>
              <span>{t('landing2.trust2x')}</span>
            </li>
            <li>
              <strong>{t('landing2.trust3t')}</strong>
              <span>{t('landing2.trust3x')}</span>
            </li>
          </ul>
        </div>
        <aside className="hero-visual">
          <BrandImg src="/brand/hero-team.jpg" alt={t('landing2.imgAlt')} className="hero-img-main" />
          <div className="hero-visual-side">
            <BrandImg src="/brand/hero-office.jpg" alt={t('landing2.imgAlt')} className="hero-img-side" />
            <BrandImg src="/brand/hero-market.jpg" alt={t('landing2.imgAlt')} className="hero-img-side" />
          </div>
        </aside>
      </section>

      <section className="section" id="plans">
        <h2 className="section-title">{t('landing2.plansTitle')}</h2>
        <p className="section-sub">{t('landing2.plansSub')}</p>
        <PlansSection />
      </section>

      <section className="section">
        <h2 className="section-title">{t('landing2.featuresTitle')}</h2>
        <div className="feature-grid">
          {features.map(([title, text]) => (
            <article className="feature" key={title}>
              <h3>{t(title)}</h3>
              <p>{t(text)}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section">
        <h2 className="section-title">{t('landing2.howTitle')}</h2>
        <ol className="flow">
          {flow.map((key, index) => (
            <li key={key}>
              <span className="flow-index">{index + 1}</span>
              <p>{t(key)}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="section">
        <h2 className="section-title">{t('landing2.faqTitle')}</h2>
        <div className="faq-list">
          {faqs.map(([question, answer]) => (
            <details className="faq" key={question}>
              <summary>{t(question)}</summary>
              <p>{t(answer)}</p>
            </details>
          ))}
        </div>
      </section>
    </PublicLayout>
  );
}

type PublicPlan = {
  id: string;
  nameAr: string;
  nameEn: string;
  priceSar: number;
  maxUsers: number | null;
  featuresAr: string[];
  featuresEn: string[];
  prices: Array<{ months: number; price: number }>;
};

/** Brand imagery with a graceful gradient fallback when the photo is absent. */
function BrandImg({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [missing, setMissing] = useState(false);
  if (missing) {
    return (
      <div className={className ? `${className} img-fallback` : 'img-fallback'} role="img" aria-label={alt} />
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
  const { locale, me, t } = useSession();
  return (
    <div className="auth-page">
      <aside className="auth-aside">
        <div className="auth-aside-brand">
          <img src={me?.branding.logoUrl ?? '/brand/logo.jpg'} alt="" />
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
          <Link to="/setup">{t('auth.setupTitle')}</Link>
        </div>
      </form>
    </AuthPanel>
  );
}

export function SetupPage() {
  const { refresh, loading, t } = useSession();
  const navigate = useNavigate();
  const branding = useApi<BrandingPayload>('/api/public/branding');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (branding.data?.platform.setupCompleted) navigate('/login', { replace: true });
  }, [branding.data, navigate]);

  if (loading || branding.loading) return <FullPageLoading />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/setup', { method: 'POST', body: form });
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
      <h1>{t('auth.setupTitle')}</h1>
      <p className="muted">{t('auth.setupSubtitle')}</p>
      <Alert tone="warn">{t('auth.setupNote')}</Alert>
      {error ? <Alert tone="danger">{t(errorKey(error))}</Alert> : null}
      <form onSubmit={submit} className="stack">
        <Field label={t('auth.fullName')} htmlFor="setup-name">
          <Input
            id="setup-name"
            required
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </Field>
        <Field label={t('common.email')} htmlFor="setup-email">
          <Input
            id="setup-email"
            type="email"
            dir="ltr"
            required
            value={form.email}
            onChange={(event) => setForm({ ...form, email: event.target.value })}
          />
        </Field>
        <Field label={t('common.password')} hint={t('auth.passwordMin')} htmlFor="setup-password">
          <Input
            id="setup-password"
            type="password"
            dir="ltr"
            minLength={10}
            required
            value={form.password}
            onChange={(event) => setForm({ ...form, password: event.target.value })}
          />
        </Field>
        <Button type="submit" loading={busy}>
          {t('auth.createAdmin')}
        </Button>
        <Link to="/login" className="auth-links">
          {t('auth.backToLogin')}
        </Link>
      </form>
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

export function TermsPage() {
  const { t } = useSession();
  return (
    <PublicLayout>
      <section className="doc">
        <h1>{t('terms.title')}</h1>
        <Alert tone="warn">{t('terms.placeholder')}</Alert>
        <p>{t('terms.body')}</p>
      </section>
    </PublicLayout>
  );
}

export function PrivacyPage() {
  const { t } = useSession();
  return (
    <PublicLayout>
      <section className="doc">
        <h1>{t('privacy.title')}</h1>
        <Alert tone="warn">{t('privacy.placeholder')}</Alert>
        <p>{t('privacy.body')}</p>
      </section>
    </PublicLayout>
  );
}

export function SupportPage() {
  const { me, t } = useSession();
  return (
    <PublicLayout>
      <section className="doc">
        <h1>{t('support.title')}</h1>
        <p>{t('support.body')}</p>
        <Card title={t('landing.support')}>
          <dl className="detail-list">
            <div>
              <dt>{t('admin.supportEmail')}</dt>
              <dd dir="ltr">
                {me?.support.email || (
                  <span className="muted">{t('support.emailMissing')}</span>
                )}
              </dd>
            </div>
            <div>
              <dt>{t('admin.supportWhatsapp')}</dt>
              <dd dir="ltr">
                {me?.support.whatsapp || (
                  <span className="muted">{t('support.whatsappMissing')}</span>
                )}
              </dd>
            </div>
          </dl>
          <p className="muted small">{t('support.adminNote')}</p>
          {me?.user.platformRole === 'super_admin' ? (
            <Link className="btn btn-secondary btn-sm" to="/admin/settings">
              {t('nav.platformSettings')}
            </Link>
          ) : null}
        </Card>
      </section>
    </PublicLayout>
  );
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
