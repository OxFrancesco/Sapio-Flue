import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
	createPolarCheckoutSession,
	isPolarBillingConfigured,
	type PaidWorkspacePlan,
	type PolarBillingBindingEnv,
} from '../billing/polar';
import {
	createWorkspaceInvite,
	getWorkspace,
	isConvexConfigured,
	joinWorkspaceInvite,
	setModelCredential,
	setWorkspaceModel,
	syncTelegramContext,
	type ConvexBindingEnv,
	type SyncedTelegramContext,
	type WorkspaceDetails,
} from '../convex-client';
import { renderUserError } from '../effect/errors';
import {
	storeWorkspaceModelApiKey,
	type WorkspaceCredentialVaultBindingEnv,
} from '../model-credentials';
import {
	buildTelegramAgentId,
	defaultTelegramAgentState,
	isTelegramModelKey,
	OPENAI_BYOK_DEFAULT_MODEL_ID,
	TELEGRAM_MODEL_OPTIONS,
	type TelegramAgentState,
	type TelegramModelKey,
} from '../models';
import {
	publicBaseUrl,
	resolveTeachingPageReference,
	shareIdForAgentId,
	teachingPageIndexUrl,
	teachingPageStore,
	teachingPageUrl,
	type TeachingPageBindingEnv,
	type TeachingPageRecord,
} from '../teaching-pages';

export interface MobileApiBindingEnv
	extends TeachingPageBindingEnv,
		ConvexBindingEnv,
		WorkspaceCredentialVaultBindingEnv,
		PolarBillingBindingEnv {
	MOBILE_API_TOKEN?: string;
	CODEX_AUTH_VAULT?: DurableObjectNamespace;
	CODEX_AUTH_ADMIN_TOKEN?: string;
	TELEGRAM_BOT_STATE?: DurableObjectNamespace;
}

interface MobileProfile {
	id: string;
	firstName: string;
	lastName?: string;
	username?: string;
}

interface MobileStateDocument extends TelegramAgentState {
	updatedAt: string;
}

interface MobileRequestContext {
	profile: MobileProfile;
	conversationId: string;
	authContext: SyncedTelegramContext | undefined;
	state: MobileStateDocument;
	agentId: string;
}

const MOBILE_CONVERSATION_PREFIX = 'mobile:v1:user:';

const flueRoutes = flue();

export const mobileApi = new Hono<{ Bindings: MobileApiBindingEnv }>();

mobileApi.use('*', cors({ origin: '*', allowHeaders: ['authorization', 'content-type'] }));

mobileApi.use('*', async (c, next) => {
	const expected = c.env.MOBILE_API_TOKEN;
	if (!expected) {
		return c.json({ error: 'MOBILE_API_TOKEN is not configured.', code: 'not_configured' }, 503);
	}
	const authorization = c.req.header('authorization') ?? '';
	const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
	if (token !== expected) {
		return c.json({ error: 'Unauthorized.', code: 'unauthorized' }, 401);
	}
	await next();
});

mobileApi.get('/health', (c) =>
	c.json({
		ok: true,
		convexConfigured: isConvexConfigured(c.env),
		polarConfigured: isPolarBillingConfigured(c.env),
	}),
);

mobileApi.post('/context', async (c) => {
	const body = await readBody(c.req.raw);
	const request = await prepareRequestContext(c.env, body);
	if ('error' in request) {
		return c.json({ error: request.error, code: request.code }, request.status);
	}

	const codex = await readCodexStatus(c.env).catch(() => undefined);
	const shareId = await shareIdForAgentId(request.agentId);
	return c.json({
		convexConfigured: isConvexConfigured(c.env),
		polarConfigured: isPolarBillingConfigured(c.env),
		context: request.authContext ?? null,
		state: publicState(request.state),
		models: modelCatalog(request.state.modelKey),
		agentId: request.agentId,
		pagesIndexUrl: teachingPageIndexUrl(c.env, shareId),
		codex: codex ?? null,
	});
});

