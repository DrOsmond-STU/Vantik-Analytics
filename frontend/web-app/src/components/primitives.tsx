/**
 * Komponen inti — DESIGN.md Bagian 6.
 *
 * Semua status disertai ANGKA atau LABEL TEKS, tidak pernah warna saja
 * (DESIGN.md Bagian 9 — aksesibilitas untuk pengguna buta warna).
 */
import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';
import { useApp } from '../app/AppContext.tsx';

export type StatusLevel = 'good' | 'warn' | 'bad' | 'info' | 'muted';

/** Memetakan status KPI/aset ke tingkat visual. */
export function levelOf(status: string | null | undefined): StatusLevel {
  switch (status) {
    case 'on_track':
    case 'certified':
    case 'connected':
    case 'active':
    case 'normal':
    case 'approved':
    case 'validated':
    case 'ready':
    case 'delivered':
    case 'success':
      return 'good';
    case 'at_risk':
    case 'attention':
    case 'sync_pending':
    case 'pending_approval':
    case 'draft':
    case 'processing':
    case 'trial':
    case 'read_only':
    case 'past_due':
    case 'warning':
      return 'warn';
    case 'critical':
    case 'failed':
    case 'auth_failed':
    case 'rejected':
    case 'locked':
    case 'suspended':
    case 'denied':
      return 'bad';
    case 'offline':
    case 'inactive':
    case 'never_tested':
      return 'muted';
    default:
      return 'info';
  }
}

export function StatusTag({ status, label }: { status: string; label?: string }): JSX.Element {
  const { t } = useApp();
  const level = levelOf(status);
  return <span className={`status-tag status-${level}`}>{label ?? t(`status.${status}`)}</span>;
}

/**
 * Threshold Ring — elemen tanda tangan (DESIGN.md Bagian 1 & 6).
 *
 * Dipakai berulang di Executive Cockpit, KPI Center, dan Operational Cockpit: begitu
 * pengguna paham artinya sekali, mereka paham di semua tempat.
 */
export function ThresholdRing({
  score,
  status,
  size = 64,
}: {
  score: number;
  status?: string;
  size?: number;
}): JSX.Element {
  const level = status ? levelOf(status) : score >= 75 ? 'good' : score >= 50 ? 'warn' : 'bad';
  const colour = level === 'good' ? 'var(--good)' : level === 'warn' ? 'var(--warn)' : level === 'bad' ? 'var(--bad)' : 'var(--accent)';
  const clamped = Math.max(0, Math.min(100, score));
  return (
    <div
      className="ring"
      style={{
        width: size,
        height: size,
        background: `conic-gradient(${colour} 0 ${clamped}%, var(--border) ${clamped}% 100%)`,
      }}
      role="img"
      aria-label={`${Math.round(clamped)} / 100`}
    >
      {/* Angka selalu ditampilkan — status tidak pernah lewat warna saja. */}
      <span className="val">{Math.round(clamped)}</span>
    </div>
  );
}

export function Card({
  children,
  className = '',
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}): JSX.Element {
  return (
    <div className={`card ${className}`} style={style}>
      {children}
    </div>
  );
}

export function Panel({
  title,
  subtitle,
  actions,
  children,
  span = 'full',
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  span?: 'full' | 'half' | 'small' | 'wide';
}): JSX.Element {
  const spanClass = span === 'full' ? 'full' : span === 'half' ? 'half' : span === 'small' ? 'small' : '';
  return (
    <Card className={`panel ${spanClass}`}>
      {(title || actions) && (
        <div className="panel-head">
          <div>
            {title && <h3>{title}</h3>}
            {subtitle && <div className="sub">{subtitle}</div>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </Card>
  );
}

/** Segmented control — opsi lebar mengikuti konten (DESIGN.md 3.1). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}): JSX.Element {
  return (
    <div className="seg" role="tablist">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          className={option.value === value ? 'on' : ''}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Kondisi kosong = ajakan bertindak, bukan sekadar "tidak ada data" (DESIGN.md 12). */
export function EmptyState({
  messageKey,
  action,
}: {
  messageKey: string;
  action?: ReactNode;
}): JSX.Element {
  const { t } = useApp();
  return (
    <div className="empty">
      <div>{t(messageKey)}</div>
      {action && <div className="cta">{action}</div>}
    </div>
  );
}

/**
 * Medan formulir berlabel.
 *
 * Label DITAUTKAN ke kontrolnya lewat `htmlFor`/`id`, dan petunjuknya lewat
 * `aria-describedby`. Sebelumnya `<label>` berdiri sendiri tanpa tautan: terlihat benar
 * di layar, tetapi pembaca layar tidak dapat menyebutkan medan mana yang sedang diisi —
 * pada formulir masuk artinya pengguna tidak tahu kotak mana kata sandinya.
 *
 * `id` dibuat `useId()` supaya satu label tidak pernah menaut ke medan milik instans
 * lain ketika komponen yang sama dipakai beberapa kali dalam satu halaman.
 */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}): JSX.Element {
  const id = useId();
  const hintId = `${id}-hint`;
  // Anak tunggal berupa elemen menerima id & keterkaitan petunjuk; bentuk lain
  // (mis. beberapa kontrol sekaligus) dibiarkan apa adanya agar tidak ada id ganda.
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<{ id?: string; 'aria-describedby'?: string }>, {
        id,
        ...(hint ? { 'aria-describedby': hintId } : {}),
      })
    : children;

  return (
    <div className="field">
      {/* Label terpisah di atas input — tetap terlihat saat pengguna mengetik. */}
      <label htmlFor={id}>{label}</label>
      {control}
      {hint && (
        <div className="hint" id={hintId}>
          {hint}
        </div>
      )}
    </div>
  );
}

