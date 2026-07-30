/**
 * Peta navigasi — 30 modul dalam 8 domain (PRD Lampiran B).
 *
 * BRAND.md Bagian 7 / DESIGN.md 8.1: NAMA MODUL tidak diterjemahkan di kedua bahasa
 * antarmuka (diperlakukan sebagai nama produk), sedangkan NAMA DOMAIN boleh
 * diterjemahkan karena merupakan pengelompokan navigasi.
 *
 * Berkas ini sengaja bebas JSX agar strukturnya dapat diuji tanpa React —
 * ikon dipisah ke `navigationIcons.tsx`.
 */

export interface NavItem {
  /** Kunci rute internal. */
  view: string;
  /** Nama modul — tidak diterjemahkan. */
  label: string;
  /** Kunci feature flag per tenant (PRD 6.27). */
  moduleKey: string;
}

export interface NavGroup {
  /** Nomor domain sesuai urutan navigasi UI (PRD Lampiran B). */
  number: number;
  /** Kunci i18n nama domain. */
  labelKey: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    number: 1,
    labelKey: 'domain.leadership',
    items: [
      { view: 'exec', label: 'Executive Cockpit', moduleKey: 'executive_cockpit' },
      { view: 'ops', label: 'Operational Cockpit', moduleKey: 'operational_cockpit' },
      { view: 'bsc', label: 'Balanced Scorecard', moduleKey: 'balanced_scorecard' },
    ],
  },
  {
    number: 2,
    labelKey: 'domain.visualization',
    items: [
      { view: 'designer', label: 'Dashboard Designer', moduleKey: 'dashboard_designer' },
      { view: 'report', label: 'Report Designer', moduleKey: 'report_designer' },
      { view: 'viz', label: 'Interactive Visualization', moduleKey: 'interactive_visualization' },
      { view: 'embed', label: 'Embed Dashboard', moduleKey: 'embed_dashboard' },
    ],
  },
  {
    number: 3,
    labelKey: 'domain.ai',
    items: [
      { view: 'ai', label: 'AI Analytics', moduleKey: 'ai_analytics' },
      { view: 'forecast', label: 'Forecast Analytics', moduleKey: 'forecast_analytics' },
      { view: 'rca', label: 'Root Cause Analysis', moduleKey: 'root_cause_analysis' },
      { view: 'discovery', label: 'Data Discovery', moduleKey: 'data_discovery' },
      { view: 'narrative', label: 'AI Narrative Report', moduleKey: 'ai_narrative_report' },
    ],
  },
  {
    number: 4,
    labelKey: 'domain.statistics',
    items: [
      { view: 'descstat', label: 'Statistik Deskriptif', moduleKey: 'descriptive_statistics' },
      { view: 'hypo', label: 'Uji Hipotesis', moduleKey: 'hypothesis_testing' },
      { view: 'regression', label: 'Regresi & Korelasi', moduleKey: 'regression_correlation' },
    ],
  },
  {
    number: 5,
    labelKey: 'domain.data',
    items: [
      { view: 'dataset', label: 'Dataset (Upload CSV)', moduleKey: 'dataset' },
      { view: 'external', label: 'Koneksi Eksternal', moduleKey: 'external_connection' },
      { view: 'datamodel', label: 'Data Modeling', moduleKey: 'data_modeling' },
      { view: 'dataquality', label: 'Data Quality Center', moduleKey: 'data_quality_center' },
      { view: 'kpi', label: 'KPI Center', moduleKey: 'kpi_center' },
    ],
  },
  {
    number: 6,
    labelKey: 'domain.monitoring',
    items: [
      { view: 'alert', label: 'Alert Center', moduleKey: 'alert_center' },
      { view: 'twin', label: 'Digital Twin', moduleKey: 'digital_twin' },
    ],
  },
  {
    number: 7,
    labelKey: 'domain.administration',
    items: [
      { view: 'employee', label: 'Master Pegawai', moduleKey: 'employee_master' },
      { view: 'auth', label: 'Otorisasi User', moduleKey: 'user_authorization' },
      { view: 'auditlog', label: 'Log Aktivitas', moduleKey: 'activity_log' },
      { view: 'device', label: 'Perangkat & Sesi', moduleKey: 'device_management' },
    ],
  },
  {
    number: 8,
    labelKey: 'domain.billing',
    items: [
      { view: 'tenant', label: 'Manajemen Tenant', moduleKey: 'tenant_management' },
      { view: 'subscription', label: 'Langganan & Paket', moduleKey: 'subscription_management' },
      { view: 'billing', label: 'Billing & Faktur', moduleKey: 'billing_invoice' },
      { view: 'usage', label: 'Usage & Kuota', moduleKey: 'usage_metering' },
    ],
  },
];

export const ALL_NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

export function findNavItem(view: string): { item: NavItem; group: NavGroup } | undefined {
  for (const group of NAV_GROUPS) {
    const item = group.items.find((i) => i.view === view);
    if (item) return { item, group };
  }
  return undefined;
}
