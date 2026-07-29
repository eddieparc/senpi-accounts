import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "@code-yeongyu/senpi";
import type { SenpiExtensionAPI } from "../src/index";

interface Registration {
	id: string;
	config: ProviderConfig;
}

let root: string;
let previousAccountsDir: string | undefined;
let senpiAccounts: typeof import("../src/index").default;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "senpi-accounts-registration-test-"));
	previousAccountsDir = process.env.SENPI_ACCOUNTS_DIR;
	process.env.SENPI_ACCOUNTS_DIR = root;
	vi.resetModules();
	({ default: senpiAccounts } = await import("../src/index"));
});

afterEach(() => {
	if (previousAccountsDir === undefined) {
		delete process.env.SENPI_ACCOUNTS_DIR;
	} else {
		process.env.SENPI_ACCOUNTS_DIR = previousAccountsDir;
	}
	rmSync(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function provider(name: string): ProviderConfig {
	return {
		name,
		baseUrl: "http://127.0.0.1:9",
		apiKey: "$SENPI_ACCOUNTS_TEST_KEY",
		api: "openai-completions",
		models: [
			{
				id: `${name.toLowerCase()}-model`,
				name: `${name} model`,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8192,
				maxTokens: 1024,
			},
		],
	};
}

function writeFragment(name: string, fragment: unknown): string {
	const path = join(root, name);
	writeFileSync(path, JSON.stringify(fragment));
	return path;
}

function createPi(options?: { failRegistrationFor?: string[] }): {
	pi: SenpiExtensionAPI;
	registrations: Registration[];
	unregistrations: string[];
} {
	const registrations: Registration[] = [];
	const unregistrations: string[] = [];
	const pi = {
		registerProvider(id: string, config: ProviderConfig): void {
			if (options?.failRegistrationFor?.includes(id)) {
				throw new Error(`registration failed for ${id}`);
			}
			registrations.push({ id, config });
		},
		unregisterProvider(id: string): void {
			unregistrations.push(id);
		},
	} as unknown as SenpiExtensionAPI;
	return { pi, registrations, unregistrations };
}

describe("senpi-accounts extension", () => {
	it("registers every loaded provider once before its async factory completes", async () => {
		writeFragment("10-providers.json", {
			alpha: { ...provider("Alpha"), accounts: [{ label: "personal" }] },
			beta: provider("Beta"),
		});
		const registration = createPi();

		const completion = senpiAccounts(registration.pi);
		expect(completion).toBeInstanceOf(Promise);
		await completion;

		expect(registration.registrations.map(({ id }) => id)).toEqual(["alpha", "beta"]);
		expect(registration.registrations[0]?.config).not.toHaveProperty("accounts");
		expect(registration.unregistrations).toEqual([]);
	});

	it("removes only ids it previously owned when a later invocation no longer defines them", async () => {
		writeFragment("10-providers.json", {
			alpha: provider("Alpha"),
			beta: provider("Beta"),
		});
		const firstInvocation = createPi();
		await senpiAccounts(firstInvocation.pi);

		writeFragment("10-providers.json", {
			beta: provider("Beta"),
			external: provider("External"),
		});
		const secondInvocation = createPi();
		await senpiAccounts(secondInvocation.pi);

		expect(secondInvocation.unregistrations).toEqual(["alpha"]);
		expect(secondInvocation.unregistrations).not.toContain("external");
		expect(secondInvocation.registrations.map(({ id }) => id)).toEqual(["beta", "external"]);
	});

	it("records only successfully registered ids as extension-owned", async () => {
		const filePath = writeFragment("10-providers.json", { failed: provider("Failed") });
		const reportError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const failedRegistration = createPi({ failRegistrationFor: ["failed"] });
		await senpiAccounts(failedRegistration.pi);
		expect(failedRegistration.registrations).toEqual([]);
		expect(reportError).toHaveBeenCalledWith(expect.stringContaining(filePath));

		writeFragment("10-providers.json", {});
		const laterInvocation = createPi();
		await senpiAccounts(laterInvocation.pi);
		expect(laterInvocation.unregistrations).toEqual([]);
	});

	it("retains previous owned ids when a malformed fragment makes removal ambiguous", async () => {
		writeFragment("10-providers.json", { alpha: provider("Alpha") });
		const firstInvocation = createPi();
		await senpiAccounts(firstInvocation.pi);
		expect(firstInvocation.registrations.map(({ id }) => id)).toEqual(["alpha"]);

		const invalidPath = writeFragment("10-providers.json", {
			alpha: { name: "Alpha", unknownField: true },
		});
		const reportError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const secondInvocation = createPi();
		await senpiAccounts(secondInvocation.pi);

		expect(secondInvocation.unregistrations).toEqual([]);
		expect(secondInvocation.registrations).toEqual([]);
		expect(reportError).toHaveBeenCalledWith(expect.stringContaining(invalidPath));
	});

	it("reports invalid fragments with their file path while registering valid fragments", async () => {
		const invalidPath = writeFragment("10-invalid.json", {
			invalid: { name: "Invalid", unknownField: true },
		});
		writeFragment("20-valid.json", { valid: provider("Valid") });
		const reportError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const registration = createPi();

		await senpiAccounts(registration.pi);

		expect(registration.registrations.map(({ id }) => id)).toEqual(["valid"]);
		expect(reportError).toHaveBeenCalledWith(expect.stringContaining(invalidPath));
	});
});
