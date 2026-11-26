import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react';
import {
  ActivityIndicator,
  Animated,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  api,
  errorMessage,
  fileUrl,
  type IntakeMessage,
  type OrderAttachment,
  type ReviewPhoto,
  type Render,
} from '@/lib/api';
import { openUrl } from '@/lib/actions';
import { copyText } from '@/lib/clipboard';
import { colors, space, text } from '@/lib/theme';
import { TamilLine } from '@/components/TamilLine';

type Bubble =
  | {
      id: string;
      role: 'user' | 'assistant';
      kind: 'text';
      content: string;
      at?: string;
      failed?: boolean;
      attachments?: OrderAttachment[];
    }
  | {
      id: string;
      role: 'assistant';
      kind: 'brochure';
      content: string;
      at?: string;
      orderId: string;
      orderNo: string;
      render: Render;
    }
  | {
      id: string;
      role: 'assistant';
      kind: 'review';
      content: string;
      at?: string;
      photos: ReviewPhoto[];
    };




let counter = 0;
const nextId = () => {
  counter += 1;
  return `m${counter}`;
};

const stamp = () =>
  new Date().toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

const ESSENTIAL_TOTAL = 1;
const MAX_UPLOAD_MB = 50;

// The intake speaks in long friendly labels ("the piece, for example a
// wardrobe"). The composer needs short chips.
const SHORT_LABELS: Record<string, string> = {
  'customer name': 'Customer name',
  'the piece, for example a wardrobe or a bench': 'Piece',
  'the room': 'Room',
  width: 'Width',
  height: 'Height',
  depth: 'Depth',
  'number of shutters': 'Shutters',
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function shortLabel(label: string): string {
  return SHORT_LABELS[label] ?? label.replace(/^the /, '').slice(0, 18);
}

function SuggestionCard({
  glyph,
  title,
  body,
  onPress,
}: {
  glyph: string;
  title: string;
  body: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      style={({ pressed }) => [styles.suggestionCard, pressed && styles.sendPressed]}>
      <View style={styles.suggestionGlyph}>
        <Text style={styles.suggestionGlyphLabel}>{glyph}</Text>
      </View>
      <Text style={styles.suggestionTitle}>{title}</Text>
      <Text style={styles.suggestionBody}>{body}</Text>
    </Pressable>
  );
}

function TypingDots({ label }: { label: string }) {
  const [dots] = useState(() => [
    new Animated.Value(0.35),
    new Animated.Value(0.35),
    new Animated.Value(0.35),
  ]);
  useEffect(() => {
    const loops = dots.map((value, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(index * 140),
          Animated.timing(value, { toValue: 1, duration: 380, useNativeDriver: true }),
          Animated.timing(value, { toValue: 0.35, duration: 380, useNativeDriver: true }),
          Animated.delay((2 - index) * 140),
        ])
      )
    );
    loops.forEach((loop) => loop.start());
    return () => loops.forEach((loop) => loop.stop());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <View style={styles.typingRow}>
      <View style={styles.dots}>
        {dots.map((value, index) => (
          <Animated.View key={index} style={[styles.dot, { opacity: value }]} />
        ))}
      </View>
      <Text style={[text.caption, styles.typingText]}>{label}</Text>
    </View>
  );
}

