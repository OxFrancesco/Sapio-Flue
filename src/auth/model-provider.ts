import { registerProvider } from '@flue/runtime';
import {
	getWorkspaceModelConfig,
	type ConvexBindingEnv,
	type WorkspaceModelConfig,
} from '../convex-client';
import {
	readWorkspaceModelApiKey,
	type WorkspaceCredentialVaultBindingEnv,
} from '../model-credentials';
import {
	OPENAI_BYOK_DEFAULT_MODEL_ID,
	type TelegramAgentState,
} from '../models';
import {
	prepareOpenAICodexProvider,
	type CodexAuthBindingEnv,
} from './openai-codex-provider';

export interface TelegramModelProviderBindingEnv
	extends CodexAuthBindingEnv,
		ConvexBindingEnv,
		WorkspaceCredentialVaultBindingEnv {}

export async function prepareTelegramModelProvider(
	env: TelegramModelProviderBindingEnv,
	state: TelegramAgentState | undefined,
	modelOverride?: string,
): Promise<string> {
	if (state?.modelKey !== 'openai') {
		if (state?.workspaceId) {
			const config = await getWorkspaceModelConfig(env, state.workspaceId);
			if (config?.workspace.plan === 'free') {
				throw new Error('Platform models require an active workspace subscription or OpenAI BYOK.');
			}
		}
		return prepareOpenAICodexProvider(env, modelOverride);
	}

	const config = await requireOpenAIWorkspaceConfig(env, state.workspaceId);
	const credential = await readWorkspaceModelApiKey(env, config.openaiCredential.vaultKey);
	const providerId = await workspaceProviderId(config.workspace.id, 'openai');
	const modelId = config.openaiCredential.modelId || OPENAI_BYOK_DEFAULT_MODEL_ID;

	registerProvider(providerId, {
		api: 'openai-responses',
		baseUrl: 'https://api.openai.com/v1',
		apiKey: credential.apiKey,
		storeResponses: false,
	});

	return `${providerId}/${modelId}`;
}

async function requireOpenAIWorkspaceConfig(
	env: TelegramModelProviderBindingEnv,
	workspaceId: string | undefined,
): Promise<WorkspaceModelConfig & { openaiCredential: NonNullable<WorkspaceModelConfig['openaiCredential']> }> {
	if (!workspaceId) {
		throw new Error('OpenAI BYOK requires a signed-in Convex workspace.');
	}

	const config = await getWorkspaceModelConfig(env, workspaceId);
	if (!config?.openaiCredential) {
		throw new Error('OpenAI BYOK is not configured for this workspace. Use /key openai <api-key> [model].');
	}
	return config as WorkspaceModelConfig & {
		openaiCredential: NonNullable<WorkspaceModelConfig['openaiCredential']>;
	};
}

async function workspaceProviderId(workspaceId: string, provider: 'openai'): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(`${provider}:${workspaceId}`),
	);
	return `workspace-${provider}-${bytesToHex(new Uint8Array(digest).slice(0, 8))}`;
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
