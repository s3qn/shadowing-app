import { router, usePathname, useSegments } from 'expo-router';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GUIDE_CHIP_ROOM, GuideLayer, type GuideHole, guideBubbleHeight } from '@/components/onboarding/guide-layer';
import { StarterFinish } from '@/components/onboarding/starter-finish';
import * as api from '@/lib/api';
import { getGuideBefore, getGuideStep, guideStartHome, setGuideStep, useGuideAnchors, useGuideStep, type GuideBox } from '@/lib/guide';
import { useT } from '@/lib/i18n';
import { clearCelebration, clearLevelUp } from '@/lib/level-up-store';
import { applyProgress, type Progress, useProgressCache } from '@/lib/progression';
import { getSettingsSync, setBetaNoteSeen, subscribeSettings } from '@/lib/settings';
import { prism } from '@/constants/theme';

/** Home's profile card with its gap: the stats card starts right under it. */
const HOME_PROFILE_H = 76;
/** ET-16: from the stats card's top past its numbers and day row, so the cat never covers them. */
const STATS_NUMBERS_H = 140;
/** The cat badge's avatar: 10 pt in from the card's start edge, 56 pt wide. */
const BADGE_CAT_X = 10 + 28;

/** Just past the tab pill's icon centre from its start edge (padding and half the icon, 2 pt outward), so the ring sits on the gear and the label stays readable. */
const TAB_ICON_X = 24;
/** The Settings tab's ring, shrunk to the icon. */
const TAB_RING = 0.45;
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
  const { t, rtl } = useT();
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
  // The route before this one: the beta step ends when the lit Settings tab is tapped from Home, not when a cold start opens on Settings.
  const prevPath = useRef(pathname);

  useEffect(() => {
    if (resumed.current || !onboarded) return;
    resumed.current = true;
    const s = getGuideStep();
    const id = getSettingsSync().guideIslandId;
    // ET-13: a guide that is not done always resumes from Home, whatever screen the app opened on.
    // Onboarding pops back to its own Home by itself, so it is left alone.
    // The beta note lives on Home too, so an account at done that has not heard it goes Home first.
    const beta = s === 'done' && !getSettingsSync().betaNoteSeen;
    if ((s !== 'done' || beta) && pathname !== '/onboarding') guideStartHome(segments[0] === '(tabs)', pathname);
    // Every account hears the beta note once: an account already at done gets it on this launch.
    if (beta) setGuideStep('beta');
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
    const from = prevPath.current;
    prevPath.current = pathname;
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
    // The beta note's last page lights the Settings tab: tapping it opens Settings and ends the guide.
    else if (step === 'beta' && pathname === '/settings' && from === '/') finishBeta();
  }, [step, pathname]);

  if (!onboarded || pathname === '/sign-in') return null;
  // ET-15: dismissAll on a stack with nothing to pop warns "POP_TO_TOP was not handled".
  const popToTabs = () => {
    if (router.canDismiss()) router.dismissAll();
  };
  const tour = () => {
    popToTabs();
    setGuideStep('tour');
  };
  const home = () => {
    leaving.current = true;
    setGuideStep('free');
    popToTabs();
  };
  // ET-16: the bubble's top just under Home's stats numbers, given the stats card's top.
  const underStats = (statsTop: number) => statsTop + STATS_NUMBERS_H;
  if (step === 'levelup') return <LevelUp onTap={tour} />;
  if (step === 'home' && a.addFab) {
    // bl58-easy-for-me: an empty Home shows "No islands yet" where the bubble would sit, so the bubble goes above that text.
    // With islands the island card is what the copy talks about, so the bubble sits over the stats card under the profile, clear of the sort tray and the card.
    // ET-16: with islands the bubble sits under the stats numbers, over the Practice now row and the sort tray, and ends above the island card.
    const bh = guideBubbleHeight('welcome', screenW);
    const head = a.homeHead;
    const clearStats = head ? Math.min(underStats(head.y + HOME_PROFILE_H), head.y + head.height + 16 - bh) : insets.top + 90;
    const top = a.homeEmpty ? Math.max(insets.top + 44, a.homeEmpty.y - bh - 12) : clearStats;
    return (
      <GuideLayer
        holes={[grow(a.addFab, 8)]}
        hint={centre(a.addFab)}
        bubble={{ kind: 'welcome', text: [t('guide.home'), t('guide.home.b2'), t(a.homeEmpty ? 'guide.home.b3' : 'guide.home.b3Have')], top }}
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
        chip={{ text: t('guide.chip.practice'), place: 'above' }}
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
    // The badge is near the top, so the bubble sits under it, over the practice card and clear of the stats numbers (ET-16).
    // The whole card is lit (its tap is the badge's own push to the wardrobe); the ring sits on the cat the copy names, at the card's start edge.
    const b = a.catBadge;
    const cat = { x: rtl ? b.x + b.width - BADGE_CAT_X : b.x + BADGE_CAT_X, y: b.y + b.height / 2 };
    return (
      <GuideLayer
        holes={[grow(b, 6, 40)]}
        hint={cat}
        bubble={{ kind: 'proud', text: [t('guide.cat'), t('guide.cat.b2'), t('guide.cat.b3')], top: underStats(b.y + HOME_PROFILE_H) }}
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
        bubble={{ kind: 'levelup', text: [t('guide.ranks'), t(a.ranksMe ? 'guide.ranks.b2' : 'guide.ranks.b2Empty'), t('guide.ranks.b3'), t('guide.ranks.b4')], top: top ? top.y + top.height + 12 : 300 }}
        tapAnywhere={home}
      />
    );
  }
  if (step === 'free') {
    return <GuideLayer holes={[]} dimOpacity={0.55} bubble={{ kind: 'proud', text: [t('guide.free'), t('guide.free.b2')], top: 300 }} tapAnywhere={() => setGuideStep('beta')} />;
  }
  if (step === 'beta') {
    const tab = a.settingsTab;
    return (
      <GuideLayer
        // The Settings tab is a target, lit and touchable only on the instruction page (the default litPage).
        // Its own tap opens Settings and the route effect ends the step; a tap elsewhere on that page ends it on Home.
        holes={tab ? [grow(tab, 0)] : []}
        hint={tab ? { x: rtl ? tab.x + tab.width - TAB_ICON_X : tab.x + TAB_ICON_X, y: tab.y + tab.height / 2, scale: TAB_RING } : undefined}
        dimOpacity={0.55}
        bubble={{ kind: 'record', text: [t('guide.beta'), t('guide.beta.b2'), t('guide.beta.b3'), t('guide.beta.b4')], top: 300 }}
        onTapOutside={finishBeta}
      />
    );
  }
  return null;
}

function finishBeta() {
  setGuideStep('done');
  setBetaNoteSeen(true);
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
        // The chip sits under the bubble, so the bubble leaves room for it above the safe area.
        bubble={{ kind: 'levelup', text: [t('guide.levelup', { level: done.after.level }), t('guide.levelup.b2')], top: screenH - insets.bottom - guideBubbleHeight('levelup', screenW) - GUIDE_CHIP_ROOM - 12 }}
        chip={{ text: t('guide.chip.podcast'), place: 'below' }}
        tapAnywhere={onTap}
      />
    </>
  );
}
