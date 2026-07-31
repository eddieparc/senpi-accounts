import { createHash } from "node:crypto";
import { type AccountPoolState, type AccountSlot, isBlocked, NoAvailableAccountError } from "./accounts.js";

/**
 * Account placement.
 *
 * The scarce resource is not quota alone but the upstream prompt-prefix cache:
 * moving a conversation to another account makes its cache cold, which can cost
 * far more than the quota it saves. So placement is decided once per
 * conversation and then held; quota only steers the *initial* choice, when the
 * cache is cold anyway and switching is free.
 */

export type SchedulingMode = "cache-first" | "balanced" | "spread";

export const DEFAULT_SCHEDULING_MODE: SchedulingMode = "cache-first";

/** Remaining headroom per account, 0..1. Absent entries are treated as unknown. */
export type UsageSnapshot = Record<string, number | undefined>;

/** Cap on remembered conversation bindings, oldest evicted first. */
const MAX_BINDINGS = 256;

/** Candidate pool size for power-of-two-choices. */
const P2C_POOL = 4;

/**
 * Stable fingerprint for a conversation.
 *
 * Only the first user message is hashed: model id, timestamps and later turns
 * are deliberately excluded so the key never drifts as the conversation grows.
 * A drifting key would rebind mid-conversation and throw away the cache.
 */
