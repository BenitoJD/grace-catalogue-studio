import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { TabIcon, type TabIconName } from '@/components/TabIcon';
import { colors, space, text } from '@/lib/theme';

export interface AppTabBarProps {
  state: {
    index: number;
    routes: { key: string; name: string }[];
  };
  // Expo Router's tab view hands the bar a route key, not a navigator.
  navigateToTab: (routeKey: string) => void;
  insets?: { bottom?: number };
}

const TABS: Record<string, { label: string; icon: TabIconName }> = {
  index: { label: 'Chat', icon: 'chat' },
  orders: { label: 'History', icon: 'history' },
  settings: { label: 'Settings', icon: 'settings' },
};

/**
 * On phones and tablets this is a normal full width tab bar. On a wide window
 * it becomes a floating dock, the way a desktop app should feel, so the app
 * does not look like a stretched phone screen.
 */
export function AppTabBar({ state, navigateToTab }: AppTabBarProps) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const floating = width >= 720;
  const [hovered, setHovered] = useState<string | null>(null);

  // Desktop app muscle memory: Alt + 1, 2, 3 move between the three tabs.
  // Ctrl and Cmd with a number belong to the operating system and browser.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.metaKey || event.ctrlKey) return;
      const index = ['1', '2', '3'].indexOf(event.key);
      if (index < 0) return;
      const route = state.routes[index];
      if (!route) return;
      event.preventDefault();
      navigateToTab(route.key);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigateToTab, state.routes]);

  return (
    <View
      style={[
        styles.wrap,
        floating
          ? { backgroundColor: '#FFFFFF', paddingBottom: Math.max(insets.bottom, space.md), paddingTop: 6 }
          : {
              backgroundColor: colors.surface,
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: colors.hair,
              paddingBottom: Math.max(insets.bottom, 6),
              paddingTop: 6,
            },
      ]}>
      <View style={[styles.bar, floating ? styles.dock : styles.full]}>
        {state.routes.map((route, index) => {
          const tab = TABS[route.name];
          if (!tab) return null;
          const active = state.index === index;
          const hovering = hovered === route.key;
          return (
            <Pressable
              key={route.key}
              accessibilityRole="tab"
              accessibilityLabel={tab.label}
              accessibilityState={{ selected: active }}
              onHoverIn={() => setHovered(route.key)}
              onHoverOut={() => setHovered(null)}
              onPress={() => {
                if (!active) navigateToTab(route.key);
              }}
              style={({ pressed }) => [
                styles.tab,
                active && styles.tabActive,
                !active && hovering && styles.tabHover,
                pressed && styles.tabPressed,
              ]}>
              <TabIcon name={tab.icon} color={active ? colors.ink : colors.muted} size={floating ? 19 : 23} />
              <Text style={[text.tabLabel, styles.label, active && styles.labelActive]}>
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 4,
  },
  full: {
    width: '100%',
    paddingHorizontal: space.sm,
  },
  dock: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#FFFFFF',
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
    padding: 6,
    marginHorizontal: space.lg,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  tab: {
    flex: 1,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  tabActive: {
    backgroundColor: '#F4F4F4',
  },
  tabHover: {
    backgroundColor: colors.fill,
  },
  tabPressed: {
    opacity: 0.72,
  },
  label: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '500',
    letterSpacing: 0.1,
  },
  labelActive: {
    color: colors.ink,
    fontWeight: '600',
  },
});
