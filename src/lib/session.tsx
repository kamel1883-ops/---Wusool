import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, type Me } from './api';
import { translate, type Locale } from './i18n';

type SessionContextValue = {
  me: Me | null;
  loading: boolean;
  locale: Locale;
  t: (key: string, fallback?: string) => string;
  setLocale: (locale: Locale) => Promise<void>;
  refresh: () => Promise<Me | null>;
  signOut: () => Promise<void>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

const LOCALE_STORAGE_KEY = 'ws_locale';

const readStoredLocale = (): Locale => {
  if (typeof window === 'undefined') return 'ar';
  const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  return stored === 'en' ? 'en' : 'ar';
};

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [locale, setLocaleState] = useState<Locale>(readStoredLocale);

  const refresh = useCallback(async () => {
    try {
      const result = await api<Me>('/api/auth/me');
      setMe(result);
      return result;
    } catch {
      setMe(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const effectiveLocale: Locale = me?.user.locale ?? locale;

  // Apply language + direction, and the branding tokens that come from
  // platform settings (so colours can change without a code change).
  useEffect(() => {
    const root = document.documentElement;
    root.lang = effectiveLocale;
    root.dir = effectiveLocale === 'ar' ? 'rtl' : 'ltr';
    if (me?.branding.primaryColor) {
      root.style.setProperty('--brand', me.branding.primaryColor);
    }
    if (me?.branding.inkColor) {
      root.style.setProperty('--ink', me.branding.inkColor);
    }
    document.title = `${effectiveLocale === 'ar' ? me?.branding.nameAr ?? 'وصول' : me?.branding.nameEn ?? 'Wusool'}`;
  }, [effectiveLocale, me?.branding]);

  const setLocale = useCallback(
    async (next: Locale) => {
      setLocaleState(next);
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
      if (me) {
        try {
          await api('/api/auth/profile', { method: 'PATCH', body: { locale: next } });
          setMe((current) => (current ? { ...current, user: { ...current.user, locale: next } } : current));
        } catch {
          // Language is a preference; a failed save must not block the UI.
        }
      }
    },
    [me]
  );

  const t = useCallback(
    (key: string, fallback?: string) => translate(effectiveLocale, key, fallback),
    [effectiveLocale]
  );

  const signOut = useCallback(async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } finally {
      setMe(null);
    }
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({ me, loading, locale: effectiveLocale, t, setLocale, refresh, signOut }),
    [me, loading, effectiveLocale, t, setLocale, refresh, signOut]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside SessionProvider');
  return context;
}
