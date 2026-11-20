import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { colors, layout, space, text } from '@/lib/theme';

export function LoadingState({ label = 'Loading.' }: { label?: string }) {
  return (
    <View style={styles.loading} accessibilityRole="progressbar" accessibilityLabel={label}>
      <ActivityIndicator color={colors.copper} />
      <Text style={[text.caption, styles.loadingLabel]}>{label}</Text>
    </View>
  );
}

export function ErrorState({
  title = 'This part of the studio did not load',
  message,
  onRetry,
  retryLabel = 'Try again',
  retrying = false,
  children,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  retrying?: boolean;
  children?: ReactNode;
}) {
  return (
    <View style={styles.errorBox}>
      <Text style={text.eyebrow}>Problem</Text>
      <Text style={[text.cardTitle, styles.errorTitle]}>{title}</Text>
      <Text style={[text.muted, styles.errorMessage]}>{message}</Text>
      {onRetry ? (
        <View style={styles.errorAction}>
          <Button
            label={retryLabel}
            variant="secondary"
            onPress={onRetry}
            loading={retrying}
            loadingLabel="Trying again"
          />
        </View>
      ) : null}
      {children}
    </View>
  );
}

export function EmptyState({
  title,
  message,
  children,
}: {
  title: string;
  message: string;
  children?: ReactNode;
}) {
  return (
    <View style={styles.empty}>
      <Text style={text.cardTitle}>{title}</Text>
      <Text style={[text.muted, styles.emptyMessage]}>{message}</Text>
      {children ? <View style={styles.emptyAction}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  loading: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: space.xxxl,
  },
  loadingLabel: {
    marginTop: space.md,
  },
  errorBox: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
    borderRadius: layout.radius,
    padding: space.xl,
    marginTop: space.lg,
  },
  errorTitle: {
    marginTop: space.sm,
  },
  errorMessage: {
    marginTop: space.sm,
    maxWidth: 520,
  },
  errorAction: {
    marginTop: space.lg,
    alignSelf: 'flex-start',
  },
  empty: {
    paddingVertical: space.xxxl,
    maxWidth: 480,
  },
  emptyMessage: {
    marginTop: space.sm,
  },
  emptyAction: {
    marginTop: space.xl,
  },
});
