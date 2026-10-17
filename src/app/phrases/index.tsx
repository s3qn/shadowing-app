import { BlurView } from 'expo-blur';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SymbolView } from 'expo-symbols';
import { memo, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  type ListRenderItem,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type TextStyle,
  View,
  useWindowDimensions,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Extrapolation,
  interpolate,
  interpolateColor,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  Easing,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { Canvas, LinearGradient, Rect, vec } from '@shopify/react-native-skia';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CatConstellation } from '@/components/cat-constellation';
import { PressScale } from '@/components/press-scale';
import { PrismButton } from '@/components/prism';
import { GRAMMAR_LILAC } from '@/components/ruby-word';
import { SearchIcon } from '@/components/tide/toolbar-icons';

import { fonts } from '@/constants/fonts';
import { Radius, Spacing, tide } from '@/constants/theme';
import * as api from '@/lib/api';
import { hapticSelection } from '@/lib/haptics';
import { useDir, useT } from '@/lib/i18n';
import { getSettingsSync, isGrammarLevel, setGrammarLevel, subscribeSettings, toIslandLanguage } from '@/lib/settings';

const SIDE = 16;
const MIC_SIZE = 44;
const TILE_H = 128;
const TILE_GAP = 10;
// One grid row: a tile and the gap under it. The grid's getItemLayout counts in rows.
const ROW_H = TILE_H + TILE_GAP;
// The pull-down search field above the grammar grid, the same pill as Home's search.
const SEARCH_H = 40;
const SEARCH_HEAD = Spacing.md * 2 + SEARCH_H;
// Scrolled this far the field sits just above the top edge, hidden until a pull down.
const SEARCH_HIDE = Spacing.md + SEARCH_H;
const SEARCH_DEBOUNCE = 200;
// GR3-2 .fade: 110 tall, clear to the sky's foot at 85%.
const FADE_H = 110;
const FADE_TO = '#16243A';
const TILE_RADIUS = 20;
// GR3-2 deck: the page is 50 narrower than the screen. A flip moves it a screen width
// plus 24, so the other side sits fully off screen at rest and slides in on a drag.
const PAGE_INSET = 50;
const PAGE_OFF = 24;
const PILL_W = 196;
const KNOB_W = (PILL_W - 8) / 2;
const GRAMMAR_EMOJI: Record<string, string> = {
  ながら: '🎧',
  てしまう: '😅',
  ばかり: '🍚',
  わけではない: '🙅',
  ようにする: '🎯',
  たことがある: '🗓️',
  すぎる: '🌶️',
  すぎ: '🌶️',
  ことにする: '✅',
};
const GRAMMAR_FALLBACK = ['📝', '🧭', '🔑', '🌊', '🎴', '🍵', '🌸', '🧩', '🚪', '🌙', '🎐', '🪁'];

// GR2-A3 level rail: 56 wide glass pill, 10 from the edge; five 48 slots 106 apart, 4 in.
// A short screen packs the slots closer, never under 72 apart.
const LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'];
// Each level's colour, for the thumb's ring and label and the tile chip ("~N1" too).
const LEVEL_INK: Record<string, string> = {
  N5: '#7EE0A8',
  N4: '#6CC8FF',
  N3: '#F5C451',
  N2: '#FF9E6B',
  N1: '#C9B8FF',
};
const LEVEL_INKS = LEVELS.map((l) => LEVEL_INK[l]!);
const SLOT_STOPS = LEVELS.map((_, i) => i);
const RAIL_W = 56;
const RAIL_EDGE = 10;
const RAIL_PAD = 4;
const THUMB = 48;
const SLOT = 106;
const SLOT_MIN = 72;
// Room between the Phrases/Grammar pill and the rail's top.
const RAIL_GAP = 16;
// Page room the rail takes: GR2-A3 tiles stop 78 from the edge, the page already ends 34 in.
const RAIL_ROOM = 44;

