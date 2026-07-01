import { Polar } from '@convex-dev/polar';
import { PolarCore } from '@polar-sh/sdk/core.js';
import { checkoutsCreate } from '@polar-sh/sdk/funcs/checkoutsCreate.js';
import { ConvexError, v } from 'convex/values';
import { api, components } from './_generated/api';
import { action } from './_generated/server';
import type { DataModel } from './_generated/dataModel';

declare const process: { env: Record<string, string | undefined> };

const plan = v.union(v.literal('free'), v.literal('pro'), v.literal('team'));
const billingMode = v.union(v.literal('platform'), v.literal('byok'));
const telegramModelKey = v.union(v.literal('zai'), v.literal('codex'), v.literal('openai'));
const workspaceKind = v.union(
	v.literal('personal'),
	v.literal('telegram_chat'),
	v.literal('study_group'),
);

const serviceArgs = {
	serviceToken: v.optional(v.string()),
};

const workspaceSummary = v.object({
	id: v.id('workspaces'),
	name: v.string(),
	kind: workspaceKind,
	plan,
	billingMode,
	defaultModelKey: telegramModelKey,
});

export const polar = new Polar<DataModel, { pro: string; team: string }>(components.polar, {
	getUserInfo: async () => {
		throw new ConvexError('Use the Telegram workspace Polar actions instead.');
	},
	products: {
		pro: process.env.POLAR_PRO_PRODUCT_ID ?? '',
		team: process.env.POLAR_TEAM_PRODUCT_ID ?? '',
	},
});

export const createCheckout = action({
	args: {
		...serviceArgs,
		workspaceId: v.id('workspaces'),
		userId: v.id('users'),
		plan: v.union(v.literal('pro'), v.literal('team')),
		successUrl: v.string(),
		cancelUrl: v.string(),
	},
	returns: v.object({
		checkoutId: v.string(),
		url: v.string(),
		workspace: workspaceSummary,
		plan: v.union(v.literal('pro'), v.literal('team')),
	}),
	handler: async (ctx, args) => {
		const context = await ctx.runQuery(api.telegram.getBillingCheckoutContext, {
			serviceToken: args.serviceToken,
			workspaceId: args.workspaceId,
			userId: args.userId,
			plan: args.plan,
		});
		const productId = productIdForPlan(args.plan);
		const checkout = await checkoutsCreate(polarClient(), {
			allowDiscountCodes: true,
			products: [productId],
			externalCustomerId: context.workspace.id,
			customerName: context.workspace.name,
			successUrl: args.successUrl,
			returnUrl: args.cancelUrl,
			metadata: {
				workspaceId: context.workspace.id,
				userId: context.user.id,
				plan: args.plan,
			},
			customerMetadata: {
				workspaceId: context.workspace.id,
			},
		});

		if (!checkout.ok) {
			throw new ConvexError(polarErrorMessage(checkout.error));
		}
		if (!checkout.value.url) {
			throw new ConvexError('Polar Checkout did not return a checkout URL.');
		}

		return {
			checkoutId: checkout.value.id,
			url: checkout.value.url,
			workspace: context.workspace,
			plan: args.plan,
		};
	},
});

export const syncProducts = action({
	args: serviceArgs,
	returns: v.null(),
	handler: async (ctx, args) => {
		assertServiceToken(args.serviceToken);
		await polar.syncProducts(ctx);
		return null;
	},
});

function productIdForPlan(requestedPlan: 'pro' | 'team'): string {
	const name = requestedPlan === 'team' ? 'POLAR_TEAM_PRODUCT_ID' : 'POLAR_PRO_PRODUCT_ID';
	const value = process.env[name]?.trim();
	if (!value) {
		throw new ConvexError(`${name} is not configured in Convex.`);
	}
	return value;
}

function polarClient(): PolarCore {
	const accessToken = process.env.POLAR_ORGANIZATION_TOKEN?.trim();
	if (!accessToken) {
		throw new ConvexError('POLAR_ORGANIZATION_TOKEN is not configured in Convex.');
	}

	return new PolarCore({
		accessToken,
		server: polarServer(),
	});
}

function polarServer(): 'sandbox' | 'production' {
	return process.env.POLAR_SERVER === 'production' ? 'production' : 'sandbox';
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

function polarErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === 'object' && error && 'message' in error) {
		const message = (error as { message?: unknown }).message;
		if (typeof message === 'string' && message.trim()) {
			return message;
		}
	}
	return 'Polar Checkout failed.';
}
