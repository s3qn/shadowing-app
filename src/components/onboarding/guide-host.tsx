import { router, usePathname, useSegments } from 'expo-router';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GuideLayer, type GuideHole, guideBubbleHeight } from '@/components/onboarding/guide-layer';
import { StarterFinish } from '@/components/onboarding/starter-finish';
import * as api from '@/lib/api';
import { getGuideBefore, getGuideStep, guideStartHome, setGuideStep, useGuideAnchors, useGuideStep, type GuideBox } from '@/lib/guide';
import { useT } from '@/lib/i18n';
import { clearCelebration, clearLevelUp } from '@/lib/level-up-store';
import { applyProgress, type Progress, useProgressCache } from '@/lib/progression';
import { getSettingsSync, setBetaNoteSeen, subscribeSettings } from '@/lib/settings';
import { prism } from '@/constants/theme';

/** Home's profile card with its gap: the bubble starts right under it. */
const HOME_PROFILE_H = 76;

const centre = (b: GuideBox) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const grow = (b: GuideBox, by: number, radius?: number): GuideHole => ({
  x: b.x - by,
  y: b.y - by,
  width: b.width + 2 * by,
  height: b.height + 2 * by,
  radius,
});

/**
 * The first-run guide at the root: the moments that sit on Home, the topic
 * grid, Practice, the level-up and the tour. The add sheet and the island
 * mount their own GuideLayer (a Modal and the dock are out of reach from here).
 * Also resumes the guide after a cold start.
 */
