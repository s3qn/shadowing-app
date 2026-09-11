import { useColorScheme } from 'react-native';

import { Colors, type Palette } from '@/constants/theme';

export function useTheme(): { palette: Palette; scheme: 'light' | 'dark' } {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  return { palette: Colors[scheme], scheme };
}
