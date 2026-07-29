import { describe, expect, it } from "vitest";
import senpiAccounts, { EXTENSION_ID, type SenpiExtensionAPI } from "../src/index";

describe("senpi-accounts extension", () => {
	it("default-exports an extension factory function", () => {
		expect(typeof senpiAccounts).toBe("function");
	});

	it("exposes its package id", () => {
		expect(EXTENSION_ID).toBe("@eddieparc/senpi-accounts");
	});

	it("accepts the senpi extension API object without throwing", () => {
		// The factory is currently a no-op and touches nothing on `pi`,
		// so an empty object satisfies the exercised contract.
		const pi = {} as SenpiExtensionAPI;
		expect(() => senpiAccounts(pi)).not.toThrow();
	});
});
