import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { Screen } from '@/components/Screen';
import { ErrorState, LoadingState } from '@/components/StateViews';
import { openUrl, shareLink } from '@/lib/actions';
import { copyText } from '@/lib/clipboard';
import {
  api,
  errorMessage,
  fileUrl,
  type Order,
  type OrderNote,
  type OrderPalette,
  type Render,
} from '@/lib/api';
import { displayValue, formatDateTime, pageCountLabel, statusLabel } from '@/lib/format';
import { colors, layout, shared, space, text } from '@/lib/theme';

const PAGE_ASPECT = 794 / 1123;

const SPEC_SECTIONS: {
  title: string;
  rows: { label: string; value: (order: Order) => string }[];
}[] = [
  {
    title: 'Order',
    rows: [
      { label: 'Order number', value: (order) => order.orderNo },
      { label: 'Customer', value: (order) => displayValue(order.customerName) },
      { label: 'Room', value: (order) => displayValue(order.room) },
      { label: 'Status', value: (order) => statusLabel(order.status) },
      {
        label: 'Created',
        value: (order) => formatDateTime(order.createdAt) || 'Not set',
      },
    ],
  },
];

function OrderTopBar({
  onBack,
  eyebrow,
  title,
  subtitle,
}: {
  onBack: () => void;
  eyebrow: string;
  title: string;
  subtitle?: string;
}) {
  return (
    <View style={styles.newHeader}>
      <View style={styles.newHeaderTop}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={onBack}
          style={({ pressed }) => [styles.newBack, pressed && styles.newPressed]}>
          <Text style={styles.newBackLabel}>‹ Back</Text>
        </Pressable>
        <View style={styles.newBrand}>
          <Image
            source={require('@/assets/images/logo.png')}
            style={styles.newBrandMark}
            resizeMode="contain"
            accessibilityLabel="Jacob Design Studio"
          />
          <Text style={styles.newBrandName}>Jacob Studio</Text>
        </View>
      </View>
      <Text style={styles.newEyebrow}>{eyebrow}</Text>
      <Text style={styles.newTitle} numberOfLines={2}>
        {title}
      </Text>
      {subtitle ? <Text style={styles.newSubtitle}>{subtitle}</Text> : null}
    </View>
  );
}

