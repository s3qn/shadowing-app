import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';

import { BuildProgress } from '@/components/build-progress';
import { useFollowBuild } from '@/hooks/use-follow-build';
import * as api from '@/lib/api';
import { etaText } from '@/lib/eta';
import { useT } from '@/lib/i18n';
import { CaptionsError, fetchCaptions } from '@/lib/youtube-captions';
import { parseYouTubeId } from '@/lib/youtube';
import { getSettings, getVoice, toIslandLanguage, toNativeLanguage } from '@/lib/settings';

/** With `url` this starts the build; with `id` it only follows one already running. */
export default function VideoBuildScreen() {
  const { t } = useT();
  const router = useRouter();
  const { url, title, id: existingId } = useLocalSearchParams<{ url?: string; title?: string; id?: string }>();

  const [error, setError] = useState('');
  const { stage, setStage, etaS, follow, stop } = useFollowBuild('/video/[id]', setError);
  const started = useRef(false);

  useEffect(() => {
    if (started.current || (!url && !existingId)) return;
    started.current = true;
    setError('');

    if (existingId) {
      follow(existingId);
      return;
    }
    getSettings().then(async (settings) => {
      const { learningLanguage, understoodLanguage } = settings;
      const voice = await getVoice(learningLanguage);
      const language = toIslandLanguage(learningLanguage);
      try {
        const videoId = parseYouTubeId(url!);
        if (!videoId) throw new Error(t('video.lookupFailed'));
        setStage('reading');
        const { events, asrEvents, context } = await fetchCaptions(videoId, language);
        const { id } = await api.importYouTubeCaptions(
          url!, title || t('video.title'), voice, language, toNativeLanguage(understoodLanguage), events, asrEvents, context,
        );
        follow(id);
      } catch (e) {
        if (e instanceof CaptionsError) setError(t(`video.err.${e.code}` as const));
        else setError(e instanceof Error ? e.message : t('video.lookupFailed'));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, existingId]);

  function close() {
    stop();
    router.back();
  }

  return (
    <BuildProgress
      stage={stage === 'reading' ? t('video.stageReading') : api.stageLabel(stage)}
      hint={t('video.buildHint')}
      eta={etaText(etaS)}
      error={error}
      onClose={close}
    />
  );
}
