/* eslint-disable */
/**
 * Generated utilities for implementing server-side Convex query and mutation functions.
 *
 * This file was added before the Convex deployment was linked locally. Run
 * `npx convex dev` after configuring Convex to regenerate it.
 */

import {
	actionGeneric,
	httpActionGeneric,
	internalActionGeneric,
	internalMutationGeneric,
	internalQueryGeneric,
	mutationGeneric,
	queryGeneric,
} from 'convex/server';
import type {
	ActionBuilder,
	GenericActionCtx,
	GenericDatabaseReader,
	GenericDatabaseWriter,
	GenericMutationCtx,
	GenericQueryCtx,
	HttpActionBuilder,
	MutationBuilder,
	QueryBuilder,
} from 'convex/server';
import type { DataModel } from './dataModel.js';

export const query: QueryBuilder<DataModel, 'public'> = queryGeneric;
export const internalQuery: QueryBuilder<DataModel, 'internal'> = internalQueryGeneric;
export const mutation: MutationBuilder<DataModel, 'public'> = mutationGeneric;
export const internalMutation: MutationBuilder<DataModel, 'internal'> = internalMutationGeneric;
export const action: ActionBuilder<DataModel, 'public'> = actionGeneric;
export const internalAction: ActionBuilder<DataModel, 'internal'> = internalActionGeneric;
export const httpAction: HttpActionBuilder = httpActionGeneric;

export type QueryCtx = GenericQueryCtx<DataModel>;
export type MutationCtx = GenericMutationCtx<DataModel>;
export type ActionCtx = GenericActionCtx<DataModel>;
export type DatabaseReader = GenericDatabaseReader<DataModel>;
export type DatabaseWriter = GenericDatabaseWriter<DataModel>;
