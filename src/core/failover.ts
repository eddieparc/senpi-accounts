import {
	type AccountPoolState,
	type AccountSlot,
	blockAccount,
	NoAvailableAccountError,
	replaceAccount,
	unblockAccount,
} from "./accounts.js";
import { placeRequest, releaseBinding, type SchedulingMode, type UsageSnapshot } from "./affinity.js";
import { classifyFailure } from "./failure.js";

export interface FailoverEvent {
	from: AccountSlot;
	to?: AccountSlot;
	reason: string;
	attempt: number;
}

/**
 * Raised when no account can serve the request.
 *
 * `retryAfterMs` matters for more than diagnostics: senpi's own
 * `SelectorCooldowns.durationFor()` prefers an explicit `retryAfterMs` over its
 * keyword heuristics. Carrying the real unblock time makes senpi suppress the
 * model for exactly as long as this pool is actually unusable, instead of
 * defaulting to its 30-minute quota bucket and idling accounts that recover
 * sooner.
 */
export class AllAccountsBlockedError extends Error {
	readonly retryAfterMs?: number;
	readonly retryAt?: number;

	constructor(message: string, retryAt?: number, now: number = Date.now()) {
		super(message);
		this.name = "AllAccountsBlockedError";
		if (retryAt !== undefined) {
			this.retryAt = retryAt;
			this.retryAfterMs = Math.max(0, retryAt - now);
		}
	}
}

export interface RunWithFailoverOptions<T> {
	state: AccountPoolState;
	/** Conversation fingerprint used for cache-preserving placement. */
	key: string;
	attempt: (account: AccountSlot) => Promise<T>;
	refresh?: (account: AccountSlot) => Promise<AccountSlot>;
	mode?: SchedulingMode;
	usage?: UsageSnapshot;
	maxAttempts?: number;
	onFailover?: (event: FailoverEvent) => void;
	now?: () => number;
	refreshSkewMs?: number;
	random?: () => number;
}

export interface FailoverResult<T> {
	value: T;
	account: AccountSlot;
	state: AccountPoolState;
}

const DEFAULT_REFRESH_SKEW_MS = 60_000;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function place(state: AccountPoolState, options: RunWithFailoverOptions<unknown>, now: number) {
	const placement: Parameters<typeof placeRequest>[1] = { key: options.key, now };
	if (options.mode !== undefined) placement.mode = options.mode;
	if (options.usage !== undefined) placement.usage = options.usage;
	if (options.random !== undefined) placement.random = options.random;
	return placeRequest(state, placement);
}

/**
 * Run one request against the account pool.
 *
 * A failure that another account could survive (429, quota, auth, 5xx) blocks
 * the offending account and replays the request elsewhere; the conversation's
 * binding is released so it can settle on the account that actually served it.
 * Client-side errors propagate untouched, because replaying them would only
 * burn a second subscription on the same bad request.
 */
export async function runWithFailover<T>(options: RunWithFailoverOptions<T>): Promise<FailoverResult<T>> {
	const now = options.now ?? Date.now;
	const skew = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
	let state = options.state;
	const limit = options.maxAttempts ?? Math.max(1, state.accounts.length);
	const attemptsByAccount = new Map<string, number>();
	let lastError: unknown;

	for (let attempt = 0; attempt < limit; attempt++) {
		let placement: ReturnType<typeof placeRequest>;
		try {
			placement = place(state, options as RunWithFailoverOptions<unknown>, now());
		} catch (error) {
			if (error instanceof NoAvailableAccountError) {
				if (lastError !== undefined) throw lastError;
				throw new AllAccountsBlockedError(error.message, error.retryAt, now());
			}
			throw error;
		}

		state = placement.state;
		let account = placement.account;

		if (options.refresh && account.expires <= now() + skew) {
			try {
				account = await options.refresh(account);
				state = replaceAccount(state, unblockAccount(account));
			} catch (error) {
				lastError = error;
				state = releaseBinding(replaceAccount(state, blockAccount(account, "auth_error")), options.key);
				options.onFailover?.({ from: account, reason: `token refresh failed: ${errorText(error)}`, attempt });
				continue;
			}
		}

		try {
			const value = await options.attempt(account);
			return { value, account, state };
		} catch (error) {
			lastError = error;
			const classification = classifyFailure(error);
			if (!classification.failover || classification.block === undefined) throw error;

			const priorAttempts = attemptsByAccount.get(account.name) ?? 0;
			attemptsByAccount.set(account.name, priorAttempts + 1);

			const blockOptions: Parameters<typeof blockAccount>[2] = { now: now(), attempt: priorAttempts };
			if (classification.retryAfterMs !== undefined) blockOptions.retryAfterMs = classification.retryAfterMs;
			state = releaseBinding(replaceAccount(state, blockAccount(account, classification.block, blockOptions)), options.key);

			// Providers tag a failure that arrived *after* visible output with
			// `committed`. Replaying such a turn on another account would emit the
			// partial text twice, so the account is still blocked (so later requests
			// route elsewhere) but this request fails rather than being retried.
			if ((error as { committed?: boolean }).committed) {
				options.onFailover?.({
					from: account,
					reason: `${classification.block}: ${errorText(error)} (output already streamed; not retrying)`,
					attempt,
				});
				throw error;
			}

			let next: AccountSlot | undefined;
			try {
				next = place(state, options as RunWithFailoverOptions<unknown>, now()).account;
			} catch {
				next = undefined;
			}

			const event: FailoverEvent = { from: account, reason: `${classification.block}: ${errorText(error)}`, attempt };
			if (next) event.to = next;
			options.onFailover?.(event);
		}
	}

	throw lastError ?? new AllAccountsBlockedError("No account completed the request");
}
