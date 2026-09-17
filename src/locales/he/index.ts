import type { Key } from '../en';
import { he as common } from './common';
import { he as home } from './home';
import { he as player } from './player';
import { he as record } from './record';
import { he as settings } from './settings';

export const he = { ...common, ...home, ...player, ...record, ...settings } satisfies Record<Key, string>;
