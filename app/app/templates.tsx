import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { ScreenHeader } from '@/components/ScreenHeader';
import { ErrorState, LoadingState } from '@/components/StateViews';
import { api, errorMessage, fileUrl, type DesignReference } from '@/lib/api';
import { colors, layout, shared, space, text } from '@/lib/theme';

const GRID_GAP = space.md;
const POLL_MS = 4000;

const ORNAMENT_GLYPH: Record<string, string> = {
  jaali: '❖',
  paisley: '❧',
  lotus: '✿',
  rangoli: '✦',
  arch: '⌒',
  none: '',
};

export default function DesignReferencesScreen() {
  const { orderId, reference } = useLocalSearchParams<{ orderId?: string; reference?: string }>();
  const { width } = useWindowDimensions();
  const [designs, setDesigns] = useState<DesignReference[]>([]);
  const [expected, setExpected] = useState(100);
  const [building, setBuilding] = useState(false);
  const [previewsReady, setPreviewsReady] = useState(0);
  const [previewsTotal, setPreviewsTotal] = useState(100);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>(reference ?? '');
  const activeRef = useRef(true);

  const columns = width >= 1180 ? 5 : width >= 920 ? 4 : width >= 640 ? 3 : 2;
  const frameWidth = Math.min(width, layout.wideMaxWidth);
  const gridWidth = Math.max(frameWidth - layout.gutter * 2, 280);
  const tileWidth = Math.floor((gridWidth - GRID_GAP * (columns - 1)) / columns);

  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    try {
      const library = await api.listDesigns();
      if (!activeRef.current) return;
      setDesigns(library.designs);
      setExpected(library.expected);
      setBuilding(library.building);
      setPreviewsReady(library.previewsReady ?? 0);
      setPreviewsTotal(library.previewsTotal ?? library.expected ?? 100);
      setLoadError(null);
    } catch (error) {
      if (activeRef.current) {
        setLoadError(errorMessage(error, 'The design references could not be prepared.'));
        setBuilding(false);
      }
    } finally {
      if (activeRef.current && initial) setLoading(false);
    }
  }, []);

  // The gallery starts in the loading state, then subscribes to the library
  // while the model writes it. Polling is the external system here.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    activeRef.current = true;
    void load(true);
    const timer = setInterval(() => {
      if (activeRef.current) void load(false);
    }, POLL_MS);
    return () => {
      activeRef.current = false;
      clearInterval(timer);
    };
  }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const chosen = useMemo(
    () => designs.find((design) => design.id === selected) ?? null,
    [designs, selected]
  );

  const finish = useCallback(
    (referenceId: string) => {
      if (!orderId) {
        router.replace('/');
        return;
      }
      const name = designs.find((design) => design.id === referenceId)?.name ?? '';
      router.replace({
        pathname: '/orders/[id]',
        params: { id: orderId, reference: referenceId, referenceName: name },
      });
    },
    [designs, orderId]
  );

  const header = (
    <View style={styles.header}>
      <ScreenHeader
        back
        onBack={() => {
          if (orderId) {
            router.replace({ pathname: '/orders/[id]', params: { id: orderId } });
          } else {
            router.replace('/');
          }
        }}
        eyebrow="Design references"
        title="One hundred looks"
        subtitle="A feel, not a layout. Pick a reference and the model composes the brochure for your order in that spirit."
      />
      <View style={[shared.hairline, styles.rule]} />
    </View>
  );

  const progress =
    designs.length > 0 && designs.length < expected ? (
      <View style={styles.progressCard}>
        <View style={styles.progressTop}>
          <Text style={text.sectionLabel}>Writing the library</Text>
          <Text style={text.caption}>
            {designs.length} / {expected}
          </Text>
        </View>
        <View style={styles.progressTrack}>
          <View
            style={[
              styles.progressFill,
              { width: `${Math.max(2, Math.round((designs.length / expected) * 100))}%` },
            ]}
          />
        </View>
        <Text style={[text.caption, styles.progressHint]}>
          The model is designing the references as you read. New looks appear every few seconds.
        </Text>
      </View>
    ) : null;

  const previewProgress =
    designs.length >= expected && previewsReady < previewsTotal ? (
      <View style={styles.progressCard}>
        <View style={styles.progressTop}>
          <Text style={text.sectionLabel}>Printing the previews</Text>
          <Text style={text.caption}>
            {previewsReady} / {previewsTotal}
          </Text>
        </View>
        <View style={styles.progressTrack}>
          <View
            style={[
              styles.progressFill,
              { width: `${Math.max(2, Math.round((previewsReady / previewsTotal) * 100))}%` },
            ]}
          />
        </View>
        <Text style={[text.caption, styles.progressHint]}>
          Each look is proving itself on a real four page brochure. Printed covers appear in the
          gallery as they pass every check.
        </Text>
      </View>
    ) : null;

  return (
    <Screen>
      <View style={styles.fill}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[styles.scroll, { paddingBottom: space.xxl }]}>
          <View style={[shared.frame, styles.page]}>
            {header}

            {loading && designs.length === 0 ? <LoadingState label="Preparing the reference library." /> : null}

            {!loading && loadError && designs.length === 0 ? (
              <ErrorState
                title="The references are not ready"
                message={loadError}
                onRetry={() => {
                  void load(true);
                }}
                retrying={loading}
              />
            ) : null}

            {designs.length > 0 ? (
              <>
                {progress}
                {previewProgress}

                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Let the model decide the look"
                  onPress={() => {
                    setSelected('');
                    finish('');
                  }}
                  style={({ pressed }) => [
                    styles.modelCard,
                    !selected && styles.modelCardSelected,
                    pressed && styles.pressed,
                  ]}>
                  <View style={styles.modelGlyph}>
                    <Text style={styles.modelGlyphLabel}>AI</Text>
                  </View>
                  <View style={styles.modelText}>
                    <Text style={styles.modelTitle}>Let the model decide</Text>
                    <Text style={[text.muted, styles.modelBody]}>
                      No reference. The mood is chosen from the room, the photographs and the finish
                      samples.
                    </Text>
                  </View>
                  <Text style={styles.modelAction}>{selected ? 'Use' : 'Using'}</Text>
                </Pressable>

                <View style={styles.gridHeading}>
                  <Text style={text.sectionLabel}>The library</Text>
                  <Text style={text.caption}>
                    {designs.length} {designs.length === 1 ? 'look' : 'looks'}
                  </Text>
                </View>

                <View style={styles.grid}>
                  {designs.map((design) => (
                    <ReferenceTile
                      key={design.id}
                      design={design}
                      width={tileWidth}
                      selected={selected === design.id}
                      onPress={() => setSelected(design.id)}
                    />
                  ))}
                </View>
              </>
            ) : null}

            {building && designs.length === 0 && !loading && !loadError ? (
              <LoadingState label="The model is writing the first references." />
            ) : null}
          </View>
        </ScrollView>

        {designs.length > 0 ? (
          <View style={[styles.actionBar, { paddingBottom: space.md }]}>
            <View style={[shared.hairline, styles.actionRule]} />
            <View style={styles.actionInner}>
              <View style={styles.actionText}>
                <Text style={styles.actionLabel}>Selected reference</Text>
                <Text style={[text.caption, styles.actionName]} numberOfLines={1}>
                  {chosen ? chosen.name : 'Model decides'}
                </Text>
              </View>
              <Button
                label={chosen ? 'Use this look' : 'Use the model choice'}
                onPress={() => finish(chosen ? chosen.id : '')}
              />
            </View>
          </View>
        ) : null}
      </View>
    </Screen>
  );
}

