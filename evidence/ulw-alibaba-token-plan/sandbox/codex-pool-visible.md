# Sandbox PASS — Codex pool is selectable

Surface: Orca visible xterm `LAB-36 validation-only QA`, with the built addon
loaded from `dist/index.js`.

Action:

```text
/login codex-pool
```

Observed selector row:

```text
→ codex-pool  OpenAI Codex (pool) · subscription
```

Selecting the row entered the real provider flow:

```text
Login to OpenAI Codex (pool)
Sign in to ChatGPT. senpi captures the callback automatically
Waiting for the OpenAI sign-in callback...
```

This proves the provider is present, selectable, and wired to the existing
subscription pool implementation without completing or changing any account.

Screenshot:

- `/var/folders/8b/wc4w7rz95w3_6b0xm_r869yw0000gn/T/orca-computer-use/719be35a-8ae4-498f-86eb-c0d4ccf4ab32-screenshot.png`
- SHA-256 `fceef61eddb01a9b9ad77dfbedd06cbca4816e368a6cd3c1aa69040ee2be7363`
- visually inspected: `Login to OpenAI Codex (pool)` is visible.

Cleanup:

- interrupted the OAuth flow before any account change;
- callback port `1455` is closed;
- the spawned OpenAI authentication tab was closed via Orca computer-use
  `CmdOrCtrl+W`;
- Aside reports zero matching `auth.openai.com`/`localhost:1455` tabs.
