import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';

import * as api from '@/lib/api';
import { devWordsCollection } from '@/lib/dev-simulate';
import { getSettingsSync } from '@/lib/settings';

/** The caught-word collection for the learning language, reloaded each time the screen gains focus.
 * beta-gate: `enabled` false (a regular user) reads nothing, so Settings never fetches into a 403. */
export function useKnownWords(enabled = true) {
  const [data, setData] = useState<api.CatchCollection | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);

  const reload = useCallback(() => {
    const mine = ++seq.current;
    if (!enabled) {
      setData(null);
      setLoading(false);
      return;
    }
    const sim = devWordsCollection();
    if (sim) {
      setData(sim);
      setFailed(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    api
      .catchCollection(getSettingsSync().learningLanguage)
      .then((res) => {
        if (mine !== seq.current) return;
        setData(res);
        setFailed(false);
      })
      .catch(() => {
        if (mine === seq.current) setFailed(true);
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
  }, [enabled]);

  useFocusEffect(reload);

  return { data, loading, failed, reload };
}
