import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';

import * as api from '@/lib/api';
import { mapCandidateLines, startTranscripts, stopTranscripts, useTranscriptStore } from '@/lib/dev-transcripts';

/** Dev only: `tr=1` swaps in the selected ASR candidate's lines, plus the tag
 * bar height and the end-of-video scores. Timing code reads the lines unchanged. */
export function useTranscriptReview(tr: string | undefined, videoId: string | undefined) {
  const router = useRouter();
  const trMode = __DEV__ && tr === '1';
  const trStore = useTranscriptStore();
  useEffect(() => {
    if (!trMode || !videoId) return;
    void startTranscripts(videoId);
  }, [trMode, videoId]);
  useEffect(() => () => stopTranscripts(), []);
  const trCandidate = trStore.candidates.find((c) => c.label === trStore.label);
  const trLines = useMemo(() => (trMode ? mapCandidateLines(trCandidate) : null), [trMode, trCandidate]);
  const [trBarH, setTrBarH] = useState(0);
  const [scoreOpen, setScoreOpen] = useState(false);
  const [scores, setScores] = useState<Record<string, number>>({});
  const finishScores = () => {
    for (const [label, score] of Object.entries(scores)) {
      void api.postTranscriptScore({ session: trStore.session, video: trStore.video, label, score });
    }
    setScoreOpen(false);
    router.back();
  };
  return { trMode, trStore, trLines, trBarH, setTrBarH, scoreOpen, setScoreOpen, scores, setScores, finishScores };
}
