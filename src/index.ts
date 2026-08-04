import { homedir } from "node:os";
import { join } from "node:path";
import { EXTENSION_ID, registerProviderPackages } from "./core/registry.js";
import type {
	ExtensionCommandContext,
	ProviderBuildContext,
	ProviderHealth,
	ProviderPackage,
	SenpiExtensionAPI,
} from "./core/types.js";
import { migrationSink } from "./core/migration-sink.js";
import { buildUsageReport } from "./core/usage.js";

export type { ProviderPackage, ProviderHealth, ProviderBuildContext } from "./core/types.js";
export { EXTENSION_ID } from "./core/registry.js";

/**
 * senpi-accounts — multi-provider subscription addon.
 *
 * Stock senpi is the base layer and is never modified. This addon sits above it
 * and fills only the gaps stock leaves: Anthropic multi-account, Alibaba Token
 * Plan and OpenCode Go are working stock features and are deliberately not
 * reimplemented here. OpenAI Codex fast mode is stock's own defect and was
 * handed upstream as senpi#503 rather than worked around here.
 *
 * Every provider lives in its own package under `src/providers/` and is loaded
 * lazily inside a try/catch, so one broken provider degrades only itself.
 */

function agentDir(env: NodeJS.ProcessEnv): string {
	const configured = env.SENPI_CODING_AGENT_DIR?.trim();
	if (configured) {
		return configured.startsWith("~") ? join(homedir(), configured.slice(1)) : configured;
	}
	return join(homedir(), ".senpi", "agent");
}

async function loadProviderPackages(): Promise<{ packages: ProviderPackage[]; failures: ProviderHealth[] }> {
	const packages: ProviderPackage[] = [];
	const failures: ProviderHealth[] = [];

	const loaders: { id: string; load: () => Promise<ProviderPackage> }[] = [
		{ id: "kiro", load: async () => (await import("./providers/kiro/index.js")).kiroProviderPackage() },
		{ id: "codex-pool", load: async () => (await import("./providers/codex/index.js")).codexProviderPackage() },
		{
			id: "alibaba-model-studio",
			load: async () =>
				(await import("./providers/alibaba/index.js")).alibabaModelStudioProviderPackage(),
		},
		{
			id: "tokenrouter",
			load: async () => (await import("./providers/tokenrouter/index.js")).tokenrouterProviderPackage(),
		},
		{
			id: "opengateway",
			load: async () => (await import("./providers/opengateway/index.js")).opengatewayProviderPackage(),
		},
	];

	for (const loader of loaders) {
		try {
			packages.push(await loader.load());
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			failures.push({ status: "degraded", providerId: loader.id, reason, error });
			console.error(`${EXTENSION_ID}: provider '${loader.id}' failed to load: ${reason}`);
		}
	}

	return { packages, failures };
}

export default async function senpiAccounts(pi: SenpiExtensionAPI): Promise<void> {
	const env = process.env;
	const context: ProviderBuildContext = { env, agentDir: agentDir(env) };

	const { packages, failures } = await loadProviderPackages();
	const { health } = await registerProviderPackages(pi, packages, context);
	const allHealth = [...failures, ...health];
	const registered = packages.filter((entry) =>
		allHealth.some((item) => item.providerId === entry.id && item.status === "registered"),
	);

	// A provider stream has no ExtensionContext of its own, so the newest session
	// context is captured here and migration notices are delivered through it.
	pi.on("session_start", (_event, ctx) => {
		migrationSink.attach(ctx);
	});

	pi.registerCommand("usage", {
		description: "Show remaining usage across every configured subscription.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			ctx.ui.notify(await buildUsageReport(registered, context), "info");
		},
	});

	pi.registerCommand("senpi-accounts", {
		description: "Show senpi-accounts provider health.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const lines = allHealth.map((entry) => {
				if (entry.status === "registered") return `  ${entry.providerId}: registered`;
				if (entry.status === "skipped") return `  ${entry.providerId}: skipped (${entry.reason})`;
				return `  ${entry.providerId}: DEGRADED (${entry.reason})`;
			});
			ctx.ui.notify(
				[`${EXTENSION_ID}:`, ...(lines.length > 0 ? lines : ["  (no providers)"])].join("\n"),
				allHealth.some((entry) => entry.status === "degraded") ? "error" : "info",
			);
		},
	});
}
