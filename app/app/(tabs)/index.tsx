import { router } from 'expo-router';
import { useMemo } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { EmptyState, ErrorState, LoadingState } from '@/components/StateViews';
import type { Order } from '@/lib/api';
import { useBootstrap } from '@/lib/bootstrap';
import { orderDimensions, sortOrders, statusLabel } from '@/lib/format';
import { layout, shared, space, text, colors } from '@/lib/theme';

export default function OrdersScreen() {
  const { data, loading, error, reload } = useBootstrap();
  const orders = useMemo(() => (data ? sortOrders(data.orders) : []), [data]);

  const header = (
    <View>
      <View style={styles.header}>
        <Text style={text.eyebrow}>Catalogue studio</Text>
        <Text style={[text.display, styles.title]}>Grace Wood</Text>
        <View style={styles.headerAction}>
          <Button label="New order" onPress={() => router.push('/orders/new')} />
        </View>
      </View>
      <View style={shared.hairline} />
      <View style={styles.listHeading}>
        <Text style={text.sectionLabel}>Orders</Text>
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
      <View style={shared.frame}>
        <FlatList
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
          data={orders}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={header}
          contentContainerStyle={styles.content}
          ItemSeparatorComponent={() => <View style={styles.itemGap} />}
          renderItem={({ item }) => <OrderCard order={item} />}
          ListEmptyComponent={
            loading || error ? undefined : (
              <EmptyState
                title="No orders yet"
                message="Orders drafted in the studio will be listed here."
              />
            )
          }
          showsVerticalScrollIndicator={false}
        />
      </View>
    </Screen>
  );
}

function OrderCard({ order }: { order: Order }) {
  const dimensions = orderDimensions(order);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Order ${order.orderNo}, ${order.title}, for ${order.customerName}`}
      onPress={() => router.push({ pathname: '/orders/[id]', params: { id: order.id } })}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}>
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
    </Pressable>
  );
}

const styles = StyleSheet.create({
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
  headerAction: {
    marginTop: space.xl,
    alignSelf: 'flex-start',
  },
  listHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: space.xl,
    paddingBottom: space.md,
  },
  itemGap: {
    height: space.md,
  },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
    borderRadius: layout.radius,
    padding: space.xl,
  },
  cardPressed: {
    opacity: 0.65,
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
