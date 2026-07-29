import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadProviderFragments,
	type LoadFragmentsResult,
} from "../src/config";

const FORBIDDEN_FIELDS = [
	"whitelist",
	"blacklist",
	"disabled",
	"compat",
	"cacheRetention",
	"modelOverrides",
] as const;

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "senpi-accounts-test-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function makeDir(...segments: string[]): string {
	const dir = join(root, ...segments);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function defaultDirs(home: string): { primary: string; legacy: string } {
	return {
		primary: join(home, ".config", "senpi-accounts", "providers.d"),
		legacy: join(home, ".config", "omo-providers", "providers.d"),
	};
}

function writeFile(dir: string, name: string, contents: string): string {
	const filePath = join(dir, name);
	writeFileSync(filePath, contents);
	return filePath;
}

function writeFragment(dir: string, name: string, fragment: unknown): string {
	return writeFile(dir, name, JSON.stringify(fragment));
}

function load(envDir: string): LoadFragmentsResult {
	return loadProviderFragments({
		env: { SENPI_ACCOUNTS_DIR: envDir },
		homeDir: join(root, "home"),
	});
}

function loadWithHome(home: string): LoadFragmentsResult {
	return loadProviderFragments({ env: {}, homeDir: home });
}

function providerIds(result: LoadFragmentsResult): string[] {
	return result.fragments.flatMap((f) => f.providers.map((p) => p.providerId));
}

