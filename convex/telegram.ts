import { ConvexError, v } from 'convex/values';
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';

declare const process: { env: Record<string, string | undefined> };

const userStatus = v.union(v.literal('active'), v.literal('disabled'));
const plan = v.union(v.literal('free'), v.literal('pro'), v.literal('team'));
const billingMode = v.union(v.literal('platform'), v.literal('byok'));
const telegramModelKey = v.union(v.literal('zai'), v.literal('codex'), v.literal('openai'));
const workspaceKind = v.union(
	v.literal('personal'),
	v.literal('telegram_chat'),
	v.literal('study_group'),
);
const workspaceRole = v.union(v.literal('owner'), v.literal('admin'), v.literal('member'));
const membershipStatus = v.union(v.literal('active'), v.literal('invited'), v.literal('removed'));
const credentialProvider = v.union(v.literal('openai'));
const billingStatus = v.union(
	v.literal('active'),
	v.literal('trialing'),
	v.literal('incomplete'),
	v.literal('incomplete_expired'),
	v.literal('past_due'),
	v.literal('canceled'),
	v.literal('unpaid'),
	v.literal('paused'),
	v.literal('checkout_completed'),
	v.literal('unknown'),
);

const serviceArgs = {
	serviceToken: v.optional(v.string()),
};

const telegramUser = v.object({
	id: v.string(),
	isBot: v.boolean(),
	firstName: v.string(),
	lastName: v.optional(v.string()),
	username: v.optional(v.string()),
	languageCode: v.optional(v.string()),
});

const telegramChat = v.object({
	id: v.string(),
	type: v.string(),
	title: v.optional(v.string()),
	username: v.optional(v.string()),
	firstName: v.optional(v.string()),
	lastName: v.optional(v.string()),
});

const userSummary = v.object({
	id: v.id('users'),
	displayName: v.string(),
	username: v.optional(v.string()),
	status: userStatus,
	plan,
});

const workspaceSummary = v.object({
	id: v.id('workspaces'),
	name: v.string(),
	kind: workspaceKind,
	plan,
	billingMode,
	defaultModelKey: telegramModelKey,
});

const membershipSummary = v.object({
	id: v.id('workspaceMembers'),
	role: workspaceRole,
	status: membershipStatus,
});

const modelCredentialSummary = v.object({
	id: v.id('modelCredentials'),
	provider: credentialProvider,
	modelId: v.string(),
	vaultKey: v.string(),
	status: v.union(v.literal('active'), v.literal('revoked')),
	updatedAt: v.string(),
});

const billingSubscriptionSummary = v.object({
	id: v.id('billingSubscriptions'),
	provider: v.literal('stripe'),
	providerCustomerId: v.optional(v.string()),
	providerSubscriptionId: v.string(),
	plan,
	status: billingStatus,
	currentPeriodEnd: v.optional(v.string()),
	cancelAtPeriodEnd: v.optional(v.boolean()),
	updatedAt: v.string(),
});

export const syncTelegramContext = mutation({
	args: {
		...serviceArgs,
		telegramUser,
		telegramChat,
		conversationId: v.string(),
		activeWorkspaceId: v.optional(v.string()),
	},
	returns: v.object({
		user: userSummary,
		workspace: workspaceSummary,
		membership: membershipSummary,
	}),
	handler: async (ctx, args) => {
		assertServiceToken(args.serviceToken);

		const now = new Date().toISOString();
		const user = await upsertTelegramUser(ctx, args.telegramUser, now);
		await upsertTelegramIdentity(ctx, user._id, args.telegramUser, now);

		const canonical = await upsertCanonicalWorkspace(
			ctx,
			user._id,
			args.telegramUser,
			args.telegramChat,
			args.conversationId,
			now,
		);
		const selected =
			(await selectableWorkspace(ctx, args.activeWorkspaceId, user._id)) ?? canonical;

		return {
			user: userToSummary(user),
			workspace: workspaceToSummary(selected.workspace),
			membership: membershipToSummary(selected.membership),
		};
	},
});

