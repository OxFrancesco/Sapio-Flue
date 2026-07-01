import { Context, Effect, Layer } from 'effect';

export interface TelegramService {
	readonly sendRichMessage: (
		chatId: number | string,
		richMessage: unknown,
		options?: unknown,
	) => Effect.Effect<{ message_id: number }, unknown>;
	readonly sendMessage: (
		chatId: number | string,
		text: string,
		options?: unknown,
	) => Effect.Effect<{ message_id: number }, unknown>;
	readonly sendRichMessageDraft: (
		chatId: number,
		draftId: number,
		richMessage: unknown,
		options?: unknown,
	) => Effect.Effect<true, unknown>;
	readonly sendMessageDraft: (
		chatId: number,
		draftId: number,
		text: string,
		options?: unknown,
	) => Effect.Effect<unknown, unknown>;
	readonly sendChatAction: (
		chatId: number | string,
		action: string,
		options?: unknown,
	) => Effect.Effect<unknown, unknown>;
}

export interface ConvexService {
	readonly query: <A>(name: string, args: unknown) => Effect.Effect<A, unknown>;
	readonly mutation: <A>(name: string, args: unknown) => Effect.Effect<A, unknown>;
}

export interface BotStateStore {
	readonly fetch: (request: Request) => Effect.Effect<Response, unknown>;
}

export interface TeachingPageStore {
	readonly fetch: (request: Request) => Effect.Effect<Response, unknown>;
}

export interface PolarService {
	readonly checkoutSession: (request: Request) => Effect.Effect<Response, unknown>;
}

export interface CodexAuthService {
	readonly fetch: (request: Request) => Effect.Effect<Response, unknown>;
}

export interface CredentialVault {
	readonly fetch: (request: Request) => Effect.Effect<Response, unknown>;
}

export interface RandomService {
	readonly bytes: (length: number) => Effect.Effect<Uint8Array, never>;
}

export const TelegramService = Context.GenericTag<TelegramService>('sapio/TelegramService');
export const ConvexService = Context.GenericTag<ConvexService>('sapio/ConvexService');
export const BotStateStore = Context.GenericTag<BotStateStore>('sapio/BotStateStore');
export const TeachingPageStore = Context.GenericTag<TeachingPageStore>('sapio/TeachingPageStore');
export const PolarService = Context.GenericTag<PolarService>('sapio/PolarService');
export const CodexAuthService = Context.GenericTag<CodexAuthService>('sapio/CodexAuthService');
export const CredentialVault = Context.GenericTag<CredentialVault>('sapio/CredentialVault');
export const RandomService = Context.GenericTag<RandomService>('sapio/RandomService');

export const makeLayer = <I, S>(tag: Context.Tag<I, S>, service: S): Layer.Layer<I> =>
	Layer.succeed(tag, service);

export const WebCryptoRandomLive = makeLayer(RandomService, {
	bytes: (length) =>
		Effect.sync(() => {
			const bytes = new Uint8Array(length);
			crypto.getRandomValues(bytes);
			return bytes;
		}),
});
