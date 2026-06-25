import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

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
const inviteStatus = v.union(v.literal('active'), v.literal('revoked'));
const credentialProvider = v.union(v.literal('openai'));
const credentialStatus = v.union(v.literal('active'), v.literal('revoked'));
const billingProvider = v.union(v.literal('stripe'));
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

export default defineSchema({
	users: defineTable({
		primaryTelegramUserId: v.string(),
		displayName: v.string(),
		username: v.optional(v.string()),
		locale: v.optional(v.string()),
		status: userStatus,
		plan,
		createdAt: v.string(),
		updatedAt: v.string(),
	}).index('by_primary_telegram_user', ['primaryTelegramUserId']),

	telegramIdentities: defineTable({
		userId: v.id('users'),
		telegramUserId: v.string(),
		isBot: v.boolean(),
		firstName: v.string(),
		lastName: v.optional(v.string()),
		username: v.optional(v.string()),
		languageCode: v.optional(v.string()),
		createdAt: v.string(),
		updatedAt: v.string(),
	})
		.index('by_telegram_user', ['telegramUserId'])
		.index('by_user', ['userId']),

	workspaces: defineTable({
		name: v.string(),
		ownerUserId: v.id('users'),
		kind: workspaceKind,
		plan,
		billingMode,
		defaultModelKey: telegramModelKey,
		personalUserId: v.optional(v.id('users')),
		telegramChatId: v.optional(v.string()),
		conversationId: v.optional(v.string()),
		createdAt: v.string(),
		updatedAt: v.string(),
	})
		.index('by_owner', ['ownerUserId'])
		.index('by_personal_user', ['personalUserId'])
		.index('by_conversation', ['conversationId']),

	workspaceMembers: defineTable({
		workspaceId: v.id('workspaces'),
		userId: v.id('users'),
		role: workspaceRole,
		status: membershipStatus,
		createdAt: v.string(),
		updatedAt: v.string(),
	})
		.index('by_workspace', ['workspaceId'])
		.index('by_user', ['userId'])
		.index('by_workspace_and_user', ['workspaceId', 'userId']),

	workspaceInvites: defineTable({
		workspaceId: v.id('workspaces'),
		code: v.string(),
		createdByUserId: v.id('users'),
		status: inviteStatus,
		expiresAt: v.optional(v.string()),
		createdAt: v.string(),
		updatedAt: v.string(),
	})
		.index('by_code', ['code'])
		.index('by_workspace', ['workspaceId']),

	modelCredentials: defineTable({
		workspaceId: v.id('workspaces'),
		provider: credentialProvider,
		modelId: v.string(),
		vaultKey: v.string(),
		status: credentialStatus,
		createdByUserId: v.id('users'),
		createdAt: v.string(),
		updatedAt: v.string(),
	})
		.index('by_workspace', ['workspaceId'])
		.index('by_workspace_and_provider', ['workspaceId', 'provider']),

	billingSubscriptions: defineTable({
		workspaceId: v.id('workspaces'),
		provider: billingProvider,
		providerCustomerId: v.optional(v.string()),
		providerSubscriptionId: v.string(),
		plan,
		status: billingStatus,
		currentPeriodEnd: v.optional(v.string()),
		cancelAtPeriodEnd: v.optional(v.boolean()),
		createdAt: v.string(),
		updatedAt: v.string(),
	})
		.index('by_workspace', ['workspaceId'])
		.index('by_provider_subscription', ['provider', 'providerSubscriptionId']),

	billingEvents: defineTable({
		provider: billingProvider,
		eventId: v.string(),
		eventType: v.string(),
		workspaceId: v.optional(v.id('workspaces')),
		processedAt: v.string(),
	})
		.index('by_provider_event', ['provider', 'eventId'])
		.index('by_workspace', ['workspaceId']),
});
