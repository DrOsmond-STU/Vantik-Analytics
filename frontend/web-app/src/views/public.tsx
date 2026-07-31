/**
 * Halaman yang dapat dilihat SEBELUM masuk: halaman depan, berlangganan, dan pemulihan
 * kata sandi.
 *
 * Semuanya memakai token desain yang sama dengan bagian dalam aplikasi (DESIGN.md 2.1),
 * bukan gaya terpisah — pengunjung yang kemudian berlangganan harus mengenali produk yang
 * sama, bukan merasa berpindah ke aplikasi lain setelah masuk.
 */
import { useEffect, useState } from 'react';
import { useApp } from '../app/AppContext.tsx';
import {
  api,
  ApiError,
  type BillingCycle,
  type BillingCycleOption,
  type PublicPlan,
  type PublicPlans,
} from '../lib/api.ts';
import { collectFingerprint } from '../lib/fingerprint.ts';
import { Card, Field } from '../components/primitives.tsx';
import { NAV_GROUPS } from '../app/navigation.ts';

/** Rute publik berbasis hash. Dipakai App.tsx untuk memilih halaman. */
export type PublicRoute = 'landing' | 'login' | 'signup' | 'forgot' | 'reset';

export function publicRouteFromHash(hash: string): PublicRoute {
  const value = hash.replace(/^#\/?/, '');
  if (value === 'masuk') return 'login';
  if (value === 'daftar') return 'signup';
  if (value === 'lupa-sandi') return 'forgot';
  if (value.startsWith('atur-ulang')) return 'reset';
  return 'landing';
}

export function goTo(route: PublicRoute): void {
  const hash =
    route === 'login' ? '#/masuk'
    : route === 'signup' ? '#/daftar'
    : route === 'forgot' ? '#/lupa-sandi'
    : route === 'reset' ? '#/atur-ulang'
    : '#/';
  window.location.hash = hash;
}

/** Rupiah tanpa desimal; harga paket selalu bilangan bulat. */
function formatPrice(value: number, locale: string): string {
  if (value === 0) return locale === 'id' ? 'Gratis' : 'Free';
  return new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(value);
}

function quotaLabel(value: number, locale: string): string {
  return value < 0 ? (locale === 'id' ? 'Tanpa batas' : 'Unlimited') : new Intl.NumberFormat().format(value);
}

/** Kunci kamus untuk nama siklus; dipetakan sekali supaya tidak tersebar di beberapa berkas. */
export const CYCLE_LABEL_KEY: Record<BillingCycle, string> = {
  monthly: 'ui.cycle_monthly',
  quarterly: 'ui.cycle_quarterly',
  semiannual: 'ui.cycle_semiannual',
  annual: 'ui.cycle_annual',
};

/**
 * Daftar siklus yang dipakai antarmuka.
 *
 * Server-lah sumbernya; daftar bawaan ini hanya dipakai bila katalog gagal dimuat,
 * supaya formulir pendaftaran tetap dapat dipakai alih-alih menampilkan pemilih kosong.
 */
export const FALLBACK_CYCLES: BillingCycleOption[] = [
  { code: 'monthly', months: 1, discount: 0, sortOrder: 1 },
  { code: 'quarterly', months: 3, discount: 0.05, sortOrder: 2 },
  { code: 'semiannual', months: 6, discount: 0.1, sortOrder: 3 },
  { code: 'annual', months: 12, discount: 1 / 6, sortOrder: 4 },
];

/**
 * Harga satu paket untuk satu siklus.
 *
 * Angkanya diambil apa adanya dari server. Kalau medan `prices` tidak ada (server lama),
 * yang ditampilkan adalah harga bulanan × jumlah bulan TANPA diskon — sengaja tidak
 * menebak diskon, karena menebak terlalu rendah berarti memajang harga yang tidak akan
 * ditagihkan.
 */
export function priceForCycle(plan: PublicPlan, cycle: BillingCycle, months: number): number {
  return plan.prices?.[cycle] ?? plan.monthlyPrice * months;
}

/* ================= Kerangka halaman publik ================= */

function PublicShell({ children }: { children: React.ReactNode }): JSX.Element {
  const { t, locale, theme, setLocale, setTheme } = useApp();
  return (
    <div className="public-shell">
      <header className="public-nav">
        <button type="button" className="brand" onClick={() => goTo('landing')}>
          <div className="mark">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M4 18L10 8L14 14L20 4" stroke="white" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="name">
            Vantik<span>.</span>
          </div>
        </button>
        <div className="public-nav-actions">
          <button type="button" className="iconbtn" onClick={() => setLocale(locale === 'id' ? 'en' : 'id')}>
            {locale.toUpperCase()}
          </button>
          <button type="button" className="iconbtn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? '☀' : '☾'}
          </button>
          <button type="button" className="btn" onClick={() => goTo('login')}>
            {t('action.login')}
          </button>
        </div>
      </header>
      {children}
      <footer className="public-foot">
        <span>© {new Date().getFullYear()} Vantik Analytics</span>
        <span>{t('ui.tagline')}</span>
      </footer>
    </div>
  );
}

/* ================= Halaman depan ================= */

export function LandingView(): JSX.Element {
  const { t, locale } = useApp();
  const [catalog, setCatalog] = useState<PublicPlans | null>(null);
  const [cycle, setCycle] = useState<BillingCycle>('monthly');

  useEffect(() => {
    // Kegagalan memuat katalog TIDAK mengosongkan halaman: penjelasan produk tetap
    // berguna, hanya bagian harga yang absen.
    api.plans().then(setCatalog).catch(() => setCatalog(null));
  }, []);

  return (
    <PublicShell>
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow">{t('ui.landing_eyebrow')}</div>
          <h1>{t('ui.landing_headline')}</h1>
          <p>{t('ui.landing_sub')}</p>
          <div className="hero-cta">
            {catalog?.signupEnabled !== false && (
              <button type="button" className="btn primary" onClick={() => goTo('signup')}>
                {t('action.start_trial')}
              </button>
            )}
            <button type="button" className="btn" onClick={() => goTo('login')}>
              {t('action.login')}
            </button>
          </div>
          <div className="hero-note">{t('ui.landing_trial_note')}</div>
        </div>
      </section>

      {/* Delapan domain adalah struktur produk yang sebenarnya (PRD Lampiran B), bukan
          daftar fitur pemasaran yang disusun terpisah dan lambat laun tidak cocok lagi
          dengan aplikasinya. Sumbernya sama dengan navigasi di dalam aplikasi. */}
      <section className="public-section">
        <h2>{t('ui.landing_modules_title')}</h2>
        <p className="section-sub">{t('ui.landing_modules_sub', { modules: NAV_GROUPS.reduce((n, g) => n + g.items.length, 0), domains: NAV_GROUPS.length })}</p>
        <div className="feature-grid">
          {NAV_GROUPS.map((group) => (
            <Card key={group.labelKey} className="feature-card">
              <h3>{t(group.labelKey)}</h3>
              <ul>
                {group.items.map((item) => (
                  <li key={item.view}>{item.label}</li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      </section>

      <section className="public-section">
        <h2>{t('ui.landing_why_title')}</h2>
        <div className="feature-grid">
          {(
            [
              ['ui.landing_why_1_title', 'ui.landing_why_1_body'],
              ['ui.landing_why_2_title', 'ui.landing_why_2_body'],
              ['ui.landing_why_3_title', 'ui.landing_why_3_body'],
              ['ui.landing_why_4_title', 'ui.landing_why_4_body'],
            ] as const
          ).map(([title, body]) => (
            <Card key={title} className="feature-card">
              <h3>{t(title)}</h3>
              <p>{t(body)}</p>
            </Card>
          ))}
        </div>
      </section>

      <section className="public-section" id="paket">
        <h2>{t('ui.landing_plans_title')}</h2>
        <p className="section-sub">{t('ui.landing_plans_sub')}</p>
        {catalog === null ? (
          <p className="section-sub">{t('ui.loading')}</p>
        ) : (
          <>
            {/* Pemilih siklus berada DI ATAS kartu, bukan di dalam masing-masing kartu:
                pengunjung membandingkan paket pada jangka waktu yang sama, bukan
                membaca empat angka per kartu dan menghitung sendiri. */}
            <CycleSwitch
              cycles={catalog.cycles ?? FALLBACK_CYCLES}
              value={cycle}
              onChange={setCycle}
            />
            <div className="plan-grid">
              {[...catalog.plans].sort((a, b) => a.sortOrder - b.sortOrder).map((plan) => (
                <PlanCard
                  key={plan.code}
                  plan={plan}
                  locale={locale}
                  cycle={(catalog.cycles ?? FALLBACK_CYCLES).find((c) => c.code === cycle) ?? FALLBACK_CYCLES[0]!}
                  signupEnabled={catalog.signupEnabled}
                />
              ))}
            </div>
          </>
        )}
      </section>
    </PublicShell>
  );
}

/** Tombol-tombol jangka waktu berlangganan: 1, 3, 6, atau 12 bulan. */
export function CycleSwitch({
  cycles,
  value,
  onChange,
}: {
  cycles: BillingCycleOption[];
  value: BillingCycle;
  onChange: (cycle: BillingCycle) => void;
}): JSX.Element {
  const { t } = useApp();
  return (
    <div className="cycle-switch" role="group" aria-label={t('ui.signup_cycle')}>
      {[...cycles]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((option) => (
          <button
            key={option.code}
            type="button"
            className={`cycle-option${option.code === value ? ' is-active' : ''}`}
            aria-pressed={option.code === value}
            onClick={() => onChange(option.code)}
          >
            {t(CYCLE_LABEL_KEY[option.code])}
            {option.discount > 0 && (
              <span className="cycle-save">{t('ui.cycle_save', { percent: Math.round(option.discount * 100) })}</span>
            )}
          </button>
        ))}
    </div>
  );
}

function PlanCard({
  plan,
  locale,
  cycle,
  signupEnabled,
}: {
  plan: PublicPlan;
  locale: string;
  cycle: BillingCycleOption;
  signupEnabled: boolean;
}): JSX.Element {
  const { t } = useApp();
  const price = priceForCycle(plan, cycle.code, cycle.months);
  return (
    <Card className="plan-card">
      <div className="plan-name">{plan.name}</div>
      <div className="plan-price">
        {formatPrice(price, locale)}
        {price > 0 && <span className="per">{t('ui.per_cycle', { cycle: t(CYCLE_LABEL_KEY[cycle.code]) })}</span>}
      </div>
      {price > 0 && cycle.months > 1 && (
        <div className="plan-annual">
          {t('ui.plan_per_month_equivalent', { price: formatPrice(Math.round(price / cycle.months), locale) })}
        </div>
      )}
      <ul className="plan-features">
        <li>{t('ui.plan_modules', { count: plan.moduleCount })}</li>
        <li>{t('ui.plan_users', { value: quotaLabel(plan.quotas.users ?? 0, locale) })}</li>
        <li>{t('ui.plan_datasets', { value: quotaLabel(plan.quotas.datasets ?? 0, locale) })}</li>
        <li>{t('ui.plan_ai', { value: quotaLabel(plan.quotas.ai_calls_monthly ?? 0, locale) })}</li>
      </ul>
      {signupEnabled && (
        <button type="button" className="btn primary" onClick={() => goTo('signup')}>
          {t('action.subscribe')}
        </button>
      )}
    </Card>
  );
}

/* ================= Berlangganan ================= */

/** Slug dari nama organisasi: huruf kecil, tanpa simbol, tanpa tanda hubung ganda. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export function SignupView(): JSX.Element {
  const { t, locale } = useApp();
  const [catalog, setCatalog] = useState<PublicPlans | null>(null);
  const [plan, setPlan] = useState('professional');
  const [cycle, setCycle] = useState<BillingCycle>('monthly');
  const [organisation, setOrganisation] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [slug, setSlug] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [done, setDone] = useState<{ slug: string; pendingApproval: boolean } | null>(null);

  useEffect(() => {
    api.plans().then(setCatalog).catch(() => setCatalog(null));
  }, []);

  const cycleOptions = [...(catalog?.cycles ?? FALLBACK_CYCLES)].sort((a, b) => a.sortOrder - b.sortOrder);
  const cycleOption = cycleOptions.find((c) => c.code === cycle) ?? FALLBACK_CYCLES[0]!;
  const selectedPlan = catalog?.plans.find((p) => p.code === plan) ?? null;

  function onOrganisation(value: string): void {
    setOrganisation(value);
    // Slug mengikuti nama sampai pengguna menyuntingnya sendiri; setelah itu ia berhenti
    // berubah, karena alamat ruang kerja yang bergeser saat mengetik nama membingungkan.
    if (!slugEdited) setSlug(slugify(value));
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setErrorKey(null);
    try {
      const result = await api.signup({
        organisationName: organisation,
        slug,
        planCode: plan,
        billingCycle: cycle,
        fullName,
        email,
        password,
      });
      setDone({ slug: result.slug, pendingApproval: result.pendingApproval === true });
    } catch (error) {
      setErrorKey(error instanceof ApiError ? error.key : 'error.internal');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <PublicShell>
        <section className="public-form">
          {/* Layar ini menyatakan keadaan yang SEBENARNYA. Selama pendaftaran menunggu
              persetujuan, tombol "Masuk" hanya akan mengantar ke penolakan, dan orang
              yang ditolak akan mengira kata sandinya salah lalu mencoba lagi sampai
              akunnya terkunci. */}
          <Card className="login-card">
            <h1>{t(done.pendingApproval ? 'ui.signup_pending_title' : 'ui.signup_done_title')}</h1>
            <p>
              {t(done.pendingApproval ? 'ui.signup_pending_body' : 'ui.signup_done_body', { slug: done.slug })}
            </p>
            <button
              type="button"
              className={done.pendingApproval ? 'btn' : 'btn primary'}
              style={{ width: '100%', justifyContent: 'center' }}
              onClick={() => goTo(done.pendingApproval ? 'landing' : 'login')}
            >
              {t(done.pendingApproval ? 'action.back_to_home' : 'action.login')}
            </button>
          </Card>
        </section>
      </PublicShell>
    );
  }

  return (
    <PublicShell>
      <section className="public-form">
        <Card className="login-card signup-card">
          <h1>{t('ui.signup_title')}</h1>
          <p className="section-sub">{t('ui.signup_sub')}</p>

          {catalog?.signupEnabled === false ? (
            <div className="note warn">{t('error.signup_disabled')}</div>
          ) : (
            <form onSubmit={(event) => void submit(event)}>
              <Field label={t('ui.signup_plan')}>
                <select value={plan} onChange={(e) => setPlan(e.target.value)}>
                  {(catalog?.plans ?? []).map((p) => (
                    <option key={p.code} value={p.code}>
                      {p.name} — {formatPrice(priceForCycle(p, cycle, cycleOption.months), locale)}
                      {p.monthlyPrice > 0 ? ` / ${t(CYCLE_LABEL_KEY[cycle])}` : ''}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('ui.signup_cycle')} hint={t('ui.signup_cycle_hint')}>
                <select value={cycle} onChange={(e) => setCycle(e.target.value as BillingCycle)}>
                  {cycleOptions.map((option) => (
                    <option key={option.code} value={option.code}>
                      {t(CYCLE_LABEL_KEY[option.code])}
                      {option.discount > 0 ? ` — ${t('ui.cycle_save', { percent: Math.round(option.discount * 100) })}` : ''}
                    </option>
                  ))}
                </select>
              </Field>

              {/* Yang akan ditagihkan setelah uji coba, dinyatakan sebelum orang mengisi
                  data diri — bukan kejutan di layar terakhir. */}
              {selectedPlan && (
                <div className="note" data-testid="signup-summary" style={{ marginBottom: 14 }}>
                  {t('ui.signup_summary', {
                    plan: selectedPlan.name,
                    price: formatPrice(priceForCycle(selectedPlan, cycle, cycleOption.months), locale),
                    cycle: t(CYCLE_LABEL_KEY[cycle]),
                  })}
                </div>
              )}
              <Field label={t('ui.signup_org')}>
                <input value={organisation} onChange={(e) => onOrganisation(e.target.value)} autoComplete="organization" required />
              </Field>
              <Field label={t('ui.signup_slug')} hint={t('ui.signup_slug_hint')}>
                <input
                  value={slug}
                  onChange={(e) => {
                    setSlugEdited(true);
                    setSlug(slugify(e.target.value));
                  }}
                  required
                />
              </Field>
              <Field label={t('ui.signup_name')}>
                <input value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" required />
              </Field>
              <Field label={t('ui.login_email')}>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
              </Field>
              <Field label={t('ui.login_password')} hint={t('ui.password_policy')}>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
              </Field>

              {errorKey && <div className="note warn">{t(errorKey)}</div>}

              <button type="submit" className="btn primary" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>
                {busy ? t('ui.loading') : t('action.subscribe')}
              </button>
            </form>
          )}
        </Card>
      </section>
    </PublicShell>
  );
}

/* ================= Lupa kata sandi ================= */

export function ForgotPasswordView(): JSX.Element {
  const { t } = useApp();
  const [email, setEmail] = useState('');
  const [tenantSlug, setTenantSlug] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{ transportConfigured: boolean } | null>(null);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api.requestPasswordReset({ email, tenantSlug: tenantSlug || undefined });
      setSent({ transportConfigured: result.transportConfigured });
    } catch {
      // Kegagalan jaringan pun TIDAK boleh menghasilkan pesan berbeda: layar yang
      // membedakan "terkirim" dari "gagal" untuk alamat tertentu akan membocorkan
      // alamat mana yang punya akun, tepat hal yang dicegah server.
      setSent({ transportConfigured: false });
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <PublicShell>
        <section className="public-form">
          <Card className="login-card">
            <h1>{t('ui.forgot_sent_title')}</h1>
            <p>{t('ui.forgot_sent_body')}</p>
            {!sent.transportConfigured && <div className="note warn">{t('ui.forgot_no_transport')}</div>}
            <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
              <button type="button" className="btn primary" style={{ justifyContent: 'center' }} onClick={() => goTo('reset')}>
                {t('action.have_reset_code')}
              </button>
              <button type="button" className="btn" style={{ justifyContent: 'center' }} onClick={() => goTo('login')}>
                {t('action.back')}
              </button>
            </div>
          </Card>
        </section>
      </PublicShell>
    );
  }

  return (
    <PublicShell>
      <section className="public-form">
        <Card className="login-card">
          <h1>{t('ui.forgot_title')}</h1>
          <p className="section-sub">{t('ui.forgot_sub')}</p>
          <form onSubmit={(event) => void submit(event)}>
            <Field label={t('ui.login_tenant')} hint={t('ui.forgot_tenant_hint')}>
              <input value={tenantSlug} onChange={(e) => setTenantSlug(e.target.value)} autoComplete="organization" />
            </Field>
            <Field label={t('ui.login_email')}>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
            </Field>
            <button type="submit" className="btn primary" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>
              {busy ? t('ui.loading') : t('action.send_reset')}
            </button>
            <button type="button" className="btn" style={{ width: '100%', justifyContent: 'center', marginTop: 8 }} onClick={() => goTo('login')}>
              {t('action.back')}
            </button>
          </form>
        </Card>
      </section>
    </PublicShell>
  );
}

/* ================= Atur ulang dengan token ================= */

export function ResetPasswordView(): JSX.Element {
  const { t } = useApp();
  // Token boleh datang dari tautan (#/atur-ulang?token=…) atau ditempel manual, karena
  // selama belum ada transport nyata pengguna menerimanya dari Admin, bukan dari email.
  const [token, setToken] = useState(() => new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('token') ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const mismatch = confirm.length > 0 && password !== confirm;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setErrorKey(null);
    try {
      await api.confirmPasswordReset({ token: token.trim(), newPassword: password });
      setDone(true);
    } catch (error) {
      setErrorKey(error instanceof ApiError ? error.key : 'error.internal');
    } finally {
      setBusy(false);
    }
  }

  return (
    <PublicShell>
      <section className="public-form">
        <Card className="login-card">
          <h1>{t('ui.reset_title')}</h1>
          {done ? (
            <>
              <p>{t('ui.reset_done')}</p>
              <button type="button" className="btn primary" style={{ width: '100%', justifyContent: 'center' }} onClick={() => goTo('login')}>
                {t('action.login')}
              </button>
            </>
          ) : (
            <form onSubmit={(event) => void submit(event)}>
              <Field label={t('ui.reset_token')} hint={t('ui.reset_token_hint')}>
                <input value={token} onChange={(e) => setToken(e.target.value)} required />
              </Field>
              <Field label={t('ui.password_new')} hint={t('ui.password_policy')}>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
              </Field>
              <Field label={t('ui.password_confirm')}>
                <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
              </Field>

              {mismatch && <div className="note warn">{t('error.password_confirm_mismatch')}</div>}
              {errorKey && <div className="note warn">{t(errorKey)}</div>}

              <button type="submit" className="btn primary" disabled={busy || mismatch} style={{ width: '100%', justifyContent: 'center' }}>
                {busy ? t('ui.loading') : t('action.reset_password')}
              </button>
            </form>
          )}
        </Card>
      </section>
    </PublicShell>
  );
}

/* ================= Kembali dari penyedia SSO ================= */

/**
 * Membaca `code` dan `state` dari alamat.
 *
 * Dikenali dari ADANYA kedua parameter, bukan dari lintasan tertentu: `redirect_uri`
 * diisi operator dan didaftarkan di sisi penyedia, jadi lintasannya tidak dapat
 * ditebak dari sini. Keduanya bersama-sama tidak dipakai halaman lain mana pun.
 */
export function readSsoCallback(search: string): { code: string; state: string } | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) return null;
  return { code, state };
}

/**
 * Halaman singgah setelah penyedia mengembalikan pengguna.
 *
 * Tugasnya satu: menghitung sidik perangkat — yang hanya dapat dilakukan di peramban —
 * lalu menukar `code` menjadi sesi. Pengguna tidak diminta melakukan apa pun di sini.
 */
export function SsoCallbackView({ code, state }: { code: string; state: string }): JSX.Element {
  const { t, refreshSession } = useApp();
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.ssoCallback({ code, state, fingerprint: collectFingerprint() });
        if (cancelled) return;
        /**
         * Kode otorisasi dibuang dari alamat SEBELUM sesi dimuat.
         *
         * Tanpa ini, menyegarkan halaman mengirim ulang kode yang sudah dipakai dan
         * pengguna disambut pesan kegagalan tepat setelah berhasil masuk. Alamatnya juga
         * tersimpan di riwayat peramban dan mudah tersalin ke orang lain.
         */
        window.history.replaceState(null, '', result.redirectTo ?? window.location.pathname);
        await refreshSession();
      } catch (error) {
        if (cancelled) return;
        setErrorKey(error instanceof ApiError ? error.key : 'error.internal');
        setRecoveryKey(error instanceof ApiError ? (error.recoveryKey ?? 'recovery.sso_start_again') : null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, state, refreshSession]);

  return (
    <PublicShell>
      <section className="public-form">
        <Card className="login-card">
          {errorKey ? (
            <>
              <div className="note warn">
                <div>{t(errorKey)}</div>
                {recoveryKey && <div style={{ marginTop: 6 }}>{t(recoveryKey)}</div>}
              </div>
              <button
                type="button"
                className="btn primary"
                style={{ width: '100%', justifyContent: 'center' }}
                onClick={() => {
                  // Alamat dibersihkan lebih dulu; membiarkan `code` di sana berarti
                  // percobaan berikutnya mendarat kembali di halaman ini.
                  window.history.replaceState(null, '', window.location.pathname);
                  goTo('login');
                }}
              >
                {t('action.login')}
              </button>
            </>
          ) : (
            <p>{t('ui.sso_finishing')}</p>
          )}
        </Card>
      </section>
    </PublicShell>
  );
}
