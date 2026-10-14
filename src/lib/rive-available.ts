import { isRunningInExpoGo } from 'expo';
import { Platform } from 'react-native';

/** Rive needs a native module, so it exists only in a dev or release build. */
export const RIVE_AVAILABLE = Platform.OS !== 'web' && !isRunningInExpoGo();
