import type { ExtensionAPI } from "@code-yeongyu/senpi";

export type { ProviderConfig } from "@code-yeongyu/senpi";

/**
 * Compile-time guard: if the `@code-yeongyu/senpi` declarations fail to
 * resolve (e.g. silently suppressed under `skipLibCheck`), `ExtensionAPI`
 * degrades to `any` and this alias becomes an unassignable marker tuple,
 * failing the build instead of silently typing `pi` as `any`.
 */
type IsAny<T> = 0 extends 1 & T ? true : false;
type Resolved<T> = IsAny<T> extends true
	? ["@code-yeongyu/senpi ExtensionAPI type failed to resolve"]
	: T;

export type SenpiExtensionAPI = Resolved<ExtensionAPI>;

export const EXTENSION_ID = "@eddieparc/senpi-accounts";

/**
 * Extension factory invoked by senpi at load time.
 * Scaffold only — provider account management lands in later tasks.
 */
export default function senpiAccounts(_pi: SenpiExtensionAPI): void {
	// no-op for now
}
