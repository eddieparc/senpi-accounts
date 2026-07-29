import { afterAll, describe, expect, it } from "vitest";
import { deleteSecret, isMacOS, keychainAvailable, readSecret, writeSecret } from "../src/core/keychain.js";

const PROVIDER = `__senpi_accounts_test_${process.pid}`;
const runOnMac = isMacOS() ? describe : describe.skip;

afterAll(() => {
	if (isMacOS()) deleteSecret(PROVIDER);
});

runOnMac("macOS keychain", () => {
	it("reports availability via a real round-trip", () => {
		expect(keychainAvailable()).toBe(true);
	});

	it("round-trips a secret", () => {
		writeSecret(PROVIDER, "secret-value-123");
		expect(readSecret(PROVIDER)).toBe("secret-value-123");
	});

	it("overwrites rather than failing on a duplicate write", () => {
		writeSecret(PROVIDER, "first");
		writeSecret(PROVIDER, "second");
		expect(readSecret(PROVIDER)).toBe("second");
	});

	it("round-trips a realistic credential payload", () => {
		const payload = JSON.stringify({
			accounts: [{ name: "jgp3620", access: "a".repeat(400), refresh: "r".repeat(120), expires: 1 }],
		});
		writeSecret(PROVIDER, payload);
		expect(JSON.parse(readSecret(PROVIDER) as string).accounts[0].name).toBe("jgp3620");
	});

	it("deletes a secret and reports absence afterwards", () => {
		writeSecret(PROVIDER, "to-delete");
		expect(deleteSecret(PROVIDER)).toBe(true);
		expect(readSecret(PROVIDER)).toBeUndefined();
	});

	it("returns undefined for an unknown provider rather than throwing", () => {
		expect(readSecret(`${PROVIDER}_missing`)).toBeUndefined();
	});

	it("reports deletion of a missing entry as false", () => {
		expect(deleteSecret(`${PROVIDER}_missing`)).toBe(false);
	});
});
