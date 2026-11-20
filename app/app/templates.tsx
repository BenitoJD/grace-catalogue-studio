import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { ScreenHeader } from '@/components/ScreenHeader';
import { ErrorState, LoadingState } from '@/components/StateViews';
import { api, errorMessage, fileUrl, type Template } from '@/lib/api';
import { colors, layout, shared, space, text } from '@/lib/theme';

const PAGE_ASPECT = 1123 / 794;
const GRID_GAP = space.lg;

export default function TemplatesScreen() {
  const { orderId, selected } = useLocalSearchParams<{ orderId?: string; selected?: string }>();
  const { width } = useWindowDimensions();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const columns = width >= 1100 ? 5 : width >= 820 ? 4 : width >= 560 ? 3 : 2;
  const frameWidth = Math.min(width, layout.wideMaxWidth);
  const gridWidth = Math.max(frameWidth - layout.gutter * 2, 260);
  const tileWidth = Math.floor((gridWidth - GRID_GAP * (columns - 1)) / columns);

  const load = useCallback(async () => {
    try {
      const next = await api.listTemplates();
      setTemplates(next);
    } catch (error) {
      setLoadError(errorMessage(error, 'The designs could not be loaded. Try again.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // First load on mount, the screen starts in the loading state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const choose = useCallback(
    (templateId: string) => {
      if (!orderId) {
        router.replace('/');
        return;
      }
      router.replace({ pathname: '/orders/[id]', params: { id: orderId, templateId } });
    },
    [orderId]
  );

  const header = useMemo(
    () => (
      <View style={styles.header}>
        <ScreenHeader
          title="Designs"
          subtitle="Pick the cover. The specification and finish pages stay the same."
          onBack={() => {
            if (orderId) {
              router.replace({ pathname: '/orders/[id]', params: { id: orderId } });
            } else {
              router.replace('/');
            }
          }}
        />
        <View style={[shared.hairline, styles.rule]} />
        <View style={styles.gridHeading}>
          <Text style={text.sectionLabel}>Cover designs</Text>
          {templates.length > 0 ? <Text style={text.caption}>{templates.length} designs</Text> : null}
        </View>
        {loading && templates.length === 0 ? <LoadingState label="Loading designs." /> : null}
        {loadError ? (
          <ErrorState
            title="Cannot load the designs"
            message={loadError}
            onRetry={() => {
              setLoading(true);
              void load();
            }}
          />
        ) : null}
      </View>
    ),
    [loadError, loading, load, orderId, templates.length]
  );

  return (
    <Screen>
      <View style={shared.frameWide}>
        <FlatList
          key={`templates-${columns}`}
          data={templates}
          keyExtractor={(item) => item.id}
          numColumns={columns}
          ListHeaderComponent={header}
          columnWrapperStyle={columns > 1 ? styles.column : undefined}
          contentContainerStyle={styles.content}
          renderItem={({ item }) => (
            <TemplateTile
              template={item}
              width={tileWidth}
              selected={selected === item.id}
              onPress={() => {
                choose(item.id);
              }}
            />
          )}
          ListFooterComponent={
            <View style={styles.footer}>
              <Button
                label="Back to the order"
                variant="secondary"
                onPress={() => {
                  if (orderId) {
                    router.replace({ pathname: '/orders/[id]', params: { id: orderId } });
                  } else {
                    router.replace('/');
                  }
                }}
              />
            </View>
          }
        />
      </View>
    </Screen>
  );
}

function TemplateTile({
  template,
  width,
  selected,
  onPress,
}: {
  template: Template;
  width: number;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${template.name}${selected ? ', selected' : ''}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.tile,
        { width },
        selected && styles.tileSelected,
        pressed && styles.tilePressed,
      ]}>
      <Image
        source={{ uri: fileUrl(template.previewUrl) }}
        style={[styles.preview, { width: width - 2, height: (width - 2) * PAGE_ASPECT }]}
        resizeMode="cover"
      />
      <View style={styles.tileText}>
        <Text style={[text.value, styles.tileName]} numberOfLines={1}>
          {template.name}
        </Text>
        <Text style={text.caption}>{selected ? 'Selected' : template.cover.replace(/([a-z])([A-Z])/g, '$1 $2')}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingBottom: space.xxl,
  },
  header: {
    gap: space.md,
    paddingBottom: space.lg,
  },
  rule: {
    marginTop: space.sm,
  },
  gridHeading: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginTop: space.sm,
  },
  column: {
    gap: GRID_GAP,
    marginBottom: GRID_GAP,
  },
  tile: {
    borderWidth: 1,
    borderColor: colors.hair,
    backgroundColor: colors.paper,
  },
  tileSelected: {
    borderColor: colors.copper,
    borderWidth: 2,
  },
  tilePressed: {
    opacity: 0.85,
  },
  preview: {
    backgroundColor: colors.paperDeep,
  },
  tileText: {
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    gap: 2,
  },
  tileName: {
    fontWeight: '600',
  },
  footer: {
    paddingTop: space.xl,
  },
});
