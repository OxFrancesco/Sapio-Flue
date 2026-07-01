import * as WebBrowser from 'expo-web-browser';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import {
  InlineNotice,
  NeoButton,
  NeoCard,
  NeoInput,
  Screen,
  SectionTitle,
} from '@/components/neo';
import { useApp } from '@/lib/store';
import { border, color, shadow, space, type } from '@/lib/theme';
import type { PagesResponse } from '@/lib/types';

export default function PagesScreen() {
  const router = useRouter();
  const { configured, bootstrap, api } = useApp();
  const [pages, setPages] = useState<PagesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reference, setReference] = useState('');

  const agentId = bootstrap?.agentId;

  const loadPages = useCallback(
    async (ref?: string) => {
      if (!agentId) return;
      setLoading(true);
      try {
        const response = await api.pages(ref);
        setPages(response);
        setError(null);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setLoading(false);
      }
    },
    [agentId, api],
  );

  useEffect(() => {
    void loadPages();
  }, [loadPages]);

  if (!configured || !bootstrap) {
    return (
      <Screen title="Pages">
        <NeoCard accent>
          <Text style={type.subheading}>Not connected</Text>
          <Text style={type.body}>Connect the app in Setup first.</Text>
          <NeoButton label="Open setup" variant="accent" onPress={() => router.push('/settings')} />
        </NeoCard>
      </Screen>
    );
  }

  return (
    <Screen title="Pages" badge={`Session ${bootstrap.state.sessionId}`}>
      <SectionTitle label="Hosted lesson pages" />
      <NeoCard>
        <Text style={type.small}>
          Lessons published by the teacher are hosted on Cloudflare. Ask for a lesson first if the
          list is empty.
        </Text>
        <NeoButton
          label="Open page index"
          variant="accent"
          onPress={() => {
            if (pages?.indexUrl) void WebBrowser.openBrowserAsync(pages.indexUrl);
          }}
          disabled={!pages?.indexUrl}
        />
        <NeoButton label="Reload" variant="ghost" loading={loading} onPress={() => void loadPages(reference.trim() || undefined)} />
      </NeoCard>
      {error ? <InlineNotice text={error} /> : null}

      {pages?.referencedPageUrl ? (
        <NeoCard accent>
          <Text style={type.subheading}>Referenced page</Text>
          <Text style={type.mono} numberOfLines={2}>
            {pages.referencedPageUrl}
          </Text>
          <NeoButton
            label="Open referenced page"
            variant="accent"
            onPress={() => void WebBrowser.openBrowserAsync(pages.referencedPageUrl ?? '')}
          />
        </NeoCard>
      ) : null}

      {(pages?.pages ?? []).map((page) => (
        <Pressable
          key={page.path}
          accessibilityRole="button"
          onPress={() => void WebBrowser.openBrowserAsync(page.url)}
          style={({ pressed }) => [styles.pageRow, pressed && styles.pageRowPressed]}
        >
          <Text style={type.subheading} numberOfLines={1}>
            {page.title}
          </Text>
          <Text style={type.mono} numberOfLines={1}>
            {page.path}
          </Text>
          <Text style={type.small}>{page.updatedAt}</Text>
        </Pressable>
      ))}
      {pages && pages.pages.length === 0 ? (
        <NeoCard>
          <Text style={type.body}>No teaching pages have been published for this session yet.</Text>
        </NeoCard>
      ) : null}

      <SectionTitle label="Look up a reference" />
      <NeoCard>
        <Text style={type.small}>
          Paste a hosted /teach URL, a 32-character share id, or a same-workspace session id.
        </Text>
        <NeoInput
          value={reference}
          onChangeText={setReference}
          placeholder="https://... or share id"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <NeoButton
          label="Resolve reference"
          loading={loading}
          disabled={!reference.trim()}
          onPress={() => void loadPages(reference.trim())}
        />
        <NeoButton
          label="Back to current session"
          variant="ghost"
          onPress={() => {
            setReference('');
            void loadPages();
          }}
        />
      </NeoCard>
    </Screen>
  );
}

const styles = StyleSheet.create({
  pageRow: {
    borderWidth: border.width,
    borderColor: color.ink,
    backgroundColor: color.paper,
    padding: space.sm,
    gap: 4,
    ...shadow.hard,
  },
  pageRowPressed: {
    backgroundColor: color.paperPressed,
    shadowOffset: { width: 0, height: 0 },
    transform: [{ translateX: 2 }, { translateY: 2 }],
  },
});
