import {
  ApiError,
  type BootstrapResponse,
  type ChatResponse,
  type CodexLoginResponse,
  type CodexStatus,
  type ModelKey,
  type ModelOption,
  type NewSessionResponse,
  type PagesResponse,
  type SessionState,
  type Settings,
  type WorkspaceDetails,
} from './types';

const DEFAULT_TIMEOUT_MS = 30_000;
const CHAT_TIMEOUT_MS = 300_000;

export interface TeacherApi {
  health(): Promise<{ ok: boolean; convexConfigured: boolean; polarConfigured: boolean }>;
  bootstrap(): Promise<BootstrapResponse>;
  chat(message: string): Promise<ChatResponse>;
  setModel(modelKey: ModelKey): Promise<{ state: SessionState; models: ModelOption[] }>;
  newSession(modelKey?: ModelKey): Promise<NewSessionResponse>;
  workspace(): Promise<{ details: WorkspaceDetails }>;
  invite(): Promise<{ code: string; workspaceName: string }>;
  join(code: string): Promise<{ workspace: { name: string } }>;
  saveKey(apiKey: string, modelId?: string): Promise<{ workspaceName: string; modelId: string }>;
  billingCheckout(plan: 'pro' | 'team'): Promise<{ url: string; plan: string; workspaceName: string }>;
  codexStatus(): Promise<CodexStatus>;
  codexLogin(): Promise<CodexLoginResponse>;
  pages(reference?: string): Promise<PagesResponse>;
}

export function isConfigured(settings: Settings): boolean {
  return Boolean(settings.serverUrl.trim() && settings.token.trim() && settings.profile.id.trim());
}

export function createApi(settings: Settings): TeacherApi {
  const base = `${settings.serverUrl.trim().replace(/\/+$/, '')}/api/mobile`;
  const profile = settings.profile;

  async function call<T>(
    path: string,
    options: { method?: 'GET' | 'POST'; body?: Record<string, unknown>; timeoutMs?: number } = {},
  ): Promise<T> {
    const method = options.method ?? 'POST';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${settings.token.trim()}`,
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        ...(method === 'POST' ? { body: JSON.stringify({ profile, ...options.body }) } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      throw new ApiError(
        aborted ? 'Request timed out.' : `Network error: ${error instanceof Error ? error.message : String(error)}`,
        aborted ? 'timeout' : 'network',
        0,
      );
    } finally {
      clearTimeout(timer);
    }

    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new ApiError(
        typeof payload.error === 'string' ? payload.error : `Request failed (${response.status}).`,
        typeof payload.code === 'string' ? payload.code : 'request_failed',
        response.status,
      );
    }
    return payload as T;
  }

  return {
    health: () => call('/health', { method: 'GET' }),
    bootstrap: () => call('/context'),
    chat: (message) => call('/chat', { body: { message }, timeoutMs: CHAT_TIMEOUT_MS }),
    setModel: (modelKey) => call('/model', { body: { modelKey } }),
    newSession: (modelKey) => call('/session/new', { body: modelKey ? { modelKey } : {} }),
    workspace: () => call('/workspace'),
    invite: () => call('/invite'),
    join: (code) => call('/join', { body: { code } }),
    saveKey: (apiKey, modelId) =>
      call('/key', { body: { apiKey, ...(modelId ? { modelId } : {}) } }),
    billingCheckout: (plan) => call('/billing/checkout', { body: { plan } }),
    codexStatus: () => call('/codex/status', { method: 'GET' }),
    codexLogin: () => call('/codex/login'),
    pages: (reference) => call('/pages', { body: reference ? { reference } : {} }),
  };
}
