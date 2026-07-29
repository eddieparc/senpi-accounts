#!/usr/bin/env node

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProviderFragments, type ProviderFragment } from "./config.js";

export interface DoctorOptions {
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	agentDir?: string;
}

export interface DoctorResult {
	exitCode: number;
	output: string;
}

interface CredentialStatus {
	field: string;
	resolves: boolean;
	command?: string;
}

interface FragmentStatus {
	filePath: string;
	loaded: boolean;
	resolves: boolean;
	credentials: Array<CredentialStatus & { providerId: string }>;
	errors: string[];
}

interface LegacyLayerStatus {
	active: boolean;
	ownedProviderIds: string[];
	errors: string[];
}

type ConfigValuePart = { type: "literal"; value: string } | { type: "env"; name: string };

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

// Values from paths, provider ids, command text, and parser messages all pass
// through this final scrubber. A doctor must remain safe even when a user put a
// credential-shaped value in a filename or a shell command.
const CREDENTIAL_SHAPED_PATTERNS = [
	/sk-ant-(?:api\d{2}|oat\d{2}|ort\d{2})-[A-Za-z0-9_-]+/gi,
	/sk-ant-[A-Za-z0-9_-]{20,}/gi,
	/sk-(?:proj|admin|svcacct)-[A-Za-z0-9_-]{16,}/gi,
	/(?:ghp|gho)_[A-Za-z0-9_]{20,}/gi,
	/github_pat_[A-Za-z0-9_]{20,}/gi,
	/AIza[0-9A-Za-z_-]{30,}/g,
	/xox[baprs]-[0-9A-Za-z-]{20,}/gi,
	/AKIA[0-9A-Z]{16}/g,
];

function redactCredentialShapes(value: string): string {
	return CREDENTIAL_SHAPED_PATTERNS.reduce(
		(redacted, pattern) => redacted.replace(pattern, "[REDACTED]"),
		value,
	);
}

function appendLiteral(parts: ConfigValuePart[], value: string): void {
	if (!value) return;
	const previous = parts.at(-1);
	if (previous?.type === "literal") {
		previous.value += value;
		return;
	}
	parts.push({ type: "literal", value });
}

/** Matches senpi's documented $ENV, ${ENV}, $$, and $! parsing rules. */
function parseTemplate(config: string): ConfigValuePart[] {
	const parts: ConfigValuePart[] = [];
	let index = 0;
	while (index < config.length) {
		const dollarIndex = config.indexOf("$", index);
		if (dollarIndex < 0) {
			appendLiteral(parts, config.slice(index));
			break;
		}
		appendLiteral(parts, config.slice(index, dollarIndex));
		const nextCharacter = config[dollarIndex + 1];
		if (nextCharacter === "$" || nextCharacter === "!") {
			appendLiteral(parts, nextCharacter);
			index = dollarIndex + 2;
			continue;
		}
		if (nextCharacter === "{") {
			const endIndex = config.indexOf("}", dollarIndex + 2);
			if (endIndex < 0) {
				appendLiteral(parts, "$");
				index = dollarIndex + 1;
				continue;
			}
			const name = config.slice(dollarIndex + 2, endIndex);
			if (ENV_VAR_NAME_RE.test(name)) {
				parts.push({ type: "env", name });
			} else {
				appendLiteral(parts, config.slice(dollarIndex, endIndex + 1));
			}
			index = endIndex + 1;
			continue;
		}
		const match = config.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_RE);
		if (match) {
			parts.push({ type: "env", name: match[0] });
			index = dollarIndex + 1 + match[0].length;
			continue;
		}
		appendLiteral(parts, "$");
		index = dollarIndex + 1;
	}
	return parts;
}

function environmentValue(name: string, env: NodeJS.ProcessEnv): string | undefined {
	return env[name] || process.env[name] || undefined;
}

function commandResolves(command: string, env: NodeJS.ProcessEnv): boolean {
	try {
		const output = execSync(command, {
			encoding: "utf8",
			timeout: 10_000,
			stdio: ["ignore", "pipe", "ignore"],
			env: { ...process.env, ...env },
		});
		return output.trim().length > 0;
	} catch {
		return false;
	}
}

function credentialStatus(value: string, field: string, env: NodeJS.ProcessEnv): CredentialStatus {
	if (value.startsWith("!")) {
		const command = value.slice(1);
		return { field, resolves: commandResolves(command, env), command };
	}

	const resolves = parseTemplate(value).every(
		(part) => part.type !== "env" || environmentValue(part.name, env) !== undefined,
	);
	return { field, resolves };
}

function providerCredentialStatuses(
	fields: { apiKey?: string; headers?: Record<string, string> },
	env: NodeJS.ProcessEnv,
): CredentialStatus[] {
	const statuses: CredentialStatus[] = [];
	if (typeof fields.apiKey === "string") {
		statuses.push(credentialStatus(fields.apiKey, "apiKey", env));
	}
	for (const [headerName, value] of Object.entries(fields.headers ?? {})) {
		statuses.push(credentialStatus(value, `header:${headerName}`, env));
	}
	return statuses;
}

function fragmentStatus(fragment: ProviderFragment, env: NodeJS.ProcessEnv): FragmentStatus {
	const credentials = fragment.providers.flatMap((provider) =>
		providerCredentialStatuses(provider.fields, env).map((status) => ({
			...status,
			providerId: provider.providerId,
		})),
	);
	return {
		filePath: fragment.filePath,
		loaded: true,
		resolves: credentials.every((status) => status.resolves),
		credentials,
		errors: [],
	};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): { value?: unknown; error?: string } {
	try {
		return { value: JSON.parse(readFileSync(path, "utf8")) as unknown };
	} catch {
		return { error: `could not read valid JSON from ${path}` };
	}
}

