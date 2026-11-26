import Constants from 'expo-constants';
import { useCallback, useEffect, useState } from 'react';
import { Image, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { Screen } from '@/components/Screen';
import { LoadingState } from '@/components/StateViews';
import {
  api,
  errorMessage,
  testLlmConnection,
  type LlmProvider,
  type LlmSettings,
  type StudioPrompt,
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
  const [prompts, setPrompts] = useState<StudioPrompt[]>([]);
  const [promptsLoading, setPromptsLoading] = useState(true);
  const [promptBusyId, setPromptBusyId] = useState<string | null>(null);
  const [promptStatus, setPromptStatus] = useState<Status>(null);
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
    let active = true;
    api
      .getPrompts()
      .then((result) => {
        if (active) setPrompts(result.prompts);
      })
      .catch((error) => {
        if (active) setPromptStatus({ tone: 'bad', message: errorMessage(error, 'The prompts could not be loaded.') });
      })
      .finally(() => {
        if (active) setPromptsLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const saveStudioPrompt = async (prompt: StudioPrompt) => {
    setPromptBusyId(prompt.id);
    setPromptStatus(null);
    try {
      const result = await api.savePrompt(prompt.id, prompt.value);
      setPrompts((current) => current.map((item) => (item.id === result.prompt.id ? result.prompt : item)));
      setPromptStatus({ tone: 'good', message: `${result.prompt.label} saved. It applies from the next turn.` });
    } catch (error) {
      setPromptStatus({ tone: 'bad', message: errorMessage(error, 'The prompt could not be saved.') });
    } finally {
      setPromptBusyId(null);
    }
  };

  const resetStudioPrompt = async (prompt: StudioPrompt) => {
    setPromptBusyId(prompt.id);
    setPromptStatus(null);
    try {
      const result = await api.resetPrompt(prompt.id);
      setPrompts((current) => current.map((item) => (item.id === result.prompt.id ? result.prompt : item)));
      setPromptStatus({ tone: 'good', message: `${result.prompt.label} reset to the built in text.` });
    } catch (error) {
      setPromptStatus({ tone: 'bad', message: errorMessage(error, 'The prompt could not be reset.') });
    } finally {
      setPromptBusyId(null);
    }
  };

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

  const forgetKey = useCallback(async () => {
    if (!settings?.hasKey) return;
    setSaving(true);
    setStatus(null);
    try {
      const next = await api.saveLlmSettings({ apiKey: '' });
      setSettings(next);
      setStatus({ tone: 'good', message: 'The saved key was removed from this computer.' });
    } catch (error) {
      setStatus({ tone: 'bad', message: errorMessage(error, 'The key could not be removed.') });
    } finally {
      setSaving(false);
    }
  }, [settings]);

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
            <View style={styles.brandRow}>
              <Image
                source={require('@/assets/images/logo.png')}
                style={styles.brandMark}
                resizeMode="contain"
                accessibilityLabel="Jacob Design Studio"
              />
              <Text style={styles.brandName}>Jacob Studio</Text>
            </View>
            <Text style={styles.screenTitle}>Settings</Text>
            <Text style={styles.subtitle}>Model and app details. Everything runs on this computer.</Text>
          </View>


          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Language model</Text>
            <Text style={styles.sectionHint}>
              Any OpenAI compatible endpoint. The key is stored on this computer and never comes
              back to the app.
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
                    ? `Key saved (${settings.source === 'env' ? 'from the environment' : 'on this computer'}).`
                    : settings?.keyOptional
                      ? 'No key needed for this provider.'
                      : 'No key saved yet.'}
                  {providers.find((provider) => provider.id === providerId)?.keyUrl
                    ? ` Create one at ${providers.find((provider) => provider.id === providerId)?.keyUrl}`
                    : ''}
                </Text>

                <View style={styles.actions}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Save model settings"
                    disabled={saving}
                    onPress={() => void save()}
                    style={({ pressed }) => [
                      styles.primaryAction,
                      saving && styles.actionDisabled,
                      pressed && styles.actionPressed,
                    ]}>
                    <Text style={styles.primaryActionLabel}>{saving ? 'Saving' : 'Save'}</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Test connection"
                    disabled={testing}
                    onPress={() => void test()}
                    style={({ pressed }) => [
                      styles.secondaryAction,
                      testing && styles.actionDisabled,
                      pressed && styles.actionPressed,
                    ]}>
                    <Text style={styles.secondaryActionLabel}>
                      {testing ? 'Testing' : 'Test connection'}
                    </Text>
                  </Pressable>
                  {settings?.hasKey ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Forget saved key"
                      disabled={saving}
                      onPress={() => void forgetKey()}
                      style={({ pressed }) => [styles.quietAction, pressed && styles.actionPressed]}>
                      <Text style={styles.quietActionLabel}>Forget key</Text>
                    </Pressable>
                  ) : null}
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
            <Text style={styles.sectionTitle}>Studio prompts</Text>
            <Text style={styles.sectionHint}>
              These are the exact internal instructions used by the studio. Read them, edit them and
              save. Edits are stored on this computer and apply from the next turn. Reset restores
              the built in text.
            </Text>
            {promptsLoading ? <LoadingState label="Loading studio prompts." /> : null}
            {promptStatus ? (
              <Text
                style={[
                  text.value,
                  styles.status,
                  promptStatus.tone === 'good' ? styles.statusGood : styles.statusBad,
                ]}
                accessibilityLiveRegion="polite">
                {promptStatus.message}
              </Text>
            ) : null}
            {prompts.map((prompt) => (
              <View key={prompt.id} style={styles.promptCard}>
                <View style={styles.promptHead}>
                  <Text style={styles.promptLabel}>{prompt.label}</Text>
                  <Text style={styles.promptState}>{prompt.isDefault ? 'Built in' : 'Edited'}</Text>
                </View>
                <Text style={[text.caption, styles.promptDescription]}>{prompt.description}</Text>
                <TextInput
                  style={styles.promptInput}
                  value={prompt.value}
                  onChangeText={(value) =>
                    setPrompts((current) =>
                      current.map((item) => (item.id === prompt.id ? { ...item, value } : item))
                    )
                  }
                  multiline
                  textAlignVertical="top"
                  accessibilityLabel={`${prompt.label} prompt`}
                />
                <View style={styles.promptActions}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Save ${prompt.label} prompt`}
                    disabled={promptBusyId === prompt.id}
                    onPress={() => void saveStudioPrompt(prompt)}
                    style={({ pressed }) => [styles.promptSave, pressed && styles.promptPressed]}>
                    <Text style={styles.promptSaveLabel}>
                      {promptBusyId === prompt.id ? 'Saving' : 'Save prompt'}
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Reset ${prompt.label} prompt`}
                    disabled={prompt.isDefault || promptBusyId === prompt.id}
                    onPress={() => void resetStudioPrompt(prompt)}
                    style={({ pressed }) => [
                      styles.promptReset,
                      prompt.isDefault && styles.promptResetDisabled,
                      pressed && styles.promptPressed,
                    ]}>
                    <Text style={styles.promptResetLabel}>Reset</Text>
                  </Pressable>
                </View>
              </View>
            ))}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>This app</Text>
            <InfoRow label="Version" value={APP_VERSION} />
            <InfoRow label="Platform" value={PLATFORM_LABEL} />
            <InfoRow label="Runs on" value="This computer, entirely" />
            <InfoRow label="Data" value="Stays on this device" />
            <InfoRow label="Expo SDK" value={SDK_VERSION} />
          </View>


          <View style={styles.section}>
            <Text style={styles.sectionTitle}>About</Text>
            <Text style={[text.body, styles.aboutTitle]}>Jacob Design Studio, Nagercoil</Text>
            <Text style={[text.muted, styles.about]}>
              Jacob Design Studio builds custom wardrobes and furniture in Nagercoil, Tamil Nadu.
              Catalogue Studio is the internal tool for drafting orders and printing vouchers and
              material kits for the workshop.
            </Text>
            <Text style={[text.caption, styles.footer]}>Internal use · Jacob Design Studio</Text>
          </View>
        </View>
      </ScrollView>
    </Screen>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: layout.gutter,
  },
  header: {
    paddingTop: 14,
    paddingBottom: 4,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  brandText: {
    flexShrink: 1,
  },
  brandMark: {
    width: 24,
    height: 24,
    borderRadius: 6,
    flexShrink: 0,
  },
  brandName: {
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: -0.2,
    color: '#0D0D0D',
  },
  screenTitle: {
    marginTop: 14,
    fontSize: 32,
    fontWeight: '700',
    letterSpacing: -0.8,
    color: '#0D0D0D',
  },
  subtitle: {
    marginTop: 2,
    fontSize: 14,
    color: '#6E6E73',
  },
  section: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#ECECEC',
    padding: 20,
    marginTop: 12,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#0D0D0D',
    letterSpacing: -0.2,
  },
  sectionHint: {
    marginTop: 4,
    fontSize: 13.5,
    lineHeight: 20,
    color: '#6E6E73',
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
    backgroundColor: '#0D0D0D',
    borderColor: '#0D0D0D',
  },
  providerChipPressed: {
    opacity: 0.72,
  },
  providerChipText: {
    fontSize: 12.5,
    color: colors.muted,
  },
  providerChipTextActive: {
    color: '#FFFFFF',
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
    backgroundColor: '#0D0D0D',
    borderColor: '#0D0D0D',
  },
  modelChipText: {
    fontSize: 11.5,
    color: colors.muted,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    marginTop: 18,
  },
  primaryAction: {
    backgroundColor: '#0D0D0D',
    borderRadius: 999,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  primaryActionLabel: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  secondaryAction: {
    borderWidth: 1,
    borderColor: '#E0E0E0',
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  secondaryActionLabel: {
    color: '#0D0D0D',
    fontSize: 13,
    fontWeight: '600',
  },
  quietAction: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  quietActionLabel: {
    color: '#8E8E93',
    fontSize: 13,
    fontWeight: '500',
  },
  actionDisabled: {
    opacity: 0.5,
  },
  actionPressed: {
    opacity: 0.7,
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
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#F0F0F0',
  },
  infoLabel: {
    fontSize: 13.5,
    color: '#6E6E73',
  },
  infoValue: {
    fontSize: 13.5,
    fontWeight: '500',
    color: '#0D0D0D',
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
  promptCard: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: '#E5E5E5',
    borderRadius: 14,
    padding: 14,
    backgroundColor: '#FFFFFF',
    gap: 8,
  },
  promptHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  promptLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#0D0D0D',
  },
  promptState: {
    fontSize: 11,
    color: '#8E8E93',
  },
  promptDescription: {
    color: '#6E6E73',
  },
  promptInput: {
    minHeight: 160,
    maxHeight: 300,
    borderWidth: 1,
    borderColor: '#E5E5E5',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 12.5,
    lineHeight: 19,
    color: '#0D0D0D',
    backgroundColor: '#FAFAFA',
  },
  promptActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  promptSave: {
    backgroundColor: '#0D0D0D',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  promptSaveLabel: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
  },
  promptReset: {
    borderWidth: 1,
    borderColor: '#E5E5E5',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: '#FFFFFF',
  },
  promptResetDisabled: {
    opacity: 0.45,
  },
  promptResetLabel: {
    color: '#0D0D0D',
    fontSize: 12,
    fontWeight: '600',
  },
  promptPressed: {
    opacity: 0.75,
  },
});
