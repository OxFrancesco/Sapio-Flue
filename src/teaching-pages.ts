import { defineTool } from '@flue/runtime';
import { Effect } from 'effect';
import { ConfigMissing, DecodeError, ExternalHttpError } from './effect/errors';
import { requireOkResponse, responseJson } from './effect/http';
import { annotateFlow, retryIdempotent, runEffect } from './effect/runtime';
import {
	decodeUnknown,
	InspectTeachingPageReferenceInputSchema,
	PublishTeachingPageInputSchema,
	TeachingPageIndexSchema,
	TeachingPageRecordSchema,
} from './effect/schemas';
import {
	buildTelegramAgentId,
	isTelegramModelKey,
	parseTelegramAgentId,
	type TelegramModelKey,
} from './models';

export interface TeachingPageBindingEnv {
	LESSON_PAGE_STORE?: DurableObjectNamespace;
	PUBLIC_BASE_URL?: string;
}

export interface TeachingPageRecord {
	path: string;
	title?: string;
	contentType: string;
	body: string;
	updatedAt: string;
}

export type TeachingPageReferenceSource = 'url' | 'share-id' | 'session-id';

export interface ResolvedTeachingPageReference {
	shareId: string;
	path: string;
	source: TeachingPageReferenceSource;
	sessionId?: string;
	modelKey?: TelegramModelKey;
}

interface TeachingPageToolsOptions {
	env: TeachingPageBindingEnv;
	agentId: string;
}

const PAGE_MAX_BYTES = 2 * 1024 * 1024;
const REFERENCE_BODY_MAX_CHARS = 120_000;
const PAGE_KEY_PREFIX = 'page:';
const SHARE_ID_PATTERN = /^[a-f0-9]{32}$/i;
const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const ALLOWED_ROOTS = new Set(['lessons', 'reference', 'assets']);

