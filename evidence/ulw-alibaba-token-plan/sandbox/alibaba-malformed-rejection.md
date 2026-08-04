# Sandbox PASS — malformed Alibaba key is rejected

Surface: the same visible Orca xterm and isolated credential store used by the
validated happy path.

Actions:

1. `/login alibaba-model-studio`
2. Select `Alibaba Model Studio (workspace)`
3. Submit the sentinel `definitely-not-a-secret-key` at the custom prompt.

Observed:

```text
Error: Failed to login to Alibaba Model Studio (workspace):
Alibaba Model Studio workspace API keys must start with sk-ws-
```

Post-condition:

```json
{
  "providers": ["alibaba-model-studio"],
  "type": "oauth",
  "keyPrefix": "sk-ws-",
  "keyLength": 117,
  "keySha256": "c64008f390220dea7acf1160e907c3d85fe54229177bb5e213c6391dec981d42"
}
```

The saved replacement credential hash is unchanged, proving the malformed input
was not persisted.

Screenshot:

- `/var/folders/8b/wc4w7rz95w3_6b0xm_r869yw0000gn/T/orca-computer-use/3ba41b19-b9f1-4f38-a87f-2dde8cc51a8e-screenshot.png`
- SHA-256 `33f32b6b76115201899bb5353d12b028d7bf3b5054b02c4faa32a2605d10ceb3`
- visually inspected: the explicit prefix error is visible; neither the real
  key nor the sentinel is echoed.
