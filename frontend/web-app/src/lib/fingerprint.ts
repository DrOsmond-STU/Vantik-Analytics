/**
 * Pengumpulan atribut perangkat untuk Device Binding (PRD 6.30).
 *
 * PENTING (SECURITY.md 17.2): nilai yang dikumpulkan di sini adalah MASUKAN, bukan
 * keputusan. Hashing, pencocokan, dan penerimaan/penolakan seluruhnya dilakukan
 * di sisi server; klien tidak pernah mengirim "ID perangkat" yang sudah jadi.
 *
 * Kewajiban privasi (SECURITY.md 17.3): atribut ini termasuk data pribadi menurut
 * UU PDP dan hanya dipakai untuk penegakan lisensi & keamanan akun — tidak untuk
 * pelacakan perilaku, pembuatan profil, atau pemasaran.
 */

export interface FingerprintComponents {
  userAgent: string;
  screenResolution: string;
  colorDepth: number;
  timezone: string;
  language: string;
  fonts: string[];
  canvasHash: string;
  webglHash: string;
  platform: string;
}

/** Daftar font yang diuji ketersediaannya; dipilih karena umum lintas OS. */
const PROBE_FONTS = [
  'Arial', 'Verdana', 'Times New Roman', 'Courier New', 'Georgia', 'Tahoma',
  'Trebuchet MS', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Ubuntu', 'Noto Sans',
];

function detectFonts(): string[] {
  const baselines = ['monospace', 'sans-serif', 'serif'] as const;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return [];

  const measure = (font: string, baseline: string): number => {
    context.font = `72px ${font}, ${baseline}`;
    return context.measureText('mmmmmmmmmmlli').width;
  };

  const defaults = new Map(baselines.map((b) => [b, measure('__none__', b)]));
  return PROBE_FONTS.filter((font) =>
    baselines.some((baseline) => Math.abs(measure(font, baseline) - (defaults.get(baseline) ?? 0)) > 0.5),
  );
}

function canvasSignature(): string {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 60;
    const context = canvas.getContext('2d');
    if (!context) return 'unavailable';

    context.textBaseline = 'top';
    context.font = "16px 'Inter', sans-serif";
    context.fillStyle = '#0EA5A5';
    context.fillRect(0, 0, 120, 30);
    context.fillStyle = '#101828';
    context.fillText('Vantik Analytics 0123456789', 4, 20);
    context.strokeStyle = 'rgba(59,91,219,0.6)';
    context.arc(60, 40, 18, 0, Math.PI * 2);
    context.stroke();

    return canvas.toDataURL().slice(-96);
  } catch {
    return 'unavailable';
  }
}

function webglSignature(): string {
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return 'unavailable';
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const vendor = debugInfo ? String(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)) : String(gl.getParameter(gl.VENDOR));
    const renderer = debugInfo ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    return `${vendor}|${renderer}|${gl.getParameter(gl.SHADING_LANGUAGE_VERSION)}`;
  } catch {
    return 'unavailable';
  }
}

export function collectFingerprint(): FingerprintComponents {
  return {
    userAgent: navigator.userAgent,
    screenResolution: `${window.screen.width}x${window.screen.height}`,
    colorDepth: window.screen.colorDepth,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'unknown',
    language: navigator.language,
    fonts: detectFonts(),
    canvasHash: canvasSignature(),
    webglHash: webglSignature(),
    platform: (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
      ?? navigator.platform
      ?? 'unknown',
  };
}
