import type { ReactNode } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

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
 * Native feeling screen header: a large bold title, a quiet subtitle and a
 * copper back control. The chevron is drawn with hairlines so no icon font is
 * needed on any platform.
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
      <View style={[styles.titleRow, (eyebrow || back) && styles.titleAfterEyebrow]}>
        <Image
          source={require('@/assets/images/logo.png')}
          style={styles.mark}
          resizeMode="contain"
          accessibilityLabel="Grace Wood Industry"
        />
        <Text style={[text.screenTitle, styles.titleText]}>{title}</Text>
      </View>
      {subtitle ? <Text style={[text.muted, styles.subtitle]}>{subtitle}</Text> : null}
      {children ? <View style={styles.children}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingTop: space.xl,
  },
  back: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    minHeight: 32,
  },
  pressed: {
    opacity: 0.55,
  },
  chevron: {
    width: 9,
    height: 9,
    borderLeftWidth: 2,
    borderBottomWidth: 2,
    borderColor: colors.copper,
    transform: [{ rotate: '45deg' }],
    marginLeft: 2,
    marginRight: 6,
  },
  backLabel: {
    ...text.caption,
    fontSize: 16,
    color: colors.copper,
  },
  eyebrowAfterBack: {
    marginTop: space.md,
  },
  titleAfterEyebrow: {
    marginTop: 2,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  titleText: {
    flexShrink: 1,
  },
  mark: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
    flexShrink: 0,
  },
  subtitle: {
    marginTop: 4,
    maxWidth: 520,
  },
  children: {
    marginTop: space.lg,
  },
});
