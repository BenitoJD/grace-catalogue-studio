import { Tabs } from 'expo-router';
import { StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { TabGlyph } from '@/components/TabGlyph';
import { colors, space, text } from '@/lib/theme';

export default function TabLayout() {
  const insets = useSafeAreaInsets();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.copper,
        tabBarInactiveTintColor: colors.faint,
        tabBarStyle: {
          backgroundColor: 'rgba(255, 255, 255, 0.96)',
          borderTopColor: colors.hairInset,
          borderTopWidth: StyleSheet.hairlineWidth,
          height: 60 + insets.bottom,
          paddingTop: space.sm,
          paddingBottom: insets.bottom,
          elevation: 0,
        },
        tabBarLabelStyle: text.tabLabel,
        tabBarItemStyle: { gap: 2 },
        sceneStyle: { backgroundColor: colors.background },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Chat',
          tabBarIcon: ({ color }) => <TabGlyph name="chat" color={color} />,
        }}
      />
      <Tabs.Screen
        name="orders"
        options={{
          title: 'History',
          tabBarIcon: ({ color }) => <TabGlyph name="orders" color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color }) => <TabGlyph name="settings" color={color} />,
        }}
      />
    </Tabs>
  );
}
