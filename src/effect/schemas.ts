import { Effect, Schema } from 'effect';
import { DecodeError } from './errors';
import { runEffect } from './runtime';

export const TelegramModelKeySchema = Schema.Literal('zai', 'codex', 'openai');

export const TelegramStateDocumentSchema = Schema.Struct({
	sessionId: Schema.String,
	modelKey: TelegramModelKeySchema,
	workspaceId: Schema.optional(Schema.String),
	updatedAt: Schema.String,
});

export const TelegramReplyTargetResponseSchema = Schema.Struct({
	replyTargetId: Schema.String,
});

export const TelegramReplyTargetDocumentSchema = Schema.Struct({
	ref: Schema.Unknown,
});

export const TeachingPageMetadataSchema = Schema.Struct({
	path: Schema.String,
	title: Schema.optional(Schema.String),
	contentType: Schema.String,
	updatedAt: Schema.String,
});

export const TeachingPageRecordSchema = Schema.Struct({
	path: Schema.String,
	title: Schema.optional(Schema.String),
	contentType: Schema.String,
	body: Schema.String,
	updatedAt: Schema.String,
});

export const TeachingPageIndexSchema = Schema.Struct({
	pages: Schema.Array(TeachingPageMetadataSchema),
});

export const PublishTeachingPageInputSchema = Schema.Struct({
	path: Schema.String,
	content: Schema.String,
	title: Schema.optional(Schema.String),
	contentType: Schema.optional(Schema.String),
});

export const InspectTeachingPageReferenceInputSchema = Schema.Struct({
	reference: Schema.String,
	path: Schema.optional(Schema.String),
	modelKey: Schema.optional(TelegramModelKeySchema),
	includeContent: Schema.optional(Schema.Boolean),
});

export const PolarCheckoutResultSchema = Schema.Struct({
	checkoutId: Schema.String,
	url: Schema.String,
	workspace: Schema.Struct({
		id: Schema.String,
		name: Schema.String,
		kind: Schema.Literal('personal', 'telegram_chat', 'study_group'),
		plan: Schema.Literal('free', 'pro', 'team'),
		billingMode: Schema.Literal('platform', 'byok'),
		defaultModelKey: TelegramModelKeySchema,
	}),
	plan: Schema.Literal('pro', 'team'),
});

export const StoredCredentialResponseSchema = Schema.Struct({
	configured: Schema.Literal(true),
	provider: Schema.Literal('openai'),
	vaultKey: Schema.String,
	updatedAt: Schema.String,
	storage: Schema.Literal('durable-object', 'workos-vault'),
});

export const ReadCredentialResponseSchema = Schema.Struct({
	provider: Schema.Literal('openai'),
	apiKey: Schema.String,
	updatedAt: Schema.String,
});

export const CodexDeviceStartResponseSchema = Schema.Struct({
	state: Schema.String,
	userCode: Schema.String,
	verificationUri: Schema.String,
	intervalSeconds: Schema.Number,
	expiresAt: Schema.String,
});

export const CodexStatusResponseSchema = Schema.Struct({
	configured: Schema.Boolean,
	expiresAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
});

export function decodeUnknown<A, I, R>(
	schema: Schema.Schema<A, I, R>,
	value: unknown,
	source: string,
): Effect.Effect<A, DecodeError, R> {
	return Schema.decodeUnknown(schema)(value).pipe(
		Effect.mapError(
			(cause) =>
				new DecodeError({
					source,
					message: `Unable to decode ${source}.`,
					cause,
				}),
		),
	);
}

export async function decodeUnknownPromise<A, I, R>(
	schema: Schema.Schema<A, I, R>,
	value: unknown,
	source: string,
): Promise<A> {
	return runEffect(decodeUnknown(schema, value, source) as Effect.Effect<A, DecodeError, never>);
}