export const getWorkspaceModelConfig = query({
	args: {
		...serviceArgs,
		workspaceId: v.id('workspaces'),
	},
	returns: v.union(
		v.null(),
		v.object({
			workspace: workspaceSummary,
			openaiCredential: v.union(v.null(), modelCredentialSummary),
			billingSubscription: v.union(v.null(), billingSubscriptionSummary),
		}),
	),
	handler: async (ctx, args) => {
		assertServiceToken(args.serviceToken);

		const workspace = await ctx.db.get(args.workspaceId);
		if (!workspace) {
			return null;
		}

		return {
			workspace: workspaceToSummary(workspace),
			openaiCredential: credentialToSummary(
				await activeModelCredential(ctx, workspace._id, 'openai'),
			),
			billingSubscription: billingSubscriptionToSummary(
				await latestBillingSubscription(ctx, workspace._id),
			),
		};
	},
});

export const setWorkspaceModel = mutation({
	args: {
		...serviceArgs,
		workspaceId: v.id('workspaces'),
		userId: v.id('users'),
		modelKey: telegramModelKey,
	},
	returns: workspaceSummary,
	handler: async (ctx, args) => {
		assertServiceToken(args.serviceToken);
		const workspace = await requireManageableWorkspace(ctx, args.workspaceId, args.userId);
		if (args.modelKey !== 'openai' && workspace.plan === 'free') {
			throw new ConvexError('Upgrade this workspace or switch to OpenAI BYOK before using platform models.');
		}
		if (args.modelKey === 'openai') {
			const credential = await activeModelCredential(ctx, workspace._id, 'openai');
			if (!credential) {
				throw new ConvexError('Connect a workspace OpenAI key before selecting OpenAI BYOK.');
			}
		}

		await ctx.db.patch(workspace._id, {
			defaultModelKey: args.modelKey,
			billingMode: args.modelKey === 'openai' ? 'byok' : 'platform',
			updatedAt: new Date().toISOString(),
		});
		return workspaceToSummary(await requireWorkspace(ctx, workspace._id));
	},
});

export const setModelCredential = mutation({
	args: {
		...serviceArgs,
		workspaceId: v.id('workspaces'),
		userId: v.id('users'),
		provider: credentialProvider,
		modelId: v.string(),
		vaultKey: v.string(),
	},
	returns: v.object({
		workspace: workspaceSummary,
		credential: modelCredentialSummary,
	}),
	handler: async (ctx, args) => {
		assertServiceToken(args.serviceToken);
		const workspace = await requireManageableWorkspace(ctx, args.workspaceId, args.userId);
		const now = new Date().toISOString();
		const existing = await ctx.db
			.query('modelCredentials')
			.withIndex('by_workspace_and_provider', (q) =>
				q.eq('workspaceId', workspace._id).eq('provider', args.provider),
			)
			.first();

		const cleanedModelId = cleanModelId(args.modelId);
		if (existing) {
			await ctx.db.patch(existing._id, {
				modelId: cleanedModelId,
				vaultKey: args.vaultKey,
				status: 'active',
				updatedAt: now,
			});
		} else {
			await ctx.db.insert('modelCredentials', {
				workspaceId: workspace._id,
				provider: args.provider,
				modelId: cleanedModelId,
				vaultKey: args.vaultKey,
				status: 'active',
				createdByUserId: args.userId,
				createdAt: now,
				updatedAt: now,
			});
		}

		await ctx.db.patch(workspace._id, {
			defaultModelKey: 'openai',
			billingMode: 'byok',
			updatedAt: now,
		});

		const credential = await activeModelCredential(ctx, workspace._id, args.provider);
		if (!credential) {
			throw new ConvexError('Unable to load saved model credential.');
		}
		return {
			workspace: workspaceToSummary(await requireWorkspace(ctx, workspace._id)),
			credential: requiredCredentialToSummary(credential),
		};
	},
});

