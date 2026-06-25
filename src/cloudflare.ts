import { getOAuthApiKey, type OAuthCredentials } from '@earendil-works/pi-ai/oauth';
import type { TelegramConversationRef } from '@flue/telegram';
import { WorkOS } from '@workos-inc/node/worker';
import { DurableObject } from 'cloudflare:workers';
import {
	credentialsEqual,
	createCodexAuthDocument,
	DEFAULT_WORKOS_VAULT_CONTEXT,
	DEFAULT_WORKOS_VAULT_OBJECT_NAME,
	OPENAI_CODEX_PROVIDER,
	parseCodexAuthDocument,
	type CodexAuthDocument,
} from './auth/codex-auth';
import {
	defaultTelegramAgentState,
	isTelegramModelKey,
	type TelegramAgentState,
	type TelegramModelKey,
} from './models';
import {
	cleanContentType,
	isPageStorageKey,
	normalizeTeachingPagePath,
	pagePathFromStorageKey,
	pageStorageKey,
	type TeachingPageRecord,
} from './teaching-pages';

interface Env {
	WORKOS_API_KEY?: string;
	WORKOS_VAULT_OBJECT_NAME?: string;
	WORKOS_MODEL_VAULT_OBJECT_PREFIX?: string;
	CODEX_AUTH_ADMIN_TOKEN?: string;
}

interface VaultObject {
	id: string;
	name: string;
	value?: string;
	metadata: {
		versionId?: string | null;
	};
}

interface TokenPayload {
	apiKey: string;
	expires: number;
}

interface DeviceAuthState {
	deviceAuthId: string;
	userCode: string;
	verificationUri: string;
	intervalSeconds: number;
	expiresAt: number;
}

interface DeviceStartResponse {
	state: string;
	userCode: string;
	verificationUri: string;
	intervalSeconds: number;
	expiresAt: string;
}

interface DeviceCompleteResponse {
	status: 'pending' | 'complete';
	configured?: true;
	expiresAt?: string;
}

