import { Stack } from 'expo-router';
import type { ErrorBoundaryProps } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { BootstrapProvider } from '@/lib/bootstrap';
import { colors, layout, space, text } from '@/lib/theme';

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return (
    <View style={styles.errorPage}>
      <Text style={text.eyebrow}>Grace Studio</Text>
      <Text style={[text.display, styles.errorTitle]}>Something broke on this screen</Text>
      <Text style={[text.muted, styles.errorBody]}>
        The rest of the app is fine. Try again, and if it happens twice, close the app and reopen it.
      </Text>
      <Text style={[text.caption, styles.errorDetail]} numberOfLines={4}>
        {error.message}
      </Text>
      <View style={styles.errorAction}>
        <Button label="Try again" onPress={() => void retry()} />
      </View>
    </View>
  );
}

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
        <Stack.Screen name="templates" />
      </Stack>
    </BootstrapProvider>
  );
}

const styles = StyleSheet.create({
  errorPage: {
    flex: 1,
    backgroundColor: colors.paper,
    padding: layout.gutter,
    gap: space.md,
    justifyContent: 'center',
    maxWidth: 620,
    width: '100%',
    alignSelf: 'center',
  },
  errorTitle: {
    marginTop: space.xs,
  },
  errorBody: {
    maxWidth: 460,
  },
  errorDetail: {
    color: colors.faint,
  },
  errorAction: {
    marginTop: space.md,
    alignSelf: 'flex-start',
  },
});
