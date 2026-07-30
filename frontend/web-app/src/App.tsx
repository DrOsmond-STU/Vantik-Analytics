import { useEffect, useState } from 'react';
import { useApp } from './app/AppContext.tsx';
import { NAV_GROUPS, findNavItem } from './app/navigation.ts';
import { NAV_ICONS } from './app/navigationIcons.tsx';
import { VIEWS } from './views/index.ts';
import { ModuleLocked } from './views/shared.tsx';
import { LoginView } from './views/login.tsx';
import {
  ForgotPasswordView,
  LandingView,
  ResetPasswordView,
  SignupView,
  publicRouteFromHash,
} from './views/public.tsx';
import { Icon } from './components/primitives.tsx';

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('');
}

export default function App(): JSX.Element {
  const { session, loading, t, locale, theme, setLocale, setTheme, signOut, moduleEnabled } = useApp();
  const [view, setView] = useState<string>(() => window.location.hash.slice(1) || 'exec');
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    const onHash = (): void => setView(window.location.hash.slice(1) || 'exec');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  function navigate(next: string): void {
    window.location.hash = next;
    setView(next);
    setDrawerOpen(false);
  }

  if (loading) {
    return <div className="login-shell">{t('ui.loading')}</div>;
  }
  // Pengunjung tanpa sesi mendarat di HALAMAN DEPAN, bukan formulir masuk.
  //
  // Sebelumnya setiap orang yang membuka alamatnya langsung dihadapkan kotak email dan
  // kata sandi — tidak ada tempat untuk menjelaskan apa produk ini, dan tidak ada jalan
  // bagi orang yang belum punya akun. Formulir masuk kini satu tujuan di antara beberapa.
  if (!session) {
    switch (publicRouteFromHash(window.location.hash)) {
      case 'login':
        return <LoginView />;
      case 'signup':
        return <SignupView />;
      case 'forgot':
        return <ForgotPasswordView />;
      case 'reset':
        return <ResetPasswordView />;
      default:
        return <LandingView />;
    }
  }

  const current = findNavItem(view);
  const ViewComponent = VIEWS[view] ?? VIEWS.exec!;
  const enabled = current ? moduleEnabled(current.item.moduleKey) : true;

  return (
    <div className="shell">
      <aside className={`sidebar ${drawerOpen ? 'open' : ''}`}>
        <div className="brand">
          <div className="mark">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M4 18L10 8L14 14L20 4" stroke="white" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="name">
            {session.tenant.whiteLabel && session.tenant.logoText ? session.tenant.logoText : 'Vantik'}
            <span>.</span>
          </div>
        </div>

        {NAV_GROUPS.map((group) => (
          <div className="navgroup" key={group.number}>
            {/* Nama domain diterjemahkan; nama modul tidak (BRAND.md Bagian 7). */}
            <div className="label">{group.number} · {t(group.labelKey)}</div>
            {group.items.map((item) => {
              const available = moduleEnabled(item.moduleKey);
              return (
                <button
                  type="button"
                  key={item.view}
                  className={`navitem ${view === item.view ? 'active' : ''} ${available ? '' : 'locked'}`}
                  onClick={() => navigate(item.view)}
                  title={available ? item.label : t('empty.module_not_in_plan')}
                  aria-current={view === item.view ? 'page' : undefined}
                >
                  <Icon path={NAV_ICONS[item.view]} size={17} />
                  <span className="lbl">{item.label}</span>
                </button>
              );
            })}
          </div>
        ))}

        <div className="sidebar-foot">
          <div className="avatar">{initials(session.user.displayName)}</div>
          <div className="who">
            <b>{session.user.displayName}</b>
            <span>{session.user.roles[0] ?? '—'}</span>
          </div>
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <div className="crumb">
            <button type="button" className="iconbtn" style={{ marginRight: 10 }} onClick={() => setDrawerOpen((o) => !o)} aria-label="Menu">
              ☰
            </button>
            {current ? (
              <>
                {t(current.group.labelKey)} / <b>{current.item.label}</b>
              </>
            ) : (
              <b>Vantik Analytics</b>
            )}
          </div>

          <div className="topbar-right">
            <div className="searchbox">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4-4" />
              </svg>
              <input placeholder={t('ui.search_placeholder')} aria-label={t('action.search')} />
            </div>

            {/* Quick-toggle tema di top bar (DESIGN.md 7.2). */}
            <button
              type="button"
              className="iconbtn"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label={t(theme === 'dark' ? 'ui.theme_light' : 'ui.theme_dark')}
              title={t(theme === 'dark' ? 'ui.theme_light' : 'ui.theme_dark')}
            >
              {theme === 'dark' ? '☀' : '☾'}
            </button>

            <button
              type="button"
              className="iconbtn"
              onClick={() => setLocale(locale === 'id' ? 'en' : 'id')}
              aria-label={t('ui.language')}
              title={t('ui.language')}
            >
              {locale.toUpperCase()}
            </button>

            <button type="button" className="iconbtn" onClick={() => void signOut()} title={t('action.logout')} aria-label={t('action.logout')}>
              ⎋
            </button>
          </div>
        </div>

        <div className="content">
          {/* Masa berlaku habis diberi spanduknya sendiri: penyebabnya berbeda dari
              tunggakan, dan langkah pemulihannya ada di layar pengguna — bukan sesuatu
              yang harus ia tanyakan ke dukungan. */}
          {session.flags.readOnly &&
            (session.flags.readOnlyReason === 'subscription_unpaid' ? (
              <div className="note warn" style={{ marginBottom: 16 }}>
                <div>{t('error.subscription_unpaid')}</div>
                <div style={{ marginTop: 6 }}>{t('recovery.activate_subscription')}</div>
              </div>
            ) : session.flags.readOnlyReason === 'subscription_expired' ? (
              <div className="note warn" style={{ marginBottom: 16 }}>
                <div>{t('error.subscription_expired')}</div>
                <div style={{ marginTop: 6 }}>{t('recovery.renew_subscription')}</div>
              </div>
            ) : (
              <div className="note warn" style={{ marginBottom: 16 }}>{t('ui.read_only_banner')}</div>
            ))}
          {enabled ? <ViewComponent /> : <div className="grid g-12"><ModuleLocked /></div>}
        </div>
      </div>
    </div>
  );
}
