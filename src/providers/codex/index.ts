import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
	addAccount,
	type AccountPoolState,
	assertValidAccountName,
	isBlocked,
	pinAccount,
	removeAccount,
	unblockAccount,
	unpinAccount,
} from "../../core/accounts.js";
import type { SchedulingMode } from "../../core/affinity.js";
import { emptyPool, readPool, type StoredPool } from "../../core/store.js";
import type { ProviderBuildContext, ProviderConfig, ProviderPackage } from "../../core/types.js";
import { resolveCodexModels } from "./models.js";
import { type CodexTokens, loginCodex, refreshCodex } from "./oauth.js";
import { createCodexStreamSimple } from "./stream.js";

/**
 * OpenAI Codex multi-account.
 *
 * Stock senpi already ships the `openai-codex` provider, its Codex Responses
 * API and fast mode (`-fast` model variants + `service_tier: priority`). Only
 * the multi-account pool is missing, so this package registers a *separate*
 * provider id that reuses stock's API rather than replacing anything.
 *
 * Requests are authenticated per account by resolving the pool's active slot to
 * an access token; stock's API implementation does the actual streaming.
 */

export const CODEX_POOL_PROVIDER_ID = "codex-pool";

/**
 * Stock's `openai-codex-responses` streamer.
 *
 * `@earendil-works/pi-ai` is a real package only inside senpi's compiled Bun
 * binary (where it is injected as a virtual module). Running from source on
 * Node an extension has to resolve it itself, and the addon deliberately does
 * not depend on it -- see `../kiro/vendor/runtime.ts` for the same constraint.
 *
 * The Codex wire protocol is far too large to vendor, so instead of importing
 * the bare specifier this resolves the copy nested inside the senpi that is
 * actually running, via that module's own resolution root. Import failure is
 * surfaced as a normal error, which `runWithFailover` treats as this account's
 * attempt failing rather than taking the addon down.
 */
