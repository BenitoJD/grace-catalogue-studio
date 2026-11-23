import { StyleSheet, Text } from 'react-native';

import { colors } from '@/lib/theme';

/** The brand line in Tamil, printed under the English wordmark. */
export function TamilLine() {
  return (
    <Text style={styles.line} accessibilityLanguage="ta">
      ஜேக்கப் டிசைன் ஸ்டுடியோ
    </Text>
  );
}

const styles = StyleSheet.create({
  line: {
    marginTop: 2,
    fontSize: 12,
    lineHeight: 18,
    color: colors.faint,
  },
});
