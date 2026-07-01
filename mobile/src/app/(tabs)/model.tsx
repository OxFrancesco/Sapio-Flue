import * as WebBrowser from 'expo-web-browser';
import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  InlineNotice,
  NeoBadge,
  NeoButton,
  NeoCard,
  NeoInput,
  Screen,
  SectionTitle,
} from '@/components/neo';
import { useApp } from '@/lib/store';
import { border, color, shadow, space, type } from '@/lib/theme';
import type { ModelKey } from '@/lib/types';

export default function ModelScreen() {
  const router = useRouter();
  const { configured, bootstrap, api, applyBootstrap, refreshBootstrap } = useApp();
  const [switching, setSwitching] = useState<ModelKey | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [modelId, setModelId] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [codexBusy, setCodexBusy] = useState(false);

  const switchModel = useCallback(
    async (modelKey: ModelKey) => {
      if (!bootstrap || switching) return;
      setSwitching(modelKey);
      try {
        const response = await api.setModel(modelKey);
        applyBootstrap({ ...bootstrap, state: response.state, models: response.models });
        await refreshBootstrap();
      } catch (error) {
        Alert.alert('Unable to switch model', error instanceof Error ? error.message : String(error));
      } finally {
        setSwitching(null);
      }
    },
    [api, applyBootstrap, bootstrap, refreshBootstrap, switching],
  );

  const saveKey = useCallback(async () => {
    if (!apiKey.trim() || savingKey) return;
    setSavingKey(true);
    try {
      const response = await api.saveKey(apiKey.trim(), modelId.trim() || undefined);
      setApiKey('');
      setModelId('');
      await refreshBootstrap();
      Alert.alert(
        'OpenAI key connected',
        `Workspace ${response.workspaceName} now uses OpenAI BYOK with ${response.modelId}.`,
      );
    } catch (error) {
      Alert.alert('Unable to save model key', error instanceof Error ? error.message : String(error));
    } finally {
      setSavingKey(false);
    }
  }, [api, apiKey, modelId, refreshBootstrap, savingKey]);

  const openCodexLogin = useCallback(async () => {
    if (codexBusy) return;
    setCodexBusy(true);
    try {
      const login = await api.codexLogin();
      await WebBrowser.openBrowserAsync(login.loginUrl);
      await refreshBootstrap();
    } catch (error) {
      Alert.alert('Codex login failed', error instanceof Error ? error.message : String(error));
    } finally {
      setCodexBusy(false);
    }
  }, [api, codexBusy, refreshBootstrap]);

  if (!configured || !bootstrap) {
    return (
      <Screen title="Model">
        <NeoCard accent>
          <Text style={type.subheading}>Not connected</Text>
          <Text style={type.body}>Connect the app in Setup first.</Text>
          <NeoButton label="Open setup" variant="accent" onPress={() => router.push('/settings')} />
        </NeoCard>
      </Screen>
    );
  }

  const plan = bootstrap.context?.workspace.plan;

  return (
    <Screen title="Model" badge={bootstrap.state.modelLabel}>
      <SectionTitle label="Pick a model" />
      {plan === 'free' ? (
        <InlineNotice text="Platform-hosted models need a subscription (Space tab). OpenAI BYOK works after key setup below." />
      ) : null}
      {bootstrap.models.map((model) => (
        <Pressable
          key={model.key}
          accessibilityRole="button"
          disabled={switching !== null}
          onPress={() => void switchModel(model.key)}
          style={({ pressed }) => [
            styles.modelCard,
            model.current && styles.modelCardCurrent,
            pressed && styles.modelCardPressed,
          ]}
        >
          <View style={styles.modelHeader}>
            <Text style={[type.subheading, model.current && styles.currentText]}>{model.label}</Text>
            {model.current ? (
              <NeoBadge label="Current" accent />
            ) : switching === model.key ? (
              <NeoBadge label="..." />
            ) : null}
          </View>
          <Text style={[type.mono, model.current && styles.currentText]}>{model.specifier}</Text>
          {model.note ? (
            <Text style={[type.small, model.current && styles.currentText]}>{model.note}</Text>
          ) : null}
        </Pressable>
      ))}

      <SectionTitle label="OpenAI BYOK key" />
      <NeoCard>
        <Text style={type.small}>
          The key is stored in the workspace credential vault. Only metadata stays in Convex.
        </Text>
        <NeoInput
          value={apiKey}
          onChangeText={setApiKey}
          placeholder="OpenAI API key"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
        <NeoInput
          value={modelId}
          onChangeText={setModelId}
          placeholder="Model id (default gpt-5.5)"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <NeoButton
          label="Save key + switch to BYOK"
          variant="accent"
          loading={savingKey}
          disabled={!apiKey.trim()}
          onPress={() => void saveKey()}
        />
      </NeoCard>

      <SectionTitle label="Codex login" />
      <NeoCard>
        <Text style={type.body}>
          {bootstrap.codex
            ? bootstrap.codex.configured
              ? `Connected. Token expires: ${bootstrap.codex.expiresAt ?? 'unknown'}.`
              : 'Not connected yet.'
            : 'Status unavailable.'}
        </Text>
        <NeoButton label="Open Codex login" loading={codexBusy} onPress={() => void openCodexLogin()} />
        <NeoButton label="Refresh status" variant="ghost" onPress={() => void refreshBootstrap()} />
      </NeoCard>
    </Screen>
  );
}

const styles = StyleSheet.create({
  modelCard: {
    borderWidth: border.width,
    borderColor: color.ink,
    backgroundColor: color.paper,
    padding: space.sm,
    gap: space.xs,
    ...shadow.hard,
  },
  modelCardCurrent: {
    backgroundColor: color.ink,
  },
  modelCardPressed: {
    shadowOffset: { width: 0, height: 0 },
    transform: [{ translateX: 2 }, { translateY: 2 }],
  },
  modelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.xs,
  },
  currentText: {
    color: color.paper,
  },
});
