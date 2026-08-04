# Sandbox PASS — validated Alibaba workspace login

Surface: Orca visible xterm `LAB-36 validation-only QA`.

Invocation:

```bash
ALIBABA_MODEL_STUDIO_BASE_URL=https://ws-tzcu53xu4sxxeqq4.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1 \
SENPI_CODING_AGENT_DIR=/tmp/lab-36-senpi-qa4 \
senpi -e /Users/jgp/Eddie-Personal-Space/work/lab-36-senpi-accounts/dist/index.js
```

Actions:

1. `/login alibaba-model-studio`
2. Select `Alibaba Model Studio (workspace)`
3. The custom prompt appears directly:
   `Alibaba Model Studio workspace API key (starts with sk-ws-)`
4. Submit the clipboard key at that secret prompt.

There is no native `Sign in with an API key` choice, so login cannot bypass the
provider's format and live-upstream validation.

Observed:

```text
Logged in to Alibaba Model Studio (workspace).
Credentials saved to /tmp/lab-36-senpi-qa4/auth.json
```

Sanitized state:

```json
{
  "providers": ["alibaba-model-studio"],
  "type": "oauth",
  "keyPrefix": "sk-ws-",
  "keyLength": 117,
  "keySha256": "c64008f390220dea7acf1160e907c3d85fe54229177bb5e213c6391dec981d42"
}
```

The key hash matches the clipboard replacement key. The custom login only
returns after its one-token `qwen-plus` request succeeds.

Screenshot:

- `/var/folders/8b/wc4w7rz95w3_6b0xm_r869yw0000gn/T/orca-computer-use/246b3791-6830-4674-92a8-ae68908bb20c-screenshot.png`
- SHA-256 `f62d2490309db3d52e3807c17d65a56c53f2204899db3e909fb6aee38d973c16`
- visually inspected: login success is visible and no key plaintext appears.
