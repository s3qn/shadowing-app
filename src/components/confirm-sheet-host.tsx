import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { PrismButton } from '@/components/prism/prism-button';
import { BottomSheet } from '@/components/sheet/bottom-sheet';
import { currentConfirm, settleConfirm, subscribeConfirm } from '@/lib/confirm-sheet';

/** Renders the request at the head of the confirm-sheet queue. The promise
 * settles in onDismissed, after the Modal has left, so the next sheet or the
 * caller's follow-up work never races the exit. */
export function ConfirmSheetHost() {
  const [tick, bump] = useState(0);
  const [open, setOpen] = useState(false);
  const chosen = useRef(-1);
  const shown = useRef<ReturnType<typeof currentConfirm>>(null);

  useEffect(() => subscribeConfirm(() => bump((n) => n + 1)), []);

  // Pick up the head of the queue once nothing is on screen. The sheet is
  // always mounted, so flipping `open` here gives it its slide-in.
  useEffect(() => {
    const head = currentConfirm();
    if (head && !shown.current) {
      shown.current = head;
      chosen.current = -1;
      setOpen(true);
    }
  }, [tick]);

  const req = shown.current;
  const actions = req?.actions ?? [];

  const cancelIdx = actions.findIndex((a) => !a.destructive && a.verb === 'tools');
  const order = actions.map((_, i) => i).filter((i) => i !== cancelIdx || actions.length === 1);
  if (cancelIdx >= 0 && actions.length > 1) order.push(cancelIdx);

  return (
    <BottomSheet
      open={open}
      title={req?.title}
      hint={req?.message}
      onClose={() => setOpen(false)}
      onDismissed={() => {
        const idx = chosen.current;
        shown.current = null;
        chosen.current = -1;
        settleConfirm(idx);
        bump((n) => n + 1);
      }}>
      <View style={styles.stack}>
        {order.map((i) => (
          <PrismButton
            key={i}
            shape="pill"
            flat
            verb={actions[i].verb}
            label={actions[i].label}
            containerStyle={styles.action}
            onPress={() => {
              if (!open) return;
              chosen.current = i;
              setOpen(false);
            }}
          />
        ))}
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 10, alignSelf: 'stretch' },
  action: { alignSelf: 'stretch' },
});
