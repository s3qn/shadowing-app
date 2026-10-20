import { useCallback, useEffect, useRef, useState } from 'react';

import type { KagenekoEmotion } from '@/constants/cosmetics';

/** A timed emotion: fire(e, ms) shows it, then it goes back to none. Cleared on unmount. */
export function useEmotionPulse(): [KagenekoEmotion, (e: KagenekoEmotion, ms?: number) => void] {
  const [emotion, setEmotion] = useState<KagenekoEmotion>('none');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);
  const fire = useCallback((e: KagenekoEmotion, ms = 4000) => {
    clear();
    setEmotion(e);
    timer.current = setTimeout(() => setEmotion('none'), ms);
  }, []);
  return [emotion, fire];
}
