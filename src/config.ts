/**
 * Provider-fragment loader: discovery, parsing, and schema validation of
 * user-provided provider fragments. Registration with senpi is a later task.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface LoadFragmentsOptions {
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
}

export interface ProviderFragmentEntry {
	providerId: string;
	fields: Record<string, unknown>;
	accounts?: unknown[];
}

export interface ProviderFragment {
	filePath: string;
	providers: ProviderFragmentEntry[];
}

export interface FragmentLoadError {
	filePath: string;
	message: string;
}

export interface LoadFragmentsResult {
	dir: string | null;
	fragments: ProviderFragment[];
	errors: FragmentLoadError[];
}

const ALLOWED_FIELDS = new Set([
	"name",
	"baseUrl",
	"apiKey",
	"api",
	"headers",
	"extraBody",
	"authHeader",
	"models",
	"refreshModels",
	"streamSimple",
	"oauth",
	"accounts",
]);

const MODELS_JSON_FIELDS = new Set([
	"whitelist",
	"blacklist",
	"disabled",
	"compat",
	"cacheRetention",
	"modelOverrides",
]);

function pathKind(path: string): "directory" | "other" | "missing" {
	try {
		return statSync(path).isDirectory() ? "directory" : "other";
	} catch {
		return "missing";
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveFragmentDir(options?: LoadFragmentsOptions): string | null {
	const hasInjectedOptions = options !== undefined;
	const env = options?.env ?? process.env;
	const envDir = env.SENPI_ACCOUNTS_DIR;

	if (envDir) {
		return pathKind(envDir) === "directory" ? envDir : null;
	}

	const homeDir = options?.homeDir ??
		(hasInjectedOptions ? undefined : env.HOME ?? homedir());
	if (!homeDir) {
		return null;
	}

	const primary = join(homeDir, ".config", "senpi-accounts", "providers.d");
	const primaryKind = pathKind(primary);
	if (primaryKind === "directory") {
		return primary;
	}
	if (primaryKind === "other") {
		return null;
	}

	const legacy = join(homeDir, ".config", "omo-providers", "providers.d");
	return pathKind(legacy) === "directory" ? legacy : null;
}

function errorFor(filePath: string, message: string): FragmentLoadError {
	return { filePath, message: `${filePath}: ${message}` };
}

function validateEntry(
	filePath: string,
	providerId: string,
	entry: unknown,
): { entry?: ProviderFragmentEntry; error?: FragmentLoadError } {
	if (!isObject(entry)) {
		return {
			error: errorFor(
				filePath,
				`provider ${providerId} must be a JSON object`,
			),
		};
	}

	for (const key of Object.keys(entry)) {
		if (MODELS_JSON_FIELDS.has(key)) {
			return {
				error: errorFor(
					filePath,
					`field ${key} is not expressible through the extension API and must stay in models.json`,
				),
			};
		}
		if (!ALLOWED_FIELDS.has(key)) {
			return {
				error: errorFor(filePath, `unknown provider field ${key}`),
			};
		}
	}

	if ("accounts" in entry && !Array.isArray(entry.accounts)) {
		return {
			error: errorFor(filePath, `field accounts must be an array`),
		};
	}

	const fields = { ...entry };
	const accounts = fields.accounts;
	delete fields.accounts;
	return {
		entry: {
			providerId,
			fields,
			...(accounts === undefined ? {} : { accounts: accounts as unknown[] }),
		},
	};
}

export function loadProviderFragments(
	options?: LoadFragmentsOptions,
): LoadFragmentsResult {
	const dir = resolveFragmentDir(options);
	if (!dir) {
		return { dir: null, fragments: [], errors: [] };
	}

	const fragments: ProviderFragment[] = [];
	const errors: FragmentLoadError[] = [];
	let fileNames: string[];
	try {
		fileNames = readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
			.map((entry) => entry.name)
			.sort();
	} catch (error) {
		errors.push(errorFor(dir, `could not read directory: ${String(error)}`));
		return { dir, fragments, errors };
	}

	for (const fileName of fileNames) {
		const filePath = join(dir, fileName);
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
		} catch (error) {
			errors.push(errorFor(filePath, `could not parse JSON: ${String(error)}`));
			continue;
		}

		if (!isObject(parsed)) {
			errors.push(
				errorFor(filePath, "fragment must be a JSON object mapping provider IDs"),
			);
			continue;
		}

		const providers: ProviderFragmentEntry[] = [];
		for (const [providerId, rawEntry] of Object.entries(parsed)) {
			const validated = validateEntry(filePath, providerId, rawEntry);
			if (validated.error) {
				errors.push(validated.error);
			} else if (validated.entry) {
				providers.push(validated.entry);
			}
		}
		fragments.push({ filePath, providers });
	}

	return { dir, fragments, errors };
}
