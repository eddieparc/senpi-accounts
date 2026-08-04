# GLM 5.2 quota failure and GPT-5.6 fallback

The first restart wave correctly selected the requested model:

```text
(alibaba-model-studio) glm-5.2:high
```

The live work request then failed:

```text
Error: 429: {
  "message": "Allocated quota exceeded, please increase your quota limit.",
  "type": "insufficient_quota",
  "code": "insufficient_quota"
}
```

A fresh terminal-tail scan classified all 22 target sessions as
`quota_429`. The key and endpoint remained valid: a separate one-token
`glm-5.2` request returned HTTP 200; the failure is the workspace's allocated
concurrent/token quota under full workloads.

Screenshot:

- `/var/folders/8b/wc4w7rz95w3_6b0xm_r869yw0000gn/T/orca-computer-use/0e073863-0f29-41c6-8872-507d1565a3c8-screenshot.png`
- SHA-256 `e2d07719afed4719306ce15527f6e4cd7bec5b5865c957ede140730d3e09572c`
- visually inspected: `glm-5.2:high` and `429 insufficient_quota` are visible.

Fallback, explicitly authorized by the user:

```bash
senpi -e /Users/jgp/Eddie-Personal-Space/work/lab-36-senpi-accounts/dist/index.js \
  --model kiro/gpt-5.6-sol \
  --thinking high \
  --continue "<end-to-end completion prompt>"
```

All 22 quota-blocked terminals were stopped. Twenty-two fresh Kiro
GPT-5.6 Sol terminals were created and connected, but the live surface
reported:

```text
(kiro) gpt-5.6-sol:high
Error: No API key found for kiro.
```

Kiro was therefore abandoned. The already authenticated stock Codex route was
probed before another fan-out:

```bash
senpi --no-extensions --no-session --no-tools \
  --model openai-codex/gpt-5.6-sol \
  --thinking high \
  -p 'Reply only with CODEX_OK'
```

Observed output: `CODEX_OK`.

All 22 Kiro terminals were stopped. Twenty-two fresh
`openai-codex/gpt-5.6-sol`, thinking `high`, continuation terminals were then
created successfully. Monitor `bash_534` watches their startup.