mobileApi.post('/chat', async (c) => {
	const body = await readBody(c.req.raw);
	const message = typeof body.message === 'string' ? body.message.trim() : '';
	if (!message) {
		return c.json({ error: 'message is required.', code: 'invalid_request' }, 400);
	}

	const request = await prepareRequestContext(c.env, body);
	if ('error' in request) {
		return c.json({ error: request.error, code: request.code }, request.status);
	}

	const readiness = modelReadiness(request.state, request.authContext, isConvexConfigured(c.env));
	if (readiness) {
		return c.json({ error: readiness.error, code: readiness.code }, readiness.status);
	}

	const response = await flueRoutes.fetch(
		new Request(
			`https://mobile-api.internal/agents/teacher/${encodeURIComponent(request.agentId)}?wait=result`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message }),
			},
		),
		c.env,
		c.executionCtx,
	);

	if (!response.ok) {
		const detail = (await response.text().catch(() => '')).split('\n    at ')[0].slice(0, 500);
		return c.json(
			{ error: `Agent prompt failed (${response.status}): ${detail}`, code: 'agent_error' },
			502,
		);
	}

	const payload = (await response.json()) as {
		result?: { text?: string; model?: { provider: string; id: string } };
		streamUrl?: string;
		offset?: string;
	};
	return c.json({
		reply: payload.result?.text ?? '',
		model: payload.result?.model ?? null,
		state: publicState(request.state),
		agentId: request.agentId,
	});
});

mobileApi.post('/model', async (c) => {
	const body = await readBody(c.req.raw);
	const modelKey = typeof body.modelKey === 'string' ? body.modelKey : '';
	if (!isTelegramModelKey(modelKey)) {
		return c.json({ error: `Unknown model key: ${modelKey}`, code: 'invalid_request' }, 400);
	}

	const request = await prepareRequestContext(c.env, body);
	if ('error' in request) {
		return c.json({ error: request.error, code: request.code }, request.status);
	}

	try {
		const state = await selectModel(c.env, request, modelKey);
		return c.json({ state: publicState(state), models: modelCatalog(state.modelKey) });
	} catch (error) {
		return c.json({ error: renderUserError(error), code: 'model_switch_failed' }, 502);
	}
});

mobileApi.post('/session/new', async (c) => {
	const body = await readBody(c.req.raw);
	const requestedModelKey = typeof body.modelKey === 'string' ? body.modelKey : undefined;
	if (requestedModelKey !== undefined && !isTelegramModelKey(requestedModelKey)) {
		return c.json({ error: `Unknown model key: ${requestedModelKey}`, code: 'invalid_request' }, 400);
	}

	const request = await prepareRequestContext(c.env, body);
	if ('error' in request) {
		return c.json({ error: request.error, code: request.code }, request.status);
	}

	try {
		const selected = requestedModelKey
			? await selectModel(c.env, request, requestedModelKey)
			: request.state;
		const state = withWorkspaceState(
			await updateConversationState(c.env, stateScopeId(request), {
				newSession: true,
				modelKey: selected.modelKey,
			}),
			request.authContext,
		);
		const agentId = buildTelegramAgentId(request.conversationId, state);
		const shareId = await shareIdForAgentId(agentId);
		return c.json({
			state: publicState(state),
			agentId,
			pagesIndexUrl: teachingPageIndexUrl(c.env, shareId),
		});
	} catch (error) {
		return c.json({ error: renderUserError(error), code: 'new_session_failed' }, 502);
	}
});

mobileApi.post('/workspace', async (c) => {
	const body = await readBody(c.req.raw);
	const request = await prepareRequestContext(c.env, body);
	if ('error' in request) {
		return c.json({ error: request.error, code: request.code }, request.status);
	}
	if (!request.authContext) {
		return c.json({ error: convexRequiredMessage(), code: 'convex_required' }, 503);
	}

	try {
		const details: WorkspaceDetails = await getWorkspace(c.env, {
			workspaceId: request.authContext.workspace.id,
			userId: request.authContext.user.id,
		});
		return c.json({ details });
	} catch (error) {
		return c.json({ error: renderUserError(error), code: 'workspace_failed' }, 502);
	}
});

