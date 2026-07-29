import { describe, expect, it } from "vitest";
import type { AccountPoolState, AccountSlot } from "../src/core/accounts.js";
import { NoAvailableAccountError } from "../src/core/accounts.js";
import { conversationKey, placeRequest, releaseBinding, rendezvousOrder } from "../src/core/affinity.js";

function slot(name: string, overrides: Partial<AccountSlot> = {}): AccountSlot {
	return {
		name,
		access: `${name}-a`,
		refresh: `${name}-r`,
		expires: Number.MAX_SAFE_INTEGER,
		source: "login",
		...overrides,
	};
}

function pool(names: string[], overrides: Partial<AccountPoolState> = {}): AccountPoolState {
	return { accounts: names.map((name) => slot(name)), ...overrides };
}

describe("conversation key", () => {
	it("is stable for the same first message", () => {
		expect(conversationKey("build me a parser")).toBe(conversationKey("build me a parser"));
	});

	it("ignores surrounding whitespace so retries do not rebind", () => {
		expect(conversationKey("  hello  ")).toBe(conversationKey("hello"));
	});

	it("differs across conversations", () => {
		expect(conversationKey("first task")).not.toBe(conversationKey("second task"));
	});

	it("falls back when there is no user text yet", () => {
		expect(conversationKey(undefined, "session-7")).toBe("session-7");
		expect(conversationKey(undefined)).toBe("default");
	});
});

describe("rendezvous ordering", () => {
	it("is deterministic for a key", () => {
		const accounts = ["a", "b", "c"].map((name) => slot(name));
		expect(rendezvousOrder("k", accounts).map((a) => a.name)).toEqual(
			rendezvousOrder("k", accounts).map((a) => a.name),
		);
	});

	it("keeps most conversations put when an account is added", () => {
		const before = ["a", "b", "c"].map((name) => slot(name));
		const after = [...before, slot("d")];
		const keys = Array.from({ length: 60 }, (_, i) => `conv-${i}`);

		const moved = keys.filter(
			(key) => rendezvousOrder(key, before)[0]!.name !== rendezvousOrder(key, after)[0]!.name,
		).length;

		// Only conversations that rendezvous with the new account should move;
		// a naive modulo scheme would reshuffle nearly all of them.
		expect(moved).toBeLessThan(keys.length / 2);
	});
});

describe("cache-first placement", () => {
	it("returns the same account for the same conversation", () => {
		const state = pool(["a", "b", "c"]);
		const first = placeRequest(state, { key: "conv" });
		const second = placeRequest(first.state, { key: "conv" });

		expect(second.account.name).toBe(first.account.name);
		expect(second.reusedBinding).toBe(true);
	});

	it("records the binding so a warm cache survives a restart", () => {
		const placement = placeRequest(pool(["a", "b"]), { key: "conv" });
		expect(placement.state.bindings?.conv).toBe(placement.account.name);
	});

	it("ignores quota so a warm conversation is never moved for headroom", () => {
		const state = pool(["a", "b"]);
		const first = placeRequest(state, { key: "conv", usage: { a: 1, b: 1 } });
		const starved = { [first.account.name]: 0.01 };
		const second = placeRequest(first.state, { key: "conv", usage: starved });

		expect(second.account.name).toBe(first.account.name);
	});

	it("places a blocked account's conversation elsewhere", () => {
		const first = placeRequest(pool(["a", "b"]), { key: "conv", now: 0 });
		const blocked: AccountPoolState = {
			...first.state,
			accounts: first.state.accounts.map((account) =>
				account.name === first.account.name
					? { ...account, blockedUntil: 10_000, blockReason: "rate_limit" as const }
					: account,
			),
		};

		expect(placeRequest(blocked, { key: "conv", now: 0 }).account.name).not.toBe(first.account.name);
	});
});

describe("balanced placement", () => {
	it("prefers the account with the most headroom for a new conversation", () => {
		const state = pool(["a", "b", "c"]);
		const placement = placeRequest(state, {
			key: "fresh",
			mode: "balanced",
			usage: { a: 0.05, b: 0.9, c: 0.1 },
			random: () => 0,
		});

		expect(placement.account.name).toBe("b");
	});

	it("still holds the binding once the conversation is placed", () => {
		const state = pool(["a", "b"]);
		const first = placeRequest(state, { key: "conv", mode: "balanced", usage: { a: 0.9, b: 0.1 }, random: () => 0 });
		const second = placeRequest(first.state, {
			key: "conv",
			mode: "balanced",
			usage: { a: 0.1, b: 0.9 },
			random: () => 0,
		});

		expect(second.account.name).toBe(first.account.name);
		expect(second.reusedBinding).toBe(true);
	});

	it("treats unknown headroom as plenty rather than starving the account", () => {
		const placement = placeRequest(pool(["known", "unknown"]), {
			key: "fresh",
			mode: "balanced",
			usage: { known: 0.2 },
			random: () => 0,
		});

		expect(placement.account.name).toBe("unknown");
	});
});

describe("spread placement", () => {
	it("round-robins across requests and ignores bindings", () => {
		let state = pool(["a", "b", "c"], { mode: "spread" });
		const seen: string[] = [];
		for (let i = 0; i < 4; i++) {
			const placement = placeRequest(state, { key: "same-conversation" });
			seen.push(placement.account.name);
			state = placement.state;
		}
		expect(seen).toEqual(["a", "b", "c", "a"]);
	});
});

describe("pinning and exhaustion", () => {
	it("a pin overrides placement entirely", () => {
		const state = pool(["a", "b", "c"], { pinned: "c" });
		expect(placeRequest(state, { key: "anything", mode: "balanced", usage: { c: 0 } }).account.name).toBe("c");
	});

	it("falls off a pinned account that is blocked", () => {
		const state = pool(["a"], { pinned: "pinned" });
		state.accounts.push(slot("pinned", { blockedUntil: 10_000, blockReason: "rate_limit" }));
		expect(placeRequest(state, { key: "k", now: 0 }).account.name).toBe("a");
	});

	it("reports the earliest unblock time when everything is blocked", () => {
		const state: AccountPoolState = {
			accounts: [
				slot("a", { blockedUntil: 9_000, blockReason: "rate_limit" }),
				slot("b", { blockedUntil: 3_000, blockReason: "rate_limit" }),
			],
		};

		try {
			placeRequest(state, { key: "k", now: 0 });
			expect.unreachable("placement should fail when everything is blocked");
		} catch (error) {
			expect(error).toBeInstanceOf(NoAvailableAccountError);
			expect((error as NoAvailableAccountError).retryAt).toBe(3_000);
		}
	});

	it("releases a binding on demand", () => {
		const placed = placeRequest(pool(["a", "b"]), { key: "conv" });
		expect(releaseBinding(placed.state, "conv").bindings?.conv).toBeUndefined();
	});
});
