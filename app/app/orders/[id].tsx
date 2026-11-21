import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { Screen } from '@/components/Screen';
import { ScreenHeader } from '@/components/ScreenHeader';
import { ErrorState, LoadingState } from '@/components/StateViews';
import { openUrl, shareLink } from '@/lib/actions';
import {
  api,
  errorMessage,
  fileUrl,
  type BrochureCopy,
  type Order,
  type OrderNote,
  type Render,
  type Template,
} from '@/lib/api';
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
  const { id, templateId: routeTemplateId } = useLocalSearchParams<{ id?: string; templateId?: string }>();
  const orderId = id;
  const insets = useSafeAreaInsets();

  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [render, setRender] = useState<Render | null>(null);
  const [rendering, setRendering] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const [briefDraft, setBriefDraft] = useState<string | null>(null);
  const [writtenCopy, setWrittenCopy] = useState<BrochureCopy | null>(null);
  const [copyModel, setCopyModel] = useState<string | null>(null);
  const [copyLoading, setCopyLoading] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [note, setNote] = useState<OrderNote | null>(null);
  const [noteLoading, setNoteLoading] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [noteStatus, setNoteStatus] = useState<string | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const chosenTemplate = routeTemplateId;

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
    } catch (fetchError) {
      setLoadError(errorMessage(fetchError, 'The order could not be loaded. Try again.'));
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  const loadLatestRender = useCallback(async () => {
    if (!orderId) {
      return;
    }
    try {
      const all = await api.listRenders();
      const mine = all
        .filter((candidate) => candidate.orderId === orderId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      if (mine.length > 0) {
        setRender(mine[0]);
      }
    } catch {
      // No previous render is not an error. The person can generate a new one.
    }
  }, [orderId]);

  // Loads once when the screen opens. The loading state is the initial state,
  // so the first paint is correct and no extra render is needed.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    void loadOrder();
    void loadLatestRender();
  }, [loadOrder, loadLatestRender]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    // Designs load in the background. A failure here never blocks the document.
    let active = true;
    api
      .listTemplates()
      .then((next) => {
        if (active) setTemplates(next);
      })
      .catch(() => {
        // Designs are a nicety. Rendering still works with the default.
      });
    return () => {
      active = false;
    };
  }, []);

  const currentTemplate = useMemo(() => {
    const wanted = chosenTemplate ?? render?.templateId ?? templates[0]?.id;
    return templates.find((candidate) => candidate.id === wanted) ?? templates[0] ?? null;
  }, [chosenTemplate, render?.templateId, templates]);

  useEffect(() => {
    if (!rendering) {
      return;
    }
    const startedAt = Date.now();
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [rendering]);

  const goBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/');
  }, []);

  const generateVoucher = useCallback(async () => {
    if (rendering) {
      return;
    }
    if (!orderId) {
      setRenderError('This order link is missing an id. Go back to the order book.');
      return;
    }
    setRendering(true);
    setElapsed(0);
    setRenderError(null);
    setShareStatus(null);
    try {
      const next = await api.renderOrder(orderId, 'voucher', chosenTemplate ?? currentTemplate?.id);
      setRender(next);
    } catch (renderFailure) {
      setRenderError(errorMessage(renderFailure, 'The voucher could not be rendered. Try again.'));
    } finally {
      setRendering(false);
    }
  }, [chosenTemplate, currentTemplate, orderId, rendering]);

  const writeCopy = useCallback(async () => {
    if (!orderId || copyLoading) {
      return;
    }
    setCopyLoading(true);
    setCopyError(null);
    try {
      const result = await api.generateOrderCopy(orderId, { brief: briefDraft ?? order?.brief ?? '' });
      setWrittenCopy(result.copy);
      setCopyModel(result.model);
      setOrder((current) => (current ? { ...current, copy: result.copy } : current));
    } catch (error) {
      setCopyError(errorMessage(error, 'The model could not write the copy. Check the model settings.'));
    } finally {
      setCopyLoading(false);
    }
  }, [briefDraft, copyLoading, order, orderId]);

  const draftNote = useCallback(async () => {
    if (!orderId || noteLoading) {
      return;
    }
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

  const copyNote = useCallback(async () => {
    if (!note) {
      return;
    }
    try {
      await Clipboard.setStringAsync(note.note);
      setNoteStatus('Note copied to the clipboard.');
    } catch {
      setNoteStatus('Could not copy. Select the text and copy it by hand.');
    }
  }, [note]);

  const pdfUrl = render ? fileUrl(render.pdfUrl) : null;

  const handleOpenPdf = useCallback(() => {
    if (pdfUrl) {
      void openUrl(pdfUrl);
    }
  }, [pdfUrl]);

  const handleShare = useCallback(async () => {
    if (!render || !order) {
      return;
    }
    setShareStatus(null);
    const outcome = await shareLink({
      title: `Voucher ${order.orderNo}`,
      message: `${order.title}, ${order.customerName}`,
      url: fileUrl(render.pdfUrl),
    });
    if (outcome === 'copied') {
      setShareStatus('Link copied to the clipboard.');
    } else if (outcome === 'shared') {
      setShareStatus('Voucher link shared.');
    } else if (outcome === 'dismissed') {
      setShareStatus('Sharing cancelled.');
    } else if (outcome === 'unavailable') {
      setShareStatus('Sharing is not available here. Open the PDF and share it from there.');
    }
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

              <View style={[shared.hairline, styles.rule]} />

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

              <View style={styles.voucherSection}>
                <View style={shared.rowBetween}>
                  <Text style={text.sectionLabel}>Design</Text>
                  <Text style={text.caption}>{currentTemplate?.name ?? 'Copper Full Bleed'}</Text>
                </View>
                <View style={styles.designRow}>
                  {currentTemplate ? (
                    <Image
                      source={{ uri: fileUrl(currentTemplate.previewUrl) }}
                      style={styles.designThumb}
                      resizeMode="cover"
                      accessibilityLabel={`${currentTemplate.name} cover preview`}
                    />
                  ) : (
                    <View style={[styles.designThumb, styles.designThumbEmpty]} />
                  )}
                  <View style={styles.designText}>
                    <Text style={text.muted}>
                      {templates.length > 0
                        ? `${templates.length} designs across ten document styles. Every design carries the same information.`
                        : 'Every design carries the same information in its own layout.'}
                    </Text>
                    <Button
                      label="Change design"
                      variant="secondary"
                      onPress={() => {
                        if (!orderId) return;
                        router.push({
                          pathname: '/templates',
                          params: { orderId, selected: currentTemplate?.id ?? '' },
                        });
                      }}
                    />
                  </View>
                </View>
              </View>

              <View style={styles.voucherSection}>
                <View style={shared.rowBetween}>
                  <Text style={text.sectionLabel}>Brochure copy</Text>
                  {copyModel ? <Text style={text.caption}>{copyModel}</Text> : null}
                </View>
                <Text style={[text.muted, styles.voucherIntro]}>
                  Paste what the customer said, including anything they added or dropped. The model
                  writes the body from the order and this brief, then the voucher is rendered again.
                </Text>
                <View style={styles.briefField}>
                  <Field
                    label="Customer brief, optional"
                    value={briefDraft ?? order.brief ?? ''}
                    onChangeText={setBriefDraft}
                    placeholder="Anything the customer added, changed or dropped"
                    multiline
                    maxLength={2000}
                  />
                </View>
                {copyError ? <Text style={[text.muted, styles.noteError]}>{copyError}</Text> : null}
                {writtenCopy ?? order.copy ? (
                  <View style={styles.noteBox}>
                    <Text style={[text.caption, styles.noteStatus]}>
                      Generate the voucher again to print this copy.
                    </Text>
                    <Text style={[text.value, styles.copyHeadline]}>
                      {(writtenCopy ?? order.copy)?.headline}
                    </Text>
                    <Text style={[text.body, styles.noteText]} selectable>
                      {(writtenCopy ?? order.copy)?.body}
                    </Text>
                    <Text style={[text.caption, styles.copyClosing]}>
                      {(writtenCopy ?? order.copy)?.closing}
                    </Text>
                  </View>
                ) : null}
                <View style={styles.generateAction}>
                  <Button
                    label={writtenCopy ?? order.copy ? 'Write it again' : 'Write the brochure copy'}
                    loading={copyLoading}
                    loadingLabel="Writing"
                    onPress={() => void writeCopy()}
                  />
                </View>
              </View>

              <View style={styles.voucherSection}>
                <View style={shared.rowBetween}>
                  <Text style={text.sectionLabel}>Voucher</Text>
                  {render ? <Text style={text.caption}>{pageCountLabel(render.pageCount)}</Text> : null}
                </View>

                {rendering ? <RenderingProgress elapsed={elapsed} /> : null}

                {renderError ? (
                  <ErrorState
                    title="The voucher could not be rendered"
                    message={renderError}
                    onRetry={() => {
                      void generateVoucher();
                    }}
                    retrying={rendering}
                  />
                ) : null}

                {!render && !rendering && !renderError ? (
                  <>
                    <Text style={[text.muted, styles.voucherIntro]}>
                      A voucher is the printable order summary for the workshop. Pages are set on
                      A4.
                    </Text>
                    <View style={styles.generateAction}>
                      <Button
                        label="Generate voucher"
                        onPress={() => {
                          void generateVoucher();
                        }}
                      />
                    </View>
                  </>
                ) : null}

                {render ? (
                  <>
                    <VoucherPreview render={render} />
                    <View style={styles.previewActions}>
                      <View style={styles.actionCell}>
                        <Button
                          label="Open PDF"
                          variant="secondary"
                          onPress={handleOpenPdf}
                          fullWidth
                        />
                      </View>
                      <View style={styles.actionCell}>
                        <Button
                          label="Share"
                          variant="secondary"
                          onPress={() => {
                            void handleShare();
                          }}
                          fullWidth
                        />
                      </View>
                    </View>
                    {shareStatus ? (
                      <Text
                        style={[text.caption, styles.shareStatus]}
                        accessibilityLiveRegion="polite">
                        {shareStatus}
                      </Text>
                    ) : null}
                    <View style={styles.regenerate}>
                      <Button
                        label="Generate voucher again"
                        variant="quiet"
                        loading={rendering}
                        loadingLabel="Rendering voucher"
                        onPress={() => {
                          void generateVoucher();
                        }}
                      />
                    </View>
                  </>
                ) : null}
              </View>

              <View style={styles.voucherSection}>
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
                  <Text style={[text.muted, styles.voucherIntro]}>
                    A short message for the customer, drafted from this order and the materials.
                  </Text>
                )}
                {noteStatus ? (
                  <Text style={[text.caption, styles.noteStatus]} accessibilityLiveRegion="polite">
                    {noteStatus}
                  </Text>
                ) : null}
                {noteError ? (
                  <Text style={[text.muted, styles.noteError]}>{noteError}</Text>
                ) : null}
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

              <View style={[shared.hairline, styles.footerRule]} />
              <Text style={[text.caption, styles.footerNote]}>
                Grace Wood Industry · Catalogue Studio
              </Text>
            </>
          ) : null}
        </View>
      </ScrollView>
    </Screen>
  );
}