export const getBillingCheckoutContext = query({
	args: {
		...serviceArgs,
		workspaceId: v.id('workspaces'),
		userId: v.id('users'),
		plan: v.union(v.literal('pro'), v.literal('team')),
	},
	returns: v.object({
		user: userSummary,
		workspace: workspaceSummary,
		subscription: v.union(v.null(), billingSubscriptionSummary),
		requestedPlan: v.union(v.literal('pro'), v.literal('team')),
	}),
	handler: async (ctx, args) => {
		assertServiceToken(args.serviceToken);
		const membership = await requireActiveMembership(ctx, args.workspaceId, args.userId);
		if (membership.role !== 'owner' && membership.role !== 'admin') {
			throw new ConvexError('Only workspace owners and admins can manage billing.');
		}

		return {
			user: userToSummary(await requireUser(ctx, args.userId)),
			workspace: workspaceToSummary(await requireWorkspace(ctx, args.workspaceId)),
			subscription: billingSubscriptionToSummary(
				await latestBillingSubscription(ctx, args.workspaceId),
			),
			requestedPlan: args.plan,
		};
	},
});

export const applyStripeBillingEvent = mutation({
	args: {
		...serviceArgs,
		eventId: v.string(),
		eventType: v.string(),
		workspaceId: v.id('workspaces'),
		plan: v.union(v.literal('pro'), v.literal('team')),
		status: billingStatus,
		customerId: v.optional(v.string()),
		subscriptionId: v.string(),
		currentPeriodEnd: v.optional(v.string()),
		cancelAtPeriodEnd: v.optional(v.boolean()),
	},
	returns: v.object({
		processed: v.boolean(),
		workspace: workspaceSummary,
		subscription: billingSubscriptionSummary,
	}),
	handler: async (ctx, args) => {
		assertServiceToken(args.serviceToken);
		const existingEvent = await ctx.db
			.query('billingEvents')
			.withIndex('by_provider_event', (q) =>
				q.eq('provider', 'stripe').eq('eventId', args.eventId),
			)
			.unique();
		const existingSubscription = await stripeSubscription(ctx, args.subscriptionId);
		if (existingEvent && existingSubscription) {
			return {
				processed: false,
				workspace: workspaceToSummary(await requireWorkspace(ctx, args.workspaceId)),
				subscription: requiredBillingSubscriptionToSummary(existingSubscription),
			};
		}

		const now = new Date().toISOString();
		if (!existingEvent) {
			await ctx.db.insert('billingEvents', {
				provider: 'stripe',
				eventId: args.eventId,
				eventType: args.eventType,
				workspaceId: args.workspaceId,
				processedAt: now,
			});
		}

		const subscriptionPatch = {
			workspaceId: args.workspaceId,
			provider: 'stripe' as const,
			providerCustomerId: args.customerId,
			providerSubscriptionId: args.subscriptionId,
			plan: args.plan,
			status: args.status,
			currentPeriodEnd: args.currentPeriodEnd,
			cancelAtPeriodEnd: args.cancelAtPeriodEnd,
			updatedAt: now,
		};

		if (existingSubscription) {
			await ctx.db.patch(existingSubscription._id, subscriptionPatch);
		} else {
			await ctx.db.insert('billingSubscriptions', {
				...subscriptionPatch,
				createdAt: now,
			});
		}

		const paidPlan = isPaidBillingStatus(args.status) ? args.plan : 'free';
		await ctx.db.patch(args.workspaceId, {
			plan: paidPlan,
			updatedAt: now,
		});

		const subscription = await stripeSubscription(ctx, args.subscriptionId);
		if (!subscription) {
			throw new ConvexError('Unable to load saved billing subscription.');
		}
		return {
			processed: true,
			workspace: workspaceToSummary(await requireWorkspace(ctx, args.workspaceId)),
			subscription: requiredBillingSubscriptionToSummary(subscription),
		};
	},
});

export const createWorkspaceInvite = mutation({
	args: {
		...serviceArgs,
		workspaceId: v.id('workspaces'),
		userId: v.id('users'),
		code: v.string(),
	},
	returns: v.object({
		code: v.string(),
		workspace: workspaceSummary,
	}),
	handler: async (ctx, args) => {
		assertServiceToken(args.serviceToken);
		await requireActiveMembership(ctx, args.workspaceId, args.userId);
		const workspace = await requireWorkspace(ctx, args.workspaceId);
		const code = cleanInviteCode(args.code);
		const existing = await ctx.db
			.query('workspaceInvites')
			.withIndex('by_code', (q) => q.eq('code', code))
			.first();
		if (existing) {
			throw new ConvexError('Invite code collision. Please try again.');
		}

		const now = new Date().toISOString();
		await ctx.db.insert('workspaceInvites', {
			workspaceId: workspace._id,
			code,
			createdByUserId: args.userId,
			status: 'active',
			createdAt: now,
			updatedAt: now,
		});

		return { code, workspace: workspaceToSummary(workspace) };
	},
});

