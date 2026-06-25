import { timingSafeEqual } from 'node:crypto';

const DEFAULT_UPSTREAM_BASE_URL = 'https://chatgpt.com/backend-api';
const RELAY_TOKEN_HEADER = 'x-codex-relay-token';
const HOP_BY_HOP_HEADERS = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
]);

export default {
	async fetch(request: Request): Promise<Response> {
		if (request.method !== 'POST') {
			return textResponse(404, 'not found\n');
		}

		const relayToken = process.env.CODEX_RELAY_TOKEN;
		if (!relayToken) {
			return textResponse(500, 'relay token is not configured\n');
		}
		if (!isAuthorized(request.headers, relayToken)) {
			return textResponse(401, 'unauthorized\n');
		}
		if (!hasBearerAuthorization(request.headers)) {
			return textResponse(400, 'missing Codex authorization\n');
		}

		const maxBodyBytes = readPositiveIntegerEnv('CODEX_RELAY_MAX_BODY_BYTES', 4.5 * 1024 * 1024);
		const requestBody = await request.arrayBuffer();
		if (requestBody.byteLength > maxBodyBytes) {
			return textResponse(413, 'request body too large\n');
		}

		const upstreamBaseUrl = normalizeBaseUrl(process.env.CODEX_UPSTREAM_BASE_URL ?? DEFAULT_UPSTREAM_BASE_URL);
		const requestUrl = new URL(request.url);
		const upstreamUrl = `${upstreamBaseUrl}/codex/responses${requestUrl.search}`;
		const upstreamResponse = await fetch(upstreamUrl, {
			method: 'POST',
			headers: forwardRequestHeaders(request.headers),
			body: requestBody,
			redirect: 'manual',
		});

		return new Response(upstreamResponse.body, {
			status: upstreamResponse.status,
			statusText: upstreamResponse.statusText,
			headers: forwardResponseHeaders(upstreamResponse.headers),
		});
	},
};

function forwardRequestHeaders(headers: Headers): Headers {
	const forwarded = new Headers();
	for (const [key, value] of headers.entries()) {
		const name = key.toLowerCase();
		if (HOP_BY_HOP_HEADERS.has(name) || name === 'host' || name === 'content-length' || name === RELAY_TOKEN_HEADER) {
			continue;
		}
		forwarded.set(key, value);
	}
	return forwarded;
}

function forwardResponseHeaders(headers: Headers): Headers {
	const forwarded = new Headers();
	for (const [key, value] of headers.entries()) {
		const name = key.toLowerCase();
		if (HOP_BY_HOP_HEADERS.has(name) || name === 'content-encoding' || name === 'content-length') {
			continue;
		}
		forwarded.set(key, value);
	}
	forwarded.set('cache-control', 'no-store');
	return forwarded;
}

function isAuthorized(headers: Headers, expectedToken: string): boolean {
	const actualToken = headers.get(RELAY_TOKEN_HEADER);
	if (!actualToken) {
		return false;
	}
	const actual = Buffer.from(actualToken);
	const expected = Buffer.from(expectedToken);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function hasBearerAuthorization(headers: Headers): boolean {
	const authorization = headers.get('authorization');
	return authorization !== null && authorization.startsWith('Bearer ');
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) {
		return fallback;
	}
	const parsed = Number.parseInt(raw, 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeBaseUrl(value: string): string {
	return value.trim().replace(/\/+$/, '');
}

function textResponse(status: number, body: string): Response {
	return new Response(body, {
		status,
		headers: {
			'cache-control': 'no-store',
			'content-type': 'text/plain; charset=utf-8',
		},
	});
}
