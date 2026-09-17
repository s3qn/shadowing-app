import { useMemo, useState } from 'react';
import { SectionList, StyleSheet, Text, TextInput, View } from 'react-native';

import { PressScale } from '@/components/press-scale';
import { CheckIcon, SearchIcon } from '@/components/tide/toolbar-icons';
import { fonts } from '@/constants/fonts';
import { Radius, Spacing, tide } from '@/constants/theme';
import { getLanguage, LANGUAGES, type LanguageEntry, type LanguageId, type Region } from '@/lib/languages';

const REGIONS: Region[] = ['Europe', 'Asia', 'Middle East', 'Africa', 'Americas'];

type Section = { title: string; data: LanguageEntry[] };

export type LanguagePickerProps = {
  /** Whether the app can generate islands in the pick (`'learn'`) or only
   * explain in it (`'understand'`). Only `'learn'` shows region chips and the
   * "coming soon" fallback note. */
  mode: 'learn' | 'understand';
  value: LanguageId;
  onChange: (id: LanguageId) => void;
  /** A language chosen on the other screen, hidden here so the two picks
   * can never collide (for example English understanding English). */
  exclude?: LanguageId;
};

// Intl.DateTimeFormat is built into Hermes, no new package needed. A locale
// Hermes cannot resolve (should not happen, but this runs at import time on
// every device) falls back to no suggestion rather than crashing the screen.
function suggestedLanguageId(): LanguageId | null {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    const subtag = locale.split(/[-_]/)[0]?.toLowerCase();
    if (!subtag) return null;
    const match = LANGUAGES.find((l) => l.understandable && l.id.toLowerCase() === subtag);
    return match?.id ?? null;
  } catch {
    return null;
  }
}

function matchesQuery(entry: LanguageEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return entry.native.toLowerCase().includes(q) || entry.english.toLowerCase().includes(q);
}

function RegionChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <PressScale
      onPress={onPress}
      style={[
        styles.chip,
        {
          backgroundColor: active ? tide.listen : 'rgba(255,255,255,0.08)',
          borderColor: active ? tide.listen : 'rgba(255,255,255,0.14)',
        },
      ]}>
      <Text style={[styles.chipText, { color: active ? tide.sky[0] : tide.text }]}>{label}</Text>
    </PressScale>
  );
}

function LanguageRow({ entry, selected, onPress }: { entry: LanguageEntry; selected: boolean; onPress: () => void }) {
  return (
    <PressScale onPress={onPress} style={styles.row}>
      <View style={styles.badgeBox}>
        <Text style={styles.badge}>{entry.badge}</Text>
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.native}>{entry.native}</Text>
        <Text style={styles.english}>{entry.english}</Text>
      </View>
      {selected ? <CheckIcon color={tide.listen} size={20} /> : null}
    </PressScale>
  );
}

/**
 * The shared language catalogue browser: search by native or English name,
 * region chips (learn mode only), and grouped sections. Onboarding's
 * language step and Settings > Language both render this instead of keeping
 * their own pill rows, so the catalogue only needs wiring once.
 */
export function LanguagePicker({ mode, value, onChange, exclude }: LanguagePickerProps) {
  const [query, setQuery] = useState('');
  const [activeRegion, setActiveRegion] = useState<Region | null>(null);

  const suggested = useMemo(() => (mode === 'understand' ? suggestedLanguageId() : null), [mode]);

  const sections = useMemo<Section[]>(() => {
    const base = LANGUAGES.filter((l) => l.id !== exclude && (mode === 'learn' || l.understandable)).filter((l) =>
      matchesQuery(l, query),
    );
    if (mode === 'learn') {
      const filtered = activeRegion ? base.filter((l) => l.region === activeRegion) : base;
      const ready = filtered.filter((l) => l.learnable);
      const soon = filtered.filter((l) => !l.learnable);
      const out: Section[] = [];
      if (ready.length) out.push({ title: 'Ready to learn', data: ready });
      if (soon.length) out.push({ title: 'Coming soon', data: soon });
      return out;
    }
    const suggestedList = suggested ? base.filter((l) => l.id === suggested) : [];
    const rest = base.filter((l) => l.id !== suggested);
    const out: Section[] = [];
    if (suggestedList.length) out.push({ title: 'Suggested', data: suggestedList });
    if (rest.length) out.push({ title: 'All languages', data: rest });
    return out;
  }, [mode, exclude, query, activeRegion, suggested]);

  return (
    <SectionList
      style={styles.fill}
      contentContainerStyle={styles.list}
      sections={sections}
      keyExtractor={(item) => item.id}
      stickySectionHeadersEnabled={false}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={
        <View style={styles.header}>
          <View style={styles.searchRow}>
            <SearchIcon color={tide.textDim} size={18} />
            <TextInput
              style={styles.searchInput}
              value={query}
              onChangeText={setQuery}
              placeholder="Search a language"
              placeholderTextColor={tide.textDim}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
          {mode === 'learn' ? (
            <View style={styles.chipRow}>
              {REGIONS.map((region) => (
                <RegionChip
                  key={region}
                  label={region}
                  active={activeRegion === region}
                  onPress={() => setActiveRegion((prev) => (prev === region ? null : region))}
                />
              ))}
            </View>
          ) : null}
        </View>
      }
      ListEmptyComponent={
        query.trim() ? <Text style={styles.empty}>No languages match &quot;{query.trim()}&quot;.</Text> : null
      }
      renderSectionHeader={({ section }) => (
        <View style={styles.sectionHeaderWrap}>
          {mode === 'learn' && section.title === 'Coming soon' ? (
            <Text style={styles.soonNote}>
              Not ready for islands yet. Picking one tells us what to build next; islands still use Japanese for now.
            </Text>
          ) : null}
          <Text style={styles.sectionHeader}>{section.title}</Text>
        </View>
      )}
      renderItem={({ item }) => <LanguageRow entry={item} selected={item.id === value} onPress={() => onChange(item.id)} />}
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
  list: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing.xl, gap: Spacing.sm },
  header: { gap: Spacing.sm, paddingBottom: Spacing.xs },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    height: 40,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: tide.waterline,
    backgroundColor: tide.water,
    paddingHorizontal: Spacing.md,
  },
  searchInput: { flex: 1, fontSize: 15, color: tide.text, fontFamily: fonts.ui, padding: 0 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  chip: {
    borderWidth: 1,
    borderRadius: Radius.pill,
    paddingVertical: Spacing.xs + 2,
    paddingHorizontal: Spacing.md,
  },
  chipText: { fontSize: 13, fontWeight: '600', fontFamily: fonts.uiMedium },
  empty: { fontSize: 14, lineHeight: 20, color: tide.textDim, fontFamily: fonts.ui, paddingTop: Spacing.sm },
  sectionHeaderWrap: { gap: Spacing.xs, paddingTop: Spacing.md, paddingBottom: Spacing.xs },
  sectionHeader: { fontSize: 13, fontWeight: '700', color: tide.textDim, letterSpacing: 0.5, fontFamily: fonts.uiMedium },
  soonNote: { fontSize: 13, lineHeight: 18, color: tide.textDim, fontFamily: fonts.ui },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.md,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: tide.waterline,
    backgroundColor: tide.water,
  },
  badgeBox: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  badge: { fontSize: 20 },
  rowBody: { flex: 1, gap: 2 },
  native: { fontSize: 17, fontWeight: '600', color: tide.text, fontFamily: fonts.uiMedium },
  english: { fontSize: 13, color: tide.textDim, fontFamily: fonts.ui },
});
