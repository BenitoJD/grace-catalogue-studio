import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
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
import {
  api,
  errorMessage,
  fileUrl,
  type AiDesign,
  type BrochureCopy,
  type Order,
  type OrderNote,
  type Render,
  type Template,
} from '@/lib/api';
import { displayValue, formatDate, pageCountLabel, statusLabel } from '@/lib/format';
import { colors, layout, shared, space, text } from '@/lib/theme';

const PAGE_ASPECT = 794 / 1123;

const TONE_OPTIONS = [
  { value: 'maroon', label: 'Maroon' },
  { value: 'teal', label: 'Teal' },
  { value: 'copper', label: 'Copper' },
  { value: 'sandal', label: 'Sandal' },
  { value: 'peacock', label: 'Peacock' },
];
const TYPE_OPTIONS = [
  { value: 'editorial', label: 'Editorial' },
  { value: 'modern', label: 'Modern' },
  { value: 'classic', label: 'Classic' },
];
const COVER_OPTIONS = [
  { value: 'fullBleed', label: 'Full bleed' },
  { value: 'splitLeft', label: 'Photo left' },
  { value: 'splitRight', label: 'Photo right' },
  { value: 'masthead', label: 'Masthead' },
  { value: 'bandTop', label: 'Photo top' },
  { value: 'framed', label: 'Framed' },
];
const STORY_OPTIONS = [
  { value: 'hero', label: 'Hero' },
  { value: 'editorial', label: 'Editorial' },
  { value: 'diptych', label: 'Diptych' },
  { value: 'collage', label: 'Collage' },
];
const MATERIALS_OPTIONS = [
  { value: 'grid4', label: 'Grid' },
  { value: 'filmstrip', label: 'Filmstrip' },
  { value: 'band', label: 'Band' },
  { value: 'museum', label: 'Museum' },
  { value: 'stacked', label: 'Stacked' },
];
const SPEC_OPTIONS = [
  { value: 'twoColumn', label: 'Two column' },
  { value: 'threeColumn', label: 'Three column' },
  { value: 'ledger', label: 'Ledger' },
  { value: 'cards', label: 'Cards' },
  { value: 'stacked', label: 'Stacked' },
];