const REFRESH_SKEW_MS = 60_000;
const DEVICE_CODE_TIMEOUT_MS = 15 * 60 * 1000;
const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_CODEX_AUTH_BASE_URL = 'https://auth.openai.com';
const OPENAI_CODEX_DEVICE_USER_CODE_URL = `${OPENAI_CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const OPENAI_CODEX_DEVICE_TOKEN_URL = `${OPENAI_CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/token`;
const OPENAI_CODEX_TOKEN_URL = `${OPENAI_CODEX_AUTH_BASE_URL}/oauth/token`;
const OPENAI_CODEX_DEVICE_VERIFICATION_URI = `${OPENAI_CODEX_AUTH_BASE_URL}/codex/device`;
const OPENAI_CODEX_DEVICE_REDIRECT_URI = `${OPENAI_CODEX_AUTH_BASE_URL}/deviceauth/callback`;
const OPENAI_CODEX_AUTH_CLAIM = 'https://api.openai.com/auth';
const DO_AUTH_VALUE_KEY = 'codex-auth-document';
const DO_AUTH_OBJECT_ID = 'codex-auth-durable-object-storage';
const DO_AUTH_OBJECT_NAME = 'codex-auth-durable-object-storage';
const TELEGRAM_STATE_PREFIX = 'telegram-state:';
const TELEGRAM_REPLY_TARGET_PREFIX = 'telegram-reply-target:';
const TELEGRAM_REPLY_TARGET_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MODEL_VAULT_OBJECT_PREFIX = 'sapio-flue-model-key';
const MODEL_CREDENTIAL_VALUE_PREFIX = 'model-credential:';
const MODEL_CREDENTIAL_DOCUMENT_TYPE = 'workspace-model-api-key';

interface TelegramStateDocument extends TelegramAgentState {
	updatedAt: string;
}

interface TelegramStatePatch {
	modelKey?: TelegramModelKey;
	sessionId?: string;
	newSession?: boolean;
	workspaceId?: string | null;
}

interface TelegramReplyTargetDocument {
	agentId: string;
	replyTargetId: string;
	ref: TelegramConversationRef;
	updateId?: number;
	createdAt: string;
	expiresAt: string;
}

export class TelegramBotState extends DurableObject<Env> {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		try {
			if (url.pathname === '/state') {
				const conversationId = url.searchParams.get('conversationId');
				if (!conversationId) {
					throw new HttpError('conversationId is required.', 400);
				}

				if (request.method === 'GET') {
					return jsonResponse(await this.getState(conversationId));
				}

				if (request.method === 'POST') {
					const patch = (await request.json()) as TelegramStatePatch;
					return jsonResponse(await this.updateState(conversationId, patch));
				}

				return jsonResponse({ error: 'Method not allowed.' }, { status: 405 });
			}

			if (url.pathname === '/reply-target') {
				if (request.method === 'POST') {
					return jsonResponse(await this.storeReplyTarget(await request.json()));
				}

				if (request.method === 'GET') {
					return jsonResponse(
						await this.getReplyTarget(
							url.searchParams.get('agentId'),
							url.searchParams.get('replyTargetId'),
						),
					);
				}

				return jsonResponse({ error: 'Method not allowed.' }, { status: 405 });
			}

			return jsonResponse({ error: 'Not found.' }, { status: 404 });
		} catch (error) {
			return jsonResponse(
				{ error: error instanceof Error ? error.message : String(error) },
				{ status: statusFromError(error) },
			);
		}
	}

	private async getState(conversationId: string): Promise<TelegramStateDocument> {
		return (await this.ctx.storage.get<TelegramStateDocument>(this.key(conversationId))) ?? {
			...defaultTelegramAgentState(),
			updatedAt: new Date(0).toISOString(),
		};
	}

	private async updateState(
		conversationId: string,
		patch: TelegramStatePatch,
	): Promise<TelegramStateDocument> {
		const current = await this.getState(conversationId);
		const modelKey = patch.modelKey ?? current.modelKey;
		if (!isTelegramModelKey(modelKey)) {
			throw new HttpError('Unsupported model key.', 400);
		}

		const sessionId = patch.newSession
			? newSessionId()
			: patch.sessionId
				? cleanSessionId(patch.sessionId)
				: current.sessionId;
		const workspaceId =
			patch.workspaceId === undefined
				? current.workspaceId
				: patch.workspaceId === null
					? undefined
					: cleanWorkspaceId(patch.workspaceId);

		const next: TelegramStateDocument = {
			modelKey,
			sessionId,
			...(workspaceId ? { workspaceId } : {}),
			updatedAt: new Date().toISOString(),
		};
		await this.ctx.storage.put(this.key(conversationId), next);
		return next;
	}

	private async storeReplyTarget(input: unknown): Promise<TelegramReplyTargetDocument> {
		const parsed = parseReplyTargetInput(input);
		const now = new Date();
		const document: TelegramReplyTargetDocument = {
			agentId: parsed.agentId,
			replyTargetId: parsed.replyTargetId,
			ref: parsed.ref,
			...(parsed.updateId === undefined ? {} : { updateId: parsed.updateId }),
			createdAt: now.toISOString(),
			expiresAt: new Date(now.getTime() + TELEGRAM_REPLY_TARGET_TTL_MS).toISOString(),
		};
		await this.ctx.storage.put(this.replyTargetKey(document.agentId, document.replyTargetId), document);
		return document;
	}

	private async getReplyTarget(
		agentId: string | null,
		replyTargetId: string | null,
	): Promise<TelegramReplyTargetDocument> {
		const cleanAgentId = cleanAgentIdOrThrow(agentId);
		const cleanReplyTargetId = cleanReplyTargetIdOrThrow(replyTargetId);
		const key = this.replyTargetKey(cleanAgentId, cleanReplyTargetId);
		const document = await this.ctx.storage.get<TelegramReplyTargetDocument>(key);
		if (!document) {
			throw new HttpError('Telegram reply target was not found.', 404);
		}
		if (Date.now() > Date.parse(document.expiresAt)) {
			await this.ctx.storage.delete(key);
			throw new HttpError('Telegram reply target expired.', 410);
		}
		return document;
	}

	private key(conversationId: string): string {
		return `${TELEGRAM_STATE_PREFIX}${conversationId}`;
	}

	private replyTargetKey(agentId: string, replyTargetId: string): string {
		return `${TELEGRAM_REPLY_TARGET_PREFIX}${agentId}:${replyTargetId}`;
	}
}

export class LessonPageStore extends DurableObject<Env> {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		try {
			if (url.pathname === '/index' && request.method === 'GET') {
				return jsonResponse({ pages: await this.listPages() });
			}

			if (url.pathname === '/page') {
				const path = normalizeTeachingPagePath(url.searchParams.get('path') ?? '');
				if (request.method === 'GET') {
					const page = await this.ctx.storage.get<TeachingPageRecord>(pageStorageKey(path));
					if (!page) {
						throw new HttpError('Teaching page not found.', 404);
					}
					return jsonResponse(page);
				}

				if (request.method === 'PUT') {
					const input = (await request.json()) as Partial<TeachingPageRecord>;
					if (typeof input.body !== 'string' || input.body.length === 0) {
						throw new HttpError('Teaching page body is required.', 400);
					}

					const page: TeachingPageRecord = {
						path,
						body: input.body,
						title: typeof input.title === 'string' && input.title.trim() ? input.title.trim() : undefined,
						contentType: cleanContentType(input.contentType, path),
						updatedAt: new Date().toISOString(),
					};
					await this.ctx.storage.put(pageStorageKey(path), page);
					return jsonResponse(this.metadata(page));
				}
			}

			return jsonResponse({ error: 'Not found.' }, { status: 404 });
		} catch (error) {
			return jsonResponse(
				{ error: error instanceof Error ? error.message : String(error) },
				{ status: statusFromError(error) },
			);
		}
	}

	private async listPages(): Promise<Array<Omit<TeachingPageRecord, 'body'>>> {
		const entries = await this.ctx.storage.list<TeachingPageRecord>({ prefix: 'page:' });
		return Array.from(entries.entries())
			.filter(([key]) => isPageStorageKey(key))
			.map(([key, page]) => this.metadata({ ...page, path: page.path || pagePathFromStorageKey(key) }))
			.sort((left, right) => left.path.localeCompare(right.path));
	}

	private metadata(page: TeachingPageRecord): Omit<TeachingPageRecord, 'body'> {
		return {
			path: page.path,
			title: page.title,
			contentType: page.contentType,
			updatedAt: page.updatedAt,
		};
	}
}

export class WorkspaceCredentialVault extends DurableObject<Env> {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		try {
			if (url.pathname !== '/credential') {
				return jsonResponse({ error: 'Not found.' }, { status: 404 });
			}

			if (request.method === 'PUT') {
				return jsonResponse(await this.storeCredential(await request.json()));
			}

			if (request.method === 'GET') {
				return jsonResponse(await this.readCredential(url.searchParams.get('vaultKey')));
			}

			if (request.method === 'DELETE') {
				return jsonResponse(await this.deleteCredential(url.searchParams.get('vaultKey')));
			}

			return jsonResponse({ error: 'Method not allowed.' }, { status: 405 });
		} catch (error) {
			return jsonResponse(
				{ error: error instanceof Error ? error.message : String(error) },
				{ status: statusFromError(error) },
			);
		}
	}

	private async storeCredential(input: unknown) {
		const parsed = parseModelCredentialInput(input);
		const document = {
			type: MODEL_CREDENTIAL_DOCUMENT_TYPE,
			vaultKey: parsed.vaultKey,
			provider: parsed.provider,
			apiKey: parsed.apiKey,
			updatedAt: new Date().toISOString(),
		};

		if (!this.env.WORKOS_API_KEY) {
			await this.ctx.storage.put(this.storageKey(parsed.vaultKey), JSON.stringify(document));
			return {
				configured: true,
				provider: parsed.provider,
				vaultKey: parsed.vaultKey,
				updatedAt: document.updatedAt,
				storage: 'durable-object' as const,
			};
		}

		const workos = this.workos();
		const existing = await this.readVaultObjectIfExists(parsed.vaultKey, workos);
		if (!existing) {
			const metadata = await workos.vault.createObject({
				name: this.objectName(parsed.vaultKey),
				value: JSON.stringify(document),
				context: {
					app: 'sapio-flue',
					kind: 'workspace-model-api-key',
					provider: parsed.provider,
					vaultKey: parsed.vaultKey,
				},
			});
			return {
				configured: true,
				provider: parsed.provider,
				vaultKey: parsed.vaultKey,
				objectId: metadata.id,
				versionId: metadata.versionId ?? null,
				updatedAt: document.updatedAt,
				storage: 'workos-vault' as const,
			};
		}

		const updated = await workos.vault.updateObject({
			id: existing.id,
			value: JSON.stringify(document),
			versionCheck: requiredVersionId(existing),
		});
		return {
			configured: true,
			provider: parsed.provider,
			vaultKey: parsed.vaultKey,
			objectId: updated.id,
			versionId: updated.metadata.versionId ?? null,
			updatedAt: document.updatedAt,
			storage: 'workos-vault' as const,
		};
	}

	private async readCredential(vaultKey: string | null) {
		const cleanVaultKey = cleanVaultKeyOrThrow(vaultKey);
		const value = await this.readCredentialValue(cleanVaultKey);
		const document = parseModelCredentialDocument(value);
		return {
			provider: document.provider,
			apiKey: document.apiKey,
			updatedAt: document.updatedAt,
		};
	}

	private async deleteCredential(vaultKey: string | null) {
		const cleanVaultKey = cleanVaultKeyOrThrow(vaultKey);
		if (!this.env.WORKOS_API_KEY) {
			await this.ctx.storage.delete(this.storageKey(cleanVaultKey));
			return { deleted: true, vaultKey: cleanVaultKey };
		}

		const existing = await this.readVaultObjectIfExists(cleanVaultKey);
		if (!existing) {
			return { deleted: false, vaultKey: cleanVaultKey };
		}

		await this.workos().vault.deleteObject({ id: existing.id });
		return { deleted: true, vaultKey: cleanVaultKey };
	}

	private async readCredentialValue(vaultKey: string): Promise<string> {
		if (!this.env.WORKOS_API_KEY) {
			const value = await this.ctx.storage.get<string>(this.storageKey(vaultKey));
			if (!value) {
				throw new HttpError('Model credential was not found.', 404);
			}
			return value;
		}

		const object = await this.readVaultObjectIfExists(vaultKey);
		if (!object?.value) {
			throw new HttpError('Model credential was not found.', 404);
		}
		return object.value;
	}

	private async readVaultObjectIfExists(
		vaultKey: string,
		workos?: WorkOS,
	): Promise<VaultObject | undefined> {
		try {
			return (await (workos ?? this.workos()).vault.readObjectByName(this.objectName(vaultKey))) as VaultObject;
		} catch (error) {
			if (statusFromError(error) === 404) {
				return undefined;
			}
			throw error;
		}
	}

	private workos(): WorkOS {
		if (!this.env.WORKOS_API_KEY) {
			throw new HttpError('WORKOS_API_KEY is not configured.', 503);
		}
		return new WorkOS(this.env.WORKOS_API_KEY);
	}

	private objectName(vaultKey: string): string {
		return `${this.env.WORKOS_MODEL_VAULT_OBJECT_PREFIX ?? DEFAULT_MODEL_VAULT_OBJECT_PREFIX}-${vaultKey}`;
	}

	private storageKey(vaultKey: string): string {
		return `${MODEL_CREDENTIAL_VALUE_PREFIX}${vaultKey}`;
	}
}

export class CodexAuthVault extends DurableObject<Env> {
	private tokenPromise: Promise<TokenPayload> | undefined;
	private cachedToken: TokenPayload | undefined;

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		try {
			if (request.method === 'GET' && url.pathname === '/status') {
				return jsonResponse(await this.status());
			}
			if (request.method === 'POST' && url.pathname === '/seed') {
				this.assertAdmin(request);
				return jsonResponse(await this.seed(await request.json()));
			}
			if (request.method === 'POST' && url.pathname === '/token') {
				const token = await this.issueToken();
				return jsonResponse(token);
			}
			if (request.method === 'POST' && url.pathname === '/oauth/device/start') {
				this.assertAdmin(request);
				return jsonResponse(await this.startDeviceLogin());
			}
			if (request.method === 'GET' && url.pathname === '/oauth/device/status') {
				return jsonResponse(await this.deviceLoginStatus(url.searchParams.get('state')));
			}
			if (request.method === 'POST' && url.pathname === '/oauth/device/complete') {
				return jsonResponse(await this.completeDeviceLogin(url.searchParams.get('state')));
			}

			return jsonResponse({ error: 'Not found.' }, { status: 404 });
		} catch (error) {
			return jsonResponse(
				{ error: error instanceof Error ? error.message : String(error) },
				{ status: statusFromError(error) },
			);
		}
	}

	private async startDeviceLogin(): Promise<DeviceStartResponse> {
		const response = await fetch(OPENAI_CODEX_DEVICE_USER_CODE_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ client_id: OPENAI_CODEX_CLIENT_ID }),
		});
		if (!response.ok) {
			throw new Error(`OpenAI Codex device login failed to start (${response.status}).`);
		}

		const json = (await response.json()) as {
			device_auth_id?: string;
			user_code?: string;
			interval?: number | string;
		};
		const intervalSeconds =
			typeof json.interval === 'string' ? Number(json.interval.trim()) : json.interval;
		if (
			!json.device_auth_id ||
			!json.user_code ||
			typeof intervalSeconds !== 'number' ||
			!Number.isFinite(intervalSeconds) ||
			intervalSeconds < 0
		) {
			throw new Error('OpenAI Codex device login returned an invalid response.');
		}

		const state = randomToken();
		const stateRecord: DeviceAuthState = {
			deviceAuthId: json.device_auth_id,
			userCode: json.user_code,
			verificationUri: OPENAI_CODEX_DEVICE_VERIFICATION_URI,
			intervalSeconds,
			expiresAt: Date.now() + DEVICE_CODE_TIMEOUT_MS,
		};
		await this.ctx.storage.put(this.deviceStateKey(state), stateRecord);

		return {
			state,
			userCode: stateRecord.userCode,
			verificationUri: stateRecord.verificationUri,
			intervalSeconds: stateRecord.intervalSeconds,
			expiresAt: new Date(stateRecord.expiresAt).toISOString(),
		};
	}

	private async deviceLoginStatus(state: string | null): Promise<DeviceStartResponse> {
		if (!state) {
			throw new HttpError('Missing device login state.', 400);
		}

		const stateRecord = await this.ctx.storage.get<DeviceAuthState>(this.deviceStateKey(state));
		if (!stateRecord) {
			throw new HttpError('Device login state was not found or already used.', 404);
		}
		if (Date.now() > stateRecord.expiresAt) {
			await this.ctx.storage.delete(this.deviceStateKey(state));
			throw new HttpError('Device login expired. Start again.', 410);
		}

		return {
			state,
			userCode: stateRecord.userCode,
			verificationUri: stateRecord.verificationUri,
			intervalSeconds: stateRecord.intervalSeconds,
			expiresAt: new Date(stateRecord.expiresAt).toISOString(),
		};
	}

	private async completeDeviceLogin(state: string | null): Promise<DeviceCompleteResponse> {
		if (!state) {
			throw new HttpError('Missing device login state.', 400);
		}

		const stateRecord = await this.ctx.storage.get<DeviceAuthState>(this.deviceStateKey(state));
		if (!stateRecord) {
			throw new HttpError('Device login state was not found or already used.', 404);
		}
		if (Date.now() > stateRecord.expiresAt) {
			await this.ctx.storage.delete(this.deviceStateKey(state));
			throw new HttpError('Device login expired. Start again.', 410);
		}

		const deviceToken = await this.pollDeviceLogin(stateRecord);
		if (deviceToken.status === 'pending') {
			return { status: 'pending' };
		}

		const credentials = await this.exchangeDeviceAuthorization(
			deviceToken.authorizationCode,
			deviceToken.codeVerifier,
		);
		const result = await this.seed(credentials);
		await this.ctx.storage.delete(this.deviceStateKey(state));

		return {
			status: 'complete',
			configured: true,
			expiresAt: result.expiresAt,
		};
	}

	private async pollDeviceLogin(
		state: DeviceAuthState,
	): Promise<
		| { status: 'pending' }
		| { status: 'complete'; authorizationCode: string; codeVerifier: string }
	> {
		const response = await fetch(OPENAI_CODEX_DEVICE_TOKEN_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				device_auth_id: state.deviceAuthId,
				user_code: state.userCode,
			}),
		});

		if (response.ok) {
			const json = (await response.json()) as {
				authorization_code?: string;
				code_verifier?: string;
			};
			if (!json.authorization_code || !json.code_verifier) {
				throw new Error('OpenAI Codex device login returned an invalid completion response.');
			}
			return {
				status: 'complete',
				authorizationCode: json.authorization_code,
				codeVerifier: json.code_verifier,
			};
		}

		if (response.status === 403 || response.status === 404) {
			return { status: 'pending' };
		}

		const body = await response.text().catch(() => '');
		const code = parseErrorCode(body);
		if (code === 'deviceauth_authorization_pending' || code === 'slow_down') {
			return { status: 'pending' };
		}

		throw new Error(`OpenAI Codex device login failed (${response.status}).`);
	}

	private async exchangeDeviceAuthorization(
		authorizationCode: string,
		codeVerifier: string,
	): Promise<OAuthCredentials> {
		const response = await fetch(OPENAI_CODEX_TOKEN_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				client_id: OPENAI_CODEX_CLIENT_ID,
				code: authorizationCode,
				code_verifier: codeVerifier,
				redirect_uri: OPENAI_CODEX_DEVICE_REDIRECT_URI,
			}),
		});
		if (!response.ok) {
			throw new Error(`OpenAI Codex token exchange failed (${response.status}).`);
		}

		const json = (await response.json()) as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
		};
		if (!json.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
			throw new Error('OpenAI Codex token exchange returned an invalid response.');
		}

		const credentials: OAuthCredentials = {
			access: json.access_token,
			refresh: json.refresh_token,
			expires: Date.now() + json.expires_in * 1000,
		};
		const accountId = getAccountId(json.access_token);
		return accountId ? { ...credentials, accountId } : credentials;
	}

	private async status() {
		const object = await this.readAuthObjectIfExists();
		if (!object?.value) {
			return { configured: false };
		}

		const document = parseCodexAuthDocument(object.value);
		return {
			configured: true,
			objectId: object.id,
			objectName: object.name,
			versionId: object.metadata.versionId ?? null,
			updatedAt: document.updatedAt,
			expiresAt: new Date(document.credentials.expires).toISOString(),
		};
	}

	private async seed(input: unknown) {
		const document = createCodexAuthDocument(input);
		const value = JSON.stringify(document);
		if (!this.env.WORKOS_API_KEY) {
			await this.ctx.storage.put(DO_AUTH_VALUE_KEY, value);
			this.cachedToken = undefined;
			return {
				configured: true,
				objectId: DO_AUTH_OBJECT_ID,
				versionId: null,
				updatedAt: document.updatedAt,
				expiresAt: new Date(document.credentials.expires).toISOString(),
			};
		}

		const workos = this.workos();
		const existing = await this.readAuthObjectIfExists(workos);

		if (!existing) {
			const metadata = await workos.vault.createObject({
				name: this.objectName(),
				value,
				context: DEFAULT_WORKOS_VAULT_CONTEXT,
			});
			this.cachedToken = undefined;
			return {
				configured: true,
				objectId: metadata.id,
				versionId: metadata.versionId ?? null,
				updatedAt: document.updatedAt,
				expiresAt: new Date(document.credentials.expires).toISOString(),
			};
		}

		const updated = await this.updateAuthObject(workos, existing, document);
		this.cachedToken = undefined;
		return {
			configured: true,
			objectId: updated.id,
			versionId: updated.metadata.versionId ?? null,
			updatedAt: document.updatedAt,
			expiresAt: new Date(document.credentials.expires).toISOString(),
		};
	}

	private async issueToken(): Promise<TokenPayload> {
		if (this.cachedToken && this.cachedToken.expires - Date.now() > REFRESH_SKEW_MS) {
			return this.cachedToken;
		}

		this.tokenPromise ??= this.issueTokenFromVault().finally(() => {
			this.tokenPromise = undefined;
		});

		return this.tokenPromise;
	}

	private async issueTokenFromVault(): Promise<TokenPayload> {
		const object = await this.readAuthObject();
		const document = parseCodexAuthDocument(object.value);
		const credentials = withRefreshSkew(document.credentials);
		const result = await getOAuthApiKey(OPENAI_CODEX_PROVIDER, {
			[OPENAI_CODEX_PROVIDER]: credentials,
		});

		if (!result) {
			throw new Error('OpenAI Codex credentials are not configured.');
		}

		if (!credentialsEqual(document.credentials, result.newCredentials)) {
			const updatedDocument: CodexAuthDocument = {
				...document,
				credentials: result.newCredentials,
				updatedAt: new Date().toISOString(),
			};
			await this.saveAuthDocument(object, updatedDocument);
		}

		this.cachedToken = {
			apiKey: result.apiKey,
			expires: result.newCredentials.expires,
		};
		return this.cachedToken;
	}

	private async readAuthObjectIfExists(workos?: WorkOS): Promise<VaultObject | undefined> {
		if (!this.env.WORKOS_API_KEY) {
			const value = await this.ctx.storage.get<string>(DO_AUTH_VALUE_KEY);
			return value
				? {
						id: DO_AUTH_OBJECT_ID,
						name: DO_AUTH_OBJECT_NAME,
						value,
						metadata: { versionId: null },
					}
				: undefined;
		}

		try {
			return (await (workos ?? this.workos()).vault.readObjectByName(this.objectName())) as VaultObject;
		} catch (error) {
			if (statusFromError(error) === 404) {
				return undefined;
			}
			throw error;
		}
	}

	private async readAuthObject(workos?: WorkOS): Promise<VaultObject> {
		const object = await this.readAuthObjectIfExists(workos);
		if (!object?.value) {
			throw new HttpError(
				'OpenAI Codex credentials are not configured. Use /admin/codex-auth/login to connect Codex.',
				404,
			);
		}
		return object;
	}

	private async saveAuthDocument(object: VaultObject, document: CodexAuthDocument): Promise<void> {
		if (!this.env.WORKOS_API_KEY) {
			await this.ctx.storage.put(DO_AUTH_VALUE_KEY, JSON.stringify(document));
			return;
		}

		await this.updateAuthObject(this.workos(), object, document);
	}

	private async updateAuthObject(
		workos: WorkOS,
		object: VaultObject,
		document: CodexAuthDocument,
	): Promise<VaultObject> {
		const versionCheck = object.metadata.versionId;
		if (!versionCheck) {
			throw new Error('WorkOS Vault object did not include a versionId.');
		}

		return (await workos.vault.updateObject({
			id: object.id,
			value: JSON.stringify(document),
			versionCheck,
		})) as VaultObject;
	}

	private workos(): WorkOS {
		if (!this.env.WORKOS_API_KEY) {
			throw new HttpError('WORKOS_API_KEY is not configured.', 503);
		}
		return new WorkOS(this.env.WORKOS_API_KEY);
	}

	private objectName(): string {
		return this.env.WORKOS_VAULT_OBJECT_NAME ?? DEFAULT_WORKOS_VAULT_OBJECT_NAME;
	}

	private deviceStateKey(state: string): string {
		return `codex-device:${state}`;
	}

	private assertAdmin(request: Request): void {
		if (!this.env.CODEX_AUTH_ADMIN_TOKEN) {
			throw new HttpError('CODEX_AUTH_ADMIN_TOKEN is not configured.', 503);
		}

		const authorization = request.headers.get('authorization');
		if (authorization !== `Bearer ${this.env.CODEX_AUTH_ADMIN_TOKEN}`) {
			throw new HttpError('Unauthorized.', 401);
		}
	}
}

function randomToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return base64Url(bytes);
}

interface ModelCredentialInput {
	vaultKey: string;
	provider: 'openai';
	apiKey: string;
}

interface ModelCredentialDocument extends ModelCredentialInput {
	type: typeof MODEL_CREDENTIAL_DOCUMENT_TYPE;
	updatedAt: string;
}

function parseModelCredentialInput(input: unknown): ModelCredentialInput {
	if (!isRecord(input)) {
		throw new HttpError('Model credential input must be an object.', 400);
	}

	const vaultKey = cleanVaultKeyOrThrow(input.vaultKey);
	if (input.provider !== 'openai') {
		throw new HttpError('Only OpenAI model credentials are supported.', 400);
	}
	if (typeof input.apiKey !== 'string' || input.apiKey.trim().length < 8) {
		throw new HttpError('apiKey is required.', 400);
	}

	return {
		vaultKey,
		provider: input.provider,
		apiKey: input.apiKey.trim(),
	};
}

function parseModelCredentialDocument(value: unknown): ModelCredentialDocument {
	const parsed = typeof value === 'string' ? parseJson(value) : value;
	if (!isRecord(parsed)) {
		throw new HttpError('Stored model credential is not an object.', 500);
	}
	if (parsed.type !== MODEL_CREDENTIAL_DOCUMENT_TYPE) {
		throw new HttpError('Stored model credential has an unsupported type.', 500);
	}
	if (parsed.provider !== 'openai') {
		throw new HttpError('Stored model credential has an unsupported provider.', 500);
	}
	if (typeof parsed.apiKey !== 'string' || parsed.apiKey.length === 0) {
		throw new HttpError('Stored model credential is missing apiKey.', 500);
	}
	if (typeof parsed.updatedAt !== 'string') {
		throw new HttpError('Stored model credential is missing updatedAt.', 500);
	}

	return {
		type: parsed.type,
		provider: parsed.provider,
		apiKey: parsed.apiKey,
		vaultKey: cleanVaultKeyOrThrow(parsed.vaultKey),
		updatedAt: parsed.updatedAt,
	};
}

function cleanVaultKeyOrThrow(value: unknown): string {
	if (typeof value !== 'string') {
		throw new HttpError('vaultKey is required.', 400);
	}
	const cleaned = value.trim().toLowerCase();
	if (!/^[a-z0-9][a-z0-9_-]{10,120}$/.test(cleaned)) {
		throw new HttpError('vaultKey is invalid.', 400);
	}
	return cleaned;
}

function parseReplyTargetInput(input: unknown): {
	agentId: string;
	replyTargetId: string;
	ref: TelegramConversationRef;
	updateId?: number;
} {
	if (!isRecord(input)) {
		throw new HttpError('Telegram reply target input must be an object.', 400);
	}

	return {
		agentId: cleanAgentIdOrThrow(input.agentId),
		replyTargetId: cleanReplyTargetIdOrThrow(input.replyTargetId),
		ref: parseTelegramConversationRef(input.ref),
		...(input.updateId === undefined ? {} : { updateId: cleanUpdateId(input.updateId) }),
	};
}

function parseTelegramConversationRef(value: unknown): TelegramConversationRef {
	if (!isRecord(value)) {
		throw new HttpError('Telegram reply target ref must be an object.', 400);
	}

	const topic = {
		...(value.messageThreadId === undefined
			? {}
			: { messageThreadId: cleanPositiveSafeInteger(value.messageThreadId, 'messageThreadId') }),
		...(value.directMessagesTopicId === undefined
			? {}
			: {
					directMessagesTopicId: cleanPositiveSafeInteger(
						value.directMessagesTopicId,
						'directMessagesTopicId',
					),
				}),
	};
	if ('messageThreadId' in topic && 'directMessagesTopicId' in topic) {
		throw new HttpError('Telegram reply target cannot include two topic ids.', 400);
	}

	if (value.type === 'chat') {
		return {
			type: 'chat',
			chatId: cleanTelegramChatId(value.chatId),
			...topic,
		};
	}

	if (value.type === 'business-chat') {
		if (typeof value.businessConnectionId !== 'string' || !value.businessConnectionId.trim()) {
			throw new HttpError('businessConnectionId is required.', 400);
		}
		return {
			type: 'business-chat',
			businessConnectionId: value.businessConnectionId.trim(),
			chatId: cleanTelegramChatId(value.chatId),
			...topic,
		};
	}

	throw new HttpError('Telegram reply target type is unsupported.', 400);
}

function cleanAgentIdOrThrow(value: unknown): string {
	if (typeof value !== 'string') {
		throw new HttpError('agentId is required.', 400);
	}
	const cleaned = value.trim();
	if (!cleaned || cleaned.length > 512) {
		throw new HttpError('agentId is invalid.', 400);
	}
	return cleaned;
}

function cleanReplyTargetIdOrThrow(value: unknown): string {
	if (typeof value !== 'string') {
		throw new HttpError('replyTargetId is required.', 400);
	}
	const cleaned = value.trim();
	if (!/^[A-Za-z0-9_-]{8,80}$/.test(cleaned)) {
		throw new HttpError('replyTargetId is invalid.', 400);
	}
	return cleaned;
}

function cleanUpdateId(value: unknown): number {
	return cleanSafeInteger(value, 'updateId', { minimum: 0 });
}

function cleanTelegramChatId(value: unknown): number {
	const chatId = cleanSafeInteger(value, 'chatId');
	if (chatId === 0) {
		throw new HttpError('chatId is invalid.', 400);
	}
	return chatId;
}

function cleanPositiveSafeInteger(value: unknown, label: string): number {
	return cleanSafeInteger(value, label, { minimum: 1 });
}

function cleanSafeInteger(
	value: unknown,
	label: string,
	options: { minimum?: number } = {},
): number {
	if (!Number.isSafeInteger(value)) {
		throw new HttpError(`${label} must be a safe integer.`, 400);
	}
	const integer = value as number;
	if (options.minimum !== undefined && integer < options.minimum) {
		throw new HttpError(`${label} is invalid.`, 400);
	}
	return integer;
}

function requiredVersionId(object: VaultObject): string {
	const versionId = object.metadata.versionId;
	if (!versionId) {
		throw new Error('WorkOS Vault object did not include a versionId.');
	}
	return versionId;
}

function newSessionId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(6));
	return `${Date.now().toString(36)}-${base64Url(bytes)}`;
}

function cleanSessionId(value: string): string {
	const cleaned = value.trim().replaceAll(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
	if (!cleaned) {
		throw new HttpError('sessionId must not be empty.', 400);
	}
	return cleaned;
}

function cleanWorkspaceId(value: string): string {
	const cleaned = value.trim();
	if (!cleaned || cleaned.length > 200 || /\s/.test(cleaned)) {
		throw new HttpError('workspaceId is invalid.', 400);
	}
	return cleaned;
}

function base64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function parseErrorCode(body: string): string | undefined {
	try {
		const json = JSON.parse(body) as { error?: string | { code?: string } };
		return typeof json.error === 'object' ? json.error.code : json.error;
	} catch {
		return undefined;
	}
}

function parseJson(value: string): unknown {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		throw new Error('Expected valid JSON.');
	}
}

function getAccountId(accessToken: string): string | undefined {
	const payload = decodeJwt(accessToken);
	const auth = payload?.[OPENAI_CODEX_AUTH_CLAIM];
	if (!isRecord(auth)) {
		return undefined;
	}
	return typeof auth.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : undefined;
}

function decodeJwt(token: string): Record<string, unknown> | undefined {
	try {
		const [, payload] = token.split('.');
		if (!payload) {
			return undefined;
		}
		const padded = payload
			.replaceAll('-', '+')
			.replaceAll('_', '/')
			.padEnd(Math.ceil(payload.length / 4) * 4, '=');
		const json = JSON.parse(atob(padded)) as unknown;
		return isRecord(json) ? json : undefined;
	} catch {
		return undefined;
	}
}

function withRefreshSkew(credentials: OAuthCredentials): OAuthCredentials {
	if (credentials.expires - Date.now() > REFRESH_SKEW_MS) {
		return credentials;
	}

	return {
		...credentials,
		expires: Date.now() - 1,
	};
}

function jsonResponse(value: unknown, init?: ResponseInit): Response {
	const headers = new Headers(init?.headers);
	headers.set('content-type', 'application/json; charset=utf-8');
	return new Response(JSON.stringify(value), {
		...init,
		headers,
	});
}

function statusFromError(error: unknown): number {
	if (error instanceof HttpError) {
		return error.status;
	}
	if (isStatusError(error)) {
		return error.status;
	}
	if (isWorkosResponseError(error)) {
		return error.response.status;
	}
	return 500;
}

function isStatusError(error: unknown): error is { status: number } {
	return (
		typeof error === 'object' &&
		error !== null &&
		'status' in error &&
		typeof error.status === 'number'
	);
}

function isWorkosResponseError(error: unknown): error is { response: { status: number } } {
	return (
		typeof error === 'object' &&
		error !== null &&
		'response' in error &&
		typeof error.response === 'object' &&
		error.response !== null &&
		'status' in error.response &&
		typeof error.response.status === 'number'
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class HttpError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}
