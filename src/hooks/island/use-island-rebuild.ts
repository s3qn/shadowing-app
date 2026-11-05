// What the island route owns for rebuilding an island: waiting for the server,
// re-voice, regenerate, rename and the delete confirmation. Plain functions
// rebuilt each render, as they were in the route, reading the screen through params.
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { useAudioPlayer } from 'expo-audio';

import type { IslandCore } from '@/hooks/island/island-core';
import type { PhraseSpan } from '@/hooks/use-phrase';
import * as api from '@/lib/api';
import { stopPlayback } from '@/lib/audio-mode';
import { alertSheet, confirmSheet } from '@/lib/confirm-sheet';
import { t } from '@/lib/i18n';
import { invalidateCachedIsland } from '@/lib/island-cache';
import { invalidateLineAudio } from '@/lib/line-audio-cache';
import { deleteTakes } from '@/lib/takes';

type Params = {
  core: MutableRefObject<IslandCore | null>;
  island: api.Island | null;
  voice: number | null;
  revoicing: boolean;
  regenerating: boolean;
  player: ReturnType<typeof useAudioPlayer>;
  carryError: MutableRefObject<string>;
  isMounted: () => boolean;
  forSession: <T extends { lines: api.Line[] }>(data: T) => T;
  resetHighlight: () => void;
  removeIsland: () => Promise<void>;
  setIdx: Dispatch<SetStateAction<number>>;
  setIsland: Dispatch<SetStateAction<api.Island | null>>;
  setError: Dispatch<SetStateAction<string>>;
  setRevoicing: Dispatch<SetStateAction<boolean>>;
  setRegenerating: Dispatch<SetStateAction<boolean>>;
  setBuildStage: Dispatch<SetStateAction<string>>;
  setGeneration: Dispatch<SetStateAction<number>>;
  setAttempt: Dispatch<SetStateAction<number>>;
  setDragSpan: Dispatch<SetStateAction<PhraseSpan | null>>;
};

