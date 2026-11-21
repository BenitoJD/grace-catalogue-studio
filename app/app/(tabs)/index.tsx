import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  api,
  errorMessage,
  fileUrl,
  type IntakeMessage,
  type OrderAttachment,
  type Render,
} from '@/lib/api';
import { openUrl } from '@/lib/actions';
import { colors, space, text } from '@/lib/theme';

type Bubble =
  | {
      id: string;
      role: 'user' | 'assistant';
      kind: 'text';
      content: string;
      failed?: boolean;
      attachments?: OrderAttachment[];
    }
  | {
      id: string;
      role: 'assistant';
      kind: 'brochure';
      content: string;
      orderId: string;
      orderNo: string;
      render: Render;
    };

const WELCOME =
  'Paste everything the customer told you. A WhatsApp forward, a list, a rough note, all of it. I will pull out the order and ask only for what is missing, then make the brochure.';


let counter = 0;
const nextId = () => {
  counter += 1;
  return `m${counter}`;
};

export default function ChatScreen() {
  const insets = useSafeAreaInsets();
  const scroll = useRef<ComponentRef<typeof ScrollView> | null>(null);

  const [bubbles, setBubbles] = useState<Bubble[]>([
    { id: nextId(), role: 'assistant', kind: 'text', content: WELCOME },
  ]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [missing, setMissing] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [cooking, setCooking] = useState(false);
  const [orderCreated, setOrderCreated] = useState(false);
  const [createFailed, setCreateFailed] = useState(false);
  const [orderFiles, setOrderFiles] = useState<OrderAttachment[]>([]);
  const [pendingFiles, setPendingFiles] = useState<OrderAttachment[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 80);
    return () => clearTimeout(timer);
  }, [bubbles.length, sending, cooking]);

  const history = useCallback((): IntakeMessage[] => {
    return bubbles
      .filter((bubble) => bubble.kind === 'text')
      .map((bubble) => ({ role: bubble.role, content: bubble.content }));
  }, [bubbles]);

  const startNewChat = useCallback(() => {
    if (sending || cooking) return;
    setBubbles([{ id: nextId(), role: 'assistant', kind: 'text', content: WELCOME }]);
    setDraft({});
    setMissing([]);
    setReady(false);
    setOrderCreated(false);
    setCreateFailed(false);
    setOrderFiles([]);
    setPendingFiles([]);
    setInput('');
  }, [cooking, sending]);

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
      for (const asset of picked.assets) {
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
      }
      setPendingFiles((current) => [...current, ...uploaded]);
    } catch (error) {
      setBubbles((current) => [
        ...current,
        {
          id: nextId(),
          role: 'assistant',
          kind: 'text',
          content: errorMessage(error, 'The file could not be uploaded. Try again.'),
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
    async (orderDraft: Record<string, string>) => {
      setCooking(true);
      setCreateFailed(false);
      try {
        const customer = await api.createCustomer({ name: orderDraft.customerName });
        const order = await api.createOrder({
          customerId: customer.id,
          attachments: orderFiles,
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
        await api.generateOrderCopy(order.id, { brief });
        const render = await api.renderOrder(order.id, 'voucher');

        setBubbles((current) => [
          ...current,
          {
            id: nextId(),
            role: 'assistant',
            kind: 'brochure',
            content: `Order ${order.orderNo} is created and the brochure is ready.`,
            orderId: order.id,
            orderNo: order.orderNo,
            render,
          },
        ]);
        setOrderCreated(true);
        setDraft({});
        setMissing([]);
        setReady(false);
        setCreateFailed(false);
      } catch (error) {
        setCreateFailed(true);
        setBubbles((current) => [
          ...current,
          {
            id: nextId(),
            role: 'assistant',
            kind: 'text',
            content: errorMessage(error, 'I could not create the order. Try again.'),
            failed: true,
          },
        ]);
      } finally {
        setCooking(false);
      }
    },
    [history, orderFiles],
  );

  const send = useCallback(async () => {
    const content = input.trim();
    if ((content === '' && pendingFiles.length === 0) || sending || cooking) return;

    // A finished order closes the chat. The next message starts a new one, so
    // one conversation never mixes two orders.
    const startingFresh = orderCreated;
    const base: Bubble[] = startingFresh
      ? [{ id: nextId(), role: 'assistant', kind: 'text', content: WELCOME }]
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
      attachments: attached.length > 0 ? attached : undefined,
    };
    const nextBubbles = [...base, userBubble];
    const allFiles = startingFresh ? attached : [...orderFiles, ...attached];
    setBubbles(nextBubbles);
    setInput('');
    setPendingFiles([]);
    setOrderFiles(allFiles);
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
        { id: nextId(), role: 'assistant', kind: 'text', content: result.reply },
      ]);
      if (result.ready) {
        await createOrderFor(result.draft);
      }
    } catch (error) {
      setBubbles((current) => [
        ...current,
        {
          id: nextId(),
          role: 'assistant',
          kind: 'text',
          content: errorMessage(error, 'I could not read that. Send it again.'),
          failed: true,
        },
      ]);
    } finally {
      setSending(false);
    }
  }, [bubbles, cooking, createOrderFor, draft, input, orderCreated, orderFiles, pendingFiles, sending]);

  const retryCreate = useCallback(async () => {
    if (cooking || sending || !createFailed) return;
    await createOrderFor(draft);
  }, [cooking, createFailed, createOrderFor, draft, sending]);

  const fieldCount = Object.keys(draft).length;
  const busy = sending || cooking;

  return (
    <KeyboardAvoidingView
      style={styles.page}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}>
      <View style={[styles.frame, { paddingTop: insets.top + space.lg }]}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={text.eyebrow}>Grace Wood</Text>
            <Text style={[text.screenTitle, styles.title]}>Studio chat</Text>
          </View>
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

        <ScrollView
          ref={scroll}
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}>
          {bubbles.map((bubble) => (
            <BubbleView key={bubble.id} bubble={bubble} />
          ))}
          {busy ? (
            <View style={styles.rowLeft}>
              <View style={[styles.bubble, styles.bubbleAssistant]}>
                <View style={styles.typing}>
                  <ActivityIndicator size="small" color={colors.faint} />
                  <Text style={[text.caption, styles.typingText]}>
                    {cooking ? 'Creating the order' : 'Reading'}
                  </Text>
                </View>
              </View>
            </View>
          ) : null}
        </ScrollView>

        <View style={[styles.draftBar, { paddingBottom: Math.max(insets.bottom, space.sm) }]}>
          <View style={styles.draftInfo}>
            <Text style={[text.caption, styles.draftCount]}>
              {orderCreated
                ? 'Order created, paste the next customer'
                : fieldCount === 0
                  ? 'Nothing captured yet'
                  : `${fieldCount} details captured`}
            </Text>
            {missing.length > 0 && fieldCount > 0 ? (
              <Text style={[text.caption, styles.draftMissing]} numberOfLines={1}>
                Still needed: {missing.join(', ')}
              </Text>
            ) : null}
            {ready ? (
              <Text style={[text.caption, styles.draftReady]}>Ready to make the brochure</Text>
            ) : null}
          </View>

          {pendingFiles.length > 0 ? (
            <View style={styles.pendingRow}>
              {pendingFiles.map((file) => (
                <Pressable
                  key={file.url}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${file.name}`}
                  onPress={() =>
                    setPendingFiles((current) => current.filter((entry) => entry.url !== file.url))
                  }
                  style={styles.pendingChip}>
                  <Text numberOfLines={1} style={styles.pendingName}>
                    {file.name}
                  </Text>
                  <Text style={styles.pendingRemove}>×</Text>
                </Pressable>
              ))}
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
              value={input}
              onChangeText={setInput}
              placeholder={orderCreated ? "Paste the next customer's requirement" : "Paste the customer's requirement"}
              placeholderTextColor={colors.faint}
              multiline
              style={styles.input}
              accessibilityLabel="Message the studio"
              onSubmitEditing={() => void send()}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send message"
              onPress={() => void send()}
              disabled={busy || (input.trim() === '' && pendingFiles.length === 0)}
              style={({ pressed }) => [
                styles.send,
                (busy || (input.trim() === '' && pendingFiles.length === 0)) && styles.sendDisabled,
                pressed && styles.sendPressed,
              ]}>
              <Text style={styles.sendLabel}>↑</Text>
            </Pressable>
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
          ) : (
            <Text style={[text.caption, styles.autoHint]}>
              {ready
                ? 'Creating the order now'
                : 'I will create the order myself once I have enough details.'}
            </Text>
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

function BubbleView({ bubble }: { bubble: Bubble }) {
  if (bubble.kind === 'brochure') {
    const firstPage = bubble.render.pageUrls?.[0];
    return (
      <View style={styles.rowLeft}>
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
      </View>
    );
  }

  const isUser = bubble.role === 'user';
  return (
    <View style={isUser ? styles.rowRight : styles.rowLeft}>
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
    alignItems: 'flex-end',
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
    borderColor: 'rgba(0, 0, 0, 0.07)',
    padding: 6,
  },
  plus: {
    width: 34,
    height: 34,
    borderRadius: 17,
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
    width: 34,
    height: 34,
    borderRadius: 17,
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
