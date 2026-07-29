import {
	addAccount,
	assertValidAccountName,
	isBlocked,
	pinAccount,
	removeAccount,
	unblockAccount,
	unpinAccount,
} from "../../core/accounts.js";
import type { AccountPoolState } from "../../core/accounts.js";
import { DEFAULT_SCHEDULING_MODE, type SchedulingMode } from "../../core/affinity.js";
import { emptyPool, readPool, type StoredPool } from "../../core/store.js";
import type { ProviderBuildContext, ProviderPackage } from "../../core/types.js";
import { KIRO_AUTH_METHOD_LABELS, type KiroAuthMethod, KIRO_PROVIDER_ID } from "./config.js";
import { fetchKiroUsage, type KiroTokens, loginKiro } from "./oauth.js";
import { buildKiroProviderConfig, type KiroProviderDeps, slotToTokens, tokensToSlot } from "./provider.js";

export { KIRO_PROVIDER_ID, KIRO_MODELS, resolveModels } from "./config.js";
export { loginKiro, refreshKiro, fetchKiroUsage, KiroAuthError, type KiroTokens } from "./oauth.js";
export { buildKiroProviderConfig, createKiroStreamSimple, tokensToSlot, slotToTokens } from "./provider.js";

/**
 * senpi's `/login <provider>` calls `oauth.login()` and persists whatever it
 * returns as that provider's single credential. Stock's Claude Agent SDK uses
 * this to manage a whole account pool, and we follow the same contract: the
 * credential *is* the pool, so `/login kiro` becomes the account manager and no
 * senpi-side change is needed to add or remove accounts.
 */

type LoginCallbacks = {
	onAuth(info: { url: string; instructions?: string }): void;
	onDeviceCode?(info: { userCode: string; verificationUri: string }): void;
	onProgress?(message: string): void;
	onPrompt(prompt: { message: string; placeholder?: string }): Promise<string>;
	onSelect?(prompt: {
		message: string;
		options: { id: string; label: string }[];
	}): Promise<string | undefined>;
	signal?: AbortSignal;
};

function toStored(state: AccountPoolState): StoredPool {
	const pool = emptyPool();
	pool.accounts = state.accounts;
	if (state.pinned !== undefined) pool.pinned = state.pinned;
	if (state.mode !== undefined) pool.mode = state.mode;
	if (state.bindings !== undefined) pool.bindings = state.bindings;
	if (state.cursor !== undefined) pool.cursor = state.cursor;
	return pool;
}

function describe(state: AccountPoolState, now: number): string {
	if (state.accounts.length === 0) return "No Kiro accounts yet.";
	return state.accounts
		.map((slot) => {
			const marks: string[] = [];
			if (state.pinned === slot.name) marks.push("pinned");
			if (slot.blockReason === "auth_error") marks.push("needs re-login");
			else if (isBlocked(slot, now)) {
				marks.push(`blocked ${Math.ceil(((slot.blockedUntil ?? now) - now) / 1000)}s`);
			} else marks.push("available");
			const meta = slot.meta as { authMethod?: string; email?: string } | undefined;
			if (meta?.authMethod) marks.push(meta.authMethod);
			const label = meta?.email ? `${slot.name} <${meta.email}>` : slot.name;
			return `${label} — ${marks.join(", ")}`;
		})
		.join("\n");
}

function nextDefaultName(state: AccountPoolState): string {
	return state.accounts.length === 0 ? "default" : `account-${state.accounts.length + 1}`;
}

async function addFlow(state: AccountPoolState, callbacks: LoginCallbacks): Promise<AccountPoolState> {
	const method = await callbacks.onSelect?.({
		message: "Kiro sign-in method",
		options: (Object.keys(KIRO_AUTH_METHOD_LABELS) as KiroAuthMethod[]).map((id) => ({
			id,
			label: KIRO_AUTH_METHOD_LABELS[id],
		})),
	});
	if (method === undefined) throw new Error("Kiro sign-in cancelled");

	const tokens = await loginKiro(callbacks as never, method as KiroAuthMethod);

	const suggested = nextDefaultName(state);
	const answer = (
		await callbacks.onPrompt({
			message:
				state.accounts.length === 0
					? "Name for this account"
					: `Name for this account (existing: ${state.accounts.map((s) => s.name).join(", ")})`,
			placeholder: suggested,
		})
	).trim();
	const name = answer || suggested;
	assertValidAccountName(name);

	// Best-effort: the email makes the account list far easier to read, but a
	// failed lookup must not lose a successful login.
	let enriched: KiroTokens = tokens;
	try {
		const usage = await fetchKiroUsage(tokens);
		if (usage.email) enriched = { ...tokens, email: usage.email };
	} catch {
		// Usage endpoint unavailable; keep the token as-is.
	}

	return addAccount(state, tokensToSlot(name, enriched));
}

