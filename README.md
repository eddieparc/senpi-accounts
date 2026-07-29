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
