/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * This file was added before the Convex deployment was linked locally. Run
 * `npx convex dev` after configuring Convex to regenerate it.
 */

import { anyApi, componentsGeneric } from 'convex/server';
import type { ApiFromModules, FilterApi, FunctionReference } from 'convex/server';
import type { ComponentApi as PolarComponentApi } from '@convex-dev/polar/_generated/component.js';
import type * as polar from '../polar.js';
import type * as telegram from '../telegram.js';

const fullApi: ApiFromModules<{
	polar: typeof polar;
	telegram: typeof telegram;
}> = anyApi as any;

export const api: FilterApi<typeof fullApi, FunctionReference<any, 'public'>> =
	anyApi as any;
export const internal: FilterApi<typeof fullApi, FunctionReference<any, 'internal'>> =
	anyApi as any;
export const components = componentsGeneric() as unknown as {
	polar: PolarComponentApi;
};
