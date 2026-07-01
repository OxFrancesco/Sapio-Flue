import { describe, expect, it } from 'vitest';
import { isPolarBillingConfigured } from '../src/billing/polar';

describe('Polar billing helpers', () => {
	it('uses Convex configuration as the Worker billing gate', () => {
		expect(isPolarBillingConfigured({ CONVEX_URL: 'https://example.convex.cloud' })).toBe(true);
		expect(isPolarBillingConfigured({ CONVEX_URL: '   ' })).toBe(false);
	});
});
