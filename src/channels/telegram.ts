import { createTelegramChannel, type TelegramConversationRef } from '@flue/telegram';
import { defineTool, dispatch } from '@flue/runtime';
import { Api } from 'grammy';
import type { Message } from 'grammy/types';
import teacher from '../agents/teacher';
import {
	buildTelegramAgentId,
	defaultTelegramAgentState,
	describeTelegramModels,
	telegramModelFromAlias,
	TELEGRAM_MODEL_OPTIONS,
	type TelegramAgentState,
	type TelegramModelKey,
} from '../models';
import {
	resolveTeachingPageReference,
	type ResolvedTeachingPageReference,
	shareIdForAgentId,
	teachingPageIndexUrl,
	teachingPageUrl,
	type TeachingPageBindingEnv,
} from '../teaching-pages';

interface TelegramChannelBindings extends TeachingPageBindingEnv {
	TELEGRAM_BOT_STATE?: DurableObjectNamespace;
	TELEGRAM_ALLOWED_USER_IDS?: string;
}

export type TelegramTeacherInput =
	| {
			type: 'telegram.message';
			updateId: number;
			text: string;
			draftId?: number;
			message: Message;
	  }
	| {
			type: 'telegram.callback_query';
			updateId: number;
			data?: string;
			from: {
				id: number;
				is_bot: boolean;
				first_name: string;
				last_name?: string;
				username?: string;
				language_code?: string;
			};
	  };

export const client = new Api(requiredEnv('TELEGRAM_BOT_TOKEN'));

export const channel = createTelegramChannel<{ Bindings: TelegramChannelBindings }>({
	secretToken: requiredEnv('TELEGRAM_WEBHOOK_SECRET_TOKEN'),

	async webhook({ c, update }) {
		const incoming = update.message ?? update.channel_post ?? update.business_message;
		if (incoming) {
			const ref = conversationFromMessage(incoming);
			const conversationId = channel.conversationKey(ref);
			const senderId = incoming.from?.id;
			if (!isTelegramSenderAllowed(c.env, senderId)) {
				console.warn('[telegram:auth] ignored unauthorized message', {
					updateId: update.update_id,
					chatId: incoming.chat.id,
					senderId,
				});
				return;
			}

			const command = parseCommand(messageText(incoming));
			if (command) {
				await handleCommand(c.env, ref, conversationId, command, senderId);
				return;
			}

			const state = await getConversationState(c.env, conversationId);
			const agentId = buildTelegramAgentId(conversationId, state);
			const draftId = update.update_id || Date.now();
			const progressMode = await startTelegramProgress(ref, draftId);
			const receipt = await dispatch(teacher, {
				id: agentId,
				input: {
					type: 'telegram.message',
					updateId: update.update_id,
					text: messageText(incoming),
					...(progressMode === 'message_draft' ? { draftId } : {}),
					message: incoming,
				} satisfies TelegramTeacherInput,
			});
			console.log('[telegram:webhook] message dispatched', {
				updateId: update.update_id,
				chatId: incoming.chat.id,
				conversationId,
				agentId,
				modelKey: state.modelKey,
				sessionId: state.sessionId,
				progressMode,
				dispatchId: receipt.dispatchId,
			});
			return;
		}

		if (update.callback_query) {
			const query = update.callback_query;
			await client.answerCallbackQuery(query.id);
			if (!isTelegramSenderAllowed(c.env, query.from.id)) {
				console.warn('[telegram:auth] ignored unauthorized callback', {
					updateId: update.update_id,
					senderId: query.from.id,
				});
				return;
			}
			if (!query.message) return;

			const conversationId = channel.conversationKey(conversationFromMessage(query.message));
			const state = await getConversationState(c.env, conversationId);
			const agentId = buildTelegramAgentId(conversationId, state);
			const receipt = await dispatch(teacher, {
				id: agentId,
				input: {
					type: 'telegram.callback_query',
					updateId: update.update_id,
					data: query.data,
					from: query.from,
				} satisfies TelegramTeacherInput,
			});
			console.log('[telegram:webhook] callback dispatched', {
				updateId: update.update_id,
				chatId: query.message.chat.id,
				conversationId,
				agentId,
				modelKey: state.modelKey,
				sessionId: state.sessionId,
				dispatchId: receipt.dispatchId,
			});
		}
	},
});

interface BotCommand {
	name: string;
	args: string;
}

interface TelegramStateDocument extends TelegramAgentState {
	updatedAt: string;
}

