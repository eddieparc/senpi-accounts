import type { ExtensionAPI, ExtensionCommandContext, ProviderConfig } from "@code-yeongyu/senpi";
import type { AccountSlot } from "./accounts.js";

export type { ProviderConfig, ExtensionCommandContext };

/**
 * Compile-time guard: if the `@code-yeongyu/senpi` declarations fail to resolve
 * (e.g. silently suppressed under `skipLibCheck`), this alias becomes an
 * unassignable marker tuple rather than weakening every consumer to `any`.
 */
type IsUnresolved<T> = 0 extends 1 & T ? true : false;
type Resolved<T> = IsUnresolved<T> extends true
	? ["@code-yeongyu/senpi ExtensionAPI type failed to resolve"]
	: T;

export type SenpiExtensionAPI = Resolved<ExtensionAPI>;

/** Health of a single provider package after a registration attempt. */
export type ProviderHealth =
	| { status: "registered"; providerId: string }
	| { status: "skipped"; providerId: string; reason: string }
	| { status: "degraded"; providerId: string; reason: string; error: unknown };

export interface ProviderBuildContext {
	readonly env: NodeJS.ProcessEnv;
	/** Absolute path to the senpi agent directory (`~/.senpi/agent` by default). */
	readonly agentDir: string;
}

/**
 * A provider package. Each lives in its own directory under `src/providers/`,
 * owns its credentials and failure modes, and never imports a sibling.
 */
export interface ProviderPackage {
	/** Provider id registered with senpi; also the `/login <id>` name. */
	readonly id: string;
	/** Human-readable label used in diagnostics. */
	readonly label: string;
	/**
	 * Whether this package should register. Returning a string skips
	 * registration and reports that string as the reason.
	 */
	enabled?(env: NodeJS.ProcessEnv): true | string;
	/** Build the senpi provider config. Throwing here degrades only this package. */
	build(context: ProviderBuildContext): ProviderConfig | Promise<ProviderConfig>;
	/**
	 * Run the provider's interactive login and return the slot to store.
	 * Present only on providers that support managed multi-account pools.
	 */
	accountLogin?(name: string, ctx: ExtensionCommandContext): Promise<AccountSlot>;
	/**
	 * Report remaining headroom per account, 0..1, for usage-aware placement and
	 * the usage dashboard. Absent or throwing means "unknown".
	 */
	accountUsage?(context: ProviderBuildContext): Promise<Record<string, number | undefined>>;
}
