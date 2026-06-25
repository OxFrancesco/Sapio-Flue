import {
	applyStripeBillingEvent,
	getBillingCheckoutContext,
	type ConvexBindingEnv,
	type SyncedWorkspace,
} from '../convex-client';

export interface StripeBillingBindingEnv extends ConvexBindingEnv {
	STRIPE_SECRET_KEY?: string;
	STRIPE_WEBHOOK_SECRET?: string;
	STRIPE_PRO_PRICE_ID?: string;
	STRIPE_TEAM_PRICE_ID?: string;
}

export type PaidWorkspacePlan = 'pro' | 'team';
type StripeBillingStatus =
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

interface StripeCheckoutSessionResponse {
	id: string;
	object: 'checkout.session';
	url?: string | null;
	customer?: string | null;
	subscription?: string | null;
}

interface StripeEvent {
	id: string;
	type: string;
	data?: {
		object?: Record<string, unknown>;
	};
}

export interface StripeCheckoutResult {
	sessionId: string;
	url: string;
	workspace: SyncedWorkspace;
	plan: PaidWorkspacePlan;
}

const STRIPE_CHECKOUT_SESSIONS_URL = 'https://api.stripe.com/v1/checkout/sessions';
const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export function isStripeBillingConfigured(env: StripeBillingBindingEnv): boolean {
	return Boolean(
		env.STRIPE_SECRET_KEY?.trim() &&
			env.STRIPE_WEBHOOK_SECRET?.trim() &&
			env.STRIPE_PRO_PRICE_ID?.trim() &&
			env.STRIPE_TEAM_PRICE_ID?.trim(),
	);
}