export const joinWorkspaceInvite = mutation({
	args: {
		...serviceArgs,
		code: v.string(),
		userId: v.id('users'),
	},
	returns: v.object({
		workspace: workspaceSummary,
		membership: membershipSummary,
	}),
	handler: async (ctx, args) => {
		assertServiceToken(args.serviceToken);
		const invite = await ctx.db
			.query('workspaceInvites')
			.withIndex('by_code', (q) => q.eq('code', cleanInviteCode(args.code)))
			.first();
		if (!invite || invite.status !== 'active') {
			throw new ConvexError('Workspace invite was not found or is no longer active.');
		}
		if (invite.expiresAt && invite.expiresAt <= new Date().toISOString()) {
			throw new ConvexError('Workspace invite has expired.');
		}

		const workspace = await requireWorkspace(ctx, invite.workspaceId);
		const membership = await ensureWorkspaceMember(
			ctx,
			workspace._id,
			args.userId,
			'member',
			new Date().toISOString(),
		);
		return {
			workspace: workspaceToSummary(workspace),
			membership: membershipToSummary(membership),
		};
	},
});

export const getWorkspace = query({
	args: {
		...serviceArgs,
		workspaceId: v.id('workspaces'),
		userId: v.id('users'),
	},
	returns: v.object({
		workspace: workspaceSummary,
		membership: membershipSummary,
		members: v.array(
			v.object({
				userId: v.id('users'),
				displayName: v.string(),
				username: v.optional(v.string()),
				role: workspaceRole,
				status: membershipStatus,
			}),
		),
	}),
	handler: async (ctx, args) => {
		assertServiceToken(args.serviceToken);
		const membership = await requireActiveMembership(ctx, args.workspaceId, args.userId);
		const workspace = await requireWorkspace(ctx, args.workspaceId);
		const members = await ctx.db
			.query('workspaceMembers')
			.withIndex('by_workspace', (q) => q.eq('workspaceId', args.workspaceId))
			.collect();
		const activeMembers = members.filter((member) => member.status === 'active');

		return {
			workspace: workspaceToSummary(workspace),
			membership: membershipToSummary(membership),
			members: await Promise.all(
				activeMembers.map(async (member) => {
					const user = await ctx.db.get(member.userId);
					return {
						userId: member.userId,
						displayName: user?.displayName ?? 'Unknown user',
						username: user?.username,
						role: member.role,
						status: member.status,
					};
				}),
			),
		};
	},
});

async function upsertTelegramUser(
	ctx: MutationCtx,
	profile: {
		id: string;
		firstName: string;
		lastName?: string;
		username?: string;
		languageCode?: string;
	},
	now: string,
): Promise<Doc<'users'>> {
	const displayName = telegramDisplayName(profile);
	const existing = await ctx.db
		.query('users')
		.withIndex('by_primary_telegram_user', (q) => q.eq('primaryTelegramUserId', profile.id))
		.unique();

	if (!existing) {
		const id = await ctx.db.insert('users', {
			primaryTelegramUserId: profile.id,
			displayName,
			username: cleanOptional(profile.username),
			locale: cleanOptional(profile.languageCode),
			status: 'active',
			plan: 'free',
			createdAt: now,
			updatedAt: now,
		});
		return await requireUser(ctx, id);
	}

	await ctx.db.patch(existing._id, {
		displayName,
		username: cleanOptional(profile.username),
		locale: cleanOptional(profile.languageCode),
		updatedAt: now,
	});
	return await requireUser(ctx, existing._id);
}