type Look = { emoji: string; from: string; to: string };
// Per-topic emoji and 135deg gradient, from the approved PH2-v1 design.
const FALLBACK_LOOK: Look = { emoji: '💬', from: '#34445a', to: '#4a5a70' };
const TOPIC_LOOK: Record<string, Look> = {
  greetings: { emoji: '👋', from: '#27405c', to: '#3c5a7a' },
  'eating-out': { emoji: '🍜', from: '#4a3b52', to: '#6b4a45' },
  'getting-around': { emoji: '🚃', from: '#1f4a52', to: '#2c6a6a' },
  'about-me': { emoji: '🙋', from: '#3a3f66', to: '#5a4f7e' },
  shopping: { emoji: '🛍️', from: '#5a3f4a', to: '#7a4f5a' },
  help: { emoji: '🆘', from: '#523a3a', to: '#6e4a3a' },
  'small-talk': { emoji: '☕', from: '#2c4a66', to: '#3a6a86' },
  questions: { emoji: '❓', from: '#34445a', to: '#4a5a70' },
};

function grammarLook(id: string): Look {
  const base = Object.values(TOPIC_LOOK);
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const c = base[h % base.length]!;
  return { emoji: GRAMMAR_EMOJI[id] ?? GRAMMAR_FALLBACK[h % GRAMMAR_FALLBACK.length]!, from: c.from, to: c.to };
}

// The thumb settles without overshoot after a tap or a release.
const RAIL_SETTLE = { duration: 180, easing: Easing.out(Easing.cubic) };
const DECK_FLIP = { duration: 260, easing: Easing.out(Easing.cubic) };
// Finger travel before a touch counts as a drag instead of a tap.
const DRAG_SLOP = 6;

function LevelRail({
  level,
  onLevel,
  onSettle,
  left,
  flip,
  stride,
  top,
  slot,
  dim,
}: {
  level: string;
  onLevel: (l: string) => void;
  onSettle: (l: string) => void;
  left: boolean;
  flip: SharedValue<number>;
  /** The deck's flip distance, so the rail moves exactly with the Grammar page. */
  stride: number;
  top: number;
  slot: number;
  /** A grammar search is showing, so the rail steps back. */
  dim: boolean;
}) {
  const idx = Math.max(0, LEVELS.indexOf(level));
  const pos = useSharedValue(idx);
  // The slot the thumb is headed for. A level set from outside springs only when it differs.
  const target = useSharedValue(idx);
  const startY = useSharedValue(0);
  const startPos = useSharedValue(idx);
  const dragging = useSharedValue(0);
  // Slot ticks only while the learner moves the thumb, not when a saved level is restored.
  const user = useSharedValue(0);
  // The ring's colour, as a slot index, crossfading over the thumb's settle time.
  const ring = useSharedValue(idx);
  useEffect(() => {
    if (target.value === idx) return;
    target.value = idx;
    user.value = 0;
    pos.value = withTiming(idx, RAIL_SETTLE);
  }, [idx, pos, target, user]);
  const pick = useCallback((i: number) => onLevel(LEVELS[i] ?? 'N5'), [onLevel]);
  const settle = useCallback((i: number) => onSettle(LEVELS[i] ?? 'N5'), [onSettle]);
  const tick = useCallback(() => {
    void hapticSelection();
  }, []);
  useAnimatedReaction(
    () => Math.round(pos.value || 0),
    (now, prev) => {
      if (prev !== null && now !== prev && user.value === 1) scheduleOnRN(tick);
      if (Number.isFinite(now) && now !== prev) ring.value = withTiming(now, RAIL_SETTLE);
    },
  );
  const rail = Gesture.Pan()
    .minDistance(0)
    .onBegin((e) => {
      startY.value = Number.isFinite(e.y) ? e.y : 0;
      startPos.value = Number.isFinite(pos.value) ? pos.value : target.value;
      dragging.value = 0;
      user.value = 1;
    })
    .onUpdate((e) => {
      const dy = e.y - startY.value;
      if (!Number.isFinite(dy) || !(slot > 0)) return;
      if (dragging.value === 0 && Math.abs(dy) < DRAG_SLOP) return;
      dragging.value = 1;
      // 1:1 with the finger from where the touch began, so the thumb never jumps to it.
      // The level itself changes only on release, so the grid never refills mid drag.
      pos.value = Math.min(4, Math.max(0, startPos.value + dy / slot));
    })
    .onFinalize(() => {
      let s = target.value;
      if (dragging.value === 1) {
        if (Number.isFinite(pos.value)) s = Math.round(pos.value);
      } else if (slot > 0) {
        const f = (startY.value - RAIL_PAD - THUMB / 2) / slot;
        if (Number.isFinite(f)) s = Math.round(Math.min(4, Math.max(0, f)));
      }
      dragging.value = 0;
      target.value = s;
      pos.value = withTiming(s, RAIL_SETTLE, (done) => {
        if (done) user.value = 0;
      });
      scheduleOnRN(pick, s);
      // Saved once per settle, not on every drag frame.
      scheduleOnRN(settle, s);
    });
  const off = stride * (left ? -1 : 1);
  // Part of the Grammar page: the same slide as the page, so rail and tiles never overlap.
  const slide = useAnimatedStyle(() => ({
    transform: [{ translateX: interpolate(flip.value || 0, [0, 1], [off, 0], Extrapolation.CLAMP) }],
  }));
  const thumbStyle = useAnimatedStyle(() => ({ transform: [{ translateY: (pos.value || 0) * slot }] }));
  const ringStyle = useAnimatedStyle(() => ({
    borderColor: interpolateColor(Math.min(4, Math.max(0, ring.value || 0)), SLOT_STOPS, LEVEL_INKS),
  }));
  return (
    <GestureDetector gesture={rail}>
      <Animated.View
        style={[
          styles.rail,
          { top, height: RAIL_PAD * 2 + THUMB + 4 * slot },
          left ? { left: RAIL_EDGE } : { right: RAIL_EDGE },
          dim && styles.railDim,
          slide,
        ]}>
        <View style={styles.railGlass}>
          <BlurView intensity={30} tint="dark" style={StyleSheet.absoluteFill} />
        </View>
        <Animated.View style={[styles.thumbWrap, thumbStyle]} pointerEvents="none">
          <Animated.View style={[styles.thumb, ringStyle]} />
        </Animated.View>
        {LEVELS.map((l, i) => (
          <RailLabel key={l} label={l} i={i} pos={pos} slot={slot} />
        ))}
      </Animated.View>
    </GestureDetector>
  );
}

