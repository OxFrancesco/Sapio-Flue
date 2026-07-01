import { describe, expect, it } from 'vitest';
import { ExternalHttpError, renderUserError } from '../src/effect/errors';

describe('renderUserError', () => {
	it('redacts common secret shapes from user-visible errors', () => {
		const message = renderUserError(
			new ExternalHttpError({
				operation: 'test',
				status: 401,
				message:
					'Failed with Bearer sk-proj_123456789abcdef and token 123456789:abcdefghijklmnopqrstuvwxyz',
				body: 'whsec_123456789abcdef',
			}),
		);

		expect(message).toContain('Bearer [redacted]');
		expect(message).toContain('[telegram-bot-token-redacted]');
		expect(message).toContain('whsec_[redacted]');
		expect(message).not.toContain('sk-proj_123456789abcdef');
		expect(message).not.toContain('abcdefghijklmnopqrstuvwxyz');
	});
});
