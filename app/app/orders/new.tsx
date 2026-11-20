import { router } from 'expo-router';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { Screen } from '@/components/Screen';
import { ScreenHeader } from '@/components/ScreenHeader';
import { ErrorState, LoadingState } from '@/components/StateViews';
import { api, errorMessage } from '@/lib/api';
import { useBootstrap } from '@/lib/bootstrap';
import { colors, layout, shared, space, text } from '@/lib/theme';

const DEFAULT_DRAFT = {
  title: 'Wardrobe',
  room: 'Master bedroom',
  width: '2400 mm',
  height: '2100 mm',
  depth: '600 mm',
  shutters: '3 · 800 mm',
  carcass: '18 mm BWP plywood',
  backPanel: '6 mm plywood',
  shuttersMat: 'Laminate',
  drawers: '12 mm plywood',
  exterior: 'Walnut laminate',
  interior: 'Ivory laminate',
  hinges: 'Soft close hinges',
  channels: 'Soft close channels',
  edgeShutter: '2 mm PVC',
  edgeCarcass: '0.8 mm PVC',
  handle: 'Slim profile',
  handleNote: '',
  finishExt: 'Matte',
  finishInt: 'Matte',
};

type DraftKey = keyof typeof DEFAULT_DRAFT;
type Draft = Record<DraftKey, string>;

interface FieldSpec {
  label: string;
  placeholder: string;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  multiline?: boolean;
}

const FIELD_SPECS: Record<DraftKey, FieldSpec> = {
  title: { label: 'Title', placeholder: 'Master Bedroom Wardrobe', autoCapitalize: 'words' },
  room: { label: 'Room', placeholder: 'Master bedroom', autoCapitalize: 'sentences' },
  width: { label: 'Width', placeholder: '2400 mm' },
  height: { label: 'Height', placeholder: '2100 mm' },
  depth: { label: 'Depth', placeholder: '600 mm' },
  shutters: { label: 'Shutters', placeholder: '3 · 800 mm' },
  carcass: { label: 'Carcass', placeholder: '18 mm BWP plywood', autoCapitalize: 'words' },
  backPanel: { label: 'Back panel', placeholder: '6 mm plywood', autoCapitalize: 'words' },
  shuttersMat: { label: 'Shutter material', placeholder: 'Laminate', autoCapitalize: 'words' },
  drawers: { label: 'Drawers', placeholder: '12 mm plywood', autoCapitalize: 'words' },
  exterior: { label: 'Exterior laminate', placeholder: 'Walnut laminate', autoCapitalize: 'words' },
  interior: { label: 'Interior laminate', placeholder: 'Ivory laminate', autoCapitalize: 'words' },
  hinges: { label: 'Hinges', placeholder: 'Soft close hinges', autoCapitalize: 'words' },
  channels: { label: 'Channels', placeholder: 'Soft close channels', autoCapitalize: 'words' },
  edgeShutter: { label: 'Edge band shutters', placeholder: '2 mm PVC', autoCapitalize: 'words' },
  edgeCarcass: { label: 'Edge band carcass', placeholder: '0.8 mm PVC', autoCapitalize: 'words' },
  handle: { label: 'Handle', placeholder: 'Slim profile', autoCapitalize: 'words' },
  handleNote: { label: 'Handle note', placeholder: 'Centred on shutters', multiline: true },
  finishExt: { label: 'Exterior finish', placeholder: 'Matte', autoCapitalize: 'words' },
  finishInt: { label: 'Interior finish', placeholder: 'Matte', autoCapitalize: 'words' },
};

const GROUPS: { title: string; rows: DraftKey[][] }[] = [
  { title: 'Specification', rows: [['title'], ['room']] },
  { title: 'Dimensions', rows: [['width', 'height', 'depth'], ['shutters']] },
  {
    title: 'Carcass',
    rows: [['carcass', 'backPanel'], ['shuttersMat', 'drawers']],
  },
  {
    title: 'Laminates',
    rows: [
      ['exterior', 'interior'],
      ['edgeShutter', 'edgeCarcass'],
    ],
  },
  {
    title: 'Hardware',
    rows: [['hinges', 'channels'], ['handle'], ['handleNote']],
  },
  {
    title: 'Finish',
    rows: [['finishExt', 'finishInt']],
  },
];

type CustomerMode = 'existing' | 'new';

