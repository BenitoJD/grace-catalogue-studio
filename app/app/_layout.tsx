import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { BootstrapProvider } from '@/lib/bootstrap';
import { colors } from '@/lib/theme';

export { ErrorBoundary } from 'expo-router';

export default function RootLayout() {
  return (
    <BootstrapProvider>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.paper },
        }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="orders/new" />
        <Stack.Screen name="orders/[id]" />
      </Stack>
    </BootstrapProvider>
  );
}