function ChoiceRow({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: string; label: string }[];
  value: string | undefined;
  onChange: (value: string) => void;
}) {
  return (
    <View style={styles.choiceBlock}>
      <Text style={[text.caption, styles.choiceLabel]}>{label}</Text>
      <View style={styles.chipRow}>
        {options.map((option) => {
          const active = option.value === value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="button"
              accessibilityLabel={`${label}: ${option.label}`}
              onPress={() => onChange(option.value)}
              style={[styles.chip, active && styles.chipActive]}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{option.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

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
  const [kitRender, setKitRender] = useState<Render | null>(null);
  const [kitLoading, setKitLoading] = useState(false);
  const [kitError, setKitError] = useState<string | null>(null);
  const [note, setNote] = useState<OrderNote | null>(null);
  const [noteLoading, setNoteLoading] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [noteStatus, setNoteStatus] = useState<string | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [aiDesign, setAiDesign] = useState<AiDesign | null>(null);
  const [aiDirection, setAiDirection] = useState('');
  const [aiCopy, setAiCopy] = useState<BrochureCopy | null>(null);
  const [designLoading, setDesignLoading] = useState(false);
  const [designError, setDesignError] = useState<string | null>(null);
  const [designStatus, setDesignStatus] = useState<string | null>(null);
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
      setAiDirection(next.designDirection ?? '');
      setAiCopy(next.copy ?? null);
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
        const latestAi = mine.find((candidate) => candidate.kind === 'ai' && candidate.design);
        if (latestAi?.design) {
          setAiDesign(latestAi.design as unknown as AiDesign);
        }
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

  const updateDesign = useCallback((patch: Partial<AiDesign>) => {
    setAiDesign((current) => (current ? { ...current, ...patch } : current));
  }, []);

  const updateCopy = useCallback(
    (patch: Partial<BrochureCopy>) => {
      setAiCopy((current) => ({
        ...(current ?? order?.copy ?? { headline: '', body: '', closing: '' }),
        ...patch,
      }));
    },
    [order?.copy]
  );

  const designWithModel = useCallback(async () => {
    if (!orderId || designLoading) {
      return;
    }
    setDesignLoading(true);
    setDesignError(null);
    setDesignStatus(null);
    try {
      const result = await api.aiBrochure(orderId, {
        direction: aiDirection,
        brief: briefDraft ?? order?.brief ?? '',
      });
      setAiDesign(result.design);
      setAiCopy(result.copy);
      setWrittenCopy(result.copy);
      setRender(result.render);
      setOrder((current) =>
        current
          ? { ...current, copy: result.copy, designDirection: result.direction ?? aiDirection }
          : current
      );
      setDesignStatus('A new brochure was designed and rendered.');
    } catch (error) {
      setDesignError(
        errorMessage(error, 'The model could not design this brochure. Check the model settings.')
      );
    } finally {
      setDesignLoading(false);
    }
  }, [aiDirection, briefDraft, designLoading, order, orderId]);

  const rerenderDesign = useCallback(async () => {
    if (!orderId || !aiDesign || designLoading) {
      return;
    }
    const copy = aiCopy ?? order?.copy ?? null;
    if (!copy) {
      setDesignError('Write the brochure copy first, then re-render the design.');
      return;
    }
    setDesignLoading(true);
    setDesignError(null);
    setDesignStatus(null);
    try {
      const result = await api.aiBrochure(orderId, {
        direction: aiDirection,
        overrides: {
          tone: aiDesign.tone,
          type: aiDesign.type,
          cover: aiDesign.cover,
          story: aiDesign.story,
          materials: aiDesign.materials,
          spec: aiDesign.spec,
          statement: aiDesign.statement,
        },
        copy,
      });
      setAiDesign(result.design);
      setAiCopy(result.copy);
      setWrittenCopy(result.copy);
      setRender(result.render);
      setOrder((current) =>
        current
          ? { ...current, copy: result.copy, designDirection: result.direction ?? aiDirection }
          : current
      );
      setDesignStatus('The brochure was re-rendered with your choices.');
    } catch (error) {
      setDesignError(errorMessage(error, 'The design could not be re-rendered.'));
    } finally {
      setDesignLoading(false);
    }
  }, [aiCopy, aiDesign, aiDirection, designLoading, order, orderId]);

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

  const renderKit = useCallback(async () => {
    if (!orderId || kitLoading) {
      return;
    }
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
    if (!note) {
      return;
    }
    const ok = await copyText(note.note);
    setNoteStatus(ok ? 'Note copied to the clipboard.' : 'Could not copy. Select the text and copy it by hand.');
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
                  <Text style={text.sectionLabel}>AI design</Text>
                  <Text style={text.caption}>{aiDesign?.label ?? 'Not designed yet'}</Text>
                </View>
                <Text style={[text.muted, styles.voucherIntro]}>
                  Say how the brochure should feel, then let the model design it. Change any choice
                  and re-render without asking the model again.
                </Text>
                <View style={styles.briefField}>
                  <Field
                    label="Design direction"
                    value={aiDirection}
                    onChangeText={setAiDirection}
                    placeholder="Warm and festive, quiet and minimal, big Tamil title, like a coffee table book"
                    multiline
                    maxLength={1200}
                  />
                </View>
                {aiDesign ? (
                  <>
                    <ChoiceRow
                      label="Palette"
                      options={TONE_OPTIONS}
                      value={aiDesign.tone}
                      onChange={(tone) => updateDesign({ tone })}
                    />
                    <ChoiceRow
                      label="Type"
                      options={TYPE_OPTIONS}
                      value={aiDesign.type}
                      onChange={(type) => updateDesign({ type })}
                    />
                    <ChoiceRow
                      label="Cover"
                      options={COVER_OPTIONS}
                      value={aiDesign.cover}
                      onChange={(cover) => updateDesign({ cover })}
                    />
                    <ChoiceRow
                      label="Story"
                      options={STORY_OPTIONS}
                      value={aiDesign.story}
                      onChange={(story) => updateDesign({ story })}
                    />
                    <ChoiceRow
                      label="Materials"
                      options={MATERIALS_OPTIONS}
                      value={aiDesign.materials}
                      onChange={(materials) => updateDesign({ materials })}
                    />
                    <ChoiceRow
                      label="Specification"
                      options={SPEC_OPTIONS}
                      value={aiDesign.spec}
                      onChange={(spec) => updateDesign({ spec })}
                    />
                    <View style={styles.briefField}>
                      <Field
                        label="Story line"
                        value={aiDesign.statement}
                        onChangeText={(statement) => updateDesign({ statement })}
                        maxLength={100}
                      />
                    </View>
                    <View style={styles.briefField}>
                      <Field
                        label="Headline"
                        value={aiCopy?.headline ?? order?.copy?.headline ?? ''}
                        onChangeText={(headline) => updateCopy({ headline })}
                        maxLength={120}
                      />
                    </View>
                    <View style={styles.briefField}>
                      <Field
                        label="Body"
                        value={aiCopy?.body ?? order?.copy?.body ?? ''}
                        onChangeText={(body) => updateCopy({ body })}
                        multiline
                        maxLength={2400}
                      />
                    </View>
                    <View style={styles.briefField}>
                      <Field
                        label="Closing"
                        value={aiCopy?.closing ?? order?.copy?.closing ?? ''}
                        onChangeText={(closing) => updateCopy({ closing })}
                        maxLength={160}
                      />
                    </View>
                  </>
                ) : null}
                {designError ? <Text style={[text.muted, styles.noteError]}>{designError}</Text> : null}
                {designStatus ? <Text style={[text.muted, styles.noteStatus]}>{designStatus}</Text> : null}
                <View style={styles.generateAction}>
                  <Button
                    label={aiDesign ? 'Ask the model to redesign' : 'Design with the model'}
                    loading={designLoading}
                    loadingLabel="Designing"
                    onPress={() => void designWithModel()}
                  />
                </View>
                {aiDesign ? (
                  <View style={styles.generateAction}>
                    <Button
                      label="Re-render with these choices"
                      variant="secondary"
                      loading={designLoading}
                      loadingLabel="Rendering"
                      onPress={() => void rerenderDesign()}
                    />
                  </View>
                ) : null}
                <View style={styles.generateAction}>
                  <Button
                    label="Use a template instead"
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

              {order.attachments && order.attachments.length > 0 ? (
                <View style={styles.voucherSection}>
                  <View style={shared.rowBetween}>
                    <Text style={text.sectionLabel}>Customer files</Text>
                    <Text style={text.caption}>
                      {order.attachments.length === 1
                        ? '1 file'
                        : `${order.attachments.length} files`}
                    </Text>
                  </View>
                  <Text style={[text.muted, styles.voucherIntro]}>
                    Uploaded in the chat with this order.
                  </Text>
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

              <View style={styles.voucherSection}>
                <View style={shared.rowBetween}>
                  <Text style={text.sectionLabel}>Info kit</Text>
                  {kitRender ? (
                    <Text style={text.caption}>{pageCountLabel(kitRender.pageCount)}</Text>
                  ) : null}
                </View>
                <Text style={[text.muted, styles.voucherIntro]}>
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
                        onPress={() => {
                          void openUrl(fileUrl(kitRender.pdfUrl));
                        }}
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

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const styles = StyleSheet.create({
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
  choiceBlock: {
    marginTop: space.md,
  },
  choiceLabel: {
    marginBottom: space.sm,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  chip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.hair,
    backgroundColor: colors.surface,
    paddingHorizontal: space.md,
    paddingVertical: 7,
  },
  chipActive: {
    borderColor: colors.copper,
    backgroundColor: colors.copperSoft,
  },
  chipText: {
    fontSize: 13,
    color: colors.muted,
  },
  chipTextActive: {
    color: colors.copper,
    fontWeight: '600',
  },
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
    borderRadius: 8,
    backgroundColor: colors.fill,
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
  voucherSection: {
    marginTop: space.md,
    backgroundColor: colors.surface,
    borderRadius: layout.radius,
    padding: space.lg,
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