async function pickAccount(
	state: AccountPoolState,
	callbacks: LoginCallbacks,
	message: string,
): Promise<string | undefined> {
	if (state.accounts.length === 0) return undefined;
	return callbacks.onSelect?.({
		message,
		options: state.accounts.map((slot) => ({ id: slot.name, label: slot.name })),
	});
}

/**
 * Menu-driven account manager. Every registration and removal path is reachable
 * from `/login kiro`, which is what makes native `/login` sufficient.
 */
async function accountManager(agentDir: string, callbacks: LoginCallbacks): Promise<StoredPool> {
	let state = readPool(agentDir, KIRO_PROVIDER_ID);
	const now = Date.now();

	if (state.accounts.length === 0 || !callbacks.onSelect) {
		return toStored(await addFlow(state, callbacks));
	}

	const action = await callbacks.onSelect({
		message: `Kiro accounts\n${describe(state, now)}`,
		options: [
			{ id: "add", label: "Add an account" },
			{ id: "remove", label: "Remove an account" },
			{ id: "pin", label: "Pin an account" },
			{ id: "unpin", label: "Clear the pin" },
			{ id: "unblock", label: "Clear a block" },
			{ id: "mode", label: "Scheduling mode" },
		],
	});

	switch (action) {
		case "add":
			state = await addFlow(state, callbacks);
			break;
		case "remove": {
			const target = await pickAccount(state, callbacks, "Remove which account?");
			if (target) state = removeAccount(state, target);
			break;
		}
		case "pin": {
			const target = await pickAccount(state, callbacks, "Pin which account?");
			if (target) state = pinAccount(state, target);
			break;
		}
		case "unpin":
			state = unpinAccount(state);
			break;
		case "unblock": {
			const target = await pickAccount(state, callbacks, "Clear the block on which account?");
			if (target) {
				state = {
					...state,
					accounts: state.accounts.map((slot) => (slot.name === target ? unblockAccount(slot) : slot)),
				};
			}
			break;
		}
		case "mode": {
			const selected = await callbacks.onSelect({
				message: "Scheduling mode",
				options: [
					{ id: "cache-first", label: "Cache first — hold one account, maximise prompt-cache hits" },
					{ id: "balanced", label: "Balanced — place new conversations by remaining quota" },
					{ id: "spread", label: "Spread — round-robin every request" },
				],
			});
			if (selected) state = { ...state, mode: selected as SchedulingMode };
			break;
		}
		default:
			break;
	}

	return toStored(state);
}

export function kiroProviderPackage(deps: KiroProviderDeps = {}): ProviderPackage {
	return {
		id: KIRO_PROVIDER_ID,
		label: "Kiro",
		build(context: ProviderBuildContext) {
			return buildKiroProviderConfig(
				context,
				{
					name: "Kiro (Google / GitHub / AWS Builder ID)",
					login: async (callbacks) => accountManager(context.agentDir, callbacks as unknown as LoginCallbacks) as never,
					// The stored credential is a pool of accounts, each refreshed
					// individually at request time, so the wrapper never refreshes.
					refreshToken: async (credentials) => credentials,
					getApiKey: (credentials) => credentials.access,
				},
				deps,
			);
		},
		async accountUsage(context) {
			const state = readPool(context.agentDir, KIRO_PROVIDER_ID);
			const entries = await Promise.all(
				state.accounts.map(async (slot) => {
					try {
						const usage = await fetchKiroUsage(slotToTokens(slot));
						const limit = usage.limitCount > 0 ? usage.limitCount : undefined;
						return [slot.name, limit ? Math.max(0, 1 - usage.usedCount / limit) : undefined] as const;
					} catch {
						return [slot.name, undefined] as const;
					}
				}),
			);
			return Object.fromEntries(entries);
		},
	};
}

export { DEFAULT_SCHEDULING_MODE };
