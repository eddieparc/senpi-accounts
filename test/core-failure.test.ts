import { describe, expect, it } from "vitest";
import { classifyFailure, retryAfterMs, statusOf } from "../src/core/failure.js";

function httpError(status: number, message = "request failed"): Error & { status: number } {
	return Object.assign(new Error(message), { status });
}

describe("retry-after extraction", () => {
	it("reads an explicit millisecond field", () => {
		expect(retryAfterMs(Object.assign(new Error("x"), { retryAfterMs: 1_500 }))).toBe(1_500);
	});

	it("reads retry-after-ms from the message", () => {
		expect(retryAfterMs(new Error("rate limited; retry-after-ms: 2500"))).toBe(2_500);
	});

	it("treats a bare retry-after as seconds", () => {
		expect(retryAfterMs(new Error("429 Too Many Requests, retry-after: 30"))).toBe(30_000);
	});

	it("returns undefined when no delay is advertised", () => {
		expect(retryAfterMs(new Error("boom"))).toBeUndefined();
	});
});

describe("status extraction", () => {
	it("reads status and statusCode", () => {
		expect(statusOf(httpError(429))).toBe(429);
		expect(statusOf(Object.assign(new Error("x"), { statusCode: 503 }))).toBe(503);
		expect(statusOf(new Error("no status"))).toBeUndefined();
	});
});

describe("failure classification", () => {
	it("fails over and blocks on a 429 status", () => {
		expect(classifyFailure(httpError(429))).toEqual({ block: "rate_limit", failover: true });
	});

	it("honours the upstream retry delay on a 429", () => {
		expect(classifyFailure(httpError(429, "Too Many Requests retry-after: 45"))).toEqual({
			block: "rate_limit",
			failover: true,
			retryAfterMs: 45_000,
		});
	});

	it("detects a rate limit reported only in the message", () => {
		expect(classifyFailure(new Error("Request throttled by upstream")).block).toBe("rate_limit");
	});

	it("blocks quota exhaustion so the account is skipped", () => {
		expect(classifyFailure(new Error("Monthly limit exceeded for this subscription"))).toEqual({
			block: "quota",
			failover: true,
		});
	});

	it("blocks auth failures until re-login", () => {
		expect(classifyFailure(httpError(401)).block).toBe("auth_error");
		expect(classifyFailure(httpError(403)).block).toBe("auth_error");
		expect(classifyFailure(new Error("invalid_grant")).block).toBe("auth_error");
	});

	it("briefly blocks server-side failures", () => {
		expect(classifyFailure(httpError(503)).block).toBe("server_error");
		expect(classifyFailure(new Error("Overloaded")).block).toBe("server_error");
	});

	it("does not fail over on client errors that another account would also hit", () => {
		expect(classifyFailure(httpError(400, "invalid request schema"))).toEqual({ failover: false });
		expect(classifyFailure(new Error("context length exceeded"))).toEqual({ failover: false });
	});
});
