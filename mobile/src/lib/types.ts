export type ModelKey = 'zai' | 'codex' | 'openai';

export interface Profile {
  id: string;
  firstName: string;
  lastName?: string;
  username?: string;
}

export interface Settings {
  serverUrl: string;
  token: string;
  profile: Profile;
}

export interface SessionState {
  sessionId: string;
  modelKey: ModelKey;
  modelLabel: string;
  workspaceId?: string;
}

export interface ModelOption {
  key: ModelKey;
  label: string;
  specifier: string;
  note?: string;
  requiresWorkspaceCredential?: 'openai';
  current: boolean;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  kind: 'personal' | 'telegram_chat' | 'study_group';
  plan: 'free' | 'pro' | 'team';
  billingMode: 'platform' | 'byok';
  defaultModelKey: ModelKey;
}

export interface AuthContext {
  user: {
    id: string;
    displayName: string;
    username?: string;
    status: 'active' | 'disabled';
    plan: 'free' | 'pro' | 'team';
  };
  workspace: WorkspaceSummary;
  membership: {
    id: string;
    role: 'owner' | 'admin' | 'member';
    status: 'active' | 'invited' | 'removed';
  };
}

export interface CodexStatus {
  configured: boolean;
  expiresAt?: string;
  updatedAt?: string;
}

export interface BootstrapResponse {
  convexConfigured: boolean;
  polarConfigured: boolean;
  context: AuthContext | null;
  state: SessionState;
  models: ModelOption[];
  agentId: string;
  pagesIndexUrl: string;
  codex: CodexStatus | null;
}

export interface ChatResponse {
  reply: string;
  model: { provider: string; id: string } | null;
  state: SessionState;
  agentId: string;
}

export interface WorkspaceDetails {
  workspace: WorkspaceSummary;
  membership: AuthContext['membership'];
  members: Array<{
    userId: string;
    displayName: string;
    username?: string;
    role: 'owner' | 'admin' | 'member';
    status: 'active' | 'invited' | 'removed';
  }>;
}

export interface PageEntry {
  path: string;
  title: string;
  updatedAt: string;
  url: string;
}

export interface PagesResponse {
  sessionId: string;
  shareId: string;
  indexUrl: string;
  referencedPageUrl: string | null;
  pages: PageEntry[];
}

export interface NewSessionResponse {
  state: SessionState;
  agentId: string;
  pagesIndexUrl: string;
}

export interface CodexLoginResponse {
  loginUrl: string;
  verificationUri: string;
  userCode: string;
  expiresAt: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'error';
  text: string;
  at: number;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}
