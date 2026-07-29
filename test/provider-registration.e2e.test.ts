import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SENPI_CLI = join(REPOSITORY_ROOT, "node_modules", "@code-yeongyu", "senpi", "dist", "cli.js");
const EXTENSION_ENTRY = join(REPOSITORY_ROOT, "dist", "index.js");
const KIRO_PRESET_FILE = join(REPOSITORY_ROOT, "presets", "20-kiro.json.disabled");
const PROVIDER_ID = "omo-e2e-anthropic";
const MODEL_ID = "omo-e2e-model";
const MULTI_ACCOUNT_PROVIDER_ID = "omo-e2e-accounts";
const MULTI_ACCOUNT_MODEL_ID = "omo-e2e-account-model";
const KIRO_PROVIDER_ID = "kiro";
const KIRO_MODEL_ID = "claude-haiku-4.5";
const MOCK_API_KEY_ENV = "SENPI_ACCOUNTS_E2E_MOCK_KEY";
const MOCK_API_KEY = "e2e-placeholder-api-key";
const REQUEST_TIMEOUT_MS = 30_000;
const SENPI_STARTUP_ARGS = [
	"--no-extensions",
	"--no-skills",
	"--no-prompt-templates",
	"--no-themes",
	"--no-context-files",
	"--offline",
];
// Keep the pre-existing inference invocation order intact. The old e2e probe
// is a regression lock; only the account-listing invocation needs new args.
const INFERENCE_ARGS = [
	...SENPI_STARTUP_ARGS,
	"--no-tools",
	"--extension",
	EXTENSION_ENTRY,
	"--provider",
	PROVIDER_ID,
	"--model",
	MODEL_ID,
	"--no-session",
	"-p",
	"Reply with exactly: OMOPROBE",
];
const LIST_MODELS_ARGS = [...SENPI_STARTUP_ARGS, "--extension", EXTENSION_ENTRY, "--list-models"];
const KIRO_INFERENCE_ARGS = [
	...SENPI_STARTUP_ARGS,
	"--no-tools",
	"--extension",
	EXTENSION_ENTRY,
	"--provider",
	KIRO_PROVIDER_ID,
	"--model",
	KIRO_MODEL_ID,
	"--no-session",
	"-p",
	"Reply with exactly: OMOPROBE",
];

interface CapturedRequest {
	method: string | undefined;
	url: string | undefined;
	headers: IncomingHttpHeaders;
	body: string;
}

interface CommandResult {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

interface MockAnthropicServer {
	server: Server;
	port: number;
	baseUrl: string;
	requests: CapturedRequest[];
	firstRequest: Promise<CapturedRequest>;
}

function withTimeout<T>(promise: Promise<T>, description: string, onTimeout?: () => void): Promise<T> {
	return new Promise<T>((resolvePromise, rejectPromise) => {
		const timer = setTimeout(() => {
			onTimeout?.();
			rejectPromise(new Error(`Timed out waiting for ${description}`));
		}, REQUEST_TIMEOUT_MS);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolvePromise(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				rejectPromise(error);
			},
		);
	});
}

function listen(server: Server, port: number): Promise<void> {
	return new Promise<void>((resolvePromise, rejectPromise) => {
		const onListening = () => {
			cleanup();
			resolvePromise();
		};
		const onError = (error: Error) => {
			cleanup();
			rejectPromise(error);
		};
		const cleanup = () => {
			server.off("listening", onListening);
			server.off("error", onError);
		};

		server.once("listening", onListening);
		server.once("error", onError);
		server.listen(port, "127.0.0.1");
	});
}

function close(server: Server): Promise<void> {
	return new Promise<void>((resolvePromise, rejectPromise) => {
		const onClose = () => {
			cleanup();
			resolvePromise();
		};
		const onError = (error: Error) => {
			cleanup();
			rejectPromise(error);
		};
		const cleanup = () => {
			server.off("close", onClose);
			server.off("error", onError);
		};

		server.once("close", onClose);
		server.once("error", onError);
		server.close((error) => {
			if (error) {
				cleanup();
				rejectPromise(error);
			}
		});
	});
}