mobileApi.post('/invite', async (c) => {
	const body = await readBody(c.req.raw);
	const request = await prepareRequestContext(c.env, body);
	if ('error' in request) {
		return c.json({ error: request.error, code: request.code }, request.status);
	}
	if (!request.authContext) {
		return c.json({ error: convexRequiredMessage(), code: 'convex_required' }, 503);
	}

	try {
		const invite = await createWorkspaceInvite(c.env, {
			workspaceId: request.authContext.workspace.id,
			userId: request.authContext.user.id,
			code: inviteCode(),
		});
		return c.json({ code: invite.code, workspaceName: invite.workspace.name });
	} catch (error) {
		return c.json({ error: renderUserError(error), code: 'invite_failed' }, 502);
	}
});

mobileApi.post('/join', async (c) => {
	const body = await readBody(c.req.raw);
	const code = typeof body.code === 'string' ? body.code.trim() : '';
	if (!code) {
		return c.json({ error: 'code is required.', code: 'invalid_request' }, 400);
	}

	const request = await prepareRequestContext(c.env, body);
	if ('error' in request) {
		return c.json({ error: request.error, code: request.code }, request.status);
	}
	if (!request.authContext) {
		return c.json({ error: convexRequiredMessage(), code: 'convex_required' }, 503);
	}

	try {
		const joined = await joinWorkspaceInvite(c.env, { code, userId: request.authContext.user.id });
		await updateConversationState(c.env, request.conversationId, {
			workspaceId: joined.workspace.id,
		});
		return c.json({ workspace: joined.workspace, membership: joined.membership });
	} catch (error) {
		return c.json({ error: renderUserError(error), code: 'join_failed' }, 502);
	}
});

mobileApi.post('/key', async (c) => {
	const body = await readBody(c.req.raw);
	const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
	const modelId =
		typeof body.modelId === 'string' && body.modelId.trim()
			? body.modelId.trim()
			: OPENAI_BYOK_DEFAULT_MODEL_ID;
	if (!apiKey) {
		return c.json({ error: 'apiKey is required.', code: 'invalid_request' }, 400);
	}

	const request = await prepareRequestContext(c.env, body);
	if ('error' in request) {
		return c.json({ error: request.error, code: request.code }, request.status);
	}
	if (!request.authContext) {
		return c.json({ error: convexRequiredMessage(), code: 'convex_required' }, 503);
	}

	try {
		const stored = await storeWorkspaceModelApiKey(c.env, {
			workspaceId: request.authContext.workspace.id,
			provider: 'openai',
			apiKey,
		});
		const result = await setModelCredential(c.env, {
			workspaceId: request.authContext.workspace.id,
			userId: request.authContext.user.id,
			provider: 'openai',
			modelId,
			vaultKey: stored.vaultKey,
		});
		return c.json({
			workspaceName: result.workspace.name,
			modelId: result.credential.modelId,
			defaultModelKey: result.workspace.defaultModelKey,
		});
	} catch (error) {
		return c.json({ error: renderUserError(error), code: 'key_failed' }, 502);
	}
});

mobileApi.post('/billing/checkout', async (c) => {
	const body = await readBody(c.req.raw);
	const plan: PaidWorkspacePlan = body.plan === 'team' ? 'team' : 'pro';

	const request = await prepareRequestContext(c.env, body);
	if ('error' in request) {
		return c.json({ error: request.error, code: request.code }, request.status);
	}
	if (!request.authContext) {
		return c.json({ error: convexRequiredMessage(), code: 'convex_required' }, 503);
	}
	if (!isPolarBillingConfigured(c.env)) {
		return c.json({ error: 'Polar billing is not configured yet.', code: 'billing_unavailable' }, 503);
	}

	try {
		const checkout = await createPolarCheckoutSession(c.env, {
			workspaceId: request.authContext.workspace.id,
			userId: request.authContext.user.id,
			plan,
			successUrl: new URL('/billing/polar/success', publicBaseUrl(c.env)).toString(),
			cancelUrl: new URL('/billing/polar/cancel', publicBaseUrl(c.env)).toString(),
		});
		return c.json({ url: checkout.url, plan: checkout.plan, workspaceName: checkout.workspace.name });
	} catch (error) {
		return c.json({ error: renderUserError(error), code: 'checkout_failed' }, 502);
	}
});

