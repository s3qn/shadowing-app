import * as Clipboard from 'expo-clipboard';
import { Image } from 'expo-image';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CatConstellation } from '@/components/cat-constellation';
import { PressScale } from '@/components/press-scale';
import { PrismButton } from '@/components/prism';
import { fonts } from '@/constants/fonts';
import { Radius, Spacing, tide } from '@/constants/theme';
import * as api from '@/lib/api';
import { useDir, useT } from '@/lib/i18n';
import { parseYouTubeId, thumbUrl } from '@/lib/youtube';

const SIDE = 16;

function rowStatus(v: api.VideoListItem, t: ReturnType<typeof useT>['t']): string {
  if (v.status === 'ready') return t('home.lines', { count: v.line_count });
  if (v.status === 'failed') return api.islandErrorText({ error_code: v.error_code });
  return api.stageLabel(v.stage || v.status);
}

/** Find a video: one Paste button reads the clipboard, no typing. */
export default function VideoAddScreen() {
  const { t } = useT();
  const dir = useDir();
  const router = useRouter();
  const [info, setInfo] = useState<api.YouTubeInfo | null>(null);
  const [hint, setHint] = useState('');
  const [busy, setBusy] = useState(false);
  const [videos, setVideos] = useState<api.VideoListItem[] | null>(null);
  const [failed, setFailed] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      api
        .listVideos()
        .then((list) => {
          if (alive) {
            setVideos(list);
            setFailed(false);
          }
        })
        .catch(() => {
          if (alive) {
            setVideos((v) => v ?? []);
            setFailed(true);
          }
        });
      return () => {
        alive = false;
      };
    }, []),
  );

  async function paste() {
    if (busy) return;
    setHint('');
    const text = await Clipboard.getStringAsync().catch(() => '');
    const id = parseYouTubeId(text);
    if (!id) {
      setInfo(null);
      setHint(t('video.copyFirst'));
      return;
    }
    setBusy(true);
    try {
      setInfo(await api.youtubeInfo(text.trim()));
    } catch (e) {
      setInfo(null);
      setHint(e instanceof Error ? e.message : t('video.lookupFailed'));
    } finally {
      setBusy(false);
    }
  }

  function build() {
    if (!info) return;
    router.replace({ pathname: '/video/build', params: { url: info.url, title: info.title } });
  }

  function preview() {
    if (!info) return;
    router.push({ pathname: '/video/[id]', params: { id: 'preview', preview: info.video_id } });
  }

  function open(v: api.VideoListItem) {
    if (v.status === 'ready') router.push({ pathname: '/video/[id]', params: { id: v.island_id } });
    else if (v.status !== 'failed') router.push({ pathname: '/video/build', params: { id: v.island_id } });
  }

  return (
    <SafeAreaView edges={['bottom']} style={[styles.fill, { backgroundColor: tide.sky[0] }]}>
      <StatusBar style="light" />
      <Stack.Screen options={{ headerStyle: { backgroundColor: tide.sky[0] }, headerTintColor: tide.text, headerShadowVisible: false }} />
      <ScrollView contentContainerStyle={styles.content}>
        {info ? (
          <View style={styles.card}>
            <Image source={{ uri: info.thumbnail }} style={styles.thumb} contentFit="cover" />
            <Text style={[styles.title, dir.content]} numberOfLines={2}>{info.title}</Text>
            {info.author ? <Text style={[styles.meta, dir.content]}>{info.author}</Text> : null}
          </View>
        ) : null}

        <View style={styles.actions}>
          {info ? (
            <>
              <PrismButton shape="pill" verb="listen" label={t('video.watchPreview')} onPress={preview} />
              <PrismButton shape="pill" verb="speak" label={t('video.build')} onPress={build} />
              <PrismButton shape="pill" verb="tools" flat press="light" label={t('video.pasteAnother')} onPress={paste} />
            </>
          ) : (
            <PrismButton shape="pill" verb="listen" label={t('video.paste')} onPress={paste} disabled={busy} />
          )}
          {busy ? <CatConstellation compact /> : null}
          {hint ? <Text style={[styles.hint, dir.writing]}>{hint}</Text> : null}
          {hint === t('video.copyFirst') ? (
            <PrismButton
              shape="pill"
              verb="tools"
              flat
              press="light"
              label={t('video.openYoutube')}
              onPress={() => void Linking.openURL('https://www.youtube.com')}
            />
          ) : null}
        </View>

        <Text style={[styles.section, dir.text]}>{t('video.yourVideos')}</Text>
        {videos === null ? (
          <View style={styles.loading}>
            <CatConstellation size={64} />
          </View>
        ) : videos.length === 0 ? (
          <Text style={[styles.meta, dir.text]}>{failed ? t('api.unreachable') : t('video.empty')}</Text>
        ) : (
          videos.map((v) => (
            <PressScale key={v.island_id} onPress={() => open(v)} style={[styles.row, dir.row]}>
              <Image source={{ uri: thumbUrl(v.video_id) }} style={styles.rowThumb} contentFit="cover" />
              <View style={styles.rowText}>
                <Text style={[styles.rowTitle, dir.content]} numberOfLines={2}>{v.title}</Text>
                <Text style={[styles.meta, dir.text, v.status === 'failed' && { color: tide.record }]} numberOfLines={2}>
                  {rowStatus(v, t)}
                </Text>
              </View>
            </PressScale>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { padding: SIDE, gap: Spacing.lg },
  card: { gap: Spacing.sm },
  thumb: { width: '100%', aspectRatio: 16 / 9, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.06)' },
  title: { fontSize: 17, lineHeight: 24, fontWeight: '600', color: tide.text, fontFamily: fonts.ui },
  meta: { fontSize: 14, lineHeight: 20, color: tide.textDim, fontFamily: fonts.ui },
  actions: { alignItems: 'center', gap: Spacing.md },
  hint: { fontSize: 14, lineHeight: 20, color: tide.textDim, fontFamily: fonts.ui, textAlign: 'center' },
  section: { fontSize: 13, fontWeight: '600', color: tide.textDim, fontFamily: fonts.ui, marginTop: Spacing.md },
  loading: { alignItems: 'center', paddingVertical: Spacing.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  rowThumb: { width: 96, aspectRatio: 16 / 9, borderRadius: Radius.md, backgroundColor: 'rgba(255,255,255,0.06)' },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 15, lineHeight: 20, color: tide.text, fontFamily: fonts.ui },
});
