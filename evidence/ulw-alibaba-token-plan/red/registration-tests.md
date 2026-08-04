# RED — provider registration and Codex pool visibility

Command:

```bash
npm --prefix /Users/jgp/Eddie-Personal-Space/work/lab-36-senpi-accounts test -- test/extension.test.ts
```

Result: exit 1, 2 failed / 8 passed.

```text
FAIL extension entry > registers providers and the usage/health commands
AssertionError: expected false to be true
test/extension.test.ts:142
expect(pi.registered.has("alibaba-model-studio")).toBe(true)

FAIL codex pool provider > registers by default so it remains visible in /login
AssertionError: expected [Function enabled] to be undefined
test/extension.test.ts:157
expect(pkg.enabled).toBeUndefined()
```

Both failures are behavioral and occur at the intended seams: the Alibaba
workspace provider is not registered, and the Codex pool still has the opt-in
gate that hides it from `/login`.