mobileApi.get('/codex/status', async (c) => {
	try {
		return c.json(await readCodexStatus(c.env));
	} catch (error) {
		return c.json({ error: renderUserError(error), code: 'codex_status_failed' }, 502);
	}
});

mobileApi.post('/codex/login', async (c) => {
	try {
		const start = await startCodexDeviceLogin(c.env);
		const loginUrl = new URL('/codex-auth/device', publicBaseUrl(c.env));
		loginUrl.searchParams.set('state', start.state);
		return c.json({
			loginUrl: loginUrl.toString(),
			verificationUri: start.verificationUri,
			userCode: start.userCode,
			expiresAt: start.expiresAt,
		});
	} catch (error) {
		return c.json({ error: renderUserError(error), code: 'codex_login_failed' }, 502);
	}
});

mobileApi.post('/pages', async (c) => {
	const body = await readBody(c.req.raw);
	const reference = typeof body.reference === 'string' ? body.reference.trim() : '';

	const request = await prepareRequestContext(c.env, body);
	if ('error' in request) {
		return c.json({ error: request.error, code: request.code }, request.status);
	}

	try {
		let shareId: string;
		let referencedPageUrl: string | undefined;
		if (reference) {
			const resolved = await resolveTeachingPageReference({
				reference,
				currentAgentId: request.agentId,
			});
			shareId = resolved.shareId;
			referencedPageUrl = resolved.path
				? teachingPageUrl(c.env, resolved.shareId, resolved.path)
				: undefined;
		} else {
			shareId = await shareIdForAgentId(request.agentId);
		}

		const pages = await readTeachingPageList(c.env, shareId);
		return c.json({
			sessionId: request.state.sessionId,
			shareId,
			indexUrl: teachingPageIndexUrl(c.env, shareId),
			referencedPageUrl: referencedPageUrl ?? null,
			pages: pages.map((page) => ({
				path: page.path,
				title: page.title || page.path,
				updatedAt: page.updatedAt,
				url: teachingPageUrl(c.env, shareId, page.path),
			})),
		});
	} catch (error) {
		return c.json({ error: renderUserError(error), code: 'pages_failed' }, 502);
	}
});

async function prepareRequestContext(
	env: MobileApiBindingEnv,
	body: Record<string, unknown>,
): Promise<MobileRequestContext | { error: string; code: string; status: 400 | 502 }> {
	const profile = parseProfile(body.profile);
	if (!profile) {
		return {
			error: 'profile with id and firstName is required.',
			code: 'invalid_request',
			status: 400,
		};
	}

	const conversationId = `${MOBILE_CONVERSATION_PREFIX}${profile.id}`;
	let authContext: SyncedTelegramContext | undefined;
	if (isConvexConfigured(env)) {
		try {
			const existing = await getConversationState(env, conversationId).catch(() => undefined);
			authContext = await syncTelegramContext(env, {
				telegramUser: {
					id: profile.id,
					isBot: false,
					firstName: profile.firstName,
					...(profile.lastName ? { lastName: profile.lastName } : {}),
					...(profile.username ? { username: profile.username } : {}),
				},
				telegramChat: {
					id: profile.id,
					type: 'private',
					firstName: profile.firstName,
					...(profile.lastName ? { lastName: profile.lastName } : {}),
					...(profile.username ? { username: profile.username } : {}),
				},
				conversationId,
				...(existing?.workspaceId ? { activeWorkspaceId: existing.workspaceId } : {}),
			});
		} catch (error) {
			return {
				error: `Workspace sign-in failed: ${renderUserError(error)}`,
				code: 'sync_failed',
				status: 502,
			};
		}
		if (authContext.user.status === 'disabled') {
			return { error: 'This account is disabled for this bot.', code: 'user_disabled', status: 400 };
		}
	}

	const scope = authContext ? workspaceStateScopeId(authContext.workspace.id) : conversationId;
	const state = withWorkspaceState(await getConversationState(env, scope), authContext);
	const agentId = buildTelegramAgentId(conversationId, state);
	return { profile, conversationId, authContext, state, agentId };
}