function RenderingProgress({ elapsed }: { elapsed: number }) {
  return (
    <View
      style={styles.progress}
      accessibilityRole="progressbar"
      accessibilityLabel="Rendering voucher">
      <ActivityIndicator color={colors.copper} />
      <View style={styles.progressText}>
        <Text style={text.value}>Rendering voucher</Text>
        <Text style={text.caption}>
          {elapsed > 0 ? `Preparing the pages. ${elapsed} s elapsed.` : 'Preparing the pages.'}
        </Text>
      </View>
    </View>
  );
}

function VoucherPreview({ render }: { render: Render }) {
  const { width } = useWindowDimensions();
  const [pageIndex, setPageIndex] = useState(0);
  const frameWidth = Math.min(width, layout.maxWidth);
  const previewWidth = Math.max(Math.min(frameWidth - layout.gutter * 2, 420), 240);
  const pages = useMemo(() => render.pageUrls ?? [], [render.pageUrls]);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const next = Math.round(event.nativeEvent.contentOffset.x / previewWidth);
      const clamped = Math.max(0, Math.min(pages.length - 1, next));
      setPageIndex(clamped);
    },
    [pages.length, previewWidth],
  );

  if (pages.length === 0) {
    return (
      <Text style={[text.muted, styles.noPreview]}>
        The voucher was generated but no page previews came back. Open the PDF to check it.
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
              <PageImage uri={fileUrl(page)} label={`Voucher page ${index + 1}`} />
            </View>
          </View>
        ))}
      </ScrollView>

      <View style={styles.pageDots}>
        {pages.map((page, index) => (
          <View
            key={`dot-${page}-${index}`}
            style={[styles.pageDot, index === pageIndex && styles.pageDotActive]}
          />
        ))}
      </View>
      <Text style={[text.caption, styles.pageCounter]}>
        {`Page ${pageIndex + 1} of ${pages.length}`}
      </Text>
    </View>
  );
}

