import { describe, expect, it } from 'vitest';
import { runEffect } from '../src/effect/runtime';
import {
	decodeUnknown,
	PolarCheckoutResultSchema,
	TelegramStateDocumentSchema,
} from '../src/effect/schemas';

describe('Effect schemas', () => {
	it('decodes Telegram state documents', async () => {
		const decoded = await runEffect(
			decodeUnknown(
				TelegramStateDocumentSchema,
				{
					sessionId: 'main',
					modelKey: 'zai',
					updatedAt: '2026-06-28T00:00:00.000Z',
				},
				'telegram state',
			),
		);

		expect(decoded).toEqual({
			sessionId: 'main',
			modelKey: 'zai',
			updatedAt: '2026-06-28T00:00:00.000Z',
		});
	});

	it('rejects malformed Polar checkout results with a typed decode error', async () => {
		await expect(
			runEffect(
				decodeUnknown(
					PolarCheckoutResultSchema,
					{ checkoutId: 123, url: 'https://checkout.polar.sh/session' },
					'polar checkout result',
				),
			),
		).rejects.toMatchObject({ _tag: 'DecodeError' });
	});
});
