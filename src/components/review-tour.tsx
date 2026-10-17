import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { RecordingPresets, requestRecordingPermissionsAsync, useAudioRecorder, useAudioRecorderState } from 'expo-audio';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter, type Href } from 'expo-router';
import { captureScreen } from 'react-native-view-shot';

import { BottomSheet } from '@/components/sheet/bottom-sheet';
import { PrismButton } from '@/components/prism/prism-button';
import { PILL_LABEL_SIZE } from '@/components/prism/pill-tray';
import { applyPlaybackMode, applyRecordingMode, scheduleAudioSessionRelease } from '@/lib/audio-mode';
import { getReview, postShot, postVerdict, postVoiceNote, type ReviewTour as Tour, type ReviewVerdict } from '@/lib/api';
import { tide } from '@/constants/theme';

const DEFAULT_CHIPS = ['slow', 'ugly', 'bug', 'not like the mock', 'confusing'];
const VERDICTS: { key: ReviewVerdict; label: string; colour: string }[] = [
  { key: 'accept', label: '👍 Accept', colour: '#3DDC97' },
  { key: 'fix', label: '🔧 Fix', colour: '#FFB020' },
  { key: 'remove', label: '🗑️ Remove', colour: '#FF5C5C' },
];

const PENDING_KEY = 'review-pending-notes';
type Pending = { wave: string; id: string; uri: string };

async function readPending(): Promise<Pending[]> {
  try {
    return JSON.parse((await AsyncStorage.getItem(PENDING_KEY)) ?? '[]') as Pending[];
  } catch {
    return [];
  }
}
const writePending = (list: Pending[]) => AsyncStorage.setItem(PENDING_KEY, JSON.stringify(list)).catch(() => undefined);

/** Upload a voice note, retrying once. */
async function uploadNote(p: Pending): Promise<boolean> {
  return (await postVoiceNote(p.wave, p.id, p.uri)) || (await postVoiceNote(p.wave, p.id, p.uri));
}

type Saved = { verdict: ReviewVerdict; chips: string[] };

/**
 * Dev-only review overlay: a pill that opens a sheet walking through the steps
 * in the backend's tour JSON. Renders nothing outside __DEV__ or without a tour.
 */
