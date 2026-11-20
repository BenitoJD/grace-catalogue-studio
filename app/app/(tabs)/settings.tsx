import Constants from 'expo-constants';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Screen } from '@/components/Screen';
import { API_BASE_URL } from '@/lib/api';
import { colors, layout, shared, space, text } from '@/lib/theme';

const APP_VERSION = Constants.expoConfig?.version ?? '1.0.0';
const SDK_VERSION = Constants.expoConfig?.sdkVersion ?? '58';
const PLATFORM_LABEL =
  Platform.select({ ios: 'iOS', android: 'Android', web: 'Web', default: 'Native' }) ?? 'Native';

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();

  return (
    <Screen>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, { paddingBottom: space.xxxl + insets.bottom }]}>
        <View style={shared.frame}>
          <View style={styles.header}>
            <Text style={text.eyebrow}>Grace Wood</Text>
            <Text style={[text.screenTitle, styles.title]}>Settings</Text>
            <Text style={[text.muted, styles.subtitle]}>Connection and app details.</Text>
          </View>

          <View style={[shared.hairline, styles.rule]} />

          <View style={styles.section}>
            <Text style={text.sectionLabel}>Connection</Text>
            <Text style={[text.caption, styles.label]}>API base URL</Text>
            <Text style={styles.url} selectable>
              {API_BASE_URL}
            </Text>
            <Text style={[text.caption, styles.hint]}>
              Set EXPO_PUBLIC_API_URL before building to point the app at another server.
            </Text>
          </View>

          <View style={[shared.hairline, styles.rule]} />

          <View style={styles.section}>
            <Text style={text.sectionLabel}>App</Text>
            <InfoRow label="Version" value={APP_VERSION} />
            <InfoRow label="Platform" value={PLATFORM_LABEL} />
            <InfoRow label="Expo SDK" value={SDK_VERSION} />
          </View>

          <View style={[shared.hairline, styles.rule]} />

          <View style={styles.section}>
            <Text style={text.sectionLabel}>About</Text>
            <Text style={[text.body, styles.aboutTitle]}>Grace Wood Industry, Nagercoil</Text>
            <Text style={[text.muted, styles.about]}>
              Grace Wood Industry builds custom wardrobes and furniture in Nagercoil, Tamil Nadu.
              Catalogue Studio is the internal tool for drafting orders and printing vouchers and
              material kits for the workshop.
            </Text>
            <Text style={[text.caption, styles.footer]}>Internal use · Grace Wood Industry</Text>
          </View>
        </View>
      </ScrollView>
    </Screen>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={text.muted}>{label}</Text>
      <Text style={[text.value, styles.infoValue]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: layout.gutter,
  },
  header: {
    paddingTop: space.xxl,
  },
  title: {
    marginTop: space.sm,
  },
  subtitle: {
    marginTop: space.xs,
  },
  rule: {
    marginTop: space.xl,
  },
  section: {
    paddingTop: space.xl,
  },
  label: {
    marginTop: space.lg,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  url: {
    marginTop: space.xs,
    fontSize: 15,
    lineHeight: 22,
    color: colors.ink,
  },
  hint: {
    marginTop: space.sm,
    maxWidth: 460,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.hair,
  },
  infoValue: {
    textAlign: 'right',
  },
  aboutTitle: {
    marginTop: space.lg,
  },
  about: {
    marginTop: space.sm,
    maxWidth: 520,
  },
  footer: {
    marginTop: space.xl,
  },
});
