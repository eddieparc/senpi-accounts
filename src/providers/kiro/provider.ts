import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { AccountSlot } from "../../core/accounts.js";
import { conversationKey } from "../../core/affinity.js";
import { runWithFailover } from "../../core/failover.js";
import { readPool, writePool } from "../../core/store.js";
import { createUsageCache, type UsageCache } from "../../core/usage-cache.js";
import type { ProviderBuildContext, ProviderConfig } from "../../core/types.js";
import {
	KIRO_API,
	KIRO_MAX_OUTPUT_TOKENS,
	KIRO_PROVIDER_ID,
	KIRO_REGION,
	KIRO_REQUEST_TIMEOUT_MS,
	KIRO_UPSTREAM_URL,
	resolveModels,
} from "./config.js";
import { fetchKiroUsage, type KiroTokens, refreshKiro } from "./oauth.js";
import { createKiroStream } from "./vendor/kiro.js";

/**
 * Kiro provider.
 *
 * Streaming is delegated to the vendored CodeWhisperer client; this module owns
 * the multi-account layer: pick the account, inject that account's token, and
 * on a retryable failure block it and replay on the next account.
 */

const PROFILE_ARN_HEADER = "x-kiro-profile-arn";

export function slotToTokens(slot: AccountSlot): KiroTokens {
	const meta = (slot.meta ?? {}) as Partial<KiroTokens>;
	const tokens: KiroTokens = {
		access: slot.access,
		refresh: slot.refresh,
		expires: slot.expires,
		authMethod: meta.authMethod ?? "google",
		region: meta.region ?? KIRO_REGION,
	};
	if (meta.profileArn) tokens.profileArn = meta.profileArn;
	if (meta.clientId) tokens.clientId = meta.clientId;
	if (meta.clientSecret) tokens.clientSecret = meta.clientSecret;
	if (meta.email) tokens.email = meta.email;
	return tokens;
}

export function tokensToSlot(name: string, tokens: KiroTokens, source: AccountSlot["source"] = "login"): AccountSlot {
	const meta: Record<string, unknown> = { authMethod: tokens.authMethod, region: tokens.region };
	if (tokens.profileArn) meta.profileArn = tokens.profileArn;
	if (tokens.clientId) meta.clientId = tokens.clientId;
	if (tokens.clientSecret) meta.clientSecret = tokens.clientSecret;
	if (tokens.email) meta.email = tokens.email;

	return { name, access: tokens.access, refresh: tokens.refresh, expires: tokens.expires, source, meta };
}

/** Minimal config surface the vendored stream reads. */
function streamConfig(profileArn: string | undefined) {
	return {
		providerId: KIRO_PROVIDER_ID,
		upstreamUrl: KIRO_UPSTREAM_URL,
		endpoint: "codewhisperer" as const,
		apiKey: "kiro-managed",
		requestTimeoutMs: KIRO_REQUEST_TIMEOUT_MS,
		headers: {},
		...(profileArn ? { profileArn } : {}),
	};
}

const silentLogger = { debug: () => undefined, warn: () => undefined, error: () => undefined };

/** First user message text, used as the cache-affinity anchor. */
export function firstUserText(context: Context): string | undefined {
	for (const message of context.messages ?? []) {
		if (message.role !== "user") continue;
		const content = message.content as unknown;
		if (typeof content === "string") {
			if (content.trim()) return content;
			continue;
		}
		if (Array.isArray(content)) {
			const text = content
				.filter((block): block is { type: "text"; text: string } => (block as { type?: string })?.type === "text")
				.map((block) => block.text)
				.join(" ")
				.trim();
			if (text) return text;
		}
	}
	return undefined;
}

/**
 * Buffer a stream so a failure can still be retried on another account.
 *
 * Retrying is only safe while nothing has reached the user, so buffering stops
 * committing once the first visible delta arrives: past that point errors
 * propagate instead of silently re-running the turn on a second subscription.
 */
