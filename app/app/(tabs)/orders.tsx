import { router, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';

import { Screen } from '@/components/Screen';
import { EmptyState, ErrorState, LoadingState } from '@/components/StateViews';
import { api, fileUrl, type Order, type Render } from '@/lib/api';
import { openUrl } from '@/lib/actions';
import { useBootstrap } from '@/lib/bootstrap';
import { orderDimensions, sortOrders, statusLabel } from '@/lib/format';
import { layout, shared, space, text, colors } from '@/lib/theme';

export default function OrdersScreen() {
  const { data, loading, error, reload } = useBootstrap();
  const { width } = useWindowDimensions();
  const wide = width >= 1100;
  const orders = useMemo(() => (data ? sortOrders(data.orders) : []), [data]);
  const [renders, setRenders] = useState<Render[]>([]);
  const [query, setQuery] = useState('');
  const visibleOrders = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return orders;
    return orders.filter((order) =>
      `${order.orderNo} ${order.title} ${order.customerName} ${order.room}`.toLowerCase().includes(needle)
    );
  }, [orders, query]);

  const loadRenders = useCallback(async () => {
    try {
      setRenders(await api.listRenders());
    } catch {
      // The order book still works without the document strip.
    }
  }, []);

  // A new order can be created inside the chat while this tab is mounted, so
  // the order book must reload on focus, not only on first mount.
  useFocusEffect(
    useCallback(() => {
      void reload();
      void loadRenders();
    }, [loadRenders, reload])
  );

  // One row per generated document kind: the latest voucher and the latest kit.
  const latestDocuments = useMemo(() => {
    const byOrder = new Map<string, Map<string, Render>>();
    for (const render of renders) {
      if (!render.orderId) continue;
      const forOrder = byOrder.get(render.orderId) ?? new Map<string, Render>();
      const current = forOrder.get(render.kind);
      if (!current || render.createdAt > current.createdAt) forOrder.set(render.kind, render);
      byOrder.set(render.orderId, forOrder);
    }
    const grouped = new Map<string, Render[]>();
    for (const [orderId, kinds] of byOrder) {
      grouped.set(
        orderId,
        [...kinds.values()].sort((left, right) => {
          if (left.kind === 'voucher') return -1;
          if (right.kind === 'voucher') return 1;
          return left.kind.localeCompare(right.kind);
        })
      );
    }
    return grouped;
  }, [renders]);

  const header = (
    <View style={styles.hHeader}>
      <View style={styles.hBrandRow}>
        <Image
          source={require('@/assets/images/logo.png')}
          style={styles.hBrandMark}
          resizeMode="contain"
          accessibilityLabel="Jacob Design Studio"
        />
        <Text style={styles.hBrandName}>Jacob Studio</Text>
      </View>
      <View style={styles.hTitleRow}>
        <Text style={styles.hTitle}>History</Text>
        {data ? (
          <Text style={styles.hCount}>
            {visibleOrders.length === 1 ? '1 order' : `${visibleOrders.length} orders`}
          </Text>
        ) : null}
      </View>
      <Text style={styles.hSub}>Every order the studio has made, with the pamphlet it produced.</Text>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search by customer, title, room or order number"
        placeholderTextColor={colors.faint}
        style={styles.hSearch}
        accessibilityLabel="Search orders"
      />
      {loading && !data ? <LoadingState label="Loading orders." /> : null}
      {error ? (
        <ErrorState
          title={data ? 'Cannot refresh the order book' : 'Cannot load the order book'}
          message={error}
          onRetry={() => {
            void reload();
          }}
          retrying={false}
        />
      ) : null}
    </View>
  );

  return (
    <Screen>
      <View style={[shared.frame, styles.fill]}>
        <ScrollView
          style={styles.list}
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={loading && Boolean(data)}
              onRefresh={() => {
                void reload();
              }}
              tintColor={colors.copper}
              colors={[colors.copper]}
            />
          }
          showsVerticalScrollIndicator={false}>
          {header}
          {loading || error ? null : visibleOrders.length === 0 ? (
            <EmptyState
              title={orders.length === 0 ? 'No orders yet' : 'No matches'}
              message={
                orders.length === 0
                  ? 'Orders drafted in the studio will be listed here.'
                  : 'Try another customer, title or order number.'
              }
            />
          ) : (
            <View style={[styles.grid, wide && styles.gridWide]}>
              {visibleOrders.map((order) => (
                <View key={order.id} style={[styles.gridItem, wide && styles.gridItemWide]}>
                  <OrderCard order={order} documents={latestDocuments.get(order.id) ?? []} />
                </View>
              ))}
            </View>
          )}
        </ScrollView>
      </View>
    </Screen>
  );
}

