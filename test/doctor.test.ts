import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "senpi-accounts-doctor-test-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function makeDir(...segments: string[]): string {
	const directory = join(root, ...segments);
	mkdirSync(directory, { recursive: true });
	return directory;
}

function writeFragment(directory: string, name: string, fragment: unknown): string {
	const filePath = join(directory, name);
	writeFileSync(filePath, JSON.stringify(fragment));
	return filePath;
}

function provider(apiKey: string) {
	return {
		name: "Doctor test provider",
		baseUrl: "http://127.0.0.1:9",
		apiKey,
		api: "anthropic-messages",
		models: [
			{
				id: "doctor-model",
				name: "Doctor model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8192,
				maxTokens: 1024,
			},
		],
	};
}

function doctor(directory: string, homeDir = makeDir("home"), env: NodeJS.ProcessEnv = {}) {
	return runDoctor({
		env: { SENPI_ACCOUNTS_DIR: directory, ...env },
		homeDir,
		agentDir: join(homeDir, ".senpi", "agent"),
	});
}

describe("senpi-accounts doctor", () => {
	it("reports loaded fragments and registered providers as resolved without revealing a resolved secret", () => {
		const directory = makeDir("providers.d");
		const secret = "sk-ant-api03-DOCTOR_TEST_SECRET_1234567890";
		const fragmentPath = writeFragment(directory, "10-happy.json", {
			good: {
				...provider(`!printf '%s' ${secret}`),
				headers: { "x-credential": "$DOCTOR_TEST_HEADER" },
			},
		});

		const result = doctor(directory, makeDir("home"), { DOCTOR_TEST_HEADER: "placeholder" });

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain(`config-dir: ${directory}`);
		expect(result.output).toContain(`fragment: ${fragmentPath} loaded=true resolves=true`);
		expect(result.output).toContain("provider: good registered=true resolves=true");
		expect(result.output).toContain(
			`credential: fragment=${fragmentPath} provider=good field=apiKey resolves=true`,
		);
		expect(result.output).toContain(
			`credential: fragment=${fragmentPath} provider=good field=header:x-credential resolves=true`,
		);
		expect(result.output).not.toContain(secret);
		expect(result.output).not.toMatch(/sk-ant-(?:api\d{2}|oat\d{2}|ort\d{2})-[A-Za-z0-9_-]+/);
	});

	it("exits nonzero and names the fragment, provider, and failing command path", () => {
		const directory = makeDir("providers.d");
		const fragmentPath = writeFragment(directory, "20-broken.json", {
			broken: provider("!/nonexistent/script"),
		});

		const result = doctor(directory);

		expect(result.exitCode).not.toBe(0);
		expect(result.output).toContain(`fragment: ${fragmentPath}`);
		expect(result.output).toContain("provider=broken");
		expect(result.output).toContain("/nonexistent/script");
		expect(result.output).toContain("resolves=false");
	});

	it("names active legacy ownership collisions explicitly without mutating fixture files", () => {
		const homeDir = makeDir("home");
		const directory = makeDir("providers.d");
		writeFragment(directory, "10-extension.json", { collision: provider("$DOCTOR_TEST_KEY") });

		const legacyDir = makeDir("home", ".config", "omo-providers");
		const ownedPath = join(legacyDir, ".owned-providers.json");
		writeFileSync(ownedPath, JSON.stringify({ providers: ["collision"] }));
		const agentDir = makeDir("home", ".senpi", "agent");
		const modelsPath = join(agentDir, "models.json");
		writeFileSync(modelsPath, JSON.stringify({ providers: { collision: { name: "Legacy collision" } } }));
		const before = {
			fragment: readFileSync(join(directory, "10-extension.json"), "utf8"),
			owned: readFileSync(ownedPath, "utf8"),
			models: readFileSync(modelsPath, "utf8"),
		};

		const result = runDoctor({
			env: { SENPI_ACCOUNTS_DIR: directory, DOCTOR_TEST_KEY: "placeholder" },
			homeDir,
			agentDir,
		});

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("legacy-layer: active=true");
		expect(result.output).toContain("collision: provider=collision");
		expect(result.output).toContain("legacy-owned");
		expect(readFileSync(join(directory, "10-extension.json"), "utf8")).toBe(before.fragment);
		expect(readFileSync(ownedPath, "utf8")).toBe(before.owned);
		expect(readFileSync(modelsPath, "utf8")).toBe(before.models);
	});
});
