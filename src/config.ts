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

// These prefixes identify credential formats, while ordinary values such as
// local-development-key remain valid. References are deliberately not parsed
// or resolved here: senpi owns those semantics and must receive the original
// string unchanged.
const INLINE_CREDENTIAL_PATTERNS = [
	/^sk-ant-(?:api\d{2}|oat\d{2}|ort\d{2})-[A-Za-z0-9_-]+$/,
	/^sk-ant-[A-Za-z0-9_-]{20,}$/,
	/^sk-(?:proj|admin|svcacct)-[A-Za-z0-9_-]{16,}$/,
	/^(?:ghp|gho)_[A-Za-z0-9_]{20,}$/,
	/^github_pat_[A-Za-z0-9_]{20,}$/,
	/^AIza[0-9A-Za-z_-]{30,}$/,
	/^xox[baprs]-[0-9A-Za-z-]{20,}$/,
	/^AKIA[0-9A-Z]{16}$/,
];

function looksLikeInlineCredential(value: string): boolean {
	return INLINE_CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value));
}

function credentialError(
	filePath: string,
	providerId: string,
	location: string,
): FragmentLoadError {
	return errorFor(
		filePath,
		`provider ${providerId} ${location} looks like an inline credential; use a !command or $ENV reference instead`,
	);
}

function validateCredentialValue(
	filePath: string,
	providerId: string,
	location: string,
	value: unknown,
): FragmentLoadError | undefined {
	if (typeof value === "string" && looksLikeInlineCredential(value)) {
		return credentialError(filePath, providerId, location);
	}
	return undefined;
}

function validateCredentialFields(
	filePath: string,
	providerId: string,
	fields: Record<string, unknown>,
	locationPrefix = "",
): FragmentLoadError | undefined {
	const apiKeyError = validateCredentialValue(
		filePath,
		providerId,
		`${locationPrefix}apiKey`,
		fields.apiKey,
	);
	if (apiKeyError) return apiKeyError;

	if (isObject(fields.headers)) {
		for (const [headerName, headerValue] of Object.entries(fields.headers)) {
			const headerError = validateCredentialValue(
				filePath,
				providerId,
				`${locationPrefix}header ${headerName}`,
				headerValue,
			);
			if (headerError) return headerError;
		}
	}

	return undefined;
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

	if ("oauth" in entry) {
		return {
			error: errorFor(
				filePath,
				`provider ${providerId} field oauth is not supported; use apiKey or headers references instead`,
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

	const fieldCredentialError = validateCredentialFields(filePath, providerId, fields);
	if (fieldCredentialError) return { error: fieldCredentialError };

	if (Array.isArray(accounts)) {
		for (const [index, account] of accounts.entries()) {
			if (!isObject(account)) continue;
			const accountCredentialError = validateCredentialFields(
				filePath,
				providerId,
				account,
				`accounts[${index}].`,
			);
			if (accountCredentialError) return { error: accountCredentialError };
		}
	}

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
