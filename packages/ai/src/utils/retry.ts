import type { AssistantMessage } from "../types.ts";

const DEFAULT_MAX_BACKOFF_MS = 10 * 60 * 1000;
const DEFAULT_MAX_UNAUTHORIZED_RETRIES = 5;

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
	return new RegExp(patterns.join("|"), "i");
}

const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
	// OpenCode Go/free-tier limits returned as 429 JSON error types by OpenCode's
	// Zen API. These are subscription/account limits, not transient throttles.
	"GoUsageLimitError",
	"FreeUsageLimitError",

	// OpenCode Go subscription-limit text asks users to enable available-balance
	// usage after rolling/weekly/monthly limits are reached.
	"Monthly usage limit reached",
	"available balance",

	// Generic quota/budget/billing exhaustion. `insufficient_quota` is OpenAI's
	// quota/billing error code; the other strings cover common gateway wording.
	"insufficient_quota",
	"out of budget",
	"quota exceeded",
	"billing",
]);

const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	// Generic provider load, HTTP status, and server-side transient failures.
	"overloaded",
	"rate.?limit",
	"too many requests",
	"429",
	"500",
	"502",
	"503",
	"504",
	"524",
	"service.?unavailable",
	"server.?error",
	"internal.?error",

	// Wrapper/provider text for transient upstream failures, including OpenRouter
	// "Provider returned error" responses (#2264).
	"provider.?returned.?error",

	// Network, proxy, and fetch transport failures. This includes OpenAI Codex
	// raw-fetch failures such as "upstream connect", "connection refused", and
	// "reset before headers" (#733), plus OpenRouter connection drops (#3317).
	"network.?error",
	"connection.?error",
	"connection.?refused",
	"connection.?lost",
	"other side closed",
	"fetch failed",
	"getaddrinfo",
	"ENOTFOUND",
	"EAI_AGAIN",
	"upstream.?connect",
	"reset before headers",
	"socket hang up",
	"socket connection was closed",
	"timed? out",
	"timeout",
	"terminated",

	// WebSocket transports can report close/error text instead of HTTP/fetch text.
	"websocket.?closed",
	"websocket.?error",

	// Premature stream endings from SDKs and transports. Anthropic can throw
	// "stream ended without ..." and "Anthropic stream ended before message_stop"
	// (#4433); Bedrock/Smithy can throw an HTTP/2 no-response error (#3594).
	"ended without",
	"stream ended before message_stop",
	"stream ended before a terminal response event",
	"http2 request did not get a response",

	// Provider-requested retry delay cap failures should flow through the outer
	// retry policy so callers can surface/abort the backoff (#1123).
	"retry delay",

	// Explicit retry guidance emitted mid-stream by OpenAI Responses and Bedrock
	// stream exceptions (#6019).
	"you can retry your request",
	"try your request again",
	"please retry your request",

	// gRPC based providers (e.g. NVIDIA NIM)
	"ResourceExhausted",
]);

const UNAUTHORIZED_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	"unauthorized",
	"invalid.?api.?key",
	"authentication.?failed",
]);

function parseHttpStatus(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) {
		return value;
	}
	if (typeof value === "string" && /^\d{3}$/.test(value)) {
		const status = Number(value);
		return status >= 100 && status <= 599 ? status : undefined;
	}
	return undefined;
}

function getAssistantErrorStatus(message: AssistantMessage): number | undefined {
	for (let i = (message.diagnostics?.length ?? 0) - 1; i >= 0; i--) {
		const diagnostic = message.diagnostics![i];
		const status =
			parseHttpStatus(diagnostic.details?.status) ??
			parseHttpStatus(diagnostic.details?.statusCode) ??
			parseHttpStatus(diagnostic.error?.code);
		if (status !== undefined) return status;
	}

	const match = message.errorMessage?.match(/(?:^|[^\d])([45]\d{2})(?!\d)/);
	return match ? Number(match[1]) : undefined;
}

