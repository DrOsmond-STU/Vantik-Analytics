/**
 * CMS — penyuntingan konten halaman depan dan katalog paket.
 *
 * Dipasang DI DALAM modul Manajemen Tenant, bukan sebagai modul ke-31. Alasannya
 * bukan kemalasan: `MODULE_KEYS` menentukan hak akses per paket, sehingga menambah
 * satu kunci modul akan menggeser jumlah modul yang didapat setiap paket dan
 * mengubah angka yang tertulis di halaman harga. Yang disunting di sini juga memang
 * satu wewenang dengan Manajemen Tenant: keduanya menuntut `tenant:configure`.
 *
 * Dua hal yang sengaja terlihat di antarmuka, bukan disembunyikan:
 *
 *  - Kolom yang KOSONG berarti "pakai bawaan", dan itu dinyatakan sebagai teks
 *    pembantu — bukan dibiarkan ditebak. Operator yang menghapus isinya perlu tahu
 *    ia mengembalikan ke bawaan, bukan mengosongkan halaman depan.
 *  - Paket yang sudah dipakai pelanggan tidak dapat dihapus. Tombolnya tetap ada
 *    dan penolakannya dijelaskan, karena tombol yang hilang tanpa keterangan
 *    terbaca sebagai kerusakan.
 */
import { useEffect, useState } from 'react';
import { useApp } from '../app/AppContext.tsx';
import { api, ApiError, type CmsContent, type CmsPlan } from '../lib/api.ts';
import { Card, Field } from '../components/primitives.tsx';

type Tab = 'content' | 'plans';

export function CmsPanel(): JSX.Element {
  const { t } = useApp();
  const [tab, setTab] = useState<Tab>('content');

  return (
    <Card>
      <h3 style={{ marginTop: 0 }}>{t('ui.cms_title')}</h3>
      <p className="muted" style={{ marginTop: 0 }}>{t('ui.cms_intro')}</p>

      <div className="cycle-switch" style={{ justifyContent: 'flex-start' }} role="group" aria-label={t('ui.cms_title')}>
        {(['content', 'plans'] as const).map((key) => (
          <button
            key={key}
            type="button"
            className={tab === key ? 'cycle-option is-active' : 'cycle-option'}
            aria-pressed={tab === key}
            onClick={() => setTab(key)}
          >
            {t(key === 'content' ? 'ui.cms_tab_content' : 'ui.cms_tab_plans')}
          </button>
        ))}
      </div>

      {tab === 'content' ? <ContentEditor /> : <PlanEditor />}
    </Card>
  );
}

/* ============================ Konten ============================ */

