import { router, useLocalSearchParams } from 'expo-router';
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
import { ScreenHeader } from '@/components/ScreenHeader';
import { ErrorState, LoadingState } from '@/components/StateViews';
import { openUrl, shareLink } from '@/lib/actions';
import { copyText } from '@/lib/clipboard';
import { api, errorMessage, fileUrl, type Order, type OrderNote, type Render } from '@/lib/api';
import { displayValue, formatDate, pageCountLabel, statusLabel } from '@/lib/format';
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
      { label: 'Created', value: (order) => formatDate(order.createdAt) || 'Not set' },
    ],
  },
  {
    title: 'Dimensions',
    rows: [
      { label: 'Width', value: (order) => displayValue(order.width) },
      { label: 'Height', value: (order) => displayValue(order.height) },
      { label: 'Depth', value: (order) => displayValue(order.depth) },
      { label: 'Shutters', value: (order) => displayValue(order.shutters) },
    ],
  },
  {
    title: 'Carcass',
    rows: [
      { label: 'Carcass', value: (order) => displayValue(order.carcass) },
      { label: 'Back panel', value: (order) => displayValue(order.backPanel) },
      { label: 'Shutter material', value: (order) => displayValue(order.shuttersMat) },
      { label: 'Drawers', value: (order) => displayValue(order.drawers) },
    ],
  },
  {
    title: 'Materials',
    rows: [
      { label: 'Exterior laminate', value: (order) => displayValue(order.exterior) },
      { label: 'Interior laminate', value: (order) => displayValue(order.interior) },
      { label: 'Edge band shutters', value: (order) => displayValue(order.edgeShutter) },
      { label: 'Edge band carcass', value: (order) => displayValue(order.edgeCarcass) },
    ],
  },
  {
    title: 'Hardware',
    rows: [
      { label: 'Hinges', value: (order) => displayValue(order.hinges) },
      { label: 'Channels', value: (order) => displayValue(order.channels) },
      { label: 'Handle', value: (order) => displayValue(order.handle) },
      { label: 'Handle note', value: (order) => displayValue(order.handleNote) },
    ],
  },
  {
    title: 'Finish',
    rows: [
      { label: 'Exterior finish', value: (order) => displayValue(order.finishExt) },
      { label: 'Interior finish', value: (order) => displayValue(order.finishInt) },
    ],
  },
];

export default function OrderDetailScreen() {
  const { id, reference: routeReference, referenceName: routeReferenceName } = useLocalSearchParams<{
    id?: string;
    reference?: string;
    referenceName?: string;
  }>();
  const orderId = id;
  const insets = useSafeAreaInsets();

  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [render, setRender] = useState<Render | null>(null);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const [reference, setReference] = useState<string>(routeReference ?? '');
  const [referenceName, setReferenceName] = useState<string>(routeReferenceName ?? '');
  const [referencePreview, setReferencePreview] = useState<string | null>(null);
  const [direction, setDirection] = useState('');
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

  // Returning from the reference gallery replaces the route parameters while
  // this screen stays mounted, so the choice is copied into state.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (routeReference !== undefined) setReference(routeReference);
    if (routeReferenceName !== undefined) setReferenceName(routeReferenceName);
  }, [routeReference, routeReferenceName]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // The preview image arrives from the network; the effect only subscribes.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!reference) {
      setReferencePreview(null);
      return;
    }
    let active = true;
    api
      .listDesigns()
      .then((library) => {
        if (!active) return;
        const match = library.designs.find((design) => design.id === reference);
        setReferencePreview(match?.previewUrl ?? null);
        if (match?.name) setReferenceName(match.name);
      })
      .catch(() => {
        if (active) setReferencePreview(null);
      });
    return () => {
      active = false;
    };
  }, [reference]);
  /* eslint-enable react-hooks/set-state-in-effect */

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
    } catch (fetchError) {
      setLoadError(errorMessage(fetchError, 'The order could not be loaded. Try again.'));
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  const loadLatestRender = useCallback(async () => {
    if (!orderId) return;
    try {
      const all = await api.listRenders();
      const mine = all
        .filter((candidate) => candidate.orderId === orderId && candidate.kind === 'ai')
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      if (mine.length > 0) {
        setRender(mine[0]);
        const design = mine[0].design as
          | { reference?: string | null; referenceName?: string | null }
          | null
          | undefined;
        if (!routeReference && design?.reference) {
          setReference(design.reference);
          setReferenceName(design.referenceName ?? '');
        }
      }
    } catch {
      // No previous brochure is not an error.
    }
  }, [orderId, routeReference]);

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
      const result = await api.aiBrochure(orderId, {
        direction,
        ...(reference ? { reference } : {}),
      });
      setRender(result.render);
      setOrder((current) =>
        current
          ? { ...current, copy: result.copy, designDirection: result.direction ?? direction }
          : current
      );
      const design = result.design as
        | { reference?: string | null; referenceName?: string | null }
        | null
        | undefined;
      if (design?.referenceName) setReferenceName(design.referenceName);
      setDesignStatus('The brochure was designed and printed.');
    } catch (error) {
      setDesignError(errorMessage(error, 'The model could not design this brochure. Check the settings.'));
    } finally {
      setDesignLoading(false);
    }
  }, [designLoading, direction, orderId, reference]);

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
              <ScreenHeader back onBack={goBack} eyebrow="Order" title="Loading order" />
              <LoadingState label="Loading the order." />
            </>
          ) : null}

          {!loading && loadError ? (
            <>
              <ScreenHeader back onBack={goBack} eyebrow="Order" title="Order unavailable" />
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
              <ScreenHeader
                back
                onBack={goBack}
                eyebrow={order.orderNo}
                title={order.title}
                subtitle={`${displayValue(order.customerName)} · ${statusLabel(order.status)}`}
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
                  The model writes the words and typesets the four pages from this order, the
                  photographs and the finish samples. A reference only sets the feel; the layout is
                  composed for this piece.
                </Text>

                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Choose a design reference"
                  onPress={() => {
                    if (!orderId) return;
                    router.push({
                      pathname: '/templates',
                      params: { orderId, reference: reference || undefined },
                    });
                  }}
                  style={({ pressed }) => [styles.referenceCard, pressed && styles.referencePressed]}>
                  {referencePreview ? (
                    <Image
                      source={{ uri: fileUrl(referencePreview) }}
                      style={styles.referenceThumb}
                      resizeMode="cover"
                      accessibilityLabel={`Printed preview of ${referenceName || reference}`}
                    />
                  ) : (
                    <View style={styles.referenceMark}>
                      <Text style={styles.referenceMarkLabel}>◈</Text>
                    </View>
                  )}
                  <View style={styles.referenceText}>
                    <Text style={styles.referenceTitle}>
                      {referenceName || reference ? referenceName || 'Selected reference' : 'No reference'}
                    </Text>
                    <Text style={[text.caption, styles.referenceCaption]}>
                      {reference || referenceName
                        ? 'Reference feel. Change it whenever you like.'
                        : 'Let the model read the room. Pick a look only if you want to guide the mood.'}
                    </Text>
                  </View>
                  <Text style={styles.referenceAction}>{reference || referenceName ? 'Change' : 'Choose'}</Text>
                </Pressable>

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
              <Text style={[text.caption, styles.footerNote]}>Grace Wood Industry · Catalogue Studio</Text>
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
    backgroundColor: colors.surface,
    borderRadius: layout.radius,
    padding: space.lg,
    marginTop: space.md,
  },
  specHeading: {
    marginBottom: space.sm,
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
    alignSelf: 'flex-start',
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
});
