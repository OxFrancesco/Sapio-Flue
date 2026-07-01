import { useCallback, useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import {
  InlineNotice,
  NeoBadge,
  NeoButton,
  NeoCard,
  NeoInput,
  NeoRow,
  Screen,
  SectionTitle,
} from '@/components/neo';
import { useApp } from '@/lib/store';
import { space, type } from '@/lib/theme';

const HELP_LINES: Array<[string, string]> = [
  ['Chat tab', 'talk to the teacher, /new, /session, examples'],
  ['Model tab', '/model, /key openai, /codex login + status'],
  ['Space tab', '/workspace, /members, /invite, /join, /billing'],
  ['Pages tab', '/pages and page references'],
  ['Setup tab', '/whoami, /help, connection settings'],
];

export default function SettingsScreen() {
  const { settings, saveSettings, refreshBootstrap, bootstrap, bootstrapError, api, configured } =
    useApp();
  const [serverUrl, setServerUrl] = useState(settings.serverUrl);
  const [token, setToken] = useState(settings.token);
  const [userId, setUserId] = useState(settings.profile.id);
  const [firstName, setFirstName] = useState(settings.profile.firstName);
  const [username, setUsername] = useState(settings.profile.username ?? '');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    setServerUrl(settings.serverUrl);
    setToken(settings.token);
    setUserId(settings.profile.id);
    setFirstName(settings.profile.firstName);
    setUsername(settings.profile.username ?? '');
  }, [settings]);

  const save = useCallback(async () => {
    if (saving) return;
    if (!/^[0-9]{1,20}$/.test(userId.trim())) {
      Alert.alert('Invalid user id', 'Use your numeric Telegram user id (see /whoami in the bot).');
      return;
    }
    setSaving(true);
    try {
      await saveSettings({
        serverUrl: serverUrl.trim(),
        token: token.trim(),
        profile: {
          id: userId.trim(),
          firstName: firstName.trim() || 'Student',
          ...(username.trim() ? { username: username.trim().replace(/^@/, '') } : {}),
        },
      });
      await refreshBootstrap();
    } finally {
      setSaving(false);
    }
  }, [firstName, refreshBootstrap, saveSettings, saving, serverUrl, token, userId, username]);

  const testConnection = useCallback(async () => {
    if (testing) return;
    setTesting(true);
    try {
      const health = await api.health();
      Alert.alert(
        'Connected',
        `Server is up. Convex: ${health.convexConfigured ? 'on' : 'off'} - Polar: ${health.polarConfigured ? 'on' : 'off'}.`,
      );
    } catch (error) {
      Alert.alert('Connection failed', error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  }, [api, testing]);

  return (
    <Screen title="Setup" badge={configured ? 'Ready' : 'Needed'}>
      <SectionTitle label="Server" />
      <NeoCard>
        <Text style={type.small}>Worker base URL (local dev: http://127.0.0.1:3583).</Text>
        <NeoInput
          value={serverUrl}
          onChangeText={setServerUrl}
          placeholder="https://your-worker.workers.dev"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <Text style={type.small}>Mobile API token (MOBILE_API_TOKEN secret on the Worker).</Text>
        <NeoInput
          value={token}
          onChangeText={setToken}
          placeholder="Mobile API token"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
      </NeoCard>

      <SectionTitle label="Who am I" />
      <NeoCard>
        <Text style={type.small}>
          Use your numeric Telegram user id so the app signs into the same personal workspace as
          your Telegram chat (/whoami in the bot shows it).
        </Text>
        <NeoInput
          value={userId}
          onChangeText={setUserId}
          placeholder="Telegram user id (numbers only)"
          keyboardType="number-pad"
        />
        <NeoInput value={firstName} onChangeText={setFirstName} placeholder="First name" />
        <NeoInput
          value={username}
          onChangeText={setUsername}
          placeholder="Username (optional)"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <NeoButton label="Save + connect" variant="accent" loading={saving} onPress={() => void save()} />
        <NeoButton label="Test connection" variant="ghost" loading={testing} onPress={() => void testConnection()} />
      </NeoCard>
      {bootstrapError ? <InlineNotice text={bootstrapError} accent /> : null}

      {bootstrap ? (
        <>
          <SectionTitle label="Signed in" />
          <NeoCard>
            <NeoRow label="User" value={bootstrap.context?.user.displayName ?? 'anonymous'} />
            <NeoRow label="User id" value={settings.profile.id || '-'} />
            <NeoRow label="Workspace" value={bootstrap.context?.workspace.name ?? 'no workspace'} />
            <NeoRow label="Session" value={bootstrap.state.sessionId} />
            <NeoRow label="Model" value={bootstrap.state.modelLabel} />
            <View style={styles.badges}>
              <NeoBadge label={bootstrap.convexConfigured ? 'Convex on' : 'Convex off'} />
              <NeoBadge label={bootstrap.polarConfigured ? 'Polar on' : 'Polar off'} />
            </View>
          </NeoCard>
        </>
      ) : null}

      <SectionTitle label="Help" />
      <NeoCard>
        <Text style={type.small}>
          Everything the Telegram bot does, mapped to the app:
        </Text>
        {HELP_LINES.map(([where, what]) => (
          <NeoRow key={where} label={where} value={what} />
        ))}
      </NeoCard>
    </Screen>
  );
}

const styles = StyleSheet.create({
  badges: {
    flexDirection: 'row',
    gap: space.xs,
    marginTop: 4,
  },
});