export function GuideHost() {
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const { width: screenW, height: screenH } = useWindowDimensions();
  // bl58-easy-for-me: the sign-in screen's buttons stay reachable; an old levelup/tour/free step never covers them.
  const pathname = usePathname();
  const segments = useSegments() as string[];
  const step = useGuideStep();
  const a = useGuideAnchors();
  const onboarded = useSyncExternalStore(subscribeSettings, () => getSettingsSync().onboarded);
  const resumed = useRef(false);
  // BL-64: set by home() while the ranks pop back to Home, so a passing /wardrobe never steps back.
  const leaving = useRef(false);

  useEffect(() => {
    if (resumed.current || !onboarded) return;
    resumed.current = true;
    const s = getGuideStep();
    const id = getSettingsSync().guideIslandId;
    // ET-13: a guide that is not done always resumes from Home, whatever screen the app opened on.
    // Onboarding pops back to its own Home by itself, so it is left alone.
    if (s !== 'done' && pathname !== '/onboarding') guideStartHome(segments[0] === '(tabs)', pathname);
    // Every account hears the beta note once: an account already at done gets it on this launch.
    if (s === 'done' && !getSettingsSync().betaNoteSeen) setGuideStep('beta');
    else if (s === 'add') setGuideStep('home');
    else if (s === 'listen' || s === 'shadow' || s === 'prep' || s === 'solo') {
      // Never a blind push: only the confirmed starter island resumes. A missing or other
      // island, or no network, restarts at the + (POST /shadow/starter hands back the same island).
      if (!id) setGuideStep('home');
      else
        api
          .getIsland(id)
          .then((island) => {
            if (island.source === 'starter') router.push({ pathname: '/island/[id]', params: { id } });
            else setGuideStep('home');
          })
          .catch(() => setGuideStep('home'));
    } else if (s === 'topics') router.push('/phrases');
    else if (s === 'size') router.push('/review');
    else if (s === 'practice') {
      setGuideStep('size');
      router.push('/review');
    } else if (s === 'wardrobe' || s === 'ranks') setGuideStep('cat');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboarded]);

  // BL-64: the cat, wardrobe and ranks steps follow the route, forward and back.
  useEffect(() => {
    if (leaving.current) {
      if (step === 'free' || step === 'done') leaving.current = false;
      return;
    }
    // The first step lives on Home: if the guide arms on another tab (Settings, Podcast), go Home.
    if (step === 'home' && (pathname === '/settings' || pathname === '/podcast')) router.navigate('/');
    else if (step === 'cat' && pathname === '/wardrobe') setGuideStep('wardrobe');
    else if (step === 'wardrobe' && pathname === '/leaderboard') setGuideStep('ranks');
    else if (step === 'wardrobe' && pathname === '/') setGuideStep('cat');
    else if (step === 'ranks' && pathname === '/wardrobe') setGuideStep('wardrobe');
  }, [step, pathname]);

  if (!onboarded || pathname === '/sign-in') return null;
  const tour = () => {
    router.dismissAll();
    setGuideStep('tour');
  };
  const home = () => {
    leaving.current = true;
    setGuideStep('free');
    router.dismissAll();
  };
  if (step === 'levelup') return <LevelUp onTap={tour} />;
  if (step === 'home' && a.addFab) {
    // bl58-easy-for-me: an empty Home shows "No islands yet" where the bubble would sit, so the bubble goes above that text.
    // With islands the island card is what the copy talks about, so the bubble sits over the stats card under the profile, clear of the sort tray and the card.
    const overStats = a.homeHead ? a.homeHead.y + HOME_PROFILE_H : insets.top + 90;
    const top = a.homeEmpty ? Math.max(insets.top + 44, a.homeEmpty.y - guideBubbleHeight('welcome', screenW) - 12) : overStats;
    return (
      <GuideLayer
        holes={[grow(a.addFab, 8)]}
        hint={centre(a.addFab)}
        bubble={{ kind: 'welcome', text: [t('guide.home'), t('guide.home.b2'), t('guide.home.b3')], top }}
      />
    );
  }
  if (step === 'topics' && a.topicGrid) {
    // The cat sits flush with the bottom edge, over the last tile row that is mostly below the fold: the title, the intro line and the rows above stay readable. The chip sits under it, inside the screen.
    const bottomTop = screenH - insets.bottom - guideBubbleHeight('welcome', screenW) + 8;
    return (
      <GuideLayer
        holes={[grow(a.topicGrid, 0, 22)]}
        hint={a.topicFirstTile ? centre(a.topicFirstTile) : undefined}
        bubble={{ kind: 'welcome', text: [t('guide.topics'), t('guide.topics.b2')], top: bottomTop }}
        chip={{ text: t('guide.chip.practice'), place: 'below' }}
      />
    );
  }
  if (step === 'size' && !a.sizeTray && a.sizeRetry) {
    return (
      <GuideLayer
        holes={[grow(a.sizeRetry, 8)]}
        hint={centre(a.sizeRetry)}
        // Above the error line (two lines of 20 pt) so the cat never covers it.
        bubble={{ kind: 'record', text: t('guide.size.offline'), top: Math.max(insets.top + 44, a.sizeRetry.y - guideBubbleHeight('record', screenW) - 24 - 56) }}
      />
    );
  }
  if (step === 'size' && a.sizeTray) {
    // review.tsx registers Practice now only once 5 has been tapped.
    const next = a.practiceNow;
    const target = next ?? a.size5;
    return (
      <GuideLayer
        holes={[next ? grow(next, 0) : grow(a.sizeTray, 8, 28)]}
        hint={target ? centre(target) : undefined}
        // Below the count, its label and the bar: the cat never covers the big digit.
        bubble={{ kind: 'record', text: [t('guide.size'), t('guide.size.b2'), t('guide.size.b3')], top: next ? undefined : a.sizeTray.y + a.sizeTray.height + 185 }}
      />
    );
  }
  if (step === 'tour' && a.addFab) {
    return (
      <GuideLayer
        // The Podcast tab is what the first page talks about, so it stays in full light; the + lights on the last page.
        holes={[grow(a.addFab, 8)]}
        seeThrough={a.podcastTab ? [grow(a.podcastTab, 0)] : undefined}
        hint={centre(a.addFab)}
        bubble={{ kind: 'record', text: [t('guide.tour'), t('guide.tour.b2')] }}
        // 'below' would sit on the + hole.
        chip={{ text: t('guide.chip.cat'), place: 'above' }}
        tapAnywhere={() => setGuideStep('cat')}
      />
    );
  }
  if (step === 'cat' && a.catBadge) {
    // The badge is near the top, so the bubble sits under it, over the practice card. The tap is the badge's own push to the wardrobe.
    return (
      <GuideLayer
        holes={[grow(a.catBadge, 6, 40)]}
        hint={centre(a.catBadge)}
        bubble={{ kind: 'proud', text: [t('guide.cat'), t('guide.cat.b2'), t('guide.cat.b3')] }}
      />
    );
  }
  if (step === 'wardrobe' && pathname === '/wardrobe' && a.wardrobeTrophy) {
    // The level header and the Rive cat stay in full light; the bubble sits over the slot tabs and the grid, never over the cat.
    const stage = a.wardrobeStage;
    return (
      <GuideLayer
        holes={[grow(a.wardrobeTrophy, 8)]}
        seeThrough={stage ? [{ ...stage, radius: 0 }] : undefined}
        hint={centre(a.wardrobeTrophy)}
        bubble={{ kind: 'welcome', text: [t('guide.wardrobe'), t('guide.wardrobe.b2'), t('guide.wardrobe.b3'), t('guide.wardrobe.b4')], top: stage ? stage.y + stage.height - 24 : undefined }}
      />
    );
  }
  if (step === 'ranks' && pathname === '/leaderboard') {
    // Anchors are optional: a failed board still gets the bubble, and the last tap still goes home.
    const top = a.ranksTop;
    const seeThrough: GuideHole[] = [];
    if (top) seeThrough.push({ ...top, radius: prism.panel.radius });
    if (a.ranksMe) seeThrough.push(a.ranksMe);
    return (
      <GuideLayer
        holes={[]}
        seeThrough={seeThrough}
        bubble={{ kind: 'levelup', text: [t('guide.ranks'), t('guide.ranks.b2'), t('guide.ranks.b3'), t('guide.ranks.b4')], top: top ? top.y + top.height + 12 : 300 }}
        tapAnywhere={home}
      />
    );
  }
  if (step === 'free') {
    return <GuideLayer holes={[]} dimOpacity={0.55} bubble={{ kind: 'proud', text: [t('guide.free'), t('guide.free.b2')], top: 300 }} tapAnywhere={() => setGuideStep('beta')} />;
  }
  if (step === 'beta') {
    return (
      <GuideLayer
        holes={[]}
        dimOpacity={0.55}
        // The Settings tab is in full light only on the instruction page (the default litPage).
        seeThrough={a.settingsTab ? [grow(a.settingsTab, 0)] : undefined}
        bubble={{ kind: 'record', text: [t('guide.beta'), t('guide.beta.b2'), t('guide.beta.b3'), t('guide.beta.b4')], top: 300 }}
        tapAnywhere={() => {
          setGuideStep('done');
          setBetaNoteSeen(true);
        }}
      />
    );
  }
  return null;
}

