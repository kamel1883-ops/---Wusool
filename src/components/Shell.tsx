import { useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useSession } from '../lib/session';
import { SubscriptionPill } from './ui';
import type { Subscription } from '../lib/api';

type IconName =
  | 'grid'
  | 'building'
  | 'users'
  | 'card'
  | 'clock'
  | 'settings'
  | 'chart'
  | 'file'
  | 'shield'
  | 'layers';

const ICONS: Record<IconName, ReactNode> = {
  grid: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.6" />
    </>
  ),
  building: (
    <>
      <path d="M4 20V5.5A1.5 1.5 0 0 1 5.5 4h7A1.5 1.5 0 0 1 14 5.5V20" />
      <path d="M14 10h4.5A1.5 1.5 0 0 1 20 11.5V20" />
      <path d="M3 20h18M7.5 8h3M7.5 12h3M7.5 16h3M16.5 14h1M16.5 17h1" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
      <path d="M16 5.5a3 3 0 0 1 0 5.8M17.5 15c2 .6 3.5 2.3 3.5 5" />
    </>
  ),
  card: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="2.4" />
      <path d="M3 10h18M6.5 14.5h4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2.2M12 18.3v2.2M4.9 7.5l1.9 1.1M17.2 15.4l1.9 1.1M4.9 16.5l1.9-1.1M17.2 8.6l1.9-1.1" />
    </>
  ),
  chart: (
    <>
      <path d="M4 19.5V12M10 19.5V5.5M16 19.5v-5M22 19.5H2" />
    </>
  ),
  file: (
    <>
      <path d="M6 3.5h7l5 5V20a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 20V5a1.5 1.5 0 0 1 0-1.5Z" />
      <path d="M13 3.5V9h5M9.5 13h5M9.5 16.5h5" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3.2 19 6v5.4c0 4.3-2.8 7.4-7 9.4-4.2-2-7-5.1-7-9.4V6l7-2.8Z" />
      <path d="m9 12 2.2 2.2L15.5 10" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3.5 8 4.2-8 4.3-8-4.3 8-4.2Z" />
      <path d="m4 12.5 8 4.3 8-4.3M4 16.8l8 4.2 8-4.2" />
    </>
  ),
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className="nav-icon"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {ICONS[name]}
    </svg>
  );
}

export type NavItem = {
  to: string;
  label: string;
  icon: IconName;
  end?: boolean;
};

export function AppShell({
  nav,
  sectionLabel,
  subscription,
  children,
}: {
  nav: NavItem[];
  sectionLabel: string;
  subscription?: Subscription | null;
  children: ReactNode;
}) {
  const { me, locale, setLocale, signOut } = useSession();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const brandName = locale === 'ar' ? me?.branding.nameAr : me?.branding.nameEn;
  const brandAlt = locale === 'ar' ? me?.branding.nameEn : me?.branding.nameAr;

  const handleSignOut = async () => {
    await signOut();
    navigate('/login', { replace: true });
  };

  return (
    <div className={open ? 'shell nav-open' : 'shell'}>
      <div className="shell-scrim" onClick={() => setOpen(false)} aria-hidden />
      <aside className="sidebar">
        <div className="sidebar-brand">
          <img
            src={me?.branding.logoUrl || '/brand/logo.svg'}
            alt=""
            className="logo-tile"
            onError={(event) => {
              const img = event.currentTarget;
              // A configured URL can go stale; keep the mark visible instead of
              // showing a broken image.
              if (img.getAttribute('src') !== '/brand/logo.svg') img.src = '/brand/logo.svg';
            }}
          />
          <div className="sidebar-brand-text">
            <strong>{brandName || 'وصول'}</strong>
            <span dir={locale === 'ar' ? 'ltr' : 'rtl'}>{brandAlt || 'Wusool'}</span>
          </div>
        </div>

        <span className="sidebar-section">{sectionLabel}</span>
        <nav className="sidebar-nav">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => (isActive ? 'nav-link nav-link-active' : 'nav-link')}
              onClick={() => setOpen(false)}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="sidebar-user">
            <span className="avatar" aria-hidden>
              {(me?.user.name ?? '?').trim().charAt(0)}
            </span>
            <div className="sidebar-user-text">
              <strong>{me?.user.name}</strong>
              <span dir="ltr">{me?.user.email}</span>
            </div>
          </div>
          <button type="button" className="nav-link nav-link-button" onClick={handleSignOut}>
            <Icon name="shield" />
            <span>{locale === 'ar' ? 'تسجيل الخروج' : 'Sign out'}</span>
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button
            type="button"
            className="icon-btn mobile-only"
            onClick={() => setOpen((value) => !value)}
            aria-label="menu"
          >
            ☰
          </button>
          <div className="topbar-brand mobile-only">{brandName || 'وصول'}</div>
          <div className="topbar-spacer" />
          {subscription ? (
            <SubscriptionPill
              status={subscription.effectiveStatus}
              daysLeft={subscription.daysLeft}
            />
          ) : null}
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
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}

export function FullPageLoading({ label }: { label?: string }) {
  return (
    <div className="boot-screen">
      <img src="/brand/logo.svg" alt="" className="boot-logo" />
      <span className="spinner" aria-hidden />
      {label ? <p>{label}</p> : null}
    </div>
  );
}