// Labels never move or fade: only the one under the thumb crossfades to its level's colour.
function RailLabel({ label, i, pos, slot }: { label: string; i: number; pos: SharedValue<number>; slot: number }) {
  const on = useSharedValue(0);
  useAnimatedReaction(
    () => Math.round(pos.value || 0) === i,
    (now, prev) => {
      if (now !== prev) on.value = withTiming(now ? 1 : 0, { duration: 120 });
    },
  );
  const lit = LEVEL_INK[label] ?? tide.text;
  const ink = useAnimatedStyle(() => ({ color: interpolateColor(on.value || 0, [0, 1], [tide.text, lit]) }));
  return (
    <View style={[styles.railSlot, { top: RAIL_PAD + i * slot }]} pointerEvents="none">
      <Animated.Text style={[styles.railText, ink]}>{label}</Animated.Text>
    </View>
  );
}

// Grammar points by level, kept for the app's life so coming back paints at once.
const grammarCache = new Map<string, api.GrammarPoint[]>();
// Levels the backend has grammar for; null until it answers, [] when it has no grammar.db.
let grammarLevelList: string[] | null = null;

function BottomFade() {
  const { width } = useWindowDimensions();
  return (
    <Canvas style={styles.fade} pointerEvents="none">
      <Rect x={0} y={0} width={width} height={FADE_H}>
        <LinearGradient start={vec(0, 0)} end={vec(0, FADE_H)} colors={['rgba(22,36,58,0)', FADE_TO]} positions={[0, 0.85]} />
      </Rect>
    </Canvas>
  );
}