async function selectModel(
	env: MobileApiBindingEnv,
	request: MobileRequestContext,
	modelKey: TelegramModelKey,
): Promise<MobileStateDocument> {
	if (request.authContext) {
		await setWorkspaceModel(env, {
			workspaceId: request.authContext.workspace.id,
			userId: request.authContext.user.id,
			modelKey,
		});
	}

	return withWorkspaceState(
		await updateConversationState(env, stateScopeId(request), { modelKey }),
		request.authContext
			? {
					...request.authContext,
					workspace: {
						...request.authContext.workspace,
						defaultModelKey: modelKey,
						billingMode: modelKey === 'openai' ? 'byok' : 'platform',
					},
				}
			: undefined,
	);
}

function modelReadiness(
	state: TelegramAgentState,
	authContext: SyncedTelegramContext | undefined,
	convexConfigured: boolean,
): { error: string; code: string; status: 402 | 503 } | undefined {
	if (state.modelKey !== 'openai' && authContext?.workspace.plan === 'free') {
		return {
			error:
				'Platform-hosted models require an active workspace subscription. Subscribe from Billing, or attach your own OpenAI key.',
			code: 'billing_required',
			status: 402,
		};
	}
	if (state.modelKey === 'openai' && !authContext) {
		return {
			error: convexConfigured
				? 'OpenAI BYOK requires workspace sign-in.'
				: 'OpenAI BYOK requires Convex workspace sign-in. Configure CONVEX_URL first.',
			code: 'byok_requires_convex',
			status: 503,
		};
	}
	return undefined;
}

function withWorkspaceState(
	state: MobileStateDocument,
	authContext: SyncedTelegramContext | undefined,
): MobileStateDocument {
	if (!authContext) {
		return state;
	}
	return {
		...state,
		modelKey: authContext.workspace.defaultModelKey,
		workspaceId: authContext.workspace.id,
	};
}

function stateScopeId(request: MobileRequestContext): string {
	return request.authContext
		? workspaceStateScopeId(request.authContext.workspace.id)
		: request.conversationId;
}

function workspaceStateScopeId(workspaceId: string): string {
	return `workspace:${workspaceId}`;
}

async function getConversationState(
	env: MobileApiBindingEnv,
	conversationId: string,
): Promise<MobileStateDocument> {
	const stub = stateStore(env);
	if (!stub) {
		return { ...defaultTelegramAgentState(), updatedAt: new Date(0).toISOString() };
	}

	const response = await stub.fetch(stateRequest(conversationId));
	if (!response.ok) {
		throw new Error(`Unable to read bot state (${response.status}): ${await response.text()}`);
	}
	return parseStateDocument(await response.json());
}

async function updateConversationState(
	env: MobileApiBindingEnv,
	conversationId: string,
	patch: { modelKey?: TelegramModelKey; newSession?: boolean; workspaceId?: string | null },
): Promise<MobileStateDocument> {
	const stub = stateStore(env);
	if (!stub) {
		throw new Error('TELEGRAM_BOT_STATE Durable Object binding is not configured.');
	}

	const response = await stub.fetch(
		stateRequest(conversationId, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(patch),
		}),
	);
	if (!response.ok) {
		throw new Error(`Unable to update bot state (${response.status}): ${await response.text()}`);
	}
	return parseStateDocument(await response.json());
}

function parseStateDocument(value: unknown): MobileStateDocument {
	const record = (value ?? {}) as Partial<MobileStateDocument>;
	if (typeof record.sessionId !== 'string' || !isTelegramModelKey(record.modelKey ?? '')) {
		throw new Error('Received an invalid bot state document.');
	}
	return {
		sessionId: record.sessionId,
		modelKey: record.modelKey as TelegramModelKey,
		...(typeof record.workspaceId === 'string' ? { workspaceId: record.workspaceId } : {}),
		updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date(0).toISOString(),
	};
}

function stateStore(env: MobileApiBindingEnv): DurableObjectStub | undefined {
	return env.TELEGRAM_BOT_STATE?.getByName('default');
}

function stateRequest(conversationId: string, init?: RequestInit): Request {
	return new Request(
		`https://telegram-bot-state/state?conversationId=${encodeURIComponent(conversationId)}`,
		init,
	);
}

