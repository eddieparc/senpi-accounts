import type { ExtensionAPI } from "@code-yeongyu/senpi";
import { loadProviderFragments } from "./config.js";

export type { ProviderConfig } from "@code-yeongyu/senpi";

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

const ownedProviderIds = new Set<string>();

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function reportError(message: string): void {
	console.error(`${EXTENSION_ID}: ${message}`);
}

/**
 * Registers the current JSON fragments during extension loading. If every
 * fragment parsed successfully, ids this module registered on an earlier
 * invocation but which are now absent are unregistered. A fragment error makes
 * absence ambiguous, so existing owned providers are retained until a clean
 * invocation confirms their removal.
 */
export default async function senpiAccounts(pi: SenpiExtensionAPI): Promise<void> {
	const result = loadProviderFragments();
	for (const error of result.errors) {
		reportError(error.message);
	}

	const currentProviderIds = new Set(
		result.fragments.flatMap((fragment) => fragment.providers.map((provider) => provider.providerId)),
	);

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

	for (const fragment of result.fragments) {
		for (const provider of fragment.providers) {
			try {
				pi.registerProvider(provider.providerId, provider.fields);
				ownedProviderIds.add(provider.providerId);
			} catch (error) {
				reportError(
					`${fragment.filePath}: could not register provider ${provider.providerId}: ${errorMessage(error)}`,
				);
			}
		}
	}
}
