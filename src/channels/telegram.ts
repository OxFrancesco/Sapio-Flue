import { createTelegramChannel, type TelegramConversationRef } from '@flue/telegram';
import { defineTool, dispatch } from '@flue/runtime';
import { Effect } from 'effect';
import { Api } from 'grammy';
import type { InlineKeyboardMarkup, Message } from 'grammy/types';
import teacher from '../agents/teacher';
import {
	createPolarCheckoutSession,
	isPolarBillingConfigured,
	type PaidWorkspacePlan,
	type PolarBillingBindingEnv,
} from '../billing/polar';
import {
	createWorkspaceInvite,
	getWorkspace,
	isConvexConfigured,
	joinWorkspaceInvite,
	setModelCredential,
	setWorkspaceModel as setConvexWorkspaceModel,
	syncTelegramContext,
	type ConvexBindingEnv,
	type SyncedTelegramContext,
	type TelegramChatProfile,
	type TelegramUserProfile,
	type WorkspaceDetails,
} from '../convex-client';
import {
	storeWorkspaceModelApiKey,
	type WorkspaceCredentialVaultBindingEnv,
} from '../model-credentials';
import {
	buildTelegramAgentId,
	defaultTelegramAgentState,
	OPENAI_BYOK_DEFAULT_MODEL_ID,
	parseTelegramAgentId,
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
import { AuthBridgeError, renderUserError } from '../effect/errors';
import { responseJson } from '../effect/http';
import { annotateFlow, retryIdempotent, runEffect } from '../effect/runtime';
import {
	CodexDeviceStartResponseSchema,
	CodexStatusResponseSchema,
	TelegramReplyTargetDocumentSchema,
	TelegramReplyTargetResponseSchema,
	TelegramStateDocumentSchema,
} from '../effect/schemas';

export interface TelegramReplyTargetBindingEnv {
	TELEGRAM_BOT_STATE?: DurableObjectNamespace;
}

interface TelegramChannelBindings
	extends TeachingPageBindingEnv,
		ConvexBindingEnv,
		WorkspaceCredentialVaultBindingEnv,
		PolarBillingBindingEnv,
		TelegramReplyTargetBindingEnv {
	CODEX_AUTH_ADMIN_TOKEN?: string;
	CODEX_AUTH_VAULT?: DurableObjectNamespace;
	TELEGRAM_ALLOWED_USER_IDS?: string;
}

export type TelegramTeacherInput =
	| {
			type: 'telegram.message';
			updateId: number;
			text: string;
			replyTargetId: string;
			draftId?: number;
			message: Message;
			auth?: TelegramAuthPayload;
	  }
	| {
			type: 'telegram.callback_query';
			updateId: number;
			data?: string;
			replyTargetId: string;
			from: {
				id: number;
				is_bot: boolean;
				first_name: string;
				last_name?: string;
				username?: string;
				language_code?: string;
			};
			auth?: TelegramAuthPayload;
	  };

interface TelegramAuthPayload {
	userId: string;
	userDisplayName: string;
	workspaceId: string;
	workspaceName: string;
	membershipRole: string;
	plan: string;
	billingMode: string;
}

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

			const authContext = await syncMessageAuthContext(c.env, incoming, conversationId);
			if (isConvexConfigured(c.env) && !authContext) {
				await sendText(ref, 'Sign-in is temporarily unavailable. Try again in a moment.');
				return;
			}
			if (authContext?.user.status === 'disabled') {
				await sendText(ref, 'This Telegram account is disabled for this bot.');
				return;
			}

			const command = parseCommand(messageText(incoming));
			if (command) {
				await handleCommand(c.env, ref, conversationId, command, senderId, authContext, incoming);
				return;
			}

			const state = await getEffectiveConversationState(c.env, conversationId, authContext);
			if (!(await ensureSelectedModelReady(c.env, ref, state, authContext))) {
				return;
			}
			const agentId = buildTelegramAgentId(conversationId, state);
			const replyTargetId = await prepareTelegramReplyTarget(
				c.env,
				ref,
				agentId,
				update.update_id,
			);
			if (!replyTargetId) {
				return;
			}
			const draftId = update.update_id || Date.now();
			const progressMode = await startTelegramProgress(ref, draftId);
			const receipt = await dispatch(teacher, {
				id: agentId,
				input: {
					type: 'telegram.message',
					updateId: update.update_id,
					text: messageText(incoming),
					replyTargetId,
					...(progressMode === 'message_draft' ? { draftId } : {}),
					message: incoming,
					...(authContext ? { auth: telegramAuthPayload(authContext) } : {}),
				} satisfies TelegramTeacherInput,
			});
			console.log('[telegram:webhook] message dispatched', {
				updateId: update.update_id,
				chatId: incoming.chat.id,
				conversationId,
				agentId,
				modelKey: state.modelKey,
				sessionId: state.sessionId,
				workspaceId: state.workspaceId,
				replyTargetId,
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
			const authContext = await syncCallbackAuthContext(c.env, query.from, query.message, conversationId);
			if (isConvexConfigured(c.env) && !authContext) {
				await sendText(ref, 'Sign-in is temporarily unavailable. Try again in a moment.');
				return;
			}
			if (authContext?.user.status === 'disabled') {
				await sendText(ref, 'This Telegram account is disabled for this bot.');
				return;
			}

			const uxAction = parseUxCallback(query.data);
			if (uxAction) {
				await handleUxCallback(c.env, ref, conversationId, uxAction, authContext);
				console.log('[telegram:webhook] ux callback handled', {
					updateId: update.update_id,
					chatId: query.message.chat.id,
					conversationId,
					action: uxAction,
				});
				return;
			}

			const state = await getEffectiveConversationState(c.env, conversationId, authContext);
			if (!(await ensureSelectedModelReady(c.env, ref, state, authContext))) {
				return;
			}
			const agentId = buildTelegramAgentId(conversationId, state);
			const replyTargetId = await prepareTelegramReplyTarget(
				c.env,
				ref,
				agentId,
				update.update_id,
			);
			if (!replyTargetId) {
				return;
			}
			const receipt = await dispatch(teacher, {
				id: agentId,
				input: {
					type: 'telegram.callback_query',
					updateId: update.update_id,
					data: query.data,
					replyTargetId,
					from: query.from,
					...(authContext ? { auth: telegramAuthPayload(authContext) } : {}),
				} satisfies TelegramTeacherInput,
			});
			console.log('[telegram:webhook] callback dispatched', {
				updateId: update.update_id,
				chatId: query.message.chat.id,
				conversationId,
				agentId,
				modelKey: state.modelKey,
				sessionId: state.sessionId,
				workspaceId: state.workspaceId,
				replyTargetId,
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
	| 'ux:model:openai'
	| 'ux:codex'
	| 'ux:pages'
	| 'ux:workspace'
	| 'ux:invite'
	| 'ux:billing'
	| 'ux:billing:pro'
	| 'ux:billing:team'
	| 'ux:examples'
	| 'ux:new:ask'
	| 'ux:new:confirm'
	| 'ux:new:cancel';

interface TelegramTextResponse {
	text: string;
	replyMarkup?: InlineKeyboardMarkup;
}

interface InputRichMessage {
	html?: string;
	markdown?: string;
	is_rtl?: boolean;
	skip_entity_detection?: boolean;
}

interface TelegramSendOptions {
	business_connection_id?: string;
	message_thread_id?: number;
	direct_messages_topic_id?: number;
	reply_markup?: InlineKeyboardMarkup;
}

interface TelegramDraftOptions {
	message_thread_id?: number;
}

interface TelegramRichApi {
	sendRichMessage(
		chatId: number | string,
		richMessage: InputRichMessage,
		options?: TelegramSendOptions,
	): Promise<{ message_id: number }>;
	sendRichMessageDraft(
		chatId: number,
		draftId: number,
		richMessage: InputRichMessage,
		options?: TelegramDraftOptions,
	): Promise<true>;
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

const TELEGRAM_TEXT_LIMIT = 4000;
const TELEGRAM_RICH_MARKDOWN_LIMIT = 32000;

const UX_CALLBACK_ACTIONS = new Set<string>([
	'ux:menu',
	'ux:model',
	'ux:model:zai',
	'ux:model:codex',
	'ux:model:openai',
	'ux:codex',
	'ux:pages',
	'ux:workspace',
	'ux:invite',
	'ux:billing',
	'ux:billing:pro',
	'ux:billing:team',
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
	authContext: SyncedTelegramContext | undefined,
	sourceMessage: Message,
): Promise<void> {
	if (command.name === 'whoami') {
		await sendText(ref, whoamiText(senderId));
		return;
	}

	if (command.name === 'start' || command.name === 'help') {
		const state = await getEffectiveConversationState(env, conversationId, authContext);
		await sendText(ref, commandCenterText(state, authContext), {
			replyMarkup: commandCenterKeyboard(),
		});
		return;
	}

	if (command.name === 'session') {
		const state = await getEffectiveConversationState(env, conversationId, authContext);
		await sendText(ref, sessionText(state, authContext), {
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
		const state = await getEffectiveConversationState(env, conversationId, authContext);
		try {
			await sendResponse(ref, await pagesResponse(env, conversationId, state, command.args));
		} catch (error) {
			await sendText(
				ref,
				errorText('Unable to resolve page reference', error),
				{ replyMarkup: commandCenterKeyboard() },
			);
		}
		return;
	}

	if (command.name === 'workspace' || command.name === 'members') {
		if (!authContext) {
			await sendText(ref, convexRequiredText(), { replyMarkup: commandCenterKeyboard() });
			return;
		}
		if (command.name === 'workspace' && command.args.trim().toLowerCase() === 'invite') {
			await sendWorkspaceInvite(env, ref, authContext);
			return;
		}
		try {
			const details = await getWorkspace(env, {
				workspaceId: authContext.workspace.id,
				userId: authContext.user.id,
			});
			await sendText(ref, workspaceText(details), { replyMarkup: workspaceKeyboard() });
		} catch (error) {
			await sendText(ref, errorText('Unable to load workspace', error), {
				replyMarkup: commandCenterKeyboard(),
			});
		}
		return;
	}

	if (command.name === 'billing' || command.name === 'subscribe') {
		if (!authContext) {
			await sendText(ref, convexRequiredText(), { replyMarkup: commandCenterKeyboard() });
			return;
		}
		await handleBillingCommand(env, ref, authContext, command.args);
		return;
	}

	if (command.name === 'invite') {
		if (!authContext) {
			await sendText(ref, convexRequiredText(), { replyMarkup: commandCenterKeyboard() });
			return;
		}
		await sendWorkspaceInvite(env, ref, authContext);
		return;
	}

	if (command.name === 'join') {
		if (!authContext) {
			await sendText(ref, convexRequiredText(), { replyMarkup: commandCenterKeyboard() });
			return;
		}
		const code = command.args.trim();
		if (!code) {
			await sendText(ref, 'Use /join <invite-code>.', { replyMarkup: workspaceKeyboard() });
			return;
		}
		try {
			const joined = await joinWorkspaceInvite(env, { code, userId: authContext.user.id });
			await updateConversationState(env, conversationId, { workspaceId: joined.workspace.id });
			await sendText(ref, joinedWorkspaceText(joined.workspace), {
				replyMarkup: workspaceKeyboard(),
			});
		} catch (error) {
			await sendText(ref, errorText('Unable to join workspace', error), {
				replyMarkup: commandCenterKeyboard(),
			});
		}
		return;
	}

	if (command.name === 'key') {
		if (!authContext) {
			await sendText(ref, convexRequiredText(), { replyMarkup: commandCenterKeyboard() });
			return;
		}
		await handleKeyCommand(env, ref, authContext, command.args, sourceMessage);
		return;
	}

	if (command.name === 'new') {
		const model = command.args ? telegramModelFromAlias(command.args) : undefined;
		if (command.args && !model) {
			await sendText(ref, unknownModelText(command.args), {
				replyMarkup: modelKeyboard(await getEffectiveConversationState(env, conversationId, authContext)),
			});
			return;
		}

		try {
			const selectedState = model
				? await selectModelForConversation(env, conversationId, authContext, model.key)
				: await getEffectiveConversationState(env, conversationId, authContext);
			const state = await updateEffectiveConversationState(env, conversationId, authContext, {
				newSession: true,
				modelKey: selectedState.modelKey,
			});
			await sendText(ref, newSessionStartedText(state), { replyMarkup: commandCenterKeyboard() });
		} catch (error) {
			await sendText(ref, errorText('Unable to start a new session', error), {
				replyMarkup: modelKeyboard(await getEffectiveConversationState(env, conversationId, authContext)),
			});
		}
		return;
	}

	if (command.name === 'model') {
		if (!command.args) {
			const state = await getEffectiveConversationState(env, conversationId, authContext);
			await sendText(ref, modelText(state, authContext), { replyMarkup: modelKeyboard(state) });
			return;
		}

		const model = telegramModelFromAlias(command.args);
		if (!model) {
			await sendText(ref, unknownModelText(command.args), {
				replyMarkup: modelKeyboard(await getEffectiveConversationState(env, conversationId, authContext)),
			});
			return;
		}

		try {
			const state = await selectModelForConversation(env, conversationId, authContext, model.key);
			await sendText(ref, modelSwitchedText(state, model.key, false), {
				replyMarkup: modelKeyboard(state),
			});
		} catch (error) {
			await sendText(ref, errorText('Unable to switch model', error), {
				replyMarkup: modelKeyboard(await getEffectiveConversationState(env, conversationId, authContext)),
			});
		}
		return;
	}

	await sendText(
		ref,
		[
			'# Unknown command',
			`Command: ${mdInlineCode(`/${command.name}`)}`,
			'',
			commandCenterText(await getEffectiveConversationState(env, conversationId, authContext), authContext),
		].join('\n'),
		{ replyMarkup: commandCenterKeyboard() },
	);
}

async function handleUxCallback(
	env: TelegramChannelBindings,
	ref: TelegramConversationRef,
	conversationId: string,
	action: UxCallbackAction,
	authContext: SyncedTelegramContext | undefined,
): Promise<void> {
	if (action === 'ux:menu') {
		const state = await getEffectiveConversationState(env, conversationId, authContext);
		await sendText(ref, commandCenterText(state, authContext), {
			replyMarkup: commandCenterKeyboard(),
		});
		return;
	}

	if (action === 'ux:model') {
		const state = await getEffectiveConversationState(env, conversationId, authContext);
		await sendText(ref, modelText(state, authContext), { replyMarkup: modelKeyboard(state) });
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

	if (action === 'ux:model:zai' || action === 'ux:model:codex' || action === 'ux:model:openai') {
		const modelKey = action === 'ux:model:zai' ? 'zai' : action === 'ux:model:codex' ? 'codex' : 'openai';
		const current = await getEffectiveConversationState(env, conversationId, authContext);
		const alreadySelected = current.modelKey === modelKey;
		try {
			const state = alreadySelected
				? current
				: await selectModelForConversation(env, conversationId, authContext, modelKey);
			await sendText(ref, modelSwitchedText(state, modelKey, alreadySelected), {
				replyMarkup: modelKeyboard(state),
			});
		} catch (error) {
			await sendText(ref, errorText('Unable to switch model', error), {
				replyMarkup: modelKeyboard(current),
			});
		}
		return;
	}

	if (action === 'ux:pages') {
		const state = await getEffectiveConversationState(env, conversationId, authContext);
		try {
			await sendResponse(ref, await pagesResponse(env, conversationId, state));
		} catch (error) {
			await sendText(
				ref,
				errorText('Unable to load pages', error),
				{ replyMarkup: commandCenterKeyboard() },
			);
		}
		return;
	}

	if (action === 'ux:workspace') {
		if (!authContext) {
			await sendText(ref, convexRequiredText(), { replyMarkup: commandCenterKeyboard() });
			return;
		}
		try {
			const details = await getWorkspace(env, {
				workspaceId: authContext.workspace.id,
				userId: authContext.user.id,
			});
			await sendText(ref, workspaceText(details), { replyMarkup: workspaceKeyboard() });
		} catch (error) {
			await sendText(ref, errorText('Unable to load workspace', error), {
				replyMarkup: commandCenterKeyboard(),
			});
		}
		return;
	}

	if (action === 'ux:invite') {
		if (!authContext) {
			await sendText(ref, convexRequiredText(), { replyMarkup: commandCenterKeyboard() });
			return;
		}
		await sendWorkspaceInvite(env, ref, authContext);
		return;
	}

	if (action === 'ux:billing') {
		if (!authContext) {
			await sendText(ref, convexRequiredText(), { replyMarkup: commandCenterKeyboard() });
			return;
		}
		await sendText(ref, billingText(authContext), { replyMarkup: billingChoiceKeyboard() });
		return;
	}

	if (action === 'ux:billing:pro' || action === 'ux:billing:team') {
		if (!authContext) {
			await sendText(ref, convexRequiredText(), { replyMarkup: commandCenterKeyboard() });
			return;
		}
		await sendBillingCheckout(env, ref, authContext, action === 'ux:billing:team' ? 'team' : 'pro');
		return;
	}

	if (action === 'ux:examples') {
		await sendText(ref, examplesText(), { replyMarkup: examplesKeyboard() });
		return;
	}

	if (action === 'ux:new:ask') {
		await sendText(ref, newSessionConfirmText(await getEffectiveConversationState(env, conversationId, authContext)), {
			replyMarkup: newSessionConfirmKeyboard(),
		});
		return;
	}

	if (action === 'ux:new:confirm') {
		const current = await getEffectiveConversationState(env, conversationId, authContext);
		const state = await updateEffectiveConversationState(env, conversationId, authContext, {
			newSession: true,
			modelKey: current.modelKey,
		});
		await sendText(ref, newSessionStartedText(state), { replyMarkup: commandCenterKeyboard() });
		return;
	}

	const state = await getEffectiveConversationState(env, conversationId, authContext);
	await sendText(ref, ['# New session cancelled', '', sessionText(state)].join('\n'), {
		replyMarkup: commandCenterKeyboard(),
	});
}

export function postMessage(env: TelegramReplyTargetBindingEnv, agentId: string) {
	return defineTool({
		name: 'post_telegram_message',
		description:
			'Post a richly formatted message to the Telegram conversation for the current teacher turn. The text is sent as Telegram Rich Markdown, so use concise headings, bullet lists, task checkboxes (`- [ ]` and `- [x]`), tables, fenced code blocks, block quotes, and details blocks when they make the answer clearer. Always pass the replyTargetId from the telegram input unchanged. If the telegram.message input includes draftId, pass it here unchanged so the answer can be streamed as a Telegram draft before it is persisted.',
		parameters: {
			type: 'object',
			properties: {
				text: {
					type: 'string',
					description:
						'Telegram Rich Markdown to send. Keep formatting valid: close code fences, keep tables aligned, and use task-list checkboxes only for real checklist/status items.',
					minLength: 1,
				},
				draftId: {
					type: 'number',
					description: 'The draftId from the telegram.message input, when present.',
					minimum: 1,
				},
				replyTargetId: {
					type: 'string',
					description: 'The replyTargetId from the current telegram.message or telegram.callback_query input.',
					minLength: 1,
				},
			},
			required: ['text', 'replyTargetId'],
			additionalProperties: false,
		},
		async execute({ text, draftId, replyTargetId }) {
			const ref = await getTelegramReplyTarget(env, agentId, replyTargetId);
			console.log('[telegram:send] sending message', {
				chatId: ref.chatId,
				type: ref.type,
				textLength: text.length,
				hasDraftId: typeof draftId === 'number',
				replyTargetId,
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

async function prepareTelegramReplyTarget(
	env: TelegramReplyTargetBindingEnv,
	ref: TelegramConversationRef,
	agentId: string,
	updateId: number,
): Promise<string | undefined> {
	try {
		return await createTelegramReplyTarget(env, agentId, ref, updateId);
	} catch (error) {
		await sendText(ref, errorText('Telegram reply routing unavailable', error), {
			replyMarkup: commandCenterKeyboard(),
		});
		return undefined;
	}
}

async function createTelegramReplyTarget(
	env: TelegramReplyTargetBindingEnv,
	agentId: string,
	ref: TelegramConversationRef,
	updateId: number,
): Promise<string> {
	const replyTargetId = newReplyTargetId(updateId);
	const stub = stateStore(env);
	if (!stub) {
		if (!parseTelegramConversationRefFromAgentId(agentId)) {
			throw new Error('TELEGRAM_BOT_STATE Durable Object binding is required for shared workspace replies.');
		}
		return replyTargetId;
	}

	const response = await stub.fetch(
		new Request('https://telegram-bot-state/reply-target', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				agentId,
				replyTargetId,
				ref,
				updateId,
			}),
		}),
	);
	if (!response.ok) {
		throw new Error(`Unable to store Telegram reply target (${response.status}): ${await response.text()}`);
	}

	return (await runEffect(responseJson(response, TelegramReplyTargetResponseSchema, 'telegram reply target response'))).replyTargetId;
}

async function getTelegramReplyTarget(
	env: TelegramReplyTargetBindingEnv,
	agentId: string,
	replyTargetId: string,
): Promise<TelegramConversationRef> {
	const stub = stateStore(env);
	if (stub) {
		const url = new URL('https://telegram-bot-state/reply-target');
		url.searchParams.set('agentId', agentId);
		url.searchParams.set('replyTargetId', replyTargetId);
		const response = await stub.fetch(new Request(url));
		if (response.ok) {
			return (
				(await runEffect(responseJson(response, TelegramReplyTargetDocumentSchema, 'telegram reply target document'))) as {
					ref: TelegramConversationRef;
				}
			).ref;
		}
		console.warn('[telegram:send] unable to read reply target', {
			agentId,
			replyTargetId,
			status: response.status,
			body: await response.text(),
		});
	}

	const fallback = parseTelegramConversationRefFromAgentId(agentId);
	if (fallback) {
		return fallback;
	}

	throw new Error('Telegram reply target expired or is unavailable. Ask the user to send the message again.');
}

function parseTelegramConversationRefFromAgentId(agentId: string): TelegramConversationRef | undefined {
	try {
		return channel.parseConversationKey(parseTelegramAgentId(agentId).baseConversationId);
	} catch {
		return undefined;
	}
}

function newReplyTargetId(updateId: number): string {
	const bytes = crypto.getRandomValues(new Uint8Array(6));
	const suffix = Array.from(bytes, (byte) => byte.toString(36).padStart(2, '0')).join('');
	return `rt_${Math.max(0, updateId).toString(36)}_${suffix}`;
}

async function syncMessageAuthContext(
	env: TelegramChannelBindings,
	message: Message,
	conversationId: string,
): Promise<SyncedTelegramContext | undefined> {
	if (!isConvexConfigured(env)) {
		return undefined;
	}
	if (!message.from) {
		return undefined;
	}
	try {
		const state = await getConversationState(env, conversationId).catch(() => undefined);
		return await syncTelegramContext(env, {
			telegramUser: telegramUserProfile(message.from),
			telegramChat: telegramChatProfile(message.chat),
			conversationId,
			...(state?.workspaceId ? { activeWorkspaceId: state.workspaceId } : {}),
		});
	} catch (error) {
		console.warn('[telegram:convex] unable to sync message context', {
			chatId: message.chat.id,
			conversationId,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

async function syncCallbackAuthContext(
	env: TelegramChannelBindings,
	from: {
		id: number;
		is_bot: boolean;
		first_name: string;
		last_name?: string;
		username?: string;
		language_code?: string;
	},
	message: Message,
	conversationId: string,
): Promise<SyncedTelegramContext | undefined> {
	if (!isConvexConfigured(env)) {
		return undefined;
	}
	try {
		const state = await getConversationState(env, conversationId).catch(() => undefined);
		return await syncTelegramContext(env, {
			telegramUser: telegramUserProfile(from),
			telegramChat: telegramChatProfile(message.chat),
			conversationId,
			...(state?.workspaceId ? { activeWorkspaceId: state.workspaceId } : {}),
		});
	} catch (error) {
		console.warn('[telegram:convex] unable to sync callback context', {
			chatId: message.chat.id,
			conversationId,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

function telegramUserProfile(user: {
	id: number;
	is_bot: boolean;
	first_name: string;
	last_name?: string;
	username?: string;
	language_code?: string;
}): TelegramUserProfile {
	return {
		id: String(user.id),
		isBot: user.is_bot,
		firstName: user.first_name,
		lastName: user.last_name,
		username: user.username,
		languageCode: user.language_code,
	};
}

function telegramChatProfile(chat: Message['chat']): TelegramChatProfile {
	return {
		id: String(chat.id),
		type: chat.type,
		title: 'title' in chat ? chat.title : undefined,
		username: 'username' in chat ? chat.username : undefined,
		firstName: 'first_name' in chat ? chat.first_name : undefined,
		lastName: 'last_name' in chat ? chat.last_name : undefined,
	};
}

function telegramAuthPayload(authContext: SyncedTelegramContext): TelegramAuthPayload {
	return {
		userId: authContext.user.id,
		userDisplayName: authContext.user.displayName,
		workspaceId: authContext.workspace.id,
		workspaceName: authContext.workspace.name,
		membershipRole: authContext.membership.role,
		plan: authContext.workspace.plan,
		billingMode: authContext.workspace.billingMode,
	};
}

async function getEffectiveConversationState(
	env: TelegramChannelBindings,
	conversationId: string,
	authContext: SyncedTelegramContext | undefined,
): Promise<TelegramStateDocument> {
	return withWorkspaceState(
		await getConversationState(env, stateScopeId(conversationId, authContext)),
		authContext,
	);
}

function withWorkspaceState(
	state: TelegramStateDocument,
	authContext: SyncedTelegramContext | undefined,
): TelegramStateDocument {
	if (!authContext) {
		return state;
	}
	return {
		...state,
		modelKey: authContext.workspace.defaultModelKey,
		workspaceId: authContext.workspace.id,
	};
}

async function selectModelForConversation(
	env: TelegramChannelBindings,
	conversationId: string,
	authContext: SyncedTelegramContext | undefined,
	modelKey: TelegramModelKey,
): Promise<TelegramStateDocument> {
	if (authContext) {
		await setConvexWorkspaceModel(env, {
			workspaceId: authContext.workspace.id,
			userId: authContext.user.id,
			modelKey,
		});
	}

	return withWorkspaceState(
		await updateConversationState(env, stateScopeId(conversationId, authContext), { modelKey }),
		authContext
			? {
					...authContext,
					workspace: {
						...authContext.workspace,
						defaultModelKey: modelKey,
						billingMode: modelKey === 'openai' ? 'byok' : 'platform',
					},
				}
			: undefined,
	);
}

async function updateEffectiveConversationState(
	env: TelegramChannelBindings,
	conversationId: string,
	authContext: SyncedTelegramContext | undefined,
	patch: { modelKey?: TelegramModelKey; newSession?: boolean; workspaceId?: string | null },
): Promise<TelegramStateDocument> {
	return withWorkspaceState(
		await updateConversationState(env, stateScopeId(conversationId, authContext), patch),
		authContext,
	);
}

function stateScopeId(
	conversationId: string,
	authContext: SyncedTelegramContext | undefined,
): string {
	return authContext ? workspaceStateScopeId(authContext.workspace.id) : conversationId;
}

function workspaceStateScopeId(workspaceId: string): string {
	return `workspace:${workspaceId}`;
}

async function ensureSelectedModelReady(
	env: TelegramChannelBindings,
	ref: TelegramConversationRef,
	state: TelegramAgentState,
	authContext: SyncedTelegramContext | undefined,
): Promise<boolean> {
	if (state.modelKey !== 'openai' && authContext?.workspace.plan === 'free') {
		await sendText(ref, platformBillingRequiredText(authContext), {
			replyMarkup: billingChoiceKeyboard(),
		});
		return false;
	}
	if (state.modelKey !== 'openai') {
		return true;
	}
	if (!authContext) {
		await sendText(ref, 'OpenAI BYOK requires Convex workspace sign-in. Configure CONVEX_URL first.', {
			replyMarkup: modelKeyboard(state),
		});
		return false;
	}
	return true;
}

async function handleBillingCommand(
	env: TelegramChannelBindings,
	ref: TelegramConversationRef,
	authContext: SyncedTelegramContext,
	args: string,
): Promise<void> {
	const plan = parsePaidWorkspacePlan(args) ?? 'pro';
	await sendBillingCheckout(env, ref, authContext, plan);
}

async function sendBillingCheckout(
	env: TelegramChannelBindings,
	ref: TelegramConversationRef,
	authContext: SyncedTelegramContext,
	plan: PaidWorkspacePlan,
): Promise<void> {
	if (!isPolarBillingConfigured(env)) {
		await sendText(ref, polarBillingUnavailableText(), { replyMarkup: commandCenterKeyboard() });
		return;
	}

	try {
		const successUrl = new URL('/billing/polar/success', publicBaseUrl(env));
		const cancelUrl = new URL('/billing/polar/cancel', publicBaseUrl(env));
		const checkout = await createPolarCheckoutSession(env, {
			workspaceId: authContext.workspace.id,
			userId: authContext.user.id,
			plan,
			successUrl: successUrl.toString(),
			cancelUrl: cancelUrl.toString(),
		});
		await sendText(ref, billingCheckoutText(checkout.workspace.name, checkout.plan), {
			replyMarkup: billingCheckoutKeyboard(checkout.url),
		});
	} catch (error) {
		await sendText(ref, errorText('Unable to start billing checkout', error), {
			replyMarkup: billingChoiceKeyboard(),
		});
	}
}

async function sendWorkspaceInvite(
	env: TelegramChannelBindings,
	ref: TelegramConversationRef,
	authContext: SyncedTelegramContext,
): Promise<void> {
	try {
		const invite = await createWorkspaceInvite(env, {
			workspaceId: authContext.workspace.id,
			userId: authContext.user.id,
			code: inviteCode(),
		});
		await sendText(ref, workspaceInviteText(invite.code, invite.workspace.name), {
			replyMarkup: workspaceKeyboard(),
		});
	} catch (error) {
		await sendText(ref, errorText('Unable to create workspace invite', error), {
			replyMarkup: commandCenterKeyboard(),
		});
	}
}

async function handleKeyCommand(
	env: TelegramChannelBindings,
	ref: TelegramConversationRef,
	authContext: SyncedTelegramContext,
	args: string,
	sourceMessage: Message,
): Promise<void> {
	const parsed = parseKeyCommand(args);
	if (!parsed) {
		await sendText(ref, keyCommandHelpText(), { replyMarkup: modelKeyboard(defaultTelegramAgentState()) });
		return;
	}

	try {
		const stored = await storeWorkspaceModelApiKey(env, {
			workspaceId: authContext.workspace.id,
			provider: 'openai',
			apiKey: parsed.apiKey,
		});
		const result = await setModelCredential(env, {
			workspaceId: authContext.workspace.id,
			userId: authContext.user.id,
			provider: 'openai',
			modelId: parsed.modelId,
			vaultKey: stored.vaultKey,
		});
		await tryDeleteSensitiveMessage(ref, sourceMessage.message_id);
		await sendText(ref, keySavedText(result.workspace.name, result.credential.modelId), {
			replyMarkup: modelKeyboard({
				...defaultTelegramAgentState(),
				modelKey: 'openai',
				workspaceId: authContext.workspace.id,
			}),
		});
	} catch (error) {
		await sendText(ref, errorText('Unable to save model key', error), {
			replyMarkup: commandCenterKeyboard(),
		});
	}
}

function parseKeyCommand(args: string): { apiKey: string; modelId: string } | undefined {
	const [provider, apiKey, modelId] = args.trim().split(/\s+/);
	if (provider !== 'openai' || !apiKey) {
		return undefined;
	}
	return {
		apiKey,
		modelId: modelId || OPENAI_BYOK_DEFAULT_MODEL_ID,
	};
}

function parsePaidWorkspacePlan(args: string): PaidWorkspacePlan | undefined {
	const first = args.trim().split(/\s+/)[0]?.toLowerCase();
	return first === 'team' ? 'team' : first === 'pro' ? 'pro' : undefined;
}

async function tryDeleteSensitiveMessage(
	ref: TelegramConversationRef,
	messageId: number,
): Promise<void> {
	if (ref.type !== 'chat') {
		return;
	}
	try {
		await client.deleteMessage(ref.chatId, messageId);
	} catch (error) {
		console.warn('[telegram:key] unable to delete sensitive key message', {
			chatId: ref.chatId,
			messageId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

function inviteCode(): string {
	const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
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

	return runEffect(
		annotateFlow(
			retryIdempotent(
				Effect.gen(function* () {
					const response = yield* Effect.tryPromise({
						try: () => stub.fetch(stateRequest(conversationId)),
						catch: (cause) =>
							new AuthBridgeError({
								operation: 'telegram_bot_state.read',
								message: 'Unable to read Telegram bot state before receiving a response.',
								cause,
							}),
					});
					if (!response.ok) {
						const body = yield* Effect.promise(() => response.text().catch(() => ''));
						return yield* Effect.fail(
							new AuthBridgeError({
								operation: 'telegram_bot_state.read',
								message: `Unable to read Telegram bot state (${response.status}): ${body}`,
							}),
						);
					}
					return yield* responseJson(response, TelegramStateDocumentSchema, 'telegram bot state');
				}),
			),
			{ conversationId },
		),
	);
}

async function updateConversationState(
	env: TelegramChannelBindings,
	conversationId: string,
	patch: { modelKey?: TelegramModelKey; newSession?: boolean; workspaceId?: string | null },
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
	return runEffect(responseJson(response, TelegramStateDocumentSchema, 'telegram bot state'));
}

function stateStore(env: TelegramReplyTargetBindingEnv): DurableObjectStub | undefined {
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
): Promise<Array<{ message_id: number }>> {
	const chunks = splitTelegramRichMarkdown(text);
	const messages: Array<{ message_id: number }> = [];
	for (const [index, chunk] of chunks.entries()) {
		try {
			messages.push(
				await (client as unknown as TelegramRichApi).sendRichMessage(
					ref.chatId,
					{ markdown: chunk },
					telegramSendOptions(
						ref,
						index === chunks.length - 1 ? options.replyMarkup : undefined,
					),
				),
			);
		} catch (error) {
			console.warn('[telegram:rich] falling back to plain text message', error);
			messages.push(
				...(await sendPlainTextChunks(ref, chunks.slice(index).join('\n\n'), options)),
			);
			break;
		}
	}
	return messages;
}

async function sendPlainTextChunks(
	ref: TelegramConversationRef,
	text: string,
	options: { replyMarkup?: InlineKeyboardMarkup } = {},
): Promise<Array<{ message_id: number }>> {
	const chunks = splitTelegramText(text);
	const messages: Array<{ message_id: number }> = [];
	for (const [index, chunk] of chunks.entries()) {
		messages.push(
			await client.sendMessage(
				ref.chatId,
				chunk,
				telegramSendOptions(
					ref,
					index === chunks.length - 1 ? options.replyMarkup : undefined,
				),
			),
		);
	}
	return messages;
}

function telegramSendOptions(
	ref: TelegramConversationRef,
	replyMarkup?: InlineKeyboardMarkup,
): TelegramSendOptions {
	return {
		...(ref.type === 'business-chat' ? { business_connection_id: ref.businessConnectionId } : {}),
		...(ref.messageThreadId ? { message_thread_id: ref.messageThreadId } : {}),
		...(ref.directMessagesTopicId ? { direct_messages_topic_id: ref.directMessagesTopicId } : {}),
		...(replyMarkup ? { reply_markup: replyMarkup } : {}),
	};
}

type TelegramProgressMode = 'message_draft' | 'chat_action' | 'none';

async function startTelegramProgress(
	ref: TelegramConversationRef,
	draftId: number,
): Promise<TelegramProgressMode> {
	if (canUseMessageDraft(ref)) {
		try {
			await (client as unknown as TelegramRichApi).sendRichMessageDraft(
				ref.chatId,
				draftId,
				{ html: '<tg-thinking>Thinking...</tg-thinking>' },
				ref.messageThreadId ? { message_thread_id: ref.messageThreadId } : undefined,
			);
			return 'message_draft';
		} catch (error) {
			console.warn('[telegram:rich-draft] unable to start rich draft progress', error);
			try {
				await client.sendMessageDraft(ref.chatId, draftId, '', {
					...(ref.messageThreadId ? { message_thread_id: ref.messageThreadId } : {}),
				});
				return 'message_draft';
			} catch (plainDraftError) {
				console.warn('[telegram:draft] unable to start draft progress', plainDraftError);
			}
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

	let usePlainDraft = false;
	try {
		for (const chunk of chunks) {
			if (usePlainDraft) {
				await client.sendMessageDraft(ref.chatId, draftId, chunk, {
					...(ref.messageThreadId ? { message_thread_id: ref.messageThreadId } : {}),
				});
			} else {
				try {
					await (client as unknown as TelegramRichApi).sendRichMessageDraft(
						ref.chatId,
						draftId,
						{ markdown: chunk },
						ref.messageThreadId ? { message_thread_id: ref.messageThreadId } : undefined,
					);
				} catch (error) {
					console.warn('[telegram:rich-draft] falling back to plain draft', error);
					usePlainDraft = true;
					await client.sendMessageDraft(ref.chatId, draftId, chunk, {
						...(ref.messageThreadId ? { message_thread_id: ref.messageThreadId } : {}),
					});
				}
			}
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

function splitTelegramRichMarkdown(text: string): string[] {
	if (text.length <= TELEGRAM_RICH_MARKDOWN_LIMIT) {
		return text ? [text] : [''];
	}

	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > 0) {
		if (remaining.length <= TELEGRAM_RICH_MARKDOWN_LIMIT) {
			chunks.push(remaining);
			break;
		}

		const boundary = nearestMarkdownBoundary(remaining, TELEGRAM_RICH_MARKDOWN_LIMIT);
		chunks.push(remaining.slice(0, boundary).trimEnd());
		remaining = remaining.slice(boundary).trimStart();
	}
	return chunks.length ? chunks : [''];
}

function splitTelegramText(text: string): string[] {
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > 0) {
		if (remaining.length <= TELEGRAM_TEXT_LIMIT) {
			chunks.push(remaining);
			break;
		}

		const boundary = nearestWordBoundary(remaining, TELEGRAM_TEXT_LIMIT);
		chunks.push(remaining.slice(0, boundary).trimEnd());
		remaining = remaining.slice(boundary).trimStart();
	}
	return chunks.length ? chunks : [''];
}

function nearestMarkdownBoundary(text: string, target: number): number {
	const bounded = Math.min(Math.max(target, 1), text.length);
	let inFence = false;
	let fenceMarker = '';
	let lineStart = 0;
	let lastParagraph = -1;
	let lastLine = -1;

	for (let index = 0; index < bounded; index += 1) {
		if (text[index] !== '\n') {
			continue;
		}

		const line = text.slice(lineStart, index);
		const fence = /^(?: {0,3})(`{3,}|~{3,})/.exec(line);
		if (fence && (!inFence || fence[1][0] === fenceMarker)) {
			inFence = !inFence;
			fenceMarker = inFence ? fence[1][0] : '';
		}

		let newlineEnd = index + 1;
		while (newlineEnd < text.length && text[newlineEnd] === '\n') {
			newlineEnd += 1;
		}

		if (!inFence) {
			lastLine = newlineEnd;
			if (newlineEnd - index > 1) {
				lastParagraph = newlineEnd;
			}
		}

		lineStart = newlineEnd;
		index = newlineEnd - 1;
	}

	if (lastParagraph >= bounded - 3000) {
		return lastParagraph;
	}
	if (lastLine >= bounded - 1000) {
		return lastLine;
	}
	return nearestWordBoundary(text, bounded);
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

function commandCenterText(
	state: TelegramAgentState,
	authContext?: SyncedTelegramContext,
): string {
	return [
		'# Teacher bot',
		`**Model:** ${TELEGRAM_MODEL_OPTIONS[state.modelKey].label}`,
		`**Session:** ${mdInlineCode(state.sessionId)}`,
		authContext ? `**Workspace:** ${authContext.workspace.name}` : undefined,
		authContext ? `**Plan:** ${authContext.workspace.plan}` : undefined,
		'',
		'Send a topic or question directly, or use the buttons below.',
		'',
		'**Commands**',
		'- `/workspace` - show the current study workspace.',
		'- `/billing` - subscribe for platform-hosted models.',
		'- `/invite` - create a workspace invite code.',
		'- `/members` - list workspace members.',
		'- `/model` - choose ZAI, Codex, or OpenAI BYOK.',
		'- `/key openai <api-key> [model]` - attach a workspace OpenAI key.',
		'- `/codex` - connect or check ChatGPT credentials.',
		'- `/new` - start a clean session.',
		'- `/pages` - open hosted lesson pages.',
		'- `/session` - show the current session.',
		'- `/whoami` - show your Telegram user id.',
	]
		.filter((line): line is string => line !== undefined)
		.join('\n');
}

function sessionText(state: TelegramAgentState, authContext?: SyncedTelegramContext): string {
	return [
		'# Current session',
		`**Session:** ${mdInlineCode(state.sessionId)}`,
		`**Model:** ${TELEGRAM_MODEL_OPTIONS[state.modelKey].label}`,
		authContext ? `**Workspace:** ${authContext.workspace.name}` : undefined,
		'',
		'Use /new to start fresh, or tap New session.',
	]
		.filter((line): line is string => line !== undefined)
		.join('\n');
}

function modelText(state: TelegramAgentState, authContext?: SyncedTelegramContext): string {
	const model = TELEGRAM_MODEL_OPTIONS[state.modelKey];
	return [
		'# Model picker',
		`**Current:** ${model.label}`,
		`**Session:** ${mdInlineCode(state.sessionId)}`,
		authContext ? `**Workspace:** ${authContext.workspace.name}` : undefined,
		'',
		modelOptionsText(),
		'',
		authContext?.workspace.plan === 'free'
			? 'Platform-hosted models require /billing. OpenAI BYOK works after /key setup.'
			: 'This workspace can use platform-hosted models. OpenAI BYOK still uses the workspace key.',
		'Tap a model, or use /model zai, /model codex, or /model openai.',
		'Use /key openai <api-key> [model] before selecting OpenAI BYOK.',
		model.note ? `> ${model.note}` : undefined,
	]
		.filter(Boolean)
		.join('\n');
}

function unknownModelText(input: string): string {
	return [
		'# Unknown model',
		`Requested: ${mdInlineCode(input)}`,
		'',
		modelOptionsText(),
		'',
		'Tap a model, or use /model zai, /model codex, or /model openai.',
	].join('\n');
}

function modelSwitchedText(
	state: TelegramAgentState,
	modelKey: TelegramModelKey,
	alreadySelected: boolean,
): string {
	const model = TELEGRAM_MODEL_OPTIONS[modelKey];
	return [
		alreadySelected ? '# Model unchanged' : '# Model switched',
		`**Model:** ${model.label}`,
		`**Session:** ${mdInlineCode(state.sessionId)}`,
		state.workspaceId ? `**Workspace id:** ${mdInlineCode(state.workspaceId)}` : undefined,
		model.note ? `> ${model.note}` : undefined,
		'Use /new to start a clean session on this model.',
	]
		.filter(Boolean)
		.join('\n');
}

function newSessionConfirmText(state: TelegramAgentState): string {
	return [
		'# Start a new session?',
		`**Current session:** ${mdInlineCode(state.sessionId)}`,
		`**Model:** ${TELEGRAM_MODEL_OPTIONS[state.modelKey].label}`,
		'',
		'- [x] Keep old history stored.',
		'- [x] Stop using old history for new messages.',
	].join('\n');
}

function newSessionStartedText(state: TelegramAgentState): string {
	return [
		'# New session started',
		`- [x] Session: ${mdInlineCode(state.sessionId)}`,
		`- [x] Model: ${TELEGRAM_MODEL_OPTIONS[state.modelKey].label}`,
		'',
		'Send a topic when ready.',
	].join('\n');
}

function examplesText(): string {
	return [
		'# Prompt starters',
		'- Teach me TypeScript generics in 10 minutes.',
		'- Quiz me on the latest lesson page.',
		'- Make a practice exercise with hints.',
		'- Explain this code step by step: `<paste code>`',
		'- Create a short lesson page about `<topic>`.',
	].join('\n');
}

function workspaceText(details: WorkspaceDetails): string {
	const memberLines = details.members
		.slice(0, 20)
		.map((member) => {
			const handle = member.username ? ` @${member.username}` : '';
			return `- ${member.displayName}${handle} - ${member.role}`;
		});
	return [
		'# Study workspace',
		`**Name:** ${details.workspace.name}`,
		`**Model:** ${TELEGRAM_MODEL_OPTIONS[details.workspace.defaultModelKey].label}`,
		`**Plan:** ${details.workspace.plan}`,
		`**Billing:** ${details.workspace.billingMode === 'byok' ? 'bring your own key' : 'platform'}`,
		`**Your role:** ${details.membership.role}`,
		'',
		'**Members**',
		...(memberLines.length ? memberLines : ['No active members found.']),
		details.members.length > memberLines.length
			? `- and ${details.members.length - memberLines.length} more`
			: undefined,
	]
		.filter((line): line is string => line !== undefined)
		.join('\n');
}

function workspaceInviteText(code: string, workspaceName: string): string {
	return [
		'# Workspace invite',
		`**Workspace:** ${workspaceName}`,
		`**Invite code:** ${mdInlineCode(code)}`,
		'',
		'Friends can join with:',
		mdCodeBlock(`/join ${code}`, 'text'),
		'In a Telegram group, anyone who talks to the bot is also signed into that group workspace automatically.',
	].join('\n');
}

function joinedWorkspaceText(workspace: { name: string; defaultModelKey: TelegramModelKey }): string {
	return [
		'# Joined workspace',
		`**Workspace:** ${workspace.name}`,
		`**Model:** ${TELEGRAM_MODEL_OPTIONS[workspace.defaultModelKey].label}`,
		'',
		'- [x] This Telegram conversation now uses that workspace.',
		'Use /workspace to see members and /invite to add more friends.',
	].join('\n');
}

function convexRequiredText(): string {
	return [
		'# Workspace sign-in unavailable',
		'Convex is not configured for this Worker yet.',
		'Set CONVEX_URL and deploy the Convex schema/functions to enable signed-in users and study workspaces.',
	].join('\n');
}

function billingText(authContext: SyncedTelegramContext): string {
	return [
		'# Workspace billing',
		`**Workspace:** ${authContext.workspace.name}`,
		`**Current plan:** ${authContext.workspace.plan}`,
		'',
		'Subscribe to use platform-hosted ZAI/Codex models, or attach an OpenAI key with /key openai <api-key> [model].',
	].join('\n');
}

function platformBillingRequiredText(authContext: SyncedTelegramContext): string {
	return [
		'# Subscription required',
		`**Workspace:** ${authContext.workspace.name}`,
		'',
		'Platform-hosted models require an active workspace subscription.',
		'Use Billing to subscribe, or attach your own OpenAI key with /key openai <api-key> [model].',
	].join('\n');
}

function polarBillingUnavailableText(): string {
	return [
		'# Billing unavailable',
		'Polar billing is not configured yet.',
		'Set CONVEX_URL on the Worker and POLAR_ORGANIZATION_TOKEN, POLAR_WEBHOOK_SECRET, POLAR_PRO_PRODUCT_ID, and POLAR_TEAM_PRODUCT_ID in Convex to enable subscriptions.',
	].join('\n');
}

function billingCheckoutText(workspaceName: string, plan: PaidWorkspacePlan): string {
	return [
		'# Billing checkout',
		`**Workspace:** ${workspaceName}`,
		`**Plan:** ${plan}`,
		'',
		'Open Polar Checkout to activate platform-hosted models for this workspace.',
	].join('\n');
}

function keyCommandHelpText(): string {
	return [
		'# Model key setup',
		'Use this command:',
		mdCodeBlock('/key openai <api-key> [model]', 'text'),
		`Default model: ${mdInlineCode(OPENAI_BYOK_DEFAULT_MODEL_ID)}`,
		'The key is stored in the workspace credential vault. Convex stores only metadata and a vault key reference.',
	].join('\n');
}

function keySavedText(workspaceName: string, modelId: string): string {
	return [
		'# OpenAI key connected',
		`**Workspace:** ${workspaceName}`,
		`**Model:** ${mdInlineCode(modelId)}`,
		'',
		'- [x] Secret stored in the credential vault.',
		'- [x] Convex workspace model switched to OpenAI BYOK.',
		'- [x] The bot tried to delete the Telegram message containing the key.',
	].join('\n');
}

function commandCenterKeyboard(): InlineKeyboardMarkup {
	return inlineKeyboard([
		[
			callbackButton('New session', 'ux:new:ask'),
			callbackButton('Model', 'ux:model'),
		],
		[
			callbackButton('Workspace', 'ux:workspace'),
			callbackButton('Billing', 'ux:billing'),
		],
		[
			callbackButton('Invite', 'ux:invite'),
			callbackButton('Pages', 'ux:pages'),
		],
		[
			callbackButton('Codex login', 'ux:codex'),
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
		[callbackButton(modelButtonText('openai', state.modelKey), 'ux:model:openai')],
		[callbackButton('Billing', 'ux:billing')],
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

function workspaceKeyboard(): InlineKeyboardMarkup {
	return inlineKeyboard([
		[
			callbackButton('Invite', 'ux:invite'),
			callbackButton('Model', 'ux:model'),
		],
		[callbackButton('Billing', 'ux:billing')],
		[callbackButton('Menu', 'ux:menu')],
	]);
}

function billingChoiceKeyboard(): InlineKeyboardMarkup {
	return inlineKeyboard([
		[
			callbackButton('Pro billing', 'ux:billing:pro'),
			callbackButton('Team billing', 'ux:billing:team'),
		],
		[
			callbackButton('Model', 'ux:model'),
			callbackButton('Menu', 'ux:menu'),
		],
	]);
}

function billingCheckoutKeyboard(url: string): InlineKeyboardMarkup {
	return inlineKeyboard([
		[urlButton('Open Polar Checkout', url)],
		[callbackButton('Menu', 'ux:menu')],
	]);
}

function modelButtonText(modelKey: TelegramModelKey, currentModelKey: TelegramModelKey): string {
	const label = modelKey === 'zai' ? 'ZAI' : modelKey === 'codex' ? 'Codex' : 'OpenAI BYOK';
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
		? '# Telegram user id\n\nTelegram did not include a user id for this message.'
		: [
				'# Telegram user id',
				`Your Telegram user id is ${mdInlineCode(senderId)}.`,
				'',
				`Set ${mdInlineCode('TELEGRAM_ALLOWED_USER_IDS')} to this value to make the bot answer only to you.`,
			].join('\n');
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
			'# Codex login',
			`**${codexStatusLine(status)}**`,
			'',
			'Tap the button below, open the Codex login page, and approve the ChatGPT account.',
			'',
			`- Code: ${mdInlineCode(start.userCode)}`,
			`- Expires: ${mdInlineCode(start.expiresAt)}`,
			'',
			'After approval, the browser page stores the credentials automatically.',
		].join('\n'),
		replyMarkup: codexLoginKeyboard(loginUrl.toString()),
	};
}

async function codexStatusResponse(env: TelegramChannelBindings): Promise<TelegramTextResponse> {
	return {
		text: ['# Codex auth', `**${codexStatusLine(await readCodexStatus(env))}**`].join('\n'),
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

	return runEffect(responseJson(response, CodexDeviceStartResponseSchema, 'codex device login start'));
}

async function readCodexStatus(env: TelegramChannelBindings): Promise<CodexStatusResponse> {
	if (!env.CODEX_AUTH_VAULT) {
		throw new Error('CODEX_AUTH_VAULT Durable Object binding is not configured.');
	}

	return runEffect(
		retryIdempotent(
			Effect.gen(function* () {
				const response = yield* Effect.tryPromise({
					try: () => env.CODEX_AUTH_VAULT!.getByName('default').fetch(new Request('https://codex-auth-vault/status')),
					catch: (cause) =>
						new AuthBridgeError({
							operation: 'codex_auth.status',
							message: 'Unable to read Codex auth status before receiving a response.',
							cause,
						}),
					});
					if (!response.ok) {
						const body = yield* Effect.promise(() => response.text().catch(() => ''));
						return yield* Effect.fail(
							new AuthBridgeError({
								operation: 'codex_auth.status',
								message: `Unable to read Codex auth status (${response.status}): ${body}`,
							}),
						);
					}
				return yield* responseJson(response, CodexStatusResponseSchema, 'codex auth status');
			}),
		),
	);
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
	return errorText('Codex login failed', error);
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
			'# Hosted pages',
			`**Session:** ${mdInlineCode(state.sessionId)}`,
			'',
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
			'# Hosted pages',
			`**Reference:** ${referencedPagesLabel(resolved)}`,
			'',
			indexUrl,
			referencedPageUrl ? `**Referenced page:** ${referencedPageUrl}` : undefined,
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
		return `session ${mdInlineCode(resolved.sessionId ?? resolved.shareId)} (${TELEGRAM_MODEL_OPTIONS[resolved.modelKey ?? 'zai'].label})`;
	}
	if (resolved.source === 'share-id') {
		return `share id ${mdInlineCode(resolved.shareId)}`;
	}
	return 'referenced session';
}

function modelOptionsText(): string {
	return Object.values(TELEGRAM_MODEL_OPTIONS)
		.map((option) => `- ${mdInlineCode(option.key)}: ${option.label}`)
		.join('\n');
}

function errorText(title: string, error: unknown): string {
	return [`# ${title}`, '', mdCodeBlock(renderUserError(error))].join('\n');
}

function mdInlineCode(value: string | number): string {
	const text = String(value);
	const longestRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
	const fence = '`'.repeat(longestRun + 1);
	const needsPadding = text.startsWith('`') || text.endsWith('`');
	return needsPadding ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

function mdCodeBlock(value: string, language = 'text'): string {
	const longestRun = Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
	const fence = '`'.repeat(Math.max(3, longestRun + 1));
	return `${fence}${language}\n${value}\n${fence}`;
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
