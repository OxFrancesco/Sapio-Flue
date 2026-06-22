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
	shareIdForAgentId,
	teachingPageIndexUrl,
	type TeachingPageBindingEnv,
} from '../teaching-pages';

interface TelegramChannelBindings extends TeachingPageBindingEnv {
	TELEGRAM_BOT_STATE?: DurableObjectNamespace;
}

export type TelegramTeacherInput =
	| {
			type: 'telegram.message';
			updateId: number;
			text: string;
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
			const command = parseCommand(messageText(incoming));
			if (command) {
				await handleCommand(c.env, ref, conversationId, command);
				return;
			}

			const state = await getConversationState(c.env, conversationId);
			const agentId = buildTelegramAgentId(conversationId, state);
			const receipt = await dispatch(teacher, {
				id: agentId,
				input: {
					type: 'telegram.message',
					updateId: update.update_id,
					text: messageText(incoming),
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
				dispatchId: receipt.dispatchId,
			});
			return;
		}

		if (update.callback_query) {
			const query = update.callback_query;
			await client.answerCallbackQuery(query.id);
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
): Promise<void> {
	if (command.name === 'start' || command.name === 'help') {
		await sendText(ref, helpText(await getConversationState(env, conversationId)));
		return;
	}

	if (command.name === 'session') {
		await sendText(ref, sessionText(await getConversationState(env, conversationId)));
		return;
	}

	if (command.name === 'pages') {
		await sendText(ref, await pagesText(env, conversationId, await getConversationState(env, conversationId)));
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
		description: 'Post a message to the Telegram conversation bound to this teacher agent.',
		parameters: {
			type: 'object',
			properties: {
				text: {
					type: 'string',
					minLength: 1,
				},
			},
			required: ['text'],
			additionalProperties: false,
		},
		async execute({ text }) {
			console.log('[telegram:send] sending message', {
				chatId: ref.chatId,
				type: ref.type,
				textLength: text.length,
			});
			const message = await client.sendMessage(ref.chatId, text, {
				...(ref.type === 'business-chat'
					? { business_connection_id: ref.businessConnectionId }
					: {}),
				...(ref.messageThreadId ? { message_thread_id: ref.messageThreadId } : {}),
				...(ref.directMessagesTopicId
					? { direct_messages_topic_id: ref.directMessagesTopicId }
					: {}),
			});
			console.log('[telegram:send] sent message', {
				chatId: ref.chatId,
				messageId: message.message_id,
			});
			return JSON.stringify({ messageId: message.message_id });
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
	await client.sendMessage(ref.chatId, text, {
		...(ref.type === 'business-chat'
			? { business_connection_id: ref.businessConnectionId }
			: {}),
		...(ref.messageThreadId ? { message_thread_id: ref.messageThreadId } : {}),
		...(ref.directMessagesTopicId ? { direct_messages_topic_id: ref.directMessagesTopicId } : {}),
	});
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

async function pagesText(
	env: TelegramChannelBindings,
	conversationId: string,
	state: TelegramAgentState,
): Promise<string> {
	const agentId = buildTelegramAgentId(conversationId, state);
	const shareId = await shareIdForAgentId(agentId);
	return [
		`Hosted pages for session ${state.sessionId}:`,
		teachingPageIndexUrl(env, shareId),
		'',
		'Ask for a lesson first if the index is empty.',
	].join('\n');
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
