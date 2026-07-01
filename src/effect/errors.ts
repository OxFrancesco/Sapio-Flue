import { Data } from 'effect';

export class ConfigMissing extends Data.TaggedError('ConfigMissing')<{
	name: string;
	message: string;
}> {}

export class ExternalHttpError extends Data.TaggedError('ExternalHttpError')<{
	operation: string;
	status: number;
	body?: string;
	message: string;
	cause?: unknown;
}> {}

export class DecodeError extends Data.TaggedError('DecodeError')<{
	source: string;
	message: string;
	cause?: unknown;
}> {}

export class TelegramSendError extends Data.TaggedError('TelegramSendError')<{
	operation: string;
	message: string;
	cause?: unknown;
}> {}

export class BillingError extends Data.TaggedError('BillingError')<{
	operation: string;
	message: string;
	cause?: unknown;
}> {}

export class AuthBridgeError extends Data.TaggedError('AuthBridgeError')<{
	operation: string;
	message: string;
	cause?: unknown;
}> {}

export type SapioEffectError =
	| ConfigMissing
	| ExternalHttpError
	| DecodeError
	| TelegramSendError
	| BillingError
	| AuthBridgeError;

export function requiredConfig(value: string | undefined, name: string): string {
	const cleaned = value?.trim();
	if (!cleaned) {
		throw new ConfigMissing({
			name,
			message: `${name} is not configured.`,
		});
	}
	return cleaned;
}

export function renderUserError(error: unknown): string {
	return redactSecrets(errorMessage(error));
}

export function errorMessage(error: unknown): string {
	if (isTaggedError(error)) {
		switch (error._tag) {
			case 'ConfigMissing':
				return error.message;
			case 'ExternalHttpError':
				return error.body
					? `${error.message}\n${error.body}`
					: error.message;
			case 'DecodeError':
				return error.message;
			case 'TelegramSendError':
			case 'BillingError':
			case 'AuthBridgeError':
				return error.message;
		}
	}

	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

export function redactSecrets(value: string): string {
	return value
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]')
		.replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '[telegram-bot-token-redacted]')
		.replace(
			/\b(?:sk|rk|whsec|sk-proj|ghp|glpat|xox[baprs])_[A-Za-z0-9_-]{8,}\b/g,
			(match) => `${match.split('_', 1)[0]}_[redacted]`,
		)
		.replace(/\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}\b/g, '[jwt-redacted]');
}

function isTaggedError(error: unknown): error is SapioEffectError {
	return (
		typeof error === 'object' &&
		error !== null &&
		'_tag' in error &&
		typeof (error as { _tag?: unknown })._tag === 'string' &&
		'message' in error &&
		typeof (error as { message?: unknown }).message === 'string'
	);
}
