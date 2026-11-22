import { StyleSheet, Text } from 'react-native';

import { colors } from '@/lib/theme';

/** The brand line in Tamil, printed under the English wordmark. */
export function TamilLine() {
  return (
    <Text style={styles.line} accessibilityLanguage="ta">
      கிரேஸ் வூட் இண்டஸ்ட்ரி
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