async function loadStockCodexStreamSimple(): Promise<
	(model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AsyncIterable<unknown>
> {
	// A package `exports` map blocks deep subpath imports, so the nested copies
	// are resolved as file URLs instead of bare specifiers.
	const RELATIVE = "node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js";
	const roots = [
		// Installed as a dependency of this addon.
		join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "node_modules", "@code-yeongyu", "senpi"),
		// senpi running from source: its own workspace copy.
		...(process.env.SENPI_REPO_ROOT ? [join(process.env.SENPI_REPO_ROOT, "packages", "coding-agent")] : []),
	];
	const specifiers = [
		// Bun binary: senpi's injected virtual module.
		"@earendil-works/pi-ai/api/openai-codex-responses",
		...roots.map((root) => pathToFileURL(join(root, RELATIVE)).href),
		// Hoisted install: pi-ai sits beside senpi rather than nested inside it.
		...roots.map((root) => pathToFileURL(join(root, "..", "..", RELATIVE)).href),
	];
	const failures: string[] = [];
	for (const specifier of specifiers) {
		try {
			const loaded = (await import(specifier)) as {
				streamSimple?: (
					model: Model<Api>,
					context: Context,
					options?: SimpleStreamOptions,
				) => AsyncIterable<unknown>;
			};
			if (loaded.streamSimple) return loaded.streamSimple;
			failures.push(`${specifier}: no streamSimple export`);
		} catch (error) {
			failures.push(`${specifier}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new Error(`codex-pool: could not load stock's Codex stream (${failures.join("; ")})`);
}

function stockCodexStream(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const iterator = (async function* () {
		const streamSimple = await loadStockCodexStreamSimple();
		for await (const event of streamSimple(model, context, options)) yield event;
	})();
	return iterator as unknown as AssistantMessageEventStream;
}

type LoginCallbacks = Parameters<typeof loginCodex>[0] & {
	onSelect?(prompt: { message: string; options: { id: string; label: string }[] }): Promise<string | undefined>;
};

export function tokensToSlot(name: string, tokens: CodexTokens) {
	const meta: Record<string, unknown> = {};
	if (tokens.accountId) meta.accountId = tokens.accountId;
	if (tokens.email) meta.email = tokens.email;
	return {
		name,
		access: tokens.access,
		refresh: tokens.refresh,
		expires: tokens.expires,
		source: "login" as const,
		meta,
	};
}

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
	if (state.accounts.length === 0) return "No OpenAI accounts yet.";
	return state.accounts
		.map((slot) => {
			const marks: string[] = [];
			if (state.pinned === slot.name) marks.push("pinned");
			if (slot.blockReason === "auth_error") marks.push("needs re-login");
			else if (isBlocked(slot, now)) marks.push(`blocked ${Math.ceil(((slot.blockedUntil ?? now) - now) / 1000)}s`);
			else marks.push("available");
			const email = (slot.meta as { email?: string } | undefined)?.email;
			return `${email ? `${slot.name} <${email}>` : slot.name} — ${marks.join(", ")}`;
		})
		.join("\n");
}

async function addFlow(state: AccountPoolState, callbacks: LoginCallbacks): Promise<AccountPoolState> {
	const tokens = await loginCodex(callbacks);
	const suggested = state.accounts.length === 0 ? "default" : `account-${state.accounts.length + 1}`;
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
	return addAccount(state, tokensToSlot(name, tokens));
}

async function pick(state: AccountPoolState, callbacks: LoginCallbacks, message: string) {
	if (state.accounts.length === 0) return undefined;
	return callbacks.onSelect?.({
		message,
		options: state.accounts.map((slot) => ({ id: slot.name, label: slot.name })),
	});
}

async function accountManager(agentDir: string, callbacks: LoginCallbacks): Promise<StoredPool> {
	let state = readPool(agentDir, CODEX_POOL_PROVIDER_ID);
	if (state.accounts.length === 0 || !callbacks.onSelect) return toStored(await addFlow(state, callbacks));

	const action = await callbacks.onSelect({
		message: `OpenAI accounts\n${describe(state, Date.now())}`,
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
			const target = await pick(state, callbacks, "Remove which account?");
			if (target) state = removeAccount(state, target);
			break;
		}
		case "pin": {
			const target = await pick(state, callbacks, "Pin which account?");
			if (target) state = pinAccount(state, target);
			break;
		}
		case "unpin":
			state = unpinAccount(state);
			break;
		case "unblock": {
			const target = await pick(state, callbacks, "Clear the block on which account?");
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

export function codexProviderPackage(): ProviderPackage {
	return {
		id: CODEX_POOL_PROVIDER_ID,
		label: "OpenAI Codex (pool)",
		enabled(env) {
			// Opt-in: stock `openai-codex` already covers the single-account case,
			// so this only registers when the user asks for pooling.
			return env.SENPI_ACCOUNTS_CODEX_POOL === "1"
				? true
				: "set SENPI_ACCOUNTS_CODEX_POOL=1 to enable the OpenAI Codex account pool";
		},
		build(context: ProviderBuildContext): ProviderConfig {
			return {
				name: "OpenAI Codex (pool)",
				baseUrl: "https://chatgpt.com/backend-api",
				api: "openai-codex-responses",
				// Required: an extension-registered provider id has no built-in
				// catalog to inherit, so omitting this registers zero models and
				// `--provider codex-pool` fails with "Unknown provider".
				models: resolveCodexModels(context.env),
				// Pool routing happens per request here, not via getApiKey: a
				// provider-level key is resolved once, so it could never rotate.
				streamSimple: createCodexStreamSimple(context.agentDir, {
					createStream: stockCodexStream,
				}),
				oauth: {
					name: "OpenAI Codex pool (ChatGPT Plus/Pro)",
					login: async (callbacks) => accountManager(context.agentDir, callbacks as unknown as LoginCallbacks) as never,
					refreshToken: async (credentials) => credentials,
					getApiKey: (credentials) => credentials.access,
				},
			};
		},
		async accountUsage(context) {
			const pool = readPool(context.agentDir, CODEX_POOL_PROVIDER_ID);
			// ChatGPT exposes no per-account quota endpoint to this client, so
			// headroom is reported as unknown and placement degrades to affinity.
			return Object.fromEntries(pool.accounts.map((slot) => [slot.name, undefined]));
		},
	};
}

export { loginCodex, refreshCodex, CodexAuthError, type CodexTokens } from "./oauth.js";
