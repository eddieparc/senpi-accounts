import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { AccountSlot } from "../../core/accounts.js";
import { conversationKey } from "../../core/affinity.js";
import { runWithFailover } from "../../core/failover.js";
import { readPool, writePool } from "../../core/store.js";
import { type CodexTokens, refreshCodex } from "./oauth.js";

/**
 * Per-request account resolution for the `codex-pool` provider.
 *
 * A provider-level `getApiKey(credentials)` cannot serve a pool: it is resolved
 * once from the stored credential, so every request would reuse whichever
 * account happened to be stored and rotation could never happen. (Registering
 * the account-manager menu result as the credential also means there is no real
 * token there at all, which upstream rejects with "Could not parse your
 * authentication token".)
 *
 * So, exactly like the Kiro package, streaming goes through `streamSimple`:
 * read the pool per request, pick an account, inject *that* account's token,
 * and on a retryable failure block it and replay on the next account. Stock's
 * `openai-codex-responses` API does the actual streaming — we only choose who
 * pays for it.
 */

export const CODEX_POOL_PROVIDER_ID = "codex-pool";

/** `chatgpt-account-id` scopes a request to the ChatGPT account owning the token. */
const ACCOUNT_ID_HEADER = "chatgpt-account-id";

export function slotToCodexTokens(slot: AccountSlot): CodexTokens {
	const meta = (slot.meta ?? {}) as { accountId?: string; email?: string };
	const tokens: CodexTokens = {
		access: slot.access,
		refresh: slot.refresh,
		expires: slot.expires,
	};
	if (meta.accountId) tokens.accountId = meta.accountId;
	if (meta.email) tokens.email = meta.email;
	return tokens;
}

function codexTokensToSlot(name: string, tokens: CodexTokens, source: AccountSlot["source"]): AccountSlot {
	const meta: Record<string, unknown> = {};
	if (tokens.accountId) meta.accountId = tokens.accountId;
	if (tokens.email) meta.email = tokens.email;
	return { name, access: tokens.access, refresh: tokens.refresh, expires: tokens.expires, source, meta };
}

function firstUserText(context: Context): string {
	for (const message of context.messages ?? []) {
		if (message.role !== "user") continue;
		const { content } = message as { content: unknown };
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			for (const block of content) {
				const text = (block as { type?: string; text?: string })?.text;
				if ((block as { type?: string })?.type === "text" && typeof text === "string") return text;
			}
		}
	}
	return "";
}

async function collectStream(stream: AssistantMessageEventStream): Promise<unknown[]> {
	const events: unknown[] = [];
	for await (const event of stream as AsyncIterable<unknown>) events.push(event);
	return events;
}

export interface CodexStreamDeps {
	readPoolState?: typeof readPool;
	writePoolState?: typeof writePool;
	refresh?: typeof refreshCodex;
	/** Stock's `openai-codex-responses` stream, injected for testability. */
	createStream?: (
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	) => AssistantMessageEventStream;
	onFailover?: (message: string) => void;
}

export function createCodexStreamSimple(agentDir: string, deps: CodexStreamDeps = {}) {
	const readState = deps.readPoolState ?? readPool;
	const writeState = deps.writePoolState ?? writePool;
	const refreshTokens = deps.refresh ?? refreshCodex;

	return (model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
		// Read per request so a login, pin, or block made elsewhere takes effect
		// on the very next turn.
		const state = readState(agentDir, CODEX_POOL_PROVIDER_ID);
		const key = conversationKey(firstUserText(context));

		const iterator = (async function* () {
			const result = await runWithFailover({
				state,
				key,
				refresh: async (account) => {
					const refreshed = await refreshTokens(slotToCodexTokens(account));
					return codexTokensToSlot(account.name, refreshed, account.source);
				},
				onFailover: (event) => {
					deps.onFailover?.(
						`codex-pool: account '${event.from.name}' failed (${event.reason}); ` +
							(event.to ? `retrying on '${event.to.name}'` : "no account left to try"),
					);
				},
				attempt: async (account) => {
					const tokens = slotToCodexTokens(account);
					const headers = { ...options?.headers };
					if (tokens.accountId) headers[ACCOUNT_ID_HEADER] = tokens.accountId;

					if (!deps.createStream) {
						throw new Error("codex-pool: no stream implementation was provided");
					}
					const stream = deps.createStream(model, context, {
						...options,
						apiKey: tokens.access,
						headers,
					} as SimpleStreamOptions);
					return collectStream(stream);
				},
			});

			writeState(agentDir, CODEX_POOL_PROVIDER_ID, result.state);
			for (const event of result.value) yield event;
		})();

		return iterator as unknown as AssistantMessageEventStream;
	};
}
