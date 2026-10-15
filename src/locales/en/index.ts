import { en as beforeAfter } from './before-after';
import { en as common } from './common';
import { en as drive } from './drive';
import { en as home } from './home';
import { en as importFile } from './import';
import { en as leaderboard } from './leaderboard';
import { en as player } from './player';
import { en as podcast } from './podcast';
import { en as profile } from './profile';
import { en as playerIsland } from './player-island';
import { en as playerTide } from './player-tide';
import { en as playerSheets } from './player-sheets';
import { en as record } from './record';
import { en as review } from './review';
import { en as settings } from './settings';
import { en as video } from './video';
import { en as wardrobe } from './wardrobe';

const NAMESPACES = { beforeAfter, common, drive, home, importFile, leaderboard, player, playerIsland, playerTide, playerSheets, podcast, profile, record, review, settings, video, wardrobe };

export const en = { ...beforeAfter, ...common, ...drive, ...home, ...importFile, ...leaderboard, ...player, ...playerIsland, ...playerTide, ...playerSheets, ...podcast, ...profile, ...record, ...review, ...settings, ...video, ...wardrobe };

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