function anthropicMessage() {
	return {
		id: "msg_omo_probe",
		type: "message",
		role: "assistant",
		model: MODEL_ID,
		content: [{ type: "text", text: "OMOPROBE" }],
		stop_reason: "end_turn",
		stop_sequence: null,
		usage: {
			input_tokens: 1,
			output_tokens: 1,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
		},
	};
}

function writeSse(response: import("node:http").ServerResponse, event: string, data: object): void {
	response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function respondWithAnthropicStream(response: import("node:http").ServerResponse): void {
	response.writeHead(200, {
		"cache-control": "no-cache",
		connection: "close",
		"content-type": "text/event-stream",
	});
	response.flushHeaders();
	const message = anthropicMessage();
	writeSse(response, "message_start", {
		type: "message_start",
		message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } },
	});
	writeSse(response, "content_block_start", {
		type: "content_block_start",
		index: 0,
		content_block: { type: "text", text: "" },
	});
	writeSse(response, "content_block_delta", {
		type: "content_block_delta",
		index: 0,
		delta: { type: "text_delta", text: "OMOPROBE" },
	});
	writeSse(response, "content_block_stop", { type: "content_block_stop", index: 0 });
	writeSse(response, "message_delta", {
		type: "message_delta",
		delta: { stop_reason: "end_turn", stop_sequence: null },
		usage: { output_tokens: 1 },
	});
	writeSse(response, "message_stop", { type: "message_stop" });
	response.end();
}

function respondWithAnthropicMessage(response: import("node:http").ServerResponse): void {
	const body = JSON.stringify(anthropicMessage());
	response.writeHead(200, {
		"content-length": Buffer.byteLength(body),
		"content-type": "application/json",
	});
	response.end(body);
}

function requestWantsStream(body: string): boolean {
	try {
		return (JSON.parse(body) as { stream?: unknown }).stream === true;
	} catch {
		return false;
	}
}

async function startMockAnthropicServer(): Promise<MockAnthropicServer> {
	const requests: CapturedRequest[] = [];
	let resolveFirstRequest: (request: CapturedRequest) => void = () => undefined;
	const firstRequest = new Promise<CapturedRequest>((resolvePromise) => {
		resolveFirstRequest = resolvePromise;
	});
	let receivedFirstRequest = false;

	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.once("end", () => {
			const captured: CapturedRequest = {
				method: request.method,
				url: request.url,
				headers: { ...request.headers },
				body: Buffer.concat(chunks).toString("utf8"),
			};
			requests.push(captured);
			if (!receivedFirstRequest) {
				receivedFirstRequest = true;
				resolveFirstRequest(captured);
			}

			if (request.method === "POST" && request.url === "/v1/messages") {
				if (requestWantsStream(captured.body)) {
					respondWithAnthropicStream(response);
				} else {
					respondWithAnthropicMessage(response);
				}
				return;
			}

			response.writeHead(404, { "content-type": "application/json" });
			response.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "not found" } }));
		});
	});

	await withTimeout(listen(server, 0), "the local mock server listening event");
	const address = server.address();
	if (address === null || typeof address === "string") {
		await withTimeout(close(server), "the local mock server close event");
		throw new Error("The local mock server did not bind a TCP port");
	}

	return {
		server,
		port: address.port,
		baseUrl: `http://127.0.0.1:${address.port}`,
		requests,
		firstRequest,
	};
}

async function provePortReleased(port: number): Promise<void> {
	const probe = createServer();
	try {
		await withTimeout(listen(probe, port), "the released mock-server port listening event");
	} finally {
		if (probe.listening) {
			await withTimeout(close(probe), "the port-release probe close event");
		}
	}
}

function writeProviderFragment(directory: string, baseUrl: string): void {
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "10-omo-e2e-provider.json"),
		JSON.stringify({
			[PROVIDER_ID]: {
				name: "OMO E2E Anthropic mock",
				baseUrl,
				apiKey: `$${MOCK_API_KEY_ENV}`,
				authHeader: false,
				api: "anthropic-messages",
				models: [
					{
						id: MODEL_ID,
						name: "OMO E2E model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 200_000,
						maxTokens: 1024,
					},
				],
			},
		}),
	);
}

