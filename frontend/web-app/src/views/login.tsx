/**
 * Layar masuk.
 *
 * SECURITY.md 17.4: pesan penolakan menjelaskan ALASAN dan LANGKAH PEMULIHAN
 * ("akun ini terikat perangkat lain — ajukan pemindahan ke Admin"), bukan sekadar
 * "akses ditolak".
 */
import { useState } from 'react';
import { useApp } from '../app/AppContext.tsx';
import { api, ApiError } from '../lib/api.ts';
import { collectFingerprint } from '../lib/fingerprint.ts';
import { Card, Field } from '../components/primitives.tsx';

export function LoginView(): JSX.Element {
  const { t, locale, theme, setLocale, setTheme, refreshSession } = useApp();
  const [tenantSlug, setTenantSlug] = useState('demo');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setErrorKey(null);
    setRecoveryKey(null);
    try {
      await api.login({
        email,
        password,
        tenantSlug: tenantSlug || undefined,
        // Atribut perangkat dikirim sebagai MASUKAN; server yang menghitung & memutuskan.
        fingerprint: collectFingerprint(),
      });
      await refreshSession();
    } catch (error) {
      if (error instanceof ApiError) {
        setErrorKey(error.key);
        setRecoveryKey(error.recoveryKey);
      } else {
        setErrorKey('error.internal');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-shell">
      <Card className="login-card">
        <div className="brand">
          <div className="mark">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M4 18L10 8L14 14L20 4" stroke="white" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="name" style={{ color: 'var(--text-900)' }}>
            Vantik<span>.</span>
          </div>
        </div>

        <h1 style={{ fontSize: 18, marginBottom: 4 }}>{t('ui.login_title')}</h1>
        <p style={{ color: 'var(--text-600)', fontSize: 12.5, marginTop: 0, marginBottom: 20 }}>{t('ui.tagline')}</p>

        <form onSubmit={(event) => void submit(event)}>
          <Field label={t('ui.login_tenant')}>
            <input value={tenantSlug} onChange={(e) => setTenantSlug(e.target.value)} autoComplete="organization" />
          </Field>
          <Field label={t('ui.login_email')}>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
          </Field>
          <Field label={t('ui.login_password')}>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
          </Field>

          {errorKey && (
            <div className="note warn" style={{ marginBottom: 14 }}>
              <div>{t(errorKey)}</div>
              {recoveryKey && <div style={{ marginTop: 6 }}>{t(recoveryKey)}</div>}
            </div>
          )}

          <button type="submit" className="btn primary" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>
            {busy ? t('ui.loading') : t('action.login')}
          </button>
        </form>

        <div style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: 'center' }}>
          <button type="button" className="iconbtn" onClick={() => setLocale(locale === 'id' ? 'en' : 'id')}>
            {locale.toUpperCase()}
          </button>
          <button type="button" className="iconbtn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? '☀' : '☾'}
          </button>
        </div>
      </Card>
    </div>
  );
}
