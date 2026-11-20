import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { colors, layout, space, text } from '@/lib/theme';

type Variant = 'primary' | 'secondary' | 'quiet';

interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  loading?: boolean;
  loadingLabel?: string;
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityHint?: string;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  loadingLabel,
  fullWidth = false,
  style,
  accessibilityHint,
}: ButtonProps) {
  const inactive = disabled || loading;
  const spinnerColor = variant === 'primary' ? colors.paper : colors.copper;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        variant === 'primary' && styles.primary,
        variant === 'secondary' && styles.secondary,
        variant === 'quiet' && styles.quiet,
        fullWidth && styles.fullWidth,
        pressed && !inactive && styles.pressed,
        disabled && !loading && styles.disabled,
        style,
      ]}>
      {loading ? <ActivityIndicator size="small" color={spinnerColor} style={styles.spinner} /> : null}
      <Text
        style={[
          text.buttonLabel,
          variant === 'primary' && styles.primaryLabel,
          variant === 'secondary' && styles.secondaryLabel,
          variant === 'quiet' && styles.quietLabel,
        ]}>
        {loading ? loadingLabel ?? label : label}
      </Text>
    </Pressable>
  );
}

/** Small text only action used for secondary links inside a screen. */
export function TextAction({
  label,
  onPress,
  children,
}: {
  label: string;
  onPress: () => void;
  children?: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={10}
      style={({ pressed }) => [styles.textAction, pressed && styles.pressed]}>
      {children}
      <Text style={[text.buttonLabel, styles.quietLabel]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 48,
    borderRadius: layout.radius,
    paddingHorizontal: space.xl,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
  primary: {
    backgroundColor: colors.copper,
  },
  secondary: {
    backgroundColor: colors.paper,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
  },
  quiet: {
    minHeight: 44,
    paddingHorizontal: 0,
    backgroundColor: 'transparent',
    alignSelf: 'flex-start',
  },
  fullWidth: {
    width: '100%',
  },
  pressed: {
    opacity: 0.65,
  },
  disabled: {
    opacity: 0.5,
  },
  spinner: {
    marginRight: space.sm,
  },
  primaryLabel: {
    color: colors.paper,
  },
  secondaryLabel: {
    color: colors.ink,
  },
  quietLabel: {
    color: colors.copper,
  },
  textAction: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    gap: space.sm,
  },
});
