import { Platform, StyleSheet } from 'react-native';

/**
 * Design tokens from CONTRACT.md. Every colour used in the app comes from here.
 */
export const colors = {
  paper: '#FFFFFF',
  paperDeep: '#F7F3EC',
  ink: '#14100C',
  muted: '#6E6259',
  faint: '#A2938A',
  copper: '#A65E22',
  hair: '#E6DED2',
} as const;

/** Spacing scale: 4, 8, 12, 16, 24, 32, 48. */
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

/** Display type is a serif. Body type stays on the system sans. */
export const displayFont = Platform.select({
  ios: 'Georgia',
  android: 'serif',
  default: 'Georgia',
});

export const layout = {
  maxWidth: 720,
  wideMaxWidth: 960,
  gutter: space.xl,
  radius: 2,
} as const;

/** Shared text styles. Screens compose these with spacing styles. */
export const text = StyleSheet.create({
  display: {
    fontFamily: displayFont,
    fontSize: 34,
    lineHeight: 42,
    letterSpacing: -0.4,
    color: colors.ink,
  },
  screenTitle: {
    fontFamily: displayFont,
    fontSize: 28,
    lineHeight: 35,
    letterSpacing: -0.2,
    color: colors.ink,
  },
  cardTitle: {
    fontFamily: displayFont,
    fontSize: 21,
    lineHeight: 28,
    color: colors.ink,
  },
  eyebrow: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '600',
    letterSpacing: 1.6,
    textTransform: 'uppercase',
    color: colors.copper,
  },
  sectionLabel: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '600',
    letterSpacing: 1.6,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  body: {
    fontSize: 16,
    lineHeight: 24,
    color: colors.ink,
  },
  bodySmall: {
    fontSize: 14,
    lineHeight: 21,
    color: colors.ink,
  },
  muted: {
    fontSize: 15,
    lineHeight: 22,
    color: colors.muted,
  },
  caption: {
    fontSize: 13,
    lineHeight: 19,
    color: colors.faint,
  },
  value: {
    fontSize: 15,
    lineHeight: 22,
    color: colors.ink,
  },
  buttonLabel: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '600',
    letterSpacing: 0.1,
  },
  tabLabel: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '500',
  },
});

/** Shared layout pieces. Keep screens consistent by using these. */
export const shared = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.paper,
  },
  frame: {
    width: '100%',
    maxWidth: layout.maxWidth,
    alignSelf: 'center',
  },
  frameWide: {
    width: '100%',
    maxWidth: layout.wideMaxWidth,
    alignSelf: 'center',
  },
  gutter: {
    paddingHorizontal: layout.gutter,
  },
  hairline: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.hair,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  scrollPadding: {
    paddingBottom: space.xxxl,
  },
});
