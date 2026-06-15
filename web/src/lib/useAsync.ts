/*
 * useAsync.ts — a tiny load/error/data hook for one-shot reads.
 *
 * NOT a server-cache library (this is a small local-only admin tool); it just
 * removes the repeated useState×3 + useEffect boilerplate while giving every read
 * screen consistent loading/error/empty handling and a `reload()`. A 401 is left
 * to the global handler (it triggers the login redirect) and is not shown as a
 * screen error.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/ApiError';
import { errorMessage } from './format';

interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
  /** Optimistically replace the local data (e.g. after a mutation). */
  setData: (next: T) => void;
}

export function useAsync<T>(fn: () => Promise<T>, deps: readonly unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fnRef.current();
      if (mounted.current) setData(result);
    } catch (err) {
      if (err instanceof ApiError && err.isAuth) return; // global redirect handles it
      if (mounted.current) setError(errorMessage(err));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, reload, setData };
}
