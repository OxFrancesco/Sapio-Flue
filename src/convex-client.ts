import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import type { TelegramModelKey } from './models';

export interface ConvexBindingEnv {
	CONVEX_URL?: string;
	CONVEX_SERVICE_TOKEN?: string;
	CONVEX_AUTH_TOKEN?: string;
}

export interface TelegramUserProfile {
	id: string;
	isBot: boolean;
	firstName: string;
	lastName?: string;
	username?: string;
	languageCode?: string;
}

export interface TelegramChatProfile {
	id: string;
	type: string;
	title?: string;
	username?: string;
	firstName?: string;
	lastName?: string;
}

export interface SyncedUser {
	id: string;
	displayName: string;
	username?: string;
	status: 'active' | 'disabled';
	plan: 'free' | 'pro' | 'team';
}

export interface SyncedWorkspace {
	id: string;
	name: string;
	kind: 'personal' | 'telegram_chat' | 'study_group';
	plan: 'free' | 'pro' | 'team';
	billingMode: 'platform' | 'byok';
	defaultModelKey: TelegramModelKey;
}

export interface SyncedMembership {
	id: string;
	role: 'owner' | 'admin' | 'member';
	status: 'active' | 'invited' | 'removed';
}

export interface SyncedTelegramContext {
	user: SyncedUser;
	workspace: SyncedWorkspace;
	membership: SyncedMembership;
}

export interface WorkspaceModelCredential {
	id: string;
	provider: 'openai';
	modelId: string;
	vaultKey: string;
	status: 'active' | 'revoked';
	updatedAt: string;
}

export interface BillingSubscription {
	id: string;
	provider: 'stripe' | 'polar';
	providerCustomerId?: string;
	providerSubscriptionId: string;
	plan: SyncedWorkspace['plan'];
	status:
		| 'active'
		| 'trialing'
		| 'incomplete'
		| 'incomplete_expired'
		| 'past_due'
		| 'canceled'
		| 'unpaid'
		| 'paused'
		| 'checkout_completed'
		| 'unknown';
	currentPeriodEnd?: string;
	cancelAtPeriodEnd?: boolean;
	updatedAt: string;
}

export interface WorkspaceModelConfig {
	workspace: SyncedWorkspace;
	openaiCredential: WorkspaceModelCredential | null;
	billingSubscription: BillingSubscription | null;
}

export interface WorkspaceDetails {
	workspace: SyncedWorkspace;
	membership: SyncedMembership;
	members: Array<{
		userId: string;
		displayName: string;
		username?: string;
		role: SyncedMembership['role'];
		status: SyncedMembership['status'];
	}>;
}

export interface WorkspaceInvite {
	code: string;
	workspace: SyncedWorkspace;
}

type ServiceArgs = { serviceToken?: string };

const syncTelegramContextRef = makeFunctionReference<
	'mutation',
	ServiceArgs & {
		telegramUser: TelegramUserProfile;
		telegramChat: TelegramChatProfile;
		conversationId: string;
		activeWorkspaceId?: string;
	},
	SyncedTelegramContext
>('telegram:syncTelegramContext');

const getWorkspaceModelConfigRef = makeFunctionReference<
	'query',
	ServiceArgs & { workspaceId: string },
	WorkspaceModelConfig | null
>('telegram:getWorkspaceModelConfig');

const setWorkspaceModelRef = makeFunctionReference<
	'mutation',
	ServiceArgs & { workspaceId: string; userId: string; modelKey: TelegramModelKey },
	SyncedWorkspace
>('telegram:setWorkspaceModel');

const setModelCredentialRef = makeFunctionReference<
	'mutation',
	ServiceArgs & {
		workspaceId: string;
		userId: string;
		provider: 'openai';
		modelId: string;
		vaultKey: string;
	},
	{ workspace: SyncedWorkspace; credential: WorkspaceModelCredential }
>('telegram:setModelCredential');

const createWorkspaceInviteRef = makeFunctionReference<
	'mutation',
	ServiceArgs & { workspaceId: string; userId: string; code: string },
	WorkspaceInvite
>('telegram:createWorkspaceInvite');

const joinWorkspaceInviteRef = makeFunctionReference<
	'mutation',
	ServiceArgs & { code: string; userId: string },
	{ workspace: SyncedWorkspace; membership: SyncedMembership }
>('telegram:joinWorkspaceInvite');

const getWorkspaceRef = makeFunctionReference<
	'query',
	ServiceArgs & { workspaceId: string; userId: string },
	WorkspaceDetails
>('telegram:getWorkspace');

