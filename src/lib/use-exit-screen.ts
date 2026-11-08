import { useRouter } from 'expo-router';
import { useCallback } from 'react';

/** The way out of a screen: back when there is a screen to go back to,
 * otherwise replace with `fallback` (a deep link or a first launch). */
export function useExitScreen(fallback: Parameters<ReturnType<typeof useRouter>['replace']>[0] = '/') {
  const router = useRouter();
  return useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace(fallback);
  }, [router, fallback]);
}
