import { Effect } from 'effect';
import { ConfigMissing, ExternalHttpError } from './effect/errors';
import { requireOkResponse, responseJson } from './effect/http';
import { retryIdempotent, runEffect } from './effect/runtime';
import {
	ReadCredentialResponseSchema,
	StoredCredentialResponseSchema,
} from './effect/schemas';

export interface WorkspaceCredentialVaultBindingEnv {
	WORKSPACE_CREDENTIAL_VAULT?: DurableObjectNamespace;
}

export type WorkspaceModelProvider = 'openai';

interface StoredCredentialResponse {
	configured: true;
	provider: WorkspaceModelProvider;
	vaultKey: string;
	updatedAt: string;
	storage: 'durable-object' | 'workos-vault';
}

interface ReadCredentialResponse {
	provider: WorkspaceModelProvider;
	apiKey: string;
	updatedAt: string;
}

export async function storeWorkspaceModelApiKey(
	env: WorkspaceCredentialVaultBindingEnv,
	args: {
		workspaceId: string;
		provider: WorkspaceModelProvider;
		apiKey: string;
	},
): Promise<StoredCredentialResponse> {
	const vaultKey = await workspaceModelVaultKey(args.workspaceId, args.provider);
	const vault = credentialVault(env);
	return runEffect(
		Effect.gen(function* () {
			const response = yield* Effect.tryPromise({
				try: () =>
					vault.fetch(
						new Request('https://workspace-credential-vault/credential', {
							method: 'PUT',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({
								vaultKey,
								provider: args.provider,
								apiKey: args.apiKey,
							}),
						}),
					),
				catch: (cause) =>
					new ExternalHttpError({
						operation: 'credential_vault.store',
						status: 0,
						message: 'Unable to store model credential before receiving a response.',
						cause,
					}),
			});
			yield* requireOkResponse(response, 'credential_vault.store', 'Unable to store model credential');
			return yield* responseJson(response, StoredCredentialResponseSchema, 'stored model credential');
		}),
	);
}

export async function readWorkspaceModelApiKey(
	env: WorkspaceCredentialVaultBindingEnv,
	vaultKey: string,
): Promise<ReadCredentialResponse> {
	const vault = credentialVault(env);
	return runEffect(
		retryIdempotent(
			Effect.gen(function* () {
				const response = yield* Effect.tryPromise({
					try: () =>
						vault.fetch(
							new Request(`https://workspace-credential-vault/credential?vaultKey=${encodeURIComponent(vaultKey)}`),
						),
					catch: (cause) =>
						new ExternalHttpError({
							operation: 'credential_vault.read',
							status: 0,
							message: 'Unable to read model credential before receiving a response.',
							cause,
						}),
				});
				yield* requireOkResponse(response, 'credential_vault.read', 'Unable to read model credential');
				return yield* responseJson(response, ReadCredentialResponseSchema, 'model credential');
			}),
		),
	);
}

export async function workspaceModelVaultKey(
	workspaceId: string,
	provider: WorkspaceModelProvider,
): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(`${provider}:${workspaceId}`),
	);
	return `model-${provider}-${bytesToHex(new Uint8Array(digest).slice(0, 16))}`;
}

function credentialVault(env: WorkspaceCredentialVaultBindingEnv): DurableObjectStub {
	if (!env.WORKSPACE_CREDENTIAL_VAULT) {
		throw new ConfigMissing({
			name: 'WORKSPACE_CREDENTIAL_VAULT',
			message: 'WORKSPACE_CREDENTIAL_VAULT Durable Object binding is not configured.',
		});
	}
	return env.WORKSPACE_CREDENTIAL_VAULT.getByName('default');
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