function hasUsableAssistantOutput(message: AssistantMessage): boolean {
	return message.content.some(
		(content) => content.type === "toolCall" || (content.type === "text" && content.text.trim().length > 0),
	);
}

/**
 * Retry policy with exponential backoff (`baseDelayMs * 2^(attempt-1)`).
 * A null `maxRetries` means retries are unbounded. Unauthorized responses have
 * their own bounded retry budget, and backoff is capped to avoid growing forever.
 */
export interface RetryPolicy {
	enabled: boolean;
	/** Max retry attempts (`null` = unlimited, `0` = no retries). The initial call never counts as a retry. */
	maxRetries: number | null;
	/** Base delay in ms. Per-attempt delay is `baseDelayMs * 2^(attempt-1)` before jitter. */
	baseDelayMs: number;
	/** Maximum exponential-backoff delay. Default: 600000 (10 minutes). */
	maxBackoffMs?: number;
	/** Maximum retry attempts for HTTP 401 responses. Default: 5. */
	maxUnauthorizedRetries?: number;
}

/** Optional callbacks emitted by {@link retryAssistantCall} around each retry. */
export interface RetryCallbacks {
	/** Emitted before the backoff sleep of each retry attempt (1-indexed). */
	onRetryScheduled?: (
		attempt: number,
		maxAttempts: number | null,
		delayMs: number,
		errorMessage: string,
	) => void | Promise<void>;
	/** Emitted after the backoff sleep, immediately before the retried call starts. */
	onRetryAttemptStart?: () => void | Promise<void>;
	/** Emitted once when the loop ends: success if a later call completed normally. */
	onRetryFinished?: (success: boolean, attempt: number, finalError?: string) => void | Promise<void>;
}

class RetrySleepAbortError extends Error {
	constructor() {
		super("Aborted");
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new RetrySleepAbortError());
			return;
		}
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new RetrySleepAbortError());
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function retryLimitForResponse(message: AssistantMessage, policy: RetryPolicy): number | null {
	if (!isUnauthorizedAssistantError(message)) return policy.maxRetries;
	const unauthorizedLimit = policy.maxUnauthorizedRetries ?? DEFAULT_MAX_UNAUTHORIZED_RETRIES;
	return policy.maxRetries === null ? unauthorizedLimit : Math.min(policy.maxRetries, unauthorizedLimit);
}

function getBackoffDelayMs(policy: RetryPolicy, attempt: number): number {
	const maxBackoffMs = Math.max(0, policy.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS);
	const exponentialDelayMs = policy.baseDelayMs * 2 ** (attempt - 1);
	return Math.max(0, Math.min(exponentialDelayMs, maxBackoffMs));
}

/**
 * Run a single assistant-producing call with policy-driven retry.
 *
 * Behavior:
 * - A successful response is returned immediately. Aborts are terminal and never
 *   retried, but reported as unsuccessful if they happen after a retry was scheduled.
 *   Aborts during the backoff sleep are normalized to an aborted `AssistantMessage`
 *   too, so callers do not need to care when cancellation happened.
 * - HTTP/provider/transport failures, empty output, and reasoning-only output are
 *   retried. HTTP 401 responses use their separate bounded retry budget.
 * - Otherwise retries according to `maxRetries` with capped exponential backoff, emitting
 *   `onRetryScheduled` before each sleep, `onRetryAttemptStart` after each sleep before
 *   the retried call starts, and `onRetryFinished` once at the end (whether the loop
 *   ends in success, exhausted retries, or an aborted backoff).
 *
 * When `policy` is undefined or disabled, the first response is returned unchanged
 * (equivalent to calling `produce()` directly).
 */
