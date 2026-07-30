/**
 * Ikon navigasi — set ikon garis buatan sendiri (DESIGN.md Bagian 5):
 * stroke 1.6–2px, sudut membulat, viewBox 24×24, mewarisi `currentColor` sehingga
 * otomatis mengikuti token teks di mode manapun tanpa duplikasi aset.
 *
 * Dipisah dari `navigation.ts` agar struktur navigasi dapat diuji tanpa React.
 */
import type { ReactNode } from 'react';

const s = (d: string): ReactNode => <path d={d} />;

/** Ikon per kunci rute; dipetakan ke `NavItem.view`. */
export const NAV_ICONS: Record<string, ReactNode> = {
  exec: (
          <>
            <rect x="3" y="3" width="7" height="9" rx="1.5" />
            <rect x="14" y="3" width="7" height="5" rx="1.5" />
            <rect x="14" y="12" width="7" height="9" rx="1.5" />
            <rect x="3" y="16" width="7" height="5" rx="1.5" />
          </>
        ),
  ops: s('M3 12h4l2-7 4 14 2-7h6'),
  bsc: (
          <>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M12 3v18M3 12h18" />
          </>
        ),
  designer: (
          <>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18M9 21V9" />
          </>
        ),
  report: (
          <>
            <path d="M6 2h9l5 5v15H6z" />
            <path d="M15 2v5h5M9 13h6M9 17h6" />
          </>
        ),
  viz: (
          <>
            <rect x="3" y="3" width="7" height="7" rx="1.5" />
            <rect x="14" y="3" width="7" height="7" rx="1.5" />
            <rect x="3" y="14" width="7" height="7" rx="1.5" />
            <rect x="14" y="14" width="7" height="7" rx="1.5" />
          </>
        ),
  embed: s('M8 4L2 12l6 8M16 4l6 8-6 8'),
  ai: s('M12 3l1.8 4.9L19 9.5l-4.9 1.8L12 16l-1.8-4.9L5 9.5l4.9-1.8L12 3z'),
  forecast: (
          <>
            <path d="M3 17l6-6 4 4 8-8" />
            <path d="M15 7h6v6" />
          </>
        ),
  rca: (
          <>
            <path d="M3 12h13M11 6l5 6-5 6" />
            <circle cx="19" cy="12" r="2" />
          </>
        ),
  discovery: (
          <>
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4-4" />
            <circle cx="11" cy="11" r="2.4" />
          </>
        ),
  narrative: (
          <>
            <path d="M4 4h16v14H4z" />
            <path d="M8 9h8M8 13h5" />
          </>
        ),
  descstat: s('M4 20V10M10 20V4M16 20v-8M22 20H2'),
  hypo: (
          <>
            <path d="M3 18c3-10 6-10 9 0s6 10 9 0" />
            <path d="M12 21v-3" />
          </>
        ),
  regression: (
          <>
            <path d="M3 21L21 5" />
            <circle cx="7" cy="17" r="1.4" />
            <circle cx="11" cy="15" r="1.4" />
            <circle cx="15" cy="10" r="1.4" />
            <circle cx="18" cy="9" r="1.4" />
          </>
        ),
  dataset: (
          <>
            <path d="M14 3v5h5" />
            <path d="M6 3h8l5 5v13H6z" />
            <path d="M9 15l2 2 4-4" />
          </>
        ),
  external: (
          <>
            <path d="M8 12a4 4 0 118 0 4 4 0 01-8 0z" />
            <path d="M2 12h4M18 12h4" />
          </>
        ),
  datamodel: (
          <>
            <ellipse cx="12" cy="5" rx="8" ry="3" />
            <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
            <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
          </>
        ),
  dataquality: (
          <>
            <path d="M9 12l2 2 4-4" />
            <circle cx="12" cy="12" r="9" />
          </>
        ),
  kpi: (
          <>
            <circle cx="12" cy="12" r="9" />
            <circle cx="12" cy="12" r="4.5" />
            <circle cx="12" cy="12" r="0.6" fill="currentColor" />
          </>
        ),
  alert: (
          <>
            <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.7 21a2 2 0 01-3.4 0" />
          </>
        ),
  twin: (
          <>
            <rect x="4" y="10" width="16" height="10" rx="2" />
            <path d="M8 10V7a4 4 0 018 0v3" />
          </>
        ),
  employee: (
          <>
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21v-1a8 8 0 0116 0v1" />
          </>
        ),
  auth: (
          <>
            <rect x="5" y="11" width="14" height="9" rx="2" />
            <path d="M8 11V8a4 4 0 018 0v3" />
            <circle cx="12" cy="15.5" r="1.3" />
          </>
        ),
  auditlog: (
          <>
            <path d="M4 4h16v16H4z" />
            <path d="M8 9h8M8 13h8M8 17h4" />
          </>
        ),
  device: (
          <>
            <rect x="2" y="4" width="14" height="10" rx="1.5" />
            <path d="M6 18h8" />
            <rect x="17" y="9" width="5" height="11" rx="1.5" />
          </>
        ),
  tenant: (
          <>
            <rect x="3" y="8" width="8" height="13" rx="1.5" />
            <rect x="13" y="3" width="8" height="18" rx="1.5" />
            <path d="M6 12h2M6 16h2M16 7h2M16 11h2M16 15h2" />
          </>
        ),
  subscription: s('M12 3l2.5 5.5L20 9l-4 4 1 6-5-2.8L7 19l1-6-4-4 5.5-.5z'),
  billing: (
          <>
            <rect x="2" y="5" width="20" height="14" rx="2" />
            <path d="M2 10h20M6 15h4" />
          </>
        ),
  usage: (
          <>
            <path d="M12 20a8 8 0 108-8" />
            <path d="M12 12l5-4" />
          </>
        ),
};
