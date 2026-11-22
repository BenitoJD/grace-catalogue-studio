import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react';
import {
  ActivityIndicator,
  Animated,
  Image,
  KeyboardAvoidingView,
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
  type Render,
  type Template,
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
    };

const WELCOME =
  'Paste everything the customer told you. A WhatsApp forward, a list, a rough note, all of it. I will pull out the order and ask only for what is missing, then make the brochure.\n\nIf a detail is not known yet, say so and I will mark it to be confirmed.\n\nFirst, choose a cover below, or pick No design and I will design one for this order.';


let counter = 0;
const nextId = () => {
  counter += 1;
  return `m${counter}`;
};

const stamp = () =>
  new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });

const ESSENTIAL_TOTAL = 7;
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

function shortLabel(label: string): string {
  return SHORT_LABELS[label] ?? label.replace(/^the /, '').slice(0, 18);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function DesignTile({
  label,
  image,
  selected,
  noDesign = false,
  onPress,
}: {
  label: string;
  image?: string | null;
  selected: boolean;
  noDesign?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={noDesign ? 'Choose no design, let the model design it' : `Choose cover ${label}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.designCard,
        selected && styles.designCardSelected,
        pressed && styles.sendPressed,
      ]}>
      {noDesign ? (
        <View style={[styles.designThumb, styles.designThumbNo]}>
          <Text style={styles.designThumbNoLabel}>AI</Text>
        </View>
      ) : (
        <Image source={{ uri: fileUrl(image ?? '') }} style={styles.designThumb} resizeMode="cover" />
      )}
      <Text
        style={[styles.designName, selected && styles.designNameSelected]}
        numberOfLines={2}>
        {label}
      </Text>
    </Pressable>
  );
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
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const compact = width < 560;
  const scroll = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const designScroll = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const designOffset = useRef(0);
  const frameRef = useRef<any>(null);
  const inputRef = useRef<any>(null);
  const anim = useRef(new Animated.Value(0)).current;
  const sendingRef = useRef(false);
  const atBottomRef = useRef(true);
  const previousBubbleCount = useRef(1);

  const [bubbles, setBubbles] = useState<Bubble[]>([
    { id: nextId(), role: 'assistant', kind: 'text', content: WELCOME, at: stamp() },
  ]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [missing, setMissing] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [cooking, setCooking] = useState(false);
  const [orderCreated, setOrderCreated] = useState(false);
  const [activeOrderId, setActiveOrderId] = useState<string | null>(null);
  const [activeOrderNo, setActiveOrderNo] = useState('');
  const [createFailed, setCreateFailed] = useState(false);
  const [orderFiles, setOrderFiles] = useState<OrderAttachment[]>([]);
  const [pendingFiles, setPendingFiles] = useState<OrderAttachment[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]);
  // 'ai' means no template: let the model design the brochure for this order.
  const [chosenDesign, setChosenDesign] = useState<string>('ai');
  const [modelReady, setModelReady] = useState<boolean | null>(null);
  const [showDesignPicker, setShowDesignPicker] = useState(true);
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

  useEffect(() => {
    let active = true;
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

  useEffect(() => {
    let active = true;
    api
      .listTemplates()
      .then((next) => {
        if (active) setTemplates(next);
      })
      .catch(() => {
        // The picker stays on No design; the order can still be created.
      });
    return () => {
      active = false;
    };
  }, []);

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
    setBubbles([
      { id: nextId(), role: 'assistant', kind: 'text', content: WELCOME, at: stamp() },
    ]);
    setDraft({});
    setMissing([]);
    setReady(false);
    setOrderCreated(false);
    setShowDesignPicker(true);
    setCopiedId(null);
    setCreateFailed(false);
    setOrderFiles([]);
    setPendingFiles([]);
    setInput('');
    setChosenDesign('ai');
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
    async (orderDraft: Record<string, string>, files: OrderAttachment[] = orderFiles) => {
      setCooking(true);
      setCreateFailed(false);
      try {
        const customer = await api.createCustomer({ name: orderDraft.customerName });
        const order = await api.createOrder({
          customerId: customer.id,
          attachments: files,
          title: orderDraft.title,
          room: orderDraft.room,
          width: orderDraft.width,
          height: orderDraft.height,
          depth: orderDraft.depth,
          shutters: orderDraft.shutters,
          carcass: orderDraft.carcass,
          backPanel: orderDraft.backPanel,
          shuttersMat: orderDraft.shuttersMat,
          drawers: orderDraft.drawers,
          exterior: orderDraft.exterior,
          interior: orderDraft.interior,
          edgeShutter: orderDraft.edgeShutter,
          edgeCarcass: orderDraft.edgeCarcass,
          edgeNote: orderDraft.edgeNote,
          handle: orderDraft.handle,
          handleNote: orderDraft.handleNote,
          finishExt: orderDraft.finishExt,
          finishInt: orderDraft.finishInt,
        } as Parameters<typeof api.createOrder>[0]);

        const brief =
          orderDraft.brief ??
          history()
            .filter((message) => message.role === 'user')
            .map((message) => message.content)
            .join(' ')
            .slice(0, 2000);
        // If the studio picked a cover in the chat, that cover is printed with
        // the model written copy. No design means the model designs the whole
        // brochure for this order.
        let render: Render;
        if (chosenDesign !== 'ai' && chosenDesign !== '') {
          await api.generateOrderCopy(order.id, { brief });
          render = await api.renderOrder(order.id, 'voucher', chosenDesign);
        } else {
          try {
            const designed = await api.aiBrochure(order.id, brief ? { brief } : {});
            render = designed.render;
          } catch {
            await api.generateOrderCopy(order.id, { brief }).catch(() => null);
            render = await api.renderOrder(order.id, 'voucher');
          }
        }

        setBubbles((current) => [
          ...current,
          {
            id: nextId(),
            role: 'assistant',
            kind: 'brochure',
            content: `Order ${order.orderNo} is created and the brochure is ready.`,
            at: stamp(),
            orderId: order.id,
            orderNo: order.orderNo,
            render,
          },
        ]);
        setOrderCreated(true);
        setActiveOrderId(order.id);
        setActiveOrderNo(order.orderNo);
        setShowDesignPicker(false);
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
    [chosenDesign, history, orderFiles],
  );

  const send = useCallback(async () => {
    const content = input.trim();
    if ((content === '' && pendingFiles.length === 0) || sending || cooking || skipping || uploadingFiles) return;
    if (sendingRef.current) return;
    // Once an order exists, the same chat edits it. Every sentence is applied to
    // that order's design or copy, then only that order is re-rendered.
    if (orderCreated && activeOrderId) {
      sendingRef.current = true;
      const previousInput = input;
      const at = stamp();
      setBubbles((current) => [
        ...current,
        { id: nextId(), role: 'user', kind: 'text', content, at },
      ]);
      setInput('');
      setInputHeight(38);
      setSending(true);
      try {
        const edited = await api.editOrder(activeOrderId, content);
        let render = null;
        if (edited.rerender) {
          const result = await api.aiBrochure(activeOrderId, {
            overrides: edited.design,
            ...(edited.copy ? { copy: edited.copy } : {}),
          });
          render = result.render;
        }
        setBubbles((current) => [
          ...current,
          { id: nextId(), role: 'assistant', kind: 'text', content: edited.reply, at: stamp() },
          ...(render
            ? [{ id: nextId(), role: 'assistant' as const, kind: 'brochure' as const, content: 'Updated brochure.', at: stamp(), orderId: activeOrderId, orderNo: activeOrderNo, render }]
            : []),
        ]);
      } catch (error) {
        setBubbles((current) => [...current, { id: nextId(), role: 'assistant', kind: 'text', content: errorMessage(error, 'I could not apply that change. Try again.'), at: stamp(), failed: true }]);
        setInput(previousInput);
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
      return;
    }
    sendingRef.current = true;
    const previousInput = input;
    const previousFiles = pendingFiles;
    const previousOrderFiles = orderFiles;
    const previousHeight = inputHeight;

    // A finished order closes the chat. The next message starts a new one, so
    // one conversation never mixes two orders.
    const startingFresh = orderCreated;
    const base: Bubble[] = startingFresh
      ? [{ id: nextId(), role: 'assistant', kind: 'text', content: WELCOME, at: stamp() }]
      : bubbles;
    if (startingFresh) {
      setDraft({});
      setMissing([]);
      setReady(false);
      setOrderCreated(false);
      setCreateFailed(false);
    }

    const attached = pendingFiles;
    const textContent =
      content !== ''
        ? content
        : `Attached: ${attached.map((file) => file.name).join(', ')}`;
    const userBubble: Bubble = {
      id: nextId(),
      role: 'user',
      kind: 'text',
      content: textContent,
      at: stamp(),
      attachments: attached.length > 0 ? attached : undefined,
    };
    const nextBubbles = [...base, userBubble];
    const allFiles = startingFresh ? attached : [...orderFiles, ...attached];
    if (startingFresh) previousBubbleCount.current = 1;
    setBubbles(nextBubbles);
    setInput('');
    setInputHeight(38);
    setPendingFiles([]);
    setOrderFiles(allFiles);
    setShowDesignPicker(false);
    atBottomRef.current = true;
    setAtBottom(true);
    setSending(true);
    try {
      const messages = nextBubbles
        .filter((bubble) => bubble.kind === 'text')
        .map((bubble) => ({ role: bubble.role, content: bubble.content }));
      const result = await api.intake(
        messages,
        startingFresh ? {} : draft,
        allFiles.length > 0 ? allFiles : undefined
      );
      setDraft(result.draft);
      setMissing(result.missing);
      setReady(result.ready);
      setBubbles((current) => [
        ...current,
        { id: nextId(), role: 'assistant', kind: 'text', content: result.reply, at: stamp() },
      ]);
      if (result.ready) {
        await createOrderFor(result.draft, allFiles);
      }
    } catch (error) {
      // A failed send must not eat the message. Take the user bubble back out
      // of the thread, put the text and attachments back in the composer, and
      // explain what happened.
      setBubbles((current) =>
        current
          .filter((bubble) => bubble.id !== userBubble.id)
          .concat([
            {
              id: nextId(),
              role: 'assistant',
              kind: 'text',
              content: `That message did not go through, so nothing was saved. It is back in the box. Check the model in Settings, then send again.${(() => {
                const detail = errorMessage(error, '');
                return detail ? `\n\n${detail}` : '';
              })()}`,
              at: stamp(),
              failed: true,
            },
          ])
      );
      setInput(previousInput);
      setInputHeight(previousHeight);
      setPendingFiles(previousFiles);
      setOrderFiles(previousOrderFiles);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [activeOrderId, activeOrderNo, bubbles, cooking, createOrderFor, draft, input, inputHeight, orderCreated, orderFiles, pendingFiles, sending, skipping, uploadingFiles]);

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
          <View style={styles.headerText}>
            <Text style={text.eyebrow}>Grace Wood</Text>
            <TamilLine />
            <Text style={[text.screenTitle, styles.title]}>Studio chat</Text>
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
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          onScroll={onChatScroll}
          scrollEventThrottle={48}>
          {bubbles.map((bubble) => (
            <BubbleView
              key={bubble.id}
              bubble={bubble}
              copied={copiedId === bubble.id}
              onCopy={copyMessage}
            />
          ))}
          {busy ? (
            <View style={styles.rowLeft}>
              <View style={styles.avatar}>
                <Text style={styles.avatarLabel}>GW</Text>
              </View>
              <View style={[styles.bubble, styles.bubbleAssistant]}>
                <TypingDots label={cooking ? 'Creating the order' : skipping ? 'Marking it to be confirmed' : 'Reading'} />
              </View>
            </View>
          ) : null}

          {bubbles.length === 1 && !busy ? (
            <View style={styles.suggestions}>
              <Text style={styles.suggestionsTitle}>Start with what you have</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.suggestionRow}>
                <SuggestionCard
                  glyph="Aa"
                  title="Paste a WhatsApp message"
                  body="Forward, list or rough note. The model pulls out the order."
                  onPress={() => inputRef.current?.focus()}
                />
                <SuggestionCard
                  glyph="+"
                  title="Add photos or a plan"
                  body="Pick photos or a plan, or drag files in. Any type, no limit."
                  onPress={() => void pickFiles()}
                />
                <SuggestionCard
                  glyph="◫"
                  title="Pick a cover"
                  body="Choose one of the thirty printed covers, or No design."
                  onPress={() => {
                    setShowDesignPicker(true);
                    setTimeout(scrollToBottom, 60);
                  }}
                />
              </ScrollView>
            </View>
          ) : null}

          {!orderCreated && showDesignPicker ? (
            <View style={styles.designPicker}>
              <View style={styles.designPickerHead}>
                <Text style={[text.caption, styles.designPickerTitle]}>
                  Choose a cover. The last card is No design, where the model designs the whole
                  brochure.
                </Text>
                <View style={styles.designArrows}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Hide covers"
                    onPress={() => setShowDesignPicker(false)}
                    style={styles.designArrow}>
                    <Text style={styles.designArrowLabel}>×</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Scroll covers left"
                    onPress={() =>
                      designScroll.current?.scrollTo({
                        x: Math.max(0, designOffset.current - 420),
                        animated: true,
                      })
                    }
                    style={styles.designArrow}>
                    <Text style={styles.designArrowLabel}>‹</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Scroll covers right"
                    onPress={() =>
                      designScroll.current?.scrollTo({
                        x: designOffset.current + 420,
                        animated: true,
                      })
                    }
                    style={styles.designArrow}>
                    <Text style={styles.designArrowLabel}>›</Text>
                  </Pressable>
                </View>
              </View>
              <ScrollView
                ref={designScroll}
                horizontal
                showsHorizontalScrollIndicator={false}
                onScroll={(event) => {
                  designOffset.current = event.nativeEvent.contentOffset.x;
                }}
                scrollEventThrottle={48}
                contentContainerStyle={styles.designRow}>
                {templates.map((template) => (
                  <DesignTile
                    key={template.id}
                    label={template.name}
                    image={template.previewUrl}
                    selected={chosenDesign === template.id}
                    onPress={() => setChosenDesign(template.id)}
                  />
                ))}
                <DesignTile
                  label="No design"
                  selected={chosenDesign === 'ai'}
                  noDesign
                  onPress={() => setChosenDesign('ai')}
                />
              </ScrollView>
              <Text style={[text.caption, styles.designPickerHint]}>
                {chosenDesign === 'ai'
                  ? 'No design chosen: the model designs the brochure for this order.'
                  : `Cover chosen: ${templates.find((template) => template.id === chosenDesign)?.name ?? 'a design'}. The model writes the copy.`}
              </Text>
            </View>
          ) : null}
        </ScrollView>

        {!atBottom ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Scroll to latest message"
            onPress={scrollToBottom}
            style={styles.scrollDown}>
            <Text style={styles.scrollDownLabel}>↓</Text>
          </Pressable>
        ) : null}

        <View style={[styles.draftBar, { paddingBottom: Math.max(insets.bottom, space.sm) }]}>
          {!orderCreated && !showDesignPicker ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Change cover"
              onPress={() => setShowDesignPicker(true)}
              style={({ pressed }) => [styles.coverSummary, pressed && styles.sendPressed]}>
              <Text style={styles.coverSummaryLabel} numberOfLines={1}>
                {compact ? 'Cover: ' : 'Cover with this order: '}
                {chosenDesign === 'ai'
                  ? compact
                    ? 'No design'
                    : 'No design, the model decides'
                  : templates.find((template) => template.id === chosenDesign)?.name ?? 'selected design'}
              </Text>
              <Text style={styles.coverSummaryAction}>Change</Text>
            </Pressable>
          ) : null}
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
                  {ready ? 'Ready to build' : `${Math.min(ESSENTIAL_TOTAL, Math.max(0, ESSENTIAL_TOTAL - missing.length))} of ${ESSENTIAL_TOTAL} details`}
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
              {ready ? (
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

          <View style={styles.composer}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Attach files"
              onPress={() => void pickFiles()}
              disabled={busy || uploadingFiles}
              style={({ pressed }) => [
                styles.plus,
                (busy || uploadingFiles) && styles.sendDisabled,
                pressed && styles.sendPressed,
              ]}>
              {uploadingFiles ? (
                <ActivityIndicator size="small" color={colors.copper} />
              ) : (
                <Text style={styles.plusLabel}>+</Text>
              )}
            </Pressable>
            <TextInput
              ref={inputRef}
              value={input}
              onChangeText={setInput}
              placeholder={
                orderCreated
                  ? 'Ask for a change to this order'
                  : "Paste the customer's requirement"
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

function BubbleView({
  bubble,
  copied,
  onCopy,
}: {
  bubble: Bubble;
  copied: boolean;
  onCopy: (bubble: Bubble) => void;
}) {
  if (bubble.kind === 'brochure') {
    const firstPage = bubble.render.pageUrls?.[0];
    return (
      <View style={styles.rowLeft}>
        <View style={styles.avatar}>
          <Text style={styles.avatarLabel}>GW</Text>
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
          <Text style={styles.avatarLabel}>GW</Text>
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
    backgroundColor: colors.background,
  },
  frameDragging: {
    borderWidth: 2,
    borderColor: colors.copper,
    borderRadius: 18,
  },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.copperSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  avatarLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.4,
    color: colors.copper,
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
    position: 'absolute',
    right: space.lg,
    bottom: 148,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  scrollDownLabel: {
    fontSize: 17,
    color: colors.copper,
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
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: space.md,
    paddingTop: space.sm,
    paddingBottom: space.sm,
  },
  headerText: {
    flexShrink: 1,
  },
  title: {
    marginTop: 2,
  },
  headerAction: {
    backgroundColor: colors.copperSoft,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
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
    paddingTop: space.sm,
    paddingBottom: space.md,
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
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0, 0, 0, 0.05)',
  },
  bubbleUser: {
    backgroundColor: colors.copper,
  },
  bubbleFailed: {
    backgroundColor: '#FCEDEA',
  },
  assistantText: {
    color: colors.ink,
    lineHeight: 22,
  },
  userText: {
    color: colors.surface,
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
    paddingTop: space.sm,
    gap: space.sm,
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
    backgroundColor: colors.surface,
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0, 0, 0, 0.08)',
    padding: 7,
    shadowColor: '#000',
    shadowOpacity: 0.06,
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
    backgroundColor: colors.fill,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 1,
  },
  plusLabel: {
    fontSize: 21,
    lineHeight: 23,
    color: colors.ink,
  },
  input: {
    flex: 1,
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
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.copper,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 1,
  },
  sendDisabled: {
    opacity: 0.3,
  },
  sendPressed: {
    opacity: 0.7,
  },
  sendLabel: {
    color: colors.surface,
    fontSize: 18,
    lineHeight: 20,
    fontWeight: '600',
  },
  designPicker: {
    marginTop: space.md,
    gap: space.sm,
  },
  designPickerTitle: {
    color: colors.muted,
    flex: 1,
    paddingRight: space.sm,
  },
  designPickerHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
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
    width: 96,
    borderRadius: 10,
    padding: 4,
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
    height: 132,
    borderRadius: 6,
    backgroundColor: colors.fill,
  },
  designThumbNo: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.copperSoft,
  },
  designThumbNoLabel: {
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: 2,
    color: colors.copper,
  },
  designName: {
    marginTop: 4,
    fontSize: 10,
    lineHeight: 13,
    color: colors.muted,
    textAlign: 'center',
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
    backgroundColor: 'rgba(255,255,255,0.18)',
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
    color: colors.surface,
  },
});
