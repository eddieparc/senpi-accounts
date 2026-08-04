# Production profile PASS — Alibaba workspace credential

The candidate addon was loaded into a real Senpi TUI with the default
`SENPI_CODING_AGENT_DIR`, and `/login alibaba-model-studio` completed through
the custom validation flow.

Observed:

```text
Logged in to Alibaba Model Studio (workspace).
Credentials saved to /Users/jgp/.senpi/agent/auth.json
```

Sanitized stored state:

```json
{
  "path": "~/.senpi/agent/auth.json",
  "providerPresent": true,
  "type": "oauth",
  "keyPrefix": "sk-ws-",
  "keyLength": 117,
  "keySha256": "c64008f390220dea7acf1160e907c3d85fe54229177bb5e213c6391dec981d42"
}
```

The stored hash matches the replacement key held in the macOS clipboard.

Screenshot:

- `/var/folders/8b/wc4w7rz95w3_6b0xm_r869yw0000gn/T/orca-computer-use/0456854e-aaf9-4012-9271-e43c2c47a0f8-screenshot.png`
- SHA-256 `6b25d6fd607abaeda79d9c67c7d721b3093b8116f177f2673afbb7fc419cff99`
- visually inspected: login success and the production credential path are
  visible; no key plaintext appears.
