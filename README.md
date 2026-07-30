# senpi-accounts

Multi-account subscription providers for [senpi](https://github.com/code-yeongyu/senpi),
with cache-preserving routing, usage-aware placement and automatic 429 failover.

Stock senpi is the base layer and is never modified. This addon sits on top of it and
fills only the gaps stock leaves.

> ### Purpose and scope
>
> **This is an open-source project published for learning and research purposes.** It
> exists to explore how senpi's extension API composes providers, how prompt-cache
> affinity interacts with account rotation, and how subscription rate limits surface
> through a provider SDK.
>
> It automates nothing you could not do by hand: it signs in with **your own**
> subscriptions, through each vendor's normal OAuth flow, and stores the resulting
> tokens in senpi's own `auth.json`. It does not share, pool, resell or redistribute
> accounts, and it does not bypass any vendor's authentication, billing or rate limits
> — when a subscription is exhausted this addon simply reports it and stops using that
> account until the vendor's own reset time.
>
> You are responsible for complying with the terms of service of every provider you
> configure. Review them before using multiple accounts. Provided as-is, without
> warranty, under the MIT licence.

## What this addon adds

| Capability | Status | Where it comes from |
|---|---|---|
| **Kiro** subscription provider (Google / GitHub / AWS Builder ID) | **shipped, live-verified** | this addon |
| Multi-account pool with pin, rotation, 429 failover and timed failback | **shipped, live-verified** | this addon |
| Cache-preserving conversation affinity + usage-aware placement | shipped | this addon |
| Per-account and full logout; `cache-first` / `balanced` / `spread` modes | shipped | this addon |
| `/usage` dashboard across every subscription | shipped | this addon |
| **OpenAI Codex account pool** | experimental, opt-in | this addon |
| Anthropic multi-account | stock | `/claude-account` |
| Alibaba Token Plan, OpenCode Go | stock | API-key providers |

Nothing marked *stock* is reimplemented here; the addon only surfaces it in the usage
dashboard.

**Kiro is the supported provider in this release.** It is verified against the live API:
four models (`claude-opus-5`, `claude-opus-4.7`, `claude-sonnet-4.6`, `claude-haiku-4.5`),
two real accounts, per-account pinning, failover onto a second account when the first is
rejected, automatic token refresh, and recovery after a cooldown expires.

### Two stock bugs found while building this

Both were reported upstream rather than worked around here:

- [senpi#503](https://github.com/code-yeongyu/senpi/pull/503) — `/fast` can never succeed.
  The command is registered only for `openai-codex`, but the catalog generator emits
  `-fast` priority variants only for the direct `openai` provider. Measured against
  `chatgpt.com`, `service_tier: "priority"` returns HTTP 200 and is then served at normal
  tier, while senpi bills it at up to 2.5x — so synthesising the missing variants would be
  a placebo that inflates reported cost. Fast mode is therefore **not** implemented here;
  the PR corrects the misleading message instead.
- [senpi#505](https://github.com/code-yeongyu/senpi/pull/505) — Claude multi-account never
  rotates. Plan exhaustion arrives as prose ("You've hit your weekly limit") or as a bare
  `error_during_execution` with the cause only in `terminal_reason`, and neither was
  classified as a rate limit, so the exhausted account was never blocked.

## Install

Requires senpi `>= 2026.7.28` (verified against `2026.7.29-6`).

**From npm:**

```bash
senpi install npm:@eddieparc/senpi-accounts
```

**From source** — no npm account needed, and the path this repo is tested against:

```bash
git clone https://github.com/eddieparc/senpi-accounts.git
cd senpi-accounts
npm install
npm run build
```

Then either load it per-run:

```bash
senpi -e /absolute/path/to/senpi-accounts
```

or enable it for every session by adding the built entry point to `extensions` in
`~/.senpi/agent/settings.json`:

```json
{
  "extensions": ["/absolute/path/to/senpi-accounts/dist/index.js"]
}
```

Point at `dist/index.js`, not the repository root. senpi enumerates a bare
directory and would load `dist/` and `src/` as two separate extensions.

Verify it loaded:

```bash
senpi -e /absolute/path/to/senpi-accounts --list-models | grep kiro
```

## Kiro setup

```
/login kiro
```

`/login kiro` is a full account manager, not just a one-shot login:

| Action | What it does |
|---|---|
| Add an account | Google / GitHub / AWS Builder ID sign-in, then names the slot |
| Log out of one account | Deletes one account, leaving the rest intact |
| Log out of every account | Empties the pool, clearing the pin and bindings too |
| Pin / Clear the pin | Force every request onto one account |
| Clear a block | Lift a rate-limit or auth block early |
| Scheduling mode | `cache-first` (default), `balanced` or `spread` |

Both logout paths live inside `/login kiro`, which is the account manager. Full
logout asks for confirmation first, and clears the pin and conversation bindings
along with the accounts so nothing points at a slot that no longer exists.

Then pick a model:

```
/model kiro/claude-opus-5
```

### Adding a second or third Kiro account

Kiro federates Google sign-in through its own Cognito pool, and Google keeps a
browser-wide SSO cookie. Two consequences:

- Signing out of **Kiro** alone is not enough — Google silently re-authenticates the
  same identity server-side, before any client-side `prompt=select_account` can apply.
- Aside browser profiles do **not** help: they share one Google cookie jar, so every
  profile presents the same default Google account.

So a second Kiro account needs the Google account switched first. This sequence
works:

1. Sign out of Kiro: `https://app.kiro.dev/home` → account menu → **Sign Out**.
2. Sign in to Google as the target account at `https://accounts.google.com/`.
   These accounts use a **passkey**, so this step needs a human at the machine
   (Touch ID); it cannot be automated.
3. Confirm the switch stuck — `https://app.kiro.dev/signin` should say
   "currently signed in via Google as: <target>".
4. Run the scripted login; it binds whichever identity Kiro now holds.

All three Kiro auth methods were exercised and all three resolve to whichever
identity the browser/AWS session already holds:

| Method | Result |
|---|---|
| Google | Kiro's Cognito session re-federates the current Google account |
| GitHub | same Cognito session behaviour |
| AWS Builder ID | device-code flow completes (`요청 승인됨`) but returns the same AWS identity |

So switching accounts is a browser/AWS session action, not something the addon
can drive. The duplicate guard below exists precisely because these flows all
*succeed* while silently returning the identity you already had.

Verify which identity was actually captured — the login prints the email:

```
USAGE 0/0 jgplabs@gmail.com
SAVED jgplabs
```

If it prints the wrong address, the Google session did not switch; repeat step 2.
Accounts are keyed by name, so a duplicate simply stores the same identity twice and
yields no extra quota.

### Scripted login

For CI or headless setup:

```bash
SENPI_CODING_AGENT_DIR=~/.senpi/agent \
  npx tsx scripts/login.mts <account-name> [google|github|builder-id]
```

It prints the authorize URL, captures the localhost callback automatically, and appends
the account to the pool.

## Other subscriptions

**Alibaba Token Plan** and **OpenCode Go** are stock providers that authenticate
with an API key, so they need nothing from this addon:

```
/login alibaba-token-plan     # or set ALIBABA_TOKEN_PLAN_API_KEY
/login opencode-go            # or set OPENCODE_API_KEY
```

Both appear in `/usage` once configured.

**Anthropic** multi-account is stock; use `/claude-account`. This addon does not
touch it.

**OpenAI Codex** works out of the box as stock `openai-codex`, and that is the
recommended path.

Pooling several ChatGPT subscriptions is **experimental** in this release and opt-in:

```bash
export SENPI_ACCOUNTS_CODEX_POOL=1
```

That registers a `codex-pool` provider which delegates streaming to stock's Codex
Responses implementation while adding the same account pool, affinity and failover as
Kiro. Manage it with `/login codex-pool`.

It is marked experimental because it has been verified with only **one** real account
(rotation was proved using a deliberately invalid second slot, not two live
subscriptions), and because it depends on resolving stock's Codex streamer at runtime —
senpi is a peer dependency, so that resolution is anchored on the running senpi process.
If it cannot be resolved the provider degrades on its own and Kiro is unaffected.

## How routing works

The scarce resource is not quota alone but the upstream **prompt-prefix cache**. Moving a
conversation to a different account makes that account's cache cold, which usually costs
more than the quota it saves. So:

1. **Affinity first.** A conversation is fingerprinted from its first user message and
   pinned to one account. Later turns reuse it, keeping the cache warm.
2. **Quota only when the cache is cold.** For a conversation that has not been placed
   before, `balanced` mode picks the account with the most headroom using
   power-of-two-choices, which spreads load without herding onto one account.
3. **429 failover last.** A rate-limited, quota-exhausted, auth-failed or 5xx account is
   blocked and the request is replayed on the next account. Timed blocks expire on their
   own (failback); auth blocks persist until re-login.

Headroom comes from Kiro's own usage-limits endpoint, read from the `CREDIT` row of
`usageBreakdownList` — the same numbers the
[account page](https://app.kiro.dev/settings/account) shows. Snapshots are cached for 30s
with a 2s ceiling per refresh, so routing never waits on a quota lookup, and an expired
access token is refreshed before probing (a stale token answers HTTP 403, which would
otherwise read as "headroom unknown" and quietly drop that account from placement).

Measured across three live Pro Max accounts at 74.5% / 92.9% / 100% headroom, 300 cold
conversations in `balanced` mode placed 208 on the fullest account, 92 on the next, and
**0** on the most-used one. When no provider reports a limit, placement degrades to an even
spread rather than herding onto one account.

### Scheduling modes

| Mode | Behaviour |
|---|---|
| `cache-first` (default) | Hold one account per conversation. Maximises cache hits. |
| `balanced` | Same, but new conversations go to the account with the most quota left. |
| `spread` | Round-robin every request. Best load spread, ignores the cache. |

### Interaction with senpi's own fallback

senpi has a **model-level** fallback (`SelectorCooldowns` + fallback chains). This addon
is **account-level** and sits underneath it:

```
request
 └─ addon: pick account → on 429 retry on the next account   (senpi never sees this)
     └─ only when every account is blocked, the error surfaces
         └─ senpi: suppress the model, fall back to the next model
```

When the pool is fully blocked, the addon raises `AllAccountsBlockedError` carrying
`retryAfterMs` set to the real unblock time. senpi's cooldown prefers an explicit
`retryAfterMs` over its keyword heuristics, so the model is suppressed for exactly as long
as the pool is down instead of senpi's default 30-minute quota bucket.

## Commands

| Command | Purpose |
|---|---|
| `/login kiro` | Account manager: add, log out (one or all), pin, unblock, set scheduling mode |
| `/usage` | Remaining usage across addon and stock subscriptions |
| `/senpi-accounts` | Provider health, including any degraded provider |

## Reliability

Each provider is an isolated package under `src/providers/`, loaded lazily inside its own
try/catch. A provider that fails to load, build or register is reported as degraded and
skipped; every other provider still registers. Providers never import each other.

Credentials live in senpi's own `auth.json`, written atomically with `0600` permissions.
A corrupt `auth.json` is never overwritten.

### Keychain (optional, macOS)

`src/core/keychain.ts` can hold pools in the macOS Keychain instead of the filesystem.
It is **off by default** because `auth.json` already matches stock's protection, and it
is only used when `keychainAvailable()` proves a full write/read round-trip succeeds —
presence of the `security` binary is not enough, since a locked or access-denied keychain
would silently drop credentials.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```
