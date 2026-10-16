import { PrismButton } from '@/components/prism';

/** Header-left button for the build and import screens: the same tools pill
 * as the back button on the review screen. */
export function HeaderClosePill({ label, onPress }: { label: string; onPress: () => void }) {
  return <PrismButton shape="pill" verb="tools" label={label} onPress={onPress} />;
}