async function upsertTelegramIdentity(
	ctx: MutationCtx,
	userId: Id<'users'>,
	profile: {
		id: string;
		isBot: boolean;
		firstName: string;
		lastName?: string;
		username?: string;
		languageCode?: string;
	},
	now: string,
): Promise<void> {
	const existing = await ctx.db
		.query('telegramIdentities')
		.withIndex('by_telegram_user', (q) => q.eq('telegramUserId', profile.id))
		.unique();
	const document = {
		userId,
		telegramUserId: profile.id,
		isBot: profile.isBot,
		firstName: profile.firstName,
		lastName: cleanOptional(profile.lastName),
		username: cleanOptional(profile.username),
		languageCode: cleanOptional(profile.languageCode),
		updatedAt: now,
	};

	if (existing) {
		await ctx.db.patch(existing._id, document);
		return;
	}

	await ctx.db.insert('telegramIdentities', { ...document, createdAt: now });
}

async function upsertCanonicalWorkspace(
	ctx: MutationCtx,
	userId: Id<'users'>,
	userProfile: { firstName: string; lastName?: string; username?: string },
	chatProfile: {
		id: string;
		type: string;
		title?: string;
		username?: string;
		firstName?: string;
		lastName?: string;
	},
	conversationId: string,
	now: string,
): Promise<{ workspace: Doc<'workspaces'>; membership: Doc<'workspaceMembers'> }> {
	if (chatProfile.type === 'private') {
		return await upsertPersonalWorkspace(ctx, userId, telegramDisplayName(userProfile), now);
	}
	return await upsertChatWorkspace(ctx, userId, chatProfile, conversationId, now);
}

async function upsertPersonalWorkspace(
	ctx: MutationCtx,
	userId: Id<'users'>,
	displayName: string,
	now: string,
): Promise<{ workspace: Doc<'workspaces'>; membership: Doc<'workspaceMembers'> }> {
	const existing = await ctx.db
		.query('workspaces')
		.withIndex('by_personal_user', (q) => q.eq('personalUserId', userId))
		.unique();
	if (!existing) {
		const id = await ctx.db.insert('workspaces', {
			name: `${displayName}'s workspace`,
			ownerUserId: userId,
			kind: 'personal',
			plan: 'free',
			billingMode: 'platform',
			defaultModelKey: 'zai',
			personalUserId: userId,
			createdAt: now,
			updatedAt: now,
		});
		const workspace = await requireWorkspace(ctx, id);
		const membership = await ensureWorkspaceMember(ctx, id, userId, 'owner', now);
		return { workspace, membership };
	}

	const membership = await ensureWorkspaceMember(ctx, existing._id, userId, 'owner', now);
	return { workspace: existing, membership };
}

async function upsertChatWorkspace(
	ctx: MutationCtx,
	userId: Id<'users'>,
	chatProfile: {
		id: string;
		title?: string;
		username?: string;
		firstName?: string;
		lastName?: string;
	},
	conversationId: string,
	now: string,
): Promise<{ workspace: Doc<'workspaces'>; membership: Doc<'workspaceMembers'> }> {
	const name = telegramChatName(chatProfile);
	const existing = await ctx.db
		.query('workspaces')
		.withIndex('by_conversation', (q) => q.eq('conversationId', conversationId))
		.unique();

	if (!existing) {
		const id = await ctx.db.insert('workspaces', {
			name,
			ownerUserId: userId,
			kind: 'telegram_chat',
			plan: 'free',
			billingMode: 'platform',
			defaultModelKey: 'zai',
			telegramChatId: chatProfile.id,
			conversationId,
			createdAt: now,
			updatedAt: now,
		});
		const workspace = await requireWorkspace(ctx, id);
		const membership = await ensureWorkspaceMember(ctx, id, userId, 'owner', now);
		return { workspace, membership };
	}

	await ctx.db.patch(existing._id, {
		name,
		telegramChatId: chatProfile.id,
		updatedAt: now,
	});
	const workspace = await requireWorkspace(ctx, existing._id);
	const membership = await ensureWorkspaceMember(ctx, workspace._id, userId, 'member', now);
	return { workspace, membership };
}

async function selectableWorkspace(
	ctx: MutationCtx,
	workspaceId: string | undefined,
	userId: Id<'users'>,
): Promise<{ workspace: Doc<'workspaces'>; membership: Doc<'workspaceMembers'> } | undefined> {
	if (!workspaceId) {
		return undefined;
	}

	const workspace = await ctx.db.get(workspaceId as Id<'workspaces'>).catch(() => null);
	if (!workspace) {
		return undefined;
	}
	const membership = await activeMembership(ctx, workspace._id, userId);
	if (!membership) {
		return undefined;
	}
	return { workspace, membership };
}

