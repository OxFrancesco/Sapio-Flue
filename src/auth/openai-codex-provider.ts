import { registerProvider } from '@flue/runtime';
import { OPENAI_CODEX_MODEL, OPENAI_CODEX_PROVIDER } from './codex-auth';

export interface CodexAuthBindingEnv {
	CODEX_AUTH_VAULT?: DurableObjectNamespace;
	MODEL_SPECIFIER?: string;
}

interface TokenResponse {
	apiKey: string;
	expires: number;
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

	registerProvider(OPENAI_CODEX_PROVIDER, {
		apiKey: token.apiKey,
	});

	return model;
}
