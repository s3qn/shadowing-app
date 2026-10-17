// --- bl36-align ---
export type AudioFormat = { url: string; mimeType: string; bitrate: number; contentLength?: string };

export const AUDIO_MAX_BYTES = 40 * 1024 * 1024;

/** The cheapest plain-url audio-only format of a player response, or null.
 * Ciphered formats are skipped: the phone cannot solve the signature. */
export function pickAudioFormat(pr: any): AudioFormat | null {
  const all: any[] = pr?.streamingData?.adaptiveFormats ?? [];
  const audio = all.filter(
    (f) => typeof f?.mimeType === 'string' && f.mimeType.startsWith('audio/') && typeof f.url === 'string' && !f.signatureCipher,
  );
  audio.sort((a, b) => (a.bitrate ?? 0) - (b.bitrate ?? 0) || Number(b.mimeType.startsWith('audio/mp4')) - Number(a.mimeType.startsWith('audio/mp4')));
  const best = audio[0];
  if (!best) return null;
  if (best.contentLength && Number(best.contentLength) > AUDIO_MAX_BYTES) return null;
  return best;
}
