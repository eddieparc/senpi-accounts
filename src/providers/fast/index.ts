/**
 * OpenAI Codex fast mode (`/fast`) — investigated, and deliberately NOT
 * reimplemented here.
 *
 * Stock senpi registers `/fast` only for the `openai-codex` provider and
 * switches to a `<id>-fast` catalog sibling carrying `serviceTier: "priority"`.
 * The catalog generator emits those variants only for the direct `openai`
 * provider, so no Codex model has a target and stock answers
 * "Fast mode is not supported for openai-codex/<model>" (issue #499).
 *
 * Two findings from measuring this against a live ChatGPT Pro subscription on
 * `chatgpt.com/backend-api/codex/responses`:
 *
 *   service_tier=priority -> HTTP 200, response echoes "auto"
 *   service_tier=default  -> HTTP 200, response echoes "auto"
 *   service_tier=auto     -> HTTP 400 Unsupported service_tier
 *   service_tier=flex     -> HTTP 400 Unsupported service_tier
 *   service_tier=scale    -> HTTP 400 Unsupported service_tier
 *
 * 1. The backend allowlists `priority` but serves it at normal tier. Priority
 *    processing is an API-billing feature, not a subscription one. Synthesising
 *    the missing `-fast` variants would therefore ship a placebo, and because
 *    senpi's `getServiceTierCostMultiplier()` bills `priority` at 2.5x for
 *    gpt-5.5 it would also inflate reported cost for unchanged service.
 * 2. Registering our own `fast` command is actively harmful. Two commands
 *    sharing a name make senpi disambiguate them as `fast:1` / `fast:2`, and
 *    plain `/fast` then matches neither and is sent to the model as an ordinary
 *    prompt — the model replies "Fast mode on." while nothing has changed.
 *    Verified in a live TUI session.
 *
 * So the correct repair is upstream, not here: the stock notice is wrong, not
 * the stock mechanism. Filed as code-yeongyu/senpi#503, which replaces the
 * misleading text with the plan-level explanation. This module intentionally
 * registers nothing and exists to keep that conclusion (and the measurements
 * behind it) from being re-litigated.
 */

/** Why priority tier cannot work on a ChatGPT subscription. Documentation only. */
export const FAST_MODE_FINDING =
	"Priority ('fast') tier is unavailable on a ChatGPT subscription: chatgpt.com accepts " +
	"service_tier=priority but serves the request at normal tier, while senpi would bill it at " +
	"up to 2.5x. Priority processing requires API-key billing on the `openai` provider, whose " +
	"catalog already carries -fast variants. Fixed upstream in code-yeongyu/senpi#503.";

/**
 * No-op by design.
 *
 * Kept as an explicit function so the addon's entry point documents that fast
 * mode was considered and consciously left to stock, rather than forgotten.
 */
export function registerFastMode(): void {
	// Intentionally empty: see the module comment. Registering a `fast` command
	// here would collide with stock's and break `/fast` entirely.
}
