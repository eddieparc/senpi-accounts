# @eddieparc/senpi-accounts

Senpi extension for registering provider fragments from user-owned JSON files.

## Install

Install the published package into senpi:

`senpi install npm:@eddieparc/senpi-accounts@0.1.0`

The extension loads `*.json` fragments from
`~/.config/senpi-accounts/providers.d/`. Set `SENPI_ACCOUNTS_DIR` to use a
different directory. If the primary directory does not exist, it falls back to
`~/.config/omo-providers/providers.d/`; files ending in `.disabled` are ignored.

For a local checkout, build it and verify a fragment before installing it:

```sh
npm run build
```

```sh
export SENPI_ACCOUNTS_EXTENSION="$(pwd)/dist/index.js"
export SENPI_ACCOUNTS_DIR="$HOME/.config/senpi-accounts/providers.d"
export SENPI_ACCOUNTS_DOC_KEY="documentation-test-key"
```

```sh
mkdir -p "$SENPI_ACCOUNTS_DIR"
cat > "$SENPI_ACCOUNTS_DIR/10-documentation-example.json" <<'JSON'
{
  "documentation-example": {
    "name": "Documentation example",
    "baseUrl": "http://127.0.0.1:9",
    "apiKey": "$SENPI_ACCOUNTS_DOC_KEY",
    "api": "anthropic-messages",
    "authHeader": false,
    "models": [
      {
        "id": "documentation-model",
        "name": "Documentation model",
        "reasoning": false,
        "input": ["text"],
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 8192,
        "maxTokens": 1024
      }
    ]
  }
}
JSON
```

```sh
npx --no-install senpi \
  --no-extensions --no-skills --no-prompt-templates --no-themes \
  --no-context-files --offline \
  --extension "$SENPI_ACCOUNTS_EXTENSION" \
  --list-models documentation-example
```

## Fragment format

Each file is a JSON object mapping a provider id to its configuration. The
extension accepts `name`, `baseUrl`, `apiKey`, `api`, `headers`, `extraBody`,
`authHeader`, and `models`, plus the extension-owned `accounts` key described
below. Unknown fields are rejected with the file and field name.

A model in a fragment must contain `id`, `name`, `reasoning` (boolean), `input`
(an array of `text`, `image`, or `video`), `cost`, `contextWindow`, and
`maxTokens`. Incomplete models are rejected, and the provider silently will
not appear in `senpi --list-models`; this is easy to miss when editing a
fragment.

## Credential reference syntax

Credentials are references, not literal values. For `apiKey` and every header
value, senpi supports `!command`, `$ENV_VAR`, `${ENV_VAR}`, `$$` yields a
literal `$`, and `$!` yields a literal `!`. The extension passes references to
senpi unchanged and rejects credential-shaped literal values. It does not log,
persist, or refresh credentials.

## Multi-account setup

Add an `accounts` array to a provider entry. Every account requires `id` and
`label`; it must override at least one of `apiKey`, `headers`, or
`upstreamModelIdSuffix`. Account credentials must be `!command`, `$ENV_VAR`,
or `${ENV_VAR}` references.

```json
{
  "gateway": {
    "name": "Gateway",
    "baseUrl": "https://gateway.example",
    "api": "anthropic-messages",
    "models": [],
    "accounts": [
      {
        "id": "personal",
        "label": "Personal",
        "apiKey": "$GATEWAY_PERSONAL_KEY"
      },
      {
        "id": "work",
        "label": "Work",
        "headers": { "x-api-key": "!gateway-work-key" },
        "upstreamModelIdSuffix": ":work"
      }
    ]
  }
}
```

The first account registers as `gateway`; later accounts register as
`gateway-account-2`, `gateway-account-3`, and so on. Account `apiKey` and
`headers` shallowly replace the base fields. `upstreamModelIdSuffix` changes
each model's upstream id while preserving its user-facing `id`.

`accounts` is extension-owned and is stripped before registration. Fragments
cannot declare `oauth`: the loader rejects it, the extension never emits a
`ProviderConfig.oauth` block, and these accounts do not create `/login
<provider>` flows. Configure their credential references directly. There is no
automatic rotation, cooldown, failover, or refresh timer.

## Diagnostics

Run `senpi-accounts doctor` after building or installing the package. It reports
the selected config directory, loaded fragments, registered provider ids, and
whether each credential reference resolves. It prints booleans only, never a
resolved credential, and exits nonzero when a reference fails. It is read-only.

The doctor also identifies an active legacy `~/.config/omo-providers` layer and
names any provider-id collision with `models.json`, which takes precedence over
an extension provider.

## ccapi

The ccapi endpoint is a third-party service, not operated by this project.
Users supply their own credentials at their own risk. Measured availability was
low (3 of 12 identical requests returned HTTP 200); do not treat a failed live
request as proof that fragment registration is wrong.

For an `anthropic-messages` ccapi fragment, `baseUrl` must not end in `/v1`.
Senpi appends `/v1/messages`; a trailing suffix produces
`/v1/v1/messages` and a 404. The regression test in
`test/provider-registration.e2e.test.ts` locks this behavior.

Set `authHeader` to `false` for an `x-api-key` provider. Otherwise senpi adds
`Authorization: Bearer`, and providers using `x-api-key` authentication,
including ccapi, answer 403.

## Kiro prerequisite

The Kiro preset is intentionally shipped as a `.disabled` fragment. It is not
verified until Kiro is installed and logged in locally and a compatible local
gateway is running. Activate it only after those prerequisites are met, then
set the gateway URL, available models, and credential reference for that
gateway. The package does not claim verified Kiro support or invent a Kiro
endpoint or model list.

## Migration from ~/.config/omo-providers

1. Keep `~/.config/omo-providers` as a dated backup. Do not delete it before
   the extension is verified.
2. Install the package, create `~/.config/senpi-accounts/providers.d/`, and
   copy compatible `*.json` fragments there. Run `senpi-accounts doctor` and
   verify the expected rows with `senpi --list-models`.
3. Only after that verification, remove the legacy-owned provider entry from
   `~/.senpi/agent/models.json` outright and remove the legacy shell hook.
   Do not leave both layers registering the same id.

Do not mark a transition provider as `"disabled": true` in `models.json`.
Senpi processes that setting before extension registration and silently deletes
an extension-registered provider with the same id. Remove the legacy entry
instead.

## API-subset limitation

The extension API is a strict subset of `models.json`. `whitelist`, `blacklist`,
`disabled`, `compat`, `cacheRetention`, and `modelOverrides` cannot be
expressed through `registerProvider`; providers requiring any of them stay in
`models.json`.

## Version compatibility policy

Supported senpi range: `>=2026.7.28-3-dev.954f53da6 <2027.0.0`, matching the
bounded peer dependency. `registerProvider` is public but carries no stability
guarantee. Pin senpi to a tested version and re-test fragments and diagnostics
before upgrading it.

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
cp "$(npm prefix)/presets/20-kiro.json.disabled" \
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

`npm run typecheck`, `npm run build`, `npm test`, and `npm run doc-check` are
the package checks. `npm run doc-check` runs every shell command block in this
README in an isolated temporary home directory.

## License

MIT - see [LICENSE](./LICENSE).
