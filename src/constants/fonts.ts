import { Platform } from 'react-native';

// Miraa uses the iPhone system fonts, so the app matches: no bundled font
// files, just the platform default per key. `fontFamily: undefined` falls
// back to the OS default on both platforms.
export const fonts = {
  serifJp: Platform.select({ ios: 'Hiragino Sans', android: 'sans-serif', default: undefined }),
  serifLight: Platform.select({ ios: 'System', android: 'sans-serif-light', default: undefined }),
  ui: Platform.select({ ios: 'System', android: 'sans-serif', default: undefined }),
  uiMedium: Platform.select({ ios: 'System', android: 'sans-serif-medium', default: undefined }),
  // "Echo Tail" wordmark. Fraunces (the approved mock) is not bundled, so
  // this is the closest loaded face: Baskerville's italic semibold on iOS,
  // a plain serif on Android (the wordmark style adds the italic and weight
  // there, since Android has no matching named face).
  wordmark: Platform.select({ ios: 'Baskerville-SemiBoldItalic', android: 'serif', default: undefined }),
} as const;