function OrderCard({ order, documents }: { order: Order; documents: Render[] }) {
  const document = documents.find((entry) => entry.kind !== 'kit') ?? null;
  return (
    <View style={styles.hCard}>
      <View style={styles.cardHead}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open order ${order.orderNo}`}
          onPress={() => router.push({ pathname: '/orders/[id]', params: { id: order.id } })}
          style={({ pressed }) => [styles.cardMain, pressed && styles.cardPressed]}>
          {document ? (
            <Image
              source={{ uri: fileUrl(document.pageUrls[0]) }}
              style={styles.cardThumb}
              resizeMode="cover"
              accessibilityLabel={`Pamphlet cover for ${order.orderNo}`}
            />
          ) : (
            <View style={[styles.cardThumb, styles.cardThumbEmpty]}>
              <Text style={styles.cardThumbEmptyLabel}>No print yet</Text>
            </View>
          )}
          <View style={styles.cardText}>
            <View style={styles.cardMetaRow}>
              <Text style={styles.cardNumber}>{order.orderNo}</Text>
              <View style={styles.cardStatus}>
                <Text style={styles.cardStatusLabel}>{statusLabel(order.status)}</Text>
              </View>
            </View>
            <Text style={styles.hCardTitle} numberOfLines={1}>
              {order.title || 'Untitled order'}
            </Text>
            <Text style={styles.cardCustomer} numberOfLines={1}>
              {order.customerName}
              {order.room ? ` · ${order.room}` : ''}
            </Text>
            <Text style={styles.cardPages}>
              {document ? `${document.pageCount} sides · print ready` : 'No pamphlet yet'}
            </Text>
          </View>
        </Pressable>
      </View>
      <View style={styles.cardActions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Continue the chat for ${order.orderNo}`}
          onPress={() =>
            router.push({ pathname: '/', params: { orderId: order.id, orderNo: order.orderNo } })
          }
          style={({ pressed }) => [styles.action, styles.actionPrimary, pressed && styles.cardPressed]}>
          <Text style={[styles.actionLabel, styles.actionLabelPrimary]}>Chat</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open the pages workspace for ${order.orderNo}`}
          onPress={() => router.push(`/workspace/${order.id}` as Href)}
          style={({ pressed }) => [styles.action, pressed && styles.cardPressed]}>
          <Text style={styles.actionLabel}>Pages</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open order ${order.orderNo}`}
          onPress={() => router.push({ pathname: '/orders/[id]', params: { id: order.id } })}
          style={({ pressed }) => [styles.action, pressed && styles.cardPressed]}>
          <Text style={styles.actionLabel}>Order</Text>
        </Pressable>
        {document ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open brochure PDF for ${order.orderNo}`}
            onPress={() => void openUrl(fileUrl(document.pdfUrl))}
            style={({ pressed }) => [styles.action, pressed && styles.cardPressed]}>
            <Text style={styles.actionLabel}>PDF</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    minHeight: 0,
  },
  list: {
    flex: 1,
    minHeight: 0,
  },
  content: {
    paddingHorizontal: layout.gutter,
    paddingBottom: space.xxxl,
  },
  header: {
    paddingTop: space.md,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  brandText: {
    flexShrink: 1,
  },
  brandMark: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
    flexShrink: 0,
  },
  title: {
    marginTop: 2,
  },
  subtitle: {
    marginTop: 4,
    maxWidth: 520,
  },
  listHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: space.xl,
    paddingBottom: space.sm,
  },
  itemGap: {
    marginBottom: space.md,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: layout.radius,
    padding: space.lg,
  },
  statusPill: {
    backgroundColor: colors.fill,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.muted,
  },
  documentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginTop: space.lg,
  },
  documentThumb: {
    width: 52,
    height: 74,
    borderRadius: 8,
    backgroundColor: colors.fill,
  },
  documentInfo: {
    gap: 2,
    flexShrink: 1,
  },
  documentTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.ink,
  },
  documentMeta: {
    color: colors.faint,
  },
  noDocument: {
    marginTop: space.lg,
    color: colors.faint,
  },
  pdfLink: {
    marginTop: 4,
    alignSelf: 'flex-start',
  },
  pdfLinkPressed: {
    opacity: 0.6,
  },
  pdfLinkLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.copper,
  },
  openRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.hairInset,
    marginTop: space.lg,
    paddingTop: space.md,
  },
  openRowPressed: {
    opacity: 0.6,
  },
  openRowLabel: {
    fontSize: 16,
    fontWeight: '500',
    color: colors.copper,
  },
  openRowChevron: {
    fontSize: 22,
    lineHeight: 24,
    color: colors.faint,
  },
  cardTitle: {
    marginTop: space.sm,
    fontSize: 18,
  },
  customer: {
    marginTop: 2,
  },
  dimensions: {
    marginTop: space.sm,
  },
  hHeader: {
    paddingTop: 14,
    paddingBottom: 12,
    gap: 8,
  },
  hBrandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  hBrandMark: {
    width: 24,
    height: 24,
    borderRadius: 6,
  },
  hBrandName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#0D0D0D',
    letterSpacing: -0.2,
  },
  hTitleRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 10,
    marginTop: 8,
  },
  hTitle: {
    fontSize: 32,
    fontWeight: '700',
    letterSpacing: -0.8,
    color: '#0D0D0D',
  },
  hCount: {
    fontSize: 13,
    color: '#8E8E93',
  },
  hSub: {
    fontSize: 14,
    color: '#6E6E73',
  },
  hSearch: {
    marginTop: 10,
    height: 42,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#E5E5E5',
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 14,
    fontSize: 14,
    color: '#0D0D0D',
  },
  grid: {
    gap: 12,
  },
  gridWide: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  gridItem: {
    width: '100%',
  },
  gridItemWide: {
    width: '49%',
  },
  hCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#ECECEC',
    padding: 14,
    gap: 12,
  },
  cardHead: {
    flexDirection: 'row',
  },
  cardMain: {
    flex: 1,
    flexDirection: 'row',
    gap: 12,
  },
  cardPressed: {
    opacity: 0.7,
  },
  cardThumb: {
    width: 74,
    height: 98,
    borderRadius: 10,
    backgroundColor: '#F2F2F2',
  },
  cardThumbEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#E5E5E5',
  },
  cardThumbEmptyLabel: {
    fontSize: 9,
    color: '#8E8E93',
    textAlign: 'center',
  },
  cardText: {
    flex: 1,
    gap: 3,
    justifyContent: 'center',
  },
  cardMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  cardNumber: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.3,
    color: '#8E8E93',
  },
  cardStatus: {
    backgroundColor: '#F4F4F4',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  cardStatusLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: '#6E6E73',
  },
  hCardTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#0D0D0D',
    letterSpacing: -0.2,
  },
  cardCustomer: {
    fontSize: 13,
    color: '#6E6E73',
  },
  cardPages: {
    fontSize: 11.5,
    color: '#8E8E93',
    marginTop: 2,
  },
  cardActions: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
  action: {
    borderWidth: 1,
    borderColor: '#E5E5E5',
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 6,
  },
  actionPrimary: {
    backgroundColor: '#0D0D0D',
    borderColor: '#0D0D0D',
  },
  actionLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#0D0D0D',
  },
  actionLabelPrimary: {
    color: '#FFFFFF',
  },
});