async function ensureWorkspaceMember(
	ctx: MutationCtx,
	workspaceId: Id<'workspaces'>,
	userId: Id<'users'>,
	role: Doc<'workspaceMembers'>['role'],
	now: string,
): Promise<Doc<'workspaceMembers'>> {
	const existing = await ctx.db
		.query('workspaceMembers')
		.withIndex('by_workspace_and_user', (q) =>
			q.eq('workspaceId', workspaceId).eq('userId', userId),
		)
		.unique();

	if (!existing) {
		const id = await ctx.db.insert('workspaceMembers', {
			workspaceId,
			userId,
			role,
			status: 'active',
			createdAt: now,
			updatedAt: now,
		});
		return await requireWorkspaceMember(ctx, id);
	}

	if (existing.status !== 'active') {
		await ctx.db.patch(existing._id, { status: 'active', updatedAt: now });
		return await requireWorkspaceMember(ctx, existing._id);
	}
	return existing;
}

async function requireManageableWorkspace(
	ctx: MutationCtx,
	workspaceId: Id<'workspaces'>,
	userId: Id<'users'>,
): Promise<Doc<'workspaces'>> {
	const membership = await requireActiveMembership(ctx, workspaceId, userId);
	if (membership.role !== 'owner' && membership.role !== 'admin') {
		throw new ConvexError('Only workspace owners and admins can manage this setting.');
	}
	return await requireWorkspace(ctx, workspaceId);
}

async function requireActiveMembership(
	ctx: QueryCtx | MutationCtx,
	workspaceId: Id<'workspaces'>,
	userId: Id<'users'>,
): Promise<Doc<'workspaceMembers'>> {
	const membership = await activeMembership(ctx, workspaceId, userId);
	if (!membership) {
		throw new ConvexError('You are not an active member of this workspace.');
	}
	return membership;
}

async function activeMembership(
	ctx: QueryCtx | MutationCtx,
	workspaceId: Id<'workspaces'>,
	userId: Id<'users'>,
): Promise<Doc<'workspaceMembers'> | null> {
	const membership = await ctx.db
		.query('workspaceMembers')
		.withIndex('by_workspace_and_user', (q) =>
			q.eq('workspaceId', workspaceId).eq('userId', userId),
		)
		.unique();
	return membership?.status === 'active' ? membership : null;
}

async function activeModelCredential(
	ctx: QueryCtx | MutationCtx,
	workspaceId: Id<'workspaces'>,
	provider: Doc<'modelCredentials'>['provider'],
): Promise<Doc<'modelCredentials'> | null> {
	const credential = await ctx.db
		.query('modelCredentials')
		.withIndex('by_workspace_and_provider', (q) =>
			q.eq('workspaceId', workspaceId).eq('provider', provider),
		)
		.first();
	return credential?.status === 'active' ? credential : null;
}

async function latestBillingSubscription(
	ctx: QueryCtx | MutationCtx,
	workspaceId: Id<'workspaces'>,
): Promise<Doc<'billingSubscriptions'> | null> {
	return await ctx.db
		.query('billingSubscriptions')
		.withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
		.order('desc')
		.first();
}

async function stripeSubscription(
	ctx: QueryCtx | MutationCtx,
	subscriptionId: string,
): Promise<Doc<'billingSubscriptions'> | null> {
	return await ctx.db
		.query('billingSubscriptions')
		.withIndex('by_provider_subscription', (q) =>
			q.eq('provider', 'stripe').eq('providerSubscriptionId', subscriptionId),
		)
		.unique();
}

async function requireUser(ctx: QueryCtx | MutationCtx, id: Id<'users'>): Promise<Doc<'users'>> {
	const user = await ctx.db.get(id);
	if (!user) {
		throw new ConvexError('User was not found.');
	}
	return user;
}

