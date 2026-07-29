# @eddieparc/senpi-accounts

Senpi extension for upstream provider account management.

> **Status:** Loads validated JSON provider fragments and registers them through
> senpi's public `pi.registerProvider(id, config)` API during async extension
> startup.

## Supported senpi version

- Compatibility range (peer dependency): `@code-yeongyu/senpi` `^2026.7.28-3-dev.954f53da6`
  (i.e. `>=2026.7.28-3-dev.954f53da6 <2027.0.0`).
- Developed and tested against senpi `2026.7.28-3-dev.954f53da6`
  (npm release line `2026.7.28`).

## Types decision

**Option A — use the published `@code-yeongyu/senpi` types** via a bounded
devDependency (`^2026.7.28-3-dev.954f53da6`, types only, `import type`).

Why:

- The installed senpi ships usable declarations for extension authors:
  `dist/index.d.ts` re-exports `ExtensionAPI`, `ProviderConfig`, and friends,
  and `package.json` exposes them through `exports["."].types`
  (`./dist/index.d.ts`).
- Nothing is vendored: `src/index.ts` carries a compile-time guard that fails
  the build if the upstream `ExtensionAPI` stops resolving correctly (for
  example, under a broken `skipLibCheck` setup).

The rejected alternative (a minimal local interface in `src/types.ts`) remains
the fallback if a future senpi release stops shipping usable declarations.

## Development

- `npm install` — install dev dependencies (typescript, vitest, senpi types)
- `npm run build` — compile `src/` to `dist/` (tsc, emits `dist/index.js`)
- `npm test` — run vitest
- `npm run typecheck` — strict typecheck, no emit

## Loading in senpi

The `pi` block in `package.json` points senpi at the built entry
`./dist/index.js`. Run `npm run build` first, then load the package through
senpi's extension mechanism (for example,
`senpi -e /path/to/senpi-accounts/dist/index.js`).

### Anthropic Messages providers

For `api: "anthropic-messages"`, set `baseUrl` to the server origin or prefix
**without** a trailing `/v1`: senpi appends `/v1/messages`, so a `/v1` suffix
would request `/v1/v1/messages`. Set `authHeader: false` for normal Anthropic
`x-api-key` authentication; `authHeader: true` additionally sends
`Authorization: Bearer <key>`.

## Kiro local-gateway preset

The package ships `presets/20-kiro.json.disabled`. It is deliberately inert:
the loader only reads files ending in `.json`, so installing this package cannot
register Kiro by itself.

Kiro has no public inference API. **A local Kiro login is mandatory**: start and
sign in to the official Kiro CLI or IDE first, then run a local gateway that
reads the local authentication state written by that official client. This
extension never reads, copies, or stores that credential.

The included default targets an OpenAI-compatible gateway at
`http://127.0.0.1:8000/v1`, with the gateway request key supplied through
`$KIRO_GATEWAY_API_KEY` in both the configured API-key and `x-api-key` header
channels. Set that environment variable to the API key required by your chosen
local gateway; no key is included in this package. Change the endpoint, request
credential reference, and models in your copied fragment when your gateway uses
different settings.

Activate the preset explicitly by copying it into your user-owned provider
directory with a `.json` name:

```sh
mkdir -p ~/.config/senpi-accounts/providers.d
cp /path/to/senpi-accounts/presets/20-kiro.json.disabled \
  ~/.config/senpi-accounts/providers.d/20-kiro.json
export KIRO_GATEWAY_API_KEY='your-local-gateway-key'
senpi --list-models
```

The documented default model list is `claude-haiku-4.5`, `claude-opus-4.5`,
`claude-opus-4.6`, `claude-opus-4.7`, `claude-opus-4.8`, `claude-opus-5`,
`claude-sonnet-4.5`, `claude-sonnet-4.6`, and `claude-sonnet-5`. Availability
depends on both the user's Kiro tier and the chosen gateway, so remove or adapt
models that gateway does not expose.

This gateway approach was verified against a real Kiro subscription on the
author's machine. It is still opt-in because each user must have a local Kiro
login and choose, configure, and run a compatible local gateway.

## Declarative multi-account fragments

A fragment file is a JSON object mapping one provider id to one `ProviderEntry`:

```json
{
  "<providerId>": {
    "name": "string",
    "baseUrl": "string",
    "apiKey": "!command or $ENV reference",
    "api": "string",
    "headers": { "header-name": "!command or $ENV reference" },
    "extraBody": {},
    "authHeader": false,
    "models": [],
    "accounts": [
      {
        "id": "string",
        "label": "string",
        "apiKey": "optional !command or $ENV reference",
        "headers": { "header-name": "optional !command or $ENV reference" },
        "upstreamModelIdSuffix": "optional string"
      }
    ]
  }
}
```

`ProviderEntry` is exactly the public `ProviderConfig` subset `name`, `baseUrl`,
`apiKey`, `api`, `headers`, `extraBody`, `authHeader`, and `models`, plus the
optional extension-owned `accounts` array shown above. Account objects accept
exactly `id`, `label`, `apiKey`, `headers`, and `upstreamModelIdSuffix`; `id`
and `label` are required strings. `accounts` is not a senpi `ProviderConfig`
field and is always removed before `registerProvider` is called.

When `accounts` is present, entry 1 registers as `<providerId>`, entry 2 as
`<providerId>-account-2`, entry 3 as `<providerId>-account-3`, and so on. Each
registered configuration is a shallow merge of the base entry and that account's
`apiKey` and `headers`; an account `headers` object replaces the base `headers`
object rather than deep-merging it. Its display name is
`<base name or provider id> (<label>)`; `id` and `label` never enter the provider
id or registered config other than that display-name suffix.

Every account `apiKey` and header value must be a config-value reference:
`!command`, `$ENV`, or `${ENV}`. The same rule applies to a base credential that
an account inherits. Literal credential-shaped values are rejected with the
existing inline-secret diagnostic, and other literal account credential values
are rejected before registration. References are passed to senpi unchanged for
senpi itself to resolve; this extension never resolves, logs, persists, or
writes credentials.

An account must override at least one of `apiKey`, `headers`, or
`upstreamModelIdSuffix`; otherwise it is rejected as a duplicate and the error
names its `id`. A suffix-only account is valid. With
`upstreamModelIdSuffix`, each emitted model keeps its user-facing `id` while its
`upstreamModelId` becomes `<upstreamModelId ?? id><suffix>`.

Fragments cannot declare `oauth`; the extension never emits a `ProviderConfig.oauth`
block. It also implements no credential rotation, cooldown, failover, or refresh
timer.

## Reload safety

Provider ownership is held only in module memory. Each clean factory invocation
registers every valid configured provider and removes only previously owned IDs
that are no longer defined. If any fragment fails parsing or validation, its
absence is ambiguous: the extension reports the file-specific error, continues
registering valid fragments, and retains previously owned providers until a
later clean invocation confirms removal. The extension neither reads nor writes
`models.json`, credentials, or runtime state files.

## License

MIT — see [LICENSE](./LICENSE).