async function handleCommand(
	env: TelegramChannelBindings,
	ref: TelegramConversationRef,
	conversationId: string,
	command: BotCommand,
	senderId: number | undefined,
): Promise<void> {
	if (command.name === 'whoami') {
		await sendText(ref, whoamiText(senderId));
		return;
	}

	if (command.name === 'start' || command.name === 'help') {
		await sendText(ref, helpText(await getConversationState(env, conversationId)));
		return;
	}

	if (command.name === 'session') {
		await sendText(ref, sessionText(await getConversationState(env, conversationId)));
		return;
	}

	if (command.name === 'pages') {
		const state = await getConversationState(env, conversationId);
		try {
			await sendText(ref, await pagesText(env, conversationId, state, command.args));
		} catch (error) {
			await sendText(
				ref,
				`Unable to resolve page reference: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return;
	}

	if (command.name === 'new') {
		const model = command.args ? telegramModelFromAlias(command.args) : undefined;
		if (command.args && !model) {
			await sendText(ref, unknownModelText(command.args));
			return;
		}

		const state = await updateConversationState(env, conversationId, {
			newSession: true,
			...(model ? { modelKey: model.key } : {}),
		});
		await sendText(
			ref,
			`Started a new session: ${state.sessionId}\nModel: ${TELEGRAM_MODEL_OPTIONS[state.modelKey].label}`,
		);
		return;
	}

	if (command.name === 'model') {
		if (!command.args) {
			await sendText(ref, modelText(await getConversationState(env, conversationId)));
			return;
		}

		const model = telegramModelFromAlias(command.args);
		if (!model) {
			await sendText(ref, unknownModelText(command.args));
			return;
		}

		const state = await updateConversationState(env, conversationId, { modelKey: model.key });
		await sendText(
			ref,
			[
				`Model switched to ${model.label}.`,
				`Session: ${state.sessionId}`,
				model.note ? `Note: ${model.note}` : undefined,
				'Use /new to start a clean session on this model.',
			]
				.filter(Boolean)
				.join('\n'),
		);
		return;
	}

	await sendText(ref, `Unknown command: /${command.name}\n\n${helpText(await getConversationState(env, conversationId))}`);
}

export function postMessage(ref: TelegramConversationRef) {
	return defineTool({
		name: 'post_telegram_message',
		description:
			'Post a message to the Telegram conversation bound to this teacher agent. If the telegram.message input includes draftId, pass it here unchanged so the answer can be streamed as a Telegram draft before it is persisted.',
		parameters: {
			type: 'object',
			properties: {
				text: {
					type: 'string',
					minLength: 1,
				},
				draftId: {
					type: 'number',
					description: 'The draftId from the telegram.message input, when present.',
					minimum: 1,
				},
			},
			required: ['text'],
			additionalProperties: false,
		},
		async execute({ text, draftId }) {
			console.log('[telegram:send] sending message', {
				chatId: ref.chatId,
				type: ref.type,
				textLength: text.length,
				hasDraftId: typeof draftId === 'number',
			});
			if (typeof draftId === 'number' && Number.isFinite(draftId)) {
				await streamTelegramDraft(ref, draftId, text);
			}
			const messages = await sendTextChunks(ref, text);
			console.log('[telegram:send] sent message', {
				chatId: ref.chatId,
				messageIds: messages.map((message) => message.message_id),
			});
			return JSON.stringify({ messageIds: messages.map((message) => message.message_id) });
		},
	});
}

async function getConversationState(
	env: TelegramChannelBindings,
	conversationId: string,
): Promise<TelegramStateDocument> {
	const stub = stateStore(env);
	if (!stub) {
		return {
			...defaultTelegramAgentState(),
			updatedAt: new Date(0).toISOString(),
		};
	}

	const response = await stub.fetch(stateRequest(conversationId));
	if (!response.ok) {
		throw new Error(`Unable to read Telegram bot state (${response.status}): ${await response.text()}`);
	}
	return (await response.json()) as TelegramStateDocument;
}

async function updateConversationState(
	env: TelegramChannelBindings,
	conversationId: string,
	patch: { modelKey?: TelegramModelKey; newSession?: boolean },
): Promise<TelegramStateDocument> {
	const stub = stateStore(env);
	if (!stub) {
		throw new Error('TELEGRAM_BOT_STATE Durable Object binding is not configured.');
	}

	const response = await stub.fetch(
		stateRequest(conversationId, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(patch),
		}),
	);
	if (!response.ok) {
		throw new Error(`Unable to update Telegram bot state (${response.status}): ${await response.text()}`);
	}
	return (await response.json()) as TelegramStateDocument;
}

function stateStore(env: TelegramChannelBindings): DurableObjectStub | undefined {
	return env.TELEGRAM_BOT_STATE?.getByName('default');
}

function stateRequest(conversationId: string, init?: RequestInit): Request {
	return new Request(
		`https://telegram-bot-state/state?conversationId=${encodeURIComponent(conversationId)}`,
		init,
	);
}

async function sendText(ref: TelegramConversationRef, text: string): Promise<void> {
	await sendTextChunks(ref, text);
}

async function sendTextChunks(ref: TelegramConversationRef, text: string): Promise<Message.TextMessage[]> {
	const chunks = splitTelegramText(text);
	const messages: Message.TextMessage[] = [];
	for (const chunk of chunks) {
		messages.push(
			await client.sendMessage(ref.chatId, chunk, {
				...(ref.type === 'business-chat'
					? { business_connection_id: ref.businessConnectionId }
					: {}),
				...(ref.messageThreadId ? { message_thread_id: ref.messageThreadId } : {}),
				...(ref.directMessagesTopicId ? { direct_messages_topic_id: ref.directMessagesTopicId } : {}),
			}),
		);
	}
	return messages;
}

type TelegramProgressMode = 'message_draft' | 'chat_action' | 'none';

async function startTelegramProgress(
	ref: TelegramConversationRef,
	draftId: number,
): Promise<TelegramProgressMode> {
	if (canUseMessageDraft(ref)) {
		try {
			await client.sendMessageDraft(ref.chatId, draftId, '');
			return 'message_draft';
		} catch (error) {
			console.warn('[telegram:draft] unable to start draft progress', error);
		}
	}

	try {
		await sendTypingAction(ref);
		return 'chat_action';
	} catch (error) {
		console.warn('[telegram:typing] unable to start typing action', error);
		return 'none';
	}
}

async function streamTelegramDraft(
	ref: TelegramConversationRef,
	draftId: number,
	text: string,
): Promise<void> {
	if (!canUseMessageDraft(ref)) {
		return;
	}

	const chunks = draftPreviewChunks(text);
	if (chunks.length === 0) {
		return;
	}

	try {
		for (const chunk of chunks) {
			await client.sendMessageDraft(ref.chatId, draftId, chunk);
			await sleep(140);
		}
	} catch (error) {
		console.warn('[telegram:draft] unable to stream draft', error);
	}
}

async function sendTypingAction(ref: TelegramConversationRef): Promise<void> {
	await client.sendChatAction(ref.chatId, 'typing', {
		...(ref.type === 'business-chat'
			? { business_connection_id: ref.businessConnectionId }
			: {}),
		...(ref.messageThreadId ? { message_thread_id: ref.messageThreadId } : {}),
		...(ref.directMessagesTopicId ? { direct_messages_topic_id: ref.directMessagesTopicId } : {}),
	});
}

function canUseMessageDraft(
	ref: TelegramConversationRef,
): ref is TelegramConversationRef & { type: 'chat'; chatId: number } {
	return ref.type === 'chat' && ref.chatId > 0 && ref.directMessagesTopicId === undefined;
}

function draftPreviewChunks(text: string): string[] {
	const preview = text.trim().slice(0, 4096);
	if (preview.length === 0) {
		return [];
	}
	if (preview.length <= 72) {
		return [preview];
	}

	const targetCount = Math.min(10, Math.max(3, Math.ceil(preview.length / 260)));
	const chunks: string[] = [];
	for (let index = 1; index <= targetCount; index += 1) {
		const target = Math.ceil((preview.length * index) / targetCount);
		const boundary = nearestWordBoundary(preview, target);
		const chunk = preview.slice(0, boundary).trimEnd();
		if (chunk && chunk !== chunks.at(-1)) {
			chunks.push(chunk);
		}
	}
	if (chunks.at(-1) !== preview) {
		chunks.push(preview);
	}
	return chunks;
}

function splitTelegramText(text: string): string[] {
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > 0) {
		if (remaining.length <= 4000) {
			chunks.push(remaining);
			break;
		}

		const boundary = nearestWordBoundary(remaining, 4000);
		chunks.push(remaining.slice(0, boundary).trimEnd());
		remaining = remaining.slice(boundary).trimStart();
	}
	return chunks.length ? chunks : [''];
}

function nearestWordBoundary(text: string, target: number): number {
	const bounded = Math.min(Math.max(target, 1), text.length);
	if (bounded === text.length) {
		return text.length;
	}

	const previous = text.lastIndexOf(' ', bounded);
	if (previous >= Math.max(1, bounded - 80)) {
		return previous;
	}

	const next = text.indexOf(' ', bounded);
	if (next > 0 && next <= bounded + 80) {
		return next;
	}

	return bounded;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCommand(text: string): BotCommand | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith('/')) {
		return undefined;
	}

	const [head, ...rest] = trimmed.split(/\s+/);
	const match = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?$/.exec(head);
	if (!match) {
		return undefined;
	}

	return {
		name: match[1].toLowerCase(),
		args: rest.join(' ').trim(),
	};
}

