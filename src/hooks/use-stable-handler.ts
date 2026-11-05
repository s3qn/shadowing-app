import { useCallback, useLayoutEffect, useRef } from 'react';

// A handler whose identity never changes but always runs the latest render's
// function, so a memoised child does not re-render just because the screen
// rendered again.
export function useStableHandler<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  // Written at commit, not during render: nothing calls a handler between
  // the two, and the compiler needs refs left alone while rendering.
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}
