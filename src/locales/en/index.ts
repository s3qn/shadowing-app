import { en as common } from './common';
import { en as home } from './home';
import { en as player } from './player';
import { en as playerIsland } from './player-island';
import { en as playerTide } from './player-tide';
import { en as playerSheets } from './player-sheets';
import { en as record } from './record';
import { en as settings } from './settings';

const NAMESPACES = { common, home, player, playerIsland, playerTide, playerSheets, record, settings };

export const en = { ...common, ...home, ...player, ...playerIsland, ...playerTide, ...playerSheets, ...record, ...settings };

// Spreading hides a collision: two namespaces claiming the same key leaves the
// later one's wording everywhere, silently and only in the app, since both
// files still typecheck on their own. Say so at startup instead.
if (__DEV__) {
  const owner: Record<string, string> = {};
  for (const [namespace, table] of Object.entries(NAMESPACES)) {
    for (const key of Object.keys(table)) {
      if (owner[key]) console.warn(`locales: "${key}" is defined in both ${owner[key]} and ${namespace}`);
      else owner[key] = namespace;
    }
  }
}

/** Every key the catalogue defines. Hebrew's `satisfies Record<Key, string>`
 * fails to typecheck the moment a key is missing there. */
export type Key = keyof typeof en;
