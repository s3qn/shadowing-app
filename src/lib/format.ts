/** "0.8×", "1×", "1.25×": the speed with its trailing zeros dropped. The
 * ruler's readout is the one place that keeps two decimals. */
export function formatSpeed(speed: number): string {
  return `${Number(speed.toFixed(2))}×`;
}

/** A clock: "1:05" under an hour (minutes unpadded), "1:02:05" from one hour. */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
