import type { BlockReason } from "./accounts.js";

export interface FailureClassification {
	/** How to block the account, or `undefined` to leave it selectable. */
	block?: BlockReason;
	/** Whether another account should be tried for this same request. */
	failover: boolean;
	/** Upstream-supplied retry delay in milliseconds, when present. */
	retryAfterMs?: number;
}

function messageOf(error: unknown): string {
	if (typeof error === "string") return error;
	if (error instanceof Error) return error.message;
	if (typeof error === "object" && error !== null) {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string") return message;
		try {
			return JSON.stringify(error);
		} catch {
			return String(error);
		}
	}
	return String(error);
}

function numberField(error: unknown, ...names: string[]): number | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	for (const name of names) {
		const value = (error as Record<string, unknown>)[name];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

/**
 * Extract a retry delay from an error.
 *
 * Accepts an explicit numeric field, a `retry-after-ms` value, or a plain
 * `retry-after` in seconds (the form Kiro and Anthropic actually send).
 */
export function retryAfterMs(error: unknown): number | undefined {
	const explicit = numberField(error, "retryAfterMs");
	if (explicit !== undefined && explicit > 0) return Math.ceil(explicit);

	const text = messageOf(error);
	const millis = text.match(/\bretry[-_ ]?after[-_ ]?ms\s*[:=]\s*(\d+(?:\.\d+)?)/i);
	if (millis?.[1]) return Math.ceil(Number(millis[1]));

	const seconds = text.match(/\bretry[-_ ]?after\s*[:=]\s*(\d+(?:\.\d+)?)/i);
	if (seconds?.[1]) return Math.ceil(Number(seconds[1]) * 1_000);

	return undefined;
}

/** HTTP status carried by an error, when it exposes one. */
export function statusOf(error: unknown): number | undefined {
	return numberField(error, "status", "statusCode");
}

/**
 * Decide what a request failure means for the account that produced it.
 *
 * - 429 / rate-limit / quota  -> block this account, try the next one.
 * - 401 / 403 auth failures   -> block until re-login, try the next one.
 * - 5xx / overloaded          -> brief block, try the next one.
 * - anything else             -> surface to the caller untouched; retrying on a
 *   different account would just repeat a client-side error on someone else's
 *   quota.
 */
export function classifyFailure(error: unknown): FailureClassification {
	const status = statusOf(error);
	const text = messageOf(error).toLowerCase();
	const retryAfter = retryAfterMs(error);

	const isRateLimited =
		status === 429 || /\b429\b|too many requests|rate[_ -]?limit|throttl/.test(text);
	if (isRateLimited) {
		return retryAfter === undefined
			? { block: "rate_limit", failover: true }
			: { block: "rate_limit", failover: true, retryAfterMs: retryAfter };
	}

	if (/quota|entitlement|subscription|billing|monthly limit|limit exceeded|insufficient credit/.test(text)) {
		return retryAfter === undefined
			? { block: "quota", failover: true }
			: { block: "quota", failover: true, retryAfterMs: retryAfter };
	}

	if (status === 401 || status === 403 || /unauthorized|forbidden|invalid[_ -]?grant|token (?:expired|rejected|invalid)|auth[_ -]?(?:expired|rejected)/.test(text)) {
		return { block: "auth_error", failover: true };
	}

	if ((status !== undefined && status >= 500) || /overloaded|service unavailable|bad gateway|internal server error/.test(text)) {
		return retryAfter === undefined
			? { block: "server_error", failover: true }
			: { block: "server_error", failover: true, retryAfterMs: retryAfter };
	}

	return { failover: false };
}