describe("loadProviderFragments", () => {
	it("loads a valid fragment, carrying provider fields and accounts through", () => {
		const dir = makeDir("providers.d");
		writeFragment(dir, "10-ccapi.json", {
			ccapi: {
				name: "CC API",
				baseUrl: "https://ccapi.example.test",
				api: "anthropic-messages",
				apiKey: "!echo test-key",
				authHeader: true,
				headers: { "x-api-key": "!echo test-key" },
				accounts: [{ label: "work" }, { label: "personal" }],
			},
		});
		const result = load(dir);
		expect(result.errors).toEqual([]);
		expect(result.dir).toBe(dir);
		expect(result.fragments).toHaveLength(1);
		const entry = result.fragments[0]?.providers[0];
		expect(entry?.providerId).toBe("ccapi");
		expect(entry?.fields).toMatchObject({
			name: "CC API",
			baseUrl: "https://ccapi.example.test",
			apiKey: "!echo test-key",
		});
		expect(entry?.fields).not.toHaveProperty("accounts");
		expect(entry?.accounts).toEqual([{ label: "work" }, { label: "personal" }]);
	});

	it("loads every .json file sorted by filename", () => {
		const dir = makeDir("providers.d");
		writeFragment(dir, "20-b.json", { b: { name: "B" } });
		writeFragment(dir, "10-a.json", { a: { name: "A" } });
		const result = load(dir);
		expect(result.errors).toEqual([]);
		expect(result.fragments.map((f) => f.filePath)).toEqual([
			join(dir, "10-a.json"),
			join(dir, "20-b.json"),
		]);
	});

	it("ignores files whose name does not end in .json", () => {
		const dir = makeDir("providers.d");
		writeFragment(dir, "20-kiro.json.disabled", { kiro: { name: "Kiro" } });
		writeFile(dir, "README.md", "not a fragment");
		writeFragment(dir, "10-ccapi.json", { ccapi: { name: "CC" } });
		const result = load(dir);
		expect(result.errors).toEqual([]);
		expect(result.fragments.map((f) => f.filePath)).toEqual([
			join(dir, "10-ccapi.json"),
		]);
	});

	it("rejects an unknown field with an error naming the file and the key", () => {
		const dir = makeDir("providers.d");
		const filePath = writeFragment(dir, "10-ccapi.json", {
			ccapi: { name: "CC", frobnicate: true },
		});
		const result = load(dir);
		expect(result.fragments[0]?.providers).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.message).toContain(filePath);
		expect(result.errors[0]?.message).toContain("frobnicate");
	});

	it.each(FORBIDDEN_FIELDS)(
		"rejects forbidden field %s as not expressible through the extension API",
		(field) => {
			const dir = makeDir("providers.d");
			const filePath = writeFragment(dir, "10-ccapi.json", {
				ccapi: { name: "CC", [field]: {} },
			});
			const result = load(dir);
			expect(result.fragments[0]?.providers).toEqual([]);
			expect(result.errors).toHaveLength(1);
			const message = result.errors[0]?.message ?? "";
			expect(message).toContain(filePath);
			expect(message).toContain(field);
			expect(message).toContain("not expressible through the extension API");
			expect(message).toContain("models.json");
		},
	);

	it("rejects a non-array accounts field", () => {
		const dir = makeDir("providers.d");
		const filePath = writeFragment(dir, "10-ccapi.json", {
			ccapi: { name: "CC", accounts: "not-an-array" },
		});
		const result = load(dir);
		expect(result.fragments[0]?.providers).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.message).toContain(filePath);
		expect(result.errors[0]?.message).toContain("accounts");
	});

	it("reports malformed JSON naming the file and still loads the other fragments", () => {
		const dir = makeDir("providers.d");
		const badPath = writeFile(dir, "10-bad.json", "{ not json");
		writeFragment(dir, "20-good.json", { good: { name: "Good" } });
		const result = load(dir);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.message).toContain(badPath);
		expect(result.fragments.map((f) => f.filePath)).toEqual([
			join(dir, "20-good.json"),
		]);
		expect(result.fragments[0]?.providers[0]?.providerId).toBe("good");
	});

	it("rejects a fragment whose top level is not a JSON object", () => {
		const dir = makeDir("providers.d");
		const filePath = writeFile(dir, "10-list.json", '["not","an","object"]');
		const result = load(dir);
		expect(result.fragments).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.message).toContain(filePath);
	});

	it("returns zero fragments without throwing when no directory exists", () => {
		const result = loadWithHome(join(root, "no-such-home"));
		expect(result.dir).toBeNull();
		expect(result.fragments).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	it("treats a missing $SENPI_ACCOUNTS_DIR as zero fragments and suppresses the fallback", () => {
		const home = makeDir("home");
		const { legacy } = defaultDirs(home);
		mkdirSync(legacy, { recursive: true });
		writeFragment(legacy, "10-legacy.json", { legacy: { name: "Legacy" } });
		const result = loadProviderFragments({
			env: { SENPI_ACCOUNTS_DIR: join(root, "missing-env-dir") },
			homeDir: home,
		});
		expect(result.dir).toBeNull();
		expect(result.fragments).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	it("prefers $SENPI_ACCOUNTS_DIR over both default directories", () => {
		const home = makeDir("home");
		const { primary, legacy } = defaultDirs(home);
		mkdirSync(primary, { recursive: true });
		mkdirSync(legacy, { recursive: true });
		writeFragment(primary, "10-primary.json", { primary: { name: "Primary" } });
		writeFragment(legacy, "10-legacy.json", { legacy: { name: "Legacy" } });
		const envDir = makeDir("env-override");
		writeFragment(envDir, "10-env.json", { fromEnv: { name: "Env" } });
		const result = loadProviderFragments({
			env: { SENPI_ACCOUNTS_DIR: envDir },
			homeDir: home,
		});
		expect(result.dir).toBe(envDir);
		expect(providerIds(result)).toEqual(["fromEnv"]);
	});

	it("uses the primary default directory when it exists, ignoring the legacy fallback", () => {
		const home = makeDir("home");
		const { primary, legacy } = defaultDirs(home);
		mkdirSync(primary, { recursive: true });
		mkdirSync(legacy, { recursive: true });
		writeFragment(primary, "10-primary.json", { primary: { name: "Primary" } });
		writeFragment(legacy, "10-legacy.json", { legacy: { name: "Legacy" } });
		const result = loadWithHome(home);
		expect(result.dir).toBe(primary);
		expect(providerIds(result)).toEqual(["primary"]);
	});

	it("falls back to the legacy omo-providers directory only when the primary is absent", () => {
		const home = makeDir("home");
		const { legacy } = defaultDirs(home);
		mkdirSync(legacy, { recursive: true });
		writeFragment(legacy, "10-legacy.json", { legacy: { name: "Legacy" } });
		const result = loadWithHome(home);
		expect(result.dir).toBe(legacy);
		expect(providerIds(result)).toEqual(["legacy"]);
	});
});
