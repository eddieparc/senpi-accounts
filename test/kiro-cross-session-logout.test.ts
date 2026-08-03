import type { Api, AssistantMessageEventStream, Context, Model } from "@earendil-works/pi-ai";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountSlot } from "../src/core/accounts.js";
import { readPool, writePool } from "../src/core/store.js";
import { createKiroStreamSimple, kiroProviderPackage, type KiroTokens } from "../src/providers/kiro/index.js";

const dirs: string[] = [];

function agentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "senpi-accounts-logout-"));
	dirs.push(dir);
	return dir;
}

function slot(): AccountSlot {
	return {
		name: "default",
		access: "fixture-kiro-access",
		refresh: "fixture-kiro-refresh",
		expires: 0,
		source: "login",
	};
}

function removeKiroCredential(dir: string): void {
	const path = join(dir, "auth.json");
	const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	delete data.kiro;
	writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function seedKiroAndAdjacent(dir: string): void {
	writeFileSync(
		join(dir, "auth.json"),
		JSON.stringify(
			{
				kiro: {
					type: "oauth",
					access: "senpi-accounts-managed",
					refresh: "senpi-accounts-managed",
					expires: 4_102_444_800_000,
					accounts: [slot()],
				},
				adjacent: { type: "api_key", key: "fixture-adjacent" },
			},
			null,
			2,
		),
		{ mode: 0o600 },
	);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return {
		promise,
		resolve: () => {
			if (!resolve) throw new Error("Deferred resolver was not initialized");
			resolve();
		},
	};
}

function model(): Model<Api> {
	return {
		id: "claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		api: "openai-completions",
		provider: "kiro",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	};
}

function context(): Context {
	return {
		messages: [{ role: "user", content: "exercise the stale session", timestamp: 1 }],
	};
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Kiro cross-session logout", () => {
	it("does not resurrect a logged-out account across sessions", async () => {
		const dir = agentDir();
		writePool(dir, "adjacent", { accounts: [] });
		writePool(dir, "kiro", { accounts: [slot()] });

		const refreshStarted = deferred();
		const continueRefresh = deferred();
		const streamSimple = createKiroStreamSimple(dir, {
			refresh: async (tokens: KiroTokens) => {
				refreshStarted.resolve();
				await continueRefresh.promise;
				return { ...tokens, access: "fixture-refreshed-access", expires: Number.MAX_SAFE_INTEGER };
			},
			usage: { get: () => undefined, refresh: async () => ({}) },
			createStream: (() => () =>
				(async function* () {
					yield { type: "text_delta", delta: "ok" };
				})() as unknown as AssistantMessageEventStream) as never,
		});

		const iterator = (
			streamSimple(model(), context()) as unknown as AsyncIterable<Record<string, unknown>>
		)[Symbol.asyncIterator]();
		const firstEvent = iterator.next();
		await refreshStarted.promise;
		removeKiroCredential(dir);
		continueRefresh.resolve();

		await expect(firstEvent).resolves.toEqual({
			done: false,
			value: { type: "text_delta", delta: "ok" },
		});
		expect(readPool(dir, "kiro").accounts).toEqual([]);
	});

	it("persists Kiro removal without deleting adjacent credentials", async () => {
		for (const scenario of [
			{ action: "remove", selections: ["remove", "default"] },
			{ action: "logout-all", selections: ["logout-all", "yes"] },
		] as const) {
			const dir = agentDir();
			seedKiroAndAdjacent(dir);
			const config = await kiroProviderPackage().build({ agentDir: dir, env: {} });
			if (!config.oauth) throw new Error("Kiro OAuth provider is missing");
			const selections: string[] = [...scenario.selections];

			await expect(
				config.oauth.login({
					onAuth() {},
					onDeviceCode() {},
					onProgress() {},
					onPrompt: async () => "",
					onSelect: async () => selections.shift(),
				}),
				`scenario=${scenario.action}`,
			).rejects.toThrow("Login cancelled");

			const path = join(dir, "auth.json");
			const serialized = readFileSync(path, "utf8");
			const stored = JSON.parse(serialized) as Record<string, unknown>;
			expect(stored).not.toHaveProperty("kiro");
			expect(stored.adjacent).toEqual({ type: "api_key", key: "fixture-adjacent" });
			expect(statSync(path).mode & 0o777).toBe(0o600);
			expect(serialized).not.toContain("fixture-kiro-access");
			expect(serialized).not.toContain("fixture-kiro-refresh");
		}
	});
});
