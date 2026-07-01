import { Cause, Duration, Effect, Exit, Option, Schedule } from 'effect';
import { ExternalHttpError } from './errors';

const IDEMPOTENT_RETRY_SCHEDULE = Schedule.jittered(
	Schedule.intersect(Schedule.recurs(2), Schedule.spaced(Duration.millis(120))),
);

export async function runEffect<A, E>(program: Effect.Effect<A, E, never>): Promise<A> {
	const exit = await Effect.runPromiseExit(program);
	if (Exit.isSuccess(exit)) {
		return exit.value;
	}
	throw causeToThrowable(exit.cause);
}

export function retryIdempotent<A, E, R>(
	program: Effect.Effect<A, E, R>,
	isRetryable: (error: E) => boolean = defaultRetryable,
): Effect.Effect<A, E, R> {
	return program.pipe(
		Effect.retry({
			schedule: IDEMPOTENT_RETRY_SCHEDULE,
			while: isRetryable,
		}),
	);
}

export function annotateFlow<A, E, R>(
	program: Effect.Effect<A, E, R>,
	annotations: Record<string, string | number | boolean | undefined>,
): Effect.Effect<A, E, R> {
	const cleaned = Object.fromEntries(
		Object.entries(annotations)
			.filter(([, value]) => value !== undefined)
			.map(([key, value]) => [key, String(value)]),
	);
	return Effect.annotateLogs(program, cleaned);
}

function causeToThrowable<E>(cause: Cause.Cause<E>): unknown {
	const failure = Cause.failureOption(cause);
	if (Option.isSome(failure)) {
		return failure.value;
	}

	const defect = Array.from(Cause.defects(cause))[0];
	if (defect) {
		return defect instanceof Error ? defect : new Error(String(defect));
	}

	return new Error(Cause.pretty(cause));
}

function defaultRetryable(error: unknown): boolean {
	if (error instanceof ExternalHttpError) {
		return error.status === 408 || error.status === 429 || error.status >= 500;
	}
	return false;
}
