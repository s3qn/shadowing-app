import { useCallback, useMemo, useRef, useState } from 'react';
import { type LayoutChangeEvent, ScrollView, SectionList, StyleSheet, Text, View } from 'react-native';

import { LanguageCard } from '@/components/language-card';
import { PillTrayItem, PillTrayShell, SlidingLitPill, useSlidingPill } from '@/components/prism/pill-tray';
import { GlassInput } from '@/components/tide/glass-input';
import { fonts } from '@/constants/fonts';
import { Spacing, tide } from '@/constants/theme';
import { useBetaFeatures } from '@/lib/beta';
import { useDir, useT } from '@/lib/i18n';
import { getLanguage, LANGUAGES, type LanguageEntry, type LanguageId, type Region } from '@/lib/languages';
import { type Key } from '@/locales/en';

// Only the regions the catalogue actually has entries for get a chip: a chip
// for an empty region would show a blank list with no explanation, since the
// empty-state message only fires while there is a search query. Order is the
// sensible one from the old fixed list, filtered down to what survives.
const REGION_ORDER: Region[] = ['Europe', 'Asia', 'Middle East', 'Africa', 'Americas'];
const REGIONS: Region[] = REGION_ORDER.filter((region) => LANGUAGES.some((l) => l.region === region));

const REGION_KEY: Record<Region, Key> = {
  Europe: 'settings.picker.regionEurope',
  Asia: 'settings.picker.regionAsia',
  'Middle East': 'settings.picker.regionMiddleEast',
  Africa: 'settings.picker.regionAfrica',
  Americas: 'settings.picker.regionAmericas',
};

/** The name shown for a catalogue language id, translated (`entry.english`
 * stays on the entry as a stable id for search; the display name always
 * goes through `language.<id>`). */
function languageName(t: (key: Key) => string, id: LanguageId): string {
  return t(`language.${id}` as Key);
}

const SECTION_KEY: Record<string, Key> = {
  'Ready to learn': 'settings.picker.readyToLearn',
  'Coming soon': 'settings.picker.comingSoon',
  'All languages': 'settings.picker.allLanguages',
};

/** `Section.title` is one of the three fixed English labels the picker
 * builds internally (see `sections` below), so this is a lookup, not a
 * translation of arbitrary content. */
function sectionTitle(t: (key: Key) => string, title: string): string {
  const key = SECTION_KEY[title];
  return key ? t(key) : title;
}

type Section = { title: string; data: LanguageEntry[] };

export type LanguagePickerProps = {
  /** Whether the app can generate islands in the pick (`'learn'`) or only
   * explain in it (`'understand'`). Only `'learn'` shows region chips and the
   * "coming soon" section. */
  mode: 'learn' | 'understand';
  value: LanguageId;
  onChange: (id: LanguageId) => void;
  /** A language chosen on the other screen, hidden here so the two picks
   * can never collide (for example English understanding English). */
  exclude?: LanguageId;
  /** Learn mode only: also hide `exclude`, so the learner is never offered the language they already understand. */
  hideExcluded?: boolean;
  /** Plain rows with no list of their own, for a screen that scrolls them in
   * its own ScrollView (Settings stacks two pickers on one page, ET-12). */
  inline?: boolean;
};

function matchesQuery(entry: LanguageEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return entry.native.toLowerCase().includes(q) || entry.english.toLowerCase().includes(q);
}

/** The region filter: "All" plus one pill per region on the sliding tray the Home sort row uses. */
function RegionTray({ active, onChange }: { active: Region | null; onChange: (r: Region | null) => void }) {
  const { t } = useT();
  const dir = useDir();
  const layoutsRef = useRef<{ x: number; width: number }[]>([]);
  const [layouts, setLayouts] = useState<{ x: number; width: number }[]>([]);
  const [fillWidth, setFillWidth] = useState(0);
  const items: { region: Region | null; label: string }[] = [
    { region: null, label: t('settings.picker.regionAll') },
    ...REGIONS.map((region) => ({ region, label: t(REGION_KEY[region]) })),
  ];
  const { translateX, width } = useSlidingPill(layouts[items.findIndex((i) => i.region === active)]);
  const measured = useCallback(
    (i: number, e: LayoutChangeEvent) => {
      const { x, width: w } = e.nativeEvent.layout;
      layoutsRef.current[i] = { x, width: w };
      setFillWidth((widest) => Math.max(widest, w));
      if (layoutsRef.current.filter((l) => l).length === items.length) setLayouts([...layoutsRef.current]);
    },
    [items.length],
  );
  return (
    <PillTrayShell wrapStyle={styles.trayWrap}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <View style={[styles.trayRow, dir.row]}>
          <SlidingLitPill translateX={translateX} width={width} fillWidth={fillWidth} />
          {items.map((item, i) => (
            <PillTrayItem
              key={item.label}
              label={item.label}
              box={layouts[i]}
              pillX={translateX}
              pillW={width}
              onLayout={(e) => measured(i, e)}
              onPress={() => onChange(item.region === active ? null : item.region)}
            />
          ))}
        </View>
      </ScrollView>
    </PillTrayShell>
  );
}

