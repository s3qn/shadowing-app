import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';

import { BuildProgress } from '@/components/build-progress';
import { useFollowBuild } from '@/hooks/use-follow-build';
import * as api from '@/lib/api';
import { useT } from '@/lib/i18n';
import { getGuideStep, setGuideStep } from '@/lib/guide';
import { setLastLine } from '@/lib/last-line';
import { getSettings, getVoice, setGuideIslandId, toIslandLanguage, toNativeLanguage } from '@/lib/settings';

export default function PhrasesBuildScreen() {
  const { t } = useT();
  const router = useRouter();
  // `guide` is the first-run guide's step when it opened this screen ('listen' or 'size'); the saved step can still be in flight.
  const { topic, uri, point, guide, starter } = useLocalSearchParams<{ topic?: string; uri?: string; point?: string; guide?: string; starter?: string }>();
  const toReview = guide === 'size';

  const [error, setError] = useState('');
  // True once this screen hands over to the island or Practice; the unmount cleanup reads it.
  const landed = useRef(false);
  const land = () => {
    landed.current = true;
  };
  const { stage, follow, stop } = useFollowBuild(toReview ? '/review' : '/island/[id]', setError, land);
  const started = useRef(false);
  // Retry bumps this to run the build again in place, so the screen never unmounts and the guide step stays.
  const [attempt, setAttempt] = useState(0);
  const retry = () => {
    started.current = false;
    setAttempt((a) => a + 1);
  };

  useEffect(() => {
    if (started.current || (!topic && !uri && !point && !starter)) return;
    started.current = true;
    setError('');
    getSettings().then(async (settings) => {
      const { learningLanguage, understoodLanguage } = settings;
      const voice = await getVoice(learningLanguage);
      const language = toIslandLanguage(learningLanguage);
      const native = toNativeLanguage(understoodLanguage);
      (starter
        ? api.startStarter(language, native, settings.starterLevel)
        : point
          ? api.importGrammar(point, voice, native)
          : uri
            ? api.createTopicIsland(uri, voice, language, native)
            : api.importPhrases(topic!, voice, language, native))
        .then(async ({ id, status }: { id: string; status?: string }) => {
          // bl56-first-run-flow: the guide's first island is the one a cold start resumes on,
          // and the island screen reads it to turn the guide on, so it is saved first.
          if (guide === 'listen') await setGuideIslandId(id).catch((err: unknown) => console.warn('saving the guide island failed', err));
          // A replayed onboarding finds the starter island already made: it starts again on line 1, not the saved line.
          if (starter) setLastLine(id, 0);
          if (status === 'ready') {
            land();
            router.replace(toReview ? '/review' : { pathname: '/island/[id]', params: { id } });
          } else follow(id);
        })
        .catch((e) => {
          setError(e instanceof Error ? e.message : t('home.phrasesError'));
        });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic, uri, point, starter, attempt]);

  // Left before the hand-over (Cancel, a swipe back, Android back): the guide returns to the
  // moment that opened this screen (the + on Home, or the lit topic grid) instead of lying dormant.
  useEffect(
    () => () => {
      if (landed.current) return;
      const s = getGuideStep();
      if (s === 'listen') setGuideStep('home');
      else if (s === 'size') setGuideStep('topics');
    },
    [],
  );

  function cancel() {
    stop();
    router.back();
  }

  return (
    <BuildProgress
      stage={api.stageLabel(stage)}
      hint={t(uri ? 'phrases.topicHint' : 'home.phrasesBuildHint')}
      error={error}
      onRetry={retry}
      blankTitle
      onClose={cancel}
    />
  );
}
