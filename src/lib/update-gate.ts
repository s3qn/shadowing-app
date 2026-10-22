import Constants, { ExecutionEnvironment } from 'expo-constants';
import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';

const BASE = process.env.EXPO_PUBLIC_SHADOW_API_URL ?? '';
const TIMEOUT_MS = 4000;
export const TESTFLIGHT_JOIN_URL = 'https://testflight.apple.com/join/uwB2C3mH';

type Entry = { build: number; url: string } | null;
export type LatestBuilds = { ios?: Entry; android?: Entry };

/** True when `latest` is a higher build than `own`. A missing or non-numeric value never blocks. */
export function compareBuild(own: string | number | null | undefined, latest: string | number | null | undefined): boolean {
  if (own == null || latest == null) return false;
  const a = parseInt(String(own), 10);
  const b = parseInt(String(latest), 10);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return b > a;
}

/** Newest build per platform, or null on any failure or after 4 s. */
export async function fetchLatest(): Promise<LatestBuilds | null> {
  if (!BASE) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/app/latest`, { signal: ctl.signal });
    if (!res.ok) return null;
    return (await res.json()) as LatestBuilds;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function gateApplies(): boolean {
  if (__DEV__ || Platform.OS === 'web') return false;
  return Constants.executionEnvironment !== ExecutionEnvironment.StoreClient;
}

/** `{ url }` once this build is older than the newest one the server lists, else null. Sticky until restart. */
export function useUpdateGate(): { url: string } | null {
  const [gate, setGate] = useState<{ url: string } | null>(null);
  const blocked = gate !== null;
  useEffect(() => {
    if (blocked || !gateApplies()) return;
    let alive = true;
    const check = async () => {
      const latest = await fetchLatest();
      const entry = Platform.OS === 'ios' ? latest?.ios : latest?.android;
      if (!alive || !entry || typeof entry.url !== 'string' || !entry.url) return;
      if (compareBuild(Constants.nativeBuildVersion, entry.build)) setGate({ url: entry.url });
    };
    void check();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void check();
    });
    return () => {
      alive = false;
      sub.remove();
    };
  }, [blocked]);
  return gate;
}
