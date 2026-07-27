/**
 * Potongan tampilan yang dipakai lintas modul.
 */
import type { ReactNode } from 'react';
import { useApp } from '../app/AppContext.tsx';
import type { AsyncState } from '../lib/useAsync.ts';
import { EmptyState, Panel } from '../components/primitives.tsx';

export function PageHead({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <div className="page-head">
      <div>
        {/* Nama modul tidak diterjemahkan (BRAND.md Bagian 7). */}
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="head-actions">{actions}</div>}
    </div>
  );
}

/** Membungkus status memuat/kesalahan/kosong secara konsisten. */
export function ViewState<T>({
  state,
  children,
}: {
  state: AsyncState<T>;
  children: (data: T) => ReactNode;
}): JSX.Element {
  const { t } = useApp();

  if (state.loading) {
    return (
      <Panel span="full">
        <div className="empty">{t('ui.loading')}</div>
      </Panel>
    );
  }
  if (state.errorKey) {
    return (
      <Panel span="full">
        <EmptyState
          messageKey={state.errorKey}
          action={
            <button type="button" className="btn" onClick={state.reload}>
              {t('action.refresh')}
            </button>
          }
        />
      </Panel>
    );
  }
  if (state.data === null) {
    return (
      <Panel span="full">
        <EmptyState messageKey="empty.no_data" />
      </Panel>
    );
  }
  return <>{children(state.data)}</>;
}

/** Blok yang menampilkan modul di luar paket langganan (PRD 6.27). */
export function ModuleLocked(): JSX.Element {
  const { t } = useApp();
  return (
    <Panel span="full">
      <EmptyState messageKey="empty.module_not_in_plan" />
      <div className="note" style={{ textAlign: 'center' }}>
        {t('error.module_not_in_plan')}
      </div>
    </Panel>
  );
}

/** Daftar peringatan berbasis kunci i18n (dipakai modul statistik & forecast). */
export function WarningList({ keys }: { keys: string[] }): JSX.Element | null {
  const { t } = useApp();
  if (keys.length === 0) return null;
  return (
    <div className="note warn" style={{ gridColumn: 'span 12' }}>
      <ul style={{ margin: 0, paddingInlineStart: 18 }}>
        {keys.map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Catatan pembedaan asosiasi vs kausalitas.
 * PRD 6.23 & 6.24 menuntut pembedaan ini EKSPLISIT di setiap output statistik.
 */
export function CausalityNote({ noteKey }: { noteKey: string }): JSX.Element {
  const { t } = useApp();
  return (
    <div className="note info" style={{ gridColumn: 'span 12' }}>
      {t(noteKey)}
    </div>
  );
}