export async function retryAssistantCall(
	produce: () => Promise<AssistantMessage>,
	policy: RetryPolicy | undefined,
	signal: AbortSignal | undefined,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	let attempt = 0;
	let unauthorizedAttempts = 0;
	let lastRetry: { attempt: number; errorMessage: string } | undefined;
	for (;;) {
		const response = await produce();

		// Abort: terminal but not successful. Never retry an aborted message.
		if (response.stopReason === "aborted") {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt);
			return response;
		}

		const retryError = getAssistantRetryErrorMessage(response);

		// Success: usable non-error responses return as-is.
		if (!retryError) {
			if (lastRetry) await callbacks?.onRetryFinished?.(true, lastRetry.attempt);
			return response;
		}

		if (!policy?.enabled || !isRetryableAssistantResponse(response)) {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);
			return response;
		}

		const retryLimit = retryLimitForResponse(response, policy);
		const unauthorized = isUnauthorizedAssistantError(response);
		if (
			(policy.maxRetries !== null && attempt >= policy.maxRetries) ||
			(unauthorized && unauthorizedAttempts >= (policy.maxUnauthorizedRetries ?? DEFAULT_MAX_UNAUTHORIZED_RETRIES))
		) {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt, retryError);
			return response;
		}

		attempt++;
		if (unauthorized) unauthorizedAttempts++;
		lastRetry = { attempt, errorMessage: retryError };
		const delayMs = getBackoffDelayMs(policy, attempt);
		await callbacks?.onRetryScheduled?.(attempt, retryLimit, delayMs, lastRetry.errorMessage);

		// Normalize aborts during retry backoff to the same AssistantMessage shape as
		// provider stream aborts, so callers do not need to care when cancellation happened.
		try {
			await sleep(delayMs, signal);
		} catch (error) {
			await callbacks?.onRetryFinished?.(false, attempt, lastRetry.errorMessage);
			if (error instanceof RetrySleepAbortError) {
				return { ...response, stopReason: "aborted", errorMessage: undefined };
			}
			throw error;
		}
		await callbacks?.onRetryAttemptStart?.();
	}
}

/** Returns true when the assistant response is an HTTP 401 authentication failure. */
export function isUnauthorizedAssistantError(message: AssistantMessage): boolean {
	return (
		message.stopReason === "error" &&
		(getAssistantErrorStatus(message) === 401 ||
			(message.errorMessage !== undefined && UNAUTHORIZED_PROVIDER_ERROR_PATTERN.test(message.errorMessage)))
	);
}

/**
 * Classifies whether a failed assistant message looks like a transient provider
 * or transport error, so callers can decide if the last assistant turn should be
 * restarted.
 *
 * This does not implement retry policy. Callers should first handle context
 * overflow separately, then apply their own retry budget, backoff, and reporting
 * before restarting the assistant turn.
 */
export function isRetryableAssistantError(message: AssistantMessage): boolean {
	if (message.stopReason !== "error") return false;
	if (getAssistantErrorStatus(message) !== undefined) return true;
	if (!message.errorMessage) return false;
	const errorMessage = message.errorMessage;
	if (UNAUTHORIZED_PROVIDER_ERROR_PATTERN.test(errorMessage)) return true;
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return false;
	return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
}

/**
 * Returns a user-visible retry reason for failed or unusable assistant responses.
 * Thinking without text or a tool call is intentionally not considered usable output.
 */
export function getAssistantRetryErrorMessage(message: AssistantMessage): string | undefined {
	if (message.stopReason === "error") {
		return isRetryableAssistantError(message) ? message.errorMessage || "Unknown provider error" : undefined;
	}
	if (
		message.stopReason === "aborted" ||
		message.stopReason === "pending" ||
		message.stopReason === "deferred" ||
		hasUsableAssistantOutput(message)
	) {
		return undefined;
	}
	const hasThinking = message.content.some(
		(content) => content.type === "thinking" && content.thinking.trim().length > 0,
	);
	return hasThinking ? "Model returned reasoning without text or tool calls" : "Model returned an empty response";
}

/** Returns true when a finalized assistant response should be retried. */
export function isRetryableAssistantResponse(message: AssistantMessage): boolean {
	return getAssistantRetryErrorMessage(message) !== undefined;
}