function helpText(state: TelegramAgentState): string {
	return [
		'Teacher bot commands:',
		'/model - show current model',
		'/model zai - switch to ZAI GLM-5.2 Max',
		'/model codex - switch to Codex GPT-5.5',
		'/new - start a clean session',
		'/new zai - start a clean session on ZAI',
		'/session - show current session',
		'/pages - show hosted lesson pages for this session',
		'/pages <url|share-id|session-id> - show a referenced page index',
		'/whoami - show your Telegram user id',
		'',
		`Current: ${TELEGRAM_MODEL_OPTIONS[state.modelKey].label}, session ${state.sessionId}`,
	].join('\n');
}

function sessionText(state: TelegramAgentState): string {
	return [
		`Session: ${state.sessionId}`,
		`Model: ${TELEGRAM_MODEL_OPTIONS[state.modelKey].label}`,
		'Use /new to start fresh.',
	].join('\n');
}

function modelText(state: TelegramAgentState): string {
	const model = TELEGRAM_MODEL_OPTIONS[state.modelKey];
	return [
		`Current model: ${model.label}`,
		`Current session: ${state.sessionId}`,
		'',
		'Available models:',
		describeTelegramModels(),
		'',
		'Switch with /model zai or /model codex.',
		model.note ? `Note: ${model.note}` : undefined,
	]
		.filter(Boolean)
		.join('\n');
}

