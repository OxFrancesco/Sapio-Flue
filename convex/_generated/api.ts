/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * This file was added before the Convex deployment was linked locally. Run
 * `npx convex dev` after configuring Convex to regenerate it.
 */

import { anyApi } from 'convex/server';
import type { ApiFromModules, FilterApi, FunctionReference } from 'convex/server';
import type * as telegram from '../telegram.js';

const fullApi: ApiFromModules<{
	telegram: typeof telegram;
}> = anyApi as any;

export const api: FilterApi<typeof fullApi, FunctionReference<any, 'public'>> =
	anyApi as any;
export const internal: FilterApi<typeof fullApi, FunctionReference<any, 'internal'>> =
	anyApi as any;
