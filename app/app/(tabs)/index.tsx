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

  useEffect(() => {
    const timer = setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 80);
    return () => clearTimeout(timer);
  }, [bubbles.length, sending, cooking]);

  const history = useCallback((): IntakeMessage[] => {
    return bubbles
      .filter((bubble) => bubble.kind === 'text')
      .map((bubble) => ({ role: bubble.role, content: bubble.content }));
  }, [bubbles]);

  const send = useCallback(async () => {
    const content = input.trim();
    if (content === '' || sending || cooking) return;
    const userBubble: Bubble = { id: nextId(), role: 'user', kind: 'text', content };
    const nextBubbles = [...bubbles, userBubble];
    setBubbles(nextBubbles);
    setInput('');
    setSending(true);
    try {
      const messages = nextBubbles
        .filter((bubble) => bubble.kind === 'text')
        .map((bubble) => ({ role: bubble.role, content: bubble.content }));
      const result = await api.intake(messages, draft);
      setDraft(result.draft);
      setMissing(result.missing);
      setReady(result.ready);
      setBubbles((current) => [
        ...current,
        { id: nextId(), role: 'assistant', kind: 'text', content: result.reply },
      ]);
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
  }, [bubbles, cooking, draft, input, sending]);

  const cook = useCallback(async () => {
    if (cooking || sending) return;
    if (!ready) {
      const list = missing.length > 0 ? missing.join(', ') : 'a few details';
      setBubbles((current) => [
        ...current,
        {
          id: nextId(),
          role: 'assistant',
          kind: 'text',
          content: `I still need ${list}. Send those and I will make the brochure.`,
        },
      ]);
      return;
    }
    setCooking(true);
    try {
      const customer = await api.createCustomer({ name: draft.customerName });
      const order = await api.createOrder({
        customerId: customer.id,
        title: draft.title,
        room: draft.room,
        width: draft.width,
        height: draft.height,
        depth: draft.depth,
        shutters: draft.shutters,
        carcass: draft.carcass,
        backPanel: draft.backPanel,
        shuttersMat: draft.shuttersMat,
        drawers: draft.drawers,
        exterior: draft.exterior,
        interior: draft.interior,
        edgeShutter: draft.edgeShutter,
        edgeCarcass: draft.edgeCarcass,
        edgeNote: draft.edgeNote,
        handle: draft.handle,
        handleNote: draft.handleNote,
        finishExt: draft.finishExt,
        finishInt: draft.finishInt,
      } as Parameters<typeof api.createOrder>[0]);

      const brief =
        draft.brief ??
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
          content: 'The brochure is ready. Four pages, print ready.',
          orderId: order.id,
          orderNo: order.orderNo,
          render,
        },
      ]);
      // Start clean: the next dump belongs to a new order, and a second press
      // cannot create a duplicate by accident.
      setDraft({});
      setMissing([]);
      setReady(false);
    } catch (error) {
      setBubbles((current) => [
        ...current,
        {
          id: nextId(),
          role: 'assistant',
          kind: 'text',
          content: errorMessage(error, 'The brochure could not be made. Try again.'),
          failed: true,
        },
      ]);
    } finally {
      setCooking(false);
    }
  }, [cooking, draft, history, missing, ready, sending]);

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
          <View style={styles.headerMark}>
            <Text style={styles.headerMarkText}>GW</Text>
          </View>
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
                    {cooking ? 'Making the brochure' : 'Reading'}
                  </Text>
                </View>
              </View>
            </View>
          ) : null}
        </ScrollView>

        <View style={[styles.draftBar, { paddingBottom: Math.max(insets.bottom, space.sm) }]}>
          <View style={styles.draftInfo}>
            <Text style={[text.caption, styles.draftCount]}>
              {fieldCount === 0 ? 'Nothing captured yet' : `${fieldCount} details captured`}
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
              placeholder="Paste the customer's requirement"
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

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cook the brochure"
            onPress={() => void cook()}
            disabled={busy}
            style={({ pressed }) => [
              styles.cook,
              ready ? styles.cookReady : styles.cookIdle,
              busy && styles.sendDisabled,
              pressed && styles.sendPressed,
            ]}>
            <Text style={[styles.cookLabel, ready ? styles.cookLabelReady : null]}>
              Cook the brochure
            </Text>
            <Text style={[styles.cookHint, ready ? styles.cookHintReady : null]}>
              {ready
                ? 'Creates the order, writes the copy and renders the voucher'
                : 'Send the missing details first'}
            </Text>
          </Pressable>
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
