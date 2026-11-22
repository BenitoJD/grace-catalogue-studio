import * as ImagePicker from 'expo-image-picker';
import { useEffect, useState } from 'react';
import {
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type ViewStyle,
} from 'react-native';

import { Screen } from '@/components/Screen';
import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { ErrorState, LoadingState } from '@/components/StateViews';
import { api, errorMessage, fileUrl, type Material } from '@/lib/api';
import { useBootstrap } from '@/lib/bootstrap';
import { colors, layout, shared, space, text } from '@/lib/theme';
import { TamilLine } from '@/components/TamilLine';

const GRID_GAP = space.lg;
const HEX_PATTERN = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;
const KINDS = ['laminate', 'edge band', 'veneer', 'acrylic', 'plywood'];

/** Web only: the modal card takes focus on open, remove the browser ring. */
const webFocusReset: ViewStyle | undefined =
  Platform.OS === 'web' ? ({ outlineStyle: 'none' } as unknown as ViewStyle) : undefined;

export default function MaterialsScreen() {
  const { data, loading, error, reload } = useBootstrap();
  const [addOpen, setAddOpen] = useState(false);

  const { width } = useWindowDimensions();
  const materials = data?.materials ?? [];
  const columns = width >= 900 ? 4 : width >= 600 ? 3 : 2;
  const frameWidth = Math.min(width, layout.wideMaxWidth);
  const gridWidth = Math.max(frameWidth - layout.gutter * 2, 240);
  const tileWidth = Math.floor((gridWidth - GRID_GAP * (columns - 1)) / columns);

  const header = (
    <View style={styles.header}>
      <Text style={text.eyebrow}>Grace Wood</Text>
            <TamilLine />
      <Text style={[text.screenTitle, styles.title]}>Materials</Text>
      <Text style={[text.muted, styles.subtitle]}>Colours in the studio catalogue.</Text>
      <View style={styles.actionsRow}>
        <Button label="Add colour" fullWidth onPress={() => setAddOpen(true)} />
      </View>
      <View style={styles.gridHeading}>
        <Text style={text.sectionLabel}>Colours</Text>
        {data ? <Text style={[text.caption, styles.count]}>{materialCountLabel(materials.length)}</Text> : null}
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
      <View style={[shared.frameWide, styles.fill]}>
        <ScrollView
          style={styles.list}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}>
          {header}
          {loading || error ? null : materials.length === 0 ? (
            <View style={styles.empty}>
              <Text style={text.cardTitle}>No colours yet</Text>
              <Text style={[text.muted, styles.emptyMessage]}>
                Colours added to the catalogue will be shown here.
              </Text>
            </View>
          ) : (
            <View style={styles.grid}>
              {materials.map((material) => (
                <MaterialTile key={material.id} material={material} width={tileWidth} />
              ))}
            </View>
          )}
        </ScrollView>
      </View>
      <AddMaterialSheet
        visible={addOpen}
        onClose={() => setAddOpen(false)}
        onSaved={() => {
          setAddOpen(false);
          void reload();
        }}
      />
    </Screen>
  );
}

