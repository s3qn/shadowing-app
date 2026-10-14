import { createContext } from 'react';

/** The blink runs only where this is true (the wardrobe stage), not in the Home badge. */
export const BlinkEnabled = createContext(false);

const resets = new Set<() => void>();

/** An equip or buy: cancel a running blink and restart its timer. */
export function resetBlink() {
  resets.forEach((r) => r());
}
export function onBlinkReset(fn: () => void) {
  resets.add(fn);
  return () => {
    resets.delete(fn);
  };
}