function ReferenceTile({
  design,
  width,
  selected,
  onPress,
}: {
  design: DesignReference;
  width: number;
  selected: boolean;
  onPress: () => void;
}) {
  const palette = design.palette;
  const glyph = ORNAMENT_GLYPH[design.ornament] ?? '';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${design.name}${selected ? ', selected' : ''}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.tile,
        { width },
        selected && styles.tileSelected,
        pressed && styles.pressed,
      ]}>
      {design.previewUrl ? (
        <Image
          source={{ uri: fileUrl(design.previewUrl) }}
          style={[
            styles.canvas,
            styles.canvasImage,
            { width: width - 12, height: (width - 12) * 1.1 },
          ]}
          resizeMode="cover"
          accessibilityLabel={`Printed preview of ${design.name}`}
        />
      ) : (
        <View
          style={[
            styles.canvas,
            { width: width - 12, height: (width - 12) * 0.92, backgroundColor: palette.paper },
          ]}>
          <View style={[styles.canvasBand, { backgroundColor: palette.accent }]} />
        <Text
          style={[styles.canvasTitle, { color: palette.deep }]}
          numberOfLines={3}
          ellipsizeMode="tail">
          {design.name}
        </Text>
        <Text style={[styles.canvasMood, { color: palette.muted }]} numberOfLines={2}>
          {design.mood}
        </Text>
          <View style={styles.canvasFooter}>
            <View style={styles.swatches}>
              {[palette.accent, palette.deep, palette.gold, palette.ink].map((colour) => (
                <View key={colour} style={[styles.swatch, { backgroundColor: colour }]} />
              ))}
            </View>
            {glyph ? (
              <Text style={[styles.ornament, { color: palette.gold }]}>{glyph}</Text>
            ) : null}
          </View>
        </View>
      )}
      <View style={styles.readyBadge}>
        <Text style={styles.readyBadgeLabel}>
          {design.previewUrl ? 'Printed preview' : 'Direction only'}
        </Text>
      </View>
      <View style={styles.tileText}>
        <Text style={[text.value, styles.tileName]} numberOfLines={1}>
          {design.name}
        </Text>
        <Text style={[text.caption, styles.tileCaption]} numberOfLines={1}>
          {selected ? 'Selected' : `${design.family} · ${design.displayFont}`}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    minHeight: 0,
  },
  scroll: {
    flexGrow: 1,
  },
  page: {
    paddingTop: space.lg,
  },
  header: {
    gap: space.md,
    paddingBottom: space.sm,
  },
  rule: {
    marginTop: space.sm,
  },
  progressCard: {
    backgroundColor: colors.surface,
    borderRadius: layout.radius,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
    padding: space.lg,
    gap: space.sm,
    marginBottom: space.lg,
  },
  progressTop: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  progressTrack: {
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.fill,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: colors.copper,
  },
  progressHint: {
    color: colors.faint,
  },
  modelCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.surface,
    borderRadius: layout.radius,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
    padding: space.lg,
    marginBottom: space.lg,
  },
  modelCardSelected: {
    borderWidth: 2,
    borderColor: colors.copper,
    backgroundColor: colors.copperSoft,
  },
  modelGlyph: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.copperSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modelGlyphLabel: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1,
    color: colors.copper,
  },
  modelText: {
    flex: 1,
    gap: 2,
  },
  modelTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.ink,
  },
  modelBody: {
    fontSize: 13,
    lineHeight: 18,
  },
  modelAction: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.copper,
  },
  gridHeading: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginBottom: space.md,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: GRID_GAP,
  },
  tile: {
    backgroundColor: colors.surface,
    borderRadius: layout.radius,
    padding: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
  },
  tileSelected: {
    borderWidth: 2,
    borderColor: colors.copper,
  },
  pressed: {
    opacity: 0.86,
  },
  canvas: {
    borderRadius: 8,
    padding: 12,
    justifyContent: 'space-between',
    overflow: 'hidden',
  },
  canvasImage: {
    padding: 0,
    backgroundColor: colors.fill,
  },
  readyBadge: {
    alignSelf: 'flex-start',
    marginTop: 6,
    marginLeft: 6,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: colors.fill,
  },
  readyBadgeLabel: {
    fontSize: 9,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: colors.faint,
  },
  canvasBand: {
    width: 30,
    height: 3,
    borderRadius: 2,
  },
  canvasTitle: {
    fontSize: 19,
    lineHeight: 22,
    fontWeight: '500',
    letterSpacing: -0.3,
    marginTop: space.md,
    flex: 1,
  },
  canvasMood: {
    fontSize: 10,
    lineHeight: 14,
    textTransform: 'uppercase',
    letterSpacing: 1.1,
  },
  canvasFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space.sm,
  },
  swatches: {
    flexDirection: 'row',
    gap: 4,
  },
  swatch: {
    width: 9,
    height: 9,
    borderRadius: 5,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,0,0,0.2)',
  },
  ornament: {
    fontSize: 16,
    lineHeight: 18,
  },
  tileText: {
    paddingHorizontal: 6,
    paddingTop: 6,
    paddingBottom: 2,
    gap: 1,
  },
  tileName: {
    fontWeight: '600',
    fontSize: 13,
  },
  tileCaption: {
    color: colors.faint,
  },
  actionBar: {
    backgroundColor: colors.background,
  },
  actionRule: {
    marginBottom: space.sm,
  },
  actionInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    maxWidth: layout.wideMaxWidth,
    width: '100%',
    alignSelf: 'center',
    paddingHorizontal: layout.gutter,
  },
  actionText: {
    flex: 1,
    gap: 1,
  },
  actionLabel: {
    fontSize: 11,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: colors.faint,
  },
  actionName: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '500',
  },
});
