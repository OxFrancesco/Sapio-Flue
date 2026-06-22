import type { OAuthCredentials } from '@earendil-works/pi-ai/oauth';

export const OPENAI_CODEX_PROVIDER = 'openai-codex';
export const OPENAI_CODEX_MODEL = 'openai-codex/gpt-5.5';
export const DEFAULT_WORKOS_VAULT_OBJECT_NAME = 'sapio-flue-openai-codex-auth';

export const DEFAULT_WORKOS_VAULT_CONTEXT = {
	app: 'sapio-flue',
	provider: OPENAI_CODEX_PROVIDER,
};

export interface CodexAuthDocument {
	type: 'pi-openai-codex-auth';
	provider: typeof OPENAI_CODEX_PROVIDER;
	credentials: OAuthCredentials;
	updatedAt: string;
}

export function createCodexAuthDocument(input: unknown): CodexAuthDocument {
	return {
		type: 'pi-openai-codex-auth',
		provider: OPENAI_CODEX_PROVIDER,
		credentials: extractOpenAICodexCredentials(input),
		updatedAt: new Date().toISOString(),
	};
}

export function parseCodexAuthDocument(value: unknown): CodexAuthDocument {
	const parsed = typeof value === 'string' ? parseJson(value) : value;
	if (!isRecord(parsed)) {
		throw new Error('Stored Codex auth document is not an object.');
	}
	if (parsed.type !== 'pi-openai-codex-auth') {
		throw new Error('Stored Codex auth document has an unsupported type.');
	}
	if (parsed.provider !== OPENAI_CODEX_PROVIDER) {
		throw new Error('Stored Codex auth document is for a different provider.');
	}
	if (typeof parsed.updatedAt !== 'string') {
		throw new Error('Stored Codex auth document is missing updatedAt.');
	}

	return {
		type: parsed.type,
		provider: parsed.provider,
		credentials: extractOpenAICodexCredentials(parsed.credentials),
		updatedAt: parsed.updatedAt,
	};
}

export function extractOpenAICodexCredentials(input: unknown): OAuthCredentials {
	const parsed = typeof input === 'string' ? parseJson(input) : input;
	const source =
		isRecord(parsed) && isRecord(parsed[OPENAI_CODEX_PROVIDER])
			? parsed[OPENAI_CODEX_PROVIDER]
			: parsed;

	if (!isRecord(source)) {
		throw new Error('OpenAI Codex credentials must be an object.');
	}
	if (typeof source.access !== 'string' || source.access.length === 0) {
		throw new Error('OpenAI Codex credentials are missing access.');
	}
	if (typeof source.refresh !== 'string' || source.refresh.length === 0) {
		throw new Error('OpenAI Codex credentials are missing refresh.');
	}
	if (typeof source.expires !== 'number' || !Number.isFinite(source.expires)) {
		throw new Error('OpenAI Codex credentials are missing a numeric expires timestamp.');
	}

	return {
		...source,
		access: source.access,
		refresh: source.refresh,
		expires: source.expires,
	};
}

export function credentialsEqual(left: OAuthCredentials, right: OAuthCredentials): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function parseJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		throw new Error('Expected valid JSON.');
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
