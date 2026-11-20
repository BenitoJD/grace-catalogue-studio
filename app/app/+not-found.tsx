import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { shared, space, text } from '@/lib/theme';

export default function NotFoundScreen() {
  return (
    <Screen>
      <View style={styles.page}>
        <View style={shared.hairline} />
        <Text style={[text.eyebrow, styles.eyebrow]}>Not found</Text>
        <Text style={[text.display, styles.title]}>This page is not in the studio.</Text>
        <Text style={[text.muted, styles.body]}>
          Check the address, or go back to the order book.
        </Text>
        <View style={styles.action}>
          <Button
            label="Go to orders"
            onPress={() => {
              router.replace('/');
            }}
          />
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
  },
  eyebrow: {
    marginTop: space.xl,
  },
  title: {
    marginTop: space.sm,
  },
  body: {
    marginTop: space.md,
    maxWidth: 420,
  },
  action: {
    marginTop: space.xl,
    alignSelf: 'flex-start',
  },
});
