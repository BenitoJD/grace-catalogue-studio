import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, space, text } from '@/lib/theme';

interface ScreenHeaderProps {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  back?: boolean;
  onBack?: () => void;
  children?: ReactNode;
}

/**
 * Editorial screen header: a copper eyebrow, a serif title and an optional
 * short subtitle. Back is drawn with hairlines so no icon font is needed.
 */
export function ScreenHeader({ eyebrow, title, subtitle, back, onBack, children }: ScreenHeaderProps) {
  return (
    <View style={styles.wrap}>
      {back ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Go back"
          onPress={onBack}
          hitSlop={12}
          style={({ pressed }) => [styles.back, pressed && styles.pressed]}>
          <View style={styles.chevron} />
          <Text style={styles.backLabel}>Back</Text>
        </Pressable>
      ) : null}
      {eyebrow ? <Text style={[text.eyebrow, back && styles.eyebrowAfterBack]}>{eyebrow}</Text> : null}
      <Text style={[text.screenTitle, (eyebrow || back) && styles.titleAfterEyebrow]}>{title}</Text>
      {subtitle ? <Text style={[text.muted, styles.subtitle]}>{subtitle}</Text> : null}
      {children ? <View style={styles.children}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingTop: space.xxl,
  },
  back: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    minHeight: 32,
  },
  pressed: {
    opacity: 0.6,
  },
  chevron: {
    width: 9,
    height: 9,
    borderLeftWidth: 1.5,
    borderBottomWidth: 1.5,
    borderColor: colors.muted,
    transform: [{ rotate: '45deg' }],
    marginLeft: 2,
    marginRight: space.sm,
  },
  backLabel: {
    ...text.caption,
    color: colors.muted,
  },
  eyebrowAfterBack: {
    marginTop: space.xl,
  },
  titleAfterEyebrow: {
    marginTop: space.sm,
  },
  subtitle: {
    marginTop: space.xs,
    maxWidth: 460,
  },
  children: {
    marginTop: space.xl,
  },
});