export default function OrderDetailScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const orderId = id;
  const insets = useSafeAreaInsets();

  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [render, setRender] = useState<Render | null>(null);
  const [palettes, setPalettes] = useState<OrderPalette[]>([]);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const [direction, setDirection] = useState('');
  const [outputFormat, setOutputFormat] = useState<'pamphlet' | 'brochure'>('pamphlet');
  const [designLoading, setDesignLoading] = useState(false);
  const [designError, setDesignError] = useState<string | null>(null);
  const [designStatus, setDesignStatus] = useState<string | null>(null);
  const [kitRender, setKitRender] = useState<Render | null>(null);
  const [kitLoading, setKitLoading] = useState(false);
  const [kitError, setKitError] = useState<string | null>(null);
  const [note, setNote] = useState<OrderNote | null>(null);
  const [noteLoading, setNoteLoading] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [noteStatus, setNoteStatus] = useState<string | null>(null);

  useEffect(() => {
    if (order?.designFormat) setOutputFormat(order.designFormat);
  }, [order?.designFormat]);

  const loadPalettes = useCallback(async () => {
    if (!orderId) return;
    try {
      const result = await api.orderPalettes(orderId);
      setPalettes(result.palettes ?? []);
    } catch {
      // A missing palette is not an error; the brochure still has the pictures.
    }
  }, [orderId]);

  const loadOrder = useCallback(async () => {
    if (!orderId) {
      setLoading(false);
      setLoadError('This order link is missing an id. Go back to the order book.');
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const next = await api.getOrder(orderId);
      setOrder(next);
      setDirection(next.designDirection ?? '');
      void loadPalettes();
    } catch (fetchError) {
      setLoadError(errorMessage(fetchError, 'The order could not be loaded. Try again.'));
    } finally {
      setLoading(false);
    }
  }, [loadPalettes, orderId]);

  const loadLatestRender = useCallback(async () => {
    if (!orderId) return;
    try {
      const all = await api.listRenders();
      const mine = all
        .filter((candidate) => candidate.orderId === orderId && candidate.kind === 'ai')
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      if (mine.length > 0) {
        setRender(mine[0]);
      }
    } catch {
      // No previous brochure is not an error.
    }
  }, [orderId]);

  // The loading state is the initial state, so the first paint is already
  // correct; the effect only fills it.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    void loadOrder();
    void loadLatestRender();
  }, [loadOrder, loadLatestRender]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const goBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/');
  }, []);

  const designBrochure = useCallback(async () => {
    if (!orderId || designLoading) return;
    setDesignLoading(true);
    setDesignError(null);
    setDesignStatus(null);
    setShareStatus(null);
    try {
      const result = await api.aiBrochure(orderId, { direction, format: outputFormat });
      setRender(result.render);
      setOrder((current) =>
        current
          ? { ...current, copy: result.copy, designDirection: result.direction ?? direction }
          : current
      );
      setDesignStatus('The brochure was designed and printed.');
    } catch (error) {
      setDesignError(errorMessage(error, 'The model could not design this brochure. Check the settings.'));
    } finally {
      setDesignLoading(false);
    }
  }, [designLoading, direction, orderId, outputFormat]);

  const draftNote = useCallback(async () => {
    if (!orderId || noteLoading) return;
    setNoteLoading(true);
    setNoteError(null);
    setNoteStatus(null);
    try {
      const next = await api.draftOrderNote(orderId);
      setNote(next);
    } catch (error) {
      setNoteError(errorMessage(error, 'The note could not be drafted. Check the model settings.'));
    } finally {
      setNoteLoading(false);
    }
  }, [noteLoading, orderId]);

  const renderKit = useCallback(async () => {
    if (!orderId || kitLoading) return;
    setKitLoading(true);
    setKitError(null);
    try {
      const next = await api.renderOrder(orderId, 'kit');
      setKitRender(next);
    } catch (error) {
      setKitError(errorMessage(error, 'The info kit could not be rendered. Try again.'));
    } finally {
      setKitLoading(false);
    }
  }, [kitLoading, orderId]);

  const copyNote = useCallback(async () => {
    if (!note) return;
    const ok = await copyText(note.note);
    setNoteStatus(ok ? 'Note copied to the clipboard.' : 'Could not copy. Select the text and copy it by hand.');
  }, [note]);

  const pdfUrl = render ? fileUrl(render.pdfUrl) : null;

  const handleShare = useCallback(async () => {
    if (!render || !order) return;
    setShareStatus(null);
    const outcome = await shareLink({
      title: `Brochure ${order.orderNo}`,
      message: `${order.title}, ${order.customerName}`,
      url: fileUrl(render.pdfUrl),
    });
    if (outcome === 'copied') setShareStatus('Link copied to the clipboard.');
    else if (outcome === 'shared') setShareStatus('Brochure link shared.');
    else if (outcome === 'dismissed') setShareStatus('Sharing cancelled.');
    else if (outcome === 'unavailable') setShareStatus('Sharing is not available here. Open the PDF and share it from there.');
  }, [order, render]);

  return (
    <Screen>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.scroll, { paddingBottom: space.xxxl + insets.bottom }]}>
        <View style={[shared.frame, styles.page]}>
          {loading ? (
            <>
              <OrderTopBar onBack={goBack} eyebrow="Order" title="Loading order" />
              <LoadingState label="Loading the order." />
            </>
          ) : null}

          {!loading && loadError ? (
            <>
              <OrderTopBar onBack={goBack} eyebrow="Order" title="Order unavailable" />
              <ErrorState
                title="Cannot load this order"
                message={loadError}
                onRetry={() => {
                  void loadOrder();
                }}
              />
            </>
          ) : null}

          {!loading && order ? (
            <>
              <OrderTopBar
                onBack={goBack}
                eyebrow={order.orderNo}
                title={order.title || 'Untitled order'}
                subtitle={`${displayValue(order.customerName)} · ${displayValue(order.room)} · ${statusLabel(order.status)}`}
              />

              {SPEC_SECTIONS.map((section) => (
                <View key={section.title} style={styles.specSection}>
                  <Text style={[text.sectionLabel, styles.specHeading]}>{section.title}</Text>
                  {section.rows.map((row) => {
                    const value = row.value(order);
                    const empty = value === 'Not set';
                    return (
                      <View key={row.label} style={styles.specRow}>
                        <Text style={[text.caption, styles.specLabel]}>{row.label}</Text>
                        <Text style={[text.value, styles.specValue, empty && styles.specValueEmpty]}>
                          {value}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              ))}

              <View style={styles.section}>
                <View style={shared.rowBetween}>
                  <Text style={text.sectionLabel}>Brochure</Text>
                  {render ? <Text style={text.caption}>{pageCountLabel(render.pageCount)}</Text> : null}
                </View>
                <Text style={[text.muted, styles.intro]}>
                  The model writes the words and composes every side for this order from its
                  photographs and palettes. Pamphlet is a small take home piece; Brochure is a larger
                  art directed book. Length follows the content.
                </Text>

                <View style={styles.formatRow}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Pamphlet format"
                    onPress={() => setOutputFormat('pamphlet')}
                    style={[styles.formatChip, outputFormat === 'pamphlet' && styles.formatChipActive]}>
                    <Text style={[styles.formatLabel, outputFormat === 'pamphlet' && styles.formatLabelActive]}>
                      Pamphlet
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Brochure format"
                    onPress={() => setOutputFormat('brochure')}
                    style={[styles.formatChip, outputFormat === 'brochure' && styles.formatChipActive]}>
                    <Text style={[styles.formatLabel, outputFormat === 'brochure' && styles.formatLabelActive]}>
                      Brochure
                    </Text>
                  </Pressable>
                  <Text style={[text.caption, styles.formatHint]}>
                    {outputFormat === 'pamphlet' ? 'Small take home piece' : 'Larger art directed book'}
                  </Text>
                </View>

                <View style={styles.briefField}>
                  <Field
                    label="Direction, optional"
                    value={direction}
                    onChangeText={setDirection}
                    placeholder="Warmer and more festive, like a coffee table book, big Tamil title"
                    multiline
                    maxLength={1200}
                  />
                </View>

                {designError ? <Text style={[text.muted, styles.noteError]}>{designError}</Text> : null}
                {designStatus ? <Text style={[text.muted, styles.noteStatus]}>{designStatus}</Text> : null}

                <View style={styles.generateAction}>
                  <Button
                    label={render ? 'Design it again' : 'Design the brochure'}
                    loading={designLoading}
                    loadingLabel="Designing and printing"
                    onPress={() => void designBrochure()}
                  />
                  <Button
                    label="Continue chat"
                    variant="secondary"
                    onPress={() =>
                      router.push({ pathname: '/', params: { orderId: orderId ?? '' } })
                    }
                  />
                  <Button
                    label="Pages workspace"
                    variant="secondary"
                    onPress={() => router.push(`/workspace/${orderId ?? ''}` as Href)}
                  />
                </View>

                {render ? (
                  <>
                    <BrochurePreview render={render} />
                    <View style={styles.previewActions}>
                      <View style={styles.actionCell}>
                        <Button label="Open PDF" variant="secondary" onPress={() => void (pdfUrl && openUrl(pdfUrl))} fullWidth />
                      </View>
                      <View style={styles.actionCell}>
                        <Button label="Share" variant="secondary" onPress={() => void handleShare()} fullWidth />
                      </View>
                    </View>
                    {shareStatus ? (
                      <Text style={[text.caption, styles.shareStatus]} accessibilityLiveRegion="polite">
                        {shareStatus}
                      </Text>
                    ) : null}
                  </>
                ) : null}
              </View>

              {order.attachments && order.attachments.length > 0 ? (
                <View style={styles.section}>
                  <View style={shared.rowBetween}>
                    <Text style={text.sectionLabel}>Customer files</Text>
                    <Text style={text.caption}>
                      {order.attachments.length === 1 ? '1 file' : `${order.attachments.length} files`}
                    </Text>
                  </View>
                  <Text style={[text.muted, styles.intro]}>Uploaded in the chat with this order.</Text>
                  {order.attachments.map((file) => (
                    <Pressable
                      key={file.url}
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${file.name}`}
                      onPress={() => void openUrl(fileUrl(file.url))}
                      style={({ pressed }) => [styles.fileRow, pressed && styles.fileRowPressed]}>
                      <Text style={[text.bodySmall, styles.fileName]} numberOfLines={1}>
                        {file.name}
                      </Text>
                      <Text style={text.caption}>{formatFileSize(file.bytes)}</Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}

              {palettes.length > 0 ? (
                <View style={styles.section}>
                  <View style={shared.rowBetween}>
                    <Text style={text.sectionLabel}>Colour from the pictures</Text>
                    <Text style={text.caption}>{palettes.length === 1 ? '1 palette' : `${palettes.length} palettes`}</Text>
                  </View>
                  <Text style={[text.muted, styles.intro]}>
                    Read from the photographs and printed in the brochure.
                  </Text>
                  {palettes.map((palette) => (
                    <View key={palette.photo} style={styles.paletteRow}>
                      <Text style={[text.caption, styles.paletteName]}>
                        {palette.photo.replace('photo', 'Photo ')}
                      </Text>
                      <View style={styles.swatchRow}>
                        {palette.colors.map((colour, index) => (
                          <View key={`${palette.photo}-${index}`} style={styles.swatchCard}>
                            <View
                              accessibilityLabel={`Colour ${colour}`}
                              style={[styles.swatch, { backgroundColor: colour }]}
                            />
                            <Text style={[text.caption, styles.swatchName]} numberOfLines={1}>
                              {palette.names[index] ?? ''}
                            </Text>
                            <Text style={[text.caption, styles.swatchHex]}>{colour}</Text>
                          </View>
                        ))}
                      </View>
                    </View>
                  ))}
                </View>
              ) : null}

              <View style={styles.section}>
                <View style={shared.rowBetween}>
                  <Text style={text.sectionLabel}>Customer note</Text>
                  {note ? <Text style={text.caption}>{note.model}</Text> : null}
                </View>
                {note ? (
                  <View style={styles.noteBox}>
                    <Text style={[text.body, styles.noteText]} selectable>
                      {note.note}
                    </Text>
                    <Button label="Copy note" variant="secondary" onPress={() => void copyNote()} />
                  </View>
                ) : (
                  <Text style={[text.muted, styles.intro]}>
                    A short message for the customer, drafted from this order and the materials.
                  </Text>
                )}
                {noteStatus ? (
                  <Text style={[text.caption, styles.noteStatus]} accessibilityLiveRegion="polite">
                    {noteStatus}
                  </Text>
                ) : null}
                {noteError ? <Text style={[text.muted, styles.noteError]}>{noteError}</Text> : null}
                <View style={styles.generateAction}>
                  <Button
                    label={note ? 'Draft another' : 'Draft customer note'}
                    variant={note ? 'secondary' : 'primary'}
                    loading={noteLoading}
                    loadingLabel="Drafting"
                    onPress={() => void draftNote()}
                  />
                </View>
              </View>

              <View style={styles.section}>
                <View style={shared.rowBetween}>
                  <Text style={text.sectionLabel}>Info kit</Text>
                  {kitRender ? <Text style={text.caption}>{pageCountLabel(kitRender.pageCount)}</Text> : null}
                </View>
                <Text style={[text.muted, styles.intro]}>
                  The company brochure: workshop, materials and process, printed on A4.
                </Text>
                {kitError ? <Text style={[text.muted, styles.noteError]}>{kitError}</Text> : null}
                {kitRender ? (
                  <View style={styles.kitRow}>
                    <Image
                      source={{ uri: fileUrl(kitRender.pageUrls[0]) }}
                      style={styles.kitThumb}
                      resizeMode="cover"
                      accessibilityLabel="Info kit first page"
                    />
                    <View style={styles.kitActions}>
                      <Button
                        label="Open PDF"
                        variant="secondary"
                        onPress={() => void openUrl(fileUrl(kitRender.pdfUrl))}
                      />
                    </View>
                  </View>
                ) : null}
                <View style={styles.generateAction}>
                  <Button
                    label={kitRender ? 'Render again' : 'Render info kit'}
                    loading={kitLoading}
                    loadingLabel="Rendering kit"
                    onPress={() => void renderKit()}
                  />
                </View>
              </View>

              <View style={[shared.hairline, styles.footerRule]} />
              <Text style={[text.caption, styles.footerNote]}>Jacob Design Studio · Catalogue Studio</Text>
            </>
          ) : null}
        </View>
      </ScrollView>
    </Screen>
  );
}

function BrochurePreview({ render }: { render: Render }) {
  const { width } = useWindowDimensions();
  const [pageIndex, setPageIndex] = useState(0);
  const frameWidth = Math.min(width, layout.maxWidth);
  const previewWidth = Math.max(Math.min(frameWidth - layout.gutter * 2, 420), 240);
  const pages = useMemo(() => render.pageUrls ?? [], [render.pageUrls]);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const next = Math.round(event.nativeEvent.contentOffset.x / previewWidth);
      setPageIndex(Math.max(0, Math.min(pages.length - 1, next)));
    },
    [pages.length, previewWidth]
  );

  if (pages.length === 0) {
    return (
      <Text style={[text.muted, styles.noPreview]}>
        The brochure was printed but no page previews came back. Open the PDF to read it.
      </Text>
    );
  }

  return (
    <View style={styles.preview}>
      <ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        decelerationRate="fast"
        snapToInterval={previewWidth}
        disableIntervalMomentum
        onScroll={handleScroll}
        scrollEventThrottle={16}
        style={{ width: previewWidth }}
        contentContainerStyle={styles.previewTrack}>
        {pages.map((page, index) => (
          <View key={`${page}-${index}`} style={{ width: previewWidth }}>
            <View style={styles.pageFrame}>
              <PageImage uri={fileUrl(page)} label={`Brochure page ${index + 1}`} />
            </View>
          </View>
        ))}
      </ScrollView>

      <View style={styles.pageDots}>
        {pages.map((page, index) => (
          <View key={`dot-${page}-${index}`} style={[styles.pageDot, index === pageIndex && styles.pageDotActive]} />
        ))}
      </View>
      <Text style={[text.caption, styles.pageCounter]}>{`Page ${pageIndex + 1} of ${pages.length}`}</Text>
    </View>
  );
}

function PageImage({ uri, label }: { uri: string; label: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <View style={styles.pageFallback}>
        <Text style={[text.caption, styles.pageFallbackText]}>This page image did not load.</Text>
        <Text style={[text.caption, styles.pageFallbackText]}>Open the PDF to read the brochure.</Text>
      </View>
    );
  }
  return (
    <Image
      source={{ uri }}
      style={styles.pageImage}
      resizeMode="contain"
      accessibilityLabel={label}
      onError={() => setFailed(true)}
    />
  );
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const styles = StyleSheet.create({
  scroll: {
    paddingTop: 0,
  },
  page: {
    paddingHorizontal: layout.gutter,
  },
  specSection: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#ECECEC',
    padding: 20,
    marginTop: 12,
  },
  specHeading: {
    marginBottom: 8,
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: -0.2,
    color: '#0D0D0D',
  },
  specRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingVertical: space.sm + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.hairInset,
    gap: space.lg,
  },
  specLabel: {
    width: '42%',
    paddingTop: 1,
  },
  specValue: {
    flex: 1,
    textAlign: 'right',
  },
  specValueEmpty: {
    color: colors.faint,
  },
  section: {
    marginTop: space.md,
    backgroundColor: colors.surface,
    borderRadius: layout.radius,
    padding: space.lg,
  },
  intro: {
    marginTop: space.md,
    maxWidth: 560,
  },
  referenceCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginTop: space.lg,
    padding: space.md,
    borderRadius: layout.radiusSmall,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
    backgroundColor: colors.paperDeep,
  },
  referencePressed: {
    opacity: 0.8,
  },
  referenceMark: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.copperSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  referenceThumb: {
    width: 40,
    height: 56,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
    backgroundColor: colors.fill,
  },
  referenceMarkLabel: {
    fontSize: 16,
    color: colors.copper,
  },
  referenceText: {
    flex: 1,
    gap: 2,
  },
  referenceTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.ink,
  },
  referenceCaption: {
    color: colors.muted,
  },
  referenceAction: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.copper,
  },
  briefField: {
    marginTop: space.md,
    maxWidth: 640,
  },
  generateAction: {
    marginTop: space.lg,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  noteStatus: {
    marginTop: space.sm,
    color: colors.muted,
  },
  noteError: {
    marginTop: space.sm,
    color: '#8C2F24',
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.hairInset,
  },
  fileRowPressed: {
    opacity: 0.65,
  },
  fileName: {
    flexShrink: 1,
    color: colors.ink,
  },
  paletteRow: {
    marginTop: space.sm,
    gap: 6,
  },
  paletteName: {
    textTransform: 'uppercase',
    letterSpacing: 1.2,
  },
  swatchRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  swatch: {
    width: 44,
    height: 28,
    borderRadius: 2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairInset,
  },
  swatchCard: {
    width: 72,
    gap: 4,
  },
  swatchName: {
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    color: colors.ink,
  },
  swatchHex: {
    fontSize: 10,
    color: colors.faint,
  },
  noteBox: {
    marginTop: space.md,
    gap: space.md,
    padding: space.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
    backgroundColor: colors.paperDeep,
    maxWidth: 640,
  },
  noteText: {
    lineHeight: 24,
  },
  kitRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    marginTop: space.md,
  },
  kitThumb: {
    width: 96,
    height: 136,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
  },
  kitActions: {
    gap: space.sm,
  },
  preview: {
    marginTop: space.lg,
    alignSelf: 'center',
  },
  previewTrack: {
    alignItems: 'flex-start',
  },
  pageFrame: {
    width: '100%',
    aspectRatio: PAGE_ASPECT,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
    backgroundColor: colors.paper,
    overflow: 'hidden',
  },
  pageImage: {
    width: '100%',
    height: '100%',
  },
  pageFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
  },
  pageFallbackText: {
    textAlign: 'center',
  },
  pageDots: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: space.md,
    gap: space.xs,
  },
  pageDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: colors.hair,
  },
  pageDotActive: {
    backgroundColor: colors.copper,
  },
  pageCounter: {
    textAlign: 'center',
    marginTop: space.sm,
  },
  previewActions: {
    flexDirection: 'row',
    gap: space.md,
    marginTop: space.lg,
  },
  actionCell: {
    flex: 1,
  },
  shareStatus: {
    marginTop: space.md,
  },
  noPreview: {
    marginTop: space.lg,
  },
  footerRule: {
    marginTop: space.xxl,
  },
  footerNote: {
    marginTop: space.lg,
  },
  newHeader: {
    paddingTop: 14,
    paddingBottom: 10,
  },
  newHeaderTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  newBack: {
    paddingVertical: 4,
    paddingRight: 8,
  },
  newBackLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6E6E73',
  },
  newBrand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  newBrandMark: {
    width: 24,
    height: 24,
    borderRadius: 6,
  },
  newBrandName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#0D0D0D',
    letterSpacing: -0.2,
  },
  newEyebrow: {
    marginTop: 14,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.4,
    color: '#8E8E93',
  },
  newTitle: {
    marginTop: 4,
    fontSize: 30,
    lineHeight: 34,
    fontWeight: '700',
    letterSpacing: -0.7,
    color: '#0D0D0D',
  },
  newSubtitle: {
    marginTop: 4,
    fontSize: 13.5,
    color: '#6E6E73',
  },
  newPressed: {
    opacity: 0.65,
  },
  formatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 12,
  },
  formatChip: {
    borderWidth: 1,
    borderColor: '#E5E5E5',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#FFFFFF',
  },
  formatChipActive: {
    backgroundColor: '#0D0D0D',
    borderColor: '#0D0D0D',
  },
  formatLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6E6E73',
  },
  formatLabelActive: {
    color: '#FFFFFF',
  },
  formatHint: {
    marginLeft: 4,
    color: '#8E8E93',
  },
});