export default function NewOrderScreen() {
  const { data, loading, error, reload } = useBootstrap();
  const insets = useSafeAreaInsets();

  const [draft, setDraft] = useState<Draft>({ ...DEFAULT_DRAFT });
  const [mode, setMode] = useState<CustomerMode | null>(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [newCustomerName, setNewCustomerName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const customers = useMemo(() => data?.customers ?? [], [data]);
  const customerMode: CustomerMode = mode ?? (customers.length > 0 ? 'existing' : 'new');

  const setField = useCallback((key: DraftKey, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
  }, []);

  const goBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/');
  }, []);

  const submit = useCallback(async () => {
    if (submitting) {
      return;
    }

    const title = draft.title.trim();
    const width = draft.width.trim();
    const height = draft.height.trim();
    const depth = draft.depth.trim();

    if (customerMode === 'existing' && !selectedCustomerId) {
      setSubmitError('Choose a customer.');
      return;
    }
    if (customerMode === 'new' && !newCustomerName.trim()) {
      setSubmitError('Add the customer name.');
      return;
    }
    if (!title) {
      setSubmitError('Add a title for the order.');
      return;
    }
    if (!width || !height || !depth) {
      setSubmitError('Add the width, height and depth.');
      return;
    }

    setSubmitError(null);
    setSubmitting(true);
    try {
      let customerId = selectedCustomerId;
      if (customerMode === 'new') {
        const customer = await api.createCustomer({ name: newCustomerName.trim() });
        customerId = customer.id;
      }
      if (!customerId) {
        setSubmitError('Choose a customer.');
        setSubmitting(false);
        return;
      }

      const trimmed = Object.fromEntries(
        (Object.entries(draft) as [DraftKey, string][]).map(([key, value]) => [key, value.trim()]),
      ) as Record<DraftKey, string>;

      const order = await api.createOrder({
        customerId,
        title: trimmed.title,
        room: trimmed.room,
        width: trimmed.width,
        height: trimmed.height,
        depth: trimmed.depth,
        shutters: trimmed.shutters,
        carcass: trimmed.carcass,
        backPanel: trimmed.backPanel,
        shuttersMat: trimmed.shuttersMat,
        drawers: trimmed.drawers,
        exterior: trimmed.exterior,
        interior: trimmed.interior,
        hinges: trimmed.hinges,
        channels: trimmed.channels,
        edgeShutter: trimmed.edgeShutter,
        edgeCarcass: trimmed.edgeCarcass,
        edgeNote: '',
        handle: trimmed.handle,
        handleNote: trimmed.handleNote,
        finishExt: trimmed.finishExt,
        finishInt: trimmed.finishInt,
      });

      // Refresh the shared bootstrap cache so the order book shows the new order.
      void reload();
      router.replace({ pathname: '/orders/[id]', params: { id: order.id } });
    } catch (submitFailure) {
      setSubmitError(errorMessage(submitFailure, 'The order could not be created. Try again.'));
      setSubmitting(false);
    }
  }, [customerMode, draft, newCustomerName, reload, selectedCustomerId, submitting]);

  return (
    <Screen>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.scrollContent}>
          <View style={[shared.frame, styles.page]}>
            <ScreenHeader
              back
              onBack={goBack}
              eyebrow="Order intake"
              title="New order"
              subtitle="Fields come prefilled. Choose a customer and create the order."
            />

            {loading && !data ? <LoadingState label="Loading customers." /> : null}

            {error && !data ? (
              <ErrorState
                title="Cannot start an order"
                message={error}
                onRetry={() => {
                  void reload();
                }}
              />
            ) : null}

            {data ? (
              <>
                <FormSection title="Customer">
                  <View style={styles.modeRow}>
                    <ModeButton
                      label="Existing customer"
                      active={customerMode === 'existing'}
                      disabled={customers.length === 0}
                      onPress={() => {
                        setMode('existing');
                        setSubmitError(null);
                      }}
                    />
                    <ModeButton
                      label="New customer"
                      active={customerMode === 'new'}
                      onPress={() => {
                        setMode('new');
                        setSelectedCustomerId(null);
                        setSubmitError(null);
                      }}
                    />
                  </View>

                  {customerMode === 'existing' ? (
                    customers.length === 0 ? (
                      <Text style={text.caption}>
                        No saved customers yet. Add a new customer instead.
                      </Text>
                    ) : (
                      <View style={styles.chips}>
                        {customers.map((customer) => {
                          const selected = customer.id === selectedCustomerId;
                          return (
                            <Pressable
                              key={customer.id}
                              accessibilityRole="button"
                              accessibilityState={{ selected }}
                              accessibilityLabel={`Choose customer ${customer.name}`}
                              onPress={() => {
                                setSelectedCustomerId(customer.id);
                                setSubmitError(null);
                              }}
                              style={({ pressed }) => [
                                styles.chip,
                                selected && styles.chipSelected,
                                pressed && styles.pressed,
                              ]}>
                              <Text
                                style={[
                                  text.bodySmall,
                                  selected ? styles.chipLabelSelected : styles.chipLabel,
                                ]}
                                numberOfLines={1}>
                                {customer.name}
                              </Text>
                            </Pressable>
                          );
                        })}
                      </View>
                    )
                  ) : (
                    <View style={styles.newCustomer}>
                      <Field
                        label="Customer name"
                        value={newCustomerName}
                        onChangeText={(value) => {
                          setNewCustomerName(value);
                          setSubmitError(null);
                        }}
                        placeholder="Anitha Selvam"
                        autoCapitalize="words"
                        maxLength={120}
                      />
                    </View>
                  )}
                </FormSection>

                {GROUPS.map((group) => (
                  <FormSection key={group.title} title={group.title}>
                    {group.rows.map((row, rowIndex) => (
                      <View key={`${group.title}-${rowIndex}`} style={styles.fieldRow}>
                        {row.map((key) => {
                          const spec = FIELD_SPECS[key];
                          return (
                            <View key={key} style={styles.fieldCell}>
                              <Field
                                label={spec.label}
                                value={draft[key]}
                                onChangeText={(value) => setField(key, value)}
                                placeholder={spec.placeholder}
                                autoCapitalize={spec.autoCapitalize}
                                multiline={spec.multiline}
                              />
                            </View>
                          );
                        })}
                      </View>
                    ))}
                  </FormSection>
                ))}
              </>
            ) : null}
          </View>
        </ScrollView>

        {data ? (
          <View style={styles.footerBar}>
            <View style={[shared.frame, styles.footer, { paddingBottom: space.md + insets.bottom }]}>
              {submitError ? (
                <Text style={[text.bodySmall, styles.footerError]} accessibilityLiveRegion="polite">
                  {submitError}
                </Text>
              ) : null}
              <Button
                label="Create order"
                loading={submitting}
                loadingLabel="Creating order"
                onPress={() => {
                  void submit();
                }}
                fullWidth
              />
            </View>
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </Screen>
  );
}

function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={[text.sectionLabel, styles.sectionTitle]}>{title}</Text>
      {children}
    </View>
  );
}

