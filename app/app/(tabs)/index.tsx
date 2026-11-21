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

import { api, errorMessage, fileUrl, type IntakeMessage, type Render } from '@/lib/api';
import { openUrl } from '@/lib/actions';
import { colors, layout, space, text } from '@/lib/theme';

type Bubble =
  | { id: string; role: 'user' | 'assistant'; kind: 'text'; content: string; failed?: boolean }
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
    setInput('');
  }, [cooking, sending]);

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
    [history],
  );

  const send = useCallback(async () => {
    const content = input.trim();
    if (content === '' || sending || cooking) return;

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

    const userBubble: Bubble = { id: nextId(), role: 'user', kind: 'text', content };
    const nextBubbles = [...base, userBubble];
    setBubbles(nextBubbles);
    setInput('');
    setSending(true);
    try {
      const messages = nextBubbles
        .filter((bubble) => bubble.kind === 'text')
        .map((bubble) => ({ role: bubble.role, content: bubble.content }));
      const result = await api.intake(messages, startingFresh ? {} : draft);
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
  }, [bubbles, cooking, createOrderFor, draft, input, orderCreated, sending]);

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
          <View>
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
          ) : (
            <View style={styles.headerMark}>
              <Text style={styles.headerMarkText}>GW</Text>
            </View>
          )}
        </View>

        <View style={[styles.rule]} />

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
              <Avatar role="assistant" />
              <View style={[styles.bubble, styles.bubbleAssistant]}>
                <View style={styles.typing}>
                  <ActivityIndicator size="small" color={colors.copper} />
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

          <View style={styles.composer}>
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
              disabled={busy || input.trim() === ''}
              style={({ pressed }) => [
                styles.send,
                (busy || input.trim() === '') && styles.sendDisabled,
                pressed && styles.sendPressed,
              ]}>
              <Text style={styles.sendLabel}>Send</Text>
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
        <Avatar role="assistant" />
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
      {!isUser ? <Avatar role="assistant" /> : null}
      <View
        style={[
          styles.bubble,
          isUser ? styles.bubbleUser : styles.bubbleAssistant,
          bubble.failed ? styles.bubbleFailed : null,
        ]}>
        <Text style={[text.body, isUser ? styles.userText : styles.assistantText]}>
          {bubble.content}
        </Text>
      </View>
      {isUser ? <Avatar role="user" /> : null}
    </View>
  );
}

function Avatar({ role }: { role: 'user' | 'assistant' }) {
  return (
    <View style={[styles.avatar, role === 'user' ? styles.avatarUser : styles.avatarAssistant]}>
      <Text style={[styles.avatarText, role === 'user' ? styles.avatarTextUser : null]}>
        {role === 'user' ? 'You' : 'GW'}
      </Text>
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

const MAX_BUBBLE = 560;

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: colors.paper,
  },
  frame: {
    flex: 1,
    width: '100%',
    maxWidth: 900,
    alignSelf: 'center',
    paddingHorizontal: layout.gutter,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    marginTop: space.xs,
  },
  headerAction: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
    borderRadius: 10,
    paddingHorizontal: space.md,
    paddingVertical: 8,
  },
  headerActionLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink,
  },
  autoHint: {
    color: colors.faint,
    textAlign: 'center',
  },
  headerMark: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerMarkText: {
    fontFamily: 'Georgia',
    fontSize: 14,
    color: colors.copper,
  },
  rule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.hair,
    marginTop: space.lg,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingVertical: space.lg,
    gap: space.md,
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
    alignItems: 'flex-start',
    gap: space.sm,
  },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  avatarAssistant: {
    backgroundColor: colors.paperDeep,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
  },
  avatarUser: {
    backgroundColor: colors.copper,
  },
  avatarText: {
    fontFamily: 'Georgia',
    fontSize: 10,
    color: colors.copper,
  },
  avatarTextUser: {
    color: colors.paper,
    fontSize: 8,
    letterSpacing: 0.4,
  },
  bubble: {
    maxWidth: MAX_BUBBLE,
    borderRadius: 16,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
  },
  bubbleAssistant: {
    backgroundColor: colors.paperDeep,
  },
  bubbleUser: {
    backgroundColor: colors.copper,
  },
  bubbleFailed: {
    backgroundColor: '#FBEDEA',
  },
  assistantText: {
    color: colors.ink,
    lineHeight: 22,
  },
  userText: {
    color: colors.paper,
    lineHeight: 22,
  },
  typing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: 2,
  },
  typingText: {
    color: colors.muted,
  },
  draftBar: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.hair,
    paddingTop: space.sm,
    gap: space.sm,
  },
  draftInfo: {
    gap: 2,
  },
  draftCount: {
    color: colors.muted,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  draftMissing: {
    color: colors.faint,
  },
  draftReady: {
    color: '#2F6B45',
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
    borderRadius: 14,
    padding: space.sm,
    backgroundColor: colors.paper,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 130,
    fontSize: 15,
    lineHeight: 21,
    color: colors.ink,
    paddingHorizontal: space.sm,
    paddingTop: 9,
    paddingBottom: 9,
  },
  send: {
    backgroundColor: colors.copper,
    borderRadius: 10,
    paddingHorizontal: space.md,
    paddingVertical: 10,
  },
  sendDisabled: {
    opacity: 0.45,
  },
  sendPressed: {
    opacity: 0.75,
  },
  sendLabel: {
    color: colors.paper,
    fontSize: 14,
    fontWeight: '600',
  },
  cook: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    alignItems: 'center',
    gap: 2,
  },
  cookReady: {
    backgroundColor: colors.ink,
    borderColor: colors.ink,
  },
  cookIdle: {
    backgroundColor: colors.paper,
    borderColor: colors.hair,
  },
  cookLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.muted,
  },
  cookLabelReady: {
    color: colors.paper,
  },
  cookHint: {
    fontSize: 11,
    color: colors.faint,
  },
  cookHintReady: {
    color: 'rgba(255,255,255,0.72)',
  },
  brochure: {
    padding: space.md,
    gap: space.sm,
  },
  brochureTitle: {
    fontWeight: '600',
  },
  brochureMeta: {
    color: colors.muted,
  },
  preview: {
    width: 200,
    height: 283,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
    backgroundColor: colors.paper,
  },
  brochureActions: {
    flexDirection: 'row',
    gap: space.sm,
  },
  smallAction: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
    borderRadius: 8,
    paddingHorizontal: space.sm + 2,
    paddingVertical: 6,
    backgroundColor: colors.paper,
  },
  smallActionLabel: {
    fontSize: 12,
    color: colors.ink,
    fontWeight: '600',
  },
});
