import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { ExternalHttpError } from '../src/effect/errors';
import { retryIdempotent, runEffect } from '../src/effect/runtime';

describe('retryIdempotent', () => {
	it('retries transient HTTP errors and returns the eventual value', async () => {
		let attempts = 0;
		const program = retryIdempotent(
			Effect.sync(() => {
				attempts += 1;
				if (attempts < 3) {
					throw new ExternalHttpError({
						operation: 'read',
						status: 503,
						message: 'temporarily unavailable',
					});
				}
				return 'ok';
			}).pipe(
				Effect.catchAllDefect((defect) =>
					defect instanceof ExternalHttpError ? Effect.fail(defect) : Effect.die(defect),
				),
			),
		);

		await expect(runEffect(program)).resolves.toBe('ok');
		expect(attempts).toBe(3);
	});

	it('does not retry non-transient HTTP errors', async () => {
		let attempts = 0;
		const program = retryIdempotent(
			Effect.sync(() => {
				attempts += 1;
				throw new ExternalHttpError({
					operation: 'read',
					status: 400,
					message: 'bad request',
				});
			}).pipe(
				Effect.catchAllDefect((defect) =>
					defect instanceof ExternalHttpError ? Effect.fail(defect) : Effect.die(defect),
				),
			),
		);

		await expect(runEffect(program)).rejects.toMatchObject({ _tag: 'ExternalHttpError' });
		expect(attempts).toBe(1);
	});
});
