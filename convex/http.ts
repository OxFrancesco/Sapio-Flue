import type { WebhookEventHandlers } from '@convex-dev/polar';
import type { Subscription } from '@polar-sh/sdk/models/components/subscription.js';
import { httpRouter } from 'convex/server';
import { internal } from './_generated/api';
import { polar } from './polar';

declare const process: { env: Record<string, string | undefined> };

type PolarHandlerContext = Parameters<NonNullable<WebhookEventHandlers['subscription.created']>>[0];
type PolarSubscriptionEvent = {
	type: string;
	timestamp: Date;
	data: Subscription;
};
type PaidPlan = 'pro' | 'team';
type BillingStatus =
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

const http = httpRouter();

polar.registerRoutes(http as any, {
	events: {
		'subscription.created': mirrorPolarSubscription,
		'subscription.updated': mirrorPolarSubscription,
		'subscription.active': mirrorPolarSubscription,
		'subscription.canceled': mirrorPolarSubscription,
		'subscription.revoked': mirrorPolarSubscription,
		'subscription.uncanceled': mirrorPolarSubscription,
		'subscription.past_due': mirrorPolarSubscription,
	},
});

export default http;

async function mirrorPolarSubscription(
	ctx: PolarHandlerContext,
	event: PolarSubscriptionEvent,
): Promise<void> {
	const subscription = event.data;
	const workspaceId =
		stringMetadata(subscription.metadata, 'workspaceId') ??
		cleanString(subscription.customer.externalId);
	const plan = planFromSubscription(subscription);

	if (!workspaceId || !plan) {
		console.warn('[polar:webhook] ignored subscription event without workspace plan metadata', {
			eventType: event.type,
			subscriptionId: subscription.id,
			productId: subscription.productId,
			hasWorkspaceId: Boolean(workspaceId),
			hasPlan: Boolean(plan),
		});
		return;
	}

	await ctx.runMutation(polar.component.lib.insertCustomer, {
		id: subscription.customerId,
		userId: workspaceId,
		metadata: { workspaceId },
	});

	await ctx.runMutation(internal.telegram.applyPolarBillingEvent, {
		eventId: polarEventId(event, subscription),
		eventType: event.type,
		workspaceId,
		plan,
		status: billingStatusFromPolar(subscription.status),
		customerId: subscription.customerId,
		subscriptionId: subscription.id,
		currentPeriodEnd: isoDate(subscription.currentPeriodEnd),
		cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
	});
}

function planFromSubscription(subscription: Subscription): PaidPlan | undefined {
	const metadataPlan = stringMetadata(subscription.metadata, 'plan');
	if (metadataPlan === 'pro' || metadataPlan === 'team') {
		return metadataPlan;
	}

	if (subscription.productId === process.env.POLAR_PRO_PRODUCT_ID?.trim()) {
		return 'pro';
	}
	if (subscription.productId === process.env.POLAR_TEAM_PRODUCT_ID?.trim()) {
		return 'team';
	}
	return undefined;
}

function billingStatusFromPolar(status: string): BillingStatus {
	switch (status) {
		case 'active':
		case 'trialing':
		case 'incomplete':
		case 'incomplete_expired':
		case 'past_due':
		case 'canceled':
		case 'unpaid':
			return status;
		default:
			return 'unknown';
	}
}

function polarEventId(event: PolarSubscriptionEvent, subscription: Subscription): string {
	const changedAt =
		isoDate(subscription.modifiedAt) ??
		isoDate(subscription.createdAt) ??
		isoDate(event.timestamp) ??
		'unknown';
	return `${event.type}:${subscription.id}:${changedAt}:${isoDate(event.timestamp) ?? 'unknown'}`;
}

function stringMetadata(
	metadata: Record<string, unknown> | undefined,
	key: string,
): string | undefined {
	return cleanString(metadata?.[key]);
}

function cleanString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isoDate(value: Date | null | undefined): string | undefined {
	return value instanceof Date && Number.isFinite(value.getTime())
		? value.toISOString()
		: undefined;
}
