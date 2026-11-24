import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { api, fileUrl, type MarkedDetail, type Order, type Render } from '@/lib/api';
import { colors, text } from '@/lib/theme';

type PageItem = {
  url: string;
  pageUrl: string;
  name: string;
  label: string;
  pageIndex: number;
  pageCount: number;
};

type ChatLine = { role: 'user' | 'assistant'; content: string };

export default function WorkspaceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const orderId = typeof id === 'string' ? id : '';
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const narrow = width < 980;

  const [order, setOrder] = useState<Order | null>(null);
  const [pages, setPages] = useState<PageItem[]>([]);
  const [annotations, setAnnotations] = useState<MarkedDetail[]>([]);
  const [render, setRender] = useState<Render | null>(null);
  const [view, setView] = useState<'project' | 'brochure'>('project');
  const [pageIndex, setPageIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [marksOpen, setMarksOpen] = useState(false);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const [markLabel, setMarkLabel] = useState('');
  const [markName, setMarkName] = useState('');
  const [markHex, setMarkHex] = useState('');
  const [markNote, setMarkNote] = useState('');
  const [savingMark, setSavingMark] = useState(false);

  const [sessionId, setSessionId] = useState('');
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [chatNote, setChatNote] = useState('');
  const [progressLabel, setProgressLabel] = useState('');

  const load = useCallback(async () => {
    if (!orderId) return;
    try {
      const [loadedOrder, loadedPages, session, renders] = await Promise.all([
        api.getOrder(orderId),
        api.orderPages(orderId),
        api.assistantSession(orderId),
        api.listRenders(),
      ]);
      setOrder(loadedOrder);
      setPages(loadedPages.pages);
      setAnnotations(loadedPages.annotations ?? loadedOrder.annotations ?? []);
      const latest = renders
        .filter((entry) => entry.orderId === orderId && entry.kind === 'ai')
        .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0];
      setRender(latest ?? null);
      setSessionId(session.sessionId ?? `chat-${Date.now()}`);
      setLines(session.messages.map((message) => ({ role: message.role, content: message.content })));
      setPageIndex((current) => Math.min(current, Math.max(0, loadedPages.pages.length - 1)));
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'This order could not be opened.');
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const brochurePages = useMemo(
    () =>
      render?.pageUrls?.map((url, index) => ({
        url,
        pageUrl: url,
        name: `${render.id}-${index + 1}`,
        label: `Brochure page ${index + 1}`,
        pageIndex: index,
        pageCount: render.pageCount,
      })) ?? [],
    [render],
  );
  const activePages = view === 'brochure' ? brochurePages : pages;
  const active = activePages[Math.min(pageIndex, Math.max(0, activePages.length - 1))];
  const photoToken = `photo${pageIndex + 1}`;
  const stageWidth = Math.max(200, stage.width || 600);

  const saveMark = async () => {
    if (!active) return;
    if (markLabel.trim() === '' || markName.trim() === '') {
      setMarkNote('Enter the detail name and the colour name.');
      return;
    }
    const hex = (markHex.trim() === '' ? '#B98A55' : markHex.trim()).toUpperCase();
    if (!/^#[0-9A-F]{6}$/.test(hex)) {
      setMarkNote('The colour code must look like #B98A55.');
      return;
    }
    setSavingMark(true);
    setMarkNote('');
    try {
      const position = point ?? { x: 50, y: 50 };
      const next = [
        ...annotations,
        {
          photo: photoToken,
          x: Math.round(position.x * 10) / 10,
          y: Math.round(position.y * 10) / 10,
          label: markLabel.trim(),
          colourName: markName.trim(),
          colourHex: hex,
        },
      ];
      const updated = await api.updateAnnotations(orderId, next);
      setAnnotations(updated.annotations ?? next);
      setPoint(null);
      setMarkLabel('');
      setMarkName('');
      setMarkHex('');
      setMarkNote('Mark saved. Ask in the chat to design with your marks.');
      setChatNote('Marks saved. Ask for a design and they will be printed as loupes.');
    } catch (saveError) {
      setMarkNote(saveError instanceof Error ? saveError.message : 'The mark could not be saved.');
    } finally {
      setSavingMark(false);
    }
  };

  const removeMark = async (mark: MarkedDetail) => {
    const next = annotations.filter(
      (entry) =>
        !(
          entry.photo === mark.photo &&
          entry.x === mark.x &&
          entry.y === mark.y &&
          entry.label === mark.label
        ),
    );
    try {
      const updated = await api.updateAnnotations(orderId, next);
      setAnnotations(updated.annotations ?? next);
    } catch {
      // Keep the local list if the server refuses.
    }
  };

  const send = async () => {
    const message = input.trim();
    if (message === '' || sending) return;
    const outgoing: ChatLine[] = [...lines, { role: 'user', content: message }];
    setLines(outgoing);
    setInput('');
    setSending(true);
    setChatNote('');
    setProgressLabel('Understanding your request');
    const progressTimer = setInterval(() => {
      api
        .assistantProgress(sessionId)
        .then((result) => {
          if (!result.progress) return;
          setProgressLabel(
            `${result.progress.label} · ${Math.floor(result.progress.elapsedMs / 1000)}s`
          );
        })
        .catch(() => {});
    }, 1500);
    try {
      const result = await api.assistant({
        sessionId,
        orderId,
        messages: outgoing.map((line) => ({ role: line.role, content: line.content })),
      });
      if (result.sessionId) setSessionId(result.sessionId);
      setLines([...outgoing, { role: 'assistant', content: result.reply }]);
      if (result.render) {
        setRender(result.render);
        setView('brochure');
        setPageIndex(0);
      }
      void load();
    } catch (sendError) {
      setLines([...outgoing, { role: 'assistant', content: sendError instanceof Error ? sendError.message : 'The assistant could not answer.' }]);
    } finally {
      clearInterval(progressTimer);
      setSending(false);
      setProgressLabel('');
    }
  };

  const loupeSize = 120;
  const loupeZoom = 4;

  return (
    <View style={[styles.screen, { paddingTop: Math.max(insets.top, 8) }]}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close workspace" onPress={() => router.back()}>
          <Text style={styles.close}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>
          {order ? `${order.orderNo} · ${order.title || 'Brochure workspace'}` : 'Brochure workspace'}
        </Text>
        <View style={styles.headerActions}>
          {render ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Open brochure PDF" onPress={() => router.push(`/orders/${orderId}`)}>
              <Text style={styles.headerAction}>Order</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.copper} />
          <Text style={[text.caption, styles.centerText]}>Opening the pages.</Text>
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={[text.body, styles.centerText]}>{error}</Text>
        </View>
      ) : (
        <View style={[styles.split, narrow && styles.splitNarrow]}>
          {/* Left: document viewer */}
          <View style={[styles.viewer, narrow && styles.viewerNarrow]}>
            <View style={styles.viewerBar}>
              <View style={styles.tabs}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Project pages"
                  onPress={() => {
                    setView('project');
                    setPageIndex(0);
                  }}
                  style={[styles.tab, view === 'project' && styles.tabActive]}>
                  <Text style={[styles.tabLabel, view === 'project' && styles.tabLabelActive]}>Project pages</Text>
                </Pressable>
                {brochurePages.length > 0 ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Brochure pages"
                    onPress={() => {
                      setView('brochure');
                      setPageIndex(0);
                    }}
                    style={[styles.tab, view === 'brochure' && styles.tabActive]}>
                    <Text style={[styles.tabLabel, view === 'brochure' && styles.tabLabelActive]}>Brochure</Text>
                  </Pressable>
                ) : null}
              </View>
              <View style={styles.zoomRow}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Zoom out"
                  onPress={() => setZoom((value) => Math.max(1, value - 0.5))}
                  style={styles.zoomButton}>
                  <Text style={styles.zoomLabel}>−</Text>
                </Pressable>
                <Text style={[text.caption, styles.zoomValue]}>{Math.round(zoom * 100)}%</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Zoom in"
                  onPress={() => setZoom((value) => Math.min(3, value + 0.5))}
                  style={styles.zoomButton}>
                  <Text style={styles.zoomLabel}>+</Text>
                </Pressable>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Add mark"
                onPress={() => {
                  setMarksOpen(true);
                  setView('project');
                  setPoint(null);
                  setMarkNote('Tap the area on the page, then name the detail and colour.');
                }}
                style={styles.addMarkButton}>
                <Text style={styles.addMarkLabel}>Add mark</Text>
              </Pressable>
            </View>

            <View
              style={styles.stage}
              onLayout={(event) => setStage(event.nativeEvent.layout)}>
              {active ? (
                <ScrollView style={styles.stageScroll} contentContainerStyle={styles.stageInner}>
                  <ScrollView horizontal contentContainerStyle={styles.stageInner}>
                    <View style={{ width: stageWidth * zoom }}>
                      <Pressable
                        accessibilityLabel="Page canvas"
                        onPress={(event) => {
                          if (!marksOpen) return;
                          const native = event.nativeEvent as unknown as {
                            locationX?: number;
                            locationY?: number;
                            offsetX?: number;
                            offsetY?: number;
                          };
                          const localX = Number(native.locationX ?? native.offsetX);
                          const localY = Number(native.locationY ?? native.offsetY);
                          const bounds = stage.width > 0 ? stage : { width: 1, height: 1 };
                          setPoint({
                            x: Number.isFinite(localX) ? Math.min(100, Math.max(0, (localX / bounds.width) * 100)) : 50,
                            y: Number.isFinite(localY) ? Math.min(100, Math.max(0, (localY / bounds.height) * 100)) : 50,
                          });
                        }}>
                        <Image
                          source={{ uri: fileUrl(active.pageUrl) }}
                          style={[styles.pageImage, { width: stageWidth * zoom, height: (stageWidth * zoom) / 0.72 }]}
                          resizeMode="contain"
                          accessibilityLabel={active.label}
                        />
                        {view === 'project'
                          ? annotations
                              .filter((mark) => mark.photo === photoToken)
                              .map((mark) => (
                                <View
                                  key={`${mark.photo}-${mark.x}-${mark.y}-${mark.label}`}
                                  style={[styles.pin, { left: `${mark.x}%`, top: `${mark.y}%` }]}>
                                  <View style={[styles.pinDot, { backgroundColor: mark.colourHex }]} />
                                  <Text style={styles.pinLabel}>{`${mark.label} · ${mark.colourName} ${mark.colourHex}`}</Text>
                                </View>
                              ))
                          : null}
                        {point ? (
                          <View style={[styles.pin, { left: `${point.x}%`, top: `${point.y}%` }]}>
                            <View style={styles.pointDot} />
                          </View>
                        ) : null}
                        {marksOpen && point && active && view === 'project' ? (
                          <View
                            style={[
                              styles.loupe,
                              {
                                left: `${Math.min(74, Math.max(2, point.x))}%`,
                                top: `${Math.min(64, Math.max(2, point.y))}%`,
                                width: loupeSize,
                                height: loupeSize,
                              },
                            ]}>
                            <Image
                              source={{ uri: fileUrl(active.pageUrl) }}
                              style={{
                                position: 'absolute',
                                width: stageWidth * zoom * loupeZoom,
                                height: (stageWidth * zoom) / 0.72 * loupeZoom,
                                left: -(point.x / 100) * stageWidth * zoom * loupeZoom + loupeSize / 2,
                                top: -(point.y / 100) * ((stageWidth * zoom) / 0.72) * loupeZoom + loupeSize / 2,
                              }}
                              resizeMode="contain"
                            />
                            <View style={styles.loupeRing} />
                          </View>
                        ) : null}
                      </Pressable>
                    </View>
                  </ScrollView>
                </ScrollView>
              ) : (
                <View style={styles.center}>
                  <Text style={[text.caption, styles.centerText]}>
                    No pages on this order yet. Attach a picture or a PDF in the chat.
                  </Text>
                </View>
              )}
            </View>

            {activePages.length > 1 ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.strip} contentContainerStyle={styles.stripInner}>
                {activePages.map((page, index) => (
                  <Pressable
                    key={`${page.pageUrl}-${index}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Page ${index + 1}`}
                    onPress={() => {
                      setPageIndex(index);
                      setPoint(null);
                    }}
                    style={[styles.thumb, pageIndex === index && styles.thumbActive]}>
                    <Image source={{ uri: fileUrl(page.pageUrl) }} style={styles.thumbImage} resizeMode="cover" />
                    <Text style={styles.thumbLabel}>{index + 1}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            ) : null}

            <View style={styles.viewerFoot}>
              <Text style={[text.caption, styles.viewerFootText]}>
                {active ? active.label : 'No page'} · Page {activePages.length === 0 ? 0 : pageIndex + 1} of {activePages.length}
              </Text>
              <Text style={[text.caption, styles.viewerFootText]}>
                {view === 'project' ? 'Tap Add mark to place a loupe.' : 'Printed brochure page.'}
              </Text>
            </View>
          </View>

          {/* Right: chat and marks */}
          <View style={[styles.panel, narrow && styles.panelNarrow]}>
            <View style={styles.panelHead}>
              <Text style={styles.panelTitle}>Studio desk</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Toggle marks" onPress={() => setMarksOpen((open) => !open)}>
                <Text style={styles.panelLink}>{marksOpen ? 'Hide marks' : `Marks (${annotations.length})`}</Text>
              </Pressable>
            </View>

            <ScrollView style={styles.chatScroll} contentContainerStyle={styles.chatInner}>
              {lines.length === 0 ? (
                <Text style={[text.caption, styles.chatHint]}>
                  Ask for a brochure, or tell me what to change. Marks you add on the left are saved to the order.
                </Text>
              ) : (
                lines.map((line, index) => (
                  <View
                    key={`${line.role}-${index}`}
                    style={[styles.chatLine, line.role === 'user' ? styles.chatLineUser : styles.chatLineAssistant]}>
                    <Text style={[text.body, styles.chatText]}>{line.content}</Text>
                  </View>
                ))
              )}
              {sending ? (
                <Text style={[text.caption, styles.chatHint]}>
                  {progressLabel || 'Working on the brochure. This can take a few minutes.'}
                </Text>
              ) : null}
              {chatNote ? <Text style={[text.caption, styles.chatHint]}>{chatNote}</Text> : null}
            </ScrollView>

            {marksOpen ? (
              <View style={styles.marks}>
                <Text style={[text.caption, styles.marksTitle]}>Marked details</Text>
                {annotations.length === 0 ? (
                  <Text style={[text.caption, styles.marksEmpty]}>
                    None yet. Tap the page, then fill the detail, colour and code.
                  </Text>
                ) : (
                  annotations.map((mark) => (
                    <View key={`${mark.photo}-${mark.x}-${mark.y}-${mark.label}`} style={styles.markRow}>
                      <View style={[styles.swatch, { backgroundColor: mark.colourHex }]} />
                      <Text style={[text.caption, styles.markText]} numberOfLines={2}>
                        {`${mark.label} · ${mark.colourName} ${mark.colourHex} · ${mark.photo}`}
                      </Text>
                      <Pressable accessibilityRole="button" accessibilityLabel={`Delete mark ${mark.label}`} onPress={() => void removeMark(mark)}>
                        <Text style={styles.markDelete}>×</Text>
                      </Pressable>
                    </View>
                  ))
                )}
                <View style={styles.markForm}>
                  {point ? (
                    <Text style={[text.caption, styles.markPointText]}>
                      {`Point ${point.x.toFixed(1)}% / ${point.y.toFixed(1)}%`}
                    </Text>
                  ) : null}
                  <TextInput
                    style={styles.markInput}
                    placeholder="Detail, e.g. brass handle"
                    placeholderTextColor={colors.muted}
                    value={markLabel}
                    onChangeText={setMarkLabel}
                  />
                  <TextInput
                    style={styles.markInput}
                    placeholder="Colour name"
                    placeholderTextColor={colors.muted}
                    value={markName}
                    onChangeText={setMarkName}
                  />
                  <TextInput
                    style={styles.markInput}
                    placeholder="#B98A55"
                    placeholderTextColor={colors.muted}
                    value={markHex}
                    onChangeText={(next) => setMarkHex(next.toUpperCase().replace(/[^#0-9A-F]/g, '').slice(0, 7))}
                    autoCapitalize="characters"
                  />
                  {markNote ? <Text style={[text.caption, styles.markNote]}>{markNote}</Text> : null}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Save mark"
                    disabled={savingMark}
                    onPress={() => void saveMark()}
                    style={styles.saveMarkButton}>
                    <Text style={styles.saveMarkLabel}>{savingMark ? 'Saving' : 'Save mark'}</Text>
                  </Pressable>
                </View>
              </View>
            ) : null}

            <View style={styles.composer}>
              <TextInput
                style={styles.composerInput}
                placeholder="Ask for a change or a new brochure"
                placeholderTextColor={colors.muted}
                value={input}
                onChangeText={setInput}
                multiline
                onSubmitEditing={() => void send()}
              />
              <Pressable accessibilityRole="button" accessibilityLabel="Send" onPress={() => void send()} style={styles.sendButton}>
                <Text style={styles.sendLabel}>{sending ? '…' : 'Send'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingBottom: 10 },
  close: { color: colors.copper, fontSize: 13, fontWeight: '600' },
  title: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  headerActions: { flexDirection: 'row', gap: 12 },
  headerAction: { color: colors.copper, fontSize: 13, fontWeight: '600' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  centerText: { color: colors.muted, textAlign: 'center', marginTop: 8 },
  split: { flex: 1, flexDirection: 'row', gap: 10, paddingHorizontal: 10, paddingBottom: 10 },
  splitNarrow: { flexDirection: 'column' },
  viewer: { flex: 3, backgroundColor: '#141210', borderRadius: 14, overflow: 'hidden' },
  viewerNarrow: { flex: 2 },
  viewerBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: 10, backgroundColor: '#1C1A17' },
  tabs: { flexDirection: 'row', gap: 6 },
  tab: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8 },
  tabActive: { backgroundColor: colors.copper },
  tabLabel: { color: '#D8D2C8', fontSize: 11.5, fontWeight: '600' },
  tabLabelActive: { color: '#FFFFFF' },
  zoomRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  zoomButton: { width: 26, height: 26, borderRadius: 13, backgroundColor: '#2A2722', alignItems: 'center', justifyContent: 'center' },
  zoomLabel: { color: '#F4E7DA', fontSize: 15, lineHeight: 18 },
  zoomValue: { color: '#D8D2C8', width: 42, textAlign: 'center' },
  addMarkButton: { backgroundColor: colors.copper, borderRadius: 999, paddingVertical: 7, paddingHorizontal: 14 },
  addMarkLabel: { color: '#FFFFFF', fontSize: 11.5, fontWeight: '700' },
  stage: { flex: 1, overflow: 'hidden' },
  stageScroll: { flex: 1 },
  stageInner: { alignItems: 'center', justifyContent: 'center' },
  pageImage: { backgroundColor: '#FFFFFF' },
  pin: { position: 'absolute', alignItems: 'center', marginLeft: -13, marginTop: -13 },
  pinDot: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: '#FFFFFF' },
  pointDot: { width: 22, height: 22, borderRadius: 11, borderWidth: 3, borderColor: '#F4C77B', backgroundColor: 'rgba(166,94,34,0.4)' },
  pinLabel: { marginTop: 2, backgroundColor: 'rgba(20,18,16,0.88)', color: '#F4E7DA', fontSize: 9, paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4, overflow: 'hidden' },
  loupe: { position: 'absolute', borderRadius: 999, overflow: 'hidden', borderWidth: 3, borderColor: '#F4C77B', backgroundColor: '#141210' },
  loupeRing: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 999, borderWidth: 1, borderColor: 'rgba(255,255,255,0.65)' },
  strip: { maxHeight: 92, backgroundColor: '#1C1A17' },
  stripInner: { padding: 8, gap: 8 },
  thumb: { width: 60, borderRadius: 6, overflow: 'hidden', borderWidth: 2, borderColor: 'transparent' },
  thumbActive: { borderColor: '#F4C77B' },
  thumbImage: { width: '100%', height: 56, backgroundColor: '#FFFFFF' },
  thumbLabel: { color: '#D8D2C8', fontSize: 9, textAlign: 'center', paddingVertical: 2 },
  viewerFoot: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#1C1A17' },
  viewerFootText: { color: '#B8AFA3', fontSize: 10 },
  panel: { flex: 1, backgroundColor: colors.surface, borderRadius: 14, overflow: 'hidden' },
  panelNarrow: { flex: 1, marginTop: 8 },
  panelHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.faint },
  panelTitle: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  panelLink: { color: colors.copper, fontSize: 11.5, fontWeight: '600' },
  chatScroll: { flex: 1 },
  chatInner: { padding: 12, gap: 8 },
  chatHint: { color: colors.muted, lineHeight: 18 },
  chatLine: { borderRadius: 12, paddingHorizontal: 10, paddingVertical: 8, maxWidth: '94%' },
  chatLineUser: { alignSelf: 'flex-end', backgroundColor: colors.copperSoft },
  chatLineAssistant: { alignSelf: 'flex-start', backgroundColor: colors.fill },
  chatText: { color: colors.ink, fontSize: 12.5, lineHeight: 18 },
  marks: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.faint, padding: 10, maxHeight: 300 },
  marksTitle: { color: colors.ink, fontWeight: '700', marginBottom: 6 },
  marksEmpty: { color: colors.muted, lineHeight: 16 },
  markRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5 },
  swatch: { width: 16, height: 16, borderRadius: 4 },
  markText: { flex: 1, color: colors.ink, lineHeight: 15 },
  markDelete: { color: colors.muted, fontSize: 16, paddingHorizontal: 4 },
  markForm: { gap: 6, marginTop: 8 },
  markPointText: { color: colors.copper, fontWeight: '600' },
  markInput: { borderWidth: 1, borderColor: colors.faint, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 7, color: colors.ink, fontSize: 12, backgroundColor: '#FFFFFF' },
  markNote: { color: colors.muted, lineHeight: 15 },
  saveMarkButton: { alignSelf: 'flex-start', backgroundColor: colors.ink, borderRadius: 999, paddingVertical: 7, paddingHorizontal: 14 },
  saveMarkLabel: { color: '#FFFFFF', fontSize: 11.5, fontWeight: '700' },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.faint },
  composerInput: { flex: 1, maxHeight: 90, minHeight: 36, borderWidth: 1, borderColor: colors.faint, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, color: colors.ink, fontSize: 12.5 },
  sendButton: { backgroundColor: colors.copper, borderRadius: 999, paddingVertical: 9, paddingHorizontal: 14 },
  sendLabel: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
});