async function collectStream(stream: AssistantMessageEventStream): Promise<unknown[]> {
	const events: unknown[] = [];
	let committed = false;

	for await (const event of stream as AsyncIterable<Record<string, unknown>>) {
		events.push(event);
		const type = typeof event.type === "string" ? event.type : "";
		// Only a *delta* has actually produced output. A `_start`/`_end` pair with no
		// delta in between showed the user nothing, so a retry cannot duplicate
		// anything -- and treating it as committed made a transient upstream
		// overload fail the request instead of rotating to a healthy account.
		if (/^(?:text|thinking|toolcall)_delta$/.test(type)) committed = true;
		if (type === "error") {
			const raw = event.error as { errorMessage?: string } | undefined;
			const error = new Error(raw?.errorMessage ?? "Kiro request failed");
			if (committed) throw Object.assign(error, { committed: true });
			throw error;
		}
	}
	return events;
}

export interface KiroProviderDeps {
	readPoolState?: typeof readPool;
	writePoolState?: typeof writePool;
	refresh?: (tokens: KiroTokens) => Promise<KiroTokens>;
	createStream?: typeof createKiroStream;
	onFailover?: (message: string) => void;
	/** Per-account headroom source for `balanced` placement. */
	usage?: UsageCache;
}

/** Live per-account headroom, 0..1, from Kiro's own usage-limits endpoint. */
function kiroUsageCache(agentDir: string, readState: typeof readPool): UsageCache {
	return createUsageCache(async () => {
		const state = readState(agentDir, KIRO_PROVIDER_ID);
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
	});
}

export function createKiroStreamSimple(agentDir: string, deps: KiroProviderDeps = {}) {
	const readState = deps.readPoolState ?? readPool;
	const writeState = deps.writePoolState ?? writePool;
	const refreshTokens = deps.refresh ?? refreshKiro;
	const makeStream = deps.createStream ?? createKiroStream;
	// One cache per provider instance, so the TTL is shared across requests.
	const usageCache = deps.usage ?? kiroUsageCache(agentDir, readState);

	return (model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
		// Read per request so a login or pin made elsewhere takes effect on the
		// very next turn.
		const state = readState(agentDir, KIRO_PROVIDER_ID);
		const key = conversationKey(firstUserText(context));

		const iterator = (async function* () {
			const result = await runWithFailover({
				state,
				key,
				// Only consulted for a cold conversation in `balanced` mode; a warm
				// binding and `cache-first` both keep the conversation where it is.
				...(usageCache.get() ? { usage: usageCache.get() } : {}),
				refresh: async (account) => {
					const refreshed = await refreshTokens(slotToTokens(account));
					return tokensToSlot(account.name, refreshed, account.source);
				},
				onFailover: (event) => {
					deps.onFailover?.(
						`kiro: account '${event.from.name}' failed (${event.reason}); ` +
							(event.to ? `retrying on '${event.to.name}'` : "no account left to try"),
					);
				},
				attempt: async (account) => {
					const tokens = slotToTokens(account);
					const headers = { ...options?.headers };
					if (tokens.profileArn) headers[PROFILE_ARN_HEADER] = tokens.profileArn;

					const stream = makeStream(streamConfig(tokens.profileArn) as never, {}, silentLogger as never)(
						model,
						context,
						{ ...options, apiKey: tokens.access, headers } as SimpleStreamOptions,
					);
					return collectStream(stream);
				},
			});

			writeState(agentDir, KIRO_PROVIDER_ID, result.state);
			for (const event of result.value) yield event;
		})();

		return iterator as unknown as AssistantMessageEventStream;
	};
}

export function buildKiroProviderConfig(
	context: ProviderBuildContext,
	oauth: ProviderConfig["oauth"],
	deps: KiroProviderDeps = {},
): ProviderConfig {
	const models = resolveModels(context.env).map((model) => ({
		...model,
		maxTokens: Math.min(model.maxTokens, KIRO_MAX_OUTPUT_TOKENS),
	}));

	return {
		name: "Kiro",
		baseUrl: KIRO_UPSTREAM_URL,
		api: KIRO_API as Api,
		// Deliberately no provider-level `apiKey`. Kiro is OAuth-only, and declaring
		// one made senpi offer "Sign in with an API key" in `/login kiro`, which
		// dead-ends at an "Enter API key" prompt that can never succeed. Each
		// request is authenticated by the pool in `streamSimple` instead.
		models,
		streamSimple: createKiroStreamSimple(context.agentDir, deps),
		...(oauth ? { oauth } : {}),
	};
}
