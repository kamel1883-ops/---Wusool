import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, Link, useNavigate } from 'react-router-dom';
import { api, ApiError, useApi, type Me } from '../lib/api';
import { useSession } from '../lib/session';
import { errorKey } from '../lib/i18n';
import { Alert, Button, Card, CopyValue, Field, Input, Loading } from '../components/ui';
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
  const { me, locale, t } = useSession();
  if (me) return <Navigate to={landingRouteFor(me)} replace />;

  const features = [
    ['landing.f1Title', 'landing.f1Text'],
    ['landing.f2Title', 'landing.f2Text'],
    ['landing.f3Title', 'landing.f3Text'],
    ['landing.f4Title', 'landing.f4Text'],
    ['landing.f5Title', 'landing.f5Text'],
    ['landing.f6Title', 'landing.f6Text'],
  ];

  const flow = ['landing.flow1', 'landing.flow2', 'landing.flow3', 'landing.flow4'];

  return (
    <PublicLayout>
      <section className="hero">
        <div className="hero-text">
          <span className="pill">Phase 1 · {t('landing.flowTitle')}</span>
          <h1>{t('landing.heroTitle')}</h1>
          <p className="hero-lead">{t('landing.heroLead')}</p>
          <div className="hero-actions">
            <Link to="/login" className="btn btn-primary">
              {t('landing.ctaLogin')}
            </Link>
            <Link to="/support" className="btn btn-secondary">
              {t('landing.ctaSupport')}
            </Link>
          </div>
          <p className="hero-note">{t('landing.phaseNote')}</p>
        </div>
        <aside className="hero-panel">
          <div className="hero-panel-head">
            <img src="/brand/logo.jpg" alt="" />
            <div>
              <strong>{locale === 'ar' ? 'وصول' : 'Wusool'}</strong>
              <span dir={locale === 'ar' ? 'ltr' : 'rtl'}>
                {locale === 'ar' ? 'Wusool' : 'وصول'}
              </span>
            </div>
          </div>
          <ul className="phase-list">
            <li className="phase-done">
              <span>01</span>
              <div>
                <strong>{locale === 'ar' ? 'الأساس والصلاحيات' : 'Foundation & access'}</strong>
                <small>{locale === 'ar' ? 'منجزة في هذه النسخة' : 'Delivered in this release'}</small>
              </div>
            </li>
            <li>
              <span>02</span>
              <div>
                <strong>{t('module.siteAnalysis')}</strong>
                <small>{t('module.phase2')}</small>
              </div>
            </li>
            <li>
              <span>03</span>
              <div>
                <strong>{t('module.content')}</strong>
                <small>{t('module.phase3')}</small>
              </div>
            </li>
            <li>
              <span>04</span>
              <div>
                <strong>{t('module.design')}</strong>
                <small>{t('module.phase4')}</small>
              </div>
            </li>
            <li>
              <span>05</span>
              <div>
                <strong>{t('module.crm')}</strong>
                <small>{t('module.phase5')}</small>
              </div>
            </li>
          </ul>
        </aside>
      </section>

      <section className="section">
        <h2 className="section-title">{t('landing.featuresTitle')}</h2>
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
        <h2 className="section-title">{t('landing.flowTitle')}</h2>
        <ol className="flow">
          {flow.map((key, index) => (
            <li key={key}>
              <span className="flow-index">{index + 1}</span>
              <p>{t(key)}</p>
            </li>
          ))}
        </ol>
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