export async function createStripeCheckoutSession(
	env: StripeBillingBindingEnv,
	args: {
		workspaceId: string;
		userId: string;
		plan: PaidWorkspacePlan;
		successUrl: string;
		cancelUrl: string;
	},
): Promise<StripeCheckoutResult> {
	const secretKey = requiredEnv(env.STRIPE_SECRET_KEY, 'STRIPE_SECRET_KEY');
	const priceId = priceIdForPlan(env, args.plan);
	const context = await getBillingCheckoutContext(env, {
		workspaceId: args.workspaceId,
		userId: args.userId,
		plan: args.plan,
	});

	const body = new URLSearchParams({
		mode: 'subscription',
		success_url: args.successUrl,
		cancel_url: args.cancelUrl,
		client_reference_id: context.workspace.id,
		'line_items[0][price]': priceId,
		'line_items[0][quantity]': '1',
		'metadata[workspaceId]': context.workspace.id,
		'metadata[userId]': context.user.id,
		'metadata[plan]': args.plan,
		'subscription_data[metadata][workspaceId]': context.workspace.id,
		'subscription_data[metadata][userId]': context.user.id,
		'subscription_data[metadata][plan]': args.plan,
	});

	const response = await fetch(STRIPE_CHECKOUT_SESSIONS_URL, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${secretKey}`,
			'content-type': 'application/x-www-form-urlencoded',
		},
		body,
	});
	const json = (await response.json().catch(() => ({}))) as Partial<StripeCheckoutSessionResponse> & {
		error?: { message?: string };
	};
	if (!response.ok) {
		throw new Error(json.error?.message || `Stripe Checkout failed (${response.status}).`);
	}
	if (typeof json.id !== 'string' || typeof json.url !== 'string' || !json.url) {
		throw new Error('Stripe Checkout did not return a usable session URL.');
	}

	return {
		sessionId: json.id,
		url: json.url,
		workspace: context.workspace,
		plan: args.plan,
	};
}

export async function handleStripeWebhook(
	env: StripeBillingBindingEnv,
	body: string,
	signatureHeader: string | undefined,
): Promise<{ received: true; processed: boolean; reason?: string }> {
	const webhookSecret = requiredEnv(env.STRIPE_WEBHOOK_SECRET, 'STRIPE_WEBHOOK_SECRET');
	await verifyStripeSignature(body, signatureHeader, webhookSecret);

	const event = JSON.parse(body) as StripeEvent;
	const object = event.data?.object;
	if (!object || typeof event.id !== 'string' || typeof event.type !== 'string') {
		throw new Error('Stripe webhook payload is missing event data.');
	}

	const normalized = normalizeStripeBillingObject(event.type, object);
	if (!normalized) {
		return { received: true, processed: false, reason: 'ignored_event_type' };
	}
	if (!normalized.workspaceId || !normalized.plan || !normalized.subscriptionId) {
		return { received: true, processed: false, reason: 'missing_metadata' };
	}

	const result = await applyStripeBillingEvent(env, {
		eventId: event.id,
		eventType: event.type,
		workspaceId: normalized.workspaceId,
		plan: normalized.plan,
		status: normalized.status,
		customerId: normalized.customerId,
		subscriptionId: normalized.subscriptionId,
		currentPeriodEnd: normalized.currentPeriodEnd,
		cancelAtPeriodEnd: normalized.cancelAtPeriodEnd,
	});

	return { received: true, processed: result.processed };
}

function normalizeStripeBillingObject(
	eventType: string,
	object: Record<string, unknown>,
):
	| {
			workspaceId: string | undefined;
			plan: PaidWorkspacePlan | undefined;
			status: StripeBillingStatus;
			customerId?: string;
			subscriptionId: string | undefined;
			currentPeriodEnd?: string;
			cancelAtPeriodEnd?: boolean;
	  }
	| undefined {
	if (eventType === 'checkout.session.completed') {
		const metadata = metadataOf(object);
		return {
			workspaceId: metadata.workspaceId,
			plan: parsePaidPlan(metadata.plan),
			status: 'checkout_completed',
			customerId: cleanString(object.customer),
			subscriptionId: cleanString(object.subscription),
		};
	}

	if (eventType.startsWith('customer.subscription.')) {
		const metadata = metadataOf(object);
		return {
			workspaceId: metadata.workspaceId,
			plan: parsePaidPlan(metadata.plan),
			status: parseStripeSubscriptionStatus(cleanString(object.status)),
			customerId: cleanString(object.customer),
			subscriptionId: cleanString(object.id),
			currentPeriodEnd: unixTimestampToIso(object.current_period_end),
			cancelAtPeriodEnd:
				typeof object.cancel_at_period_end === 'boolean'
					? object.cancel_at_period_end
					: undefined,
		};
	}

	return undefined;
}

async function verifyStripeSignature(
	body: string,
	signatureHeader: string | undefined,
	secret: string,
): Promise<void> {
	if (!signatureHeader) {
		throw new Error('Missing Stripe-Signature header.');
	}

	const parsed = parseStripeSignatureHeader(signatureHeader);
	if (!parsed.timestamp || parsed.signatures.length === 0) {
		throw new Error('Stripe-Signature header is invalid.');
	}
	const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - parsed.timestamp);
	if (ageSeconds > STRIPE_SIGNATURE_TOLERANCE_SECONDS) {
		throw new Error('Stripe webhook signature timestamp is outside tolerance.');
	}

	const expected = await hmacSha256Hex(secret, `${parsed.timestamp}.${body}`);
	if (!parsed.signatures.some((signature) => constantTimeEqual(signature, expected))) {
		throw new Error('Stripe webhook signature verification failed.');
	}
}

function parseStripeSignatureHeader(header: string): { timestamp?: number; signatures: string[] } {
	const result: { timestamp?: number; signatures: string[] } = { signatures: [] };
	for (const part of header.split(',')) {
		const [key, value] = part.split('=', 2);
		if (key === 't') {
			const timestamp = Number(value);
			if (Number.isFinite(timestamp)) {
				result.timestamp = timestamp;
			}
		}
		if (key === 'v1' && value) {
			result.signatures.push(value);
		}
	}
	return result;
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
	return bytesToHex(new Uint8Array(signature));
}

function constantTimeEqual(left: string, right: string): boolean {
	const leftBytes = new TextEncoder().encode(left);
	const rightBytes = new TextEncoder().encode(right);
	if (leftBytes.length !== rightBytes.length) {
		return false;
	}
	let diff = 0;
	for (let index = 0; index < leftBytes.length; index += 1) {
		diff |= leftBytes[index] ^ rightBytes[index];
	}
	return diff === 0;
}

function priceIdForPlan(env: StripeBillingBindingEnv, plan: PaidWorkspacePlan): string {
	if (plan === 'team') {
		return requiredEnv(env.STRIPE_TEAM_PRICE_ID, 'STRIPE_TEAM_PRICE_ID');
	}
	return requiredEnv(env.STRIPE_PRO_PRICE_ID, 'STRIPE_PRO_PRICE_ID');
}

function requiredEnv(value: string | undefined, name: string): string {
	const cleaned = value?.trim();
	if (!cleaned) {
		throw new Error(`${name} is not configured.`);
	}
	return cleaned;
}

function metadataOf(object: Record<string, unknown>): Record<string, string | undefined> {
	const metadata = object.metadata;
	if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
		return {};
	}
	return metadata as Record<string, string | undefined>;
}

function parsePaidPlan(value: string | undefined): PaidWorkspacePlan | undefined {
	return value === 'pro' || value === 'team' ? value : undefined;
}

function parseStripeSubscriptionStatus(status: string | undefined): StripeBillingStatus {
	switch (status) {
		case 'active':
		case 'trialing':
		case 'incomplete':
		case 'incomplete_expired':
		case 'past_due':
		case 'canceled':
		case 'unpaid':
		case 'paused':
			return status;
		default:
			return 'unknown';
	}
}

function cleanString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function unixTimestampToIso(value: unknown): string | undefined {
	return typeof value === 'number' && Number.isFinite(value)
		? new Date(value * 1000).toISOString()
		: undefined;
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
