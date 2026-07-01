import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Markdown } from '@/components/markdown';
import { InlineNotice, NeoBadge, NeoButton, NeoCard, NeoInput, Screen } from '@/components/neo';
import { loadChatMessages, saveChatMessages, useApp } from '@/lib/store';
import { border, color, shadow, space, type } from '@/lib/theme';
import type { ChatMessage } from '@/lib/types';

const STARTERS = [
  'Teach me TypeScript generics in 10 minutes.',
  'Quiz me on the latest lesson page.',
  'Make a practice exercise with hints.',
  'Create a short lesson page about closures.',
];

function newMessage(role: ChatMessage['role'], text: string): ChatMessage {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    text,
    at: Date.now(),
  };
}

export default function ChatScreen() {
  const router = useRouter();
  const { configured, bootstrap, bootstrapLoading, bootstrapError, api, refreshBootstrap, applyBootstrap } =
    useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [startingSession, setStartingSession] = useState(false);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const agentId = bootstrap?.agentId;

  useEffect(() => {
    if (!agentId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    void loadChatMessages(agentId).then((loaded) => {
      if (!cancelled) setMessages(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  useEffect(() => {
    if (agentId) {
      void saveChatMessages(agentId, messages);
    }
  }, [agentId, messages]);

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || sending || !bootstrap) return;
      setDraft('');
      setSending(true);
      setMessages((current) => [...current, newMessage('user', message)]);
      try {
        const response = await api.chat(message);
        setMessages((current) => [
          ...current,
          newMessage('assistant', response.reply || '(empty reply)'),
        ]);
        applyBootstrap({ ...bootstrap, state: response.state, agentId: response.agentId });
      } catch (error) {
        setMessages((current) => [
          ...current,
          newMessage('error', error instanceof Error ? error.message : String(error)),
        ]);
      } finally {
        setSending(false);
      }
    },
    [api, applyBootstrap, bootstrap, sending],
  );

  const startNewSession = useCallback(() => {
    if (!bootstrap || startingSession) return;
    Alert.alert(
      'Start a new session?',
      'Old history stays stored but stops being used for new messages.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Start new session',
          style: 'destructive',
          onPress: () => {
            setStartingSession(true);
            api
              .newSession()
              .then((response) => {
                applyBootstrap({
                  ...bootstrap,
                  state: response.state,
                  agentId: response.agentId,
                  pagesIndexUrl: response.pagesIndexUrl,
                });
              })
              .catch((error: unknown) => {
                Alert.alert(
                  'Unable to start a new session',
                  error instanceof Error ? error.message : String(error),
                );
              })
              .finally(() => setStartingSession(false));
          },
        },
      ],
    );
  }, [api, applyBootstrap, bootstrap, startingSession]);

  if (!configured) {
    return (
      <Screen title="Teacher">
        <NeoCard accent>
          <Text style={type.subheading}>Not connected</Text>
          <Text style={type.body}>
            Set the server URL, API token, and your profile in Setup to start studying.
          </Text>
          <NeoButton label="Open setup" variant="accent" onPress={() => router.push('/settings')} />
        </NeoCard>
      </Screen>
    );
  }

  if (!bootstrap) {
    return (
      <Screen title="Teacher">
        <NeoCard>
          <Text style={type.subheading}>{bootstrapLoading ? 'Connecting...' : 'Offline'}</Text>
          {bootstrapError ? <InlineNotice text={bootstrapError} /> : null}
          <NeoButton
            label="Retry connection"
            loading={bootstrapLoading}
            onPress={() => void refreshBootstrap()}
          />
        </NeoCard>
      </Screen>
    );
  }

  return (
    <Screen
      title="Teacher"
      badge={bootstrap.state.modelLabel}
      scroll={false}
      footer={
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={0}
        >
          <View style={styles.composer}>
            <NeoInput
              value={draft}
              onChangeText={setDraft}
              placeholder="Ask the teacher..."
              multiline
              style={styles.composerInput}
              editable={!sending}
            />
            <NeoButton
              label="Send"
              variant="accent"
              loading={sending}
              disabled={!draft.trim()}
              onPress={() => void send(draft)}
              style={styles.sendButton}
            />
          </View>
        </KeyboardAvoidingView>
      }
    >
      <View style={styles.sessionStrip}>
        <NeoBadge label={`Session ${bootstrap.state.sessionId}`} />
        <Pressable
          accessibilityRole="button"
          onPress={startNewSession}
          style={({ pressed }) => [styles.newSession, pressed && styles.newSessionPressed]}
        >
          <Text style={styles.newSessionLabel}>{startingSession ? '...' : '+ New'}</Text>
        </Pressable>
      </View>
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.id}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={type.subheading}>Prompt starters</Text>
            {STARTERS.map((starter) => (
              <Pressable
                key={starter}
                accessibilityRole="button"
                onPress={() => void send(starter)}
                style={({ pressed }) => [styles.starter, pressed && styles.starterPressed]}
              >
                <Text style={type.body}>{starter}</Text>
              </Pressable>
            ))}
          </View>
        }
        ListFooterComponent={
          sending ? (
            <View style={styles.thinking}>
              <Text style={styles.thinkingLabel}>Thinking...</Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => {
          if (item.role === 'user') {
            return (
              <View style={styles.userBubble}>
                <Text style={styles.userText}>{item.text}</Text>
              </View>
            );
          }
          if (item.role === 'error') {
            return (
              <View style={styles.errorBubble}>
                <Text style={styles.errorTitle}>Error</Text>
                <Text style={type.body}>{item.text}</Text>
              </View>
            );
          }
          return (
            <View style={styles.assistantBubble}>
              <Markdown text={item.text} />
            </View>
          );
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  sessionStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.xs,
  },
  newSession: {
    borderWidth: border.width,
    borderColor: color.ink,
    backgroundColor: color.paper,
    paddingHorizontal: space.xs,
    paddingVertical: 4,
    ...shadow.hardSmall,
  },
  newSessionPressed: {
    backgroundColor: color.paperPressed,
    shadowOffset: { width: 0, height: 0 },
    transform: [{ translateX: 2 }, { translateY: 2 }],
  },
  newSessionLabel: {
    ...type.small,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  list: {
    flex: 1,
  },
  listContent: {
    gap: space.sm,
    paddingVertical: space.sm,
  },
  empty: {
    gap: space.xs,
    paddingTop: space.sm,
  },
  starter: {
    borderWidth: border.width,
    borderColor: color.ink,
    backgroundColor: color.paper,
    padding: space.xs,
    ...shadow.hardSmall,
  },
  starterPressed: {
    backgroundColor: color.paperPressed,
    shadowOffset: { width: 0, height: 0 },
    transform: [{ translateX: 2 }, { translateY: 2 }],
  },
  userBubble: {
    alignSelf: 'flex-end',
    maxWidth: '85%',
    backgroundColor: color.ink,
    borderWidth: border.width,
    borderColor: color.ink,
    padding: space.xs,
  },
  userText: {
    ...type.body,
    color: color.paper,
  },
  assistantBubble: {
    alignSelf: 'flex-start',
    maxWidth: '92%',
    backgroundColor: color.paper,
    borderWidth: border.width,
    borderColor: color.ink,
    padding: space.sm,
    ...shadow.hard,
  },
  errorBubble: {
    alignSelf: 'stretch',
    borderWidth: border.width,
    borderColor: color.accent,
    padding: space.xs,
    gap: 4,
  },
  errorTitle: {
    ...type.small,
    color: color.accent,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  thinking: {
    alignSelf: 'flex-start',
    borderWidth: border.width,
    borderColor: color.ink,
    backgroundColor: color.paperPressed,
    paddingHorizontal: space.xs,
    paddingVertical: 4,
  },
  thinkingLabel: {
    ...type.small,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  composer: {
    flexDirection: 'row',
    gap: space.xs,
    padding: space.sm,
    borderTopWidth: border.width,
    borderColor: color.ink,
    backgroundColor: color.paper,
    alignItems: 'flex-end',
  },
  composerInput: {
    flex: 1,
    maxHeight: 120,
  },
  sendButton: {
    minWidth: 88,
  },
});
