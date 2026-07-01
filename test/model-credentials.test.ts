import { describe, expect, it, vi } from 'vitest';
import { readWorkspaceModelApiKey } from '../src/model-credentials';

describe('workspace credential vault', () => {
	it('retries idempotent credential reads and decodes the response', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(new Response('temporary', { status: 503 }))
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						provider: 'openai',
						apiKey: 'sk-test-value',
						updatedAt: '2026-06-28T00:00:00.000Z',
					}),
					{ headers: { 'content-type': 'application/json' } },
				),
			);
		const env = {
			WORKSPACE_CREDENTIAL_VAULT: {
				getByName: () => ({ fetch }),
			} as unknown as DurableObjectNamespace,
		};

		await expect(readWorkspaceModelApiKey(env, 'vault-key')).resolves.toEqual({
			provider: 'openai',
			apiKey: 'sk-test-value',
			updatedAt: '2026-06-28T00:00:00.000Z',
		});
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});
