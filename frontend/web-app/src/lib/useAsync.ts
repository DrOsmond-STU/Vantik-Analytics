import { useCallback, useEffect, useState } from 'react';
import { ApiError } from './api.ts';

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  /** Kunci i18n kesalahan — bukan kalimat siap tampil (DESIGN.md 8.2). */
  errorKey: string | null;
  reload: () => void;
}

/** Pemuat data sederhana dengan penanganan kesalahan berbasis kunci i18n. */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrorKey(null);
    loader()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setErrorKey(error instanceof ApiError ? error.key : 'error.internal');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, loading, errorKey, reload };
}