export function useIslandRebuild({
  core,
  island,
  voice,
  revoicing,
  regenerating,
  player,
  carryError,
  isMounted,
  forSession,
  resetHighlight,
  removeIsland,
  setIdx,
  setIsland,
  setError,
  setRevoicing,
  setRegenerating,
  setBuildStage,
  setGeneration,
  setAttempt,
  setDragSpan,
}: Params) {
  // Polls until the island settles. Returns the ready island, throws with the
  // island's error when it failed, returns null when maxSeconds pass first.
  // A poll can fail while the server is briefly unreachable; that is not the
  // island failing, so keep polling.
  async function waitForIsland(
    islandId: string,
    maxSeconds: number,
    onStage?: (stage: string) => void,
  ): Promise<api.Island | null> {
    for (let i = 0; i < maxSeconds; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      let data: api.Island;
      try {
        data = await api.getIsland(islandId);
      } catch {
        continue;
      }
      onStage?.(data.stage);
      if (data.status === 'ready') return data;
      if (data.status === 'failed') throw new Error(api.islandErrorText(data));
    }
    return null;
  }

  // The backend replaces the lines' audio one by one and flips the island to
  // working meanwhile. The scene and dock leave the screen for the wait (the
  // `revoicing` render branch), so no old clip can start, and the screen
  // comes back on the same line with the new voice.
  async function doRevoice() {
    if (!island || voice === null || revoicing || regenerating) return;
    setRevoicing(true);
    core.current?.setPlayWhenLoaded(false);
    core.current?.dropTake();
    stopPlayback(player);
    core.current?.closePanel();
    setDragSpan(null);
    try {
      await api.revoice(island.id, voice);
    } catch (e) {
      // Nothing was started, so the island on the server still matches what
      // is on screen. Say why and go back to it.
      setRevoicing(false);
      setError(e instanceof Error ? e.message : t('player.reVoicingFailed'));
      return;
    }
    invalidateLineAudio(island.id);
    invalidateCachedIsland(island.id);
    await awaitRevoice(island.id);
  }

  // Waits for a running re-voice to land, then swaps the fresh island in on
  // the same line. Shared by doRevoice and the load effect, which finds an
  // island still being re-voiced when the player is opened again mid-way.
  // A failure or the 60 s timeout drops to the error screen, whose Retry
  // reloads (and waits again if the server is still working).
  async function awaitRevoice(islandId: string) {
    // A promise finally, not a try finally: the compiler does not lower those.
    const run = async () => {
      try {
        const data = await waitForIsland(islandId, 60);
        if (!isMounted()) return;
        // Once more after the wait: a clip fetched while the server was
        // still speaking would be the old voice.
        invalidateLineAudio(islandId);
        invalidateCachedIsland(islandId);
        if (!data) {
          setIsland(null);
          setError(t('player.reVoicingTakingLong'));
          return;
        }
        // A new generation gives the player a new source URL, so the native
        // player drops the old clip instead of keeping it.
        setGeneration((g) => g + 1);
        core.current?.resetForNewAudio();
        setIdx((i) => Math.max(0, Math.min(i, data.lines.length - 1)));
        setIsland(forSession(data));
        setError('');
      } catch (e) {
        if (!isMounted()) return;
        setIsland(null);
        setError(e instanceof Error ? e.message : t('player.reVoicingFailed'));
      }
    };
    await run().finally(() => setRevoicing(false));
  }

  async function renameTitle(title: string) {
    if (!island) return;
    const finalTitle = title.trim() || t('player.untitledIsland');
    try {
      await api.renameIsland(island.id, finalTitle);
      invalidateCachedIsland(island.id);
      // Functional update: this runs after the sheet's exit animation
      // (`onDismissed`), so `island` closed over at call time may already be
      // stale if a build or revoice updated it in the meantime.
      setIsland((cur) => cur && { ...cur, title: finalTitle });
    } catch (e) {
      void alertSheet(t('player.couldNotRename'), e instanceof Error ? e.message : t('player.serverDidNotAnswer'));
    }
  }

  async function confirmRegenerate() {
    if (!island || revoicing || regenerating) return;
    const target: api.Complexity = island.complexity === 'simple' ? 'complex' : 'simple';
    const pick = await confirmSheet({
      title: target === 'complex' ? t('player.regenerateComplexTitle') : t('player.regenerateSimpleTitle'),
      message: t('player.regenerateBody'),
      actions: [
        { label: t('common.cancel'), verb: 'tools' },
        { label: t('player.regenerateLabel'), verb: 'tools' },
      ],
    });
    if (pick === 1) void doRegenerate(target);
  }

  // The backend drops the old lines as soon as the route runs and rebuilds
  // from the stored recording: transcribe, write, speak. The screen shows the
  // stage until the island is ready again, then starts over at line 0.
  async function doRegenerate(target: api.Complexity) {
    if (!island) return;
    setRegenerating(true);
    setBuildStage('transcribing');
    core.current?.setPlayWhenLoaded(false);
    core.current?.dropTake();
    stopPlayback(player);
    core.current?.closePanel();
    setDragSpan(null);
    // A promise finally, not a try finally: the compiler does not lower those.
    const run = async () => {
      try {
        try {
          await api.regenerate(island.id, target);
          invalidateLineAudio(island.id);
          invalidateCachedIsland(island.id);
        } catch (e) {
          // Nothing was started, so the island on the server still matches what
          // is on screen. Say why and go back to it.
          setError(e instanceof Error ? e.message : t('player.regenerateFailed'));
          return;
        }
        deleteTakes(island.id);
        const data = await waitForIsland(island.id, 240, setBuildStage);
        resetHighlight();
        setGeneration((g) => g + 1);
        core.current?.resetForNewAudio();
        setIdx(0);
        if (!data) {
          // Each new line is written over the same audio path, so by now the
          // server has already replaced the lines this screen is holding.
          // Reload onto whatever it has rather than showing old text.
          const message = t('player.stillBuildingShowsWhatServerHas');
          carryError.current = message;
          setError(message);
          setAttempt((n) => n + 1);
          return;
        }
        setIsland(forSession(data));
        setError('');
      } catch (e) {
        // The server now holds a failed island with no lines. Reloading shows
        // the failed screen, which already offers Regenerate.
        setError(e instanceof Error ? e.message : t('player.regenerateFailed'));
        setAttempt((n) => n + 1);
      }
    };
    await run().finally(() => setRegenerating(false));
  }

  async function confirmDelete() {
    if (!island) return;
    const pick = await confirmSheet({
      title: t('player.deleteIslandTitle', { title: island.title || t('player.untitledIsland') }),
      message: t('player.deleteIslandBody'),
      actions: [
        { label: t('common.cancel'), verb: 'tools' },
        { label: t('common.delete'), verb: 'speak', destructive: true },
      ],
    });
    if (pick === 1) void removeIsland();
  }

  return { doRevoice, awaitRevoice, renameTitle, confirmRegenerate, confirmDelete };
}
