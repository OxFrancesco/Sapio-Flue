import { describe, expect, it } from 'vitest';
import {
	buildTelegramAgentId,
	type TelegramAgentState,
} from '../src/models';
import {
	normalizeTeachingPagePath,
	parseTeachingPageReference,
	resolveTeachingPageReference,
} from '../src/teaching-pages';

describe('teaching page references', () => {
	it('normalizes safe workspace paths', () => {
		expect(normalizeTeachingPagePath('/lessons/typescript/intro.html')).toBe('lessons/typescript/intro.html');
		expect(() => normalizeTeachingPagePath('../secrets.txt')).toThrow('must not contain');
		expect(() => normalizeTeachingPagePath('private/file.txt')).toThrow('must start with');
	});

	it('parses hosted page URLs and share ids', () => {
		expect(
			parseTeachingPageReference('https://example.com/teach/0123456789abcdef0123456789abcdef/lessons/a.html'),
		).toEqual({
			shareId: '0123456789abcdef0123456789abcdef',
			path: 'lessons/a.html',
			source: 'url',
		});
		expect(parseTeachingPageReference('0123456789ABCDEF0123456789ABCDEF')).toEqual({
			shareId: '0123456789abcdef0123456789abcdef',
			path: '',
			source: 'share-id',
		});
	});

	it('resolves same-conversation session references', async () => {
		const state: TelegramAgentState = { sessionId: 'main', modelKey: 'zai', workspaceId: 'workspace_1' };
		const currentAgentId = buildTelegramAgentId('telegram:chat:1', state);

		const resolved = await resolveTeachingPageReference({
			reference: 'lesson-two',
			currentAgentId,
			path: 'reference/notes.html',
		});

		expect(resolved).toMatchObject({
			source: 'session-id',
			sessionId: 'lesson-two',
			modelKey: 'zai',
			path: 'reference/notes.html',
		});
		expect(resolved.shareId).toMatch(/^[a-f0-9]{32}$/);
	});
});