function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Kind ${label}`}
      onPress={onPress}
      style={({ pressed }) => [styles.chip, active && styles.chipActive, pressed && styles.chipPressed]}>
      <Text style={[styles.chipLabel, active && styles.chipLabelActive]}>{label}</Text>
    </Pressable>
  );
}

function AddMaterialSheet({
  visible,
  onClose,
  onSaved,
}: {
  visible: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState(KINDS[0]);
  const [hex, setHex] = useState('#A65E22');
  const [imageUrl, setImageUrl] = useState('');
  const [sku, setSku] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The web modal moves focus to its wrapper, which paints the browser's blue
  // focus ring around the card. Remove it once, globally, for focusable
  // containers. Fields keep their normal focus state.
  useEffect(() => {
    if (!visible || Platform.OS !== 'web' || typeof document === 'undefined') return;
    if (document.getElementById('gw-focus-reset')) return;
    const style = document.createElement('style');
    style.id = 'gw-focus-reset';
    style.textContent =
      '[tabindex="-1"]:focus, [role="dialog"]:focus { outline: none !important; }';
    document.head.appendChild(style);
  }, [visible]);

  const reset = () => {
    setName('');
    setKind(KINDS[0]);
    setHex('#A65E22');
    setImageUrl('');
    setSku('');
    setError(null);
  };

  const close = () => {
    if (saving) {
      return;
    }
    reset();
    onClose();
  };

  const uploadImage = async () => {
    if (uploading) return;
    setError(null);
    try {
      const picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        base64: true,
        quality: 0.9,
        allowsMultipleSelection: false,
      });
      if (picked.canceled || !picked.assets?.length) return;
      const asset = picked.assets[0];
      if (!asset.base64) {
        setError('That image could not be read. Try another one.');
        return;
      }
      setUploading(true);
      const uploaded = await api.uploadImage(asset.base64, asset.mimeType ?? 'image/png');
      setImageUrl(uploaded.url);
    } catch (failure) {
      setError(errorMessage(failure, 'The image could not be uploaded. Try again.'));
    } finally {
      setUploading(false);
    }
  };

  const save = async () => {
    const trimmedName = name.trim();
    if (trimmedName === '') {
      setError('Give the colour a name.');
      return;
    }
    if (!HEX_PATTERN.test(hex.trim())) {
      setError('The colour code must look like #A65E22.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.createMaterial({
        name: trimmedName,
        kind: kind.trim() === '' ? 'laminate' : kind.trim(),
        hex: hex.trim(),
        imageUrl: imageUrl.trim() === '' ? undefined : imageUrl.trim(),
        sku: sku.trim(),
      });
      reset();
      onSaved();
    } catch (failure) {
      setError(errorMessage(failure, 'The colour could not be saved. Try again.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, webFocusReset]}>
          <ScrollView
            style={webFocusReset}
            contentContainerStyle={styles.sheetContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}>
            <View style={styles.grabber} />
            <Text style={[text.largeCardTitle, styles.sheetTitle]}>Add a colour</Text>
            <Text style={[text.muted, styles.sheetIntro]}>
              It appears in the catalogue and in the finishes page of every voucher.
            </Text>

            <Field
              label="Name"
              value={name}
              onChangeText={setName}
              placeholder="e.g. Teak Natural"
            />

            <Text style={[text.sectionLabel, styles.fieldLabel]}>Kind</Text>
            <View style={styles.chipRow}>
              {KINDS.map((option) => (
                <Chip
                  key={option}
                  label={option}
                  active={kind === option}
                  onPress={() => setKind(option)}
                />
              ))}
            </View>

            <Field
              label="Colour code"
              value={hex}
              onChangeText={setHex}
              placeholder="#A65E22"
              autoCapitalize="characters"
            />
            <View style={styles.hexRow}>
              <View
                style={[
                  styles.hexSwatch,
                  { backgroundColor: HEX_PATTERN.test(hex.trim()) ? hex.trim() : colors.hair },
                ]}
              />
              <Text style={[text.caption, styles.hexHint]}>
                The swatch shows when no image is set.
              </Text>
            </View>

            <Text style={[text.sectionLabel, styles.fieldLabel]}>Swatch image</Text>
            <View style={styles.uploadRow}>
              <View style={styles.uploadPreview}>
                {imageUrl.trim() === '' ? (
                  <Text style={[text.caption, styles.uploadEmpty]}>No image</Text>
                ) : (
                  <Image
                    source={{ uri: fileUrl(imageUrl.trim()) }}
                    style={styles.uploadThumb}
                    resizeMode="cover"
                    accessibilityLabel="Swatch image preview"
                  />
                )}
              </View>
              <View style={styles.uploadActions}>
                <Button
                  label="Upload image"
                  variant="secondary"
                  onPress={() => void uploadImage()}
                  loading={uploading}
                  loadingLabel="Uploading"
                />
                <Text style={[text.caption, styles.uploadHint]}>
                  From the photo library, or paste an address below.
                </Text>
              </View>
            </View>
            <Field
              label="Image address"
              value={imageUrl}
              onChangeText={setImageUrl}
              placeholder="/media/tex-walnut.jpg"
              autoCapitalize="none"
            />

            <Field
              label="Code"
              value={sku}
              onChangeText={setSku}
              placeholder="GW-WAL-06"
              autoCapitalize="characters"
            />

            {error ? <Text style={[text.caption, styles.sheetError]}>{error}</Text> : null}

            <View style={styles.sheetActions}>
              <Button
                label="Save colour"
                onPress={() => void save()}
                loading={saving}
                loadingLabel="Saving"
              />
              <Button label="Cancel" variant="quiet" onPress={close} />
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
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
  fill: {
    flex: 1,
    minHeight: 0,
  },
  list: {
    flex: 1,
    minHeight: 0,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: GRID_GAP,
  },
  content: {
    paddingHorizontal: layout.gutter,
    paddingBottom: space.xxxl,
  },
  header: {
    paddingTop: space.md,
  },
  title: {
    marginTop: 2,
  },
  subtitle: {
    marginTop: 4,
  },
  gridHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: space.xxl,
    paddingBottom: space.md,
  },
  count: {
    color: colors.faint,
  },
  column: {
    gap: GRID_GAP,
  },
  tile: {
    backgroundColor: colors.surface,
    borderRadius: layout.radius,
    padding: 10,
    marginBottom: space.md,
  },
  swatch: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: colors.fill,
  },
  swatchImage: {
    width: '100%',
    height: '100%',
  },
  materialName: {
    marginTop: space.sm + 2,
    fontWeight: '600',
  },
  actionsRow: {
    marginTop: space.lg,
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.lg,
  },
  sheet: {
    width: '100%',
    maxWidth: 540,
    maxHeight: '92%',
    backgroundColor: colors.surface,
    borderRadius: 24,
    overflow: 'hidden',
  },
  grabber: {
    alignSelf: 'center',
    width: 38,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.hair,
    marginBottom: space.md,
  },
  sheetTitle: {
    marginBottom: 4,
  },
  sheetContent: {
    padding: space.lg,
    gap: space.sm,
  },
  sheetIntro: {
    marginBottom: space.sm,
  },
  fieldLabel: {
    marginTop: space.sm,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    marginTop: space.xs,
    marginBottom: space.sm,
  },
  chip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
    borderRadius: 999,
    paddingHorizontal: space.md,
    paddingVertical: 7,
  },
  chipActive: {
    backgroundColor: colors.copper,
    borderColor: colors.copper,
  },
  chipPressed: {
    opacity: 0.75,
  },
  chipLabel: {
    fontSize: 13,
    color: colors.ink,
  },
  chipLabelActive: {
    color: colors.paper,
    fontWeight: '600',
  },
  hexRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  hexSwatch: {
    width: 34,
    height: 34,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
  },
  hexHint: {
    color: colors.faint,
    flex: 1,
  },
  uploadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginTop: space.xs,
    marginBottom: space.sm,
  },
  uploadPreview: {
    width: 64,
    height: 64,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
    backgroundColor: colors.paperDeep,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  uploadThumb: {
    width: '100%',
    height: '100%',
  },
  uploadEmpty: {
    color: colors.faint,
  },
  uploadActions: {
    flex: 1,
    gap: space.xs,
  },
  uploadHint: {
    color: colors.faint,
  },
  sheetError: {
    color: '#8C2F24',
    marginTop: space.xs,
  },
  sheetActions: {
    marginTop: space.md,
    gap: space.sm,
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