function legacyLayerStatus(homeDir: string | undefined, agentDir: string): LegacyLayerStatus {
	if (!homeDir) {
		return { active: false, ownedProviderIds: [], errors: [] };
	}
	const legacyDir = join(homeDir, ".config", "omo-providers");
	if (!existsSync(legacyDir)) {
		return { active: false, ownedProviderIds: [], errors: [] };
	}

	const ownedPath = join(legacyDir, ".owned-providers.json");
	if (!existsSync(ownedPath)) {
		return { active: false, ownedProviderIds: [], errors: [] };
	}
	const owned = readJson(ownedPath);
	if (!isObject(owned.value) || !Array.isArray(owned.value.providers)) {
		return {
			active: false,
			ownedProviderIds: [],
			errors: [owned.error ?? `invalid legacy ownership record ${ownedPath}`],
		};
	}
	const ownedProviderIds = owned.value.providers.filter((providerId): providerId is string =>
		typeof providerId === "string",
	);

	const modelsPath = join(agentDir, "models.json");
	if (!existsSync(modelsPath)) {
		return { active: false, ownedProviderIds, errors: [] };
	}
	const models = readJson(modelsPath);
	if (!isObject(models.value) || !isObject(models.value.providers)) {
		return {
			active: false,
			ownedProviderIds,
			errors: [models.error ?? `invalid legacy models record ${modelsPath}`],
		};
	}
	const modelProviderIds = new Set(Object.keys(models.value.providers));
	return {
		active: ownedProviderIds.some((providerId) => modelProviderIds.has(providerId)),
		ownedProviderIds: ownedProviderIds.filter((providerId) => modelProviderIds.has(providerId)),
		errors: [],
	};
}

function homeDirectory(options: DoctorOptions | undefined, env: NodeJS.ProcessEnv): string | undefined {
	if (options?.homeDir) return options.homeDir;
	if (options === undefined) return env.HOME ?? homedir();
	return undefined;
}

/**
 * Reads fragment and legacy-layer state, executes credential references only to
 * determine a boolean, and returns a secret-safe text report. It never writes
 * a file and never retains or prints a resolved credential value.
 */
export function runDoctor(options?: DoctorOptions): DoctorResult {
	const env = options?.env ?? process.env;
	const homeDir = homeDirectory(options, env);
	const agentDir = options?.agentDir ?? env.SENPI_CODING_AGENT_DIR ?? (homeDir && join(homeDir, ".senpi", "agent"));
	const loaded = loadProviderFragments({ env, ...(homeDir ? { homeDir } : {}) });
	const statuses = new Map<string, FragmentStatus>();
	for (const fragment of loaded.fragments) {
		statuses.set(fragment.filePath, fragmentStatus(fragment, env));
	}
	for (const error of loaded.errors) {
		const status = statuses.get(error.filePath) ?? {
			filePath: error.filePath,
			loaded: false,
			resolves: false,
			credentials: [],
			errors: [],
		};
		status.resolves = false;
		status.errors.push(error.message);
		statuses.set(error.filePath, status);
	}

	const extensionProviderIds = loaded.fragments.flatMap((fragment) =>
		fragment.providers.map((provider) => provider.providerId),
	);
	const legacy = legacyLayerStatus(homeDir, agentDir ?? "");
	const legacyOwnedIds = new Set(legacy.ownedProviderIds);
	const collisions = extensionProviderIds.filter((providerId) => legacyOwnedIds.has(providerId));
	const lines = [`config-dir: ${loaded.dir ?? "(none)"}`];
	let failed = loaded.errors.length > 0 || legacy.errors.length > 0;

	for (const status of [...statuses.values()].sort((left, right) => left.filePath.localeCompare(right.filePath))) {
		lines.push(`fragment: ${status.filePath} loaded=${status.loaded} resolves=${status.resolves}`);
		for (const error of status.errors) {
			lines.push(`fragment-error: ${error}`);
		}
		const fragment = loaded.fragments.find((candidate) => candidate.filePath === status.filePath);
		for (const provider of fragment?.providers ?? []) {
			const credentials = status.credentials.filter(
				(credential) => credential.providerId === provider.providerId,
			);
			const resolves = credentials.every((credential) => credential.resolves);
			if (!resolves) failed = true;
			lines.push(`provider: ${provider.providerId} registered=true resolves=${resolves}`);
			for (const credential of credentials) {
				const command = credential.command && !credential.resolves ? ` command=${credential.command}` : "";
				lines.push(
					`credential: fragment=${status.filePath} provider=${credential.providerId} field=${credential.field} resolves=${credential.resolves}${command}`,
				);
			}
		}
	}

	lines.push(`legacy-layer: active=${legacy.active}`);
	for (const error of legacy.errors) {
		lines.push(`legacy-layer-error: ${error}`);
	}
	for (const providerId of collisions) {
		lines.push(`collision: provider=${providerId} legacy-owned=true models-json-precedence=true`);
	}

	return {
		exitCode: failed ? 1 : 0,
		output: redactCredentialShapes(lines.join("\n")),
	};
}

function main(): void {
	const command = process.argv[2];
	if (command !== undefined && command !== "doctor") {
		process.stderr.write("Usage: senpi-accounts doctor\n");
		process.exitCode = 2;
		return;
	}
	const result = runDoctor();
	process.stdout.write(`${result.output}\n`);
	process.exitCode = result.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
