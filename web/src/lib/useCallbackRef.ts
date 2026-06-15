import { useCallback, useRef } from 'react';

/*
 * useCallbackRef — stabilize a callback identity while always invoking the latest
 * version. Lets effects depend on a handler without re-running when the caller
 * passes a new inline function each render (a common React footgun).
 */
export function useCallbackRef<Args extends unknown[], R>(
  callback: (...args: Args) => R
): (...args: Args) => R {
  const ref = useRef(callback);
  ref.current = callback;
  return useCallback((...args: Args) => ref.current(...args), []);
}
