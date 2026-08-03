import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MINIMUM_SENPI_VERSION = "2026.8.3-3";

describe("child-agent provider routing contract", () => {
	it("requires the Senpi runtime that preserves addon providers in child sessions", () => {
		const manifest = JSON.parse(
			readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
		) as {
			devDependencies?: Record<string, string>;
			peerDependencies?: Record<string, string>;
		};

		expect(manifest.devDependencies?.["@code-yeongyu/senpi"]).toBe(MINIMUM_SENPI_VERSION);
		expect(manifest.peerDependencies?.["@code-yeongyu/senpi"]).toBe(`>=${MINIMUM_SENPI_VERSION}`);
	});
});
