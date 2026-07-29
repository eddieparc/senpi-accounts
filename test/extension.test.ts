import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerProviderPackages } from "../src/core/registry.js";
import type { ProviderBuildContext, ProviderPackage } from "../src/core/types.js";

function agentDir(): string {
	return mkdtempSync(join(tmpdir(), "senpi-accounts-ext-"));
}

function context(): ProviderBuildContext {
	return { env: {} as NodeJS.ProcessEnv, agentDir: agentDir() };
}

/** Minimal stand-in for the pieces of ExtensionAPI the registry touches. */
function fakePi() {
	const registered = new Map<string, unknown>();
	const unregistered: string[] = [];
	return {
		events: {},
		registerProvider: vi.fn((name: string, config: unknown) => {
			registered.set(name, config);
		}),
		unregisterProvider: vi.fn((name: string) => {
			unregistered.push(name);
		}),
		registerCommand: vi.fn(),
		registered,
		unregistered,
	};
}

function healthyPackage(id: string): ProviderPackage {
	return { id, label: id, build: () => ({ name: id, apiKey: "x" }) };
}

function brokenPackage(id: string): ProviderPackage {
	return {
		id,
		label: id,
		build: () => {
			throw new Error(`${id} exploded`);
		},
	};
}

describe("provider isolation", () => {
	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
	});

	it("registers every healthy provider", async () => {
		const pi = fakePi();
		const { health } = await registerProviderPackages(pi as never, [healthyPackage("a"), healthyPackage("b")], context());

		expect(health.every((entry) => entry.status === "registered")).toBe(true);
		expect([...pi.registered.keys()]).toEqual(["a", "b"]);
	});

	it("keeps other providers working when one throws while building", async () => {
		const pi = fakePi();
		const { health } = await registerProviderPackages(
			pi as never,
			[healthyPackage("first"), brokenPackage("broken"), healthyPackage("last")],
			context(),
		);

		expect([...pi.registered.keys()]).toEqual(["first", "last"]);
		const broken = health.find((entry) => entry.providerId === "broken");
		expect(broken?.status).toBe("degraded");
		expect(broken && "reason" in broken ? broken.reason : "").toMatch(/exploded/);
	});

	it("keeps other providers working when registration itself throws", async () => {
		const pi = fakePi();
		pi.registerProvider.mockImplementationOnce(() => {
			throw new Error("registry rejected");
		});

		const { health } = await registerProviderPackages(
			pi as never,
			[healthyPackage("rejected"), healthyPackage("survivor")],
			context(),
		);

		expect([...pi.registered.keys()]).toEqual(["survivor"]);
		expect(health.find((entry) => entry.providerId === "rejected")?.status).toBe("degraded");
	});

	it("skips a provider that reports itself disabled", async () => {
		const pi = fakePi();
		const disabled: ProviderPackage = {
			id: "off",
			label: "off",
			enabled: () => "no credentials configured",
			build: () => ({ name: "off" }),
		};

		const { health } = await registerProviderPackages(pi as never, [disabled, healthyPackage("on")], context());

		expect([...pi.registered.keys()]).toEqual(["on"]);
		const skipped = health.find((entry) => entry.providerId === "off");
		expect(skipped?.status).toBe("skipped");
		expect(skipped && "reason" in skipped ? skipped.reason : "").toBe("no credentials configured");
	});

	it("releases providers it registered earlier but no longer registers", async () => {
		const pi = fakePi();
		const ctx = context();

		await registerProviderPackages(pi as never, [healthyPackage("kept"), healthyPackage("dropped")], ctx);
		await registerProviderPackages(pi as never, [healthyPackage("kept")], ctx);

		// The reload must not leave a stale provider whose credentials senpi can
		// no longer refresh.
		expect(pi.unregistered).toEqual(["dropped"]);
	});
});

describe("extension entry", () => {
	it("registers providers and the usage/health commands", async () => {
		const pi = fakePi();
		const previous = process.env.SENPI_CODING_AGENT_DIR;
		process.env.SENPI_CODING_AGENT_DIR = agentDir();

		try {
			const { default: senpiAccounts } = await import("../src/index.js");
			await senpiAccounts(pi as never);
		} finally {
			if (previous === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
			else process.env.SENPI_CODING_AGENT_DIR = previous;
		}

		expect(pi.registered.has("kiro")).toBe(true);
		const commands = pi.registerCommand.mock.calls.map((call) => call[0]);
		expect(commands).toContain("usage");
		expect(commands).toContain("senpi-accounts");
	});
});
