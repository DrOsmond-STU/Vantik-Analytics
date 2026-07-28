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
import { goTo } from './public.tsx';

export function LoginView(): JSX.Element {
  const { t, locale, theme, setLocale, setTheme, refreshSession } = useApp();
  const [tenantSlug, setTenantSlug] = useState('demo');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  /** Terisi bila server meminta faktor kedua; formulir berganti ke langkah kode. */
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [code, setCode] = useState('');

  function reportError(error: unknown): void {
    if (error instanceof ApiError) {
      setErrorKey(error.key);
      setRecoveryKey(error.recoveryKey);
      // Tantangan yang sudah mati tidak boleh menyisakan formulir kode yang tak berguna;
      // pengguna dikembalikan ke langkah kata sandi dengan alasan yang terbaca.
      if (error.key === 'error.mfa_challenge_invalid' || error.key === 'error.mfa_too_many_attempts') {
        setChallengeToken(null);
        setCode('');
      }
    } else {
      setErrorKey('error.internal');
    }
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setErrorKey(null);
    setRecoveryKey(null);
    try {
      const result = await api.login({
        email,
        password,
        tenantSlug: tenantSlug || undefined,
        // Atribut perangkat dikirim sebagai MASUKAN; server yang menghitung & memutuskan.
        fingerprint: collectFingerprint(),
      });
      if ('mfaRequired' in result) {
        setChallengeToken(result.challengeToken);
        return;
      }
      await refreshSession();
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!challengeToken) return;
    setBusy(true);
    setErrorKey(null);
    setRecoveryKey(null);
    try {
      await api.verifyMfa({ challengeToken, code, fingerprint: collectFingerprint() });
      await refreshSession();
    } catch (error) {
      reportError(error);
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

        <h1 style={{ fontSize: 18, marginBottom: 4 }}>
          {challengeToken ? t('ui.mfa_step_title') : t('ui.login_title')}
        </h1>
        <p style={{ color: 'var(--text-600)', fontSize: 12.5, marginTop: 0, marginBottom: 20 }}>
          {challengeToken ? t('ui.mfa_step_hint') : t('ui.tagline')}
        </p>

        {challengeToken ? (
          <form onSubmit={(event) => void submitCode(event)}>
            <Field label={t('ui.mfa_code')} hint={t('ui.mfa_code_hint')}>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                // `one-time-code` membuat peramban & iOS menawarkan kode dari SMS/keychain,
                // dan `inputMode` memunculkan papan tuts angka di ponsel.
                autoComplete="one-time-code"
                inputMode="numeric"
                autoFocus
                required
              />
            </Field>

            {errorKey && (
              <div className="note warn" style={{ marginBottom: 14 }}>
                <div>{t(errorKey)}</div>
                {recoveryKey && <div style={{ marginTop: 6 }}>{t(recoveryKey)}</div>}
              </div>
            )}

            <button type="submit" className="btn primary" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>
              {busy ? t('ui.loading') : t('action.verify')}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                setChallengeToken(null);
                setCode('');
                setErrorKey(null);
                setRecoveryKey(null);
              }}
              style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
            >
              {t('action.back')}
            </button>
          </form>
        ) : (
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

            {/* Jalan keluar bagi orang yang tidak dapat masuk. Tanpa ini, layar masuk
                adalah jalan buntu: satu-satunya pilihan adalah menebak lagi. */}
            <div className="login-links">
              <button type="button" className="linkbtn" onClick={() => goTo('forgot')}>
                {t('action.forgot_password')}
              </button>
              <button type="button" className="linkbtn" onClick={() => goTo('landing')}>
                {t('action.back_to_home')}
              </button>
            </div>
          </form>
        )}

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
