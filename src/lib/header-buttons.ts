import type { ReactElement } from 'react';
import { Platform } from 'react-native';

/** Header options for a left item that is already a round or pill button. On
 * iOS 26 the native header wraps every header view in a shared glass capsule,
 * which shows as a button inside a button. A custom item with
 * `hidesSharedBackground` drops that capsule. Android and web keep
 * `headerLeft`. Spread into `<Stack.Screen options>`. */
export function headerLeftButton(render: () => ReactElement) {
  return Platform.select({
    ios: { unstable_headerLeftItems: () => [{ type: 'custom' as const, element: render(), hidesSharedBackground: true }] },
    default: { headerLeft: render },
  });
}

/** Twin of `headerLeftButton` for the right side. `lib/header-item.ts`
 * re-exports it. */
export function headerRightButton(render: () => ReactElement) {
  return Platform.select({
    ios: { unstable_headerRightItems: () => [{ type: 'custom' as const, element: render(), hidesSharedBackground: true }] },
    default: { headerRight: render },
  });
}
