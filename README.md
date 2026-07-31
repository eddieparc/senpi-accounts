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
| **TokenRouter** provider (117 models behind one key) | **shipped, live-verified** | this addon |
| **OpenGateway** provider (Kimi K3 Ultrafast) | shipped | this addon |
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

Requires senpi `>= 2026.7.28` (verified against `2026.7.30`).

**One command** — from the npm registry:

```bash
npm install @eddieparc/senpi-accounts
```

The git route works too and compiles on install:

```bash
npm install github:eddieparc/senpi-accounts
```

npm runs the package's `prepare` script for a git dependency, so `dist/` is
compiled during install. Then point senpi at the built entry:

```text
senpi -e ./node_modules/@eddieparc/senpi-accounts
```

Or use the tarball attached to the
[v0.2.0 release](https://github.com/eddieparc/senpi-accounts/releases/tag/v0.2.0):

```text
npm install ./eddieparc-senpi-accounts-0.2.0.tgz
```

**From source** — the path this repo is developed against:

```bash
git clone https://github.com/eddieparc/senpi-accounts.git
cd senpi-accounts
npm install
npm run build
```

Then either load it per-run (substitute your own checkout path):

```text
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

Verify it loaded — this should print the Kiro models:

```text
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

The built-in catalog follows Kiro CLI 2.15.2 and includes its Claude, GPT-5.6,
DeepSeek, MiniMax, GLM and Qwen options. Availability still depends on the
selected account. To replace the catalog without waiting for a package update:

```bash
export KIRO_MODELS_OVERRIDE=auto,claude-sonnet-5,gpt-5.6-sol
```

Automatic completion probing is intentionally disabled because probes consume
credits and one pooled account's entitlement does not describe the whole pool.

For redacted Kiro protocol and request-failure diagnostics:

```bash
export KIRO_DEBUG=1
```

The log is written to `$SENPI_CODING_AGENT_DIR/debug/debug.log`. Credentials and
authorization values are redacted, and logging is off by default.

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

```text
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

Both appear in `/usage` once configured. Verified state on the development machine:
`opencode-go` is registered and listed in `/usage` (`configured (API key; no quota
endpoint)`), but a live completion returns `401 CreditsError: Insufficient balance` — a
billing state, not an addon fault. `alibaba-token-plan` is **not configured here**, so it
is unverified end to end; stock already lists its models (`deepseek-v4-pro`, `glm-5.2`,
`kimi-k2.7-code`, ...), and it needs only the key above.

**Anthropic** multi-account is stock; use `/claude-account`. This addon does not
touch it.

### TokenRouter

TokenRouter fronts ~117 models behind one OpenAI-compatible endpoint, and stock senpi
has no `tokenrouter` provider — so the models are unreachable however the key is stored.
This addon registers the provider id, which is what puts TokenRouter in the `/login`
list:

```
/login tokenrouter            # or set TOKENROUTER_API_KEY
```

Issue the key at [tokenrouter.com](https://www.tokenrouter.com) under Console -> API
Keys. There is no account pool: TokenRouter meters one account, so rotating keys would
buy nothing, and this is a single-credential provider like stock's `opencode-go`.

The catalog ships `moonshotai/kimi-k3`, `moonshotai/kimi-k3-free`,
`deepseek/deepseek-v4-pro`, `qwen/qwen3.7-max` and `z-ai/glm-5.2`;
`TOKENROUTER_MODELS_OVERRIDE=<comma-separated ids>` adds any other id the router serves.
A catalog is mandatory rather than cosmetic — an extension-registered provider inherits
no models, and without one `--provider tokenrouter` fails as `Unknown provider`.

Two measured quirks are encoded in the catalog's `compat` profile rather than left for a
user to hit:

| Request senpi sends by default | TokenRouter's answer |
|---|---|
| `role: "developer"` | `HTTP 400 role 'developer' is not allowed` |
| `store: false` | `HTTP 200` with a whitespace body and no completion |

Both made a turn fail as `422 openai_error` while a plain `curl` succeeded, so every
model declares `supportsDeveloperRole: false` and `supportsStore: false`.

**`kimi-k3-free` is slow, not broken.** The free tier queued for 395s on a cold call
before returning a normal `HTTP 200`. senpi bounds the wait to the first stream event at
90s by default, so a free-tier turn needs that raised:

```json
{
  "retry": { "provider": { "streamStartTimeoutMs": 600000, "streamIdleTimeoutMs": 600000 } }
}
```

Paid `moonshotai/kimi-k3` answers in 6-9s and needs no such setting.

### OpenGateway

OpenGateway is an OpenAI-compatible gateway that stock senpi does not know, so its
models are unreachable no matter where the key is stored. Registering the provider id is
what puts it in the `/login` list, and senpi's own API-key prompt then stores, replaces
and drops the key:

```
/login opengateway            # or set OPENGATEWAY_API_KEY
```

The catalog ships `moonshotai/kimi-k3-ultrafast`. OpenGateway publishes neither token
limits nor pricing, so the limits mirror Kimi K3 elsewhere in senpi and cost stays zero
rather than inventing billing data. Like TokenRouter this is a single-credential
provider: one metered account, so there is no pool to rotate.

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

Measured across three live Pro Max accounts, `balanced` mode places cold conversations by
headroom and leaves the most-used account untouched; the per-mode figures are in
[Scheduling modes](#scheduling-modes). When no provider reports a limit, placement
degrades to an even
spread rather than herding onto one account.

### Scheduling modes

| Mode | Behaviour |
|---|---|
| `cache-first` (default) | Hold one account per conversation. Maximises cache hits. |
| `balanced` | Same, but new conversations go to the account with the most quota left. |
| `spread` | Round-robin every request. Best load spread, ignores the cache. |

Measured over the three live Pro Max accounts at 70.3% / 90.1% / 98.1% headroom, 300 cold
conversations each:

| Mode | Placement |
|---|---|
| `cache-first` | `jgplabs01` 111, `jgp3620` 98, `jgplabs` 91 — hashed, quota ignored |
| `balanced` | `jgplabs01` 194, `jgplabs` 106, `jgp3620` **0** — most-used account starved |
| `spread` | 100 / 100 / 100 — exactly even |

The same conversation key placed twice returns the same account with `reusedBinding=true`,
so affinity holds across turns.

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

The probe asks `security default-keychain` before attempting anything. An isolated `HOME`
(CI, a sandbox, the README doc-check) has no login keychain, and a write in that state
makes macOS raise a modal "keychain could not be found" dialog that blocks the run until
someone clicks it. Reporting unavailable is the correct answer there, and it costs no
write.

## Publishing

Published to the npm registry as
[`@eddieparc/senpi-accounts`](https://www.npmjs.com/package/@eddieparc/senpi-accounts).
A scoped package defaults to restricted access, which answers `402 Payment Required` on a
free account, so `publishConfig.access` is `public` in `package.json` and no flag is
needed.

Releases go out from CI over
[trusted publishing](https://docs.npmjs.com/trusted-publishers): `.github/workflows/release.yml`
authenticates to the registry with a short-lived OIDC token, so no npm credential is
stored anywhere and no publish needs an interactive 2FA approval. Bump the version, then
push the tag:

```bash
npm version patch          # or minor / major
git push origin main --follow-tags
```

The workflow also accepts a manual `workflow_dispatch` run. Either way `prepublishOnly`
runs typecheck, the full suite and the build first, so an unverified tree cannot reach the
registry, and npm attaches a signed provenance statement because the publish is attributable
to the workflow that produced it.

Publishing this way depends on three things staying in agreement, and npm only reports a
mismatch when a publish actually runs:

- the trusted publisher registered on npmjs.com names `eddieparc` / `senpi-accounts` /
  `release.yml`, case-sensitive and including the extension
- the workflow keeps `permissions: id-token: write`
- `repository.url` in `package.json` matches the GitHub repository

Renaming the workflow file therefore breaks releases until the npm setting is renamed to
match.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```