function unknownModelText(input: string): string {
	return [
		`Unknown model: ${input}`,
		'',
		'Available models:',
		describeTelegramModels(),
		'',
		'Use /model zai or /model codex.',
	].join('\n');
}

function whoamiText(senderId: number | undefined): string {
	return senderId === undefined
		? 'Telegram did not include a user id for this message.'
		: `Your Telegram user id is ${senderId}.\nSet TELEGRAM_ALLOWED_USER_IDS to this value to make the bot answer only to you.`;
}

function isTelegramSenderAllowed(env: TelegramChannelBindings, senderId: number | undefined): boolean {
	const allowed = telegramAllowedUserIds(env);
	if (!allowed) {
		return true;
	}
	return senderId !== undefined && allowed.has(String(senderId));
}

function telegramAllowedUserIds(env: TelegramChannelBindings): Set<string> | undefined {
	const ids = env.TELEGRAM_ALLOWED_USER_IDS?.split(',')
		.map((id) => id.trim())
		.filter(Boolean);
	return ids?.length ? new Set(ids) : undefined;
}

async function pagesText(
	env: TelegramChannelBindings,
	conversationId: string,
	state: TelegramAgentState,
	reference?: string,
): Promise<string> {
	const agentId = buildTelegramAgentId(conversationId, state);
	if (reference?.trim()) {
		const resolved = await resolveTeachingPageReference({
			reference,
			currentAgentId: agentId,
		});
		return referencedPagesText(env, resolved);
	}

	const shareId = await shareIdForAgentId(agentId);
	return [
		`Hosted pages for session ${state.sessionId}:`,
		teachingPageIndexUrl(env, shareId),
		'',
		'Ask for a lesson first if the index is empty.',
	].join('\n');
}

function referencedPagesText(
	env: TelegramChannelBindings,
	resolved: ResolvedTeachingPageReference,
): string {
	return [
		`Hosted pages for ${referencedPagesLabel(resolved)}:`,
		teachingPageIndexUrl(env, resolved.shareId),
		resolved.path ? `Referenced page: ${teachingPageUrl(env, resolved.shareId, resolved.path)}` : undefined,
		'',
		'Paste the page URL in a normal message when you want the agent to use it.',
	]
		.filter((line): line is string => line !== undefined)
		.join('\n');
}

function referencedPagesLabel(resolved: ResolvedTeachingPageReference): string {
	if (resolved.source === 'session-id') {
		return `session ${resolved.sessionId} (${TELEGRAM_MODEL_OPTIONS[resolved.modelKey ?? 'zai'].label})`;
	}
	if (resolved.source === 'share-id') {
		return `share id ${resolved.shareId}`;
	}
	return 'referenced session';
}

/*
 * Build the canonical destination identity from a native Telegram Message.
 * Trusted code binds chat/topic; the model can only choose message text.
 */
function conversationFromMessage(message: Message): TelegramConversationRef {
	const topic = {
		...(message.message_thread_id === undefined
			? {}
			: { messageThreadId: message.message_thread_id }),
		...(message.direct_messages_topic?.topic_id === undefined
			? {}
			: { directMessagesTopicId: message.direct_messages_topic.topic_id }),
	};

	if (message.business_connection_id) {
		return {
			type: 'business-chat',
			businessConnectionId: message.business_connection_id,
			chatId: message.chat.id,
			...topic,
		};
	}

	return {
		type: 'chat',
		chatId: message.chat.id,
		...topic,
	};
}

function messageText(message: Message): string {
	return message.text ?? message.caption ?? '';
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`${name} is required to enable the Telegram channel.`);
	}
	return value;
}