export function Bar({
  label,
  value,
  max,
  formatted,
  colour = 'var(--series-1)',
}: {
  label: string;
  value: number;
  max: number;
  formatted: string;
  colour?: string;
}): JSX.Element {
  const width = max <= 0 ? 0 : Math.max(1, Math.min(100, (value / max) * 100));
  return (
    <div className="bar-row">
      <span className="lbl" title={label}>
        {label}
      </span>
      <span className="bar-track">
        <span className="bar-fill" style={{ width: `${width}%`, background: colour }} />
      </span>
      <span className="val">{formatted}</span>
    </div>
  );
}

/** Sparkline sederhana. Memakai `currentColor`/token, bukan hex (DESIGN.md 7.4). */
export function Sparkline({
  points,
  height = 44,
  colour = 'var(--series-1)',
}: {
  points: number[];
  height?: number;
  colour?: string;
}): JSX.Element | null {
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = 100 / (points.length - 1);
  const path = points
    .map((value, index) => `${(index * step).toFixed(2)},${(100 - ((value - min) / span) * 100).toFixed(2)}`)
    .join(' ');

  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" width="100%" height={height} aria-hidden="true">
      <polyline points={path} fill="none" stroke={colour} strokeWidth="2.4" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Grafik garis dengan sumbu dan pembanding target. */
export function LineChart({
  series,
  height = 190,
}: {
  series: Array<{ name: string; points: number[]; colour?: string; dashed?: boolean }>;
  height?: number;
}): JSX.Element | null {
  const all = series.flatMap((s) => s.points);
  if (all.length === 0) return null;
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || 1;

  return (
    <svg viewBox="0 0 560 200" width="100%" height={height} role="img">
      <line x1="0" y1="170" x2="560" y2="170" stroke="var(--border)" strokeDasharray="3 4" />
      <line x1="0" y1="10" x2="560" y2="10" stroke="var(--border)" strokeDasharray="3 4" />
      {series.map((s, index) => {
        const step = s.points.length > 1 ? 560 / (s.points.length - 1) : 0;
        const path = s.points
          .map((value, i) => `${(i * step).toFixed(1)},${(170 - ((value - min) / span) * 160).toFixed(1)}`)
          .join(' ');
        return (
          <polyline
            key={s.name}
            points={path}
            fill="none"
            stroke={s.colour ?? `var(--series-${(index % 8) + 1})`}
            strokeWidth={s.dashed ? 2 : 2.6}
            strokeDasharray={s.dashed ? '4 4' : undefined}
          />
        );
      })}
    </svg>
  );
}

export function Legend({ items }: { items: Array<{ label: string; colour: string }> }): JSX.Element {
  return (
    <div className="legend">
      {items.map((item) => (
        <div className="item" key={item.label}>
          <span className="sw" style={{ background: item.colour }} />
          {item.label}
        </div>
      ))}
    </div>
  );
}

export function StatTile({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="stat-tile">
      <div className="k">{label}</div>
      <div className="v">{value}</div>
    </div>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (next: boolean) => void; label: string }): JSX.Element {
  return (
    <button
      type="button"
      className={`toggle ${on ? '' : 'off'}`}
      aria-pressed={on}
      aria-label={label}
      onClick={() => onChange(!on)}
    />
  );
}

export function Icon({ path, size = 16 }: { path: ReactNode; size?: number }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width={size} height={size} aria-hidden="true">
      {path}
    </svg>
  );
}
