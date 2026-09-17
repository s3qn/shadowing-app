import { useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, SectionList, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CatConstellation } from '@/components/cat-constellation';
import { PILL_TAB_BAR_REACH } from '@/components/pill-tab-bar';
import { PressScale } from '@/components/press-scale';
import { GlassPanel, PrismButton } from '@/components/prism';

import { fonts } from '@/constants/fonts';
import { Radius, Spacing, prism, tide } from '@/constants/theme';
import * as api from '@/lib/api';
import { getSettingsSync, subscribeSettings } from '@/lib/settings';

const SIDE = 16;
const SEARCH_DEBOUNCE_MS = 400;
/** How many shows a section shows before its "View all" row appears. */
const SHOWN_CAP = 5;

const LEVEL_STYLE: Record<'beginner' | 'intermediate' | 'advanced', { bg: string; text: string; label: string }> = {
  beginner: { bg: 'rgba(255,158,128,0.18)', text: tide.lang.ja, label: 'Beginner' },
  intermediate: { bg: 'rgba(244,200,106,0.18)', text: tide.turn, label: 'Intermediate' },
  advanced: { bg: 'rgba(255,143,122,0.18)', text: tide.record, label: 'Advanced' },
};

function LevelPill({ level }: { level: 'beginner' | 'intermediate' | 'advanced' }) {
  const s = LEVEL_STYLE[level];
  return (
    <View style={[styles.levelPill, { backgroundColor: s.bg }]}>
      <Text style={[styles.levelPillText, { color: s.text }]}>{s.label}</Text>
    </View>
  );
}

type PodcastRowProps = { show: api.PodcastShow; number?: number; onPress: () => void };

const PodcastRow = memo(function PodcastRow({ show, number, onPress }: PodcastRowProps) {
  return (
    <PressScale onPress={onPress} accessibilityRole="button" style={styles.row}>
      {number != null ? <Text style={styles.rowNumber}>{number}</Text> : null}
      {show.artworkUrl ? (
        <Image
          source={{ uri: show.artworkUrl }}
          style={styles.artwork}
          cachePolicy="memory-disk"
          contentFit="cover"
          transition={150}
        />
      ) : (
        <View style={[styles.artwork, styles.artworkPlaceholder]} />
      )}
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {show.title}
        </Text>
        <View style={styles.rowMetaRow}>
          {show.level ? <LevelPill level={show.level} /> : null}
          {show.tagline ? (
            <Text style={styles.rowTagline} numberOfLines={1}>
              {show.tagline}
            </Text>
          ) : null}
        </View>
      </View>
    </PressScale>
  );
});

type SectionData = { id: string; title: string; subtitle: string; total: number; data: api.PodcastShow[] };

