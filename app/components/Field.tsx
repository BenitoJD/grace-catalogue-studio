import { useState } from 'react';
import { Platform, StyleSheet, Text, TextInput, View, type TextStyle } from 'react-native';

import { colors, space, text } from '@/lib/theme';

/** Web only: remove the browser focus ring, the copper underline is the focus state. */
const webInputReset: TextStyle | undefined =
  Platform.OS === 'web' ? ({ outlineStyle: 'none' } as unknown as TextStyle) : undefined;

interface FieldProps {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
  maxLength?: number;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  autoCorrect?: boolean;
  secure?: boolean;
  accessibilityHint?: string;
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  multiline = false,
  maxLength,
  autoCapitalize = 'sentences',
  autoCorrect = false,
  secure = false,
  accessibilityHint,
}: FieldProps) {
  const [focused, setFocused] = useState(false);

  return (
    <View style={styles.wrap}>
      <Text style={[text.sectionLabel, styles.label]}>{label}</Text>
      <TextInput
        secureTextEntry={secure}
        accessibilityLabel={label}
        accessibilityHint={accessibilityHint}
        value={value}
        onChangeText={onChangeText}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        placeholderTextColor={colors.faint}
        selectionColor={colors.copper}
        cursorColor={colors.copper}
        multiline={multiline}
        maxLength={maxLength}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
        style={[
          styles.input,
          multiline && styles.inputMultiline,
          focused && styles.inputFocused,
          webInputReset,
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginBottom: space.xl,
  },
  label: {
    marginBottom: space.xs,
  },
  input: {
    minHeight: 44,
    paddingVertical: space.sm,
    paddingHorizontal: 0,
    fontSize: 16,
    lineHeight: 22,
    color: colors.ink,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.hair,
  },
  inputMultiline: {
    minHeight: 64,
    textAlignVertical: 'top',
  },
  inputFocused: {
    borderBottomColor: colors.copper,
  },
});