function writeKiroPresetFixture(directory: string, baseUrl: string): void {
	mkdirSync(directory, { recursive: true });
	const preset = JSON.parse(readFileSync(KIRO_PRESET_FILE, "utf8")) as {
		kiro: { baseUrl: string };
	};
	preset.kiro.baseUrl = baseUrl;
	writeFileSync(join(directory, "20-kiro.json"), JSON.stringify(preset));
}

function writeMultiAccountProviderFragment(directory: string, baseUrl: string): void {
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "20-omo-e2e-accounts.json"),
		JSON.stringify({
			[MULTI_ACCOUNT_PROVIDER_ID]: {
				name: "OMO E2E account mock",
				baseUrl,
				api: "anthropic-messages",
				authHeader: false,
				models: [
					{
						id: MULTI_ACCOUNT_MODEL_ID,
						name: "OMO E2E account model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 200_000,
						maxTokens: 1024,
					},
				],
				accounts: [
					{ id: "first", label: "First", apiKey: "!printf account-one" },
					{ id: "second", label: "Second", apiKey: "!printf account-two" },
				],
			},
		}),
	);
}

function runSenpi(
	root: string,
	providersDirectory: string,
	argumentsForSenpi: readonly string[] = INFERENCE_ARGS,
): Promise<CommandResult> {
	if (!existsSync(EXTENSION_ENTRY)) {
		throw new Error(`Missing built extension at ${EXTENSION_ENTRY}; run npm run build before this E2E test`);
	}

	const child = spawn(
		process.execPath,
		[SENPI_CLI, ...argumentsForSenpi],
		{
			cwd: root,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				HOME: root,
				NO_COLOR: "1",
				PATH: process.env.PATH ?? "",
				PI_OFFLINE: "1",
				PI_TELEMETRY: "0",
				SENPI_ACCOUNTS_DIR: providersDirectory,
				SENPI_CODING_AGENT_DIR: join(root, "senpi-agent"),
				[MOCK_API_KEY_ENV]: MOCK_API_KEY,
				KIRO_GATEWAY_API_KEY: MOCK_API_KEY,
			},
		},
	);
	child.stdin.end();

	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
	child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

	const completed = new Promise<CommandResult>((resolvePromise, rejectPromise) => {
		child.once("error", rejectPromise);
		child.once("close", (exitCode, signal) => {
			resolvePromise({
				exitCode,
				signal,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			});
		});
	});

	return withTimeout(completed, "the real senpi process", () => child.kill("SIGKILL")).catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`${message}\nstdout:\n${Buffer.concat(stdout).toString("utf8")}\nstderr:\n${Buffer.concat(stderr).toString("utf8")}`,
		);
	});
}

async function awaitRequestBeforeExit(
	server: MockAnthropicServer,
	result: Promise<CommandResult>,
): Promise<CapturedRequest> {
	return withTimeout(
		Promise.race([
			server.firstRequest,
			result.then((completed) => {
				throw new Error(
					`senpi exited before reaching the local mock server (exit ${String(completed.exitCode)}): ${completed.stderr}`,
				);
			}),
		]),
		"the real senpi request reaching the local mock server",
	);
}

async function closeAndProvePortReleased(server: MockAnthropicServer): Promise<void> {
	await withTimeout(close(server.server), "the local mock server close event");
	await provePortReleased(server.port);
}

async function runWithFixture(
	baseUrlFor: (server: MockAnthropicServer) => string,
	assertion: (server: MockAnthropicServer, result: CommandResult, request: CapturedRequest) => Promise<void>,
): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "senpi-accounts-provider-e2e-"));
	const providersDirectory = join(root, "providers.d");
	const server = await startMockAnthropicServer();
	try {
		writeProviderFragment(providersDirectory, baseUrlFor(server));
		const result = runSenpi(root, providersDirectory);
		const request = await awaitRequestBeforeExit(server, result);
		await assertion(server, await result, request);
		await closeAndProvePortReleased(server);
	} finally {
		if (server.server.listening) {
			await withTimeout(close(server.server), "the local mock server cleanup close event");
		}
		rmSync(root, { recursive: true, force: true });
	}
}

