import Constants from 'expo-constants';
import { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { Screen } from '@/components/Screen';
import { LoadingState } from '@/components/StateViews';
import {
  API_BASE_URL,
  api,
  errorMessage,
  testLlmConnection,
  type LlmProvider,
  type LlmSettings,
} from '@/lib/api';
import { colors, layout, shared, space, text } from '@/lib/theme';
import { TamilLine } from '@/components/TamilLine';

const APP_VERSION = Constants.expoConfig?.version ?? '1.0.0';
const SDK_VERSION = Constants.expoConfig?.sdkVersion ?? '58';
const PLATFORM_LABEL =
  Platform.select({ ios: 'iOS', android: 'Android', web: 'Web', default: 'Native' }) ?? 'Native';

type Status = { tone: 'good' | 'bad'; message: string } | null;

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();

  const [settings, setSettings] = useState<LlmSettings | null>(null);
  const [providers, setProviders] = useState<LlmProvider[]>([]);
  const [providerId, setProviderId] = useState('custom');
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  const load = useCallback(async () => {
    try {
      const [next, catalog] = await Promise.all([
        api.getLlmSettings(),
        api.listProviders(),
      ]);
      setSettings(next);
      setProviderId(next.provider);
      setEndpoint(next.endpoint);
      setModel(next.model);
      setProviders(catalog.providers);
      setSettingsError(null);
    } catch (error) {
      setSettingsError(errorMessage(error, 'The model settings could not be loaded.'));
    } finally {
      setSettingsLoading(false);
    }
  }, []);

  useEffect(() => {
    // First load on mount. The section starts in its loading state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const save = useCallback(async () => {
    setSaving(true);
    setStatus(null);
    try {
      const next = await api.saveLlmSettings({
        provider: providerId,
        endpoint: endpoint.trim(),
        model: model.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setSettings(next);
      setProviderId(next.provider);
      setApiKey('');
      setStatus({ tone: 'good', message: 'Settings saved on the server.' });
    } catch (error) {
      setStatus({ tone: 'bad', message: errorMessage(error, 'The settings could not be saved.') });
    } finally {
      setSaving(false);
    }
  }, [apiKey, endpoint, model, providerId]);

  const chooseProvider = useCallback(
    (provider: LlmProvider) => {
      setProviderId(provider.id);
      setStatus(null);
      if (provider.id !== 'custom') {
        setEndpoint(provider.endpoint);
        setModel(provider.models[0] ?? '');
      }
    },
    []
  );

  const test = useCallback(async () => {
    setTesting(true);
    setStatus(null);
    try {
      const result = await testLlmConnection();
      if (result.ok) {
        const sample = result.sample ? ` Replied "${result.sample}".` : '';
        setStatus({
          tone: 'good',
          message: `Connected to ${result.model ?? model} in ${result.latencyMs ?? 0} ms.${sample}`,
        });
      } else {
        setStatus({
          tone: 'bad',
          message: result.error?.message ?? 'The endpoint did not answer correctly.',
        });
      }
    } finally {
      setTesting(false);
    }
  }, [model]);

  return (
    <Screen>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, { paddingBottom: space.xxxl + insets.bottom }]}>
        <View style={shared.frame}>
          <View style={styles.header}>
            <Text style={text.eyebrow}>Grace Wood</Text>
            <TamilLine />
            <Text style={[text.screenTitle, styles.title]}>Settings</Text>
            <Text style={[text.muted, styles.subtitle]}>Connection, model and app details.</Text>
          </View>


          <View style={styles.section}>
            <Text style={text.sectionLabel}>Connection</Text>
            <Text style={[text.caption, styles.label]}>API base URL</Text>
            <Text style={styles.url} selectable>
              {API_BASE_URL}
            </Text>
            <Text style={[text.caption, styles.hint]}>
              Set EXPO_PUBLIC_API_URL before building to point the app at another server.
            </Text>
          </View>


          <View style={styles.section}>
            <Text style={text.sectionLabel}>Language model</Text>
            <Text style={[text.muted, styles.hint]}>
              Any OpenAI compatible endpoint. The key is stored on the server and never comes back
              to the app.
            </Text>

            {settingsLoading ? <LoadingState label="Loading model settings." /> : null}
            {settingsError ? (
              <Text style={[text.muted, styles.statusBad]}>{settingsError}</Text>
            ) : null}

            {!settingsLoading ? (
              <View style={styles.form}>
                <Text style={[text.caption, styles.label]}>Provider</Text>
                <View style={styles.providerWrap}>
                  {providers.map((provider) => {
                    const active = provider.id === providerId;
                    return (
                      <Pressable
                        key={provider.id}
                        accessibilityRole="button"
                        accessibilityLabel={`Provider ${provider.label}`}
                        accessibilityState={{ selected: active }}
                        onPress={() => chooseProvider(provider)}
                        style={({ pressed }) => [
                          styles.providerChip,
                          active && styles.providerChipActive,
                          pressed && styles.providerChipPressed,
                        ]}>
                        <Text
                          style={[styles.providerChipText, active && styles.providerChipTextActive]}>
                          {provider.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                <Text style={[text.caption, styles.hint]}>
                  {providers.find((provider) => provider.id === providerId)?.note ??
                    'Pick a provider, or paste any OpenAI compatible endpoint below.'}
                </Text>
                <Field
                  label={providerId === 'custom' ? 'Endpoint' : 'Endpoint, editable'}
                  value={endpoint}
                  onChangeText={setEndpoint}
                  placeholder="https://provider.example.com/v1"
                  autoCapitalize="none"
                  maxLength={300}
                />
                <Field
                  label="Model"
                  value={model}
                  onChangeText={setModel}
                  placeholder="deepseek-v4.1-flash"
                  autoCapitalize="none"
                  maxLength={120}
                />
                {providers.find((provider) => provider.id === providerId)?.models.length ? (
                  <View style={styles.modelWrap}>
                    <Text style={[text.caption, styles.hint]}>Suggested models</Text>
                    <View style={styles.providerWrap}>
                      {providers
                        .find((provider) => provider.id === providerId)!
                        .models.slice(0, 6)
                        .map((suggestion) => (
                          <Pressable
                            key={suggestion}
                            accessibilityRole="button"
                            accessibilityLabel={`Use model ${suggestion}`}
                            onPress={() => setModel(suggestion)}
                            style={({ pressed }) => [
                              styles.modelChip,
                              model === suggestion && styles.modelChipActive,
                              pressed && styles.providerChipPressed,
                            ]}>
                            <Text
                              style={[
                                styles.modelChipText,
                                model === suggestion && styles.providerChipTextActive,
                              ]}>
                              {suggestion}
                            </Text>
                          </Pressable>
                        ))}
                    </View>
                  </View>
                ) : null}
                <Field
                  label="API key"
                  value={apiKey}
                  onChangeText={setApiKey}
                  placeholder={settings?.hasKey ? 'Saved. Type to replace.' : 'Paste the key'}
                  autoCapitalize="none"
                  secure
                  maxLength={400}
                />
                <Text style={[text.caption, styles.hint]}>
                  {settings?.hasKey
                    ? `A key is already saved (${settings.source === 'env' ? 'from the server environment' : 'set in the studio'}).`
                    : settings?.keyOptional
                      ? 'No key needed for this provider.'
                      : 'No key saved yet.'}
                  {providers.find((provider) => provider.id === providerId)?.keyUrl
                    ? ` Create a key at ${providers.find((provider) => provider.id === providerId)?.keyUrl}`
                    : ''}
                </Text>

                <View style={styles.actions}>
                  <Button label="Save" onPress={() => void save()} loading={saving} />
                  <Button
                    label="Test connection"
                    variant="secondary"
                    onPress={() => void test()}
                    loading={testing}
                  />
                </View>

                {status ? (
                  <Text
                    style={[
                      text.value,
                      styles.status,
                      status.tone === 'good' ? styles.statusGood : styles.statusBad,
                    ]}
                    accessibilityLiveRegion="polite">
                    {status.message}
                  </Text>
                ) : null}
              </View>
            ) : null}
          </View>


          <View style={styles.section}>
            <Text style={text.sectionLabel}>App</Text>
            <InfoRow label="Version" value={APP_VERSION} />
            <InfoRow label="Platform" value={PLATFORM_LABEL} />
            <InfoRow label="Expo SDK" value={SDK_VERSION} />
          </View>


          <View style={styles.section}>
            <Text style={text.sectionLabel}>About</Text>
            <Text style={[text.body, styles.aboutTitle]}>Grace Wood Industry, Nagercoil</Text>
            <Text style={[text.muted, styles.about]}>
              Grace Wood Industry builds custom wardrobes and furniture in Nagercoil, Tamil Nadu.
              Catalogue Studio is the internal tool for drafting orders and printing vouchers and
              material kits for the workshop.
            </Text>
            <Text style={[text.caption, styles.footer]}>Internal use · Grace Wood Industry</Text>
          </View>
        </View>
      </ScrollView>
    </Screen>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={text.muted}>{label}</Text>
      <Text style={[text.value, styles.infoValue]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: layout.gutter,
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
  section: {
    backgroundColor: colors.surface,
    borderRadius: layout.radius,
    padding: space.lg,
    marginTop: space.md,
  },
  label: {
    marginTop: space.lg,
  },
  url: {
    marginTop: space.xs,
    fontSize: 15,
    lineHeight: 22,
    color: colors.ink,
  },
  hint: {
    marginTop: space.sm,
    maxWidth: 520,
  },
  form: {
    marginTop: space.lg,
    gap: space.lg,
    maxWidth: 560,
  },
  providerWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  providerChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.hair,
    backgroundColor: colors.surface,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  providerChipActive: {
    borderColor: colors.copper,
    backgroundColor: colors.copperSoft,
  },
  providerChipPressed: {
    opacity: 0.72,
  },
  providerChipText: {
    fontSize: 12.5,
    color: colors.muted,
  },
  providerChipTextActive: {
    color: colors.copper,
    fontWeight: '600',
  },
  modelWrap: {
    gap: 4,
  },
  modelChip: {
    borderRadius: 8,
    backgroundColor: colors.fill,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  modelChipActive: {
    backgroundColor: colors.copperSoft,
  },
  modelChipText: {
    fontSize: 11.5,
    color: colors.muted,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.md,
  },
  status: {
    maxWidth: 520,
  },
  statusGood: {
    color: '#2F6B45',
  },
  statusBad: {
    color: '#8C2F24',
    marginTop: space.sm,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.hairInset,
  },
  infoValue: {
    textAlign: 'right',
  },
  aboutTitle: {
    marginTop: space.lg,
  },
  about: {
    marginTop: space.sm,
    maxWidth: 520,
  },
  footer: {
    marginTop: space.xl,
  },
});
