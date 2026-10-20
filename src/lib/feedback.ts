/**
 * Tester feedback: the meta block, the upload and the offline queue.
 * Mirrors the review tour's pending pattern: an entry is saved with its files
 * copied into the document directory, and sent again on launch or foreground
 * until the server answers.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Directory, File, Paths } from 'expo-file-system';
import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';

import * as api from '@/lib/api';
import { resolveAppLanguage, LOCALES } from '@/lib/i18n';
import { getSettingsSync } from '@/lib/settings';

const PENDING_KEY = 'feedback-pending';

export type FeedbackKind = 'bug' | 'suggestion';
export type FeedbackDraft = { kind: FeedbackKind; text: string; voice?: string; images: string[] };
type Pending = { id: string; kind: FeedbackKind; text: string; meta: string; voice?: string; images: string[] };

let lastRoute = '';

/** Remembers the last screen outside Settings, so a bug found elsewhere still says where. */
export function noteRoute(pathname: string): void {
  if (pathname && !pathname.startsWith('/settings')) lastRoute = pathname;
}

export function buildMeta(): string {
  const cfg = Constants.expoConfig;
  const s = getSettingsSync();
  const lang = resolveAppLanguage(s);
  const meta = {
    appVersion: cfg?.version,
    buildNumber: Constants.nativeBuildVersion ?? cfg?.ios?.buildNumber ?? String(cfg?.android?.versionCode ?? ''),
    platform: Platform.OS,
    osVersion: Device.osVersion ?? String(Platform.Version),
    deviceModel: Device.modelName,
    deviceBrand: Device.brand,
    route: lastRoute,
    uiLanguage: lang,
    learningLanguage: s.learningLanguage,
    locale: LOCALES[lang].tag,
    clientTime: new Date().toISOString(),
    guideStep: s.guideStep,
  };
  return JSON.stringify(meta);
}

async function readPending(): Promise<Pending[]> {
  try {
    return JSON.parse((await AsyncStorage.getItem(PENDING_KEY)) ?? '[]') as Pending[];
  } catch {
    return [];
  }
}
const writePending = (list: Pending[]) => AsyncStorage.setItem(PENDING_KEY, JSON.stringify(list)).catch(() => undefined);

const isFinal = (status: number) => status === 400 || status === 413 || status === 429;

function dropFolder(id: string): void {
  try {
    const dir = new Directory(Paths.document, 'feedback', id);
    if (dir.exists) dir.delete();
  } catch {
    // nothing to clean up
  }
}

/** Copies a picker or recorder file (cache) into the entry's own folder. */
function keep(id: string, uri: string, name: string): string {
  const dir = new Directory(Paths.document, 'feedback', id);
  dir.create({ intermediates: true, idempotent: true });
  const dest = new File(dir, name);
  new File(uri).copy(dest);
  return dest.uri;
}

/**
 * Sends a report. Resolves `'sent'` or `'queued'` (no connection; saved and
 * sent later). Throws when the server refuses it for good (400, 413, 429) or
 * on web with no connection, so the draft stays on screen.
 */
export async function submitFeedback(draft: FeedbackDraft): Promise<'sent' | 'queued'> {
  const meta = buildMeta();
  const text = draft.text.trim();
  const status = await api.sendFeedback({ kind: draft.kind, text, meta, voice: draft.voice, images: draft.images });
  if (status === 200) return 'sent';
  if (status !== 0) throw new Error(String(status));
  if (Platform.OS === 'web') throw new Error('unreachable');
  const id = `${Date.now()}`;
  let entry: Pending;
  try {
    entry = {
      id,
      kind: draft.kind,
      text,
      meta,
      voice: draft.voice ? keep(id, draft.voice, 'voice.m4a') : undefined,
      images: draft.images.map((u, i) => keep(id, u, `img-${i + 1}`)),
    };
  } catch {
    dropFolder(id);
    throw new Error('unreachable');
  }
  await writePending([...(await readPending()), entry]);
  return 'queued';
}

let flushing = false;

/** Sends every saved report; keeps the ones that still cannot reach the server. */
export async function flushFeedback(): Promise<void> {
  if (flushing || Platform.OS === 'web') return;
  flushing = true;
  try {
    const left: Pending[] = [];
    const list = await readPending();
    for (const p of list) {
      const status = await api.sendFeedback(p);
      if (status === 200 || isFinal(status)) dropFolder(p.id);
      else left.push(p);
    }
    if (list.length) await writePending([...left, ...(await readPending()).filter((x) => !list.some((l) => l.id === x.id))]);
  } finally {
    flushing = false;
  }
}

/** Flushes saved reports on launch and whenever the app returns to the foreground. */
export function useFeedbackFlush(): void {
  useEffect(() => {
    void flushFeedback();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void flushFeedback();
    });
    return () => sub.remove();
  }, []);
}
