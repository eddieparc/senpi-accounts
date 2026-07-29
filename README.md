# senpi-accounts

Multi-account subscription providers for [senpi](https://github.com/code-yeongyu/senpi),
with cache-preserving routing, usage-aware placement and automatic 429 failover.

Stock senpi is the base layer and is never modified. This addon sits on top of it and
fills only the gaps stock leaves.

## What this addon adds

| Capability | Where it comes from |
|---|---|
| **Kiro** subscription provider (Google / GitHub / AWS Builder ID) | this addon |
| Multi-account pool with pin, rotation, 429 failover and timed failback | this addon |
| Cache-preserving conversation affinity + usage-aware placement | this addon |
| **OpenAI Codex account pool** (opt-in, reuses stock's Codex API) | this addon |
| `/usage` dashboard across every subscription | this addon |
| Anthropic multi-account | **stock** (`/claude-account`) |
| OpenAI Codex fast mode | **stock** (`service-tier`, `-fast` models) |
| Alibaba Token Plan, OpenCode Go | **stock** (API-key providers) |

Nothing above marked *stock* is reimplemented here; the addon only surfaces it in the
usage dashboard.

## Install

```bash
senpi install npm:@eddieparc/senpi-accounts
```

Or load a local checkout directly:

```bash
senpi -e /path/to/senpi-accounts
```

## Kiro setup

```
/login kiro
```

`/login kiro` is a full account manager, not just a one-shot login:

| Action | What it does |
|---|---|
| Add an account | Google / GitHub / AWS Builder ID sign-in, then names the slot |
| Remove an account | Deletes one account, leaving the rest intact |
| Pin / Clear the pin | Force every request onto one account |
| Clear a block | Lift a rate-limit or auth block early |
| Scheduling mode | `cache-first`, `balanced` or `spread` |

`/logout kiro` removes **all** Kiro accounts, matching stock `/logout` semantics.
To drop a single account, use *Remove an account* inside `/login kiro`.

Then pick a model:

```
/model kiro/claude-opus-5
```

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

**OpenAI Codex** works out of the box as stock `openai-codex`. If you want to pool
several ChatGPT subscriptions, opt in:

```bash
export SENPI_ACCOUNTS_CODEX_POOL=1
```

That registers a `codex-pool` provider that reuses stock's Codex Responses API —
so fast mode and service tiers keep working — while adding the same account pool,
affinity and failover as Kiro. Manage it with `/login codex-pool`.

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
| `/login kiro` | Add, remove, pin or unpin accounts; set scheduling mode |
| `/logout kiro` | Remove all Kiro accounts |
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
