import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ALIBABA_MODEL_STUDIO_PROVIDER_ID,
	alibabaModelStudioProviderPackage,
} from "../src/providers/alibaba/index.js";

const BASE_URL = "https://ws-test.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
const context = {
	env: { ALIBABA_MODEL_STUDIO_BASE_URL: `${BASE_URL}/` } as NodeJS.ProcessEnv,
	agentDir: "/tmp/senpi-accounts-alibaba",
};

async function login(key: string): Promise<unknown> {
	const config = await alibabaModelStudioProviderPackage().build(context);
	expect(config.oauth).toBeDefined();
	return config.oauth?.login({ onPrompt: async () => key } as never);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Alibaba Model Studio workspace provider", () => {
	it("registers the workspace provider with its dedicated endpoint", async () => {
		const provider = alibabaModelStudioProviderPackage();
		const config = await provider.build(context);

		expect(provider.id).toBe(ALIBABA_MODEL_STUDIO_PROVIDER_ID);
		expect(config).toMatchObject({
			name: "Alibaba Model Studio (workspace)",
			baseUrl: BASE_URL,
			api: "openai-completions",
		});
		expect(config.apiKey).toBeUndefined();
		expect(config.models?.some((model) => model.id === "qwen-plus")).toBe(true);
		expect(config.models?.find((model) => model.id === "glm-5.2")).toMatchObject({
			name: "GLM-5.2",
			reasoning: true,
			contextWindow: 1_000_000,
			maxTokens: 131_072,
		});
	});

	it("validates a workspace key before returning credentials to Senpi", async () => {
		const request = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", request);

		await expect(login("sk-ws-test-secret")).resolves.toEqual({
			type: "api_key",
			key: "sk-ws-test-secret",
		});
		expect(request).toHaveBeenCalledOnce();
		const [url, init] = request.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${BASE_URL}/chat/completions`);
		expect(init.headers).toMatchObject({ Authorization: "Bearer sk-ws-test-secret" });
		expect(JSON.parse(String(init.body))).toMatchObject({ model: "qwen-plus", max_tokens: 1 });
	});

	it("rejects malformed keys before network access without echoing them", async () => {
		const request = vi.fn();
		vi.stubGlobal("fetch", request);
		const malformed = "definitely-not-a-secret-key";

		await expect(login(malformed)).rejects.toThrow("must start with sk-ws-");
		expect(request).not.toHaveBeenCalled();
	});

	it("rejects revoked keys without echoing them", async () => {
		const request = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ error: { code: "invalid_api_key" } }), {
				status: 401,
				headers: { "content-type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", request);
		const revoked = "sk-ws-revoked-test-secret";

		await expect(login(revoked)).rejects.toThrow("rejected the API key (HTTP 401)");
		expect(request).toHaveBeenCalledOnce();
	});
});