const getBillingCheckoutContextRef = makeFunctionReference<
	'query',
	ServiceArgs & { workspaceId: string; userId: string; plan: 'pro' | 'team' },
	{
		user: SyncedUser;
		workspace: SyncedWorkspace;
		subscription: BillingSubscription | null;
		requestedPlan: 'pro' | 'team';
	}
>('telegram:getBillingCheckoutContext');

const createPolarCheckoutRef = makeFunctionReference<
	'action',
	ServiceArgs & {
		workspaceId: string;
		userId: string;
		plan: 'pro' | 'team';
		successUrl: string;
		cancelUrl: string;
	},
	{
		checkoutId: string;
		url: string;
		workspace: SyncedWorkspace;
		plan: 'pro' | 'team';
	}
>('polar:createCheckout');

export function isConvexConfigured(env: ConvexBindingEnv): boolean {
	return Boolean(env.CONVEX_URL?.trim());
}

export async function syncTelegramContext(
	env: ConvexBindingEnv,
	args: {
		telegramUser: TelegramUserProfile;
		telegramChat: TelegramChatProfile;
		conversationId: string;
		activeWorkspaceId?: string;
	},
): Promise<SyncedTelegramContext> {
	return convexClient(env).mutation(syncTelegramContextRef, withServiceToken(env, args));
}

export async function getWorkspaceModelConfig(
	env: ConvexBindingEnv,
	workspaceId: string,
): Promise<WorkspaceModelConfig | null> {
	return convexClient(env).query(
		getWorkspaceModelConfigRef,
		withServiceToken(env, { workspaceId }),
	);
}

export async function setWorkspaceModel(
	env: ConvexBindingEnv,
	args: { workspaceId: string; userId: string; modelKey: TelegramModelKey },
): Promise<SyncedWorkspace> {
	return convexClient(env).mutation(setWorkspaceModelRef, withServiceToken(env, args));
}

export async function setModelCredential(
	env: ConvexBindingEnv,
	args: {
		workspaceId: string;
		userId: string;
		provider: 'openai';
		modelId: string;
		vaultKey: string;
	},
): Promise<{ workspace: SyncedWorkspace; credential: WorkspaceModelCredential }> {
	return convexClient(env).mutation(setModelCredentialRef, withServiceToken(env, args));
}

export async function createWorkspaceInvite(
	env: ConvexBindingEnv,
	args: { workspaceId: string; userId: string; code: string },
): Promise<WorkspaceInvite> {
	return convexClient(env).mutation(createWorkspaceInviteRef, withServiceToken(env, args));
}

export async function joinWorkspaceInvite(
	env: ConvexBindingEnv,
	args: { code: string; userId: string },
): Promise<{ workspace: SyncedWorkspace; membership: SyncedMembership }> {
	return convexClient(env).mutation(joinWorkspaceInviteRef, withServiceToken(env, args));
}

export async function getWorkspace(
	env: ConvexBindingEnv,
	args: { workspaceId: string; userId: string },
): Promise<WorkspaceDetails> {
	return convexClient(env).query(getWorkspaceRef, withServiceToken(env, args));
}

export async function getBillingCheckoutContext(
	env: ConvexBindingEnv,
	args: { workspaceId: string; userId: string; plan: 'pro' | 'team' },
): Promise<{
	user: SyncedUser;
	workspace: SyncedWorkspace;
	subscription: BillingSubscription | null;
	requestedPlan: 'pro' | 'team';
}> {
	return convexClient(env).query(getBillingCheckoutContextRef, withServiceToken(env, args));
}

export async function createPolarCheckout(
	env: ConvexBindingEnv,
	args: {
		workspaceId: string;
		userId: string;
		plan: 'pro' | 'team';
		successUrl: string;
		cancelUrl: string;
	},
): Promise<{
	checkoutId: string;
	url: string;
	workspace: SyncedWorkspace;
	plan: 'pro' | 'team';
}> {
	return convexClient(env).action(createPolarCheckoutRef, withServiceToken(env, args));
}

function convexClient(env: ConvexBindingEnv): ConvexHttpClient {
	const url = env.CONVEX_URL?.trim();
	if (!url) {
		throw new Error('CONVEX_URL is not configured.');
	}
	return new ConvexHttpClient(url, { logger: false });
}

function withServiceToken<T extends object>(env: ConvexBindingEnv, args: T): T & ServiceArgs {
	const token = env.CONVEX_SERVICE_TOKEN?.trim() || env.CONVEX_AUTH_TOKEN?.trim();
	return token ? { ...args, serviceToken: token } : args;
}
