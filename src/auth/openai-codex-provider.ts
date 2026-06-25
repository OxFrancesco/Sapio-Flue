import { registerProvider } from '@flue/runtime';
import { OPENAI_CODEX_MODEL, OPENAI_CODEX_PROVIDER } from './codex-auth';

export interface CodexAuthBindingEnv {
	CODEX_AUTH_VAULT?: DurableObjectNamespace;
	CODEX_RELAY_BASE_URL?: string;
	CODEX_RELAY_TOKEN?: string;
	MODEL_SPECIFIER?: string;
}

interface TokenResponse {
	apiKey: string;
	expires: number;
}

interface CodexProviderRegistration {
	apiKey: string;
	baseUrl?: string;
	headers?: Record<string, string>;
}

export async function prepareOpenAICodexProvider(
	env: CodexAuthBindingEnv,
	modelOverride?: string,
): Promise<string> {
	const model = modelOverride ?? env.MODEL_SPECIFIER ?? OPENAI_CODEX_MODEL;
	if (!model.startsWith(`${OPENAI_CODEX_PROVIDER}/`)) {
		return model;
	}

	if (!env.CODEX_AUTH_VAULT) {
		throw new Error('CODEX_AUTH_VAULT Durable Object binding is required for openai-codex models.');
	}

	const response = await env.CODEX_AUTH_VAULT.getByName('default').fetch(
		new Request('https://codex-auth-vault/token', { method: 'POST' }),
	);
	if (!response.ok) {
		throw new Error(
			`Unable to prepare OpenAI Codex provider (${response.status}): ${await response.text()}`,
		);
	}

	const token = (await response.json()) as Partial<TokenResponse>;
	if (typeof token.apiKey !== 'string' || token.apiKey.length === 0) {
		throw new Error('Codex auth bridge did not return an API key.');
	}
	if (typeof token.expires !== 'number' || !Number.isFinite(token.expires)) {
		throw new Error('Codex auth bridge returned an invalid expiry timestamp.');
	}

	const registration: CodexProviderRegistration = {
		apiKey: token.apiKey,
	};
	const relayBaseUrl = normalizeOptionalUrl(env.CODEX_RELAY_BASE_URL);
	if (relayBaseUrl) {
		const relayToken = env.CODEX_RELAY_TOKEN?.trim();
		if (!relayToken) {
			throw new Error('CODEX_RELAY_TOKEN is required when CODEX_RELAY_BASE_URL is set.');
		}
		registration.baseUrl = relayBaseUrl;
		registration.headers = { 'x-codex-relay-token': relayToken };
	}

	registerProvider(OPENAI_CODEX_PROVIDER, registration);

	return model;
}

function normalizeOptionalUrl(value: string | undefined): string | undefined {
	const normalized = value?.trim().replace(/\/+$/, '');
	return normalized && normalized.length > 0 ? normalized : undefined;
}