async function requireWorkspace(
	ctx: QueryCtx | MutationCtx,
	id: Id<'workspaces'>,
): Promise<Doc<'workspaces'>> {
	const workspace = await ctx.db.get(id);
	if (!workspace) {
		throw new ConvexError('Workspace was not found.');
	}
	return workspace;
}

async function requireWorkspaceMember(
	ctx: QueryCtx | MutationCtx,
	id: Id<'workspaceMembers'>,
): Promise<Doc<'workspaceMembers'>> {
	const membership = await ctx.db.get(id);
	if (!membership) {
		throw new ConvexError('Workspace member was not found.');
	}
	return membership;
}

function assertServiceToken(serviceToken: string | undefined): void {
	const expected = process.env.TELEGRAM_WORKER_TOKEN;
	if (!expected) {
		throw new ConvexError('TELEGRAM_WORKER_TOKEN is not configured in Convex.');
	}
	if (serviceToken !== expected) {
		throw new ConvexError('Unauthorized Convex Worker call.');
	}
}

function userToSummary(user: Doc<'users'>) {
	return {
		id: user._id,
		displayName: user.displayName,
		username: user.username,
		status: user.status,
		plan: user.plan,
	};
}

function workspaceToSummary(workspace: Doc<'workspaces'>) {
	return {
		id: workspace._id,
		name: workspace.name,
		kind: workspace.kind,
		plan: workspace.plan,
		billingMode: workspace.billingMode,
		defaultModelKey: workspace.defaultModelKey,
	};
}

function membershipToSummary(membership: Doc<'workspaceMembers'>) {
	return {
		id: membership._id,
		role: membership.role,
		status: membership.status,
	};
}

function credentialToSummary(credential: Doc<'modelCredentials'> | null) {
	return credential ? requiredCredentialToSummary(credential) : null;
}

function requiredCredentialToSummary(credential: Doc<'modelCredentials'>) {
	return {
		id: credential._id,
		provider: credential.provider,
		modelId: credential.modelId,
		vaultKey: credential.vaultKey,
		status: credential.status,
		updatedAt: credential.updatedAt,
	};
}

function billingSubscriptionToSummary(subscription: Doc<'billingSubscriptions'> | null) {
	return subscription ? requiredBillingSubscriptionToSummary(subscription) : null;
}

function requiredBillingSubscriptionToSummary(subscription: Doc<'billingSubscriptions'>) {
	return {
		id: subscription._id,
		provider: subscription.provider,
		providerCustomerId: subscription.providerCustomerId,
		providerSubscriptionId: subscription.providerSubscriptionId,
		plan: subscription.plan,
		status: subscription.status,
		currentPeriodEnd: subscription.currentPeriodEnd,
		cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
		updatedAt: subscription.updatedAt,
	};
}

function isPaidBillingStatus(status: Doc<'billingSubscriptions'>['status']): boolean {
	return status === 'active' || status === 'trialing' || status === 'checkout_completed';
}

function telegramDisplayName(profile: {
	firstName: string;
	lastName?: string;
	username?: string;
	id?: string;
}): string {
	const names = [profile.firstName, profile.lastName].filter(Boolean).join(' ').trim();
	if (names) {
		return names;
	}
	if (profile.username) {
		return `@${profile.username}`;
	}
	return profile.id ? `Telegram ${profile.id}` : 'Telegram user';
}

function telegramChatName(chat: {
	id: string;
	title?: string;
	username?: string;
	firstName?: string;
	lastName?: string;
}): string {
	if (chat.title?.trim()) {
		return chat.title.trim();
	}
	if (chat.username?.trim()) {
		return `@${chat.username.trim()}`;
	}
	const directName = [chat.firstName, chat.lastName].filter(Boolean).join(' ').trim();
	return directName || `Telegram chat ${chat.id}`;
}

function cleanOptional(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function cleanModelId(value: string): string {
	const modelId = value.trim();
	if (!modelId || modelId.length > 120) {
		throw new ConvexError('Model id is invalid.');
	}
	return modelId;
}

function cleanInviteCode(value: string): string {
	const code = value.trim().toUpperCase();
	if (!/^[A-Z0-9-]{4,32}$/.test(code)) {
		throw new ConvexError('Invite code is invalid.');
	}
	return code;
}
