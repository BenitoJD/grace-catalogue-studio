import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { colors, space, text } from '@/lib/theme';

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
  const spinnerColor = variant === 'primary' ? '#FFFFFF' : '#0D0D0D';

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
    minHeight: 46,
    borderRadius: 999,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
  primary: {
    backgroundColor: '#0D0D0D',
  },
  secondary: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E0E0E0',
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
    opacity: 0.72,
  },
  disabled: {
    opacity: 0.4,
  },
  spinner: {
    marginRight: space.sm,
  },
  primaryLabel: {
    color: '#FFFFFF',
  },
  secondaryLabel: {
    color: colors.ink,
  },
  quietLabel: {
    color: '#6E6E73',
  },
  textAction: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    gap: space.sm,
  },
});
