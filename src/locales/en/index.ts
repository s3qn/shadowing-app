import { en as common } from './common';
import { en as home } from './home';
import { en as player } from './player';
import { en as record } from './record';
import { en as settings } from './settings';

export const en = { ...common, ...home, ...player, ...record, ...settings };

/** Every key the catalogue defines. Hebrew's `satisfies Record<Key, string>`
 * fails to typecheck the moment a key is missing there. */
export type Key = keyof typeof en;
