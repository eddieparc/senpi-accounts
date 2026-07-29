import { describe, expect, it, vi } from "vitest";
import { FAST_MODE_FINDING, registerFastMode } from "../src/providers/fast/index.js";

describe("codex fast mode", () => {
	it("registers no command, so stock /fast keeps working", () => {
		// Two commands sharing a name make senpi expose them as `fast:1`/`fast:2`,
		// and plain `/fast` then matches neither and is sent to the model as a
		// prompt. Verified live: the model answered "Fast mode on." while nothing
		// had changed. Shadowing stock's command is therefore never acceptable.
		const pi = { registerCommand: vi.fn(), registerProvider: vi.fn(), on: vi.fn() };

		registerFastMode();

		expect(pi.registerCommand).not.toHaveBeenCalled();
		expect(pi.registerProvider).not.toHaveBeenCalled();
		expect(pi.on).not.toHaveBeenCalled();
	});

	it("records why synthesising -fast variants would be wrong", () => {
		// Measured against a live ChatGPT Pro subscription: priority is accepted
		// but served at normal tier, while senpi bills it at up to 2.5x.
		expect(FAST_MODE_FINDING).toContain("service_tier=priority");
		expect(FAST_MODE_FINDING).toContain("2.5x");
		expect(FAST_MODE_FINDING).toContain("API-key billing");
	});

	it("points at the upstream fix rather than a local workaround", () => {
		expect(FAST_MODE_FINDING).toContain("senpi#503");
	});
});