export function conversationKey(firstUserMessage: string | undefined, fallback?: string): string {
	const text = firstUserMessage?.trim();
	if (!text) return fallback ?? "default";
	return `c-${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
}

export interface ConversationKeyInput {
	/** senpi's per-session id (`SimpleStreamOptions.sessionId`), when available. */
	sessionId?: string | undefined;
	firstUserMessage?: string | undefined;
	fallback?: string | undefined;
}

/**
 * Preferred fingerprint: the session id.
 *
 * The first user message is a proxy for "which conversation is this", but it is
 * not actually stable: once senpi compacts, the summary becomes the first user
 * message and the content-derived key changes mid-conversation, dropping the
 * binding and re-placing a conversation whose cache is warm. The session id
 * does not move, so it anchors the binding for the whole session. Content
 * hashing remains the fallback for callers that have no session id.
 */
export function conversationKeyFor(input: ConversationKeyInput): string {
	const sessionId = input.sessionId?.trim();
	if (sessionId) return `s-${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}`;
	return conversationKey(input.firstUserMessage, input.fallback);
}

/** Highest-random-weight score; ties broken deterministically by name. */
function score(key: string, accountName: string): bigint {
	return createHash("sha256").update(`${key}\u0000${accountName}`).digest().readBigUInt64BE(0);
}

/**
 * Rendezvous (HRW) ordering. Adding or removing an account only moves the
 * conversations that actually hashed to it, leaving every other binding — and
 * therefore every other warm cache — untouched.
 */
export function rendezvousOrder(key: string, accounts: readonly AccountSlot[]): AccountSlot[] {
	return [...accounts]
		.map((account) => ({ account, weight: score(key, account.name) }))
		.sort((left, right) => (right.weight > left.weight ? 1 : right.weight < left.weight ? -1 : 0))
		.map(({ account }) => account);
}

function remaining(usage: UsageSnapshot | undefined, name: string): number {
	const value = usage?.[name];
	// Unknown headroom sorts as "plenty" so a provider without usage telemetry
	// degrades to plain affinity instead of being starved.
	return typeof value === "number" && Number.isFinite(value) ? value : 1;
}

/**
 * Power-of-two-choices over the accounts with the most headroom.
 *
 * Always taking the single emptiest account makes every concurrent session pile
 * onto the same one; sampling two from the top slice and keeping the better
 * spreads load without that herd effect.
 */
function pickByUsage(
	accounts: readonly AccountSlot[],
	usage: UsageSnapshot | undefined,
	random: () => number,
): AccountSlot {
	const ranked = [...accounts].sort((left, right) => remaining(usage, right.name) - remaining(usage, left.name));
	const poolSize = Math.min(P2C_POOL, ranked.length);
	if (poolSize <= 1) return ranked[0] as AccountSlot;

	const first = Math.floor(random() * poolSize) % poolSize;
	let second = Math.floor(random() * poolSize) % poolSize;
	if (second === first) second = (first + 1) % poolSize;

	const left = ranked[first] as AccountSlot;
	const right = ranked[second] as AccountSlot;
	return remaining(usage, left.name) >= remaining(usage, right.name) ? left : right;
}

function rememberBinding(state: AccountPoolState, key: string, accountName: string): AccountPoolState {
	const bindings = { ...(state.bindings ?? {}) };
	delete bindings[key];
	bindings[key] = accountName;

	const keys = Object.keys(bindings);
	if (keys.length > MAX_BINDINGS) {
		for (const stale of keys.slice(0, keys.length - MAX_BINDINGS)) delete bindings[stale];
	}
	return { ...state, bindings };
}

export interface PlacementOptions {
	/** Conversation fingerprint; see {@link conversationKey}. */
	key: string;
	mode?: SchedulingMode;
	usage?: UsageSnapshot;
	now?: number;
	random?: () => number;
}

export interface Placement {
	account: AccountSlot;
	/** Pool state to persist (binding recorded, cursor advanced). */
	state: AccountPoolState;
	/** True when this request reused an existing warm binding. */
	reusedBinding: boolean;
}

function unblocked(accounts: readonly AccountSlot[], now: number): AccountSlot[] {
	return accounts.filter((account) => !isBlocked(account, now));
}

function earliestRetryAt(accounts: readonly AccountSlot[]): number | undefined {
	const times = accounts
		.filter((account) => account.blockReason !== "auth_error" && account.blockedUntil !== undefined)
		.map((account) => account.blockedUntil as number);
	return times.length > 0 ? Math.min(...times) : undefined;
}

/**
 * Choose the account for a request.
 *
 * Precedence: an explicit pin always wins; then an existing conversation
 * binding (the warm cache); then, only for a conversation we have not placed
 * before, the scheduling mode decides.
 */
export function placeRequest(state: AccountPoolState, options: PlacementOptions): Placement {
	const now = options.now ?? Date.now();
	const mode = options.mode ?? state.mode ?? DEFAULT_SCHEDULING_MODE;
	const random = options.random ?? Math.random;

	if (state.accounts.length === 0) throw new NoAvailableAccountError("No accounts are registered");

	const available = unblocked(state.accounts, now);
	if (available.length === 0) {
		throw new NoAvailableAccountError(
			"All accounts are blocked (rate limited or awaiting re-login)",
			earliestRetryAt(state.accounts),
		);
	}

	if (state.pinned) {
		const pinned = available.find((account) => account.name === state.pinned);
		if (pinned) return { account: pinned, state, reusedBinding: true };
	}

	if (mode === "spread") {
		const cursor = state.cursor ?? 0;
		const account = available[cursor % available.length] as AccountSlot;
		return { account, state: { ...state, cursor: (cursor + 1) % available.length }, reusedBinding: false };
	}

	const boundName = state.bindings?.[options.key];
	if (boundName) {
		const bound = available.find((account) => account.name === boundName);
		if (bound) return { account: bound, state, reusedBinding: true };
	}

	// Cold cache: this is the only moment when moving costs nothing, so it is
	// the only moment quota is allowed to steer the choice.
	const account =
		mode === "balanced"
			? pickByUsage(available, options.usage, random)
			: (rendezvousOrder(options.key, available)[0] as AccountSlot);

	// A binding that exists but is momentarily blocked is a *detour*, not a
	// rebind: the warm prefix cache still lives on the bound account, and its
	// block is a wall-clock window that expires. Overwriting the binding here
	// would strand the conversation on the detour account for good, paying a
	// fresh cache write now and forfeiting the warm one forever.
	if (boundName && state.accounts.some((candidate) => candidate.name === boundName)) {
		return { account, state, reusedBinding: false };
	}

	return { account, state: rememberBinding(state, options.key, account.name), reusedBinding: false };
}

/** Drop a conversation's binding so the next request is placed afresh. */
export function releaseBinding(state: AccountPoolState, key: string): AccountPoolState {
	if (!state.bindings?.[key]) return state;
	const bindings = { ...state.bindings };
	delete bindings[key];
	return { ...state, bindings };
}