export default function PodcastScreen() {
  const router = useRouter();

  const [catalog, setCatalog] = useState<api.PodcastCatalog | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<api.PodcastShow[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sectionListRef = useRef<SectionList<api.PodcastShow, SectionData>>(null);
  const [activeChip, setActiveChip] = useState<string | null>(null);

  const [learningLanguage, setLearningLanguage] = useState(() => getSettingsSync().learningLanguage);
  useEffect(() => subscribeSettings(() => setLearningLanguage(getSettingsSync().learningLanguage)), []);

  useEffect(() => {
    setCatalog(null);
    setCatalogError('');
    api
      .podcastCatalog(learningLanguage)
      .then(setCatalog)
      .catch((e) => setCatalogError(e instanceof Error ? e.message : 'The catalog could not be loaded.'));
  }, [learningLanguage]);

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!q) {
      setSearchResults(null);
      setSearching(false);
      setSearchError('');
      return;
    }
    debounceRef.current = setTimeout(() => {
      setSearching(true);
      setSearchError('');
      api
        .podcastSearch(q, learningLanguage)
        .then(setSearchResults)
        .catch((e) => setSearchError(e instanceof Error ? e.message : 'That could not be searched.'))
        .finally(() => setSearching(false));
    }, SEARCH_DEBOUNCE_MS);
  }, [query, learningLanguage]);

  const sections: SectionData[] = useMemo(
    () =>
      (catalog?.sections ?? []).map((s) => ({
        id: s.id,
        title: s.title,
        subtitle: s.subtitle,
        total: s.shows.length,
        data: expanded[s.id] ? s.shows : s.shows.slice(0, SHOWN_CAP),
      })),
    [catalog, expanded],
  );

  function openShow(show: api.PodcastShow) {
    router.push({ pathname: '/podcast/episodes', params: { feedUrl: show.feedUrl, title: show.title } });
  }

  function jumpTo(sectionId: string) {
    const index = sections.findIndex((s) => s.id === sectionId);
    if (index < 0) return;
    setActiveChip(sectionId);
    sectionListRef.current?.scrollToLocation({ sectionIndex: index, itemIndex: 0, viewOffset: 0, animated: true });
  }

  const showingSearch = query.trim().length > 0;

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: tide.sky[0] }])}>
      <View style={styles.searchRow}>
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder="Search podcast or URL"
          placeholderTextColor={tide.textDim}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      {showingSearch ? (
        searching ? (
          <View style={styles.center}>
            <CatConstellation size={100} label="Loading" />
          </View>
        ) : searchError ? (
          <View style={styles.center}>
            <Text style={[styles.hint, styles.centerText]}>{searchError}</Text>
          </View>
        ) : (
          <FlatList
            style={styles.fill}
            contentContainerStyle={styles.list}
            data={searchResults ?? []}
            keyExtractor={(item, i) => `${item.collectionId ?? item.feedUrl}-${i}`}
            renderItem={({ item }) => <PodcastRow show={item} onPress={() => openShow(item)} />}
            ListEmptyComponent={<Text style={[styles.hint, styles.centerText]}>No shows found.</Text>}
          />
        )
      ) : catalogError ? (
        <View style={styles.center}>
          <Text style={[styles.hint, styles.centerText]}>{catalogError}</Text>
        </View>
      ) : !catalog ? (
        <View style={styles.center}>
          <CatConstellation size={120} label="Loading" />
        </View>
      ) : (
        <>
          {/* prism: chip row shares one blur pane, each chip a flat pill */}
          <GlassPanel radius={Radius.pill} style={styles.chipRow}>
            <FlatList
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chipRowContent}
              data={catalog.sections}
              keyExtractor={(s) => s.id}
              renderItem={({ item }) => (
                <PrismButton
                  shape="pill"
                  verb="listen"
                  flat
                  press="light"
                  haptic={false}
                  on={activeChip === item.id}
                  label={item.title}
                  onPress={() => jumpTo(item.id)}
                  accessibilityRole="button"
                />
              )}
            />
          </GlassPanel>
          <SectionList
            ref={sectionListRef}
            style={styles.fill}
            contentContainerStyle={styles.list}
            sections={sections}
            keyExtractor={(item, i) => `${item.collectionId ?? item.feedUrl}-${i}`}
            renderSectionHeader={({ section }) => (
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>{section.title}</Text>
                <Text style={styles.sectionSubtitle}>{section.subtitle}</Text>
              </View>
            )}
            renderItem={({ item, index }) => (
              <PodcastRow show={item} number={index + 1} onPress={() => openShow(item)} />
            )}
            renderSectionFooter={({ section }) =>
              section.total > SHOWN_CAP && !expanded[section.id] ? (
                <PrismButton
                  shape="pill"
                  verb="listen"
                  label={`View all ${section.total}`}
                  onPress={() => setExpanded((prev) => ({ ...prev, [section.id]: true }))}
                  containerStyle={styles.viewAll}
                />
              ) : null
            }
            onScrollToIndexFailed={() => {
              // A section past the measured window: nothing to recover, the
              // next layout pass will let the chip work.
            }}
            stickySectionHeadersEnabled={false}
          />
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.lg,
    paddingHorizontal: SIDE,
  },
  centerText: { textAlign: 'center' },
  hint: { fontSize: 14, lineHeight: 20, color: tide.textDim, fontFamily: fonts.ui },
  searchRow: { paddingHorizontal: SIDE, paddingTop: Spacing.sm, paddingBottom: Spacing.sm },
  searchInput: {
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.md,
    backgroundColor: 'rgba(255,255,255,0.06)',
    color: tide.text,
    fontSize: 15,
    fontFamily: fonts.ui,
  },
  chipRow: { flexGrow: 0, marginHorizontal: SIDE, marginBottom: Spacing.sm },
  chipRowContent: { paddingHorizontal: SIDE, paddingVertical: Spacing.xs, gap: Spacing.xs },
  // paddingBottom leaves room for the floating pill tab bar and the offset
  // pane that peeks out past its bottom edge, so the last row never hides
  // under it.
  list: { paddingHorizontal: SIDE, paddingBottom: Spacing.xl + PILL_TAB_BAR_REACH + prism.tray.pane.dy, gap: Spacing.sm },
  sectionHeader: { paddingTop: Spacing.md, paddingBottom: Spacing.xs, gap: 2 },
  sectionTitle: { fontSize: 17, lineHeight: 22, color: tide.text, fontFamily: fonts.uiMedium, fontWeight: '500' },
  sectionSubtitle: { fontSize: 13, lineHeight: 18, color: tide.textDim, fontFamily: fonts.ui },
  viewAll: { alignSelf: 'center', marginVertical: Spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    padding: Spacing.sm,
    borderRadius: Radius.md,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  rowNumber: { width: 20, textAlign: 'center', fontSize: 14, color: tide.textDim, fontFamily: fonts.ui },
  artwork: { width: 56, height: 56, borderRadius: Radius.sm },
  artworkPlaceholder: { backgroundColor: tide.water },
  rowBody: { flex: 1, gap: 4 },
  rowTitle: { fontSize: 15, lineHeight: 20, color: tide.text, fontFamily: fonts.uiMedium, fontWeight: '500' },
  rowMetaRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  rowTagline: { flex: 1, fontSize: 13, lineHeight: 18, color: tide.textDim, fontFamily: fonts.ui },
  levelPill: { borderRadius: Radius.pill, paddingHorizontal: Spacing.sm, paddingVertical: 2 },
  levelPillText: { fontSize: 11, fontFamily: fonts.uiMedium, fontWeight: '500' },
});
