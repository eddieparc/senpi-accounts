# @eddieparc/senpi-accounts

Senpi extension for upstream provider account management.

> **Status: scaffold.** The extension factory in `src/index.ts` is a near-no-op;
> account-management behavior lands in later tasks.

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
- Nothing is vendored and there is no silent `any` fallback: `src/index.ts`
  carries a compile-time guard (`IsAny` check) that fails the build if the
  upstream `ExtensionAPI` ever degrades to `any` (e.g. broken type resolution
  under `skipLibCheck`).

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
senpi's extension mechanism (e.g. `senpi -e /path/to/senpi-accounts`).

## License

MIT — see [LICENSE](./LICENSE).