/** Moment 6: pays the starter gift, then shows 1 → 2 with the blush. A failed request skips ahead. */
function LevelUp({ onTap }: { onTap: () => void }) {
  const { t, lang } = useT();
  const insets = useSafeAreaInsets();
  const { width: screenW, height: screenH } = useWindowDimensions();
  const { catalog: cached } = useProgressCache();
  const [fetched, setFetched] = useState<api.CosmeticItem[] | null>(null);
  const catalog = cached ?? fetched;
  const [done, setDone] = useState<{ after: Progress; item: string } | null>(null);
  const before = useRef(getGuideBefore());
  useEffect(() => {
    let live = true;
    clearCelebration();
    clearLevelUp();
    api
      .finishStarter()
      .then((res) => {
        applyProgress(res.progress);
        clearLevelUp();
        if (live) setDone({ after: res.progress, item: res.item });
      })
      .catch((err: unknown) => {
        console.warn('finishing the starter failed', err);
        if (live) onTap();
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A cold start can reach moment 6 before any screen loaded the catalog; without it the blush has no art.
  const needCatalog = !cached;
  useEffect(() => {
    if (!needCatalog) return;
    let live = true;
    api
      .getCosmeticsCatalog(lang)
      .then((c) => {
        if (live) setFetched(c.items);
      })
      .catch((err: unknown) => console.warn('loading the cosmetics catalog failed', err));
    return () => {
      live = false;
    };
  }, [needCatalog, lang]);
  if (!done) return null;
  return (
    <>
      <StarterFinish before={before.current} after={done.after} catalog={catalog ?? []} itemId={done.item} />
      <GuideLayer
        holes={[]}
        dimOpacity={0}
        bubble={{ kind: 'levelup', text: [t('guide.levelup'), t('guide.levelup.b2')], top: screenH - insets.bottom - guideBubbleHeight('levelup', screenW) - 30 }}
        chip={{ text: t('guide.chip.podcast'), place: 'below' }}
        tapAnywhere={onTap}
      />
    </>
  );
}
