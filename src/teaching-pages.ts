import { defineTool } from '@flue/runtime';

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

interface TeachingPageToolsOptions {
	env: TeachingPageBindingEnv;
	agentId: string;
}

const PAGE_MAX_BYTES = 2 * 1024 * 1024;
const PAGE_KEY_PREFIX = 'page:';
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
			async execute({ path, content, title, contentType }) {
				const normalizedPath = normalizeTeachingPagePath(path);
				const resolvedContentType = cleanContentType(contentType, normalizedPath);
				assertReasonablePageSize(content);

				const shareId = await shareIdForAgentId(agentId);
				const response = await teachingPageStore(env, shareId).fetch(
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
				);
				if (!response.ok) {
					throw new Error(`Unable to publish teaching page (${response.status}): ${await response.text()}`);
				}

				const url = teachingPageUrl(env, shareId, normalizedPath);
				return JSON.stringify({
					url,
					indexUrl: teachingPageIndexUrl(env, shareId),
					path: normalizedPath,
					contentType: resolvedContentType,
				});
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
				const response = await teachingPageStore(env, shareId).fetch(
					new Request('https://lesson-page-store/index'),
				);
				if (!response.ok) {
					throw new Error(`Unable to list teaching pages (${response.status}): ${await response.text()}`);
				}

				const index = (await response.json()) as { pages: Array<Pick<TeachingPageRecord, 'path' | 'title' | 'contentType' | 'updatedAt'>> };
				return JSON.stringify({
					indexUrl: teachingPageIndexUrl(env, shareId),
					pages: index.pages.map((page) => ({
						...page,
						url: teachingPageUrl(env, shareId, page.path),
					})),
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
		throw new Error('LESSON_PAGE_STORE Durable Object binding is not configured.');
	}
	return env.LESSON_PAGE_STORE.getByName(shareId);
}

function assertReasonablePageSize(content: string): void {
	const bytes = new TextEncoder().encode(content).byteLength;
	if (bytes > PAGE_MAX_BYTES) {
		throw new Error(`Teaching page is too large (${bytes} bytes). Limit is ${PAGE_MAX_BYTES} bytes.`);
	}
}

function encodePath(path: string): string {
	return path.split('/').map(encodeURIComponent).join('/');
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
