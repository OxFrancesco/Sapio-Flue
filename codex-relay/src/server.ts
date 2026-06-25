import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

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
type NodeFetchInit = RequestInit;

const relayToken = process.env.CODEX_RELAY_TOKEN;
const upstreamBaseUrl = normalizeBaseUrl(process.env.CODEX_UPSTREAM_BASE_URL ?? DEFAULT_UPSTREAM_BASE_URL);
const port = Number.parseInt(process.env.PORT ?? '8788', 10);
const maxBodyBytes = Number.parseInt(process.env.CODEX_RELAY_MAX_BODY_BYTES ?? `${25 * 1024 * 1024}`, 10);

if (!relayToken) {
	throw new Error('CODEX_RELAY_TOKEN is required.');
}
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
	throw new Error(`Invalid PORT: ${process.env.PORT}`);
}
if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0) {
	throw new Error(`Invalid CODEX_RELAY_MAX_BODY_BYTES: ${process.env.CODEX_RELAY_MAX_BODY_BYTES}`);
}

const server = createServer(async (req, res) => {
	const startedAt = Date.now();
	const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

	try {
		if (url.pathname === '/health') {
			writeText(res, 200, 'ok\n');
			return;
		}

		if (!isAuthorized(req.headers, relayToken)) {
			writeText(res, 401, 'unauthorized\n');
			return;
		}

		if (req.method !== 'POST' || url.pathname !== '/codex/responses') {
			writeText(res, 404, 'not found\n');
			return;
		}

		if (!hasBearerAuthorization(req.headers)) {
			writeText(res, 400, 'missing Codex authorization\n');
			return;
		}

		await forwardCodexRequest(req, res, url);
	} catch (error) {
		if (error instanceof RelayHttpError) {
			writeText(res, error.statusCode, error.responseBody);
			return;
		}
		const message = error instanceof Error ? error.message : 'unknown error';
		console.error('codex relay error', {
			method: req.method,
			pathname: url.pathname,
			durationMs: Date.now() - startedAt,
			error: message,
		});
		if (!res.headersSent) {
			writeText(res, 502, 'upstream request failed\n');
		} else {
			res.destroy(error instanceof Error ? error : undefined);
		}
	} finally {
		console.info('codex relay request', {
			method: req.method,
			pathname: url.pathname,
			statusCode: res.statusCode,
			durationMs: Date.now() - startedAt,
		});
	}
});

server.on('upgrade', (_req, socket) => {
	socket.write('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n');
	socket.destroy();
});

server.requestTimeout = 0;
server.headersTimeout = 65_000;

server.listen(port, () => {
	console.info(`Codex relay listening on :${port}`);
	console.info(`Forwarding Codex requests to ${upstreamBaseUrl}`);
});

async function forwardCodexRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
	const controller = new AbortController();
	res.on('close', () => {
		if (!res.writableEnded) {
			controller.abort();
		}
	});

	const upstreamUrl = `${upstreamBaseUrl}${url.pathname}${url.search}`;
	const requestBody = await readRequestBody(req);
	const init: NodeFetchInit = {
		method: req.method,
		headers: forwardRequestHeaders(req.headers),
		body: requestBody as unknown as BodyInit,
		redirect: 'manual',
		signal: controller.signal,
	};
	const response = await fetch(upstreamUrl, init);

	res.writeHead(response.status, response.statusText, forwardResponseHeaders(response.headers));
	if (!response.body) {
		res.end();
		return;
	}

	await new Promise<void>((resolve, reject) => {
		const body = Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>);
		body.on('error', reject);
		res.on('error', reject);
		res.on('finish', resolve);
		body.pipe(res);
	});
}

function forwardRequestHeaders(headers: IncomingHttpHeaders): Headers {
	const forwarded = new Headers();
	for (const [key, rawValue] of Object.entries(headers)) {
		const name = key.toLowerCase();
		if (HOP_BY_HOP_HEADERS.has(name) || name === 'host' || name === 'content-length' || name === RELAY_TOKEN_HEADER) {
			continue;
		}
		if (Array.isArray(rawValue)) {
			for (const value of rawValue) {
				forwarded.append(key, value);
			}
		} else if (typeof rawValue === 'string') {
			forwarded.set(key, rawValue);
		}
	}
	return forwarded;
}

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		totalBytes += buffer.byteLength;
		if (totalBytes > maxBodyBytes) {
			throw new RelayHttpError(413, 'request body too large\n');
		}
		chunks.push(buffer);
	}
	return Buffer.concat(chunks, totalBytes);
}

function forwardResponseHeaders(headers: Headers): Record<string, string | string[]> {
	const forwarded: Record<string, string | string[]> = {};
	for (const [key, value] of headers.entries()) {
		const name = key.toLowerCase();
		if (HOP_BY_HOP_HEADERS.has(name) || name === 'content-encoding' || name === 'content-length') {
			continue;
		}
		forwarded[key] = value;
	}
	forwarded['cache-control'] = 'no-store';
	return forwarded;
}

function isAuthorized(headers: IncomingHttpHeaders, expectedToken: string): boolean {
	const actualToken = readSingleHeader(headers, RELAY_TOKEN_HEADER);
	if (!actualToken) {
		return false;
	}
	const actual = Buffer.from(actualToken);
	const expected = Buffer.from(expectedToken);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function hasBearerAuthorization(headers: IncomingHttpHeaders): boolean {
	const authorization = readSingleHeader(headers, 'authorization');
	return typeof authorization === 'string' && authorization.startsWith('Bearer ');
}

function readSingleHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
	const value = headers[name];
	if (Array.isArray(value)) {
		return value[0];
	}
	return value;
}

function normalizeBaseUrl(value: string): string {
	return value.trim().replace(/\/+$/, '');
}

function writeText(res: ServerResponse, statusCode: number, body: string): void {
	res.writeHead(statusCode, {
		'cache-control': 'no-store',
		'content-type': 'text/plain; charset=utf-8',
	});
	res.end(body);
}

class RelayHttpError extends Error {
	constructor(
		readonly statusCode: number,
		readonly responseBody: string,
	) {
		super(responseBody.trim());
	}
}
