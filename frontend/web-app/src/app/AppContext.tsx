/**
 * Konteks aplikasi: sesi, bahasa, tema.
 *
 * DESIGN.md 7.2 & 13: preferensi tema & bahasa disimpan sebagai atribut PROFIL
 * PENGGUNA (server-side), bukan hanya localStorage, agar konsisten lintas perangkat.
 * localStorage hanya dipakai sebagai cache agar tidak terjadi "flash of wrong theme"
 * sebelum sesi termuat.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, loadToken, setToken, type Session } from '../lib/api.ts';
import { translate, type Locale } from '../i18n/dictionary.ts';

export type Theme = 'light' | 'dark';

interface AppState {
  session: Session | null;
  locale: Locale;
  theme: Theme;
  loading: boolean;
  t: (key: string, params?: Record<string, string | number>) => string;
  setLocale: (locale: Locale) => void;
  setTheme: (theme: Theme) => void;
  refreshSession: () => Promise<void>;
  signOut: () => Promise<void>;
  can: (permission: string) => boolean;
  moduleEnabled: (key: string) => boolean;
}

const AppContext = createContext<AppState | null>(null);

function readCached<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key) as T | null;
    return value && allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function applyDocument(theme: Theme, locale: Locale): void {
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.setAttribute('lang', locale);
}

export function AppProvider({ children }: { children: ReactNode }): JSX.Element {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  // Bahasa Indonesia adalah default sistem (DESIGN.md 8.1).
  const [locale, setLocaleState] = useState<Locale>(() => readCached('vantik.locale', ['id', 'en'] as const, 'id'));
  const [theme, setThemeState] = useState<Theme>(() => readCached('vantik.theme', ['light', 'dark'] as const, 'light'));

  useEffect(() => {
    applyDocument(theme, locale);
    try {
      localStorage.setItem('vantik.theme', theme);
      localStorage.setItem('vantik.locale', locale);
    } catch {
      /* penyimpanan lokal tidak tersedia */
    }
  }, [theme, locale]);

  const refreshSession = useCallback(async () => {
    if (!loadToken()) {
      setSession(null);
      setLoading(false);
      return;
    }
    try {
      const next = await api.get<Session>('/me');
      setSession(next);
      // Preferensi profil (server-side) menang atas cache lokal.
      setLocaleState(next.user.locale);
      setThemeState(next.user.theme);
    } catch {
      setToken(null);
      setSession(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  const setLocale = useCallback(
    (next: Locale) => {
      setLocaleState(next);
      if (session) void api.patch('/me/preferences', { locale: next }).catch(() => undefined);
    },
    [session],
  );

  const setTheme = useCallback(
    (next: Theme) => {
      setThemeState(next);
      if (session) void api.patch('/me/preferences', { theme: next }).catch(() => undefined);
    },
    [session],
  );

  const signOut = useCallback(async () => {
    await api.logout();
    setSession(null);
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>) => translate(key, locale, params),
    [locale],
  );

  const can = useCallback(
    (permission: string) => {
      if (!session) return false;
      const [module, action] = permission.split(':');
      return session.permissions.some((granted) => {
        if (granted === permission) return true;
        const [gModule, gAction] = granted.split(':');
        if (gModule === '*' && gAction === '*') return true;
        if (gModule === module && gAction === '*') return true;
        return gModule === '*' && gAction === action;
      });
    },
    [session],
  );

  const moduleEnabled = useCallback(
    (key: string) => session?.flags.modules[key] === true,
    [session],
  );

  const value = useMemo<AppState>(
    () => ({ session, locale, theme, loading, t, setLocale, setTheme, refreshSession, signOut, can, moduleEnabled }),
    [session, locale, theme, loading, t, setLocale, setTheme, refreshSession, signOut, can, moduleEnabled],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppState {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used inside AppProvider');
  return context;
}
