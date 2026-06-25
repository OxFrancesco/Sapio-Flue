/* eslint-disable */
/**
 * Generated data model types.
 *
 * This file was added before the Convex deployment was linked locally. Run
 * `npx convex dev` after configuring Convex to regenerate it.
 */

import type {
	DataModelFromSchemaDefinition,
	DocumentByName,
	SystemTableNames,
	TableNamesInDataModel,
} from 'convex/server';
import type { GenericId } from 'convex/values';
import schema from '../schema.js';

export type DataModel = DataModelFromSchemaDefinition<typeof schema>;
export type TableNames = TableNamesInDataModel<DataModel>;
export type Doc<TableName extends TableNames> = DocumentByName<DataModel, TableName>;
export type Id<TableName extends TableNames | SystemTableNames> = GenericId<TableName>;
