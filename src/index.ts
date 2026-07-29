import type { ExtensionAPI, ProviderConfig } from "@code-yeongyu/senpi";
import { expandProviderEntry, loadProviderFragments } from "./config.js";

export type { ProviderConfig };

/**
 * Compile-time guard: if the `@code-yeongyu/senpi` declarations fail to
 * resolve (e.g. silently suppressed under `skipLibCheck`), this alias becomes
 * an unassignable marker tuple rather than weakening the factory parameter.
 */
type IsUnresolved<T> = 0 extends 1 & T ? true : false;
type Resolved<T> = IsUnresolved<T> extends true
	? ["@code-yeongyu/senpi ExtensionAPI type failed to resolve"]
	: T;

export type SenpiExtensionAPI = Resolved<ExtensionAPI>;

export const EXTENSION_ID = "@eddieparc/senpi-accounts";

// Senpi creates a fresh extension module and API object on reload, but retains
// the EventBus owned by its resource loader. A global symbol lets the fresh
// module find this extension's host-scoped state without writing a file.
const ownedProviderIdsKey = Symbol.for(`${EXTENSION_ID}:owned-provider-ids`);

function getOwnedProviderIds(pi: SenpiExtensionAPI): Set<string> {
	const eventBus = pi.events as unknown as Record<symbol, unknown>;
	const existing = eventBus[ownedProviderIdsKey];
	if (existing instanceof Set) {
		return existing as Set<string>;
	}

	const ownedProviderIds = new Set<string>();
	Object.defineProperty(eventBus, ownedProviderIdsKey, { value: ownedProviderIds });
	return ownedProviderIds;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function reportError(message: string): void {
	console.error(`${EXTENSION_ID}: ${message}`);
}

function reportKiroConnectionUrl(pi: SenpiExtensionAPI, currentProviders: RegisteredProvider[]): void {
	const baseUrl = currentProviders.find((provider) => provider.providerId === "kiro")?.fields.baseUrl;
	if (!baseUrl) {
		return;
	}

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant" || event.message.provider !== "kiro") {
			return;
		}
		const errorMessage = event.message.errorMessage;
		if (
			typeof errorMessage !== "string" ||
			!/(?:connection|connect|fetch failed)/iu.test(errorMessage) ||
			errorMessage.includes(baseUrl)
		) {
			return;
		}
		return {
			message: {
				...event.message,
				errorMessage: `${errorMessage} (${baseUrl})`,
			},
		};
	});
}

interface RegisteredProvider {
	filePath: string;
	providerId: string;
	fields: ProviderConfig;
}

/**
 * Registers the current JSON fragments during extension loading. If every
 * fragment parsed successfully, ids this module registered on an earlier
 * invocation but which are now absent are unregistered. A fragment error makes
 * absence ambiguous, so existing owned providers are retained until a clean
 * invocation confirms their removal.
 */
export default async function senpiAccounts(pi: SenpiExtensionAPI): Promise<void> {
	const ownedProviderIds = getOwnedProviderIds(pi);
	const result = loadProviderFragments();
	for (const error of result.errors) {
		reportError(error.message);
	}

	const currentProviders = result.fragments.flatMap((fragment) =>
		fragment.providers.flatMap((provider) =>
			expandProviderEntry(provider).map((registeredProvider) => ({
				filePath: fragment.filePath,
				...registeredProvider,
			})),
		),
	);
	const currentProviderIds = new Set(currentProviders.map((provider) => provider.providerId));
	reportKiroConnectionUrl(pi, currentProviders);

	if (result.errors.length === 0) {
		for (const providerId of ownedProviderIds) {
			if (currentProviderIds.has(providerId)) {
				continue;
			}
			try {
				pi.unregisterProvider(providerId);
				ownedProviderIds.delete(providerId);
			} catch (error) {
				reportError(`could not unregister provider ${providerId}: ${errorMessage(error)}`);
			}
		}
	}

	for (const provider of currentProviders) {
		try {
			pi.registerProvider(provider.providerId, provider.fields);
			ownedProviderIds.add(provider.providerId);
		} catch (error) {
			reportError(
				`${provider.filePath}: could not register provider ${provider.providerId}: ${errorMessage(error)}`,
			);
		}
	}
}
