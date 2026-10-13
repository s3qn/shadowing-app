import type { Key } from '../en';
import { he as beforeAfter } from './before-after';
import { he as common } from './common';
import { he as home } from './home';
import { he as importFile } from './import';
import { he as player } from './player';
import { he as playerIsland } from './player-island';
import { he as playerTide } from './player-tide';
import { he as playerSheets } from './player-sheets';
import { he as record } from './record';
import { he as settings } from './settings';

export const he = { ...beforeAfter, ...common, ...home, ...importFile, ...player, ...playerIsland, ...playerTide, ...playerSheets, ...record, ...settings } satisfies Record<Key, string>;
