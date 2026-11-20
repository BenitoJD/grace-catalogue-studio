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
          backgroundColor: colors.paper,
          borderTopColor: colors.hair,
          borderTopWidth: StyleSheet.hairlineWidth,
          height: 58 + insets.bottom,
          paddingTop: space.xs + 2,
          paddingBottom: insets.bottom,
        },
        tabBarLabelStyle: text.tabLabel,
        sceneStyle: { backgroundColor: colors.paper },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Orders',
          tabBarIcon: ({ color }) => <TabGlyph name="orders" color={color} />,
        }}
      />
      <Tabs.Screen
        name="materials"
        options={{
          title: 'Materials',
          tabBarIcon: ({ color }) => <TabGlyph name="materials" color={color} />,
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
