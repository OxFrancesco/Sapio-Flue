import { InvalidTelegramConversationKeyError } from '@flue/telegram';
import { createAgent, type AgentRouteHandler } from '@flue/runtime';
import teach from '../../.agents/skills/teach/SKILL.md' with { type: 'skill' };
import { prepareOpenAICodexProvider, type CodexAuthBindingEnv } from '../auth/openai-codex-provider';
import { channel as telegramChannel, postMessage } from '../channels/telegram';
import {
	modelSpecifierForTelegramKey,
	parseTelegramAgentId,
	TELEGRAM_MODEL_OPTIONS,
	ZAI_GLM_5_2_MODEL,
} from '../models';
import { getDefaultWorkspace, getShellSandbox } from '../sandboxes/cloudflare-shell';
import { createTeachingPageTools, type TeachingPageBindingEnv } from '../teaching-pages';

interface Env extends CodexAuthBindingEnv, TeachingPageBindingEnv {
	LOADER?: WorkerLoader;
	ZAI_API_KEY?: string;
}

export const description =
	'A stateful teaching agent that uses Matt Pocock\'s teach skill to create and maintain lesson workspaces.';

export const route: AgentRouteHandler = async (_c, next) => next();

export default createAgent<unknown, Env>(async ({ env, id }) => {
	const selection = parseTelegramAgentId(id);
	const selectedModel = selection.state
		? modelSpecifierForTelegramKey(selection.state.modelKey)
		: undefined;
	const model = await prepareOpenAICodexProvider(env, selectedModel);
	const telegramRef = parseTelegramConversationId(id);
	const telegramModel = selection.state ? TELEGRAM_MODEL_OPTIONS[selection.state.modelKey] : undefined;
	const tools = [
		...(telegramRef ? [postMessage(telegramRef)] : []),
		...createTeachingPageTools({ env, agentId: id }),
	];

	return {
		model,
		...(model === ZAI_GLM_5_2_MODEL ? { thinkingLevel: 'xhigh' as const } : {}),
		skills: [teach],
		tools,
		...(env.LOADER
			? {
					sandbox: getShellSandbox({
						workspace: getDefaultWorkspace(),
						loader: env.LOADER,
					}),
				}
			: {}),
		cwd: '/',
		instructions:
			'You are a teaching agent. When the user asks to learn a topic, use the teach skill. ' +
			'Maintain the learning workspace in the durable filesystem, keep lessons short, and ask for the mission before teaching when it is unclear. ' +
			'After creating or updating any teach-skill file under lessons/, reference/, or assets/, read the final file content if needed, then call publish_teaching_page with the workspace-relative path and full file contents so it is hosted on Cloudflare. Include the returned hosted lesson URLs in your user-facing reply. ' +
			'Use list_teaching_pages when you need the pages published in this session. When the user explicitly references a hosted teaching page URL, share id, or same-conversation session id from another session, call inspect_teaching_page_reference before relying on that page. Do not search unrelated sessions without a user-provided reference. ' +
			(telegramModel && selection.state
				? `This Telegram session is ${selection.state.sessionId} and uses ${telegramModel.label}. `
				: '') +
			(telegramRef
				? 'This session is bound to a Telegram conversation. For every telegram.message input, treat the text field as the user message and call post_telegram_message exactly once with your reply. If the input includes draftId, pass that exact draftId to post_telegram_message so Telegram can stream the reply preview before the final message is saved. Do not answer only in plain assistant text because the Telegram user cannot see it.'
				: ''),
	};
});

function parseTelegramConversationId(id: string) {
	try {
		return telegramChannel.parseConversationKey(parseTelegramAgentId(id).baseConversationId);
	} catch (error) {
		if (error instanceof InvalidTelegramConversationKeyError) {
			return undefined;
		}
		throw error;
	}
}
