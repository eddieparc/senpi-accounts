/**
 * Provider-fragment loader: discovery, parsing, and schema validation of
 * user-provided provider fragments. Registration with senpi happens in index.ts.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderConfig, ProviderModelConfig } from "@code-yeongyu/senpi";

export interface LoadFragmentsOptions {
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
}

export interface ProviderAccount {
	id: string;
	label: string;
	apiKey?: string;
	headers?: Record<string, string>;
	upstreamModelIdSuffix?: string;
}

export interface ProviderFragmentEntry {
	providerId: string;
	fields: ProviderConfig;
	accounts?: ProviderAccount[];
}

export interface RegisteredProviderEntry {
	providerId: string;
	fields: ProviderConfig;
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

const JSON_PROVIDER_FIELDS = new Set([
	"name",
	"baseUrl",
	"apiKey",
	"api",
	"headers",
	"extraBody",
	"authHeader",
	"models",
]);

const NON_JSON_PROVIDER_FIELDS = new Set(["oauth", "refreshModels", "streamSimple"]);

const MODELS_JSON_FIELDS = new Set([
	"whitelist",
	"blacklist",
	"disabled",
	"compat",
	"cacheRetention",
	"modelOverrides",
]);

const MODEL_FIELDS = new Set([
	"id",
	"name",
	"upstreamModelId",
	"api",
	"baseUrl",
	"reasoning",
	"recoverTextToolCalls",
	"thinkingLevelMap",
	"input",
	"cost",
	"contextWindow",
	"maxTokens",
	"headers",
	"extraBody",
	"compat",
]);

const ACCOUNT_FIELDS = new Set(["id", "label", "apiKey", "headers", "upstreamModelIdSuffix"]);

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

function isUnknownArray(value: unknown): value is unknown[] {
	return Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isJsonValue(value: unknown): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean" || isFiniteNumber(value)) {
		return true;
	}
	if (Array.isArray(value)) {
		return value.every(isJsonValue);
	}
	return isObject(value) && Object.values(value).every(isJsonValue);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return isObject(value) && Object.values(value).every(isJsonValue);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isObject(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isStringOrNullRecord(value: unknown): boolean {
	return isObject(value) && Object.values(value).every((entry) => typeof entry === "string" || entry === null);
}

function isConfigValueReference(value: string): boolean {
	return value.startsWith("!") || /^\$[A-Za-z_][A-Za-z0-9_]*$/u.test(value) || /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/u.test(value);
}

function credentialReferenceError(
	filePath: string,
	providerId: string,
	accountId: string,
	location: string,
): FragmentLoadError {
	return errorFor(
		filePath,
		`provider ${providerId} account ${accountId} ${location} must be a config-value reference; use a !command or $ENV reference instead`,
	);
}

function validateCredentialReferences(
	filePath: string,
	providerId: string,
	accountId: string,
	fields: Record<string, unknown>,
): FragmentLoadError | undefined {
	if (typeof fields.apiKey === "string" && !isConfigValueReference(fields.apiKey)) {
		return credentialReferenceError(filePath, providerId, accountId, "apiKey");
	}
	if (isObject(fields.headers)) {
		for (const [headerName, headerValue] of Object.entries(fields.headers)) {
			if (typeof headerValue === "string" && !isConfigValueReference(headerValue)) {
				return credentialReferenceError(filePath, providerId, accountId, `header ${headerName}`);
			}
		}
	}
	return undefined;
}

function validateAccount(
	filePath: string,
	providerId: string,
	index: number,
	value: unknown,
): { account?: ProviderAccount; error?: FragmentLoadError } {
	if (!isObject(value)) {
		return { error: errorFor(filePath, `provider ${providerId} accounts[${index}] must be a JSON object`) };
	}
	for (const key of Object.keys(value)) {
		if (!ACCOUNT_FIELDS.has(key)) {
			return { error: errorFor(filePath, `provider ${providerId} accounts[${index}] unknown field ${key}`) };
		}
	}
	if (typeof value.id !== "string") {
		return { error: errorFor(filePath, `provider ${providerId} accounts[${index}].id must be a string`) };
	}
	if (typeof value.label !== "string") {
		return { error: errorFor(filePath, `provider ${providerId} accounts[${index}].label must be a string`) };
	}
	if ("apiKey" in value && typeof value.apiKey !== "string") {
		return { error: errorFor(filePath, `provider ${providerId} accounts[${index}].apiKey must be a string`) };
	}
	if ("headers" in value && !isStringRecord(value.headers)) {
		return {
			error: errorFor(filePath, `provider ${providerId} accounts[${index}].headers must map strings to strings`),
		};
	}
	if ("upstreamModelIdSuffix" in value && typeof value.upstreamModelIdSuffix !== "string") {
		return {
			error: errorFor(
				filePath,
				`provider ${providerId} accounts[${index}].upstreamModelIdSuffix must be a string`,
			),
		};
	}

	const inlineCredentialError = validateCredentialFields(
		filePath,
		providerId,
		value,
		`accounts[${index}].`,
	);
	if (inlineCredentialError) return { error: inlineCredentialError };
	const referenceError = validateCredentialReferences(filePath, providerId, value.id, value);
	if (referenceError) return { error: referenceError };
	if (value.apiKey === undefined && value.headers === undefined && value.upstreamModelIdSuffix === undefined) {
		return {
			error: errorFor(
				filePath,
				`provider ${providerId} account ${value.id} duplicates the base entry; specify apiKey, headers, or upstreamModelIdSuffix`,
			),
		};
	}

	const account: ProviderAccount = { id: value.id, label: value.label };
	if (typeof value.apiKey === "string") account.apiKey = value.apiKey;
	if (isStringRecord(value.headers)) account.headers = value.headers;
	if (typeof value.upstreamModelIdSuffix === "string") {
		account.upstreamModelIdSuffix = value.upstreamModelIdSuffix;
	}
	return { account };
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: Set<string>): boolean {
	return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isModelCost(value: unknown): boolean {
	if (!isObject(value)) {
		return false;
	}
	if (
		!isFiniteNumber(value.input) ||
		!isFiniteNumber(value.output) ||
		!isFiniteNumber(value.cacheRead) ||
		!isFiniteNumber(value.cacheWrite)
	) {
		return false;
	}
	if (!("tiers" in value)) {
		return true;
	}
	return (
		Array.isArray(value.tiers) &&
		value.tiers.every(
			(tier) =>
				isObject(tier) &&
				isFiniteNumber(tier.input) &&
				isFiniteNumber(tier.output) &&
				isFiniteNumber(tier.cacheRead) &&
				isFiniteNumber(tier.cacheWrite) &&
				isFiniteNumber(tier.inputTokensAbove),
		)
	);
}

function isProviderModelConfig(value: unknown): value is ProviderModelConfig {
	if (!isObject(value) || !hasOnlyKeys(value, MODEL_FIELDS)) {
		return false;
	}
	if (
		typeof value.id !== "string" ||
		typeof value.name !== "string" ||
		typeof value.reasoning !== "boolean" ||
		!Array.isArray(value.input) ||
		!value.input.every((input) => input === "text" || input === "image" || input === "video") ||
		!isModelCost(value.cost) ||
		!isFiniteNumber(value.contextWindow) ||
		!isFiniteNumber(value.maxTokens)
	) {
		return false;
	}
	return (
		(!("upstreamModelId" in value) || typeof value.upstreamModelId === "string") &&
		(!("api" in value) || typeof value.api === "string") &&
		(!("baseUrl" in value) || typeof value.baseUrl === "string") &&
		(!("recoverTextToolCalls" in value) || typeof value.recoverTextToolCalls === "boolean") &&
		(!("thinkingLevelMap" in value) || isStringOrNullRecord(value.thinkingLevelMap)) &&
		(!("headers" in value) || isStringRecord(value.headers)) &&
		(!("extraBody" in value) || isJsonObject(value.extraBody)) &&
		(!("compat" in value) || isJsonObject(value.compat))
	);
}

function providerConfigIssue(value: Record<string, unknown>): string | undefined {
	if ("name" in value && typeof value.name !== "string") return "field name must be a string";
	if ("baseUrl" in value && typeof value.baseUrl !== "string") return "field baseUrl must be a string";
	if ("apiKey" in value && typeof value.apiKey !== "string") return "field apiKey must be a string";
	if ("api" in value && typeof value.api !== "string") return "field api must be a string";
	if ("headers" in value && !isStringRecord(value.headers)) return "field headers must map strings to strings";
	if ("extraBody" in value && !isJsonObject(value.extraBody)) return "field extraBody must be a JSON object";
	if ("authHeader" in value && typeof value.authHeader !== "boolean") return "field authHeader must be a boolean";
	if (
		"models" in value &&
		(!Array.isArray(value.models) || !value.models.every(isProviderModelConfig))
	) {
		return "field models must contain valid provider model definitions";
	}
	return undefined;
}

/**
 * This is the explicit JSON-to-public-API boundary. Fragments are parsed JSON,
 * then every emitted field is checked before TypeScript narrows it to the
 * bounded public ProviderConfig surface accepted by registerProvider().
 */