export default function ChatScreen() {
  const params = useLocalSearchParams<{ orderId?: string }>();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const compact = width < 560;
  const scroll = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const frameRef = useRef<any>(null);
  const inputRef = useRef<any>(null);
  const anim = useRef(new Animated.Value(0)).current;
  const sendingRef = useRef(false);
  const atBottomRef = useRef(true);
  const previousBubbleCount = useRef(0);

  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [missing, setMissing] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  // True between the picture review and the client's answer about what to
  // magnify. The brochure waits for that answer.
  const [awaitingReview, setAwaitingReview] = useState(false);
  const reviewDraft = useRef<Record<string, string> | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [cooking, setCooking] = useState(false);
  const [orderCreated, setOrderCreated] = useState(false);
  const [activeOrderId, setActiveOrderId] = useState<string | null>(null);
  const [pendingMarks, setPendingMarks] = useState<
    { photo: string; x: number; y: number; label: string; colourName: string; colourHex: string }[]
  >([]);
  const [activeOrderNo, setActiveOrderNo] = useState('');
  const [createFailed, setCreateFailed] = useState(false);
  const [orderFiles, setOrderFiles] = useState<OrderAttachment[]>([]);
  const [pendingFiles, setPendingFiles] = useState<OrderAttachment[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [modelReady, setModelReady] = useState<boolean | null>(null);
  // The Pi agent drives the chat when the machine has it switched on. If a turn
  // fails, the session falls back to the deterministic flow instead of dying.
  const [assistantEnabled, setAssistantEnabled] = useState(false);
  const [assistantSessionId, setAssistantSessionId] = useState<string>(() => `chat-${Date.now()}`);
  const [outputFormat, setOutputFormat] = useState<'pamphlet' | 'brochure'>('pamphlet');
  const [assistantProgress, setAssistantProgress] = useState<{
    label: string;
    elapsedMs: number;
    steps: string[];
    events: { label: string; at: number }[];
  } | null>(null);
  const progressTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const assistantBroken = useRef(false);
  const [skipping, setSkipping] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [inputHeight, setInputHeight] = useState(38);

  useEffect(() => {
    // Only follow the conversation when a message arrives and the reader is
    // already at the bottom. Mounting or expanding the cover strip must not
    // move the chat away from its greeting.
    const grew = bubbles.length > previousBubbleCount.current;
    previousBubbleCount.current = bubbles.length;
    if (!grew || !atBottomRef.current) return;
    const timer = setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 80);
    return () => clearTimeout(timer);
  }, [bubbles.length, sending, cooking]);

  // Coming from History: reopen the order and its Pi conversation, so the
  // studio can carry on editing in the same chat instead of starting over.
  useEffect(() => {
    const orderId = typeof params.orderId === 'string' ? params.orderId : '';
    if (orderId === '') return;
    let active = true;
    Promise.all([api.getOrder(orderId), api.assistantSession(orderId), api.listRenders()])
      .then(([order, session, renders]) => {
        if (!active) return;
        const latest = renders
          .filter((render) => render.orderId === orderId && render.kind === 'ai')
          .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0];
        const visibleMessages = session.messages
          .map((message) => {
            const marker = '\n\nStudio: ';
            const index = message.content.lastIndexOf(marker);
            if (index >= 0) return { ...message, content: message.content.slice(index + marker.length).trim() };
            return message;
          })
          .filter((message) => !message.content.startsWith('Conversation so far:'));
        const rendered = visibleMessages.map((message) => ({
          id: nextId(),
          role: message.role,
          kind: 'text' as const,
          content: message.content,
          at: stamp(),
        }));
        setBubbles(rendered);
        if (latest) {
          setBubbles((current) => [
            ...current,
            {
              id: nextId(),
              role: 'assistant',
              kind: 'brochure',
              content: 'The brochure for this order.',
              at: stamp(),
              orderId,
              orderNo: order.orderNo,
              render: latest,
            },
          ]);
        }
        setActiveOrderId(orderId);
        setActiveOrderNo(order.orderNo);
        setOrderCreated(true);
        setOrderFiles(order.attachments ?? []);
        if (order.designFormat) setOutputFormat(order.designFormat);
        setAssistantSessionId(session.sessionId ?? `chat-${Date.now()}`);
        previousBubbleCount.current = Math.max(1, rendered.length);
        atBottomRef.current = true;
        setAtBottom(true);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [params.orderId]);

  // The chat stays mounted when the studio opens Settings, so the model status
  // is read again every time the chat is focused. Without this the header kept
  // saying "Add model" and the chat kept asking for a key that was already
  // saved, until the application was restarted.
  const refreshModelStatus = useCallback(() => {
    let active = true;
    api
      .health()
      .then((health) => {
        if (active) setAssistantEnabled(Boolean(health.assistant) && !assistantBroken.current);
      })
      .catch(() => {
        if (active) setAssistantEnabled(false);
      });
    api
      .getLlmSettings()
      .then((settings) => {
        if (active) setModelReady(settings.endpoint !== '' && settings.model !== '' && settings.hasKey);
      })
      .catch(() => {
        if (active) setModelReady(null);
      });
    return () => {
      active = false;
    };
  }, []);

  useFocusEffect(refreshModelStatus);

  useEffect(() => {
    if (!activeOrderId || pendingMarks.length === 0) return;
    let active = true;
    api
      .getOrder(activeOrderId)
      .then((order) =>
        api.updateAnnotations(activeOrderId, [...(order.annotations ?? []), ...pendingMarks])
      )
      .then(() => {
        if (active) setPendingMarks([]);
      })
      .catch(() => {
        // The mark stays queued and is retried on the next order change.
      });
    return () => {
      active = false;
    };
  }, [activeOrderId, pendingMarks]);

  useEffect(() => {
    anim.setValue(0);
    Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0, duration: 900, useNativeDriver: true }),
      ])
    ).start();
    return () => anim.stopAnimation();
  }, [anim]);

  const history = useCallback((): IntakeMessage[] => {
    return bubbles
      .filter((bubble) => bubble.kind === 'text')
      .map((bubble) => ({ role: bubble.role, content: bubble.content }));
  }, [bubbles]);

  const copyMessage = useCallback(async (bubble: Bubble) => {
    if (bubble.kind !== 'text') return;
    const ok = await copyText(bubble.content);
    if (!ok) return;
    setCopiedId(bubble.id);
    setTimeout(() => setCopiedId(null), 1600);
  }, []);

  const scrollToBottom = useCallback(() => {
    atBottomRef.current = true;
    setAtBottom(true);
    scroll.current?.scrollToEnd({ animated: true });
  }, []);

  const onChatScroll = useCallback((event: any) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distance = contentSize.height - contentOffset.y - layoutMeasurement.height;
    const nearBottom = distance < 80;
    atBottomRef.current = nearBottom;
    setAtBottom(nearBottom);
  }, []);

  const startNewChat = useCallback(() => {
    if (sending || cooking) return;
    router.setParams({ orderId: undefined });
    setBubbles([
    ]);
    setDraft({});
    setMissing([]);
    setReady(false);
    setOrderCreated(false);
    setCopiedId(null);
    setCreateFailed(false);
    setOrderFiles([]);
    setPendingFiles([]);
    setInput('');
    previousBubbleCount.current = 1;
    atBottomRef.current = true;
    setAtBottom(true);
    setTimeout(() => scroll.current?.scrollTo({ y: 0, animated: false }), 40);
  }, [cooking, sending]);

  // Files dropped or pasted into the window go through the same upload route as
  // the picker. Useful on the desktop app where dragging a photo in is faster.
  const uploadBrowserFiles = useCallback(
    async (files: any[]) => {
      if (files.length === 0 || uploadingFiles) return;
      setUploadingFiles(true);
      const uploaded: OrderAttachment[] = [];
      const failures: string[] = [];
      try {
        for (const file of files) {
          if (file.size && file.size > MAX_UPLOAD_MB * 1024 * 1024) {
            failures.push(`${file.name ?? 'A file'} is larger than ${MAX_UPLOAD_MB} MB`);
            continue;
          }
          try {
            const dataUrl: string = await new Promise((resolve, reject) => {
              const reader = new (globalThis as any).FileReader();
              reader.onload = () => resolve(String(reader.result ?? ''));
              reader.onerror = () => reject(new Error('The file could not be read.'));
              reader.readAsDataURL(file);
            });
            const base64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
            const stored = await api.uploadFile(
              base64,
              file.name ?? 'attachment',
              file.type || 'application/octet-stream'
            );
            uploaded.push({
              url: stored.url,
              name: stored.name ?? file.name ?? 'attachment',
              contentType: stored.contentType,
              bytes: stored.bytes,
            });
          } catch {
            failures.push(`${file.name ?? 'A file'} could not be uploaded`);
          }
        }
        if (uploaded.length > 0) setPendingFiles((current) => [...current, ...uploaded]);
        if (failures.length > 0) {
          setBubbles((current) => [
            ...current,
            {
              id: nextId(),
              role: 'assistant',
              kind: 'text',
              content: `I could not attach everything:\n${failures.map((line) => `- ${line}`).join('\n')}`,
              at: stamp(),
              failed: true,
            },
          ]);
        }
      } finally {
        setUploadingFiles(false);
      }
    },
    [uploadingFiles]
  );

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const node = frameRef.current as unknown as HTMLElement | null;
    if (!node) return;
    const onDragOver = (event: any) => {
      event.preventDefault();
      setDragging(true);
    };
    const onDragLeave = () => setDragging(false);
    const onDrop = (event: any) => {
      event.preventDefault();
      setDragging(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) void uploadBrowserFiles(files);
    };
    const onPaste = (event: any) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length > 0) {
        event.preventDefault();
        void uploadBrowserFiles(files);
      }
    };
    node.addEventListener('dragover', onDragOver);
    node.addEventListener('dragleave', onDragLeave);
    node.addEventListener('drop', onDrop);
    node.addEventListener('paste', onPaste);
    return () => {
      node.removeEventListener('dragover', onDragOver);
      node.removeEventListener('dragleave', onDragLeave);
      node.removeEventListener('drop', onDrop);
      node.removeEventListener('paste', onPaste);
    };
  }, [uploadBrowserFiles]);

  // Attach anything: photos, plans, PDFs, spreadsheets. There is no type filter
  // and no client side size limit; the server stores the file as it is.
  const pickFiles = useCallback(async () => {
    if (sending || cooking || uploadingFiles) return;
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        multiple: true,
        base64: true,
        copyToCacheDirectory: true,
      });
      if (picked.canceled || !picked.assets || picked.assets.length === 0) return;
      setUploadingFiles(true);
      const uploaded: OrderAttachment[] = [];
      const failures: string[] = [];
      for (const asset of picked.assets) {
        if (asset.size && asset.size > MAX_UPLOAD_MB * 1024 * 1024) {
          failures.push(`${asset.name ?? 'A file'} is larger than ${MAX_UPLOAD_MB} MB`);
          continue;
        }
        try {
          let data = asset.base64 ?? '';
          if (data === '') {
            if (Platform.OS === 'web') {
              data = asset.uri.includes(',') ? asset.uri.slice(asset.uri.indexOf(',') + 1) : asset.uri;
            } else {
              data = await FileSystem.readAsStringAsync(asset.uri, {
                encoding: FileSystem.EncodingType.Base64,
              });
            }
          }
          const stored = await api.uploadFile(
            data,
            asset.name ?? 'attachment',
            asset.mimeType ?? 'application/octet-stream'
          );
          uploaded.push({
            url: stored.url,
            name: stored.name ?? asset.name ?? 'attachment',
            contentType: stored.contentType,
            bytes: stored.bytes,
          });
        } catch {
          failures.push(`${asset.name ?? 'A file'} could not be uploaded`);
        }
      }
      if (uploaded.length > 0) setPendingFiles((current) => [...current, ...uploaded]);
      if (failures.length > 0) {
        setBubbles((current) => [
          ...current,
          {
            id: nextId(),
            role: 'assistant',
            kind: 'text',
            content: `I could not attach everything:\n${failures.map((line) => `- ${line}`).join('\n')}`,
            at: stamp(),
            failed: true,
          },
        ]);
      }
    } catch (error) {
      setBubbles((current) => [
        ...current,
        {
          id: nextId(),
          role: 'assistant',
          kind: 'text',
          content: errorMessage(error, 'The file could not be uploaded. Try again.'),
          at: stamp(),
          failed: true,
        },
      ]);
    } finally {
      setUploadingFiles(false);
    }
  }, [cooking, sending, uploadingFiles]);

  // One chat is one order. As soon as the intake says it has enough, the order
  // is created, the copy is written and the voucher is rendered.
  const createOrderFor = useCallback(
    async (
      orderDraft: Record<string, string>,
      files: OrderAttachment[] = orderFiles,
      direction = '',
    ) => {
      setCooking(true);
      setCreateFailed(false);
      try {
        const customer = await api.createCustomer({ name: orderDraft.customerName });
        const order = await api.createOrder({
          customerId: customer.id,
          attachments: files,
          title: orderDraft.title,
          room: orderDraft.room,
        } as Parameters<typeof api.createOrder>[0]);

        const brief =
          orderDraft.brief ??
          history()
            .filter((message) => message.role === 'user')
            .map((message) => message.content)
            .join(' ')
            .slice(0, 2000);

        // The model designs and typesets the brochure from the order and the
        // uploaded photographs. There is no template and no silent fallback.
        let render: Render | null = null;
        let designError: string | null = null;
        try {
          const designed = await api.aiBrochure(order.id, {
            ...(brief ? { brief } : {}),
            ...(direction.trim() ? { direction: direction.trim() } : {}),
          });
          render = designed.render;
        } catch (error) {
          designError = errorMessage(error, 'The brochure could not be designed.');
        }

        const finished: Bubble[] = [];
        if (render) {
          finished.push({
            id: nextId(),
            role: 'assistant',
            kind: 'brochure',
            content: `Order ${order.orderNo} is created and the brochure is ready.`,
            at: stamp(),
            orderId: order.id,
            orderNo: order.orderNo,
            render,
          });
        }
        if (designError) {
          finished.push({
            id: nextId(),
            role: 'assistant',
            kind: 'text',
            content: `Order ${order.orderNo} is saved, but the brochure could not be designed yet. ${designError} Ask me to design it again and I will retry.`,
            at: stamp(),
            failed: true,
          });
        }
        setBubbles((current) => [...current, ...finished]);
        setOrderCreated(true);
        setActiveOrderId(order.id);
        setActiveOrderNo(order.orderNo);
        setDraft({});
        setMissing([]);
        setReady(false);
        setCreateFailed(false);
        setOrderFiles([]);
        setPendingFiles([]);
      } catch (error) {
        setCreateFailed(true);
        setBubbles((current) => [
          ...current,
          {
            id: nextId(),
            role: 'assistant',
            kind: 'text',
            content: errorMessage(error, 'I could not create the order. Try again.'),
            at: stamp(),
            failed: true,
          },
        ]);
      } finally {
        setCooking(false);
      }
    },
    [history, orderFiles],
  );

  // One conversational turn through the Pi agent. Everything the agent does is
  // reflected back into the existing chat bubbles and order state.
  const startProgressPolling = useCallback((sessionId: string) => {
    if (progressTimer.current) clearInterval(progressTimer.current);
    progressTimer.current = setInterval(() => {
      api
        .assistantProgress(sessionId)
        .then((result) => {
          const progress = result.progress;
          if (!progress) return;
          setAssistantProgress({
            label: progress.label,
            elapsedMs: progress.elapsedMs,
            steps: progress.steps.map((step) => step.label),
            events: (progress.events ?? []).map((event) => ({ label: event.label, at: event.at })),
          });
        })
        .catch(() => {});
    }, 500);
  }, []);

  const stopProgressPolling = useCallback(() => {
    if (progressTimer.current) clearInterval(progressTimer.current);
    progressTimer.current = null;
    setAssistantProgress(null);
  }, []);

  const sendWithAssistant = useCallback(async () => {
    if (assistantBroken.current) throw new Error('assistant off');
    const content = input.trim();
    const files = pendingFiles;
    const history = bubbles
      .filter((bubble) => bubble.kind === 'text')
      .map((bubble) => ({
        role: bubble.role,
        content: bubble.kind === 'text' ? bubble.content : '',
      }))
      .filter((message) => message.content.trim() !== '');
    const message = content !== '' ? content : `Attached: ${files.map((file) => file.name).join(', ')}`;
    const conversation = [...history, { role: 'user' as const, content: message }];
    const attachments = activeOrderId
      ? files
      : [...orderFiles.filter((file) => !files.some((next) => next.url === file.url)), ...files];

    sendingRef.current = true;
    setSending(true);
    startProgressPolling(assistantSessionId);
    let result;
    try {
      result = await api.assistant({
        messages: conversation,
        ...(activeOrderId ? { orderId: activeOrderId } : {}),
        sessionId: assistantSessionId,
        format: outputFormat,
        ...(attachments.length > 0 ? { attachments } : {}),
      });
    } catch (error) {
      stopProgressPolling();
      sendingRef.current = false;
      setSending(false);
      throw error;
    }

    const at = stamp();
    const reply =
      result.reply && result.reply.trim() !== ''
        ? result.reply.trim()
        : result.render
          ? 'The brochure is ready.'
          : result.orderNo
            ? `Order ${result.orderNo} is created.`
            : 'Noted.';
    const nextOrderId = result.orderId ?? result.order?.id ?? activeOrderId ?? null;
    const nextOrderNo = result.orderNo ?? result.order?.orderNo ?? activeOrderNo;
    const userBubble: Bubble = {
      id: nextId(),
      role: 'user',
      kind: 'text',
      content: message,
      at,
      ...(files.length > 0 ? { attachments: files } : {}),
    };
    const assistantBubble: Bubble = {
      id: nextId(),
      role: 'assistant',
      kind: 'text',
      content: reply,
      at: stamp(),
    };
    const render = result.render ?? null;
    const reviewBubble: Bubble[] =
      Array.isArray(result.review) && result.review.length > 0
        ? [
            {
              id: nextId(),
              role: 'assistant' as const,
              kind: 'review' as const,
              content:
                'Before I design, here is what I read from your picture: the marks worth making and the colours inside them. Nothing is magnified or cropped; the whole picture stays as it is.',
              at: stamp(),
              photos: result.review,
            },
          ]
        : [];
    setBubbles((current) => [
      ...current,
      userBubble,
      assistantBubble,
      ...reviewBubble,
      ...(render && nextOrderId
        ? [
            {
              id: nextId(),
              role: 'assistant' as const,
              kind: 'brochure' as const,
              content: activeOrderId ? 'Updated brochure.' : 'The brochure is ready.',
              at: stamp(),
              orderId: nextOrderId,
              orderNo: nextOrderNo,
              render,
            },
          ]
        : []),
    ]);
    setInput('');
    setInputHeight(38);
    setPendingFiles([]);
    if (nextOrderId) {
      setOrderCreated(true);
      setActiveOrderId(nextOrderId);
      setActiveOrderNo(nextOrderNo);
      setOrderFiles([]);
    } else {
      setOrderFiles(attachments);
    }
    if (result.sessionId) setAssistantSessionId(result.sessionId);
    stopProgressPolling();
    sendingRef.current = false;
    setSending(false);
    atBottomRef.current = true;
    setAtBottom(true);
  }, [activeOrderId, activeOrderNo, assistantSessionId, bubbles, input, orderFiles, pendingFiles, startProgressPolling, stopProgressPolling]);

  const send = useCallback(async () => {
    const content = input.trim();
    if ((content === '' && pendingFiles.length === 0) || sending || cooking || skipping || uploadingFiles) return;
    if (sendingRef.current) return;
    // Pi is the only chat path.
    try {
      await sendWithAssistant();
    } catch (error) {
      assistantBroken.current = true;
      setBubbles((current) => [
        ...current,
        {
          id: nextId(),
          role: 'assistant',
          kind: 'text',
          content: errorMessage(error, 'The studio assistant could not answer. Try again.'),
          at: stamp(),
          failed: true,
        },
      ]);
    }
    return;
  }, [cooking, input, pendingFiles.length, sendWithAssistant, sending, skipping, uploadingFiles]);

  const skipMissing = useCallback(async () => {
    if (!missing.length || sending || cooking || skipping) return;
    setSkipping(true);
    try {
      const result = await api.intake(history(), draft, undefined, missing);
      setDraft(result.draft);
      setMissing(result.missing);
      setReady(result.ready);
      setBubbles((current) => [
        ...current,
        { id: nextId(), role: 'assistant', kind: 'text', content: result.reply, at: stamp() },
      ]);
      if (result.ready) {
        // Pictures and PDF sheets both join the review; a PDF is shown through
        // its first page, which the server rasterises.
        const pictures = orderFiles.filter((file) => {
          const type = String(file.contentType ?? '');
          return type.startsWith('image/') || type === 'application/pdf' || /\.pdf$/i.test(file.url);
        });
        if (pictures.length > 0) {
          try {
            const review = await api.analyzeImages(pictures.map((file) => file.url));
            reviewDraft.current = result.draft;
            setAwaitingReview(true);
            if (review.photos.length > 0) {
              setBubbles((current) => [
                ...current,
                {
                  id: nextId(),
                  role: 'assistant' as const,
                  kind: 'review' as const,
                  content:
                    'Before I design, here is what I read from your picture: the marks worth making and the colours inside them. Nothing is magnified or cropped; the whole picture stays as it is.',
                  at: stamp(),
                  photos: review.photos,
                },
              ]);
            }
            return;
          } catch {
            // A picture that cannot be read must not stop the order.
          }
        }
        await createOrderFor(result.draft, orderFiles);
      }
    } catch (error) {
      setBubbles((current) => [
        ...current,
        {
          id: nextId(),
          role: 'assistant',
          kind: 'text',
          content: errorMessage(error, 'I could not mark those details. Try again.'),
          at: stamp(),
          failed: true,
        },
      ]);
    } finally {
      setSkipping(false);
    }
  }, [cooking, createOrderFor, draft, history, missing, orderFiles, sending, skipping]);

  const retryCreate = useCallback(async () => {
    if (cooking || sending || !createFailed) return;
    await createOrderFor(draft, orderFiles);
  }, [cooking, createFailed, createOrderFor, draft, orderFiles, sending]);

  const fieldCount = Object.keys(draft).length;
  const busy = sending || cooking || skipping;

  return (
    <KeyboardAvoidingView
      style={styles.page}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}>
      <View ref={frameRef} style={[styles.frame, { paddingTop: insets.top + space.lg }, dragging && styles.frameDragging]}>
        <View style={styles.header}>
          <View style={styles.headerBrand}>
            <Image
              source={require('@/assets/images/logo.png')}
              style={styles.brandMarkCompact}
              resizeMode="contain"
              accessibilityLabel="Jacob Design Studio"
            />
            <Text style={styles.headerTitle}>Jacob Studio</Text>
          </View>
          <View style={styles.headerActions}>
            {modelReady === false ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Add your language model"
                onPress={() => router.push('/settings')}
                style={({ pressed }) => [styles.modelPill, styles.modelPillOff, pressed && styles.sendPressed]}>
                <View style={[styles.statusDot, styles.statusDotOff]} />
                <Text style={styles.modelPillLabel}>Add model</Text>
              </Pressable>
            ) : modelReady && !compact ? (
              <View style={[styles.modelPill, styles.modelPillOn]}>
                <View style={[styles.statusDot, styles.statusDotOn]} />
                <Text style={styles.modelPillLabel}>Model ready</Text>
              </View>
            ) : null}
            {bubbles.length > 1 || orderCreated ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="New order chat"
                onPress={startNewChat}
                style={({ pressed }) => [styles.headerAction, pressed && styles.sendPressed]}>
                <Text style={styles.headerActionLabel}>New order</Text>
              </Pressable>
            ) : null}
          </View>
        </View>

        <ScrollView
          ref={scroll}
          style={styles.scroll}
          contentContainerStyle={[
            styles.scrollContent,
            bubbles.length === 0 && !busy ? styles.scrollWelcome : null,
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          onScroll={onChatScroll}
          scrollEventThrottle={48}>
          {bubbles.length === 0 && !busy ? (
            <View style={styles.welcome}>
              <Image
                source={require('@/assets/images/logo.png')}
                style={styles.welcomeMark}
                resizeMode="contain"
                accessibilityLabel="Jacob Design Studio"
              />
              <Text style={styles.welcomeTitle}>How can I help with this brochure?</Text>
              <Text style={styles.welcomeSub}>
                Send the customer&apos;s words and pictures. I will read every picture, build the order and design the
                pages.
              </Text>
              <View style={styles.welcomeChips}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Paste the customer message"
                  onPress={() => inputRef.current?.focus()}
                  style={({ pressed }) => [styles.welcomeChip, pressed && styles.sendPressed]}>
                  <Text style={styles.welcomeChipLabel}>Paste a message</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Add pictures or a plan"
                  onPress={() => void pickFiles()}
                  style={({ pressed }) => [styles.welcomeChip, pressed && styles.sendPressed]}>
                  <Text style={styles.welcomeChipLabel}>Add pictures</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Say what to magnify"
                  onPress={() => inputRef.current?.focus()}
                  style={({ pressed }) => [styles.welcomeChip, pressed && styles.sendPressed]}>
                  <Text style={styles.welcomeChipLabel}>What to magnify</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            bubbles.map((bubble) => (
              <BubbleView
                key={bubble.id}
                bubble={bubble}
                copied={copiedId === bubble.id}
                onCopy={copyMessage}
                activeOrderId={activeOrderId}
                onMarksSaved={() => setInput("Design with my marked details.")}
                onMarkQueued={(mark) => setPendingMarks((current) => [...current, mark])}
                onMarkRemoved={(mark) => {
                  setPendingMarks((current) =>
                    current.filter(
                      (queued) =>
                        !(
                          queued.photo === mark.photo &&
                          queued.label === mark.label &&
                          Math.abs(queued.x - mark.x) <= 3 &&
                          Math.abs(queued.y - mark.y) <= 3
                        )
                    )
                  );
                  if (activeOrderId) {
                    void api
                      .getOrder(activeOrderId)
                      .then((order) => {
                        const existing = order.annotations ?? [];
                        const next = existing.filter(
                          (saved) =>
                            !(
                              saved.photo === mark.photo &&
                              Math.abs(Number(saved.x) - mark.x) <= 3 &&
                              Math.abs(Number(saved.y) - mark.y) <= 3
                            )
                        );
                        if (next.length !== existing.length) {
                          return api.updateAnnotations(activeOrderId, next);
                        }
                        return undefined;
                      })
                      .catch(() => {});
                  }
                }}
              />
            ))
          )}
          {busy ? (
            <View style={styles.rowLeft}>
              <View style={styles.avatar}>
                <Text style={styles.avatarLabel}>JD</Text>
              </View>
              <View style={[styles.bubble, styles.bubbleAssistant]}>
                <TypingDots
                  label={
                    sending
                      ? assistantProgress
                        ? `${assistantProgress.label} · ${Math.floor(assistantProgress.elapsedMs / 1000)}s`
                        : 'Working on the brochure'
                      : cooking
                        ? 'Creating the order'
                        : skipping
                          ? 'Marking it to be confirmed'
                          : 'Reading'
                  }
                />
                {sending && assistantProgress && assistantProgress.events.length > 0 ? (
                  <View style={styles.agentFeed} accessibilityLiveRegion="polite">
                    <Text style={styles.agentFeedTitle}>What the studio is doing</Text>
                    {assistantProgress.events.slice(-6).map((event, eventIndex) => (
                      <View key={`${event.at}-${eventIndex}`} style={styles.agentFeedRow}>
                        <View style={styles.agentFeedDot} />
                        <Text style={styles.agentFeedText} numberOfLines={2}>
                          {event.label}
                        </Text>
                        <Text style={styles.agentFeedTime}>
                          {`${Math.max(0, Math.round((event.at - (assistantProgress.events[0]?.at ?? event.at)) / 1000))}s`}
                        </Text>
                      </View>
                    ))}
                  </View>
                ) : null}
              </View>
            </View>
          ) : null}


        </ScrollView>

        {!atBottom ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Scroll to latest message"
            onPress={scrollToBottom}
            style={styles.scrollDown}>
            <Text style={styles.scrollDownLabel}>Latest ↓</Text>
          </Pressable>
        ) : null}

        <View style={[styles.draftBar, { paddingBottom: Math.max(insets.bottom, space.sm) }]}>
          {modelReady === false ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open model settings"
              onPress={() => router.push('/settings')}
              style={({ pressed }) => [styles.modelBanner, pressed && styles.sendPressed]}>
              <View style={styles.modelBannerText}>
                <Text style={styles.modelBannerTitle}>Add your language model to start</Text>
                <Text style={styles.modelBannerBody}>
                  Paste the endpoint, model and key in Settings. It is stored on this machine.
                </Text>
              </View>
              <Text style={styles.modelBannerAction}>Open Settings</Text>
            </Pressable>
          ) : null}
          {orderCreated ? (
            <View style={styles.statusCard}>
              <View style={styles.statusTop}>
                <View style={styles.statusCheck}>
                  <Text style={styles.statusCheckLabel}>✓</Text>
                </View>
                <Text style={styles.statusTitle}>Order created</Text>
                <Text style={styles.statusHint}>Ask for a change below, or press New order</Text>
              </View>
            </View>
          ) : missing.length > 0 || fieldCount > 0 ? (
            <View style={styles.statusCard}>
              <View style={styles.statusTop}>
                <Text style={styles.statusTitle}>
                  {awaitingReview
                    ? 'Pictures reviewed'
                    : ready
                      ? 'Ready to build'
                      : `${Math.min(ESSENTIAL_TOTAL, Math.max(0, ESSENTIAL_TOTAL - missing.length))} of ${ESSENTIAL_TOTAL} details`}
                </Text>
                <View style={styles.progressTrack}>
                  <View
                    style={[
                      styles.progressFill,
                      { width: `${Math.round((Math.min(ESSENTIAL_TOTAL, Math.max(0, ESSENTIAL_TOTAL - missing.length)) / ESSENTIAL_TOTAL) * 100)}%` },
                      ready && styles.progressFillReady,
                    ]}
                  />
                </View>
                <Text style={styles.statusPct}>
                  {Math.round((Math.min(ESSENTIAL_TOTAL, Math.max(0, ESSENTIAL_TOTAL - missing.length)) / ESSENTIAL_TOTAL) * 100)}%
                </Text>
              </View>
              {awaitingReview ? (
                <Text style={styles.statusHint}>
                  Pick the details you want magnified, then the brochure is designed.
                </Text>
              ) : ready ? (
                <Text style={styles.statusHint}>
                  The order and brochure are being made automatically. Check the thread for the PDF.
                </Text>
              ) : (
                <View style={styles.missingWrap}>
                  <Text style={styles.missingTitle}>Still needed</Text>
                  {missing.slice(0, 6).map((label) => (
                    <Pressable
                      key={label}
                      accessibilityRole="button"
                      accessibilityLabel={`Missing ${shortLabel(label)}, focus the message box`}
                      onPress={() => inputRef.current?.focus()}
                      style={({ pressed }) => [styles.missingChip, pressed && styles.sendPressed]}>
                      <Text style={styles.missingChipText}>{shortLabel(label)}</Text>
                    </Pressable>
                  ))}
                  <Text style={styles.missingOr}>or</Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="I do not know these details, mark them to be confirmed"
                    onPress={() => void skipMissing()}
                    disabled={busy}
                    style={({ pressed }) => [styles.skipChip, pressed && styles.sendPressed]}>
                    <Text style={styles.skipChipText}>I don&apos;t know</Text>
                  </Pressable>
                </View>
              )}
            </View>
          ) : null}

          {pendingFiles.length > 0 || uploadingFiles ? (
            <View style={styles.attachTray}>
              {pendingFiles.map((file) => (
                <View key={file.url} style={styles.attachCard}>
                  {file.contentType.startsWith('image/') ? (
                    <Image
                      source={{ uri: fileUrl(file.url) }}
                      style={styles.attachThumb}
                      resizeMode="cover"
                    />
                  ) : (
                    <View style={styles.attachIcon}>
                      <Text style={styles.attachIconLabel}>
                        {(file.name.split('.').pop() ?? 'FILE').slice(0, 4).toUpperCase()}
                      </Text>
                    </View>
                  )}
                  <View style={styles.attachMeta}>
                    <Text numberOfLines={1} style={styles.attachName}>
                      {file.name}
                    </Text>
                    <Text style={styles.attachSize}>{formatBytes(file.bytes)}</Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${file.name}`}
                    onPress={() =>
                      setPendingFiles((current) => current.filter((entry) => entry.url !== file.url))
                    }
                    style={({ pressed }) => [styles.attachRemove, pressed && styles.sendPressed]}>
                    <Text style={styles.attachRemoveLabel}>×</Text>
                  </Pressable>
                </View>
              ))}
              {uploadingFiles ? (
                <View style={[styles.attachCard, styles.attachUploading]}>
                  <ActivityIndicator size="small" color={colors.copper} />
                  <Text style={styles.attachUploadingText}>Uploading</Text>
                </View>
              ) : null}
            </View>
          ) : null}

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
            <Text style={styles.formatHint}>
              {outputFormat === 'pamphlet' ? 'Small take home piece' : 'Larger art directed book'}
            </Text>
          </View>

          <View style={styles.composer}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                pendingFiles.length > 0
                  ? `Attach files, ${pendingFiles.length} attached`
                  : 'Attach files'
              }
              onPress={() => void pickFiles()}
              disabled={busy || uploadingFiles}
              style={({ pressed }) => [
                styles.plus,
                pendingFiles.length > 0 && styles.plusActive,
                (busy || uploadingFiles) && styles.sendDisabled,
                pressed && styles.sendPressed,
              ]}>
              {uploadingFiles ? (
                <ActivityIndicator size="small" color={colors.copper} />
              ) : (
                <View style={styles.plusGlyph} pointerEvents="none">
                  <View
                    style={[
                      styles.plusH,
                      pendingFiles.length > 0 && styles.plusBarActive,
                    ]}
                  />
                  <View
                    style={[
                      styles.plusV,
                      pendingFiles.length > 0 && styles.plusBarActive,
                    ]}
                  />
                </View>
              )}
              {pendingFiles.length > 0 && !uploadingFiles ? (
                <View style={styles.plusBadge} pointerEvents="none">
                  <Text style={styles.plusBadgeLabel}>{pendingFiles.length}</Text>
                </View>
              ) : null}
            </Pressable>
            <TextInput
              ref={inputRef}
              value={input}
              onChangeText={setInput}
              placeholder={
                orderCreated
                  ? 'Ask for a change to this order'
                  : 'Ask anything about this brochure'
              }
              placeholderTextColor={colors.faint}
              multiline
              style={[styles.input, { height: inputHeight }]}
              accessibilityLabel="Message the studio"
              onContentSizeChange={(event) => {
                const next = Math.min(150, Math.max(38, event.nativeEvent.contentSize.height));
                setInputHeight(next);
              }}
              onKeyPress={(event) => {
                const native = event.nativeEvent as unknown as { key?: string; shiftKey?: boolean };
                const composing = (event.nativeEvent as unknown as { isComposing?: boolean }).isComposing;
                if (Platform.OS === 'web' && native.key === 'Enter' && !native.shiftKey && !composing) {
                  event.preventDefault?.();
                  void send();
                }
              }}
              onSubmitEditing={() => void send()}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={busy ? 'Sending message' : 'Send message'}
              onPress={() => void send()}
              disabled={busy || uploadingFiles || (input.trim() === '' && pendingFiles.length === 0)}
              style={({ pressed }) => [
                styles.send,
                (busy || (input.trim() === '' && pendingFiles.length === 0)) && styles.sendDisabled,
                pressed && styles.sendPressed,
              ]}>
              {busy ? (
                <ActivityIndicator size="small" color={colors.surface} />
              ) : (
                <Text style={styles.sendLabel}>↑</Text>
              )}
            </Pressable>
          </View>
          <View style={styles.composerHint}>
            <Text style={styles.composerHintText}>
              {compact
                ? 'Attach photos or plans with + · Send when ready'
                : Platform.OS === 'web'
                  ? dragging
                    ? 'Drop to attach'
                    : 'Enter to send · Shift+Enter for a new line · Drop or paste files'
                  : 'Attach photos, plans or PDFs with +'}
            </Text>
          </View>

          {createFailed ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Create the order"
              onPress={() => void retryCreate()}
              disabled={busy}
              style={({ pressed }) => [
                styles.cook,
                styles.cookReady,
                busy && styles.sendDisabled,
                pressed && styles.sendPressed,
              ]}>
              <Text style={[styles.cookLabel, styles.cookLabelReady]}>Create the order</Text>
              <Text style={[styles.cookHint, styles.cookHintReady]}>
                The details are enough, the last attempt failed
              </Text>
            </Pressable>
          ) : null}
        </View>
        {dragging ? (
          <View style={styles.dropOverlay} pointerEvents="none">
            <Text style={styles.dropOverlayTitle}>Drop to attach</Text>
            <Text style={styles.dropOverlayBody}>Photos, plans, PDFs, anything the customer sent</Text>
          </View>
        ) : null}
      </View>
    </KeyboardAvoidingView>
  );
}

function ReviewPhotoCard({
  photo,
  index,
  orderId,
  onMarksSaved,
  onMarkQueued,
  onMarkRemoved,
}: {
  photo: ReviewPhoto;
  index: number;
  orderId: string | null;
  onMarksSaved?: () => void;
  onMarkRemoved?: (mark: {
    photo: string;
    x: number;
    y: number;
    label: string;
  }) => void;
  onMarkQueued?: (mark: {
    photo: string;
    x: number;
    y: number;
    label: string;
    colourName: string;
    colourHex: string;
  }) => void;
}) {
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const [markOpen, setMarkOpen] = useState(false);
  const [markFrame, setMarkFrame] = useState({ width: 0, height: 0 });
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const [markLabel, setMarkLabel] = useState('');
  const [markName, setMarkName] = useState('');
  const [markHex, setMarkHex] = useState('');
  const [markNote, setMarkNote] = useState('');
  const [markSuggestions, setMarkSuggestions] = useState<
    { label: string; x: number; y: number; colourHex: string; colourName: string }[]
  >([]);
  const [sampling, setSampling] = useState(false);
  const [hiddenMarks, setHiddenMarks] = useState<string[]>([]);
  const markKeyFor = (candidate: { x: number; y: number; label: string }, candidateIndex: number) =>
    `${candidateIndex}-${candidate.x}-${candidate.y}-${candidate.label}`;
  const visibleCandidates = photo.analysis.candidates.filter(
    (candidate, candidateIndex) => !hiddenMarks.includes(markKeyFor(candidate, candidateIndex))
  );
  const removeMark = (candidate: { x: number; y: number; label: string }, candidateIndex: number) => {
    setHiddenMarks((current) =>
      current.includes(markKeyFor(candidate, candidateIndex))
        ? current
        : [...current, markKeyFor(candidate, candidateIndex)]
    );
    onMarkRemoved?.({
      photo: `photo${index + 1}`,
      x: candidate.x,
      y: candidate.y,
      label: candidate.label,
    });
  };
  const [marking, setMarking] = useState(false);
  const ready = frame.width > 0 && frame.height > 0;
  const samplePoint = async (position: { x: number; y: number }) => {
    setSampling(true);
    setMarkSuggestions([]);
    try {
      const sample = await api.visualSample({
        imageUrl: photo.previewUrl ?? photo.url,
        x: position.x,
        y: position.y,
      });
      setMarkHex(sample.hex);
      setMarkName(sample.name);
      if (sample.label) setMarkLabel(sample.label);
      setMarkSuggestions(sample.suggestions ?? []);
    } catch {
      // Fall back to the candidates already read from this picture.
      const candidates = (photo.analysis.candidates ?? []).slice(0, 3).map((candidate) => ({
        label: candidate.label,
        x: candidate.x,
        y: candidate.y,
        colourHex: candidate.hex ?? '',
        colourName: candidate.name ?? 'Colour',
      }));
      const named = candidates.filter((candidate) => candidate.colourHex !== '');
      if (named.length > 0) {
        let nearest = named[0];
        let best = Number.POSITIVE_INFINITY;
        for (const candidate of named) {
          const distance = Math.hypot(candidate.x - position.x, candidate.y - position.y);
          if (distance < best) {
            best = distance;
            nearest = candidate;
          }
        }
        setMarkHex(nearest.colourHex);
        setMarkName(nearest.colourName);
        setMarkLabel(nearest.label);
      }
      setMarkSuggestions(named);
    } finally {
      setSampling(false);
    }
  };

  const saveMark = async () => {
    if (markLabel.trim() === '' || markName.trim() === '') {
      setMarkNote('Enter the detail and the colour name.');
      return;
    }
    const hex = (markHex.trim() === '' ? '#B98A55' : markHex.trim()).toUpperCase();
    if (!/^#[0-9A-F]{6}$/.test(hex)) {
      setMarkNote('The colour code must look like #B98A55.');
      return;
    }
    const position = point ?? { x: 50, y: 50 };
    if (!orderId) {
      // The review happens before the order exists. Keep the mark in the chat
      // and attach it as soon as the order is created.
      onMarkQueued?.({
        photo: `photo${index + 1}`,
        x: Math.round(position.x * 10) / 10,
        y: Math.round(position.y * 10) / 10,
        label: markLabel.trim(),
        colourName: markName.trim(),
        colourHex: hex,
      });
      setMarkNote('Saved to this chat. It will be attached when the order is created.');
      setMarking(false);
      return;
    }
    setMarking(true);
    try {
      const order = await api.getOrder(orderId);
      const existing = order.annotations ?? [];
      await api.updateAnnotations(orderId, [
        ...existing,
        {
          photo: `photo${index + 1}`,
          x: Math.round(position.x * 10) / 10,
          y: Math.round(position.y * 10) / 10,
          label: markLabel.trim(),
          colourName: markName.trim(),
          colourHex: hex,
        },
      ]);
      setMarkNote('Saved. Press Send to design with your marked details.');
      onMarksSaved?.();
    } catch (error) {
      setMarkNote(error instanceof Error ? error.message : 'Marks could not be saved.');
    } finally {
      setMarking(false);
    }
  };

  return (
    <>
      <View style={styles.reviewPhoto}>
      <Text style={[text.caption, styles.reviewPhotoLabel]} numberOfLines={1}>
        {`${photo.label ?? `Picture ${index + 1}`} · ${photo.analysis.orientation}`}
      </Text>
      <View
        style={styles.reviewFrameBox}
        onLayout={(event) => setFrame(event.nativeEvent.layout)}>
        <View style={styles.reviewFrame}>
          <Image
            source={{ uri: fileUrl(photo.previewUrl ?? photo.url) }}
            style={styles.reviewImage}
            resizeMode="cover"
            accessibilityLabel={`Review picture ${index + 1}`}
          />
        </View>
        {ready
          ? visibleCandidates.map((candidate, candidateIndex) => {
              const cx = Math.min(94, Math.max(6, candidate.x));
              const cy = Math.min(92, Math.max(8, candidate.y));
              const distances = [
                { side: 'left', value: cx },
                { side: 'right', value: 100 - cx },
                { side: 'top', value: cy },
                { side: 'bottom', value: 100 - cy },
              ].sort((left, right) => left.value - right.value);
              const side = distances[0].side;
              const leader =
                side === 'right'
                  ? { left: `${cx}%`, top: `${cy}%`, width: `${(100 - cx).toFixed(1)}%`, borderTopWidth: 1, borderTopColor: '#0D0D0D', borderStyle: 'dashed' as const }
                  : side === 'left'
                    ? { left: '0%', top: `${cy}%`, width: `${cx.toFixed(1)}%`, borderTopWidth: 1, borderTopColor: '#0D0D0D', borderStyle: 'dashed' as const }
                    : side === 'top'
                      ? { left: `${cx}%`, top: '0%', height: `${cy.toFixed(1)}%`, borderLeftWidth: 1, borderLeftColor: '#0D0D0D', borderStyle: 'dashed' as const }
                      : { left: `${cx}%`, top: `${cy}%`, height: `${(100 - cy).toFixed(1)}%`, borderLeftWidth: 1, borderLeftColor: '#0D0D0D', borderStyle: 'dashed' as const };
              return (
                <View key={candidate.id} pointerEvents="none">
                  <View testID={`review-point-${candidateIndex + 1}`} style={[styles.reviewPointRing, { left: `${cx}%`, top: `${cy}%` }]}>
                    <Text style={styles.reviewPointRingLabel}>{candidateIndex + 1}</Text>
                  </View>
                  <View style={[styles.reviewLeader, leader]} />
                </View>
              );
            })
          : null}
      </View>
      {photo.insight?.summary ? (
        <Text style={[text.caption, styles.reviewReadingLine]} numberOfLines={2}>
          {`What the model reads: ${photo.insight.summary}`}
        </Text>
      ) : null}
      {photo.analysis.candidates.length > 0 ? (
        <View style={styles.reviewSectionHead}>
          <Text style={styles.reviewSectionLabel}>Marks on this picture</Text>
          {visibleCandidates.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Clear marks on picture ${index + 1}`}
              onPress={() => {
                photo.analysis.candidates.forEach((candidate, candidateIndex) =>
                  removeMark(candidate, candidateIndex)
                );
              }}>
              <Text style={styles.reviewClearMarks}>Clear marks</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {visibleCandidates.length > 0 ? (
        <View style={styles.reviewLegend}>
          {visibleCandidates.map((candidate, candidateIndex) => (
            <View
              key={`${candidate.id}-legend`}
              testID={`review-legend-${candidateIndex + 1}`}
              style={styles.reviewLegendItem}>
              <Text style={styles.reviewLegendNumber}>{candidateIndex + 1}</Text>
              <View style={[styles.reviewLegendSwatch, { backgroundColor: candidate.hex }]} />
              <Text style={[text.caption, styles.reviewLegendText]} numberOfLines={1}>
                {`${candidate.name} ${candidate.hex}`}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove mark ${candidateIndex + 1} on picture ${index + 1}`}
                hitSlop={8}
                onPress={() => {
                  const originalIndex = photo.analysis.candidates.indexOf(candidate);
                  removeMark(candidate, originalIndex);
                }}>
                <Text style={styles.reviewRemoveMark}>×</Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      <Text style={styles.reviewSectionLabel}>Palette read from the picture</Text>
      <View style={styles.reviewPalette}>
        {photo.analysis.palette.map((swatch) => (
          <View key={swatch.hex} style={styles.reviewSwatch}>
            <View style={[styles.reviewChip, { backgroundColor: swatch.hex }]} />
            <Text style={[text.caption, styles.reviewChipName]} numberOfLines={1}>
              {swatch.name}
            </Text>
            <Text style={[text.caption, styles.reviewChipHex]} numberOfLines={1}>
              {swatch.hex}
            </Text>
          </View>
        ))}
      </View>
    </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Mark an area on picture ${index + 1}`}
        onPress={() => setMarkOpen(true)}
        style={styles.markOpenButton}>
        <Text style={styles.markOpenLabel}>Mark an area</Text>
      </Pressable>
      <Modal visible={markOpen} transparent animationType="fade" onRequestClose={() => setMarkOpen(false)}>
        <View style={styles.markBackdrop}>
          <View style={styles.markCard}>
            <View style={styles.markHead}>
              <Text style={styles.markTitle}>Mark a detail</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Close marks" onPress={() => setMarkOpen(false)}>
                <Text style={styles.markClose}>Close</Text>
              </Pressable>
            </View>
            <Text style={[text.caption, styles.markHint]}>
              Tap the exact area on the picture. It becomes a marked detail with the colour you name.
            </Text>
            <View
              style={styles.markImageBox}
              onLayout={(event) => setMarkFrame(event.nativeEvent.layout)}>
              <Image
                source={{ uri: fileUrl(photo.previewUrl ?? photo.url) }}
                style={styles.markImage}
                resizeMode="contain"
              />
              <Pressable
                style={StyleSheet.absoluteFill}
                onPress={(event) => {
                  const native = event.nativeEvent as unknown as {
                    locationX?: number;
                    locationY?: number;
                    offsetX?: number;
                    offsetY?: number;
                  };
                  const localX = Number(native.locationX ?? native.offsetX);
                  const localY = Number(native.locationY ?? native.offsetY);
                  if (markFrame.width <= 0 || markFrame.height <= 0) return;
                  const position = {
                    x: Number.isFinite(localX)
                      ? Math.min(100, Math.max(0, (localX / markFrame.width) * 100))
                      : 50,
                    y: Number.isFinite(localY)
                      ? Math.min(100, Math.max(0, (localY / markFrame.height) * 100))
                      : 50,
                  };
                  setPoint(position);
                  void samplePoint(position);
                }}
              />
              {point ? (
                <View style={[styles.markPoint, { left: `${point.x}%`, top: `${point.y}%` }]} />
              ) : null}
            </View>
            {sampling ? (
              <Text style={[text.caption, styles.markNote]}>Reading the colour at that point.</Text>
            ) : null}
            {markSuggestions.length > 0 ? (
              <View style={styles.markSuggestWrap}>
                <Text style={[text.caption, styles.markSuggestTitle]}>Suggestions for this point</Text>
                <View style={styles.markSuggestRow}>
                  {markSuggestions.map((suggestion) => (
                    <Pressable
                      key={`${suggestion.label}-${suggestion.x}`}
                      accessibilityRole="button"
                      accessibilityLabel={`Use ${suggestion.label} ${suggestion.colourName}`}
                      onPress={() => {
                        setPoint({ x: suggestion.x, y: suggestion.y });
                        setMarkLabel(suggestion.label);
                        setMarkName(suggestion.colourName);
                        setMarkHex(suggestion.colourHex);
                      }}
                      style={({ pressed }) => [styles.markSuggestChip, pressed && styles.sendPressed]}>
                      <View style={[styles.markSuggestSwatch, { backgroundColor: suggestion.colourHex || '#EFE7D8' }]} />
                      <Text style={styles.markSuggestText}>
                        {`${suggestion.label} · ${suggestion.colourName} ${suggestion.colourHex}`}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ) : null}
            <View style={styles.markFields}>
              <TextInput
                style={styles.markField}
                placeholder="Detail, e.g. brass handle"
                placeholderTextColor={colors.muted}
                value={markLabel}
                onChangeText={setMarkLabel}
              />
              <TextInput
                style={styles.markField}
                placeholder="Colour name"
                placeholderTextColor={colors.muted}
                value={markName}
                onChangeText={setMarkName}
              />
              <TextInput
                style={styles.markField}
                placeholder="#B98A55"
                placeholderTextColor={colors.muted}
                value={markHex}
                onChangeText={(next) => setMarkHex(next.toUpperCase().replace(/[^#0-9A-F]/g, '').slice(0, 7))}
                autoCapitalize="characters"
              />
            </View>
            {markNote ? <Text style={[text.caption, styles.markNote]}>{markNote}</Text> : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Save marked detail"
              disabled={marking || markLabel.trim() === '' || markName.trim() === ''}
              onPress={() => void saveMark()}
              style={[
                styles.markSave,
                (marking || markLabel.trim() === '' || markName.trim() === '') && styles.markSaveDisabled,
              ]}>
              <Text style={styles.markSaveLabel}>{marking ? 'Saving' : 'Save marked detail'}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
}


function BubbleView({
  bubble,
  copied,
  onCopy,
  activeOrderId,
  onMarksSaved,
  onMarkQueued,
  onMarkRemoved,
}: {
  bubble: Bubble;
  copied: boolean;
  onCopy: (bubble: Bubble) => void;
  activeOrderId: string | null;
  onMarksSaved: () => void;
  onMarkQueued: (mark: {
    photo: string;
    x: number;
    y: number;
    label: string;
    colourName: string;
    colourHex: string;
  }) => void;
  onMarkRemoved: (mark: { photo: string; x: number; y: number; label: string }) => void;
}) {
  if (bubble.kind === 'review') {
    return (
      <View style={styles.rowLeft}>
        <View style={styles.avatar}>
          <Text style={styles.avatarLabel}>JD</Text>
        </View>
        <View style={styles.bubbleColumn}>
          <View style={[styles.bubble, styles.bubbleAssistant, styles.reviewBubble]}>
            <Text style={[text.body, styles.reviewTitle]}>{bubble.content}</Text>
            {bubble.photos.map((photo, photoIndex) => (
              <ReviewPhotoCard
                key={photo.url}
                photo={photo}
                index={photoIndex}
                orderId={activeOrderId}
                onMarksSaved={onMarksSaved}
                onMarkQueued={onMarkQueued}
                onMarkRemoved={onMarkRemoved}
              />
            ))}
            <Text style={[text.caption, styles.reviewHint]}>
              Reply with the numbers you want magnified, name a detail, or say you choose.
            </Text>
          </View>
        </View>
      </View>
    );
  }
  if (bubble.kind === 'brochure') {
    const firstPage = bubble.render.pageUrls?.[0];
    return (
      <View style={styles.rowLeft}>
        <View style={styles.avatar}>
          <Text style={styles.avatarLabel}>JD</Text>
        </View>
        <View style={styles.bubbleColumn}>
          <View style={[styles.bubble, styles.bubbleAssistant, styles.brochure]}>
            <Text style={[text.body, styles.brochureTitle]}>{bubble.content}</Text>
            <Text style={[text.caption, styles.brochureMeta]}>
              {bubble.orderNo} · {bubble.render.pageCount} pages
            </Text>
            {firstPage ? (
              <Image
                source={{ uri: fileUrl(firstPage) }}
                style={styles.preview}
                resizeMode="contain"
                accessibilityLabel="First page of the brochure"
              />
            ) : null}
            <View style={styles.brochureActions}>
              <SmallAction
                label="Open PDF"
                onPress={() => void openUrl(fileUrl(bubble.render.pdfUrl))}
              />
              <SmallAction
                label="Open order"
                onPress={() => router.push(`/orders/${bubble.orderId}`)}
              />
            </View>
          </View>
          <Text style={styles.metaTime}>{bubble.at ?? ''}</Text>
        </View>
      </View>
    );
  }

  const isUser = bubble.role === 'user';
  return (
    <View style={isUser ? styles.rowRight : styles.rowLeft}>
      {isUser ? null : (
        <View style={styles.avatar}>
          <Text style={styles.avatarLabel}>JD</Text>
        </View>
      )}
      <View style={[styles.bubbleColumn, isUser && styles.bubbleColumnUser]}>
        <View
          style={[
            styles.bubble,
            isUser ? styles.bubbleUser : styles.bubbleAssistant,
            bubble.failed ? styles.bubbleFailed : null,
          ]}>
          <Text style={[text.body, isUser ? styles.userText : styles.assistantText]}>
            {bubble.content}
          </Text>
          {bubble.attachments && bubble.attachments.length > 0 ? (
            <View style={styles.bubbleFiles}>
              {bubble.attachments.map((file) => (
                <Pressable
                  key={file.url}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${file.name}`}
                  onPress={() => void openUrl(fileUrl(file.url))}
                  style={[styles.fileChip, isUser && styles.fileChipUser]}>
                  {file.contentType.startsWith('image/') ? (
                    <Image
                      source={{ uri: fileUrl(file.url) }}
                      style={styles.fileThumb}
                      resizeMode="cover"
                    />
                  ) : null}
                  <Text
                    numberOfLines={1}
                    style={[styles.fileChipName, isUser && styles.fileChipNameUser]}>
                    {file.name}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
        <View style={[styles.metaRow, isUser && styles.metaRowUser]}>
          <Text style={styles.metaTime}>{bubble.at ?? ''}</Text>
          {!isUser ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={copied ? 'Copied' : 'Copy message'}
              onPress={() => void onCopy(bubble)}>
              <Text style={[styles.metaAction, copied && styles.metaActionDone]}>
                {copied ? 'Copied' : 'Copy'}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function SmallAction({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.smallAction, pressed && styles.sendPressed]}>
      <Text style={styles.smallActionLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  frameDragging: {
    borderWidth: 2,
    borderColor: colors.copper,
    borderRadius: 18,
  },
  avatar: {
    width: 0,
    height: 0,
    overflow: 'hidden',
    opacity: 0,
    marginTop: 0,
  },
  avatarLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.4,
    color: colors.copper,
  },
  brandMarkCompact: {
    width: 24,
    height: 24,
    borderRadius: 6,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: -0.2,
    color: '#0D0D0D',
  },
  scrollWelcome: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  welcome: {
    alignItems: 'center',
    paddingTop: 48,
    paddingBottom: 24,
    paddingHorizontal: 12,
    maxWidth: 620,
    alignSelf: 'center',
  },
  welcomeMark: {
    width: 46,
    height: 46,
    borderRadius: 12,
  },
  welcomeTitle: {
    marginTop: 18,
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '600',
    letterSpacing: -0.6,
    color: '#0D0D0D',
    textAlign: 'center',
  },
  welcomeSub: {
    marginTop: 10,
    fontSize: 14,
    lineHeight: 21,
    color: '#6E6E73',
    textAlign: 'center',
    maxWidth: 520,
  },
  welcomeChips: {
    marginTop: 20,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 8,
  },
  welcomeChip: {
    borderWidth: 1,
    borderColor: '#E5E5E5',
    backgroundColor: '#FFFFFF',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  welcomeChipLabel: {
    fontSize: 12.5,
    fontWeight: '500',
    color: '#0D0D0D',
  },
  bubbleColumn: {
    flexShrink: 1,
    maxWidth: '82%',
    gap: 3,
  },
  bubbleColumnUser: {
    alignItems: 'flex-end',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingLeft: 4,
  },
  metaRowUser: {
    justifyContent: 'flex-end',
    paddingRight: 4,
  },
  metaTime: {
    fontSize: 10.5,
    color: colors.faint,
    paddingLeft: 4,
  },
  metaAction: {
    fontSize: 10.5,
    fontWeight: '600',
    color: colors.muted,
  },
  metaActionDone: {
    color: colors.success,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    flexShrink: 0,
  },
  modelPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderWidth: StyleSheet.hairlineWidth,
  },
  modelPillOn: {
    backgroundColor: '#F1F6F1',
    borderColor: '#D7E4D7',
  },
  modelPillOff: {
    backgroundColor: '#FBF1E7',
    borderColor: '#EAD6BF',
  },
  modelPillLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.muted,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusDotOn: {
    backgroundColor: '#4C8A4C',
  },
  statusDotOff: {
    backgroundColor: colors.copper,
  },
  suggestions: {
    marginTop: space.md,
    gap: space.sm,
  },
  suggestionsTitle: {
    fontSize: 12,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: colors.faint,
    fontWeight: '600',
  },
  suggestionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  suggestionCard: {
    width: 220,
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
    padding: space.md,
    gap: 4,
  },
  suggestionGlyph: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.copperSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  suggestionGlyphLabel: {
    color: colors.copper,
    fontSize: 12,
    fontWeight: '700',
  },
  suggestionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.ink,
  },
  suggestionBody: {
    fontSize: 12,
    lineHeight: 17,
    color: colors.muted,
  },
  typingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: 3,
  },
  dots: {
    flexDirection: 'row',
    gap: 4,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.copper,
  },
  scrollDown: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E0E0E0',
    marginTop: 4,
    marginBottom: 6,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  scrollDownLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#0D0D0D',
  },
  coverSummary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  coverSummaryLabel: {
    fontSize: 12,
    color: colors.muted,
    flexShrink: 1,
  },
  coverSummaryAction: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.copper,
  },
  modelBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: '#FBF4EA',
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#EAD6BF',
    padding: space.md,
  },
  modelBannerText: {
    flex: 1,
    gap: 2,
  },
  modelBannerTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink,
  },
  modelBannerBody: {
    fontSize: 12,
    lineHeight: 16,
    color: colors.muted,
  },
  modelBannerAction: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.copper,
  },
  frame: {
    flex: 1,
    width: '100%',
    maxWidth: 860,
    alignSelf: 'center',
    paddingHorizontal: space.lg,
  },
  header: {
    width: '100%',
    maxWidth: 860,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 4,
    paddingTop: 6,
    paddingBottom: 10,
  },
  headerBrand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 1,
  },
  brandMark: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
  },
  headerText: {
    flexShrink: 1,
  },
  title: {
    marginTop: 2,
  },
  headerAction: {
    backgroundColor: 'transparent',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  headerActionLabel: {
    color: colors.copper,
    fontSize: 14,
    fontWeight: '600',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    width: '100%',
    maxWidth: 860,
    alignSelf: 'center',
    paddingTop: space.sm,
    paddingBottom: 32,
    gap: space.sm + 2,
  },
  rowLeft: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    maxWidth: '100%',
  },
  rowRight: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingLeft: 48,
  },
  bubble: {
    maxWidth: '80%',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bubbleAssistant: {
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderColor: 'transparent',
    borderRadius: 0,
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  bubbleUser: {
    backgroundColor: '#F4F4F4',
    borderWidth: 0,
    borderRadius: 22,
  },
  bubbleFailed: {
    backgroundColor: '#FCEDEA',
  },
  assistantText: {
    color: colors.ink,
    lineHeight: 22,
  },
  userText: {
    color: '#0D0D0D',
    lineHeight: 22,
  },
  typing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: 2,
  },
  typingText: {
    color: colors.faint,
  },
  draftBar: {
    width: '100%',
    maxWidth: 860,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingTop: 2,
    gap: 8,
    backgroundColor: 'transparent',
  },
  statusCard: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
  },
  statusTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  statusCheck: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#EAF3E7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusCheckLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#3F7A3F',
  },
  statusTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink,
  },
  statusHint: {
    fontSize: 12,
    color: colors.muted,
    flexShrink: 1,
  },
  progressTrack: {
    flex: 1,
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
  progressFillReady: {
    backgroundColor: '#4C8A4C',
  },
  statusPct: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.muted,
    minWidth: 30,
    textAlign: 'right',
  },
  missingWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
  },
  missingTitle: {
    fontSize: 11,
    color: colors.faint,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginRight: 2,
  },
  missingChip: {
    borderRadius: 999,
    backgroundColor: colors.fill,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  missingChipText: {
    fontSize: 11.5,
    color: colors.muted,
  },
  missingOr: {
    fontSize: 11,
    color: colors.faint,
  },
  skipChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.copper,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  skipChipText: {
    fontSize: 11.5,
    fontWeight: '600',
    color: colors.copper,
  },
  attachTray: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  attachCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    maxWidth: 280,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
    borderRadius: 12,
    padding: 6,
    paddingRight: 8,
  },
  attachThumb: {
    width: 38,
    height: 38,
    borderRadius: 8,
    backgroundColor: colors.fill,
  },
  attachIcon: {
    width: 38,
    height: 38,
    borderRadius: 8,
    backgroundColor: colors.fill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachIconLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: colors.muted,
  },
  attachMeta: {
    flexShrink: 1,
    minWidth: 0,
  },
  attachName: {
    fontSize: 12,
    color: colors.ink,
    fontWeight: '500',
  },
  attachSize: {
    fontSize: 10.5,
    color: colors.faint,
  },
  attachRemove: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.fill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachRemoveLabel: {
    fontSize: 13,
    color: colors.muted,
    lineHeight: 15,
  },
  attachUploading: {
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  attachUploadingText: {
    fontSize: 11,
    color: colors.muted,
  },
  dropOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(255, 255, 255, 0.86)',
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: colors.copper,
  },
  dropOverlayTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: colors.ink,
  },
  dropOverlayBody: {
    fontSize: 13,
    color: colors.muted,
  },
  draftInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space.sm,
    paddingHorizontal: 4,
  },
  draftCount: {
    color: colors.faint,
    fontSize: 12,
  },
  draftMissing: {
    color: colors.muted,
    fontSize: 12,
  },
  draftReady: {
    color: colors.success,
    fontSize: 12,
    fontWeight: '600',
  },
  pendingRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: 4,
  },
  pendingChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    maxWidth: 260,
    backgroundColor: colors.fill,
  },
  pendingName: {
    fontSize: 13,
    color: colors.ink,
    flexShrink: 1,
  },
  pendingRemove: {
    fontSize: 15,
    color: colors.faint,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    backgroundColor: '#FFFFFF',
    borderRadius: 26,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#E3E3E3',
    padding: 7,
    shadowColor: '#000000',
    shadowOpacity: 0.05,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  composerHint: {
    paddingHorizontal: 12,
    paddingTop: 2,
  },
  composerHintText: {
    fontSize: 11,
    color: colors.faint,
  },
  plus: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#F4F4F4',
    borderWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 1,
  },
  plusActive: {
    backgroundColor: colors.copper,
    borderColor: colors.copper,
  },
  plusGlyph: {
    width: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  plusH: {
    position: 'absolute',
    left: 0,
    top: 6.8,
    width: 16,
    height: 2.4,
    borderRadius: 1.2,
    backgroundColor: colors.copper,
  },
  plusV: {
    position: 'absolute',
    left: 6.8,
    top: 0,
    width: 2.4,
    height: 16,
    borderRadius: 1.2,
    backgroundColor: colors.copper,
  },
  plusBarActive: {
    backgroundColor: '#FFFFFF',
  },
  plusBadge: {
    position: 'absolute',
    top: -5,
    right: -5,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    backgroundColor: colors.copper,
    borderWidth: 1.5,
    borderColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  plusBadgeLabel: {
    fontSize: 10.5,
    lineHeight: 12,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  input: {
    flex: 1,
    backgroundColor: 'transparent',
    borderWidth: 0,
    minHeight: 34,
    maxHeight: 140,
    fontSize: 16,
    lineHeight: 21,
    color: colors.ink,
    paddingHorizontal: 4,
    paddingTop: 7,
    paddingBottom: 7,
  },
  send: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#0D0D0D',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  sendDisabled: {
    opacity: 0.3,
  },
  sendPressed: {
    opacity: 0.7,
  },
  sendLabel: {
    color: '#FFFFFF',
    fontSize: 17,
    lineHeight: 19,
    fontWeight: '600',
    marginTop: -1,
  },
  designPicker: {
    marginTop: space.md,
    gap: space.sm,
  },
  designPickerTitle: {
    color: colors.muted,
  },
  designPickerHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
  },
  designSearchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  designSearch: {
    flex: 1,
    height: 36,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
    backgroundColor: colors.surface,
    paddingHorizontal: 12,
    fontSize: 14,
    color: colors.ink,
  },
  designArrows: {
    flexDirection: 'row',
    gap: space.xs ?? 6,
  },
  designArrow: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: colors.hair,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  designArrowLabel: {
    fontSize: 18,
    lineHeight: 20,
    color: colors.copper,
  },
  designRow: {
    gap: space.sm,
    paddingVertical: space.xs ?? 0,
  },
  designCard: {
    width: 112,
    borderRadius: 14,
    padding: 6,
    borderWidth: 1,
    borderColor: colors.hair,
    backgroundColor: colors.surface,
  },
  designCardSelected: {
    borderWidth: 2,
    borderColor: colors.copper,
  },
  designThumb: {
    width: '100%',
    height: 152,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 10,
    backgroundColor: colors.fill,
    overflow: 'hidden',
  },
  designThumbImage: {
    padding: 0,
  },
  designThumbNo: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.copperSoft,
  },
  designThumbNoLabel: {
    fontSize: 26,
    fontWeight: '600',
    letterSpacing: 3,
    color: colors.copper,
  },
  designThumbNoSub: {
    marginTop: 2,
    fontSize: 9,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
    color: colors.faint,
  },
  referenceBand: {
    width: 34,
    height: 4,
    borderRadius: 2,
    alignSelf: 'flex-start',
  },
  referenceTitle: {
    marginTop: 10,
    fontSize: 18,
    lineHeight: 20,
    fontWeight: '500',
    letterSpacing: -0.2,
  },
  referenceDots: {
    position: 'absolute',
    left: 10,
    right: 10,
    bottom: 10,
    flexDirection: 'row',
    gap: 4,
  },
  referenceDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,0,0,0.18)',
  },
  designName: {
    marginTop: 6,
    fontSize: 11.5,
    lineHeight: 15,
    fontWeight: '500',
    color: colors.ink,
    textAlign: 'left',
  },
  designSub: {
    marginTop: 1,
    fontSize: 9.5,
    lineHeight: 13,
    color: colors.faint,
    textAlign: 'left',
  },
  designPalette: {
    position: 'absolute',
    right: 7,
    bottom: 7,
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.9)',
  },
  designPickerTitles: {
    flex: 1,
    gap: 2,
    paddingRight: space.sm,
  },
  designPickerHeading: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink,
  },
  designNameSelected: {
    color: colors.copper,
    fontWeight: '600',
  },
  designPickerHint: {
    color: colors.faint,
  },
  autoHint: {
    color: colors.faint,
    textAlign: 'center',
    fontSize: 12,
    paddingBottom: 2,
  },
  cook: {
    borderRadius: 14,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm + 2,
    alignItems: 'center',
    gap: 2,
  },
  cookReady: {
    backgroundColor: colors.copper,
  },
  cookLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.copper,
  },
  cookLabelReady: {
    color: colors.surface,
  },
  cookHint: {
    fontSize: 12,
    color: colors.faint,
  },
  cookHintReady: {
    color: 'rgba(255,255,255,0.78)',
  },
  agentSteps: {
    marginTop: 6,
    color: colors.muted,
  },
  markOpenButton: {
    alignSelf: 'flex-start',
    marginTop: 8,
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.faint,
    backgroundColor: colors.card,
  },
  markOpenLabel: { color: colors.ink, fontSize: 11.5, fontWeight: '600' },
  markBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(20,16,12,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  markCard: {
    width: '100%',
    maxWidth: 640,
    maxHeight: '92%',
    backgroundColor: colors.card,
    borderRadius: 20,
    padding: 18,
  },
  markHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  markTitle: { fontSize: 18, fontWeight: '700', color: colors.ink },
  markClose: { color: colors.muted, fontSize: 13 },
  markHint: { marginTop: 4, marginBottom: 10, color: colors.muted },
  markImageBox: {
    height: 320,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#141210',
  },
  markImage: { width: '100%', height: '100%' },
  markPoint: {
    position: 'absolute',
    width: 26,
    height: 26,
    marginLeft: -13,
    marginTop: -13,
    borderRadius: 13,
    borderWidth: 3,
    borderColor: '#F6E7C8',
    backgroundColor: 'rgba(166,94,34,0.45)',
  },
  markFields: { marginTop: 12, gap: 8 },
  markField: {
    borderWidth: 1,
    borderColor: colors.faint,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    color: colors.ink,
    backgroundColor: '#FFFFFF',
    fontSize: 13,
  },
  markNote: { marginTop: 8, color: colors.muted },
  markSave: {
    marginTop: 12,
    alignSelf: 'flex-start',
    backgroundColor: colors.ink,
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 18,
  },
  markSaveDisabled: { opacity: 0.45 },
  markSaveLabel: { color: colors.card, fontSize: 12.5, fontWeight: '700' },
  reviewBubble: {
    gap: 12,
    maxWidth: 720,
    width: '100%',
  },
  reviewTitle: {
    fontWeight: '600',
  },
  reviewPhoto: {
    gap: 6,
  },
  reviewPhotoLabel: {
    textTransform: 'uppercase',
    letterSpacing: 1.2,
  },
  reviewFrameBox: {
    position: 'relative',
    width: '100%',
    height: 280,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#141210',
  },
  reviewFrame: {
    position: 'absolute',
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#141210',
  },
  reviewImage: {
    width: '100%',
    height: '100%',
  },
  reviewLoupe: {
    position: 'absolute',
    borderRadius: 48,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: '#B98A55',
    backgroundColor: colors.fill,
  },
  reviewLoupeNumber: {
    position: 'absolute',
    right: 3,
    bottom: 3,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#173B44',
    alignItems: 'center',
    justifyContent: 'center',
  },
  reviewLoupeNumberLabel: {
    color: colors.surface,
    fontSize: 10,
    fontWeight: '700',
  },
  reviewLoupeLabel: {
    position: 'absolute',
    marginLeft: -72,
    width: 144,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  reviewLoupeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairInset,
  },
  reviewLoupeName: {
    fontSize: 9,
    color: colors.ink,
    fontWeight: '600',
  },
  reviewMagnifiedLine: {
    color: colors.ink,
    letterSpacing: 0.4,
  },
  reviewReadingLine: {
    color: colors.ink,
    fontStyle: 'italic',
  },
  reviewCircle: {
    position: 'absolute',
    marginLeft: -19,
    marginTop: -19,
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 2,
    borderColor: '#B98A55',
    backgroundColor: 'rgba(248,242,231,0.28)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  reviewCircleLabel: {
    color: colors.surface,
    backgroundColor: '#173B44',
    width: 18,
    height: 18,
    borderRadius: 9,
    textAlign: 'center',
    fontSize: 11,
    fontWeight: '700',
    overflow: 'hidden',
  },
  reviewSectionLabel: {
    marginTop: 12,
    marginBottom: 6,
    fontSize: 11.5,
    fontWeight: '600',
    letterSpacing: 0.2,
    color: '#6E6E73',
  },
  reviewPalette: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 4,
  },
  reviewSwatch: {
    width: 64,
    gap: 3,
  },
  reviewChip: {
    height: 20,
    borderRadius: 3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairInset,
  },
  reviewChipName: {
    fontSize: 10,
    color: colors.ink,
  },
  reviewChipHex: {
    fontSize: 9,
    color: colors.faint,
    letterSpacing: 0.3,
  },
  reviewHint: {
    color: colors.muted,
    fontStyle: 'italic',
  },
  brochure: {
    maxWidth: 440,
    alignSelf: 'flex-start',
    padding: 14,
    gap: 8,
    borderRadius: 20,
  },
  brochureTitle: {
    fontWeight: '600',
  },
  brochureMeta: {
    color: colors.faint,
  },
  preview: {
    width: 176,
    height: 249,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairInset,
    backgroundColor: colors.surface,
  },
  brochureActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 2,
  },
  smallAction: {
    backgroundColor: colors.fill,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  smallActionLabel: {
    fontSize: 14,
    color: colors.copper,
    fontWeight: '600',
  },
  bubbleFiles: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 8,
  },
  fileChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    maxWidth: 250,
    backgroundColor: colors.fill,
  },
  fileChipUser: {
    // The chat bubble is a light neutral (#F4F4F4), so the chip needs a fill
    // that reads on it and dark type. White on white was unreadable.
    backgroundColor: colors.fill,
  },
  fileThumb: {
    width: 24,
    height: 24,
    borderRadius: 6,
  },
  fileChipName: {
    fontSize: 13,
    color: colors.ink,
    flexShrink: 1,
  },
  fileChipNameUser: {
    color: colors.ink,
  },
  formatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 2,
    paddingBottom: 2,
  },
  formatChip: {
    borderWidth: 1,
    borderColor: '#E5E5E5',
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 5,
    backgroundColor: '#FFFFFF',
  },
  formatChipActive: {
    backgroundColor: '#0D0D0D',
    borderColor: '#0D0D0D',
  },
  formatLabel: {
    fontSize: 11.5,
    fontWeight: '600',
    color: '#6E6E73',
  },
  formatLabelActive: {
    color: '#FFFFFF',
  },
  formatHint: {
    marginLeft: 4,
    fontSize: 11,
    color: '#8E8E93',
  },
  markSuggestWrap: {
    marginTop: 10,
    gap: 6,
  },
  markSuggestTitle: {
    color: colors.muted,
  },
  markSuggestRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  markSuggestChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: '#E5E5E5',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#FFFFFF',
    maxWidth: '100%',
  },
  markSuggestSwatch: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  markSuggestText: {
    fontSize: 11,
    color: '#0D0D0D',
    flexShrink: 1,
  },
  reviewPointRing: {
    position: 'absolute',
    width: 14,
    height: 14,
    marginLeft: -7,
    marginTop: -7,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: '#FFFFFF',
    backgroundColor: 'rgba(0,0,0,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  reviewPointRingLabel: {
    color: '#FFFFFF',
    fontSize: 8,
    fontWeight: '700',
  },
  reviewLeader: {
    position: 'absolute',
  },
  reviewLegend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
  },
  reviewLegendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderColor: '#E5E5E5',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: '#FFFFFF',
  },
  reviewLegendNumber: {
    fontSize: 9,
    fontWeight: '700',
    color: '#0D0D0D',
  },
  reviewLegendSwatch: {
    width: 9,
    height: 9,
    borderRadius: 5,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#D0D0D0',
  },
  reviewLegendText: {
    color: '#0D0D0D',
    fontSize: 10,
  },
  agentFeed: {
    marginTop: 10,
    borderWidth: 1,
    borderColor: '#ECECEC',
    borderRadius: 12,
    backgroundColor: '#FAFAF9',
    paddingVertical: 10,
    paddingHorizontal: 12,
    gap: 6,
    maxWidth: 460,
  },
  agentFeedTitle: {
    fontSize: 10.5,
    fontWeight: '600',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: '#8A8A8E',
    marginBottom: 2,
  },
  agentFeedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  agentFeedDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: '#B98A55',
  },
  agentFeedText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
    color: '#3C3C43',
  },
  agentFeedTime: {
    fontSize: 10.5,
    color: '#A0A0A5',
    fontVariant: ['tabular-nums'],
  },
  reviewSectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  reviewClearMarks: {
    marginTop: 12,
    marginBottom: 6,
    fontSize: 11.5,
    fontWeight: '600',
    color: '#6E6E73',
  },
  reviewRemoveMark: {
    fontSize: 13,
    lineHeight: 15,
    color: '#8E8E93',
    paddingHorizontal: 2,
  },
});