function ModeButton({
  label,
  active,
  disabled,
  onPress,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled }}
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.modeButton,
        active && styles.modeButtonActive,
        disabled && styles.modeButtonDisabled,
        pressed && !disabled && styles.pressed,
      ]}>
      <Text style={[text.bodySmall, active ? styles.modeLabelActive : styles.modeLabel]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: space.xxl,
  },
  page: {
    paddingHorizontal: layout.gutter,
  },
  section: {
    marginTop: space.xxl,
  },
  sectionTitle: {
    marginBottom: space.lg,
  },
  modeRow: {
    flexDirection: 'row',
    gap: space.sm,
  },
  modeButton: {
    minHeight: 40,
    paddingHorizontal: space.md,
    borderRadius: layout.radius,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeButtonActive: {
    backgroundColor: colors.copper,
    borderColor: colors.copper,
  },
  modeButtonDisabled: {
    opacity: 0.4,
  },
  modeLabel: {
    color: colors.ink,
  },
  modeLabelActive: {
    color: colors.paper,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: space.lg,
  },
  chip: {
    minHeight: 38,
    paddingHorizontal: space.md,
    justifyContent: 'center',
    borderRadius: layout.radius,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hair,
    marginRight: space.sm,
    marginBottom: space.sm,
    maxWidth: '100%',
  },
  chipSelected: {
    backgroundColor: colors.copper,
    borderColor: colors.copper,
  },
  chipLabel: {
    color: colors.ink,
  },
  chipLabelSelected: {
    color: colors.paper,
  },
  newCustomer: {
    marginTop: space.lg,
  },
  fieldRow: {
    flexDirection: 'row',
    gap: space.md,
  },
  fieldCell: {
    flex: 1,
    minWidth: 0,
  },
  pressed: {
    opacity: 0.65,
  },
  footerBar: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.hair,
    backgroundColor: colors.paper,
  },
  footer: {
    paddingHorizontal: layout.gutter,
    paddingTop: space.md,
  },
  footerError: {
    color: colors.copper,
    marginBottom: space.sm,
  },
});