function PageImage({ uri, label }: { uri: string; label: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <View style={styles.pageFallback}>
        <Text style={[text.caption, styles.pageFallbackText]}>This page image did not load.</Text>
        <Text style={[text.caption, styles.pageFallbackText]}>Open the PDF to read the voucher.</Text>
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

const styles = StyleSheet.create({
  briefField: {
    marginTop: space.md,
    maxWidth: 640,
  },
  copyHeadline: {
    fontFamily: 'Georgia',
    fontSize: 19,
    lineHeight: 26,
  },
  copyClosing: {
    color: colors.muted,
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
  noteStatus: {
    marginTop: space.sm,
    color: colors.muted,
  },
  noteError: {
    marginTop: space.sm,
    color: '#8C2F24',
  },
  designRow: {
    flexDirection: 'row',
    gap: space.md,
    alignItems: 'flex-start',
  },
  designThumb: {
    width: 84,
    height: 118,
    borderWidth: 1,
    borderColor: colors.hair,
    backgroundColor: colors.paperDeep,
  },
  designThumbEmpty: {
    backgroundColor: colors.paperDeep,
  },
  designText: {
    flex: 1,
    gap: space.sm,
  },
  scroll: {
    paddingTop: 0,
  },
  page: {
    paddingHorizontal: layout.gutter,
  },
  rule: {
    marginTop: space.xl,
  },
  specSection: {
    marginTop: space.xl,
  },
  specHeading: {
    marginBottom: space.sm,
  },
  specRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.hair,
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
  voucherSection: {
    marginTop: space.xxl,
  },
  voucherIntro: {
    marginTop: space.md,
    maxWidth: 480,
  },
  generateAction: {
    marginTop: space.lg,
    alignSelf: 'flex-start',
  },
  progress: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
    borderRadius: layout.radius,
    padding: space.lg,
    marginTop: space.lg,
  },
  progressText: {
    marginLeft: space.md,
    flex: 1,
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
  regenerate: {
    marginTop: space.lg,
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
