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
	const response = await credentialVault(env).fetch(
		new Request('https://workspace-credential-vault/credential', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				vaultKey,
				provider: args.provider,
				apiKey: args.apiKey,
			}),
		}),
	);
	if (!response.ok) {
		throw new Error(`Unable to store model credential (${response.status}): ${await response.text()}`);
	}
	return (await response.json()) as StoredCredentialResponse;
}

export async function readWorkspaceModelApiKey(
	env: WorkspaceCredentialVaultBindingEnv,
	vaultKey: string,
): Promise<ReadCredentialResponse> {
	const response = await credentialVault(env).fetch(
		new Request(`https://workspace-credential-vault/credential?vaultKey=${encodeURIComponent(vaultKey)}`),
	);
	if (!response.ok) {
		throw new Error(`Unable to read model credential (${response.status}): ${await response.text()}`);
	}
	return (await response.json()) as ReadCredentialResponse;
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
		throw new Error('WORKSPACE_CREDENTIAL_VAULT Durable Object binding is not configured.');
	}
	return env.WORKSPACE_CREDENTIAL_VAULT.getByName('default');
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