export function ReviewTour() {
  const router = useRouter();
  const [tour, setTour] = useState<Tour | null>(null);
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<Record<string, Saved>>({});
  const [summary, setSummary] = useState(false);
  const [sent, setSent] = useState(false);
  const [notes, setNotes] = useState<Record<string, number>>({});
  const [recording, setRecording] = useState(false);
  const [shots, setShots] = useState(0);
  const [shotFlash, setShotFlash] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const rec = useAudioRecorderState(recorder, 250);
  const recStep = useRef('');
  const [noteMsg, setNoteMsg] = useState('');
  const [failed, setFailed] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);

  // Safety: the pill is never hidden by a capture for more than 2s.
  useEffect(() => {
    if (!capturing) return;
    const t = setTimeout(() => setCapturing(false), 2000);
    return () => clearTimeout(t);
  }, [capturing]);

  // Retry notes that failed to upload in an earlier session.
  useEffect(() => {
    if (!__DEV__) return;
    void (async () => {
      const left: Pending[] = [];
      for (const p of await readPending()) if (!(await uploadNote(p))) left.push(p);
      await writePending(left);
    })();
  }, []);

  useEffect(() => {
    if (!__DEV__) return;
    void getReview().then((t) => {
      if (!t || t.steps.length === 0) return;
      const seed: Record<string, Saved> = {};
      for (const s of t.steps) if (s.verdict) seed[s.id] = { verdict: s.verdict, chips: s.vchips ?? [] };
      const first = t.steps.findIndex((s) => !s.verdict);
      setSaved(seed);
      setIndex(first < 0 ? 0 : first);
      setTour(t);
    });
  }, []);

  if (!__DEV__ || !tour) return null;
  const step = tour.steps[index];
  const done = Object.keys(saved).length;
  const cur = saved[step.id];
  const chips = step.chips ?? DEFAULT_CHIPS;

  const save = (verdict: ReviewVerdict, chipList: string[]) => {
    setSaved((m) => ({ ...m, [step.id]: { verdict, chips: chipList } }));
    void postVerdict({ wave: tour.wave, id: step.id, verdict, chips: chipList });
  };
  const toggleChip = (c: string) => {
    if (!cur) return;
    save(cur.verdict, cur.chips.includes(c) ? cur.chips.filter((x) => x !== c) : [...cur.chips, c]);
  };
  const go = () => {
    setOpen(false);
    router.push({ pathname: step.route, params: step.params ?? {} } as unknown as Href);
  };
  /** Close the sheet, wait out its exit animation, grab the whole screen and upload it. */
  const snap = async (id: string, wasOpen: boolean) => {
    if (wasOpen) setOpen(false);
    setCapturing(true);
    try {
      await new Promise((r) => setTimeout(r, wasOpen ? 450 : 100));
      const uri = await captureScreen({ format: 'jpg', quality: 0.7 });
      if (await postShot(tour.wave, id, uri)) {
        setShots((n) => n + 1);
        setShotFlash(true);
        setTimeout(() => setShotFlash(false), 2000);
      }
    } catch {
      // A failed capture must not break the tour.
    } finally {
      setCapturing(false);
    }
  };
  /** Upload a note. On failure keep the file, persist it for the next launch and offer a retry. */
  const sendNote = async (p: Pending) => {
    setBusy(true);
    setNoteMsg('Uploading voice note…');
    try {
      if (await uploadNote(p)) {
        setNotes((n) => ({ ...n, [p.id]: (n[p.id] ?? 0) + 1 }));
        setFailed(null);
        setNoteMsg('Voice note saved');
        await writePending((await readPending()).filter((x) => x.uri !== p.uri));
      } else {
        throw new Error('upload failed');
      }
    } catch {
      setFailed(p);
      setNoteMsg('Upload failed, tap to retry');
      const list = await readPending();
      if (!list.some((x) => x.uri === p.uri)) await writePending([...list, p]);
    } finally {
      setBusy(false);
      setTimeout(() => setNoteMsg((m) => (m === 'Voice note saved' ? '' : m)), 3000);
    }
  };
  const stopNote = async () => {
    const id = recStep.current;
    setRecording(false);
    setCapturing(false);
    let uri: string | null = null;
    try {
      await recorder.stop();
      uri = recorder.uri;
    } catch {
      uri = recorder.uri;
    }
    await applyPlaybackMode().catch(() => undefined);
    scheduleAudioSessionRelease();
    if (uri) await sendNote({ wave: tour.wave, id, uri });
    else setNoteMsg('Recording failed');
  };
  const toggleNote = async () => {
    if (recording) {
      await stopNote();
      return;
    }
    try {
      if (!(await requestRecordingPermissionsAsync()).granted) return;
      await applyRecordingMode();
      await recorder.prepareToRecordAsync();
      recStep.current = step.id;
      recorder.record();
      setRecording(true);
    } catch {
      setNoteMsg('Could not start recording');
      return;
    }
    await snap(step.id, true);
  };
  const next = () => {
    if (index + 1 >= tour.steps.length) setSummary(true);
    else setIndex(index + 1);
  };
  const flagged = tour.steps.filter((s) => saved[s.id] && saved[s.id].verdict !== 'accept');
  const count = (v: ReviewVerdict) => Object.values(saved).filter((s) => s.verdict === v).length;

  return (
    <>
      {open || capturing ? null : (
        <Pressable
          onPress={() => {
            if (recording) void stopNote();
            else if (failed && !busy) void sendNote(failed);
            else setOpen(true);
          }}
          style={[styles.pill, { bottom: 96 }]}
          accessibilityRole="button"
          accessibilityLabel={recording ? 'Stop voice note' : 'Open review tour'}>
          <Text style={styles.pillText}>
            {recording
              ? `🔴 ${Math.floor((rec.durationMillis ?? 0) / 1000)}s  ⏹ Stop`
              : noteMsg
                ? noteMsg
                : shotFlash
                ? `📸 saved (${shots})`
                : `Review ${done}/${tour.steps.length}`}
          </Text>
        </Pressable>
      )}
      <BottomSheet open={open} onClose={() => setOpen(false)} title={summary ? 'Summary' : step.title} contentTitle>
        {summary ? (
          <View style={styles.body}>
            <Text style={styles.line}>{`Accept ${count('accept')}, Fix ${count('fix')}, Remove ${count('remove')}`}</Text>
            {flagged.map((s) => (
              <Text key={s.id} style={styles.line}>{`• ${saved[s.id].verdict}: ${s.title}`}</Text>
            ))}
            <PrismButton shape="pill" verb="tools" on label="Send to Claude" onPress={() => setSent(true)} />
            {sent ? <Text style={styles.line}>{`Saved ${done} verdicts`}</Text> : null}
            <Pressable onPress={() => setSummary(false)}>
              <Text style={styles.link}>Back</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.body}>
            {step.checks.map((c) => (
              <Text key={c} style={styles.line}>{`• ${c}`}</Text>
            ))}
            <PrismButton shape="pill" verb="listen" label="Take me there" onPress={go} />
            <View style={styles.row}>
              {VERDICTS.map((v) => (
                <PrismButton
                  key={v.key}
                  shape="pill"
                  verb="tools"
                  on={cur?.verdict === v.key}
                  label={v.label}
                  onPress={() => save(v.key, cur?.chips ?? [])}
                  containerStyle={[
                    styles.verdict,
                    { opacity: cur && cur.verdict !== v.key ? 0.5 : 1 },
                    cur?.verdict === v.key && { borderColor: v.colour },
                  ]}
                />
              ))}
            </View>
            <View style={styles.row}>
              {chips.map((c) => (
                <Pressable
                  key={c}
                  onPress={() => toggleChip(c)}
                  style={[styles.chip, cur?.chips.includes(c) && styles.chipOn]}>
                  <Text style={styles.chipText}>{c}</Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.row}>
              <PrismButton
                shape="pill"
                verb="speak"
                on={recording}
                label={recording ? `Stop  ● ${Math.floor((rec.durationMillis ?? 0) / 1000)}s` : '🎙️ Voice note'}
                onPress={() => void toggleNote()}
              />
              <PrismButton shape="pill" verb="tools" label="📸" onPress={() => void snap(step.id, true)} />
              {notes[step.id] ? <Text style={styles.line}>{`Voice note saved (${notes[step.id]})`}</Text> : null}
            </View>
            <View style={styles.nav}>
              <Pressable onPress={() => setIndex(Math.max(0, index - 1))}>
                <Text style={styles.link}>Back</Text>
              </Pressable>
              <Pressable onPress={next}>
                <Text style={styles.link}>{index + 1 >= tour.steps.length ? 'Finish' : 'Next'}</Text>
              </Pressable>
            </View>
          </View>
        )}
      </BottomSheet>
    </>
  );
}

const styles = StyleSheet.create({
  pill: {
    position: 'absolute',
    right: 12,
    height: 36,
    paddingHorizontal: 14,
    borderRadius: 18,
    justifyContent: 'center',
    backgroundColor: 'rgba(11,10,16,0.92)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.12)',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  pillText: { color: tide.text, fontSize: PILL_LABEL_SIZE, fontWeight: '600' },
  body: { gap: 12, paddingTop: 8 },
  line: { color: tide.text, fontSize: 15 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  verdict: { borderWidth: 2, borderColor: 'transparent', borderRadius: 24 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.08)' },
  chipOn: { backgroundColor: 'rgba(255,255,255,0.28)' },
  chipText: { color: tide.text, fontSize: PILL_LABEL_SIZE, fontWeight: '600' },
  nav: { flexDirection: 'row', justifyContent: 'space-between' },
  link: { color: tide.textDim, fontSize: 15, fontWeight: '600', paddingVertical: 6 },
});
