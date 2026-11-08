import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

import { PrismButton } from '@/components/prism/prism-button';
import { prism } from '@/constants/theme';

type ActionProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /** Style for the outer Pressable (margins, alignment, flex). */
  containerStyle?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  testID?: string;
};

/**
 * The one main action of a screen (Build, Shadow it, Start): a big pill in
 * the speak colour, switched on, with the Tide Drop press. `trailing` is the
 * slot after the label (the energy cost chip).
 */
export function PrimaryAction({
  label,
  onPress,
  disabled,
  trailing,
  containerStyle,
  accessibilityLabel,
  testID,
}: ActionProps & { trailing?: ReactNode }) {
  return (
    <PrismButton
      shape="pill"
      verb="speak"
      on
      height={prism.sizes.bigRound}
      label={label}
      trailing={trailing}
      onPress={onPress}
      disabled={disabled}
      containerStyle={containerStyle}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      testID={testID}
    />
  );
}

/** A secondary action (Record again, Tools, Retry): a flat tools-colour pill with the light press. */
export function SecondaryAction({ label, onPress, disabled, containerStyle, accessibilityLabel, testID }: ActionProps) {
  return (
    <PrismButton
      shape="pill"
      verb="tools"
      flat
      press="light"
      label={label}
      onPress={onPress}
      disabled={disabled}
      containerStyle={containerStyle}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      testID={testID}
    />
  );
}