function ContentEditor(): JSX.Element {
  const { t, locale } = useApp();
  const [data, setData] = useState<CmsContent | null>(null);
  const [editing, setEditing] = useState<'id' | 'en'>(locale === 'en' ? 'en' : 'id');
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  useEffect(() => {
    api.cmsContent().then(setData).catch((e) => setErrorKey(e instanceof ApiError ? e.key : 'error.unknown'));
  }, []);

  if (errorKey) return <p className="muted">{t(errorKey)}</p>;
  if (!data) return <p className="muted">{t('ui.loading')}</p>;

  const current = (key: string): string => draft[`${editing}:${key}`] ?? data.overrides[editing][key] ?? '';

  const save = async (key: string): Promise<void> => {
    setSavingKey(key);
    setErrorKey(null);
    try {
      const next = await api.cmsSetContent(key, editing, current(key));
      setData(next);
      setDraft((d) => {
        const copy = { ...d };
        delete copy[`${editing}:${key}`];
        return copy;
      });
    } catch (e) {
      setErrorKey(e instanceof ApiError ? e.key : 'error.unknown');
    } finally {
      setSavingKey(null);
    }
  };

  return (
    <div>
      <div className="cycle-switch" style={{ justifyContent: 'flex-start' }} role="group" aria-label={t('ui.cms_locale')}>
        {(['id', 'en'] as const).map((code) => (
          <button
            key={code}
            type="button"
            className={editing === code ? 'cycle-option is-active' : 'cycle-option'}
            aria-pressed={editing === code}
            onClick={() => setEditing(code)}
          >
            {code.toUpperCase()}
          </button>
        ))}
      </div>

      <p className="muted" style={{ fontSize: '12.5px' }}>{t('ui.cms_content_hint')}</p>

      <div style={{ display: 'grid', gap: '14px' }}>
        {data.editableKeys.map((key) => {
          const overridden = data.overrides[editing][key] !== undefined;
          return (
            <div key={key}>
              <label htmlFor={`cms-${key}`} style={{ display: 'block', fontSize: '12.5px', fontWeight: 600 }}>
                {key}
                {overridden && (
                  <span className="cycle-save" style={{ marginLeft: '8px' }}>{t('ui.cms_overridden')}</span>
                )}
              </label>
              <textarea
                id={`cms-${key}`}
                rows={2}
                value={current(key)}
                placeholder={t('ui.cms_placeholder_default')}
                onChange={(e) => setDraft((d) => ({ ...d, [`${editing}:${key}`]: e.target.value }))}
                style={{ width: '100%', font: 'inherit', fontSize: '13.5px', padding: '8px', borderRadius: '10px' }}
              />
              <button
                type="button"
                className="btn"
                disabled={savingKey === key}
                onClick={() => void save(key)}
              >
                {savingKey === key ? t('ui.loading') : t('action.save')}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ============================ Paket ============================ */

const EMPTY_PLAN: CmsPlan = {
  code: '',
  name: '',
  monthlyPrice: 0,
  annualPrice: 0,
  features: {},
  quotas: {},
  sortOrder: 100,
  published: true,
  description: null,
};

function PlanEditor(): JSX.Element {
  const { t } = useApp();
  const [plans, setPlans] = useState<CmsPlan[] | null>(null);
  const [moduleKeys, setModuleKeys] = useState<string[]>([]);
  const [quotaKeys, setQuotaKeys] = useState<string[]>([]);
  const [edit, setEdit] = useState<CmsPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const load = (): void => {
    api
      .cmsPlans()
      .then((r) => {
        setPlans(r.plans);
        setModuleKeys(r.moduleKeys ?? []);
        setQuotaKeys(r.quotaKeys ?? []);
      })
      .catch((e) => setErrorKey(e instanceof ApiError ? e.key : 'error.unknown'));
  };
  useEffect(load, []);

  const submit = async (): Promise<void> => {
    if (!edit) return;
    setBusy(true);
    setErrorKey(null);
    try {
      const r = await api.cmsSavePlan(edit.code, {
        name: edit.name,
        monthlyPrice: Math.round(edit.monthlyPrice),
        annualPrice: Math.round(edit.annualPrice),
        quotas: edit.quotas,
        modules: Object.entries(edit.features).filter(([, on]) => on).map(([k]) => k),
        description: edit.description,
        sortOrder: edit.sortOrder,
        published: edit.published,
      });
      setPlans(r.plans);
      setEdit(null);
    } catch (e) {
      setErrorKey(e instanceof ApiError ? e.key : 'error.unknown');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (code: string): Promise<void> => {
    setBusy(true);
    setErrorKey(null);
    try {
      const r = await api.cmsDeletePlan(code);
      setPlans(r.plans);
    } catch (e) {
      // `error.plan_in_use` sampai ke sini apa adanya: operator perlu tahu paketnya
      // masih dipakai, bukan sekadar "gagal".
      setErrorKey(e instanceof ApiError ? e.key : 'error.unknown');
    } finally {
      setBusy(false);
    }
  };

  if (!plans) return <p className="muted">{errorKey ? t(errorKey) : t('ui.loading')}</p>;

  if (edit) {
    return (
      <div style={{ display: 'grid', gap: '12px' }}>
        {errorKey && <p className="muted">{t(errorKey)}</p>}
        <Field label={t('ui.cms_plan_code')}>
          <input value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value })} />
        </Field>
        <Field label={t('ui.cms_plan_name')}>
          <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
        </Field>
        <Field label={t('ui.cms_plan_monthly')}>
          <input
            type="number"
            value={edit.monthlyPrice}
            onChange={(e) => setEdit({ ...edit, monthlyPrice: Number(e.target.value) })}
          />
        </Field>
        <Field label={t('ui.cms_plan_annual')}>
          <input
            type="number"
            value={edit.annualPrice}
            onChange={(e) => setEdit({ ...edit, annualPrice: Number(e.target.value) })}
          />
        </Field>
        <Field label={t('ui.cms_plan_order')}>
          <input
            type="number"
            value={edit.sortOrder}
            onChange={(e) => setEdit({ ...edit, sortOrder: Number(e.target.value) })}
          />
        </Field>

        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontSize: '12.5px', fontWeight: 600 }}>{t('ui.cms_plan_quotas')}</legend>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '8px' }}>
            {quotaKeys.map((q) => (
              <Field key={q} label={q}>
                <input
                  type="number"
                  value={edit.quotas[q] ?? 0}
                  onChange={(e) => setEdit({ ...edit, quotas: { ...edit.quotas, [q]: Number(e.target.value) } })}
                />
              </Field>
            ))}
          </div>
          <p className="muted" style={{ fontSize: '12px' }}>{t('ui.cms_quota_hint')}</p>
        </fieldset>

        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontSize: '12.5px', fontWeight: 600 }}>{t('ui.cms_plan_modules')}</legend>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '4px' }}>
            {moduleKeys.map((m) => (
              <label key={m} style={{ fontSize: '13px', display: 'flex', gap: '6px', alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={edit.features[m] === true}
                  onChange={(e) => setEdit({ ...edit, features: { ...edit.features, [m]: e.target.checked } })}
                />
                {m}
              </label>
            ))}
          </div>
        </fieldset>

        <label style={{ fontSize: '13px', display: 'flex', gap: '6px', alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={edit.published}
            onChange={(e) => setEdit({ ...edit, published: e.target.checked })}
          />
          {t('ui.cms_plan_published')}
        </label>

        <div style={{ display: 'flex', gap: '8px' }}>
          <button type="button" className="btn brand" disabled={busy} onClick={() => void submit()}>
            {t('action.save')}
          </button>
          <button type="button" className="btn" onClick={() => setEdit(null)}>
            {t('action.cancel')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      {errorKey && <p className="muted">{t(errorKey)}</p>}
      <button type="button" className="btn brand" onClick={() => setEdit({ ...EMPTY_PLAN })}>
        {t('ui.cms_plan_new')}
      </button>
      <table style={{ width: '100%', marginTop: '12px', fontSize: '13.5px' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>{t('ui.cms_plan_code')}</th>
            <th style={{ textAlign: 'left' }}>{t('ui.cms_plan_name')}</th>
            <th style={{ textAlign: 'right' }}>{t('ui.cms_plan_monthly')}</th>
            <th style={{ textAlign: 'left' }}>{t('ui.cms_plan_published')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {plans.map((plan) => (
            <tr key={plan.code}>
              <td>{plan.code}</td>
              <td>{plan.name}</td>
              <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                {plan.monthlyPrice.toLocaleString('id-ID')}
              </td>
              <td>{plan.published ? t('ui.yes') : t('ui.no')}</td>
              <td style={{ textAlign: 'right' }}>
                <button type="button" className="linkbtn" onClick={() => setEdit(plan)}>
                  {t('action.edit')}
                </button>{' '}
                <button type="button" className="linkbtn" disabled={busy} onClick={() => void remove(plan.code)}>
                  {t('action.delete')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted" style={{ fontSize: '12px' }}>{t('ui.cms_plan_hint')}</p>
    </div>
  );
}
