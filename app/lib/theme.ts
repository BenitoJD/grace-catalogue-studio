import { Platform, StyleSheet } from 'react-native';

/**
 * Apple inspired design tokens for the studio app.
 *
 * Neutral grouped surfaces, one brand tint, system typography. The printed
 * brochures keep their own editorial type: this file is only the application.
 */
export const colors = {
  /** Screen background, the iOS grouped grey. */
  background: '#F2F2F7',
  /** Card and sheet surfaces. */
  surface: '#FFFFFF',
  /** Slightly raised neutral fill, for fields and secondary buttons. */
  fill: '#EFEFF4',
  fillPressed: '#E5E5EA',
  /** Text. */
  ink: '#1C1C1E',
  muted: '#6E6E73',
  faint: '#8E8E93',
  /** Brand tint. */
  copper: '#A65E22',
  copperSoft: '#F4E7DA',
  /** Interactive tint fill used by secondary buttons and selected chips. */
  tintFill: '#EFEFF4',
  hair: '#DCDCE2',
  hairInset: 'rgba(60, 60, 67, 0.18)',
  danger: '#C0392B',
  success: '#2E7D4F',
  /** Legacy names kept so screens and components keep working. */
  paper: '#FFFFFF',
  paperDeep: '#F2F2F7',
  card: '#FFFFFF',
} as const;

/** Spacing scale: 4, 8, 12, 16, 20, 24, 32, 44. */
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
  xxxl: 44,
} as const;

/** The app uses the system UI font, like a native Apple application. */
export const systemFont = Platform.select({
  ios: 'System',
  android: 'sans-serif',
  web: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  default: 'system-ui',
}) as string;

/** Kept for places that still ask for the old display face. */
export const displayFont = systemFont;

export const layout = {
  maxWidth: 700,
  wideMaxWidth: 980,
  gutter: 20,
  radius: 14,
  radiusSmall: 10,
  radiusLarge: 20,
} as const;

/** Shared text styles. Apple sizes and weights. */
export const text = StyleSheet.create({
  display: {
    fontFamily: systemFont,
    fontSize: 34,
    lineHeight: 41,
    fontWeight: '700',
    letterSpacing: -0.4,
    color: colors.ink,
  },
  screenTitle: {
    fontFamily: systemFont,
    fontSize: 34,
    lineHeight: 41,
    fontWeight: '700',
    letterSpacing: -0.4,
    color: colors.ink,
  },
  cardTitle: {
    fontFamily: systemFont,
    fontSize: 17,
    lineHeight: 23,
    fontWeight: '600',
    letterSpacing: -0.2,
    color: colors.ink,
  },
  largeCardTitle: {
    fontFamily: systemFont,
    fontSize: 24,
    lineHeight: 30,
    fontWeight: '700',
    letterSpacing: -0.3,
    color: colors.ink,
  },
  eyebrow: {
    fontFamily: systemFont,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
    color: colors.faint,
  },
  sectionLabel: {
    fontFamily: systemFont,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '500',
    color: colors.muted,
  },
  body: {
    fontFamily: systemFont,
    fontSize: 16,
    lineHeight: 23,
    color: colors.ink,
  },
  bodySmall: {
    fontFamily: systemFont,
    fontSize: 15,
    lineHeight: 21,
    color: colors.ink,
  },
  muted: {
    fontFamily: systemFont,
    fontSize: 15,
    lineHeight: 21,
    color: colors.muted,
  },
  caption: {
    fontFamily: systemFont,
    fontSize: 13,
    lineHeight: 18,
    color: colors.faint,
  },
  value: {
    fontFamily: systemFont,
    fontSize: 15,
    lineHeight: 21,
    color: colors.ink,
  },
  buttonLabel: {
    fontFamily: systemFont,
    fontSize: 17,
    lineHeight: 22,
    fontWeight: '600',
    letterSpacing: -0.2,
  },
  tabLabel: {
    fontFamily: systemFont,
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '500',
  },
  metric: {
    fontFamily: systemFont,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '600',
    color: colors.ink,
  },
});

/** Shared layout pieces. */
export const shared = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
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
    backgroundColor: colors.hairInset,
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
  /** The default grouped card. */
  card: {
    backgroundColor: colors.surface,
    borderRadius: layout.radius,
    padding: space.lg,
  },
  cardLarge: {
    backgroundColor: colors.surface,
    borderRadius: layout.radiusLarge,
    padding: space.xl,
  },
});
