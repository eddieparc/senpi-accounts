# RED — Alibaba key/endpoint mismatch

Captured: 2026-08-04T01:01:15+09:00

The key was copied from the already-authenticated Alibaba Model Studio console
into the macOS clipboard. The commands never printed the key and sanitized any
`sk-*` token in the response.

Payload:

```json
{"model":"qwen-plus","messages":[{"role":"user","content":"1"}],"max_tokens":1,"stream":false}
```

Results:

| Endpoint | Result |
|---|---|
| `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions` | `HTTP/2 401`, `code=invalid_api_key`, request `2e99cacc-eac1-42e4-b1c7-7bcfd647a63b` |
| `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` | `HTTP/2 401`, `code=invalid_api_key`, request `ac0133f2-0dfd-95ff-b532-074cdec2ff8d` |
| `https://ws-tzcu53xu4sxxeqq4.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions` | `HTTP/2 200`, model `qwen-plus`, content `It`, request `b2b06fd0-5743-9aa1-a788-84fddf73fbc4` |

Binary RED observable: the stock Token Plan endpoint returns 401 for this valid
workspace key while the dedicated workspace endpoint returns 200.

No server, browser context, port, temporary file, or directory was created by
the curl probes. The existing Aside tab remains user-owned and was not closed.