export function createTeachingPageTools({ env, agentId }: TeachingPageToolsOptions) {
	return [
		defineTool({
			name: 'publish_teaching_page',
			description:
				'Publish a generated teach-skill file to Cloudflare. Use this after creating or updating lessons/*.html, reference/*.html, or assets/* so the Telegram user can open the hosted page.',
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description:
							'Workspace-relative path, for example lessons/intro.html, reference/types.html, or assets/styles.css.',
						minLength: 1,
					},
					content: {
						type: 'string',
						description: 'Full text content of the file to host.',
						minLength: 1,
					},
					title: {
						type: 'string',
						description: 'Optional human-readable page title.',
					},
					contentType: {
						type: 'string',
						description: 'Optional MIME type. Inferred from path when omitted.',
					},
				},
				required: ['path', 'content'],
				additionalProperties: false,
			},
			async execute(input) {
				return runEffect(
					annotateFlow(
						Effect.gen(function* () {
							const { path, content, title, contentType } = yield* decodeUnknown(
								PublishTeachingPageInputSchema,
								input,
								'publish_teaching_page input',
							);
							const normalizedPath = yield* normalizeTeachingPagePathEffect(path);
							const resolvedContentType = cleanContentType(contentType, normalizedPath);
							yield* assertReasonablePageSizeEffect(content);

							const shareId = yield* Effect.tryPromise({
								try: () => shareIdForAgentId(agentId),
								catch: (cause) =>
									new DecodeError({
										source: 'teaching page share id',
										message: 'Unable to calculate teaching page share id.',
										cause,
									}),
							});
							const store = teachingPageStore(env, shareId);
							const response = yield* Effect.tryPromise({
								try: () =>
									store.fetch(
										new Request(`https://lesson-page-store/page?path=${encodeURIComponent(normalizedPath)}`, {
											method: 'PUT',
											headers: { 'content-type': 'application/json' },
											body: JSON.stringify({
												path: normalizedPath,
												body: content,
												title,
												contentType: resolvedContentType,
											}),
										}),
									),
								catch: (cause) =>
									new ExternalHttpError({
										operation: 'teaching_page.publish',
										status: 0,
										message: 'Unable to publish teaching page before receiving a response.',
										cause,
									}),
							});
							yield* requireOkResponse(
								response,
								'teaching_page.publish',
								'Unable to publish teaching page',
							);

							const url = teachingPageUrl(env, shareId, normalizedPath);
							return JSON.stringify({
								url,
								indexUrl: teachingPageIndexUrl(env, shareId),
								shareId,
								path: normalizedPath,
								contentType: resolvedContentType,
							});
						}),
						{ agentId },
					),
				);
			},
		}),
		defineTool({
			name: 'list_teaching_pages',
			description: 'List Cloudflare-hosted lesson, reference, and asset pages for this teaching session.',
			parameters: {
				type: 'object',
				properties: {},
				additionalProperties: false,
			},
			async execute() {
				const shareId = await shareIdForAgentId(agentId);
				const index = await readTeachingPageIndex(env, shareId);
				return JSON.stringify({
					source: 'current-session',
					shareId,
					indexUrl: teachingPageIndexUrl(env, shareId),
					pages: index.pages.map((page) => ({
						...page,
						url: teachingPageUrl(env, shareId, page.path),
					})),
				});
			},
		}),
		defineTool({
			name: 'inspect_teaching_page_reference',
			description:
				'Inspect a Cloudflare-hosted teaching page or page index that the user explicitly referenced. Accepts a /teach/<share-id> URL, a 32-character share id, or a session id from this Telegram conversation. Use this for pages from other sessions only when the user provides the reference.',
			parameters: {
				type: 'object',
				properties: {
					reference: {
						type: 'string',
						description:
							'The referenced teaching page/index URL, share id, or same-conversation session id provided by the user.',
						minLength: 1,
					},
					path: {
						type: 'string',
						description:
							'Optional workspace-relative page path to read when the reference is an index, share id, or session id.',
						minLength: 1,
					},
					modelKey: {
						type: 'string',
						enum: ['zai', 'codex', 'openai'],
						description:
							'Optional model key for resolving a same-conversation session id. Defaults to the current session model.',
					},
					includeContent: {
						type: 'boolean',
						description:
							'Set false to return only page metadata. Page URLs include content by default.',
					},
				},
				required: ['reference'],
				additionalProperties: false,
			},
			async execute(input) {
				const { reference, path, modelKey, includeContent } = await runEffect(
					decodeUnknown(
						InspectTeachingPageReferenceInputSchema,
						input,
						'inspect_teaching_page_reference input',
					),
				);
				const resolved = await resolveTeachingPageReference({
					reference,
					currentAgentId: agentId,
					path,
					modelKey,
				});

				if (!resolved.path) {
					const index = await readTeachingPageIndex(env, resolved.shareId);
					return JSON.stringify({
						source: resolved.source,
						sessionId: resolved.sessionId,
						modelKey: resolved.modelKey,
						shareId: resolved.shareId,
						indexUrl: teachingPageIndexUrl(env, resolved.shareId),
						pages: index.pages.map((page) => ({
							...page,
							url: teachingPageUrl(env, resolved.shareId, page.path),
						})),
					});
				}

				const page = await readTeachingPage(env, resolved.shareId, resolved.path);
				const shouldIncludeContent = includeContent !== false;
				const truncatedBody =
					shouldIncludeContent && page.body.length > REFERENCE_BODY_MAX_CHARS
						? page.body.slice(0, REFERENCE_BODY_MAX_CHARS)
						: page.body;

				return JSON.stringify({
					source: resolved.source,
					sessionId: resolved.sessionId,
					modelKey: resolved.modelKey,
					shareId: resolved.shareId,
					indexUrl: teachingPageIndexUrl(env, resolved.shareId),
					url: teachingPageUrl(env, resolved.shareId, page.path),
					path: page.path,
					title: page.title,
					contentType: page.contentType,
					updatedAt: page.updatedAt,
					...(shouldIncludeContent
						? {
								body: truncatedBody,
								truncated: page.body.length > REFERENCE_BODY_MAX_CHARS,
								totalChars: page.body.length,
							}
						: {}),
				});
			},
		}),
	];
}

export async function shareIdForAgentId(agentId: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(agentId));
	return bytesToHex(new Uint8Array(digest).slice(0, 16));
}

export function normalizeTeachingPagePath(path: string): string {
	const segments = path
		.trim()
		.replaceAll('\\', '/')
		.replace(/^\/+/, '')
		.split('/')
		.filter(Boolean);

	if (segments.length === 0) {
		throw new Error('Teaching page path is required.');
	}
	if (segments.some((segment) => segment === '.' || segment === '..')) {
		throw new Error('Teaching page path must not contain "." or ".." segments.');
	}
	if (!ALLOWED_ROOTS.has(segments[0])) {
		throw new Error('Teaching page path must start with lessons/, reference/, or assets/.');
	}

	const normalized = segments.join('/');
	if (normalized.length > 240) {
		throw new Error('Teaching page path is too long.');
	}
	return normalized;
}

export function teachingPageUrl(env: TeachingPageBindingEnv, shareId: string, path: string): string {
	return `${publicBaseUrl(env)}/teach/${encodeURIComponent(shareId)}/${encodePath(path)}`;
}

export function teachingPageIndexUrl(env: TeachingPageBindingEnv, shareId: string): string {
	return `${publicBaseUrl(env)}/teach/${encodeURIComponent(shareId)}`;
}

