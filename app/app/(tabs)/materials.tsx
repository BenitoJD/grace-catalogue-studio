import { useCallback, useEffect, useState } from 'react';
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
import { openUrl } from '@/lib/actions';
import { useBootstrap } from '@/lib/bootstrap';
import { colors, layout, shared, space, text } from '@/lib/theme';

const LOGO = require('../../assets/images/logo.png');
const GRID_GAP = space.lg;
const HEX_PATTERN = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;
const KINDS = ['laminate', 'edge band', 'veneer', 'acrylic', 'plywood'];

/** Web only: the modal card takes focus on open, remove the browser ring. */
const webFocusReset: ViewStyle | undefined =
  Platform.OS === 'web' ? ({ outlineStyle: 'none' } as unknown as ViewStyle) : undefined;
const UNITS = ['sheet', 'metre', 'piece'];

export default function MaterialsScreen() {
  const { data, loading, error, reload } = useBootstrap();
  const [rateLoading, setRateLoading] = useState(false);
  const [rateError, setRateError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const printRateCard = useCallback(async () => {
    if (rateLoading) {
      return;
    }
    setRateLoading(true);
    setRateError(null);
    try {
      const rendered = await api.renderCatalogue();
      await openUrl(fileUrl(rendered.pdfUrl));
    } catch (failure) {
      setRateError(errorMessage(failure, 'The rate card could not be rendered. Try again.'));
    } finally {
      setRateLoading(false);
    }
  }, [rateLoading]);
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
      <View style={styles.actionsRow}>
        <View style={styles.actionItem}>
          <Button label="Add colour" onPress={() => setAddOpen(true)} />
        </View>
        <View style={styles.actionItem}>
          <Button
            label="Print rate card"
            variant="secondary"
            onPress={() => void printRateCard()}
            loading={rateLoading}
            loadingLabel="Rendering"
          />
        </View>
      </View>
      {rateError ? <Text style={[text.caption, styles.rateError]}>{rateError}</Text> : null}
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
  const [priceAmount, setPriceAmount] = useState('');
  const [priceUnit, setPriceUnit] = useState(UNITS[0]);
  const [sku, setSku] = useState('');
  const [saving, setSaving] = useState(false);
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
    setPriceAmount('');
    setPriceUnit(UNITS[0]);
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
    const amount = priceAmount.trim() === '' ? 0 : Number(priceAmount.replace(/[^\d.]/g, ''));
    if (!Number.isFinite(amount) || amount < 0) {
      setError('The rate must be a number, zero or more.');
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
        priceAmount: amount,
        priceUnit: priceUnit.trim(),
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
            <Text style={text.cardTitle}>Add a colour</Text>
            <Text style={[text.muted, styles.sheetIntro]}>
              It appears in the catalogue and on the printed rate card.
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

            <Field
              label="Swatch image"
              value={imageUrl}
              onChangeText={setImageUrl}
              placeholder="/media/tex-walnut.jpg"
              autoCapitalize="none"
            />

            <Field
              label="Rate"
              value={priceAmount}
              onChangeText={setPriceAmount}
              placeholder="1240"
              autoCapitalize="none"
            />
            <Text style={[text.sectionLabel, styles.fieldLabel]}>Rate unit</Text>
            <View style={styles.chipRow}>
              {UNITS.map((option) => (
                <Chip
                  key={option}
                  label={option}
                  active={priceUnit === option}
                  onPress={() => setPriceUnit(option)}
                />
              ))}
            </View>

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
      {typeof material.priceAmount === 'number' && material.priceAmount > 0 ? (
        <Text style={[text.caption, styles.materialRate]} numberOfLines={1}>
          {`₹${material.priceAmount.toLocaleString('en-IN')} per ${material.priceUnit || 'unit'}`}
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
  materialRate: {
    color: colors.copper,
  },
  actionsRow: {
    marginTop: space.lg,
    flexDirection: 'row',
    gap: space.sm,
  },
  actionItem: {
    flex: 1,
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(28, 26, 23, 0.42)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.lg,
  },
  sheet: {
    width: '100%',
    maxWidth: 520,
    maxHeight: '92%',
    backgroundColor: colors.paper,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
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
  sheetError: {
    color: '#8C2F24',
    marginTop: space.xs,
  },
  sheetActions: {
    marginTop: space.md,
    gap: space.sm,
  },
  rateError: {
    color: '#8C2F24',
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