describe("provider registration against a local Anthropic Messages server", () => {
	it("registers an Anthropic Messages provider and completes an OMOPROBE round trip", async () => {
		await runWithFixture(
			(server) => server.baseUrl,
			async (server, result, request) => {
				expect(result.exitCode, result.stderr).toBe(0);
				expect(result.signal).toBeNull();
				expect(result.stdout).toContain("OMOPROBE");
				expect(server.requests).toHaveLength(1);
				expect(request.method).toBe("POST");
				expect(request.url).toBe("/v1/messages");
				expect(request.headers["x-api-key"]).toBe(MOCK_API_KEY);
				expect(request.headers.authorization).toBeUndefined();
				expect(JSON.parse(request.body)).toMatchObject({ model: MODEL_ID, stream: true });
			},
		);
	}, REQUEST_TIMEOUT_MS + 5_000);

	it("makes two declarative account providers available to the real senpi CLI", async () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-accounts-multi-account-e2e-"));
		const providersDirectory = join(root, "providers.d");
		try {
			writeMultiAccountProviderFragment(providersDirectory, "http://127.0.0.1:9");
			const result = await runSenpi(root, providersDirectory, LIST_MODELS_ARGS);

			expect(result.exitCode, result.stderr).toBe(0);
			expect(result.signal).toBeNull();
			expect(result.stdout).toContain(MULTI_ACCOUNT_PROVIDER_ID);
			expect(result.stdout).toContain(`${MULTI_ACCOUNT_PROVIDER_ID}-account-2`);
			expect(result.stdout).toContain(MULTI_ACCOUNT_MODEL_ID);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, REQUEST_TIMEOUT_MS + 5_000);

	it("loads the explicitly enabled Kiro preset through the real CLI while its fixture gateway is listening", async () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-accounts-kiro-list-e2e-"));
		const providersDirectory = join(root, "providers.d");
		const server = await startMockAnthropicServer();
		try {
			writeKiroPresetFixture(providersDirectory, server.baseUrl);
			const result = await runSenpi(root, providersDirectory, LIST_MODELS_ARGS);

			expect(result.exitCode, result.stderr).toBe(0);
			expect(result.signal).toBeNull();
			expect(result.stdout.split("\n").filter((line) => /^kiro\s+/u.test(line))).toHaveLength(9);
			expect(result.stdout).toContain(KIRO_MODEL_ID);
		} finally {
			await closeAndProvePortReleased(server);
			rmSync(root, { recursive: true, force: true });
		}
	}, REQUEST_TIMEOUT_MS + 5_000);

	it("reports the configured Kiro gateway URL when inference cannot connect", async () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-accounts-kiro-unavailable-e2e-"));
		const providersDirectory = join(root, "providers.d");
		const unavailable = await startMockAnthropicServer();
		const unavailableBaseUrl = unavailable.baseUrl;
		await closeAndProvePortReleased(unavailable);
		try {
			writeKiroPresetFixture(providersDirectory, unavailableBaseUrl);
			const result = await runSenpi(root, providersDirectory, KIRO_INFERENCE_ARGS);
			const output = `${result.stdout}\n${result.stderr}`;

			expect(result.exitCode).not.toBe(0);
			expect(output).toContain(unavailableBaseUrl);
			expect(output).toMatch(/(?:ECONNREFUSED|connect|connection|fetch failed)/iu);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, REQUEST_TIMEOUT_MS + 5_000);

	it("documents the /v1 baseUrl pitfall by rejecting the doubled Messages path", async () => {
		await runWithFixture(
			(server) => `${server.baseUrl}/v1`,
			async (server, result, request) => {
				expect(result.exitCode).not.toBe(0);
				expect(request.method).toBe("POST");
				expect(request.url).toBe("/v1/v1/messages");
				expect(server.requests.every((captured) => captured.url === "/v1/v1/messages")).toBe(true);
			},
		);
	}, REQUEST_TIMEOUT_MS + 5_000);
});