function isJsonProviderConfig(value: unknown): value is ProviderConfig {
	return isObject(value) && providerConfigIssue(value) === undefined;
}

export function resolveFragmentDir(options?: LoadFragmentsOptions): string | null {
	const hasInjectedOptions = options !== undefined;
	const env = options?.env ?? process.env;
	const envDir = env.SENPI_ACCOUNTS_DIR;

	if (envDir) {
		return pathKind(envDir) === "directory" ? envDir : null;
	}

	const homeDir = options?.homeDir ?? (hasInjectedOptions ? undefined : env.HOME ?? homedir());
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
			error: errorFor(filePath, `provider ${providerId} must be a JSON object`),
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
		if (NON_JSON_PROVIDER_FIELDS.has(key)) {
			return {
				error: errorFor(filePath, `field ${key} cannot be expressed in a JSON provider fragment`),
			};
		}
		if (key !== "accounts" && !JSON_PROVIDER_FIELDS.has(key)) {
			return {
				error: errorFor(filePath, `unknown provider field ${key}`),
			};
		}
	}

	const rawAccounts = entry.accounts;
	if (rawAccounts !== undefined && !isUnknownArray(rawAccounts)) {
		return {
			error: errorFor(filePath, "field accounts must be an array"),
		};
	}

	const fields: Record<string, unknown> = { ...entry };
	delete fields.accounts;

	const fieldCredentialError = validateCredentialFields(filePath, providerId, fields);
	if (fieldCredentialError) return { error: fieldCredentialError };

	const accounts: ProviderAccount[] = [];
	if (rawAccounts) {
		const baseReferenceError = validateCredentialReferences(filePath, providerId, "base", fields);
		if (baseReferenceError) return { error: baseReferenceError };
		for (const [index, rawAccount] of rawAccounts.entries()) {
			const validatedAccount = validateAccount(filePath, providerId, index, rawAccount);
			if (validatedAccount.error) return { error: validatedAccount.error };
			if (validatedAccount.account) accounts.push(validatedAccount.account);
		}
	}

	const issue = providerConfigIssue(fields);
	if (issue) {
		return { error: errorFor(filePath, issue) };
	}
	if (!isJsonProviderConfig(fields)) {
		return { error: errorFor(filePath, "provider config must use JSON-compatible public fields") };
	}

	return {
		entry: {
			providerId,
			fields,
			...(rawAccounts === undefined ? {} : { accounts }),
		},
	};
}

export function expandProviderEntry(entry: ProviderFragmentEntry): RegisteredProviderEntry[] {
	if (!entry.accounts) {
		return [{ providerId: entry.providerId, fields: entry.fields }];
	}

	return entry.accounts.map((account, index) => {
		const providerId = index === 0 ? entry.providerId : `${entry.providerId}-account-${index + 1}`;
		const fields: ProviderConfig = {
			...entry.fields,
			name: `${entry.fields.name ?? entry.providerId} (${account.label})`,
			...(account.apiKey === undefined ? {} : { apiKey: account.apiKey }),
			...(account.headers === undefined ? {} : { headers: account.headers }),
			...(account.upstreamModelIdSuffix === undefined || entry.fields.models === undefined
				? {}
				: {
						models: entry.fields.models.map((model) => ({
							...model,
							upstreamModelId: `${model.upstreamModelId ?? model.id}${account.upstreamModelIdSuffix}`,
						})),
					}),
		};
		return { providerId, fields };
	});
}

export function loadProviderFragments(options?: LoadFragmentsOptions): LoadFragmentsResult {
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
			errors.push(errorFor(filePath, "fragment must be a JSON object mapping provider IDs"));
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
