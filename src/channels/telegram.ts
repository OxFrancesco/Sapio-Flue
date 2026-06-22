import { createTelegramChannel, type TelegramConversationRef } from '@flue/telegram';
import { defineTool, dispatch } from '@flue/runtime';
import { Api } from 'grammy';
import type { InlineKeyboardMarkup, Message } from 'grammy/types';
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
	publicBaseUrl,
	type TeachingPageBindingEnv,
} from '../teaching-pages';

interface TelegramChannelBindings extends TeachingPageBindingEnv {
	CODEX_AUTH_ADMIN_TOKEN?: string;
	CODEX_AUTH_VAULT?: DurableObjectNamespace;
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

			const ref = conversationFromMessage(query.message);
			const conversationId = channel.conversationKey(ref);
			const uxAction = parseUxCallback(query.data);
			if (uxAction) {
				await handleUxCallback(c.env, ref, conversationId, uxAction);
				console.log('[telegram:webhook] ux callback handled', {
					updateId: update.update_id,
					chatId: query.message.chat.id,
					conversationId,
					action: uxAction,
				});
				return;
			}

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

type UxCallbackAction =
	| 'ux:menu'
	| 'ux:model'
	| 'ux:model:zai'
	| 'ux:model:codex'
	| 'ux:codex'
	| 'ux:pages'
	| 'ux:examples'
	| 'ux:new:ask'
	| 'ux:new:confirm'
	| 'ux:new:cancel';

interface TelegramTextResponse {
	text: string;
	replyMarkup?: InlineKeyboardMarkup;
}

interface CodexDeviceStartResponse {
	state: string;
	userCode: string;
	verificationUri: string;
	intervalSeconds: number;
	expiresAt: string;
}

interface CodexStatusResponse {
	configured: boolean;
	expiresAt?: string;
	updatedAt?: string;
}

const UX_CALLBACK_ACTIONS = new Set<string>([
	'ux:menu',
	'ux:model',
	'ux:model:zai',
	'ux:model:codex',
	'ux:codex',
	'ux:pages',
	'ux:examples',
	'ux:new:ask',
	'ux:new:confirm',
	'ux:new:cancel',
]);

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
		await sendText(ref, commandCenterText(await getConversationState(env, conversationId)), {
			replyMarkup: commandCenterKeyboard(),
		});
		return;
	}

	if (command.name === 'session') {
		await sendText(ref, sessionText(await getConversationState(env, conversationId)), {
			replyMarkup: commandCenterKeyboard(),
		});
		return;
	}

	if (command.name === 'codex') {
		try {
			await sendResponse(
				ref,
				command.args.trim().toLowerCase() === 'status'
					? await codexStatusResponse(env)
					: await codexLoginResponse(env),
			);
		} catch (error) {
			await sendText(ref, codexErrorText(error), { replyMarkup: commandCenterKeyboard() });
		}
		return;
	}

	if (command.name === 'pages') {
		const state = await getConversationState(env, conversationId);
		try {
			await sendResponse(ref, await pagesResponse(env, conversationId, state, command.args));
		} catch (error) {
			await sendText(
				ref,
				`Unable to resolve page reference: ${error instanceof Error ? error.message : String(error)}`,
				{ replyMarkup: commandCenterKeyboard() },
			);
		}
		return;
	}

	if (command.name === 'new') {
		const model = command.args ? telegramModelFromAlias(command.args) : undefined;
		if (command.args && !model) {
			await sendText(ref, unknownModelText(command.args), {
				replyMarkup: modelKeyboard(await getConversationState(env, conversationId)),
			});
			return;
		}

		const state = await updateConversationState(env, conversationId, {
			newSession: true,
			...(model ? { modelKey: model.key } : {}),
		});
		await sendText(ref, newSessionStartedText(state), { replyMarkup: commandCenterKeyboard() });
		return;
	}

	if (command.name === 'model') {
		if (!command.args) {
			const state = await getConversationState(env, conversationId);
			await sendText(ref, modelText(state), { replyMarkup: modelKeyboard(state) });
			return;
		}

		const model = telegramModelFromAlias(command.args);
		if (!model) {
			await sendText(ref, unknownModelText(command.args), {
				replyMarkup: modelKeyboard(await getConversationState(env, conversationId)),
			});
			return;
		}

		const state = await updateConversationState(env, conversationId, { modelKey: model.key });
		await sendText(ref, modelSwitchedText(state, model.key, false), {
			replyMarkup: modelKeyboard(state),
		});
		return;
	}

	await sendText(
		ref,
		`Unknown command: /${command.name}\n\n${commandCenterText(await getConversationState(env, conversationId))}`,
		{ replyMarkup: commandCenterKeyboard() },
	);
}

