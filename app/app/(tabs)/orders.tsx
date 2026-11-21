import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { EmptyState, ErrorState, LoadingState } from '@/components/StateViews';
import { api, fileUrl, type Order, type Render } from '@/lib/api';
import { openUrl } from '@/lib/actions';
import { useBootstrap } from '@/lib/bootstrap';
import { orderDimensions, sortOrders, statusLabel } from '@/lib/format';
import { layout, shared, space, text, colors } from '@/lib/theme';

export default function OrdersScreen() {
  const { data, loading, error, reload } = useBootstrap();
  const orders = useMemo(() => (data ? sortOrders(data.orders) : []), [data]);
  const [renders, setRenders] = useState<Render[]>([]);

  const loadRenders = useCallback(async () => {
    try {
      setRenders(await api.listRenders());
    } catch {
      // The order book still works without the document strip.
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadRenders();
    }, [loadRenders])
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
    <View>
      <View style={styles.header}>
        <Text style={text.eyebrow}>Catalogue studio</Text>
        <Text style={[text.display, styles.title]}>Grace Wood</Text>
        <Text style={[text.muted, styles.subtitle]}>
          Every order the chat has made, with the brochure it produced.
        </Text>
      </View>
      <View style={shared.hairline} />
      <View style={styles.listHeading}>
        <Text style={text.sectionLabel}>History</Text>
        {data ? (
          <Text style={text.caption}>{orders.length === 1 ? '1 order' : `${orders.length} orders`}</Text>
        ) : null}
      </View>
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
          {loading || error ? null : orders.length === 0 ? (
            <EmptyState
              title="No orders yet"
              message="Orders drafted in the studio will be listed here."
            />
          ) : (
            orders.map((order) => (
              <View key={order.id} style={styles.itemGap}>
                <OrderCard order={order} documents={latestDocuments.get(order.id) ?? []} />
              </View>
            ))
          )}
        </ScrollView>
      </View>
    </Screen>
  );
}

function OrderCard({ order, documents }: { order: Order; documents: Render[] }) {
  const dimensions = orderDimensions(order);

  return (
    <View style={styles.card}>
      <View style={shared.rowBetween}>
        <Text style={text.eyebrow}>{order.orderNo}</Text>
        <Text style={text.caption}>{statusLabel(order.status)}</Text>
      </View>
      <Text style={[text.cardTitle, styles.cardTitle]} numberOfLines={2}>
        {order.title}
      </Text>
      <Text style={[text.muted, styles.customer]} numberOfLines={1}>
        {order.customerName}
      </Text>
      {dimensions ? <Text style={[text.caption, styles.dimensions]}>{dimensions}</Text> : null}

      {documents.length === 0 ? (
        <Text style={[text.caption, styles.noDocument]}>No document yet</Text>
      ) : (
        documents.map((document) => (
          <View key={document.id} style={styles.documentRow}>
            {document.kind === 'voucher' ? (
              <Image
                source={{ uri: fileUrl(document.pageUrls[0]) }}
                style={styles.documentThumb}
                resizeMode="cover"
                accessibilityLabel={`Brochure cover for ${order.orderNo}`}
              />
            ) : null}
            <View style={styles.documentInfo}>
              <Text style={[text.caption, styles.documentTitle]}>
                {document.kind === 'voucher' ? 'Brochure' : 'Info kit'}
              </Text>
              <Text style={[text.caption, styles.documentMeta]}>
                {document.pageCount} pages · print ready
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open ${document.kind} PDF for ${order.orderNo}`}
                onPress={() => void openUrl(fileUrl(document.pdfUrl))}
                style={({ pressed }) => [styles.pdfLink, pressed && styles.pdfLinkPressed]}>
                <Text style={styles.pdfLinkLabel}>Open PDF</Text>
              </Pressable>
            </View>
          </View>
        ))
      )}

      <View style={styles.cardActions}>
        <Button
          label="Open order"
          variant="secondary"
          onPress={() => router.push({ pathname: '/orders/[id]', params: { id: order.id } })}
        />
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
    paddingTop: space.xxl,
  },
  title: {
    marginTop: space.sm,
  },
  subtitle: {
    marginTop: space.sm,
    maxWidth: 520,
  },
  listHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: space.xl,
    paddingBottom: space.md,
  },
  itemGap: {
    marginBottom: space.md,
  },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
    borderRadius: layout.radius,
    padding: space.xl,
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
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
    backgroundColor: colors.paper,
  },
  documentInfo: {
    gap: 2,
  },
  documentTitle: {
    color: colors.ink,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  documentMeta: {
    color: colors.faint,
  },
  noDocument: {
    marginTop: space.lg,
    color: colors.faint,
  },
  pdfLink: {
    marginTop: space.xs,
    alignSelf: 'flex-start',
  },
  pdfLinkPressed: {
    opacity: 0.65,
  },
  pdfLinkLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.copper,
  },
  cardActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    marginTop: space.lg,
  },
  cardTitle: {
    marginTop: space.sm,
  },
  customer: {
    marginTop: space.xs,
  },
  dimensions: {
    marginTop: space.md,
  },
});
