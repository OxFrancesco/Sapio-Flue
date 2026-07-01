import { Effect } from 'effect';
import {
	createPolarCheckout,
	type ConvexBindingEnv,
	type SyncedWorkspace,
} from '../convex-client';
import { BillingError } from '../effect/errors';
import { annotateFlow, runEffect } from '../effect/runtime';

export interface PolarBillingBindingEnv extends ConvexBindingEnv {}

export type PaidWorkspacePlan = 'pro' | 'team';

export interface PolarCheckoutResult {
	sessionId: string;
	url: string;
	workspace: SyncedWorkspace;
	plan: PaidWorkspacePlan;
}

export function isPolarBillingConfigured(env: PolarBillingBindingEnv): boolean {
	return Boolean(env.CONVEX_URL?.trim());
}

export async function createPolarCheckoutSession(
	env: PolarBillingBindingEnv,
	args: {
		workspaceId: string;
		userId: string;
		plan: PaidWorkspacePlan;
		successUrl: string;
		cancelUrl: string;
	},
): Promise<PolarCheckoutResult> {
	return runEffect(
		annotateFlow(
			Effect.gen(function* () {
				const checkout = yield* Effect.tryPromise({
					try: () =>
						createPolarCheckout(env, {
							workspaceId: args.workspaceId,
							userId: args.userId,
							plan: args.plan,
							successUrl: args.successUrl,
							cancelUrl: args.cancelUrl,
						}),
					catch: (cause) =>
						new BillingError({
							operation: 'convex.polar_checkout.create',
							message: 'Unable to create Polar Checkout link.',
							cause,
						}),
				});

				return {
					sessionId: checkout.checkoutId,
					url: checkout.url,
					workspace: checkout.workspace,
					plan: checkout.plan,
				};
			}),
			{
				workspaceId: args.workspaceId,
				userId: args.userId,
				plan: args.plan,
			},
		),
	);
}