async function readCodexStatus(
	env: MobileApiBindingEnv,
): Promise<{ configured: boolean; expiresAt?: string; updatedAt?: string }> {
	if (!env.CODEX_AUTH_VAULT) {
		throw new Error('CODEX_AUTH_VAULT Durable Object binding is not configured.');
	}
	const response = await env.CODEX_AUTH_VAULT.getByName('default').fetch(
		new Request('https://codex-auth-vault/status'),
	);
	if (!response.ok) {
		throw new Error(`Unable to read Codex auth status (${response.status}): ${await response.text()}`);
	}
	return (await response.json()) as { configured: boolean; expiresAt?: string; updatedAt?: string };
}

async function startCodexDeviceLogin(env: MobileApiBindingEnv): Promise<{
	state: string;
	userCode: string;
	verificationUri: string;
	intervalSeconds: number;
	expiresAt: string;
}> {
	if (!env.CODEX_AUTH_VAULT) {
		throw new Error('CODEX_AUTH_VAULT Durable Object binding is not configured.');
	}
	if (!env.CODEX_AUTH_ADMIN_TOKEN) {
		throw new Error('CODEX_AUTH_ADMIN_TOKEN is not configured.');
	}

	const response = await env.CODEX_AUTH_VAULT.getByName('default').fetch(
		new Request('https://codex-auth-vault/oauth/device/start', {
			method: 'POST',
			headers: { authorization: `Bearer ${env.CODEX_AUTH_ADMIN_TOKEN}` },
		}),
	);
	if (!response.ok) {
		throw new Error(`Unable to start Codex login (${response.status}): ${await response.text()}`);
	}
	return (await response.json()) as {
		state: string;
		userCode: string;
		verificationUri: string;
		intervalSeconds: number;
		expiresAt: string;
	};
}

async function readTeachingPageList(
	env: MobileApiBindingEnv,
	shareId: string,
): Promise<Array<Omit<TeachingPageRecord, 'body'>>> {
	const stub = teachingPageStore(env, shareId);
	const response = await stub.fetch(new Request('https://lesson-page-store/index'));
	if (!response.ok) {
		throw new Error(`Unable to read teaching page index (${response.status}): ${await response.text()}`);
	}
	const index = (await response.json()) as { pages: Array<Omit<TeachingPageRecord, 'body'>> };
	return index.pages;
}

function modelCatalog(currentModelKey: TelegramModelKey): Array<{
	key: TelegramModelKey;
	label: string;
	specifier: string;
	note?: string;
	requiresWorkspaceCredential?: 'openai';
	current: boolean;
}> {
	return Object.values(TELEGRAM_MODEL_OPTIONS).map((option) => ({
		key: option.key,
		label: option.label,
		specifier: option.specifier,
		...(option.note ? { note: option.note } : {}),
		...(option.requiresWorkspaceCredential
			? { requiresWorkspaceCredential: option.requiresWorkspaceCredential }
			: {}),
		current: option.key === currentModelKey,
	}));
}

function publicState(state: MobileStateDocument): {
	sessionId: string;
	modelKey: TelegramModelKey;
	modelLabel: string;
	workspaceId?: string;
} {
	return {
		sessionId: state.sessionId,
		modelKey: state.modelKey,
		modelLabel: TELEGRAM_MODEL_OPTIONS[state.modelKey].label,
		...(state.workspaceId ? { workspaceId: state.workspaceId } : {}),
	};
}

function parseProfile(value: unknown): MobileProfile | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const id = typeof record.id === 'string' ? record.id.trim() : '';
	const firstName = typeof record.firstName === 'string' ? record.firstName.trim() : '';
	if (!/^[0-9]{1,20}$/.test(id) || !firstName) {
		return undefined;
	}
	return {
		id,
		firstName,
		...(typeof record.lastName === 'string' && record.lastName.trim()
			? { lastName: record.lastName.trim() }
			: {}),
		...(typeof record.username === 'string' && record.username.trim()
			? { username: record.username.trim() }
			: {}),
	};
}

function inviteCode(): string {
	const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

function convexRequiredMessage(): string {
	return 'Convex is not configured for this Worker yet. Set CONVEX_URL and deploy the Convex schema/functions to enable signed-in users and study workspaces.';
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
	try {
		const parsed = (await request.json()) as unknown;
		return typeof parsed === 'object' && parsed !== null
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}