/**
 * The shared language catalogue browser: search by native or English name,
 * region chips (learn mode only), and grouped sections. Onboarding's
 * language step and Settings > Language both render this instead of keeping
 * their own pill rows, so the catalogue only needs wiring once.
 */
export function LanguagePicker({ mode, value, onChange, exclude, hideExcluded, inline }: LanguagePickerProps) {
  const { t } = useT();
  const dir = useDir();
  const [query, setQuery] = useState('');
  const [activeRegion, setActiveRegion] = useState<Region | null>(null);

  // lang-core: "Ready to learn" is what `/shadow/beta` enables for this
  // device (ja/es/en with no answer); every other catalogue row is "Coming soon".
  const enabledList = useBetaFeatures().languages;
  const enabled = useMemo(() => new Set<string>(enabledList.map((l) => l.id)), [enabledList]);
  const sections = useMemo<Section[]>(() => {
    // `exclude` only applies in understand mode: hiding the learn language's
    // pick there keeps the pair from colliding. Learn mode ignores it, so
    // English (the default understood language) can still be picked to
    // learn on a fresh install; `selectLearning`'s swap handles the collision
    // from that side instead.
    const base = LANGUAGES.filter((l) => (l.id !== exclude || (mode === 'learn' && !hideExcluded)) && (mode === 'learn' || l.understandable)).filter(
      (l) => matchesQuery(l, query),
    );
    if (mode === 'learn') {
      const filtered = activeRegion ? base.filter((l) => l.region === activeRegion) : base;
      const ready = filtered.filter((l) => enabled.has(l.id));
      const soon = filtered.filter((l) => !enabled.has(l.id));
      const out: Section[] = [];
      if (ready.length) out.push({ title: 'Ready to learn', data: ready });
      if (soon.length) out.push({ title: 'Coming soon', data: soon });
      return out;
    }
    // Understand mode is one flat list. It used to lead with a "Suggested"
    // pick taken from the device locale, which is the one thing this screen
    // must not assume: the phone being set to English says nothing about
    // whether its owner reads English.
    return base.length ? [{ title: 'All languages', data: base }] : [];
  }, [mode, exclude, hideExcluded, query, activeRegion, enabled]);

  const header = (
    <View style={styles.header}>
      <GlassInput
        style={dir.text}
        value={query}
        onChangeText={setQuery}
        placeholder={t('settings.picker.searchPlaceholder')}
        autoCapitalize="none"
        autoCorrect={false}
      />
      {mode === 'learn' ? <RegionTray active={activeRegion} onChange={setActiveRegion} /> : null}
    </View>
  );
  const empty = query.trim() ? (
    <Text style={[styles.empty, dir.text]}>{t('settings.picker.noMatch', { query: query.trim() })}</Text>
  ) : null;
  const sectionHeader = (section: Section) => (
    <View style={styles.sectionHeaderWrap}>
      <Text style={[styles.sectionHeader, dir.text]}>{sectionTitle(t, section.title)}</Text>
    </View>
  );
  const row = (item: LanguageEntry) => {
    // A "coming soon" pick can never become what the app is actually
    // learning (see `setLearningLanguage`), so a learn-mode tap on one
    // must not reach `onChange` at all: `disabled` blocks the press
    // itself, rather than letting `onChange` silently no-op it.
    const soon = mode === 'learn' && !enabled.has(item.id);
    return (
      <LanguageCard
        key={item.id}
        avatar={item.flag ?? item.letter}
        title={item.native}
        subtitle={languageName(t, item.id)}
        selected={item.id === value}
        soon={soon}
        onPress={() => onChange(item.id)}
      />
    );
  };

  if (inline) {
    return (
      <View style={styles.list}>
        {header}
        {sections.length === 0 ? empty : null}
        {sections.map((section) => (
          <View key={section.title}>
            {sectionHeader(section)}
            {section.data.map(row)}
          </View>
        ))}
      </View>
    );
  }
  return (
    <SectionList
      style={styles.fill}
      contentContainerStyle={styles.list}
      sections={sections}
      keyExtractor={(item) => item.id}
      stickySectionHeadersEnabled={false}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={header}
      ListEmptyComponent={empty}
      renderSectionHeader={({ section }) => sectionHeader(section)}
      renderItem={({ item }) => row(item)}
    />
  );
}

// Exported so a screen that needs the fallback colour for a language not in
// `tide.lang` (only ja/es/en have one) can reuse the same rule the picker's
// own rows would use if they painted by language colour.
export function languageColor(id: LanguageId): string {
  return getLanguage(id) ? ((tide.lang as Record<string, string>)[id] ?? tide.listen) : tide.listen;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  list: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing.xl },
  header: { gap: Spacing.sm, paddingBottom: Spacing.xs },
  trayWrap: { alignSelf: 'stretch' },
  trayRow: { flexDirection: 'row', gap: Spacing.sm },
  empty: { fontSize: 14, lineHeight: 20, color: tide.textDim, fontFamily: fonts.ui, paddingTop: Spacing.sm },
  sectionHeaderWrap: { gap: Spacing.xs, paddingTop: Spacing.md, paddingBottom: Spacing.xs },
  sectionHeader: { fontSize: 13, fontWeight: '700', color: tide.textDim, letterSpacing: 0.5, fontFamily: fonts.uiMedium },
});
