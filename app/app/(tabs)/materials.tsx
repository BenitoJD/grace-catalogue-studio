import { useState } from 'react';
import { FlatList, Image, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { Screen } from '@/components/Screen';
import { ErrorState, LoadingState } from '@/components/StateViews';
import { fileUrl, type Material } from '@/lib/api';
import { useBootstrap } from '@/lib/bootstrap';
import { colors, layout, shared, space, text } from '@/lib/theme';

const LOGO = require('../../assets/images/logo.png');
const GRID_GAP = space.lg;
const HEX_PATTERN = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;

export default function MaterialsScreen() {
  const { data, loading, error, reload } = useBootstrap();
  const { width } = useWindowDimensions();
  const materials = data?.materials ?? [];
  const columns = width >= 900 ? 4 : width >= 600 ? 3 : 2;
  const frameWidth = Math.min(width, layout.wideMaxWidth);
  const gridWidth = Math.max(frameWidth - layout.gutter * 2, 240);
  const tileWidth = Math.floor((gridWidth - GRID_GAP * (columns - 1)) / columns);

  const header = (
    <View style={styles.header}>
      <Image source={LOGO} style={styles.logo} resizeMode="contain" accessibilityLabel="Grace Wood logo" />
      <Text style={[text.eyebrow, styles.eyebrow]}>Grace Wood</Text>
      <Text style={[text.screenTitle, styles.title]}>Materials</Text>
      <Text style={[text.muted, styles.subtitle]}>Colours in the studio catalogue.</Text>
      <View style={[shared.hairline, styles.rule]} />
      <View style={styles.gridHeading}>
        <Text style={text.sectionLabel}>Colours</Text>
        {data ? <Text style={text.caption}>{materialCountLabel(materials.length)}</Text> : null}
      </View>
      {loading && !data ? <LoadingState label="Loading colours." /> : null}
      {error ? (
        <ErrorState
          title={data ? 'Cannot refresh the catalogue' : 'Cannot load the catalogue'}
          message={error}
          onRetry={() => {
            void reload();
          }}
        />
      ) : null}
    </View>
  );

  return (
    <Screen>
      <View style={shared.frameWide}>
        <FlatList
          key={`materials-${columns}`}
          data={materials}
          keyExtractor={(item) => item.id}
          numColumns={columns}
          ListHeaderComponent={header}
          columnWrapperStyle={columns > 1 ? styles.column : undefined}
          contentContainerStyle={styles.content}
          renderItem={({ item }) => <MaterialTile material={item} width={tileWidth} />}
          ListEmptyComponent={
            loading || error ? undefined : (
              <View style={styles.empty}>
                <Text style={text.cardTitle}>No colours yet</Text>
                <Text style={[text.muted, styles.emptyMessage]}>
                  Colours added to the catalogue will be shown here.
                </Text>
              </View>
            )
          }
          showsVerticalScrollIndicator={false}
        />
      </View>
    </Screen>
  );
}

function MaterialTile({ material, width }: { material: Material; width: number }) {
  const [imageFailed, setImageFailed] = useState(false);
  const hex = HEX_PATTERN.test(material.hex) ? material.hex : colors.hair;
  const showImage = Boolean(material.imageUrl) && !imageFailed;

  return (
    <View style={[styles.tile, { width }]}>
      <View style={[styles.swatch, { backgroundColor: hex }]}>
        {showImage && material.imageUrl ? (
          <Image
            source={{ uri: fileUrl(material.imageUrl) }}
            style={styles.swatchImage}
            resizeMode="cover"
            onError={() => setImageFailed(true)}
          />
        ) : null}
      </View>
      <Text style={[text.bodySmall, styles.materialName]} numberOfLines={2}>
        {material.name}
      </Text>
      {material.kind ? (
        <Text style={[text.caption, styles.materialKind]} numberOfLines={1}>
          {material.kind}
        </Text>
      ) : null}
    </View>
  );
}

function materialCountLabel(count: number): string {
  if (count === 1) {
    return '1 colour';
  }
  return `${count} colours`;
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: layout.gutter,
    paddingBottom: space.xxxl,
  },
  header: {
    paddingTop: space.xxl,
  },
  logo: {
    width: 58,
    height: 65,
    alignSelf: 'center',
  },
  eyebrow: {
    marginTop: space.lg,
    textAlign: 'center',
  },
  title: {
    marginTop: space.sm,
    textAlign: 'center',
  },
  subtitle: {
    marginTop: space.xs,
    textAlign: 'center',
  },
  rule: {
    marginTop: space.xl,
  },
  gridHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: space.xl,
    paddingBottom: space.lg,
  },
  column: {
    gap: GRID_GAP,
  },
  tile: {
    marginBottom: space.xl,
  },
  swatch: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: layout.radius,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
    overflow: 'hidden',
  },
  swatchImage: {
    width: '100%',
    height: '100%',
  },
  materialName: {
    marginTop: space.md,
  },
  materialKind: {
    marginTop: 2,
  },
  empty: {
    paddingVertical: space.xxxl,
    maxWidth: 420,
  },
  emptyMessage: {
    marginTop: space.sm,
  },
});