async function handleUxCallback(
	env: TelegramChannelBindings,
	ref: TelegramConversationRef,
	conversationId: string,
	action: UxCallbackAction,
): Promise<void> {
	if (action === 'ux:menu') {
		await sendText(ref, commandCenterText(await getConversationState(env, conversationId)), {
			replyMarkup: commandCenterKeyboard(),
		});
		return;
	}

	if (action === 'ux:model') {
		const state = await getConversationState(env, conversationId);
		await sendText(ref, modelText(state), { replyMarkup: modelKeyboard(state) });
		return;
	}

	if (action === 'ux:codex') {
		try {
			await sendResponse(ref, await codexLoginResponse(env));
		} catch (error) {
			await sendText(ref, codexErrorText(error), { replyMarkup: commandCenterKeyboard() });
		}
		return;
	}

	if (action === 'ux:model:zai' || action === 'ux:model:codex') {
		const modelKey = action === 'ux:model:zai' ? 'zai' : 'codex';
		const current = await getConversationState(env, conversationId);
		const alreadySelected = current.modelKey === modelKey;
		const state = alreadySelected
			? current
			: await updateConversationState(env, conversationId, { modelKey });
		await sendText(ref, modelSwitchedText(state, modelKey, alreadySelected), {
			replyMarkup: modelKeyboard(state),
		});
		return;
	}

	if (action === 'ux:pages') {
		const state = await getConversationState(env, conversationId);
		try {
			await sendResponse(ref, await pagesResponse(env, conversationId, state));
		} catch (error) {
			await sendText(
				ref,
				`Unable to load pages: ${error instanceof Error ? error.message : String(error)}`,
				{ replyMarkup: commandCenterKeyboard() },
			);
		}
		return;
	}

	if (action === 'ux:examples') {
		await sendText(ref, examplesText(), { replyMarkup: examplesKeyboard() });
		return;
	}

	if (action === 'ux:new:ask') {
		await sendText(ref, newSessionConfirmText(await getConversationState(env, conversationId)), {
			replyMarkup: newSessionConfirmKeyboard(),
		});
		return;
	}

	if (action === 'ux:new:confirm') {
		const state = await updateConversationState(env, conversationId, { newSession: true });
		await sendText(ref, newSessionStartedText(state), { replyMarkup: commandCenterKeyboard() });
		return;
	}

	const state = await getConversationState(env, conversationId);
	await sendText(ref, `New session cancelled.\n\n${sessionText(state)}`, {
		replyMarkup: commandCenterKeyboard(),
	});
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

async function sendResponse(ref: TelegramConversationRef, response: TelegramTextResponse): Promise<void> {
	await sendText(ref, response.text, { replyMarkup: response.replyMarkup });
}

async function sendText(
	ref: TelegramConversationRef,
	text: string,
	options: { replyMarkup?: InlineKeyboardMarkup } = {},
): Promise<void> {
	await sendTextChunks(ref, text, options);
}

async function sendTextChunks(
	ref: TelegramConversationRef,
	text: string,
	options: { replyMarkup?: InlineKeyboardMarkup } = {},
): Promise<Message.TextMessage[]> {
	const chunks = splitTelegramText(text);
	const messages: Message.TextMessage[] = [];
	for (const [index, chunk] of chunks.entries()) {
		messages.push(
			await client.sendMessage(ref.chatId, chunk, {
				...(ref.type === 'business-chat'
					? { business_connection_id: ref.businessConnectionId }
					: {}),
				...(ref.messageThreadId ? { message_thread_id: ref.messageThreadId } : {}),
				...(ref.directMessagesTopicId ? { direct_messages_topic_id: ref.directMessagesTopicId } : {}),
				...(index === chunks.length - 1 && options.replyMarkup
					? { reply_markup: options.replyMarkup }
					: {}),
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

function parseUxCallback(data: string | undefined): UxCallbackAction | undefined {
	if (!data || !UX_CALLBACK_ACTIONS.has(data)) {
		return undefined;
	}
	return data as UxCallbackAction;
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

function commandCenterText(state: TelegramAgentState): string {
	return [
		'Teacher bot',
		`Model: ${TELEGRAM_MODEL_OPTIONS[state.modelKey].label}`,
		`Session: ${state.sessionId}`,
		'',
		'Send a topic or question directly, or use the buttons below.',
		'Commands: /model, /codex, /new, /pages, /session, /whoami',
	].join('\n');
}

function sessionText(state: TelegramAgentState): string {
	return [
		'Current session',
		`Session: ${state.sessionId}`,
		`Model: ${TELEGRAM_MODEL_OPTIONS[state.modelKey].label}`,
		'Use /new to start fresh, or tap New session.',
	].join('\n');
}

function modelText(state: TelegramAgentState): string {
	const model = TELEGRAM_MODEL_OPTIONS[state.modelKey];
	return [
		'Model picker',
		`Current: ${model.label}`,
		`Session: ${state.sessionId}`,
		'',
		describeTelegramModels(),
		'',
		'Tap a model, or use /model zai or /model codex. Use /codex to connect ChatGPT.',
		model.note ? `Note: ${model.note}` : undefined,
	]
		.filter(Boolean)
		.join('\n');
}

function unknownModelText(input: string): string {
	return [
		`Unknown model: ${input}`,
		'',
		describeTelegramModels(),
		'',
		'Tap a model, or use /model zai or /model codex. Use /codex to connect ChatGPT.',
	].join('\n');
}

function modelSwitchedText(
	state: TelegramAgentState,
	modelKey: TelegramModelKey,
	alreadySelected: boolean,
): string {
	const model = TELEGRAM_MODEL_OPTIONS[modelKey];
	return [
		alreadySelected ? `Already using ${model.label}.` : `Model switched to ${model.label}.`,
		`Session: ${state.sessionId}`,
		model.note ? `Note: ${model.note}` : undefined,
		'Use /new to start a clean session on this model.',
	]
		.filter(Boolean)
		.join('\n');
}

function newSessionConfirmText(state: TelegramAgentState): string {
	return [
		'Start a new session?',
		`Current session: ${state.sessionId}`,
		`Model: ${TELEGRAM_MODEL_OPTIONS[state.modelKey].label}`,
		'',
		'This keeps old history stored but stops using it for new messages.',
	].join('\n');
}

function newSessionStartedText(state: TelegramAgentState): string {
	return [
		'Started a new session.',
		`Session: ${state.sessionId}`,
		`Model: ${TELEGRAM_MODEL_OPTIONS[state.modelKey].label}`,
		'Send a topic when ready.',
	].join('\n');
}

function examplesText(): string {
	return [
		'Prompt starters',
		'Teach me TypeScript generics in 10 minutes.',
		'Quiz me on the latest lesson page.',
		'Make a practice exercise with hints.',
		'Explain this code step by step: <paste code>',
		'Create a short lesson page about <topic>.',
	].join('\n');
}

function commandCenterKeyboard(): InlineKeyboardMarkup {
	return inlineKeyboard([
		[
			callbackButton('New session', 'ux:new:ask'),
			callbackButton('Model', 'ux:model'),
		],
		[
			callbackButton('Codex login', 'ux:codex'),
			callbackButton('Pages', 'ux:pages'),
		],
		[
			callbackButton('Examples', 'ux:examples'),
		],
	]);
}

function modelKeyboard(state: TelegramAgentState): InlineKeyboardMarkup {
	return inlineKeyboard([
		[
			callbackButton(modelButtonText('zai', state.modelKey), 'ux:model:zai'),
			callbackButton(modelButtonText('codex', state.modelKey), 'ux:model:codex'),
		],
		[callbackButton('Codex login', 'ux:codex')],
		[callbackButton('Menu', 'ux:menu')],
	]);
}

function codexLoginKeyboard(loginUrl: string): InlineKeyboardMarkup {
	return inlineKeyboard([
		[urlButton('Open Codex login', loginUrl)],
		[callbackButton('Menu', 'ux:menu')],
	]);
}

function pagesKeyboard(indexUrl: string, referencedPageUrl?: string): InlineKeyboardMarkup {
	return inlineKeyboard([
		[urlButton('Open page index', indexUrl)],
		...(referencedPageUrl ? [[urlButton('Open referenced page', referencedPageUrl)]] : []),
		[callbackButton('Menu', 'ux:menu')],
	]);
}

function examplesKeyboard(): InlineKeyboardMarkup {
	return inlineKeyboard([[callbackButton('Menu', 'ux:menu')]]);
}

function newSessionConfirmKeyboard(): InlineKeyboardMarkup {
	return inlineKeyboard([
		[
			callbackButton('Start new session', 'ux:new:confirm'),
			callbackButton('Cancel', 'ux:new:cancel'),
		],
	]);
}

function modelButtonText(modelKey: TelegramModelKey, currentModelKey: TelegramModelKey): string {
	const label = modelKey === 'zai' ? 'ZAI' : 'Codex';
	return modelKey === currentModelKey ? `${label} [current]` : label;
}

function inlineKeyboard(rows: InlineKeyboardMarkup['inline_keyboard']): InlineKeyboardMarkup {
	return { inline_keyboard: rows };
}

function callbackButton(text: string, callbackData: UxCallbackAction): { text: string; callback_data: string } {
	return { text, callback_data: callbackData };
}

function urlButton(text: string, url: string): { text: string; url: string } {
	return { text, url };
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

async function codexLoginResponse(env: TelegramChannelBindings): Promise<TelegramTextResponse> {
	const [start, status] = await Promise.all([
		startCodexDeviceLogin(env),
		readCodexStatus(env).catch(() => undefined),
	]);
	const loginUrl = new URL('/codex-auth/device', publicBaseUrl(env));
	loginUrl.searchParams.set('state', start.state);

	return {
		text: [
			'Codex login',
			codexStatusLine(status),
			'',
			'Tap the button below, open the Codex login page, and approve the ChatGPT account.',
			`Code: ${start.userCode}`,
			`Expires: ${start.expiresAt}`,
			'',
			'After approval, the browser page stores the credentials automatically.',
		].join('\n'),
		replyMarkup: codexLoginKeyboard(loginUrl.toString()),
	};
}

async function codexStatusResponse(env: TelegramChannelBindings): Promise<TelegramTextResponse> {
	return {
		text: ['Codex auth', codexStatusLine(await readCodexStatus(env))].join('\n'),
		replyMarkup: commandCenterKeyboard(),
	};
}

async function startCodexDeviceLogin(
	env: TelegramChannelBindings,
): Promise<CodexDeviceStartResponse> {
	if (!env.CODEX_AUTH_VAULT) {
		throw new Error('CODEX_AUTH_VAULT Durable Object binding is not configured.');
	}
	if (!env.CODEX_AUTH_ADMIN_TOKEN) {
		throw new Error('CODEX_AUTH_ADMIN_TOKEN is not configured.');
	}

	const response = await env.CODEX_AUTH_VAULT.getByName('default').fetch(
		new Request('https://codex-auth-vault/oauth/device/start', {
			method: 'POST',
			headers: { authorization: `Bearer ${env.CODEX_AUTH_ADMIN_TOKEN}` },
		}),
	);
	if (!response.ok) {
		throw new Error(`Unable to start Codex login (${response.status}): ${await response.text()}`);
	}

	return (await response.json()) as CodexDeviceStartResponse;
}

async function readCodexStatus(env: TelegramChannelBindings): Promise<CodexStatusResponse> {
	if (!env.CODEX_AUTH_VAULT) {
		throw new Error('CODEX_AUTH_VAULT Durable Object binding is not configured.');
	}

	const response = await env.CODEX_AUTH_VAULT.getByName('default').fetch(
		new Request('https://codex-auth-vault/status'),
	);
	if (!response.ok) {
		throw new Error(`Unable to read Codex auth status (${response.status}): ${await response.text()}`);
	}

	return (await response.json()) as CodexStatusResponse;
}

function codexStatusLine(status: CodexStatusResponse | undefined): string {
	if (!status) {
		return 'Status: unable to read current credentials.';
	}
	if (!status.configured) {
		return 'Status: not connected yet.';
	}
	return `Status: connected. Token expires: ${status.expiresAt ?? 'unknown'}.`;
}

function codexErrorText(error: unknown): string {
	return `Unable to start Codex login: ${error instanceof Error ? error.message : String(error)}`;
}

async function pagesResponse(
	env: TelegramChannelBindings,
	conversationId: string,
	state: TelegramAgentState,
	reference?: string,
): Promise<TelegramTextResponse> {
	const agentId = buildTelegramAgentId(conversationId, state);
	if (reference?.trim()) {
		const resolved = await resolveTeachingPageReference({
			reference,
			currentAgentId: agentId,
		});
		return referencedPagesResponse(env, resolved);
	}

	const shareId = await shareIdForAgentId(agentId);
	const indexUrl = teachingPageIndexUrl(env, shareId);
	return {
		text: [
			`Hosted pages for session ${state.sessionId}:`,
			indexUrl,
			'',
			'Ask for a lesson first if the index is empty.',
		].join('\n'),
		replyMarkup: pagesKeyboard(indexUrl),
	};
}

function referencedPagesResponse(
	env: TelegramChannelBindings,
	resolved: ResolvedTeachingPageReference,
): TelegramTextResponse {
	const indexUrl = teachingPageIndexUrl(env, resolved.shareId);
	const referencedPageUrl = resolved.path
		? teachingPageUrl(env, resolved.shareId, resolved.path)
		: undefined;
	return {
		text: [
			`Hosted pages for ${referencedPagesLabel(resolved)}:`,
			indexUrl,
			referencedPageUrl ? `Referenced page: ${referencedPageUrl}` : undefined,
			'',
			'Paste the page URL in a normal message when you want the agent to use it.',
		]
			.filter((line): line is string => line !== undefined)
			.join('\n'),
		replyMarkup: pagesKeyboard(indexUrl, referencedPageUrl),
	};
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