export function parseTeachingPagePathname(
	pathname: string,
): Pick<ResolvedTeachingPageReference, 'shareId' | 'path'> | undefined {
	const normalizedPathname = pathname.startsWith('/') ? pathname : `/${pathname}`;
	const prefix = '/teach/';
	if (!normalizedPathname.startsWith(prefix)) {
		return undefined;
	}

	const remainder = normalizedPathname.slice(prefix.length);
	const slashIndex = remainder.indexOf('/');
	const encodedShareId = slashIndex === -1 ? remainder : remainder.slice(0, slashIndex);
	const rawPath = slashIndex === -1 ? '' : remainder.slice(slashIndex + 1);
	const shareId = decodePathPart(encodedShareId);
	if (!shareId || !SHARE_ID_PATTERN.test(shareId)) {
		return undefined;
	}
	return {
		shareId: shareId.toLowerCase(),
		path: rawPath ? decodePath(rawPath) : '',
	};
}

export function parseTeachingPageReference(
	reference: string,
): Pick<ResolvedTeachingPageReference, 'shareId' | 'path' | 'source'> | undefined {
	const candidate = extractTeachingPageCandidate(reference);
	if (!candidate) {
		return undefined;
	}

	if (SHARE_ID_PATTERN.test(candidate)) {
		return {
			shareId: candidate.toLowerCase(),
			path: '',
			source: 'share-id',
		};
	}

	if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
		try {
			const parsed = parseTeachingPagePathname(new URL(candidate).pathname);
			return parsed ? { ...parsed, source: 'url' } : undefined;
		} catch {
			return undefined;
		}
	}

	const pathCandidate = candidate.startsWith('/teach/')
		? candidate
		: candidate.startsWith('teach/')
			? `/${candidate}`
			: undefined;

	if (!pathCandidate) {
		return undefined;
	}

	const parsed = parseTeachingPagePathname(pathWithoutQueryAndHash(pathCandidate));
	return parsed ? { ...parsed, source: 'url' } : undefined;
}

export async function resolveTeachingPageReference({
	reference,
	currentAgentId,
	path,
	modelKey,
}: {
	reference: unknown;
	currentAgentId: string;
	path?: unknown;
	modelKey?: unknown;
}): Promise<ResolvedTeachingPageReference> {
	if (typeof reference !== 'string' || !reference.trim()) {
		throw new Error('Teaching page reference is required.');
	}

	const parsed = parseTeachingPageReference(reference);
	const resolvedPath =
		typeof path === 'string' && path.trim()
			? normalizeTeachingPagePath(path)
			: parsed?.path
				? normalizeTeachingPagePath(parsed.path)
				: '';
	if (parsed) {
		return {
			...parsed,
			path: resolvedPath,
		};
	}

	const sessionId = reference.trim();
	if (!SESSION_ID_PATTERN.test(sessionId)) {
		throw new Error(
			'Teaching page reference must be a /teach URL, a 32-character share id, or a same-conversation session id.',
		);
	}

	const current = parseTelegramAgentId(currentAgentId);
	if (!current.state) {
		throw new Error('Session id references are only available for Telegram-backed teaching sessions.');
	}

	const resolvedModelKey = cleanReferencedModelKey(modelKey) ?? current.state.modelKey;
	const shareId = await shareIdForAgentId(
		buildTelegramAgentId(current.baseConversationId, {
			sessionId,
			modelKey: resolvedModelKey,
			...(current.state.workspaceId ? { workspaceId: current.state.workspaceId } : {}),
		}),
	);

	return {
		shareId,
		path: resolvedPath,
		source: 'session-id',
		sessionId,
		modelKey: resolvedModelKey,
	};
}

export function publicBaseUrl(env: TeachingPageBindingEnv): string {
	return (env.PUBLIC_BASE_URL ?? 'https://sapio-flue-teacher.oddofrancesco000.workers.dev').replace(/\/+$/, '');
}

