import { OPENAI_CODEX_MODEL } from './auth/codex-auth';

export const ZAI_GLM_5_2_MODEL = 'zai/glm-5.2';
export const OPENAI_BYOK_DEFAULT_MODEL_ID = 'gpt-5.5';

export const TELEGRAM_AGENT_SUFFIX_MARKER = '|sapio|';
export const TELEGRAM_WORKSPACE_AGENT_BASE_PREFIX = 'telegram:v1:workspace:';
export const DEFAULT_TELEGRAM_SESSION_ID = 'main';
export const DEFAULT_TELEGRAM_MODEL_KEY = 'zai';

export type TelegramModelKey = 'zai' | 'codex' | 'openai';

export interface TelegramModelOption {
	key: TelegramModelKey;
	label: string;
	specifier: string;
	aliases: readonly string[];
	note?: string;
	requiresWorkspaceCredential?: 'openai';
}

export interface TelegramAgentState {
	sessionId: string;
	modelKey: TelegramModelKey;
	workspaceId?: string;
}

export const TELEGRAM_MODEL_OPTIONS: Record<TelegramModelKey, TelegramModelOption> = {
	zai: {
		key: 'zai',
		label: 'ZAI GLM-5.2 Max',
		specifier: ZAI_GLM_5_2_MODEL,
		aliases: ['zai', 'glm', 'glm5', 'glm-5', 'glm5.2', 'glm-5.2', 'max'],
	},
	codex: {
		key: 'codex',
		label: 'Codex GPT-5.5',
		specifier: OPENAI_CODEX_MODEL,
		aliases: ['codex', 'gpt', 'gpt5.5', 'gpt-5.5'],
		note: 'Use /codex to connect a ChatGPT Plus/Pro account when credentials need refreshing.',
	},
	openai: {
		key: 'openai',
		label: 'OpenAI BYOK',
		specifier: `openai/${OPENAI_BYOK_DEFAULT_MODEL_ID}`,
		aliases: ['byok', 'key', 'apikey', 'api-key', 'openai-key'],
		note: 'Use /key openai <api-key> [model] to attach a workspace-owned OpenAI key.',
		requiresWorkspaceCredential: 'openai',
	},
};

export function defaultTelegramAgentState(): TelegramAgentState {
	return {
		sessionId: DEFAULT_TELEGRAM_SESSION_ID,
		modelKey: DEFAULT_TELEGRAM_MODEL_KEY,
	};
}

export function isTelegramModelKey(value: string): value is TelegramModelKey {
	return value === 'zai' || value === 'codex' || value === 'openai';
}

export function telegramModelFromAlias(value: string): TelegramModelOption | undefined {
	const normalized = normalizeAlias(value);
	for (const option of Object.values(TELEGRAM_MODEL_OPTIONS)) {
		if (option.aliases.includes(normalized)) {
			return option;
		}
	}
	return undefined;
}

export function modelSpecifierForTelegramKey(key: TelegramModelKey): string {
	return TELEGRAM_MODEL_OPTIONS[key].specifier;
}

export function buildTelegramAgentId(
	baseConversationId: string,
	state: TelegramAgentState,
): string {
	const agentBaseId = state.workspaceId
		? telegramWorkspaceAgentBaseId(state.workspaceId)
		: baseConversationId;
	const params = new URLSearchParams({
		s: state.sessionId,
		m: state.modelKey,
	});
	if (state.workspaceId) {
		params.set('w', state.workspaceId);
	}
	return `${agentBaseId}${TELEGRAM_AGENT_SUFFIX_MARKER}${params.toString()}`;
}

export function telegramWorkspaceAgentBaseId(workspaceId: string): string {
	return `${TELEGRAM_WORKSPACE_AGENT_BASE_PREFIX}${encodeURIComponent(workspaceId)}`;
}

export function parseTelegramAgentId(id: string): {
	baseConversationId: string;
	state?: TelegramAgentState;
} {
	const markerIndex = id.indexOf(TELEGRAM_AGENT_SUFFIX_MARKER);
	if (markerIndex < 0) {
		return { baseConversationId: id };
	}

	const baseConversationId = id.slice(0, markerIndex);
	const params = new URLSearchParams(id.slice(markerIndex + TELEGRAM_AGENT_SUFFIX_MARKER.length));
	const sessionId = params.get('s');
	const modelKey = params.get('m');
	const workspaceId = params.get('w') ?? undefined;
	if (!sessionId || !modelKey || !isTelegramModelKey(modelKey)) {
		return { baseConversationId };
	}

	return {
		baseConversationId,
		state: { sessionId, modelKey, ...(workspaceId ? { workspaceId } : {}) },
	};
}

export function describeTelegramModels(): string {
	return Object.values(TELEGRAM_MODEL_OPTIONS)
		.map((option) => `${option.key}: ${option.label}`)
		.join('\n');
}

function normalizeAlias(value: string): string {
	return value.trim().toLowerCase().replaceAll('_', '-');
}
