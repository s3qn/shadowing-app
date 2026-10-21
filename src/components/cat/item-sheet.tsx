import { StyleSheet, Text, View } from 'react-native';

import { ItemDisc, wornByPct } from '@/components/cat/item-grid';
import { formatHours } from '@/components/cat/level-header';
import { BottomSheet } from '@/components/sheet/bottom-sheet';
import { fonts } from '@/constants/fonts';
import { tide, verb } from '@/constants/theme';
import { useDir, useT } from '@/lib/i18n';
import { itemState, type CosmeticItem, type Progress } from '@/lib/progression';

const GOLD = verb.read.c1;
const DISC = 96;

export type ItemSheetProps = {
  /** The item shown. The parent keeps it through the exit slide, so the rows never blank while closing. */
  item: CosmeticItem | null;
  open: boolean;
  onClose: () => void;
  progress: Progress;
  /** Lifetime listening hours, for the hours row. */
  hours: number;
};

/** Hours to go, rounded up: one decimal under 10, else whole. */
function hoursUp(h: number): string {
  if (h < 10) return (Math.ceil(h * 10) / 10).toFixed(1);
  return String(Math.ceil(h));
}

/**
 * The item popup: the item on its disc, how it unlocks, where you stand and
 * what it costs after. Nothing to tap but close (backdrop, drag down, grab,
 * Android back). Opens from a locked wardrobe cell and from every Rewards
 * cell on the own profile. The server writes the unlock copy; an old server
 * without `unlock` falls back to the level and hours fields.
 */
export function ItemSheet({ item, open, onClose, progress, hours }: ItemSheetProps) {
  const { t } = useT();
  const dir = useDir();
  const state = item ? itemState(item, progress) : null;
  const locked = state === 'locked';
  const owned = state === 'owned' || state === 'equipped';
  const unlock = item?.unlock;
  const source = unlock?.source ?? (item?.hours_req ? 'hours' : 'level');

  let status = '';
  if (item) {
    if (state === 'equipped') status = t('wardrobe.worn');
    else if (state === 'owned') status = t('wardrobe.owned');
    else if (!locked) status = source === 'achievement' ? t('item.earned') : t('item.unlocked');
    else if (source === 'level') status = t('item.youAreLevel', { n: progress.level });
    else if (source === 'hours') {
      const need = typeof unlock?.need === 'number' ? unlock.need : (item.hours_req ?? 0);
      status = `${t('wardrobe.listened', { h: formatHours(hours * 3600) })} · ${t('wardrobe.hoursLeft', { n: hoursUp(Math.max(0, need - hours)) })}`;
    } else status = t('item.notEarned');
  }
  const price = !item || owned ? null : source === 'hours' || item.price === 0 ? t('item.thenFree') : t('item.thenPrice', { n: item.price });

  return (
    <BottomSheet open={open && item !== null} onClose={onClose} title={item?.name}>
      {item ? (
        <View style={styles.body}>
          <ItemDisc item={item} locked={locked} size={DISC} />
          <Text style={[styles.how, dir.writing]}>{unlock?.text ?? t('wardrobe.reachLevel', { n: item.level_req })}</Text>
          <Text style={[styles.dim, dir.writing]}>{status}</Text>
          {price ? <Text style={[styles.price, dir.writing]}>{price}</Text> : null}
          {item.owned_pct != null ? <Text style={[styles.dim, dir.writing]}>{t('wardrobe.wornBy', { n: wornByPct(item.owned_pct) })}</Text> : null}
        </View>
      ) : null}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  body: { alignItems: 'center', gap: 6, paddingTop: 4, paddingBottom: 8 },
  how: { fontFamily: fonts.ui, fontSize: 15, lineHeight: 20, color: tide.text, textAlign: 'center', marginTop: 8 },
  dim: { fontFamily: fonts.ui, fontSize: 13, lineHeight: 18, color: tide.textDim, textAlign: 'center' },
  price: { fontFamily: fonts.ui, fontSize: 13, lineHeight: 18, color: GOLD, textAlign: 'center' },
});
