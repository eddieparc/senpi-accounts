import type { ProviderPackage } from "../../core/types.js";

export const ALIBABA_MODEL_STUDIO_PROVIDER_ID = "alibaba-model-studio";
export const ALIBABA_MODEL_STUDIO_BASE_URL_ENV = "ALIBABA_MODEL_STUDIO_BASE_URL";

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens" as const,
};

export const ALIBABA_MODEL_STUDIO_MODELS = [
	{
		id: "qwen-plus",
		name: "Qwen Plus",
		reasoning: false,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 16_384,
		compat: COMPAT,
	},
	{
		id: "glm-5.2",
		name: "GLM-5.2",
		reasoning: true,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens" as const,
		},
	},
];

function baseUrl(env: NodeJS.ProcessEnv): string {
	return (env[ALIBABA_MODEL_STUDIO_BASE_URL_ENV]?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

async function loginWorkspaceKey(
	callbacks: unknown,
	endpoint: string,
): Promise<{ type: "api_key"; key: string }> {
	const onPrompt = (callbacks as { onPrompt?: (spec: unknown) => Promise<string> }).onPrompt;
	if (!onPrompt) throw new Error("Alibaba Model Studio login needs an interactive prompt");

	const key = (
		await onPrompt({
			type: "secret",
			message: "Alibaba Model Studio workspace API key (starts with sk-ws-)",
		})
	).trim();
	if (!key.startsWith("sk-ws-")) {
		throw new Error("Alibaba Model Studio workspace API keys must start with sk-ws-");
	}

	const response = await fetch(`${endpoint}/chat/completions`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${key}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: "qwen-plus",
			messages: [{ role: "user", content: "1" }],
			max_tokens: 1,
			stream: false,
		}),
	});
	if (!response.ok) {
		throw new Error(`Alibaba Model Studio rejected the API key (HTTP ${response.status})`);
	}

	return { type: "api_key", key };
}

/**
 * Alibaba's `sk-ws` keys belong to a workspace-specific pay-as-you-go endpoint,
 * not stock Senpi's `alibaba-token-plan` endpoint for `sk-sp` plan keys.
 */
export function alibabaModelStudioProviderPackage(): ProviderPackage {
	return {
		id: ALIBABA_MODEL_STUDIO_PROVIDER_ID,
		label: "Alibaba Model Studio (workspace)",
		build(context) {
			return {
				name: "Alibaba Model Studio (workspace)",
				baseUrl: baseUrl(context.env),
				api: "openai-completions",
				models: ALIBABA_MODEL_STUDIO_MODELS,
				oauth: {
					name: "Alibaba Model Studio workspace API key",
					login: async (callbacks) => loginWorkspaceKey(callbacks, baseUrl(context.env)) as never,
					refreshToken: async (credentials) => credentials,
					getApiKey: (credentials) => (credentials as unknown as { key?: string }).key ?? "",
				},
			};
		},
	};
}