function TopicTile({ look, children }: { look: Look; children: ReactNode }) {
  const [size, setSize] = useState({ w: 0, h: TILE_H });
  return (
    <View
      style={styles.card}
      onLayout={(e) => setSize({ w: e.nativeEvent.layout.width || 0, h: e.nativeEvent.layout.height || TILE_H })}>
      <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
        <Rect x={0} y={0} width={size.w} height={size.h} opacity={0.9}>
          <LinearGradient start={vec(0, 0)} end={vec(size.w, size.h)} colors={[look.from, look.to]} />
        </Rect>
      </Canvas>
      {children}
    </View>
  );
}

// One grammar tile. Memoized, so a refilled grid only renders the rows that come into view.
const GrammarTile = memo(function GrammarTile({
  point,
  text,
  onOpen,
}: {
  point: api.GrammarPoint;
  text: TextStyle | undefined;
  onOpen: (id: string) => void;
}) {
  const look = grammarLook(point.id);
  const ink = LEVEL_INK[point.level] ?? GRAMMAR_LILAC;
  return (
    <PressScale style={styles.tile} accessibilityRole="button" onPress={() => onOpen(point.id)}>
      <TopicTile look={look}>
        <Text style={styles.glyph}>{look.emoji}</Text>
        <View style={[styles.lvl, { borderColor: `${ink}99` }]}>
          <Text style={[styles.lvlText, { color: ink }]}>
            {point.level_guess ? '~' : ''}
            {point.level}
          </Text>
          {point.added ? (
            <SymbolView name={{ ios: 'checkmark', android: 'check' }} size={10} weight="bold" tintColor={tide.text} />
          ) : null}
        </View>
        <View style={styles.tx}>
          <Text style={[styles.title, text]} numberOfLines={2}>
            {point.pattern}
          </Text>
          <Text style={[styles.count, text]} numberOfLines={1}>
            {point.meaning_short || point.reading}
          </Text>
        </View>
      </TopicTile>
    </PressScale>
  );
});

const grammarKey = (p: api.GrammarPoint) => p.id;
const grammarRow = (_: unknown, index: number) => ({ length: ROW_H, offset: SEARCH_HEAD + ROW_H * index, index });

