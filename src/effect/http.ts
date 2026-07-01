import { Effect, Schema } from 'effect';
import { DecodeError, ExternalHttpError, renderUserError } from './errors';
import { decodeUnknown } from './schemas';

export function responseJson<A, I, R>(
	response: Response,
	schema: Schema.Schema<A, I, R>,
	source: string,
): Effect.Effect<A, DecodeError, R> {
	return Effect.tryPromise({
		try: () => response.json(),
		catch: (cause) =>
			new DecodeError({
				source,
				message: `Unable to parse JSON from ${source}.`,
				cause,
			}),
	}).pipe(Effect.flatMap((json) => decodeUnknown(schema, json, source)));
}

export function requireOkResponse(
	response: Response,
	operation: string,
	defaultMessage: string,
): Effect.Effect<void, ExternalHttpError, never> {
	if (response.ok) {
		return Effect.void;
	}

	return Effect.promise(() => response.text().catch(() => '')).pipe(
		Effect.flatMap((body) =>
			Effect.fail(
				new ExternalHttpError({
					operation,
					status: response.status,
					body,
					message: `${defaultMessage} (${response.status}): ${renderUserError(body)}`,
				}),
			),
		),
	);
}
