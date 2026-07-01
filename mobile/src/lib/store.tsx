import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { createApi, isConfigured, type TeacherApi } from './api';
import type { BootstrapResponse, ChatMessage, Settings } from './types';

const SETTINGS_KEY = '@sapio/settings';
const chatKey = (agentId: string) => `@sapio/chat/${agentId}`;

const emptySettings: Settings = {
  serverUrl: '',
  token: '',
  profile: { id: '', firstName: '' },
};

interface AppStore {
  hydrated: boolean;
  settings: Settings;
  configured: boolean;
  api: TeacherApi;
  saveSettings(next: Settings): Promise<void>;
  bootstrap: BootstrapResponse | null;
  bootstrapError: string | null;
  bootstrapLoading: boolean;
  refreshBootstrap(): Promise<BootstrapResponse | null>;
  applyBootstrap(next: BootstrapResponse | null): void;
}

const AppContext = createContext<AppStore | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  const [hydrated, setHydrated] = useState(false);
  const [settings, setSettings] = useState<Settings>(emptySettings);
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [bootstrapLoading, setBootstrapLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(SETTINGS_KEY)
      .then((raw) => {
        if (cancelled) return;
        if (raw) {
          const parsed = JSON.parse(raw) as Settings;
          setSettings({ ...emptySettings, ...parsed, profile: { ...emptySettings.profile, ...parsed.profile } });
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const api = useMemo(() => createApi(settings), [settings]);
  const configured = isConfigured(settings);

  const saveSettings = useCallback(async (next: Settings) => {
    setSettings(next);
    setBootstrap(null);
    setBootstrapError(null);
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  }, []);

  const refreshBootstrap = useCallback(async (): Promise<BootstrapResponse | null> => {
    if (!isConfigured(settings)) {
      setBootstrap(null);
      setBootstrapError(null);
      return null;
    }
    setBootstrapLoading(true);
    try {
      const next = await api.bootstrap();
      setBootstrap(next);
      setBootstrapError(null);
      return next;
    } catch (error) {
      setBootstrapError(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setBootstrapLoading(false);
    }
  }, [api, settings]);

  useEffect(() => {
    if (hydrated && configured) {
      void refreshBootstrap();
    }
  }, [hydrated, configured, refreshBootstrap]);

  const value = useMemo<AppStore>(
    () => ({
      hydrated,
      settings,
      configured,
      api,
      saveSettings,
      bootstrap,
      bootstrapError,
      bootstrapLoading,
      refreshBootstrap,
      applyBootstrap: setBootstrap,
    }),
    [hydrated, settings, configured, api, saveSettings, bootstrap, bootstrapError, bootstrapLoading, refreshBootstrap],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppStore {
  const store = useContext(AppContext);
  if (!store) {
    throw new Error('useApp must be used within AppProvider.');
  }
  return store;
}

export async function loadChatMessages(agentId: string): Promise<ChatMessage[]> {
  try {
    const raw = await AsyncStorage.getItem(chatKey(agentId));
    return raw ? (JSON.parse(raw) as ChatMessage[]) : [];
  } catch {
    return [];
  }
}

export async function saveChatMessages(agentId: string, messages: ChatMessage[]): Promise<void> {
  try {
    await AsyncStorage.setItem(chatKey(agentId), JSON.stringify(messages.slice(-200)));
  } catch {
    // Persistence is best-effort; the durable session lives on the server.
  }
}