export function contentTypeForPath(path: string): string {
	const lower = path.toLowerCase();
	if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html; charset=utf-8';
	if (lower.endsWith('.css')) return 'text/css; charset=utf-8';
	if (lower.endsWith('.js') || lower.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
	if (lower.endsWith('.json')) return 'application/json; charset=utf-8';
	if (lower.endsWith('.svg')) return 'image/svg+xml; charset=utf-8';
	if (lower.endsWith('.txt') || lower.endsWith('.md')) return 'text/plain; charset=utf-8';
	return 'application/octet-stream';
}

export function cleanContentType(value: unknown, path: string): string {
	if (typeof value !== 'string') {
		return contentTypeForPath(path);
	}

	const trimmed = value.trim();
	if (!trimmed || trimmed.includes('\r') || trimmed.includes('\n') || !trimmed.includes('/')) {
		return contentTypeForPath(path);
	}
	return trimmed;
}

export function pageStorageKey(path: string): string {
	return `${PAGE_KEY_PREFIX}${path}`;
}

export function pagePathFromStorageKey(key: string): string {
	return key.slice(PAGE_KEY_PREFIX.length);
}

export function isPageStorageKey(key: string): boolean {
	return key.startsWith(PAGE_KEY_PREFIX);
}

export function teachingPageStore(env: TeachingPageBindingEnv, shareId: string): DurableObjectStub {
	if (!env.LESSON_PAGE_STORE) {
		throw new ConfigMissing({
			name: 'LESSON_PAGE_STORE',
			message: 'LESSON_PAGE_STORE Durable Object binding is not configured.',
		});
	}
	return env.LESSON_PAGE_STORE.getByName(shareId);
}

async function readTeachingPageIndex(
	env: TeachingPageBindingEnv,
	shareId: string,
): Promise<{ pages: Array<Pick<TeachingPageRecord, 'path' | 'title' | 'contentType' | 'updatedAt'>> }> {
	const store = teachingPageStore(env, shareId);
	return runEffect(
		annotateFlow(
			retryIdempotent(
				Effect.gen(function* () {
					const response = yield* Effect.tryPromise({
						try: () => store.fetch(new Request('https://lesson-page-store/index')),
						catch: (cause) =>
							new ExternalHttpError({
								operation: 'teaching_page.index.read',
								status: 0,
								message: 'Unable to list teaching pages before receiving a response.',
								cause,
							}),
					});
					yield* requireOkResponse(response, 'teaching_page.index.read', 'Unable to list teaching pages');
					const index = yield* responseJson(response, TeachingPageIndexSchema, 'teaching page index');
					return { pages: Array.from(index.pages) };
				}),
			),
			{ shareId },
		),
	);
}

async function readTeachingPage(
	env: TeachingPageBindingEnv,
	shareId: string,
	path: string,
): Promise<TeachingPageRecord> {
	const store = teachingPageStore(env, shareId);
	return runEffect(
		annotateFlow(
			retryIdempotent(
				Effect.gen(function* () {
					const response = yield* Effect.tryPromise({
						try: () =>
							store.fetch(
								new Request(`https://lesson-page-store/page?path=${encodeURIComponent(path)}`),
							),
						catch: (cause) =>
							new ExternalHttpError({
								operation: 'teaching_page.read',
								status: 0,
								message: 'Unable to read teaching page before receiving a response.',
								cause,
							}),
					});
					yield* requireOkResponse(response, 'teaching_page.read', 'Unable to read teaching page');
					return yield* responseJson(response, TeachingPageRecordSchema, 'teaching page');
				}),
			),
			{ shareId, path },
		),
	);
}

function assertReasonablePageSize(content: string): void {
	const bytes = new TextEncoder().encode(content).byteLength;
	if (bytes > PAGE_MAX_BYTES) {
		throw new Error(`Teaching page is too large (${bytes} bytes). Limit is ${PAGE_MAX_BYTES} bytes.`);
	}
}

function normalizeTeachingPagePathEffect(path: string): Effect.Effect<string, DecodeError> {
	return Effect.try({
		try: () => normalizeTeachingPagePath(path),
		catch: (cause) =>
			new DecodeError({
				source: 'teaching page path',
				message: cause instanceof Error ? cause.message : String(cause),
				cause,
			}),
	});
}

function assertReasonablePageSizeEffect(content: string): Effect.Effect<void, DecodeError> {
	return Effect.try({
		try: () => assertReasonablePageSize(content),
		catch: (cause) =>
			new DecodeError({
				source: 'teaching page content',
				message: cause instanceof Error ? cause.message : String(cause),
				cause,
			}),
	});
}

function extractTeachingPageCandidate(reference: string): string {
	const trimmed = trimReferencePunctuation(reference.trim());
	const urlMatch = /https?:\/\/[^\s<>"']+/.exec(trimmed);
	if (urlMatch) {
		return trimReferencePunctuation(urlMatch[0]);
	}

	const pathMatch = /(?:^|\s)(\/?teach\/[^\s<>"']+)/.exec(trimmed);
	if (pathMatch?.[1]) {
		return trimReferencePunctuation(pathMatch[1]);
	}

	return trimmed;
}

function trimReferencePunctuation(value: string): string {
	return value.replace(/[)\].,!?;]+$/g, '');
}

function pathWithoutQueryAndHash(value: string): string {
	return value.split(/[?#]/, 1)[0];
}

function cleanReferencedModelKey(value: unknown): TelegramModelKey | undefined {
	if (typeof value !== 'string' || !value.trim()) {
		return undefined;
	}

	const trimmed = value.trim();
	if (!isTelegramModelKey(trimmed)) {
		throw new Error('modelKey must be "zai", "codex", or "openai".');
	}
	return trimmed;
}

function encodePath(path: string): string {
	return path.split('/').map(encodeURIComponent).join('/');
}

function decodePath(value: string): string {
	return value.split('/').map(decodePathPart).join('/');
}

function decodePathPart(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return '';
	}
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
