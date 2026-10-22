import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';

import { BuildProgress } from '@/components/build-progress';
import { useFollowBuild } from '@/hooks/use-follow-build';
import * as api from '@/lib/api';
import { etaText } from '@/lib/eta';
import { useT } from '@/lib/i18n';
import { getSettings, getVoice, toIslandLanguage, toNativeLanguage } from '@/lib/settings';

export default function PodcastBuildScreen() {
  const { t } = useT();
  const router = useRouter();
  const { audioUrl, title } = useLocalSearchParams<{ audioUrl: string; title?: string }>();

  const [error, setError] = useState('');
  const { stage, etaS, follow, stop } = useFollowBuild('/podcast/[id]', setError);
  const started = useRef(false);

  useEffect(() => {
    if (started.current || !audioUrl) return;
    started.current = true;
    setError('');
    getSettings().then(async (settings) => {
      const { learningLanguage, understoodLanguage } = settings;
      const voice = await getVoice(learningLanguage);
      api
        .importPodcastEpisode(
          audioUrl,
          title || t('record.defaultEpisodeTitle'),
          voice,
          toIslandLanguage(learningLanguage),
          toNativeLanguage(understoodLanguage),
        )
        .then(({ id }) => follow(id))
        .catch((e) => {
          setError(e instanceof Error ? e.message : t('record.episodeDownloadFailed'));
        });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioUrl]);

  function cancel() {
    stop();
    router.back();
  }

  return (
    <BuildProgress
      stage={api.stageLabel(stage)}
      hint={t('record.podcastBuildHint')}
      eta={etaText(etaS)}
      error={error}
      onClose={cancel}
    />
  );
}
