# GREEN — Alibaba workspace auth and Codex pool visibility

Command:

```bash
npm --prefix /Users/jgp/Eddie-Personal-Space/work/lab-36-senpi-accounts test -- \
  test/extension.test.ts test/alibaba-model-studio.test.ts
```

Result: exit 0.

```text
Test Files  2 passed (2)
Tests       14 passed (14)
Duration    1.25s
```

Covered:

- `alibaba-model-studio` is registered by the extension.
- The dedicated workspace endpoint is normalized and used.
- A valid `sk-ws-` key receives a one-token `qwen-plus` validation probe before
  Senpi stores it.
- A malformed key is rejected before network access.
- A revoked key is rejected with a status-only error that never includes the
  key.
- `codex-pool` registers without `SENPI_ACCOUNTS_CODEX_POOL=1`, so `/login` can
  list it.
