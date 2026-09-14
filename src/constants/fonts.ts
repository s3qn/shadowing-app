import { Platform } from 'react-native';

// Miraa uses the iPhone system fonts, so the app matches: no bundled font
// files, just the platform default per key. `fontFamily: undefined` falls
// back to the OS default on both platforms.
export const fonts = {
  serifJp: Platform.select({ ios: 'Hiragino Sans', android: 'sans-serif', default: undefined }),
  serifLight: Platform.select({ ios: 'System', android: 'sans-serif-light', default: undefined }),
  ui: Platform.select({ ios: 'System', android: 'sans-serif', default: undefined }),
  uiMedium: Platform.select({ ios: 'System', android: 'sans-serif-medium', default: undefined }),
} as const;
