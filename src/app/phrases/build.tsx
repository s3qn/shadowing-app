import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';

import { BuildProgress } from '@/components/build-progress';
import { useFollowBuild } from '@/hooks/use-follow-build';
import * as api from '@/lib/api';
import { useT } from '@/lib/i18n';
import { getSettings, getVoice, toIslandLanguage, toNativeLanguage } from '@/lib/settings';

export default function PhrasesBuildScreen() {
  const { t } = useT();
  const router = useRouter();
  const { topic, uri } = useLocalSearchParams<{ topic?: string; uri?: string }>();

  const [error, setError] = useState('');
  const { stage, follow, stop } = useFollowBuild('/island/[id]', setError);
  const started = useRef(false);

  useEffect(() => {
    if (started.current || (!topic && !uri)) return;
    started.current = true;
    setError('');
    getSettings().then(async (settings) => {
      const { learningLanguage, understoodLanguage } = settings;
      const voice = await getVoice(learningLanguage);
      const language = toIslandLanguage(learningLanguage);
      const native = toNativeLanguage(understoodLanguage);
      (uri ? api.createTopicIsland(uri, voice, language, native) : api.importPhrases(topic!, voice, language, native))
        .then(({ id }) => follow(id))
        .catch((e) => {
          setError(e instanceof Error ? e.message : t('home.phrasesError'));
        });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic, uri]);

  function cancel() {
    stop();
    router.back();
  }

  return (
    <BuildProgress
      stage={api.stageLabel(stage)}
      hint={t(uri ? 'phrases.topicHint' : 'home.phrasesBuildHint')}
      error={error}
      blankTitle
      onClose={cancel}
    />
  );
}
