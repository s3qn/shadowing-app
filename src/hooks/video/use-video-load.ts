import { useEffect, useState } from 'react';

import * as api from '@/lib/api';
import { devRepairPending, devRepairPhase } from '@/lib/dev-simulate';
import { useT } from '@/lib/i18n';
import { syncVideoRepair, syncVideoTiming } from '@/lib/video-timing';

/** Loads the island and its video, then waits on the server jobs (caption timing and caption repair), reloading the lines in place when one lands. */
export function useVideoLoad(
  id: string,
  preview: string | undefined,
  review: string | undefined,
  onReviewCards: (cards: api.ReviewCard[]) => void,
) {
  const { t } = useT();
  const [island, setIsland] = useState<api.Island | null>(null);
  const [video, setVideo] = useState<api.IslandVideo | null>(null);
  const [error, setError] = useState('');
  // Server jobs the player waits on: caption timing and caption repair.
  const [alignWait, setAlignWait] = useState(false);
  const [repairWait, setRepairWait] = useState(false);

  useEffect(() => {
    if (preview) return;
    let alive = true;
    Promise.all([api.getIsland(id), api.getIslandVideo(id), review ? api.listReviewCards(id) : null])
      .then(([i, v, cards]) => {
        if (!alive) return;
        if (cards) onReviewCards(cards);
        setIsland(i);
        setVideo(v);
        // Caption timing: an island built before the ASR transfer (or whose
        // job failed) posts the automatic track once, then polls below.
        if (v.align === '' || v.align === 'failed') {
          void syncVideoTiming(id, v.video_id, i.language).then((ok) => ok && alive && setAlignWait(true));
        } else if (v.align === 'queued' || v.align === 'running') setAlignWait(true);
        // Caption repair: an island built before the repair pass (or whose
        // job failed, while attempts remain) posts the video's context once.
        if (v.repair === '' || v.repair === 'failed') {
          void syncVideoRepair(id, v.video_id).then(
            (r) => (r === 'queued' || r === 'running') && alive && setRepairWait(true),
          );
        } else if (v.repair === 'queued' || v.repair === 'running') setRepairWait(true);
        if (devRepairPending()) setRepairWait(true);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : t('video.loadFailed')));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, preview]);

  // Poll while the server retimes or repairs the lines; reload them in place
  // when a job lands (one reload when both land on the same tick). The
  // active line index and the catch state live outside `island`, so they
  // carry over to the new text.
  useEffect(() => {
    if (!alignWait && !repairWait) return;
    let alive = true;
    const t0 = Date.now();
    const timer = setInterval(async () => {
      if (Date.now() - t0 > 15 * 60 * 1000) {
        setAlignWait(false);
        setRepairWait(false);
        return;
      }
      try {
        const v = await api.getIslandVideo(id);
        if (!alive) return;
        let landed = false;
        if (alignWait) {
          if (v.align === 'done') {
            setAlignWait(false);
            landed = true;
          } else if (v.align === 'failed' || v.align === 'closed') setAlignWait(false);
        }
        if (repairWait) {
          const repair = devRepairPhase() ?? v.repair;
          if (repair === 'done') {
            setRepairWait(false);
            landed = true;
          } else if (repair === 'failed' || repair === 'closed') setRepairWait(false);
        }
        if (landed) {
          const i = await api.getIsland(id);
          if (alive) setIsland(i);
        }
      } catch {}
    }, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [alignWait, repairWait, id]);

  return { island, video, error, alignWait, repairWait };
}
