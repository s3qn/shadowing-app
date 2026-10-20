import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CatAvatar } from '@/components/cat/cat-avatar';
import { PrismButton } from '@/components/prism';
import { KAGENEKO_EMOTIONS, KAGENEKO_MODES, SLOTS, type ArtSpec, type Equipped, type KagenekoEmotion, type KagenekoMode, type Slot } from '@/constants/cosmetics';
import { fonts } from '@/constants/fonts';
import { Spacing } from '@/constants/theme';
import { RIVE_AVAILABLE } from '@/lib/rive-available';

const PAGE = '#0B1020';
const TEST_ART: ArtSpec = { shape: 'cap', color: '#FFC857', accent: '#FFC857' };
const INSTANCES = ['Default', 'Showcase'] as const;

// Same rule as CatAvatar: Rive is required only where it exists, never imported.
const KagenekoView = RIVE_AVAILABLE
  ? (require('@/components/cat/kageneko-view') as typeof import('@/components/cat/kageneko-view')).KagenekoView
  : null;

/**
 * Dev-only cat lab for checking the Rive cat in a dev build: the Default and
 * Showcase instances, each slot's Shown toggle, one test image on the head,
 * the four modes and the pet trigger. Reachable from Settings, About.
 */
export default function CatLabScreen() {
  const [instanceName, setInstanceName] = useState<(typeof INSTANCES)[number]>('Default');
  const [equipped, setEquipped] = useState<Equipped>({});
  const [headImage, setHeadImage] = useState(false);
  const [mode, setMode] = useState<KagenekoMode>('idle');
  const [emotion, setEmotion] = useState<KagenekoEmotion>('none');
  const [petKey, setPetKey] = useState(0);

  const toggleSlot = (slot: Slot) => setEquipped((e) => ({ ...e, [slot]: e[slot] ? null : TEST_ART }));
  const shown: Equipped = {
    ...equipped,
    head: equipped.head && headImage ? { ...equipped.head, image: require('../../assets/images/splash-icon.png') } : equipped.head,
  };

  return (
    <SafeAreaView edges={['bottom']} style={styles.fill}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.stage}>
          {KagenekoView ? (
            <KagenekoView key={instanceName} size={184} equipped={shown} mode={mode} emotion={emotion} petKey={petKey} instanceName={instanceName} />
          ) : (
            <>
              <CatAvatar size={184} equipped={shown} mode={mode} emotion={emotion} petKey={petKey} />
              <Text style={styles.note}>Rive needs a dev build. Expo Go shows the placeholder cat.</Text>
            </>
          )}
        </View>

        <Text style={styles.title}>Instance</Text>
        <View style={styles.row}>
          {INSTANCES.map((n) => (
            <PrismButton key={n} shape="pill" verb="tools" label={n} on={instanceName === n} onPress={() => setInstanceName(n)} />
          ))}
        </View>

        <Text style={styles.title}>Slot Shown (1 or 0)</Text>
        <View style={styles.row}>
          {SLOTS.map((s) => (
            <PrismButton key={s} shape="pill" verb="tools" label={s} on={!!equipped[s]} onPress={() => toggleSlot(s)} />
          ))}
          <PrismButton shape="pill" verb="tools" label="Head image" on={headImage} onPress={() => setHeadImage((v) => !v)} />
        </View>

        <Text style={styles.title}>Mode</Text>
        <View style={styles.row}>
          {KAGENEKO_MODES.map((m) => (
            <PrismButton key={m} shape="pill" verb="tools" label={m} on={mode === m} onPress={() => setMode(m)} />
          ))}
        </View>

        <Text style={styles.title}>Emotion</Text>
        <View style={styles.row}>
          {KAGENEKO_EMOTIONS.map((e) => (
            <PrismButton key={e} shape="pill" verb="tools" label={e} on={emotion === e} onPress={() => setEmotion(e)} />
          ))}
        </View>

        <Text style={styles.title}>Trigger</Text>
        <View style={styles.row}>
          <PrismButton shape="pill" verb="tools" label="Pet" onPress={() => setPetKey((k) => k + 1)} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: PAGE },
  content: { padding: Spacing.md, gap: Spacing.sm },
  stage: { alignItems: 'center', paddingVertical: Spacing.md, gap: Spacing.sm },
  note: { fontFamily: fonts.ui, fontSize: 13, color: '#9AA3C7', textAlign: 'center' },
  title: { fontFamily: fonts.ui, fontSize: 13, fontWeight: '700', color: '#9AA3C7', marginTop: Spacing.sm },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
});