export default function PhrasesScreen() {
  const router = useRouter();
  const { t, lang } = useT();
  const dir = useDir();

  const [topics, setTopics] = useState<api.PhraseTopic[] | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [learningLanguage, setLearningLanguage] = useState(() => getSettingsSync().learningLanguage);
  useEffect(() => subscribeSettings(() => setLearningLanguage(getSettingsSync().learningLanguage)), []);
  const requestId = useRef(0);
  // Grammar points (ja only, GR3-2), read from grammarCache. Bumped when a level lands.
  const [, setGrammarVersion] = useState(0);
  // The saved level from the start; a learner with none picks the open default once the grammar loads.
  const [level, setLevel] = useState<string>(() => getSettingsSync().grammarLevel ?? 'N5');
  const levelRef = useRef(level);
  useEffect(() => {
    levelRef.current = level;
  }, [level]);
  const levelSeeded = useRef(false);
  const settleLevel = useCallback((l: string) => {
    if (isGrammarLevel(l) && getSettingsSync().grammarLevel !== l) void setGrammarLevel(l);
  }, []);
  const shown = grammarCache.get(level) ?? null;
  // Pull-down search across every level. Results replace the grid while the query has text.
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<api.GrammarPoint[] | null>(null);
  const q = query.trim();
  useEffect(() => {
    if (!q) {
      setFound(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      api
        .grammarPoints('', q)
        .then((pts) => {
          if (live) setFound(pts);
        })
        .catch(() => {
          if (live) setFound([]);
        });
    }, SEARCH_DEBOUNCE);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q]);
  const grid = q ? (found ?? shown) : shown;
  const gridRef = useRef<FlatList<api.GrammarPoint>>(null);
  // A new level opens at its top with the search field tucked away again.
  useEffect(() => {
    gridRef.current?.scrollToOffset({ offset: SEARCH_HIDE, animated: false });
  }, [level]);
  const openPoint = useCallback(
    (id: string) => router.push({ pathname: '/phrases/build', params: { point: id } }),
    [router],
  );
  const renderPoint = useCallback<ListRenderItem<api.GrammarPoint>>(
    ({ item }) => <GrammarTile point={item} text={dir.text} onOpen={openPoint} />,
    [dir.text, openPoint],
  );
  const isJa = toIslandLanguage(learningLanguage) === 'ja';
  // The deck shows until the backend says it has no grammar, so the first fetch paints its loader there.
  const hasGrammar = isJa && (grammarLevelList === null || grammarLevelList.length > 0);
  // Fetched on mount, the shown level first, then the rest. Refetched on focus so a point added
  // in Build shows its check on the way back; the cache paints meanwhile.
  useFocusEffect(
    useCallback(() => {
      if (!isJa) return;
      let live = true;
      const bump = () => {
        if (live) setGrammarVersion((v) => v + 1);
      };
      const store = (l: string) =>
        api
          .grammarPoints(l)
          .then((pts) => {
            grammarCache.set(l, pts);
            bump();
          })
          .catch(() => {});
      const first = levelRef.current;
      const firstDone = store(first);
      api
        .grammarLevels()
        .then((levels) => {
          grammarLevelList = levels.map((l) => l.level);
          bump();
          return Promise.all([firstDone, ...grammarLevelList.filter((l) => l !== first).map(store)]);
        })
        .catch(() => {
          if (grammarLevelList === null && grammarCache.size === 0) grammarLevelList = [];
          bump();
        })
        .then(() => {
          // First load this mount: a saved level stays, else the lowest level that still has a point not added.
          if (!live || levelSeeded.current || !grammarLevelList?.length) return;
          levelSeeded.current = true;
          if (getSettingsSync().grammarLevel === null) {
            const open = LEVELS.find((l) => grammarCache.get(l)?.some((p) => !p.added));
            setLevel(open ?? 'N5');
          }
        });
      return () => {
        live = false;
      };
    }, [isJa, attempt]),
  );
  // The pill's box and the deck's height place the rail RAIL_GAP under the pill and fit it on screen.
  const [pillBox, setPillBox] = useState<{ y: number; h: number } | null>(null);
  const [deckH, setDeckH] = useState(0);
  const railTop = pillBox ? pillBox.y + pillBox.h + RAIL_GAP : 0;
  const railSlot = Math.max(
    SLOT_MIN,
    Math.min(SLOT, Math.floor((deckH - railTop - Spacing.md - RAIL_PAD * 2 - THUMB) / 4) || SLOT_MIN),
  );
  // Which side is showing, for the pill's accessibility state. The deck itself runs on `flip`.
  const [side, setSide] = useState(0);

  const { width: screenW } = useWindowDimensions();
  const pageW = screenW - PAGE_INSET;
  const stride = screenW + PAGE_OFF;
  const flip = useSharedValue(0);
  const startFlip = useSharedValue(0);
  const deck = Gesture.Pan()
    .activeOffsetX([-14, 14])
    .failOffsetY([-12, 12])
    .onStart(() => {
      startFlip.value = flip.value;
    })
    .onUpdate((e) => {
      flip.value = Math.min(1, Math.max(0, startFlip.value - e.translationX / stride));
    })
    .onEnd((e) => {
      const to = flip.value + (-e.velocityX / stride) * 0.2 > 0.5 ? 1 : 0;
      flip.value = withTiming(to, DECK_FLIP);
      scheduleOnRN(setSide, to);
    });
  const deckStyle = useAnimatedStyle(() => ({ transform: [{ translateX: -flip.value * stride }] }));
  const knobStyle = useAnimatedStyle(() => ({ transform: [{ translateX: flip.value * KNOB_W }] }));
  const phrasesInk = useAnimatedStyle(() => ({ color: interpolateColor(flip.value, [0, 1], ['#FFE2A0', '#B7B1C6']) }));
  const grammarInk = useAnimatedStyle(() => ({ color: interpolateColor(flip.value, [0, 1], ['#B7B1C6', '#FFE2A0']) }));
  const hintStyle = useAnimatedStyle(() => ({ opacity: interpolate(flip.value, [0, 0.5, 1], [1, 0.6, 1]) }));
  const flipTo = (to: number) => {
    flip.value = withTiming(to, DECK_FLIP);
    setSide(to);
  };

  useEffect(() => {
    const id = ++requestId.current;
    setTopics(null);
    setError('');
    api
      .phraseCatalog(toIslandLanguage(learningLanguage), lang)
      .then((res) => {
        if (id === requestId.current) setTopics(res.topics);
      })
      .catch(() => {
        if (id === requestId.current) setError(t('home.phrasesError'));
      });
  }, [learningLanguage, lang, t, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const topicList = topics ? (
    <FlatList
      style={styles.fill}
      contentContainerStyle={[styles.list, hasGrammar && styles.listDeck]}
      columnWrapperStyle={styles.row}
      numColumns={2}
      data={topics}
      keyExtractor={(topic) => topic.id}
      renderItem={({ item }) => {
        const title = lang === 'he' ? (item.titleHe ?? item.title) : item.title;
        const he = lang !== 'he' && !!item.titleHe && item.titleHe !== item.title ? `${item.titleHe} · ` : '';
        const look = TOPIC_LOOK[item.id] ?? FALLBACK_LOOK;
        return (
          <PressScale
            style={styles.tile}
            accessibilityRole="button"
            onPress={() => router.push({ pathname: '/phrases/build', params: { topic: item.id } })}>
            <TopicTile look={look}>
              <Text style={styles.glyph}>{look.emoji}</Text>
              {item.added ? (
                <View style={styles.added} accessibilityLabel={t('phrases.added')}>
                  <SymbolView name={{ ios: 'checkmark', android: 'check' }} size={11} weight="bold" tintColor={tide.text} />
                </View>
              ) : null}
              <View style={styles.tx}>
                <Text style={[styles.title, dir.text]} numberOfLines={2}>
                  {title}
                </Text>
                <Text style={[styles.count, dir.text]} numberOfLines={1}>
                  {he}
                  {t('home.phrasesCount', { count: item.count })}
                </Text>
              </View>
            </TopicTile>
          </PressScale>
        );
      }}
    />
  ) : null;

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: tide.sky[0] }])}>
      <StatusBar style="light" />
      <Stack.Screen
        options={{
          title: t('home.phrasesTitle'),
          headerStyle: { backgroundColor: tide.sky[0] },
          headerTintColor: tide.text,
          headerShadowVisible: false,
          headerRight: () => (
            <PrismButton
              shape="round"
              size={MIC_SIZE}
              verb="speak"
              onPress={() => router.push({ pathname: '/record', params: { mode: 'topic' } })}
              accessibilityRole="button"
              accessibilityLabel={t('phrases.micLabel')}>
              <View style={styles.recordDot} />
            </PrismButton>
          ),
        }}
      />
      <View style={styles.promptWrap}>
        <Text style={[styles.prompt, dir.text]}>{t('phrases.prompt')}</Text>
        <Text style={[styles.hint, dir.text]}>{t('phrases.promptHint')}</Text>
      </View>
      {error ? (
        <Pressable style={styles.center} onPress={retry} accessibilityRole="button">
          <Text style={[styles.hint, styles.centerText]}>{error}</Text>
        </Pressable>
      ) : !topics ? (
        <View style={styles.center}>
          <CatConstellation size={120} label={t('common.loading')} />
        </View>
      ) : hasGrammar ? (
        <View style={styles.fill} onLayout={(e) => setDeckH(e.nativeEvent.layout.height || 0)}>
          <View
            style={[styles.pill, { width: PILL_W }]}
            onLayout={(e) => setPillBox({ y: e.nativeEvent.layout.y || 0, h: e.nativeEvent.layout.height || 0 })}>
            <Animated.View style={[styles.knob, { width: KNOB_W }, knobStyle]} pointerEvents="none" />
            <Pressable
              style={styles.seg}
              onPress={() => flipTo(0)}
              accessibilityRole="tab"
              accessibilityState={{ selected: side === 0 }}>
              <Animated.Text style={[styles.segText, phrasesInk]}>{t('phrases.tabPhrases')}</Animated.Text>
            </Pressable>
            <Pressable
              style={styles.seg}
              onPress={() => flipTo(1)}
              accessibilityRole="tab"
              accessibilityState={{ selected: side === 1 }}>
              <Animated.Text style={[styles.segText, grammarInk]}>{t('phrases.tabGrammar')}</Animated.Text>
            </Pressable>
          </View>
          <GestureDetector gesture={deck}>
            <Animated.View style={[styles.deck, { width: pageW + stride, gap: stride - pageW }, deckStyle]}>
              <View style={{ width: pageW }}>{topicList}</View>
              <View style={{ width: pageW }}>
                {!shown ? (
                  <View style={styles.center}>
                    <CatConstellation size={120} label={t('common.loading')} />
                  </View>
                ) : (
                  <FlatList
                    ref={gridRef}
                    style={styles.fill}
                    contentContainerStyle={[
                      styles.list,
                      styles.listDeck,
                      styles.grid,
                      dir.rtl ? { paddingLeft: RAIL_ROOM } : { paddingRight: RAIL_ROOM },
                    ]}
                    columnWrapperStyle={styles.gridRow}
                    numColumns={2}
                    data={grid}
                    keyExtractor={grammarKey}
                    renderItem={renderPoint}
                    getItemLayout={grammarRow}
                    windowSize={5}
                    initialNumToRender={8}
                    removeClippedSubviews
                    contentOffset={{ x: 0, y: SEARCH_HIDE }}
                    keyboardDismissMode="on-drag"
                    keyboardShouldPersistTaps="handled"
                    ListHeaderComponent={
                      <View style={styles.searchHead}>
                        <View style={styles.search}>
                          <View style={styles.searchIcon} pointerEvents="none">
                            <SearchIcon color={tide.text} size={18} />
                          </View>
                          <TextInput
                            value={query}
                            onChangeText={setQuery}
                            placeholder={t('phrases.grammarSearch')}
                            placeholderTextColor={tide.textDim}
                            autoCorrect={false}
                            returnKeyType="search"
                            style={[styles.searchInput, dir.text]}
                          />
                          {query ? (
                            <Pressable
                              onPress={() => setQuery('')}
                              hitSlop={10}
                              style={styles.searchClear}
                              accessibilityRole="button"
                              accessibilityLabel={t('phrases.grammarSearchClear')}>
                              <SymbolView
                                name={{ ios: 'xmark', android: 'close' }}
                                size={13}
                                weight="bold"
                                tintColor={tide.textDim}
                              />
                            </Pressable>
                          ) : null}
                        </View>
                      </View>
                    }
                    ListEmptyComponent={
                      q && found ? (
                        <Text style={[styles.hint, styles.centerText]}>{t('phrases.grammarNoMatch')}</Text>
                      ) : null
                    }
                  />
                )}
              </View>
            </Animated.View>
          </GestureDetector>
          <BottomFade />
          {pillBox && deckH > 0 ? (
            <LevelRail
              level={level}
              onLevel={setLevel}
              onSettle={settleLevel}
              left={dir.rtl}
              flip={flip}
              stride={stride}
              top={railTop}
              slot={railSlot}
              dim={!!q}
            />
          ) : null}
          <Animated.Text style={[styles.flipHint, hintStyle]}>{t('phrases.flipHint')}</Animated.Text>
        </View>
      ) : (
        <View style={styles.fill}>{topicList}</View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  recordDot: { width: 13, height: 13, borderRadius: 7, backgroundColor: tide.record },
  promptWrap: { paddingHorizontal: SIDE, paddingTop: Spacing.sm, gap: 4 },
  prompt: { fontSize: 20, lineHeight: 26, color: tide.text, fontFamily: fonts.uiMedium, fontWeight: '500' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.lg, paddingHorizontal: SIDE },
  centerText: { textAlign: 'center' },
  hint: { fontSize: 14, lineHeight: 20, color: tide.textDim, fontFamily: fonts.ui },
  list: { paddingHorizontal: SIDE, paddingVertical: Spacing.md, gap: TILE_GAP },
  // The deck's last row scrolls clear of the bottom fade.
  listDeck: { paddingHorizontal: 0, paddingBottom: FADE_H },
  row: { gap: TILE_GAP },
  // The grammar grid spaces rows by margin, not gap, so every row is exactly ROW_H for getItemLayout.
  grid: { paddingTop: 0, gap: 0 },
  gridRow: { gap: TILE_GAP, marginBottom: TILE_GAP },
  searchHead: { height: SEARCH_HEAD, paddingVertical: Spacing.md },
  // Home's search pill (island-search): same height, radius, border and type.
  search: {
    height: SEARCH_H,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: tide.waterline,
    backgroundColor: tide.water,
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: Spacing.md,
  },
  searchIcon: { width: SEARCH_H - 2, height: SEARCH_H - 2, alignItems: 'center', justifyContent: 'center' },
  searchInput: {
    flex: 1,
    height: SEARCH_H - 2,
    paddingVertical: 0,
    fontSize: 15,
    fontFamily: fonts.uiMedium,
    fontWeight: '500',
    color: tide.text,
  },
  searchClear: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  tile: { flex: 1 },
  pill: {
    alignSelf: 'center',
    flexDirection: 'row',
    height: 38,
    padding: 4,
    marginTop: Spacing.sm,
    borderRadius: 19,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  knob: {
    position: 'absolute',
    left: 4,
    top: 4,
    bottom: 4,
    borderRadius: 15,
    backgroundColor: 'rgba(255,200,87,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,200,87,0.40)',
  },
  seg: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  segText: { fontSize: 14, fontFamily: fonts.uiMedium, fontWeight: '600' },
  deck: { flex: 1, flexDirection: 'row', marginLeft: SIDE },
  // GR3-2 .cc.lv
  lvl: {
    position: 'absolute',
    left: 12,
    top: 11,
    height: 22,
    paddingHorizontal: 9,
    borderRadius: 11,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(8,12,22,0.5)',
    borderWidth: 1,
    borderColor: 'rgba(201,184,255,0.6)',
  },
  lvlText: { fontSize: 11, fontWeight: '700', color: GRAMMAR_LILAC, fontFamily: fonts.uiMedium },
  rail: { position: 'absolute', width: RAIL_W, zIndex: 6 },
  railDim: { opacity: 0.4 },
  railGlass: {
    ...StyleSheet.absoluteFill,
    borderRadius: RAIL_W / 2,
    overflow: 'hidden',
    backgroundColor: 'rgba(24,34,54,0.5)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  railSlot: { position: 'absolute', left: 0, width: RAIL_W, height: THUMB, alignItems: 'center', justifyContent: 'center' },
  railText: { fontSize: 13, fontWeight: '700', color: tide.text, fontFamily: fonts.uiMedium },
  thumbWrap: { position: 'absolute', left: RAIL_PAD, top: RAIL_PAD, width: THUMB, height: THUMB },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    backgroundColor: 'rgba(255,200,87,0.2)',
    borderWidth: 2,
    borderColor: '#FFE2A0',
  },
  fade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: FADE_H },
  flipHint: {
    textAlign: 'center',
    fontSize: 12,
    color: tide.textDim,
    fontFamily: fonts.ui,
    paddingVertical: Spacing.sm,
    zIndex: 5,
  },
  card: {
    height: TILE_H,
    borderRadius: TILE_RADIUS,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: 'rgba(20,28,44,0.72)',
  },
  glyph: { position: 'absolute', right: 12, top: 8, fontSize: 38, lineHeight: 46, opacity: 0.9 },
  added: {
    position: 'absolute',
    left: 10,
    top: 10,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  tx: { position: 'absolute', left: 14, right: 10, bottom: 12, gap: 1 },
  title: { fontSize: 19, lineHeight: 24, letterSpacing: 0.3, color: '#fff', fontFamily: fonts.uiMedium, fontWeight: '600' },
  count: { fontSize: 11.5, lineHeight: 16, color: tide.textDim, fontFamily: fonts.ui },
});
